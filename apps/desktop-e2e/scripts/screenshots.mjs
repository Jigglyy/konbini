// Generate README/marketing screenshots of the real Electron app.
//
// Boots Kanbini against a throwaway userData dir (so it never touches
// the developer's real board), seeds an attractive demo dataset over
// the 127.0.0.1 control channel (the same HTTP API the MCP server
// uses), then drives the renderer to each headline surface and writes
// a PNG per view into docs/screenshots/.
//
// Run after a desktop build is in place:
//   node apps/desktop-e2e/scripts/prepare.mjs      # build + ABI align
//   node apps/desktop-e2e/scripts/screenshots.mjs  # this script
//
// Captured at a 2x device scale factor for crisp output. The window is
// parked off-screen (KANBINI_E2E_HEADLESS=1) so it renders at full rate
// without stealing focus; Playwright screenshots over CDP regardless.

import { _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const MAIN_ENTRY = resolve(here, '../../desktop/out/main/index.js')
const OUT_DIR = resolve(here, '../../../docs/screenshots')

const DAY = 86_400_000
const now = Date.now()

// Renderer accent palette (apps/renderer/src/lib/palette.ts).
const A = {
  red: 'oklch(0.63 0.19 25)',
  orange: 'oklch(0.72 0.19 48)',
  amber: 'oklch(0.76 0.14 85)',
  lime: 'oklch(0.74 0.17 140)',
  green: 'oklch(0.64 0.15 160)',
  teal: 'oklch(0.68 0.10 195)',
  sky: 'oklch(0.69 0.13 230)',
  blue: 'oklch(0.60 0.16 262)',
  indigo: 'oklch(0.56 0.17 292)',
  purple: 'oklch(0.62 0.18 322)',
  pink: 'oklch(0.67 0.20 352)'
}

async function waitForDiscovery(userDataDir, timeoutMs = 10_000) {
  const start = Date.now()
  const path = join(userDataDir, 'mcp.json')
  while (Date.now() - start < timeoutMs) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      await sleep(150)
    }
  }
  throw new Error(`mcp.json did not appear at ${path}`)
}

function makeApi(port, token) {
  const base = `http://127.0.0.1:${port}`
  const auth = { Authorization: `Bearer ${token}` }
  return {
    get: (p) => fetch(base + p, { headers: auth }),
    post: async (p, body) => {
      const res = await fetch(base + p, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok) {
        throw new Error(
          `POST ${p} -> ${res.status}: ${await res.text()} for ${JSON.stringify(body)}`
        )
      }
      return res.json()
    }
  }
}

async function seed(api) {
  const m = (body) => api.post('/mutate', body)

  // Start from a blank slate - drop the auto-seeded Welcome Board so
  // the home grid shows only the demo boards.
  const boards = await (await api.get('/boards')).json()
  const welcome = boards.find((b) => b.name === 'Welcome Board')
  if (welcome) await m({ type: 'board.delete', id: welcome.id })

  // ── Hero board: Product Roadmap ───────────────────────────────────
  const roadmap = await m({ type: 'board.create', name: 'Product Roadmap' })
  await m({
    type: 'board.update',
    id: roadmap.id,
    patch: {
      color: A.indigo,
      background: { kind: 'gradient', preset: 'dusk' },
      pinned: true
    }
  })

  const L = {
    feature: (await m({ type: 'label.create', boardId: roadmap.id, name: 'Feature', color: A.blue })).id,
    bug: (await m({ type: 'label.create', boardId: roadmap.id, name: 'Bug', color: A.red })).id,
    design: (await m({ type: 'label.create', boardId: roadmap.id, name: 'Design', color: A.purple })).id,
    docs: (await m({ type: 'label.create', boardId: roadmap.id, name: 'Docs', color: A.teal })).id,
    research: (await m({ type: 'label.create', boardId: roadmap.id, name: 'Research', color: A.lime })).id
  }

  const list = (name, color) =>
    m({ type: 'list.create', boardId: roadmap.id, name, color })
  const backlog = await list('Backlog', A.sky)
  const inProgress = await list('In Progress', A.amber)
  const inReview = await list('In Review', A.purple)
  const done = await list('Done', A.green)

  async function card(listId, title, opts = {}) {
    const { priority, labels, due, completed, description } = opts
    const c = await m({
      type: 'card.create',
      listId,
      title,
      ...(priority ? { priority } : {})
    })
    const patch = {}
    if (due !== undefined) patch.dueAt = due
    if (completed) patch.completed = true
    if (description !== undefined) patch.description = description
    if (Object.keys(patch).length) await m({ type: 'card.update', id: c.id, patch })
    if (labels?.length) await m({ type: 'card.setLabels', id: c.id, labelIds: labels })
    return c.id
  }

  await card(backlog.id, 'Offline-first sync engine', {
    priority: 'high',
    labels: [L.feature, L.research],
    due: now + 10 * DAY
  })
  await card(backlog.id, 'Dark mode contrast pass', {
    priority: 'low',
    labels: [L.design]
  })
  await card(backlog.id, 'Keyboard shortcut cheatsheet', { labels: [L.docs] })
  await card(backlog.id, 'SQLite WAL checkpoint stalls', {
    priority: 'medium',
    labels: [L.bug, L.research]
  })

  const rich = await card(inProgress.id, 'Drag-and-drop reorder animation', {
    priority: 'high',
    labels: [L.feature, L.design],
    due: now + 3 * DAY,
    description:
      'Smooth FLIP-based reordering for both cards and lists.\n\n' +
      'The drag overlay animates only `transform` and `box-shadow`, so the ' +
      'drop reads as "what you saw is what you get" - no snap-back to the ' +
      'old slot.'
  })
  await card(inProgress.id, 'Command palette fuzzy ranking', {
    priority: 'medium',
    labels: [L.feature]
  })

  // Rich card detail: checklist + a human comment + an AI comment.
  const cl = await m({ type: 'checklist.create', cardId: rich, name: 'Acceptance' })
  const item = async (text, done2) => {
    const it = await m({ type: 'checklistItem.create', checklistId: cl.id, text })
    if (done2) await m({ type: 'checklistItem.update', id: it.id, patch: { completed: true } })
  }
  await item('Cross-list live reorder', true)
  await item('Same-list glide via CSS transforms', true)
  await item('No snap-back on drop', true)
  await item('Multi-card group drag', false)
  await m({
    type: 'comment.create',
    cardId: rich,
    body: 'Tested on a 200-card board - stays buttery even mid-drag.'
  })
  await m({
    type: 'comment.create',
    cardId: rich,
    author: 'ai',
    body: 'Moved this into In Progress and ticked the first three acceptance items for you.'
  })

  await card(inReview.id, 'Export round-trip test', {
    priority: 'medium',
    labels: [L.docs],
    due: now + DAY
  })
  await card(inReview.id, 'Label bar overflow on narrow windows', {
    priority: 'urgent',
    labels: [L.bug],
    due: now - DAY
  })

  await card(done.id, 'MCP write tools', { labels: [L.feature], completed: true })
  await card(done.id, 'Board background presets', { labels: [L.design], completed: true })
  await card(done.id, 'Trello import', { labels: [L.feature], completed: true })

  // ── Secondary boards for the home grid ────────────────────────────
  async function simpleBoard(name, { color, gradient, lists }) {
    const b = await m({ type: 'board.create', name })
    const patch = {}
    if (color) patch.color = color
    if (gradient) patch.background = { kind: 'gradient', preset: gradient }
    if (Object.keys(patch).length) await m({ type: 'board.update', id: b.id, patch })
    for (const [listName, cards] of lists) {
      const l = await m({ type: 'list.create', boardId: b.id, name: listName })
      for (const t of cards) await m({ type: 'card.create', listId: l.id, title: t })
    }
    return b
  }

  await simpleBoard('Trip to Japan', {
    gradient: 'ocean',
    lists: [
      ['Itinerary', ['Book flights', 'Reserve ryokan in Kyoto', 'JR Pass order']],
      ['Packing', ['Power adapters', 'Pocket wifi']],
      ['Booked', ['Tokyo hotel']]
    ]
  })
  await simpleBoard('Reading List', {
    color: A.teal,
    lists: [
      ['To read', ['Designing Data-Intensive Apps', 'The Pragmatic Programmer']],
      ['Reading', ['Crafting Interpreters']],
      ['Finished', ['Project Hail Mary']]
    ]
  })
  await simpleBoard('Home Renovation', {
    gradient: 'sunset',
    lists: [
      ['Quotes', ['Kitchen counters', 'Repaint hallway']],
      ['Scheduled', ['Electrician Tuesday']]
    ]
  })
  await simpleBoard('Content Calendar', {
    gradient: 'rose',
    lists: [
      ['Ideas', ['Offline-first deep dive', 'MCP walkthrough video']],
      ['Drafting', ['Release notes v0.8']],
      ['Published', ['Why local-first matters']]
    ]
  })
  await simpleBoard('Fitness', {
    color: A.green,
    lists: [
      ['This week', ['Long run 10k', 'Mobility session']],
      ['Log', ['Mon - push', 'Wed - pull']]
    ]
  })

  return { roadmap }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-shots-'))

  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  }
  env.KANBINI_USERDATA_OVERRIDE = userDataDir
  env.KANBINI_E2E_HEADLESS = '1'
  env.NODE_ENV = 'development'

  const app = await electron.launch({
    args: [MAIN_ENTRY, '--force-device-scale-factor=2'],
    env
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // Roomy content size for the screenshots (chrome-free renderer area).
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) w.setContentSize(1440, 900)
    })

    const { port, token } = await waitForDiscovery(userDataDir)
    const api = makeApi(port, token)
    await seed(api)

    // Force dark theme + named label chips, skip the welcome modal,
    // then reload so the renderer paints the seeded data fresh.
    await page.evaluate(() => {
      const raw = localStorage.getItem('kanbini.settings')
      const s = raw ? JSON.parse(raw) : {}
      localStorage.setItem(
        'kanbini.settings',
        JSON.stringify({ ...s, theme: 'dark', labelsExpanded: true, hasSeenWelcome: true })
      )
    })
    await page.reload({ waitUntil: 'domcontentloaded' })

    // The in-list card runs a one-shot WAAPI height tween on reflow
    // (hooks/useSmoothHeight.ts) and pins an inline `height` while it
    // plays. A screenshot taken mid-tween can freeze that pinned (older,
    // shorter) height and the card's `overflow-hidden` clips its last
    // row. Before each capture, wait for every running animation to
    // finish, then release any inline height pin so cards sit at their
    // true auto height. Not a product bug - the live app settles the
    // tween in ~200ms; this just keeps the static capture clean.
    const settle = async () => {
      await page
        .waitForFunction(() => document.getAnimations().length === 0, null, {
          timeout: 5000
        })
        .catch(() => {})
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('[data-card-id]')) {
          if (el instanceof HTMLElement && el.style.height) el.style.height = ''
        }
      })
      await page.waitForTimeout(150)
    }

    const shot = async (name) => {
      await settle()
      await page.screenshot({
        path: join(OUT_DIR, `${name}.png`),
        animations: 'disabled',
        caret: 'hide'
      })
      console.log(`  wrote ${name}.png`)
    }

    // ── Home grid ──────────────────────────────────────────────────
    await page.getByRole('heading', { name: /your boards/i }).waitFor()
    await page.getByText('Product Roadmap', { exact: true }).waitFor()
    await sleep(700)
    await shot('home')

    // ── Board view (hero) ──────────────────────────────────────────
    await page.getByText('Product Roadmap', { exact: true }).click()
    await page.getByRole('heading', { name: /^Backlog\b/ }).waitFor()
    await sleep(900)
    await shot('board')

    // Proof the checklist-preview row isn't clipped after settling.
    const check = await page.evaluate(() => {
      const card = [...document.querySelectorAll('[data-card-id]')].find((el) =>
        el.textContent?.includes('Drag-and-drop reorder animation')
      )
      if (!card) return 'card-not-found'
      const cr = card.getBoundingClientRect()
      const pill = card.querySelector('[aria-expanded]')
      const pr = pill?.getBoundingClientRect()
      return {
        clipPx: card.scrollHeight - card.clientHeight,
        pillBelowCardPx: pr ? +(pr.bottom - cr.bottom).toFixed(1) : null,
        inlineHeight: card.style.height || '(none)'
      }
    })
    console.log('  board card check:', JSON.stringify(check))

    // ── Card detail ────────────────────────────────────────────────
    await page.getByText('Drag-and-drop reorder animation', { exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Drag-and-drop reorder animation' })
      .waitFor()
    await sleep(1000)
    await shot('card-detail')
    await page.getByRole('button', { name: 'Close' }).click()
    await sleep(400)

    // ── Command palette / cross-board search ───────────────────────
    await page.keyboard.press('Control+f')
    await sleep(350)
    await page.keyboard.type('reorder', { delay: 45 })
    await sleep(800)
    await shot('command-palette')
    await page.keyboard.press('Escape')
    await sleep(400)

    // ── Swimlanes (group by priority) ──────────────────────────────
    await page.getByRole('button', { name: 'Rename board' }).click()
    await page.getByRole('button', { name: 'Priority', exact: true }).click()
    await page.getByRole('heading', { name: 'Urgent' }).waitFor()
    await page.keyboard.press('Escape') // close the board-settings popover
    await sleep(900)
    await shot('swimlanes')

    console.log(`\nScreenshots written to ${OUT_DIR}`)
  } finally {
    try {
      await app.close()
    } catch {
      /* ignore */
    }
    await rm(userDataDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
