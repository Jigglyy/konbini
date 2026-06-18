import { expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for the REST aliases + mutate.batch on the 127.0.0.1 control
// channel (the "direct HTTP API without MCP", docs/MCP.md). These map
// onto the same dispatch table the MCP tools use, so this exercises the
// real channel in the running app: discovery via mcp.json, bearer auth,
// GET read routes, POST write routes, atomic batch, and the error paths.

let handle: E2EHandle

test.afterEach(async () => {
  await handle?.cleanup()
})

interface McpJson {
  port: number
  token: string
  pid: number
}

async function waitForDiscovery(
  userDataDir: string,
  timeoutMs = 5000
): Promise<McpJson> {
  const start = Date.now()
  const path = join(userDataDir, 'mcp.json')
  while (Date.now() - start < timeoutMs) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as McpJson
    } catch {
      await sleep(100)
    }
  }
  throw new Error(`mcp.json did not appear at ${path} within ${timeoutMs} ms`)
}

function makeApi(port: number, token: string) {
  const base = `http://127.0.0.1:${port}`
  const auth = { Authorization: `Bearer ${token}` }
  return {
    get: (path: string) => fetch(base + path, { headers: auth }),
    post: (path: string, body: unknown) =>
      fetch(base + path, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
  }
}

interface BoardSummary {
  id: string
  name: string
}
interface BoardView {
  lists: Array<{ id: string; cards: Array<{ id: string; title: string }> }>
}

async function welcomeBoardId(api: ReturnType<typeof makeApi>): Promise<string> {
  const boards = (await (await api.get('/boards')).json()) as BoardSummary[]
  const b = boards.find((x) => x.name === 'Welcome Board')
  if (!b) throw new Error('Welcome Board not found via /boards')
  return b.id
}

test('REST read aliases return board / card / search data', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-api-'))
  handle = await launchKanbini({ userDataDir })
  const { port, token } = await waitForDiscovery(userDataDir)
  const api = makeApi(port, token)

  // GET /boards
  const boardsRes = await api.get('/boards')
  expect(boardsRes.status).toBe(200)
  const boards = (await boardsRes.json()) as BoardSummary[]
  expect(boards.some((b) => b.name === 'Welcome Board')).toBe(true)
  const boardId = boards.find((b) => b.name === 'Welcome Board')!.id

  // GET /boards/:id
  const boardRes = await api.get(`/boards/${boardId}`)
  expect(boardRes.status).toBe(200)
  const board = (await boardRes.json()) as BoardView
  expect(Array.isArray(board.lists)).toBe(true)
  const card = board.lists.flatMap((l) => l.cards)[0]
  expect(card).toBeTruthy()

  // GET /cards/:id
  const cardRes = await api.get(`/cards/${card!.id}`)
  expect(cardRes.status).toBe(200)
  const cardView = (await cardRes.json()) as { id: string }
  expect(cardView.id).toBe(card!.id)

  // GET /search?query= (a seeded card contains "checkbox")
  const searchRes = await api.get('/search?query=checkbox&limit=10')
  expect(searchRes.status).toBe(200)
  const hits = (await searchRes.json()) as unknown[]
  expect(Array.isArray(hits)).toBe(true)
  expect(hits.length).toBeGreaterThan(0)
})

test('REST write aliases mutate one and batch many atomically', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-api-'))
  handle = await launchKanbini({ userDataDir })
  const { port, token } = await waitForDiscovery(userDataDir)
  const api = makeApi(port, token)

  const boardId = await welcomeBoardId(api)
  const board = (await (await api.get(`/boards/${boardId}`)).json()) as BoardView
  const listId = board.lists[0]!.id

  // POST /mutate - a single card.
  const mutRes = await api.post('/mutate', {
    type: 'card.create',
    listId,
    title: 'Made via REST /mutate'
  })
  expect(mutRes.status).toBe(200)
  const mutResult = (await mutRes.json()) as { boardId: string }
  expect(mutResult.boardId).toBe(boardId)

  // POST /mutate/batch - two cards in one transaction.
  const batchRes = await api.post('/mutate/batch', [
    { type: 'card.create', listId, title: 'Batch A' },
    { type: 'card.create', listId, title: 'Batch B' }
  ])
  expect(batchRes.status).toBe(200)
  const batchResults = (await batchRes.json()) as unknown[]
  expect(batchResults.length).toBe(2)

  // All three landed (and the batch also accepts the { mutations } shape).
  const after = (await (await api.get(`/boards/${boardId}`)).json()) as BoardView
  const titles = after.lists.flatMap((l) => l.cards).map((c) => c.title)
  expect(titles).toContain('Made via REST /mutate')
  expect(titles).toContain('Batch A')
  expect(titles).toContain('Batch B')

  const wrapped = await api.post('/mutate/batch', {
    mutations: [{ type: 'card.create', listId, title: 'Wrapped batch' }]
  })
  expect(wrapped.status).toBe(200)
})

test('the HTTP API requires the bearer token and rejects bad input', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-api-'))
  handle = await launchKanbini({ userDataDir })
  const { port, token } = await waitForDiscovery(userDataDir)
  const base = `http://127.0.0.1:${port}`

  // No token -> 401, even on a valid route (auth is checked before routing).
  expect((await fetch(`${base}/boards`)).status).toBe(401)

  const api = makeApi(port, token)
  // Unknown route -> 404 (authenticated).
  expect((await api.get('/nope')).status).toBe(404)

  // attachment.delete can't ride a batch (needs the renderer's file unlink).
  const badBatch = await api.post('/mutate/batch', [
    { type: 'attachment.delete', id: 'does-not-exist' }
  ])
  expect(badBatch.status).toBeGreaterThanOrEqual(400)
  const err = (await badBatch.json()) as { error?: string }
  expect(err.error).toMatch(/not allowed in a mutation batch/i)
})
