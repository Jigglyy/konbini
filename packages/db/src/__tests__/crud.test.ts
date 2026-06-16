import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@kanbini/shared'
import {
  applyMutation,
  createAttachment,
  ensureDefaultProjectId
} from '../crud'
import { getBoardView, getCardView, listBoards } from '../data'
import { type Db } from '../client'
import { createTestDb } from './_setup'

// Black-box tests for applyMutation: drive each arm through the
// public surface (the same discriminated union main + MCP feed in),
// read back through the public read views, assert the world looks
// right. No private SQL - if a refactor moves a column, these tests
// stay valid as long as the view shape doesn't change.

let db: Db
let sqlite: Database.Database
let close: () => void
let projectId: string

beforeEach(() => {
  const t = createTestDb()
  db = t.db
  sqlite = t.sqlite
  close = t.close
  projectId = ensureDefaultProjectId(db)
})

afterEach(() => close())

/** Create a board + list + card with one assertion-friendly helper.
 *  Returns ids for the chain so tests can target individual entities. */
function seedBoard(name = 'B'): {
  boardId: string
  listId: string
  cardId: string
} {
  const board = applyMutation(db, { type: 'board.create', projectId, name })
  const list = applyMutation(db, {
    type: 'list.create',
    boardId: board.id,
    name: 'L'
  })
  const card = applyMutation(db, {
    type: 'card.create',
    listId: list.id,
    title: 'T'
  })
  return { boardId: board.id, listId: list.id, cardId: card.id }
}

describe('board CRUD', () => {
  it('board.create returns the new board id with itself as boardId', () => {
    const r = applyMutation(db, {
      type: 'board.create',
      projectId,
      name: 'New'
    })
    expect(r.id).toBeTruthy()
    expect(r.boardId).toBe(r.id)
    expect(listBoards(db).map((b) => b.name)).toContain('New')
  })

  it('board.create omits projectId → service seeds / resolves the default', () => {
    // Fresh DB, ensureDefaultProjectId was already called by beforeEach
    // so a default exists; the mutation should still work without an
    // explicit projectId.
    const r = applyMutation(db, { type: 'board.create', name: 'Default' })
    expect(r.id).toBeTruthy()
    const summary = listBoards(db).find((b) => b.id === r.id)
    expect(summary?.projectId).toBe(projectId)
  })

  it('board.update patches name + color + pinned', () => {
    const { boardId } = seedBoard()
    applyMutation(db, {
      type: 'board.update',
      id: boardId,
      patch: { name: 'Renamed', color: '#ff0000', pinned: true }
    })
    const b = listBoards(db).find((x) => x.id === boardId)!
    expect(b.name).toBe('Renamed')
    expect(b.color).toBe('#ff0000')
    expect(b.pinned).toBe(true)
  })

  it('board.delete cascades to lists + cards', () => {
    const { boardId, cardId } = seedBoard()
    applyMutation(db, { type: 'board.delete', id: boardId })
    expect(listBoards(db).find((b) => b.id === boardId)).toBeUndefined()
    expect(getCardView(db, cardId)).toBeNull()
  })

  it('getBoardView returns labels in creation order, not alphabetical', () => {
    const { boardId } = seedBoard()
    const color = 'oklch(0.62 0.17 25)'
    // Created reverse-alphabetically: creation order must win over name.
    applyMutation(db, { type: 'label.create', boardId, name: 'Zebra', color })
    applyMutation(db, { type: 'label.create', boardId, name: 'Apple', color })
    const view = getBoardView(db, boardId)!
    expect(view.labels.map((l) => l.name)).toEqual(['Zebra', 'Apple'])
  })

  it('listBoards attributes list/card counts to the right board', () => {
    // Regression guard for the batched GROUP BY in listBoards: counts
    // must not bleed across boards, and a board absent from a GROUP BY
    // result (no lists / cards / activity) must read 0, not undefined.
    const a = applyMutation(db, { type: 'board.create', projectId, name: 'A' })
    const a1 = applyMutation(db, { type: 'list.create', boardId: a.id, name: 'A1' })
    const a2 = applyMutation(db, { type: 'list.create', boardId: a.id, name: 'A2' })
    applyMutation(db, { type: 'card.create', listId: a1.id, title: 'a-c1' })
    applyMutation(db, { type: 'card.create', listId: a1.id, title: 'a-c2' })
    applyMutation(db, { type: 'card.create', listId: a2.id, title: 'a-c3' })

    const b = applyMutation(db, { type: 'board.create', projectId, name: 'B' })
    const b1 = applyMutation(db, { type: 'list.create', boardId: b.id, name: 'B1' })
    applyMutation(db, { type: 'card.create', listId: b1.id, title: 'b-c1' })

    const empty = applyMutation(db, {
      type: 'board.create',
      projectId,
      name: 'Empty'
    })

    const boards = listBoards(db)
    const sa = boards.find((x) => x.id === a.id)!
    const sb = boards.find((x) => x.id === b.id)!
    const se = boards.find((x) => x.id === empty.id)!
    expect([sa.listCount, sa.cardCount]).toEqual([2, 3])
    expect([sb.listCount, sb.cardCount]).toEqual([1, 1])
    expect([se.listCount, se.cardCount]).toEqual([0, 0])
  })

  it('board.move places a board between two neighbours by fractional index', () => {
    const a = applyMutation(db, { type: 'board.create', projectId, name: 'A' }).id
    const b = applyMutation(db, { type: 'board.create', projectId, name: 'B' }).id
    const c = applyMutation(db, { type: 'board.create', projectId, name: 'C' }).id
    // Starting order: [A, B, C]. Move C to sit between A and B.
    applyMutation(db, {
      type: 'board.move',
      id: c,
      beforeId: a,
      afterId: b
    })
    const names = listBoards(db)
      .filter((x) => [a, b, c].includes(x.id))
      .map((x) => x.name)
    expect(names).toEqual(['A', 'C', 'B'])
  })

  it('list.move places a list between two neighbours by fractional index', () => {
    const board = applyMutation(db, { type: 'board.create', projectId, name: 'B' })
    const a = applyMutation(db, { type: 'list.create', boardId: board.id, name: 'A' }).id
    const b = applyMutation(db, { type: 'list.create', boardId: board.id, name: 'B' }).id
    const c = applyMutation(db, { type: 'list.create', boardId: board.id, name: 'C' }).id
    // Starting order: [A, B, C]. Move C to sit between A and B.
    const r = applyMutation(db, { type: 'list.move', id: c, beforeId: a, afterId: b })
    expect(r.boardId).toBe(board.id)
    expect(getBoardView(db, board.id)?.lists.map((l) => l.name)).toEqual([
      'A',
      'C',
      'B'
    ])
  })

  it('board.update accepts all three background kinds + clears with null', () => {
    const { boardId } = seedBoard()
    const cases = [
      { kind: 'color', value: 'oklch(0.62 0.15 250)' } as const,
      { kind: 'gradient', preset: 'sunset' } as const,
      { kind: 'image', relPath: 'board-backgrounds/b1/wallpaper.jpg' } as const
    ]
    for (const bg of cases) {
      applyMutation(db, {
        type: 'board.update',
        id: boardId,
        patch: { background: bg }
      })
      // Round-trips intact through both read views.
      expect(listBoards(db).find((b) => b.id === boardId)?.background).toEqual(bg)
      expect(getBoardView(db, boardId)?.board.background).toEqual(bg)
    }
    // Clear with null.
    applyMutation(db, {
      type: 'board.update',
      id: boardId,
      patch: { background: null }
    })
    expect(listBoards(db).find((b) => b.id === boardId)?.background).toBeNull()
    expect(getBoardView(db, boardId)?.board.background).toBeNull()
  })

  it('board.duplicate carries color/gradient backgrounds but drops image backgrounds', () => {
    const { boardId } = seedBoard()
    // Color: should ride along.
    applyMutation(db, {
      type: 'board.update',
      id: boardId,
      patch: { background: { kind: 'color', value: '#abcdef' } }
    })
    const dup1 = applyMutation(db, { type: 'board.duplicate', id: boardId })
    expect(getBoardView(db, dup1.id)?.board.background).toEqual({
      kind: 'color',
      value: '#abcdef'
    })

    // Image: should NOT - the source's file path would dangle on the
    // duplicate (file lives under the source's folder). Cleaner to
    // drop than to point at a path that could vanish.
    applyMutation(db, {
      type: 'board.update',
      id: boardId,
      patch: {
        background: {
          kind: 'image',
          relPath: 'board-backgrounds/x/wall.png'
        }
      }
    })
    const dup2 = applyMutation(db, { type: 'board.duplicate', id: boardId })
    expect(getBoardView(db, dup2.id)?.board.background).toBeNull()
  })

  it('board.duplicate carries the swimlane grouping', () => {
    const { boardId } = seedBoard()
    applyMutation(db, {
      type: 'board.update',
      id: boardId,
      patch: { swimlaneMode: 'priority' }
    })
    const dup = applyMutation(db, { type: 'board.duplicate', id: boardId })
    // A duplicate of a priority-grouped board opens priority-grouped,
    // same as it carries color / gradient.
    expect(getBoardView(db, dup.id)?.board.swimlaneMode).toBe('priority')
  })

  it('board.duplicate copies lists + labels with new ids but no cards', () => {
    const { boardId } = seedBoard()
    applyMutation(db, {
      type: 'label.create',
      boardId,
      name: 'bug',
      color: '#f00'
    })
    const dup = applyMutation(db, { type: 'board.duplicate', id: boardId })
    const view = getBoardView(db, dup.id)!
    expect(view.board.name).toMatch(/copy/i)
    expect(view.lists).toHaveLength(1)
    expect(view.lists[0]?.cards).toEqual([]) // cards NOT copied
    expect(view.labels).toHaveLength(1)
    expect(view.labels[0]?.name).toBe('bug')
    // Ids must be fresh (not the source's).
    const src = getBoardView(db, boardId)!
    expect(view.lists[0]?.id).not.toBe(src.lists[0]?.id)
    expect(view.labels[0]?.id).not.toBe(src.labels[0]?.id)
  })
})

describe('list CRUD', () => {
  it('list.create appends after existing lists by fractional-index', () => {
    const { boardId } = seedBoard()
    const second = applyMutation(db, {
      type: 'list.create',
      boardId,
      name: 'L2'
    })
    const view = getBoardView(db, boardId)!
    const positions = view.lists.map((l) => l.position)
    expect(positions).toEqual([...positions].sort())
    expect(view.lists.at(-1)?.id).toBe(second.id)
  })

  it('list.update closed=true hides the list from the view', () => {
    const { boardId, listId } = seedBoard()
    applyMutation(db, {
      type: 'list.update',
      id: listId,
      patch: { closed: true }
    })
    const view = getBoardView(db, boardId)!
    // BoardView surfaces closed lists too - the renderer filters them
    // out - so just assert the column was patched.
    expect(view.lists.find((l) => l.id === listId)?.closed).toBe(true)
  })

  it('list.update accepts wipLimit + clears with null', () => {
    const { boardId, listId } = seedBoard()
    applyMutation(db, {
      type: 'list.update',
      id: listId,
      patch: { wipLimit: 3 }
    })
    expect(
      getBoardView(db, boardId)!.lists.find((l) => l.id === listId)?.wipLimit
    ).toBe(3)
    applyMutation(db, {
      type: 'list.update',
      id: listId,
      patch: { wipLimit: null }
    })
    expect(
      getBoardView(db, boardId)!.lists.find((l) => l.id === listId)?.wipLimit
    ).toBeNull()
  })

  it('list.delete cascades to its cards', () => {
    const { boardId, listId, cardId } = seedBoard()
    applyMutation(db, { type: 'list.delete', id: listId })
    expect(getCardView(db, cardId)).toBeNull()
    expect(getBoardView(db, boardId)!.lists).toHaveLength(0)
  })

  // ADR-0032 per-list sort override. Tests use 2 ms sleeps to put
  // each card.create in a distinct millisecond, so the createdAt
  // ordering is deterministic (UUIDv7 id is only a tiebreaker).
  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms))

  it('list.update sortMode=created-desc orders cards newest-first in the view', async () => {
    const { boardId, listId } = seedBoard()
    await sleep(2)
    const second = applyMutation(db, {
      type: 'card.create',
      listId,
      title: 'second'
    })
    await sleep(2)
    const third = applyMutation(db, {
      type: 'card.create',
      listId,
      title: 'third'
    })
    applyMutation(db, {
      type: 'list.update',
      id: listId,
      patch: { sortMode: 'created-desc' }
    })
    const titles = getBoardView(db, boardId)!.lists[0]!.cards.map((c) => c.title)
    expect(titles).toEqual(['third', 'second', 'T'])
    // sortMode reads back too.
    expect(getBoardView(db, boardId)!.lists[0]!.sortMode).toBe('created-desc')
    void second
    void third
  })

  it('list.update sortMode=created-asc orders cards oldest-first in the view', async () => {
    const { boardId, listId } = seedBoard()
    await sleep(2)
    applyMutation(db, { type: 'card.create', listId, title: 'second' })
    await sleep(2)
    applyMutation(db, { type: 'card.create', listId, title: 'third' })
    applyMutation(db, {
      type: 'list.update',
      id: listId,
      patch: { sortMode: 'created-asc' }
    })
    const titles = getBoardView(db, boardId)!.lists[0]!.cards.map((c) => c.title)
    expect(titles).toEqual(['T', 'second', 'third'])
  })

  it('flipping sortMode back to null snapshots the displayed order into positions', async () => {
    const { boardId, listId } = seedBoard()
    await sleep(2)
    applyMutation(db, { type: 'card.create', listId, title: 'second' })
    await sleep(2)
    applyMutation(db, { type: 'card.create', listId, title: 'third' })
    // Sort newest-first → expected on-screen: [third, second, T].
    applyMutation(db, {
      type: 'list.update',
      id: listId,
      patch: { sortMode: 'created-desc' }
    })
    // Flip back to manual - server snapshots the on-screen order.
    applyMutation(db, {
      type: 'list.update',
      id: listId,
      patch: { sortMode: null }
    })
    const view = getBoardView(db, boardId)!.lists[0]!
    expect(view.sortMode).toBeNull()
    // Manual view re-orders by fractional-index position; the freshly-
    // minted positions must give back the same order the user just saw.
    expect(view.cards.map((c) => c.title)).toEqual(['third', 'second', 'T'])
    // Positions should be strictly ascending (the manual sort key).
    const positions = view.cards.map((c) => c.position)
    expect([...positions].sort()).toEqual(positions)
  })

  it('card.move INTO a sorted list orders the arrival by its createdAt', async () => {
    // Build two lists. dest has two older cards; source has one
    // brand-new card. After the move, dest's view (created-desc)
    // should look like [old1, old2, source_new] no wait - desc means
    // newest-first, so the newly-arrived one should be at the top
    // because its createdAt is the most recent.
    const { boardId } = seedBoard()
    const destList = applyMutation(db, {
      type: 'list.create',
      boardId,
      name: 'Dest'
    }).id
    const dOld = applyMutation(db, {
      type: 'card.create',
      listId: destList,
      title: 'd-old'
    }).id
    await sleep(2)
    const dMid = applyMutation(db, {
      type: 'card.create',
      listId: destList,
      title: 'd-mid'
    }).id
    applyMutation(db, {
      type: 'list.update',
      id: destList,
      patch: { sortMode: 'created-desc' }
    })
    await sleep(2)
    // Source card created LAST so it has the newest createdAt.
    const srcList = applyMutation(db, {
      type: 'list.create',
      boardId,
      name: 'Src'
    }).id
    const srcCard = applyMutation(db, {
      type: 'card.create',
      listId: srcList,
      title: 'arrived'
    }).id
    // Move srcCard into the sorted dest. Pass beforeId/afterId both
    // null (renderer's "drop into list" path); server writes a
    // position column but the view ignores it for sorted lists.
    applyMutation(db, {
      type: 'card.move',
      id: srcCard,
      toListId: destList,
      beforeId: null,
      afterId: null
    })
    const dest = getBoardView(db, boardId)!.lists.find(
      (l) => l.id === destList
    )!
    expect(dest.cards.map((c) => c.title)).toEqual(['arrived', 'd-mid', 'd-old'])
    void dOld
    void dMid
  })

  it('card.move OUT of a sorted list lands at the chosen neighbour position', () => {
    const { boardId, listId } = seedBoard()
    applyMutation(db, {
      type: 'list.update',
      id: listId,
      patch: { sortMode: 'created-desc' }
    })
    const dest = applyMutation(db, {
      type: 'list.create',
      boardId,
      name: 'Manual'
    }).id
    const anchor = applyMutation(db, {
      type: 'card.create',
      listId: dest,
      title: 'anchor'
    }).id
    // Cards in a sorted list are still drag sources; moving one out
    // to a manual list at a chosen slot must honour beforeId/afterId.
    const seeded = getBoardView(db, boardId)!.lists.find(
      (l) => l.id === listId
    )!.cards[0]!
    applyMutation(db, {
      type: 'card.move',
      id: seeded.id,
      toListId: dest,
      beforeId: null,
      afterId: anchor // land BEFORE anchor → first
    })
    const destView = getBoardView(db, boardId)!.lists.find(
      (l) => l.id === dest
    )!
    expect(destView.cards.map((c) => c.id)).toEqual([seeded.id, anchor])
  })

  it('flipping sortMode null → null is a no-op (no snapshot path triggered)', () => {
    const { boardId, listId } = seedBoard()
    // Capture the original positions; setting sortMode:null when it's
    // already null must not rewrite positions (the snapshot branch is
    // gated on prev.sortMode != null).
    const before = getBoardView(db, boardId)!.lists[0]!.cards.map((c) => ({
      id: c.id,
      position: c.position
    }))
    applyMutation(db, {
      type: 'list.update',
      id: listId,
      patch: { sortMode: null }
    })
    const after = getBoardView(db, boardId)!.lists[0]!.cards.map((c) => ({
      id: c.id,
      position: c.position
    }))
    expect(after).toEqual(before)
  })
})

describe('card CRUD', () => {
  it('card.create appends to the list with a fresh fractional position', () => {
    const { boardId, listId } = seedBoard()
    const second = applyMutation(db, {
      type: 'card.create',
      listId,
      title: 'T2'
    })
    const view = getBoardView(db, boardId)!
    const cards = view.lists[0]!.cards
    expect(cards).toHaveLength(2)
    expect(cards.map((c) => c.position)).toEqual(
      [...cards].map((c) => c.position).sort()
    )
    expect(cards.at(-1)?.id).toBe(second.id)
  })

  it('card.update patches title / description / dueAt / completed / cover', () => {
    const { cardId } = seedBoard()
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: {
        title: 'Updated',
        description: 'body',
        dueAt: 1700000000000,
        completed: true,
        coverAttachmentId: null
      }
    })
    const c = getCardView(db, cardId)!
    expect(c.title).toBe('Updated')
    expect(c.description).toBe('body')
    expect(c.dueAt).toBe(1700000000000)
    expect(c.completed).toBe(true)
  })

  it('card.create accepts an optional priority (ADR-0037 slice 2)', () => {
    const { listId } = seedBoard()
    // Default behaviour: no priority arg → null.
    const a = applyMutation(db, { type: 'card.create', listId, title: 'plain' })
    expect(getCardView(db, a.id)!.priority).toBeNull()
    // Preset: priority rides through the mutation and lands on the row.
    const b = applyMutation(db, {
      type: 'card.create',
      listId,
      title: 'urgent thing',
      priority: 'urgent'
    })
    expect(getCardView(db, b.id)!.priority).toBe('urgent')
    // Explicit null is the same as omitted.
    const c = applyMutation(db, {
      type: 'card.create',
      listId,
      title: 'also plain',
      priority: null
    })
    expect(getCardView(db, c.id)!.priority).toBeNull()
  })

  it('card.update sets / clears priority (ADR-0037) + logs the change', () => {
    const { cardId, boardId } = seedBoard()
    expect(getCardView(db, cardId)!.priority).toBeNull()

    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { priority: 'high' }
    })
    expect(getCardView(db, cardId)!.priority).toBe('high')

    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { priority: 'urgent' }
    })
    expect(getCardView(db, cardId)!.priority).toBe('urgent')

    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { priority: null }
    })
    expect(getCardView(db, cardId)!.priority).toBeNull()

    const activities = getBoardView(db, boardId)!.lists[0]!.cards[0]!.activities
    const priorityKinds = activities
      .map((a) => a.type)
      .filter((t) => t.startsWith('priority'))
    expect(priorityKinds).toEqual([
      'priority-cleared',
      'priority-set',
      'priority-set'
    ])
  })

  it('board.update sets / clears swimlaneMode (ADR-0037 slice 2)', () => {
    const { boardId } = seedBoard()
    expect(getBoardView(db, boardId)!.board.swimlaneMode).toBeNull()

    applyMutation(db, {
      type: 'board.update',
      id: boardId,
      patch: { swimlaneMode: 'priority' }
    })
    expect(getBoardView(db, boardId)!.board.swimlaneMode).toBe('priority')

    applyMutation(db, {
      type: 'board.update',
      id: boardId,
      patch: { swimlaneMode: null }
    })
    expect(getBoardView(db, boardId)!.board.swimlaneMode).toBeNull()
  })

  it('getBoardView soft-narrows an unknown swimlane mode to null', () => {
    const { boardId } = seedBoard()
    // Simulate an older DB / future mode the current build doesn't
    // know yet - read-side parser must not throw, and the renderer
    // should fall through to the flat layout (mode=null).
    sqlite
      .prepare('UPDATE board SET swimlane_mode=? WHERE id=?')
      .run('label:lab123', boardId)
    expect(getBoardView(db, boardId)!.board.swimlaneMode).toBeNull()
  })

  it('card.update priority survives a round-trip through getBoardView', () => {
    const { cardId, listId, boardId } = seedBoard()
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { priority: 'medium' }
    })
    applyMutation(db, {
      type: 'card.create',
      listId,
      title: 'Sibling'
    })
    const view = getBoardView(db, boardId)!
    const cards = view.lists[0]!.cards
    expect(cards.find((c) => c.id === cardId)?.priority).toBe('medium')
    expect(cards.find((c) => c.title === 'Sibling')?.priority).toBeNull()
  })

  it('card.delete removes the card', () => {
    const { cardId } = seedBoard()
    applyMutation(db, { type: 'card.delete', id: cardId })
    expect(getCardView(db, cardId)).toBeNull()
  })

  it('card.setLabels replaces the label set (idempotent)', () => {
    const { boardId, cardId } = seedBoard()
    const l1 = applyMutation(db, {
      type: 'label.create',
      boardId,
      name: 'one',
      color: '#111'
    })
    const l2 = applyMutation(db, {
      type: 'label.create',
      boardId,
      name: 'two',
      color: '#222'
    })
    applyMutation(db, {
      type: 'card.setLabels',
      id: cardId,
      labelIds: [l1.id, l2.id]
    })
    expect(new Set(getCardView(db, cardId)!.labelIds)).toEqual(
      new Set([l1.id, l2.id])
    )
    // Idempotent: re-applying the same set is a no-op.
    applyMutation(db, {
      type: 'card.setLabels',
      id: cardId,
      labelIds: [l1.id, l2.id]
    })
    expect(getCardView(db, cardId)!.labelIds).toHaveLength(2)
    // Replace: shrinking the set drops the absent label.
    applyMutation(db, {
      type: 'card.setLabels',
      id: cardId,
      labelIds: [l1.id]
    })
    expect(getCardView(db, cardId)!.labelIds).toEqual([l1.id])
  })

  it('card.move across lists puts the card at the requested neighbour position', () => {
    const { boardId, listId } = seedBoard()
    const cardA = applyMutation(db, {
      type: 'card.create',
      listId,
      title: 'A'
    })
    const cardB = applyMutation(db, {
      type: 'card.create',
      listId,
      title: 'B'
    })
    const list2 = applyMutation(db, {
      type: 'list.create',
      boardId,
      name: 'L2'
    })
    // Move B to list2, with no neighbours → appended to (empty) list2.
    applyMutation(db, {
      type: 'card.move',
      id: cardB.id,
      toListId: list2.id,
      beforeId: null,
      afterId: null
    })
    const view = getBoardView(db, boardId)!
    // Board has two lists at this point: the seeded L (index 0) and
    // L2 (index 1). Card B left L and landed in L2.
    expect(view.lists[0]?.cards.map((c) => c.id)).not.toContain(cardB.id)
    expect(view.lists[1]?.cards.map((c) => c.id)).toContain(cardB.id)
    // Same-list reorder: cardA above the original T (the first card
    // in list 0). beforeId=null + afterId=T means "land before T".
    applyMutation(db, {
      type: 'card.move',
      id: cardA.id,
      toListId: listId,
      beforeId: null,
      afterId: view.lists[0]!.cards[0]!.id
    })
    expect(getBoardView(db, boardId)!.lists[0]?.cards[0]?.id).toBe(cardA.id)
  })
})

describe('card.update coverAttachmentId guard', () => {
  function addAttachment(cardId: string): string {
    const id = newId()
    createAttachment(db, {
      id,
      cardId,
      filename: 'cover.png',
      relPath: `attachments/${id}/cover.png`,
      mime: 'image/png',
      size: 1
    })
    return id
  }

  it('accepts a cover that belongs to the card', () => {
    const { cardId } = seedBoard()
    const attId = addAttachment(cardId)
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { coverAttachmentId: attId }
    })
    expect(getCardView(db, cardId)?.coverAttachmentId).toBe(attId)
  })

  it('always allows clearing the cover (null)', () => {
    const { cardId } = seedBoard()
    const attId = addAttachment(cardId)
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { coverAttachmentId: attId }
    })
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { coverAttachmentId: null }
    })
    expect(getCardView(db, cardId)?.coverAttachmentId).toBeNull()
  })

  it('rejects an attachment that belongs to ANOTHER card', () => {
    const { cardId } = seedBoard('A')
    const { cardId: otherCardId } = seedBoard('B')
    const foreignAtt = addAttachment(otherCardId)
    expect(() =>
      applyMutation(db, {
        type: 'card.update',
        id: cardId,
        patch: { coverAttachmentId: foreignAtt }
      })
    ).toThrow(/does not belong to card/)
    // The guard throws before the write, so no foreign cover is stuck.
    expect(getCardView(db, cardId)?.coverAttachmentId).toBeNull()
  })

  it('rejects a non-existent attachment id', () => {
    const { cardId } = seedBoard()
    expect(() =>
      applyMutation(db, {
        type: 'card.update',
        id: cardId,
        patch: { coverAttachmentId: 'no-such-attachment' }
      })
    ).toThrow(/does not belong to card/)
  })
})

describe('label / checklist / comment CRUD', () => {
  it('label.create + label.update + label.delete', () => {
    const { boardId, cardId } = seedBoard()
    const lab = applyMutation(db, {
      type: 'label.create',
      boardId,
      name: 'tag',
      color: '#abc'
    })
    applyMutation(db, {
      type: 'card.setLabels',
      id: cardId,
      labelIds: [lab.id]
    })
    expect(
      getBoardView(db, boardId)!.labels.find((l) => l.id === lab.id)?.name
    ).toBe('tag')
    applyMutation(db, {
      type: 'label.update',
      id: lab.id,
      patch: { name: 'renamed', color: '#def' }
    })
    expect(
      getBoardView(db, boardId)!.labels.find((l) => l.id === lab.id)?.color
    ).toBe('#def')
    applyMutation(db, { type: 'label.delete', id: lab.id })
    // Card_label rows cascade off the label deletion.
    expect(getCardView(db, cardId)!.labelIds).toEqual([])
  })

  it('checklist + checklistItem create/update/toggle/delete', () => {
    const { cardId } = seedBoard()
    const cl = applyMutation(db, {
      type: 'checklist.create',
      cardId,
      name: 'sub'
    })
    const item = applyMutation(db, {
      type: 'checklistItem.create',
      checklistId: cl.id,
      text: 'todo'
    })
    expect(getCardView(db, cardId)!.checklists[0]?.items[0]?.text).toBe('todo')

    applyMutation(db, {
      type: 'checklistItem.update',
      id: item.id,
      patch: { completed: true, text: 'done' }
    })
    const after = getCardView(db, cardId)!.checklists[0]?.items[0]
    expect(after?.completed).toBe(true)
    expect(after?.text).toBe('done')

    applyMutation(db, {
      type: 'checklist.update',
      id: cl.id,
      patch: { name: 'sub2' }
    })
    expect(getCardView(db, cardId)!.checklists[0]?.name).toBe('sub2')

    applyMutation(db, { type: 'checklistItem.delete', id: item.id })
    expect(getCardView(db, cardId)!.checklists[0]?.items).toEqual([])

    applyMutation(db, { type: 'checklist.delete', id: cl.id })
    expect(getCardView(db, cardId)!.checklists).toEqual([])
  })

  it('comment.create flags author=null for humans and "ai" for MCP', () => {
    const { cardId } = seedBoard()
    const human = applyMutation(db, {
      type: 'comment.create',
      cardId,
      body: 'hi'
    })
    const ai = applyMutation(db, {
      type: 'comment.create',
      cardId,
      body: 'response',
      author: 'ai'
    })
    const c = getCardView(db, cardId)!
    const h = c.comments.find((x) => x.id === human.id)
    const a = c.comments.find((x) => x.id === ai.id)
    expect(h?.author).toBeNull()
    expect(a?.author).toBe('ai')
  })

  it('comment.update + comment.delete', () => {
    const { cardId } = seedBoard()
    const c1 = applyMutation(db, {
      type: 'comment.create',
      cardId,
      body: 'one'
    })
    applyMutation(db, {
      type: 'comment.update',
      id: c1.id,
      patch: { body: 'edited' }
    })
    expect(
      getCardView(db, cardId)!.comments.find((c) => c.id === c1.id)?.body
    ).toBe('edited')
    applyMutation(db, { type: 'comment.delete', id: c1.id })
    expect(getCardView(db, cardId)!.comments).toEqual([])
  })
})

describe('activity log', () => {
  it('logs an entry per card-scoped mutation', () => {
    const { cardId } = seedBoard()
    const before = getCardView(db, cardId)!.activities.length
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { title: 'A2' }
    })
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { completed: true }
    })
    const after = getCardView(db, cardId)!.activities
    expect(after.length).toBeGreaterThanOrEqual(before + 2)
    // Newest first.
    const types = after.map((a) => a.type)
    expect(types).toContain('renamed')
    expect(types).toContain('completed')
  })

  it('card.move on a nonexistent card logs nothing and returns boardId null', () => {
    const { listId } = seedBoard()
    // Raw row count: the phantom 'moved' row carried the TARGET
    // board's boardId with the bogus cardId, so card-scoped views
    // never surfaced it - only the table itself shows the leak.
    const count = (): number =>
      (
        sqlite
          .prepare('SELECT COUNT(*) AS c FROM activity')
          .get() as { c: number }
      ).c
    const before = count()
    // Stale id (an MCP caller after the card was deleted out-of-band).
    const result = applyMutation(db, {
      type: 'card.move',
      id: 'no-such-card',
      toListId: listId,
      beforeId: null,
      afterId: null
    })
    expect(result).toEqual({ id: 'no-such-card', boardId: null })
    expect(count()).toBe(before)
  })
})

// ADR-0041 · per-list on-card-enter automation. Fires inside the
// card.move transaction; only on cross-list arrivals; only when the
// rule would actually change something (idempotent).
describe('list.onEnter automation', () => {
  function seedTwoLists() {
    const board = applyMutation(db, {
      type: 'board.create',
      projectId,
      name: 'B'
    })
    const todo = applyMutation(db, {
      type: 'list.create',
      boardId: board.id,
      name: 'Todo'
    })
    const done = applyMutation(db, {
      type: 'list.create',
      boardId: board.id,
      name: 'Done'
    })
    const cardId = applyMutation(db, {
      type: 'card.create',
      listId: todo.id,
      title: 'T'
    }).id
    return { boardId: board.id, todoId: todo.id, doneId: done.id, cardId }
  }

  it('round-trips through list.update + getBoardView', () => {
    const { boardId, doneId } = seedTwoLists()
    applyMutation(db, {
      type: 'list.update',
      id: doneId,
      patch: { onEnter: { kind: 'complete' } }
    })
    const view = getBoardView(db, boardId)!
    const done = view.lists.find((l) => l.id === doneId)!
    expect(done.onEnter).toEqual({ kind: 'complete' })
    applyMutation(db, {
      type: 'list.update',
      id: doneId,
      patch: { onEnter: null }
    })
    expect(
      getBoardView(db, boardId)!.lists.find((l) => l.id === doneId)!.onEnter
    ).toBeNull()
  })

  it('fires complete-on-enter when card crosses lists', () => {
    const { boardId, doneId, cardId } = seedTwoLists()
    applyMutation(db, {
      type: 'list.update',
      id: doneId,
      patch: { onEnter: { kind: 'complete' } }
    })
    applyMutation(db, {
      type: 'card.move',
      id: cardId,
      toListId: doneId,
      beforeId: null,
      afterId: null
    })
    const after = getCardView(db, cardId)!
    expect(after.completed).toBe(true)
    // Activity feed shows BOTH events from the same tx, newest first.
    const types = after.activities.map((a) => a.type)
    expect(types[0]).toBe('rule-completed')
    expect(types[1]).toBe('moved')
    // The boardId carried by the move's result still tracks the
    // destination board so the renderer invalidates the right query.
    void boardId
  })

  it('fires uncomplete-on-enter and resets a completed card', () => {
    const { todoId, doneId, cardId } = seedTwoLists()
    // Pre-complete + put it on the Todo list.
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { completed: true }
    })
    // Done list has uncomplete-on-enter (intentionally inverted setup
    // - proves the rule kind is what fires, not just complete).
    applyMutation(db, {
      type: 'list.update',
      id: doneId,
      patch: { onEnter: { kind: 'uncomplete' } }
    })
    applyMutation(db, {
      type: 'card.move',
      id: cardId,
      toListId: doneId,
      beforeId: null,
      afterId: null
    })
    expect(getCardView(db, cardId)!.completed).toBe(false)
    const types = getCardView(db, cardId)!.activities.map((a) => a.type)
    expect(types).toContain('rule-uncompleted')
    void todoId
  })

  it('is idempotent - re-running the rule on a matching state is a no-op', () => {
    const { doneId, cardId } = seedTwoLists()
    // Card is already complete; rule says complete-on-enter; the
    // rule shouldn't log a rule-completed row.
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { completed: true }
    })
    applyMutation(db, {
      type: 'list.update',
      id: doneId,
      patch: { onEnter: { kind: 'complete' } }
    })
    applyMutation(db, {
      type: 'card.move',
      id: cardId,
      toListId: doneId,
      beforeId: null,
      afterId: null
    })
    const types = getCardView(db, cardId)!.activities.map((a) => a.type)
    expect(types).not.toContain('rule-completed')
    expect(types).toContain('moved')
  })

  it('does NOT fire on in-list reorder', () => {
    const { doneId } = seedTwoLists()
    // Put two cards on the Done list, with complete-on-enter rule.
    applyMutation(db, {
      type: 'list.update',
      id: doneId,
      patch: { onEnter: { kind: 'complete' } }
    })
    const a = applyMutation(db, {
      type: 'card.create',
      listId: doneId,
      title: 'A'
    }).id
    const b = applyMutation(db, {
      type: 'card.create',
      listId: doneId,
      title: 'B'
    }).id
    // Both were created directly on Done - no move, no rule fired,
    // so they're not completed.
    expect(getCardView(db, a)!.completed).toBe(false)
    expect(getCardView(db, b)!.completed).toBe(false)
    // Now reorder A within the same list. Rule must NOT fire.
    applyMutation(db, {
      type: 'card.move',
      id: a,
      toListId: doneId,
      beforeId: b,
      afterId: null
    })
    expect(getCardView(db, a)!.completed).toBe(false)
    const types = getCardView(db, a)!.activities.map((a) => a.type)
    expect(types).not.toContain('rule-completed')
  })

  it('does nothing when destination list has no rule', () => {
    const { todoId, doneId, cardId } = seedTwoLists()
    // Done has no rule (default).
    applyMutation(db, {
      type: 'card.move',
      id: cardId,
      toListId: doneId,
      beforeId: null,
      afterId: null
    })
    expect(getCardView(db, cardId)!.completed).toBe(false)
    const types = getCardView(db, cardId)!.activities.map((a) => a.type)
    expect(types).not.toContain('rule-completed')
    expect(types).not.toContain('rule-uncompleted')
    void todoId
  })

  it('soft-narrows an unknown rule kind to null on read', () => {
    const { boardId, doneId } = seedTwoLists()
    // Plant a future-mode rule directly via raw sqlite. The current
    // build doesn't recognise `set-label`, so parseOnEnter falls back
    // to null and the editor shows "None" - no crash, no surprise.
    sqlite
      .prepare('UPDATE list SET on_enter = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'set-label', labelId: 'x' }), doneId)
    const view = getBoardView(db, boardId)!
    const done = view.lists.find((l) => l.id === doneId)!
    expect(done.onEnter).toBeNull()
  })
})
