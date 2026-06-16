import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { getBoardView, listBoards } from '../data'
import { type Db } from '../client'
import {
  MAX_UNDO_LOG_SIZE,
  applyMutationRecorded,
  applyMutationsRecorded,
  clearUndoLog,
  redoOne,
  snapshotBoard,
  snapshotCard,
  undoOne,
  undoStatus
} from '../undo'
import { createTestDb } from './_setup'

// ADR-0036 server-side undo log. Black-box: drive the recorder via
// `applyMutationRecorded` for every mutation kind we claim to support,
// then exercise `undoOne` / `redoOne` and assert the read views agree.
// No private SQL - uses the same public surface main + MCP use.

let db: Db
let close: () => void
let projectId: string

beforeEach(() => {
  const t = createTestDb()
  db = t.db
  close = t.close
  projectId = ensureDefaultProjectId(db)
})

afterEach(() => close())

function seedBoard(
  name = 'B'
): { boardId: string; listId: string; cardId: string } {
  const b = applyMutationRecorded(db, {
    type: 'board.create',
    projectId,
    name
  })
  const l = applyMutationRecorded(db, {
    type: 'list.create',
    boardId: b.id,
    name: 'L'
  })
  const c = applyMutationRecorded(db, {
    type: 'card.create',
    listId: l.id,
    title: 'T'
  })
  return { boardId: b.id, listId: l.id, cardId: c.id }
}

describe('undo log basics', () => {
  it('canUndo flips true after one recorded mutation', () => {
    expect(undoStatus(db).canUndo).toBe(false)
    seedBoard()
    expect(undoStatus(db).canUndo).toBe(true)
    expect(undoStatus(db).canRedo).toBe(false)
  })

  it('undo of card.update restores the previous value', () => {
    const { cardId, boardId } = seedBoard()
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { title: 'Renamed' }
    })
    expect(
      getBoardView(db, boardId)?.lists[0]?.cards[0]?.title
    ).toBe('Renamed')
    expect(undoOne(db).applied).toBe(true)
    expect(getBoardView(db, boardId)?.lists[0]?.cards[0]?.title).toBe('T')
    // Redo brings the rename back.
    expect(redoOne(db).applied).toBe(true)
    expect(
      getBoardView(db, boardId)?.lists[0]?.cards[0]?.title
    ).toBe('Renamed')
  })

  it('undo of card.create deletes the new card', () => {
    const { listId, boardId } = seedBoard()
    const before = getBoardView(db, boardId)!.lists[0]!.cards.length
    applyMutationRecorded(db, {
      type: 'card.create',
      listId,
      title: 'Another'
    })
    expect(getBoardView(db, boardId)?.lists[0]?.cards).toHaveLength(
      before + 1
    )
    expect(undoOne(db).applied).toBe(true)
    expect(getBoardView(db, boardId)?.lists[0]?.cards).toHaveLength(before)
  })

  it('undo of card.update priority restores the prior value (ADR-0037)', () => {
    const { cardId, boardId } = seedBoard()
    // Climb the ladder so we have a non-null prior state to roll back to.
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { priority: 'low' }
    })
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { priority: 'urgent' }
    })
    expect(getBoardView(db, boardId)?.lists[0]?.cards[0]?.priority).toBe(
      'urgent'
    )
    // First undo: urgent → low.
    expect(undoOne(db).applied).toBe(true)
    expect(getBoardView(db, boardId)?.lists[0]?.cards[0]?.priority).toBe(
      'low'
    )
    // Second undo: low → null.
    expect(undoOne(db).applied).toBe(true)
    expect(getBoardView(db, boardId)?.lists[0]?.cards[0]?.priority).toBeNull()
    // Redo walks back up the ladder.
    expect(redoOne(db).applied).toBe(true)
    expect(getBoardView(db, boardId)?.lists[0]?.cards[0]?.priority).toBe(
      'low'
    )
    expect(redoOne(db).applied).toBe(true)
    expect(getBoardView(db, boardId)?.lists[0]?.cards[0]?.priority).toBe(
      'urgent'
    )
  })

  it('board.update swimlaneMode is NOT recorded (view setting, not data)', () => {
    // ADR-0037 slice 2: swimlane mode is a per-board view setting,
    // not a content mutation. Ctrl+Z should never silently flip the
    // board layout back from Priority to None - and toggling the
    // view in the middle of an undo session shouldn't kill the
    // redo tail either.
    const { boardId, cardId } = seedBoard()
    // Build a known undo + redo state with a real content mutation.
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { title: 'Renamed' }
    })
    expect(undoOne(db).applied).toBe(true) // → status='undone'
    expect(undoStatus(db).canRedo).toBe(true)

    // Now toggle swimlane mode in the middle of the undo session.
    applyMutationRecorded(db, {
      type: 'board.update',
      id: boardId,
      patch: { swimlaneMode: 'priority' }
    })

    // The toggle landed (it was applied, just not recorded).
    expect(getBoardView(db, boardId)?.board.swimlaneMode).toBe('priority')
    // Redo tail untouched: the swimlane toggle didn't clear it.
    // A normal mutation here WOULD have wiped the redo entry.
    expect(undoStatus(db).canRedo).toBe(true)
    // And there's no extra undo entry for the swimlane toggle -
    // redo brings back the card rename, not anything swimlane-shaped.
    expect(redoOne(db).applied).toBe(true)
    const renamed = getBoardView(db, boardId)?.lists[0]?.cards[0]
    expect(renamed?.title).toBe('Renamed')
    // Swimlane state is preserved through the redo.
    expect(getBoardView(db, boardId)?.board.swimlaneMode).toBe('priority')
  })

  it('board.update with a mixed patch (name + swimlaneMode) still records the name part', () => {
    const { boardId } = seedBoard('Orig')
    applyMutationRecorded(db, {
      type: 'board.update',
      id: boardId,
      patch: { name: 'Renamed', swimlaneMode: 'priority' }
    })
    expect(undoOne(db).applied).toBe(true)
    // Name reverts; swimlaneMode stays at the new value (view
    // settings don't ride along even in mixed patches).
    const view = getBoardView(db, boardId)!.board
    expect(view.name).toBe('Orig')
    expect(view.swimlaneMode).toBe('priority')
  })

  it('undo of card.delete preserves priority on restore', () => {
    const { cardId, boardId } = seedBoard()
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { priority: 'high' }
    })
    applyMutationRecorded(db, { type: 'card.delete', id: cardId })
    expect(getBoardView(db, boardId)?.lists[0]?.cards).toHaveLength(0)
    expect(undoOne(db).applied).toBe(true)
    const restored = getBoardView(db, boardId)?.lists[0]?.cards[0]
    expect(restored?.id).toBe(cardId)
    expect(restored?.priority).toBe('high')
  })

  it('undo of card.delete restores the card + its checklists/comments', () => {
    const { cardId, boardId } = seedBoard()
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { description: 'D', completed: true }
    })
    const cl = applyMutationRecorded(db, {
      type: 'checklist.create',
      cardId,
      name: 'Steps'
    })
    applyMutationRecorded(db, {
      type: 'checklistItem.create',
      checklistId: cl.id,
      text: 'one'
    })
    applyMutationRecorded(db, {
      type: 'comment.create',
      cardId,
      body: 'hi'
    })
    // Delete the card - cascades through checklist + items + comments.
    applyMutationRecorded(db, { type: 'card.delete', id: cardId })
    expect(getBoardView(db, boardId)?.lists[0]?.cards).toHaveLength(0)
    // Undo brings everything back exactly as it was.
    expect(undoOne(db).applied).toBe(true)
    const v = getBoardView(db, boardId)!
    const c = v.lists[0]!.cards.find((x) => x.id === cardId)!
    expect(c.title).toBe('T')
    expect(c.description).toBe('D')
    expect(c.completed).toBe(true)
    expect(c.checklists).toHaveLength(1)
    expect(c.checklists[0]?.items).toHaveLength(1)
    expect(c.checklists[0]?.items[0]?.text).toBe('one')
    expect(c.comments).toHaveLength(1)
    expect(c.comments[0]?.body).toBe('hi')
  })

  it('undo of list.delete restores the list + every card under it', () => {
    const { listId, boardId } = seedBoard()
    applyMutationRecorded(db, {
      type: 'card.create',
      listId,
      title: 'Second'
    })
    applyMutationRecorded(db, { type: 'list.delete', id: listId })
    expect(getBoardView(db, boardId)?.lists).toHaveLength(0)
    expect(undoOne(db).applied).toBe(true)
    const v = getBoardView(db, boardId)!
    expect(v.lists).toHaveLength(1)
    expect(v.lists[0]?.cards.map((c) => c.title)).toEqual(['T', 'Second'])
  })

  it('undo of board.delete restores the board + lists + cards + labels', () => {
    const { boardId, cardId } = seedBoard()
    const lbl = applyMutationRecorded(db, {
      type: 'label.create',
      boardId,
      name: 'bug',
      color: '#f00'
    })
    applyMutationRecorded(db, {
      type: 'card.setLabels',
      id: cardId,
      labelIds: [lbl.id]
    })
    expect(listBoards(db).find((b) => b.id === boardId)).toBeDefined()
    applyMutationRecorded(db, { type: 'board.delete', id: boardId })
    expect(listBoards(db).find((b) => b.id === boardId)).toBeUndefined()
    expect(undoOne(db).applied).toBe(true)
    const v = getBoardView(db, boardId)!
    expect(v.board.name).toBe('B')
    expect(v.lists).toHaveLength(1)
    expect(v.lists[0]?.cards).toHaveLength(1)
    expect(v.labels).toHaveLength(1)
    expect(v.labels[0]?.name).toBe('bug')
    expect(v.lists[0]?.cards[0]?.labelIds).toEqual([lbl.id])
  })

  it('undo of board.delete restores the cards activity history', () => {
    const { boardId, cardId } = seedBoard()
    // Each card.update field logs its own activity row.
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { title: 'Renamed' }
    })
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { completed: true }
    })
    const activityCount = (): number =>
      getBoardView(db, boardId)?.lists[0]?.cards[0]?.activities.length ?? 0
    const before = activityCount()
    expect(before).toBeGreaterThan(0)

    applyMutationRecorded(db, { type: 'board.delete', id: boardId })
    expect(undoOne(db).applied).toBe(true)
    // Regression: the feed used to come back EMPTY - activity.boardId is
    // onDelete:cascade, so a board delete wiped every row and the
    // snapshot never carried them.
    expect(activityCount()).toBe(before)
  })

  it('undo of card.delete re-links the cards activity (set-null survivors)', () => {
    const { boardId, cardId } = seedBoard()
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { title: 'Renamed' }
    })
    const activityCount = (): number =>
      getBoardView(db, boardId)
        ?.lists[0]?.cards.find((c) => c.id === cardId)
        ?.activities.length ?? 0
    const before = activityCount()
    expect(before).toBeGreaterThan(0)

    applyMutationRecorded(db, { type: 'card.delete', id: cardId })
    expect(
      getBoardView(db, boardId)?.lists[0]?.cards.find((c) => c.id === cardId)
    ).toBeUndefined()
    expect(undoOne(db).applied).toBe(true)
    // On card delete the rows were NULLed (cardId set-null), so the
    // card-scoped feed query couldn't find them; restore re-links them.
    expect(activityCount()).toBe(before)
  })

  it('undo of card.move puts the card back in its original slot', () => {
    const { cardId, listId, boardId } = seedBoard()
    const second = applyMutationRecorded(db, {
      type: 'list.create',
      boardId,
      name: 'L2'
    })
    applyMutationRecorded(db, {
      type: 'card.move',
      id: cardId,
      toListId: second.id,
      beforeId: null,
      afterId: null
    })
    expect(
      getBoardView(db, boardId)?.lists.find((l) => l.id === second.id)?.cards
        .length
    ).toBe(1)
    expect(undoOne(db).applied).toBe(true)
    const v = getBoardView(db, boardId)!
    expect(v.lists.find((l) => l.id === listId)?.cards.map((c) => c.id)).toEqual([cardId])
    expect(v.lists.find((l) => l.id === second.id)?.cards).toEqual([])
  })

  it('undo of list.move puts the list back in its original slot', () => {
    const { boardId, listId } = seedBoard()
    const b = applyMutationRecorded(db, {
      type: 'list.create',
      boardId,
      name: 'L2'
    }).id
    const c = applyMutationRecorded(db, {
      type: 'list.create',
      boardId,
      name: 'L3'
    }).id
    // Order: [L, L2, L3]. Move L3 to the front (before L).
    applyMutationRecorded(db, { type: 'list.move', id: c, beforeId: null, afterId: listId })
    expect(getBoardView(db, boardId)?.lists.map((l) => l.id)).toEqual([
      c,
      listId,
      b
    ])
    expect(undoOne(db).applied).toBe(true)
    expect(getBoardView(db, boardId)?.lists.map((l) => l.id)).toEqual([
      listId,
      b,
      c
    ])
    // Redo re-applies the move.
    expect(redoOne(db).applied).toBe(true)
    expect(getBoardView(db, boardId)?.lists.map((l) => l.id)).toEqual([
      c,
      listId,
      b
    ])
  })

  it('undo of card.setLabels restores the previous label set', () => {
    const { boardId, cardId } = seedBoard()
    const a = applyMutationRecorded(db, {
      type: 'label.create',
      boardId,
      name: 'a',
      color: '#0a0'
    })
    const b = applyMutationRecorded(db, {
      type: 'label.create',
      boardId,
      name: 'b',
      color: '#a00'
    })
    applyMutationRecorded(db, {
      type: 'card.setLabels',
      id: cardId,
      labelIds: [a.id]
    })
    applyMutationRecorded(db, {
      type: 'card.setLabels',
      id: cardId,
      labelIds: [b.id]
    })
    const view = (): string[] =>
      getBoardView(db, boardId)!.lists[0]!.cards[0]!.labelIds
    expect(view()).toEqual([b.id])
    expect(undoOne(db).applied).toBe(true)
    expect(view()).toEqual([a.id])
    expect(undoOne(db).applied).toBe(true)
    expect(view()).toEqual([])
  })

  it('a new mutation clears the redo stack (standard editor model)', () => {
    const { cardId, boardId } = seedBoard()
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { title: 'A' }
    })
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { title: 'B' }
    })
    expect(undoOne(db).applied).toBe(true) // back to 'A'
    expect(undoStatus(db).canRedo).toBe(true)
    // Branching edit drops the redo stack.
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { title: 'C' }
    })
    expect(undoStatus(db).canRedo).toBe(false)
    expect(
      getBoardView(db, boardId)?.lists[0]?.cards[0]?.title
    ).toBe('C')
  })

  it('caps the stack at MAX_UNDO_LOG_SIZE undoable entries', () => {
    const { cardId } = seedBoard()
    // seedBoard already added 3 undoable entries; aim for MAX + 5.
    const target = MAX_UNDO_LOG_SIZE + 5
    for (let i = 0; i < target; i++) {
      applyMutationRecorded(db, {
        type: 'card.update',
        id: cardId,
        patch: { title: `t${i}` }
      })
    }
    // After capping, the deepest still-undoable history is MAX_UNDO_LOG_SIZE entries.
    // We can verify by counting how many times undo runs before canUndo flips.
    let undoCount = 0
    while (undoStatus(db).canUndo && undoCount < MAX_UNDO_LOG_SIZE + 50) {
      undoOne(db)
      undoCount++
    }
    expect(undoCount).toBe(MAX_UNDO_LOG_SIZE)
  })

  it('undo on an empty stack is a no-op (not an error)', () => {
    const r = undoOne(db)
    expect(r.applied).toBe(false)
  })

  it('redo on an empty stack is a no-op (not an error)', () => {
    const r = redoOne(db)
    expect(r.applied).toBe(false)
  })
})

describe('bulk-gesture grouping (applyMutationsRecorded)', () => {
  const titles = (): string[] =>
    getBoardView(db)!.lists[0]!.cards.map((x) => x.title)

  it('one Ctrl+Z unwinds an entire bulk batch, one Ctrl+Y replays it', () => {
    const { listId } = seedBoard()
    const results = applyMutationsRecorded(db, [
      { type: 'card.create', listId, title: 'g-A' },
      { type: 'card.create', listId, title: 'g-B' },
      { type: 'card.create', listId, title: 'g-C' }
    ])
    expect(results).toHaveLength(3)
    expect(titles()).toEqual(['T', 'g-A', 'g-B', 'g-C'])

    // The whole gesture is one undo step.
    const out = undoOne(db)
    expect(out.applied).toBe(true)
    expect(titles()).toEqual(['T'])

    // And one redo step - same ids ride back in.
    redoOne(db)
    expect(titles()).toEqual(['T', 'g-A', 'g-B', 'g-C'])
    const ids = getBoardView(db)!.lists[0]!.cards.map((x) => x.id)
    for (const r of results) expect(ids).toContain(r.id)
  })

  it('undoStatus surfaces the group size in the description', () => {
    const { listId } = seedBoard()
    applyMutationsRecorded(db, [
      { type: 'card.create', listId, title: 'g-A' },
      { type: 'card.create', listId, title: 'g-B' }
    ])
    expect(undoStatus(db).undoDescription).toContain('(2 changes)')
    undoOne(db)
    expect(undoStatus(db).redoDescription).toContain('(2 changes)')
  })

  it('a single-mutation batch records ungrouped (plain entry)', () => {
    const { listId } = seedBoard()
    applyMutationsRecorded(db, [
      { type: 'card.create', listId, title: 'solo' }
    ])
    expect(undoStatus(db).undoDescription).toBe('Create card "solo"')
    undoOne(db)
    expect(titles()).toEqual(['T'])
  })

  it('a grouped batch is atomic - one failing mutation rolls back all', () => {
    const { listId } = seedBoard()
    expect(() =>
      applyMutationsRecorded(db, [
        { type: 'card.create', listId, title: 'will-roll-back' },
        // FK violation - no such list.
        { type: 'card.create', listId: 'no-such-list', title: 'boom' }
      ])
    ).toThrow()
    expect(titles()).toEqual(['T'])
    // Nothing recorded either - undo has only the seed entries left.
    const status = undoStatus(db)
    expect(status.undoDescription).not.toContain('will-roll-back')
  })

  it('chained bulk moves keep their order through undo/redo', () => {
    const { boardId, listId } = seedBoard()
    const l2 = applyMutationRecorded(db, {
      type: 'list.create',
      boardId,
      name: 'L2'
    })
    const a = applyMutationRecorded(db, {
      type: 'card.create',
      listId,
      title: 'm-A'
    })
    const bCard = applyMutationRecorded(db, {
      type: 'card.create',
      listId,
      title: 'm-B'
    })
    // Bulk "move to L2" - beforeId chains exactly like bulkMoveTo.
    applyMutationsRecorded(db, [
      {
        type: 'card.move',
        id: a.id,
        toListId: l2.id,
        beforeId: null,
        afterId: null
      },
      {
        type: 'card.move',
        id: bCard.id,
        toListId: l2.id,
        beforeId: a.id,
        afterId: null
      }
    ])
    const inL2 = (): string[] =>
      getBoardView(db)!
        .lists.find((l) => l.id === l2.id)!
        .cards.map((c) => c.title)
    expect(inL2()).toEqual(['m-A', 'm-B'])
    expect(titles()).toEqual(['T'])

    // One undo puts BOTH cards back in the source list, in order.
    undoOne(db)
    expect(inL2()).toEqual([])
    expect(titles()).toEqual(['T', 'm-A', 'm-B'])

    // One redo re-runs the gesture.
    redoOne(db)
    expect(inL2()).toEqual(['m-A', 'm-B'])
  })
})

describe('same-millisecond ordering (bulk gestures)', () => {
  it('undoes same-ms entries newest-first and redoes oldest-first', () => {
    const { listId } = seedBoard()
    // Freeze the clock so every entry lands on ONE createdAt value -
    // exactly what a bulk multi-select action produces. Ordering then
    // rides entirely on the UUIDv7 id tiebreaker.
    const frozen = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(frozen)
    try {
      const a = applyMutationRecorded(db, {
        type: 'card.create',
        listId,
        title: 'bulk-A'
      })
      const b = applyMutationRecorded(db, {
        type: 'card.create',
        listId,
        title: 'bulk-B'
      })
      const c = applyMutationRecorded(db, {
        type: 'card.create',
        listId,
        title: 'bulk-C'
      })

      const titles = (): string[] =>
        getBoardView(db)!.lists[0]!.cards.map((x) => x.title)
      expect(titles()).toEqual(['T', 'bulk-A', 'bulk-B', 'bulk-C'])

      // Undo pops strictly newest-first: C, then B, then A.
      undoOne(db)
      expect(titles()).toEqual(['T', 'bulk-A', 'bulk-B'])
      undoOne(db)
      expect(titles()).toEqual(['T', 'bulk-A'])
      undoOne(db)
      expect(titles()).toEqual(['T'])

      // Redo replays oldest-first: A, then B, then C - same ids.
      redoOne(db)
      expect(titles()).toEqual(['T', 'bulk-A'])
      redoOne(db)
      expect(titles()).toEqual(['T', 'bulk-A', 'bulk-B'])
      redoOne(db)
      expect(titles()).toEqual(['T', 'bulk-A', 'bulk-B', 'bulk-C'])
      const ids = getBoardView(db)!.lists[0]!.cards.map((x) => x.id)
      expect(ids).toContain(a.id)
      expect(ids).toContain(b.id)
      expect(ids).toContain(c.id)
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('redo + chained creates (id-preservation)', () => {
  it('redo of a create reuses the original id so downstream entries still resolve', () => {
    const { boardId, listId } = seedBoard()
    // Create a new card, then update it. After undo undo + redo redo,
    // the update should still target the SAME card (the redo of the
    // create must reuse the original id, not mint a fresh one).
    const created = applyMutationRecorded(db, {
      type: 'card.create',
      listId,
      title: 'X'
    })
    applyMutationRecorded(db, {
      type: 'card.update',
      id: created.id,
      patch: { title: 'Y' }
    })
    // Roll the world back to before creation.
    expect(undoOne(db).applied).toBe(true) // undo update → 'X'
    expect(undoOne(db).applied).toBe(true) // undo create → card gone
    expect(
      getBoardView(db, boardId)?.lists[0]?.cards.find(
        (c) => c.id === created.id
      )
    ).toBeUndefined()
    // Redo create, then redo update.
    expect(redoOne(db).applied).toBe(true)
    const recreated = getBoardView(db, boardId)?.lists[0]?.cards.find(
      (c) => c.id === created.id
    )
    expect(recreated).toBeDefined()
    expect(recreated?.title).toBe('X') // forward title, pre-update
    expect(redoOne(db).applied).toBe(true)
    expect(
      getBoardView(db, boardId)?.lists[0]?.cards.find(
        (c) => c.id === created.id
      )?.title
    ).toBe('Y')
  })

  it('redo of list.create + redo of card.create-in-it still resolves the FK', () => {
    const { boardId } = seedBoard()
    const newList = applyMutationRecorded(db, {
      type: 'list.create',
      boardId,
      name: 'NEW'
    })
    const newCard = applyMutationRecorded(db, {
      type: 'card.create',
      listId: newList.id,
      title: 'in-NEW'
    })
    // Tear the chain down.
    expect(undoOne(db).applied).toBe(true) // undo card.create
    expect(undoOne(db).applied).toBe(true) // undo list.create → list gone
    // Redo both. Before the id-preservation fix, the redo of
    // list.create minted a fresh id, then redo of card.create
    // failed with a FOREIGN KEY error because the original listId
    // no longer existed.
    expect(redoOne(db).applied).toBe(true)
    expect(redoOne(db).applied).toBe(true)
    // Both back and consistent.
    const v = getBoardView(db, boardId)!
    const restored = v.lists.find((l) => l.id === newList.id)
    expect(restored).toBeDefined()
    expect(restored?.cards.map((c) => c.id)).toContain(newCard.id)
  })

  it('redo of board.duplicate recreates the SAME board id (no orphaned copy)', () => {
    const { boardId } = seedBoard('Orig')
    const copies = (): string[] =>
      listBoards(db)
        .filter((b) => b.name.endsWith('(copy)'))
        .map((b) => b.id)

    const dup = applyMutationRecorded(db, {
      type: 'board.duplicate',
      id: boardId
    })
    expect(copies()).toEqual([dup.id])

    // Undo removes the duplicate.
    expect(undoOne(db).applied).toBe(true)
    expect(copies()).toEqual([])

    // Redo must recreate the SAME id. Before the fix it minted a FRESH
    // id (board.duplicate wasn't backfilled), so the stored inverse
    // `board.delete <dup.id>` dangled.
    expect(redoOne(db).applied).toBe(true)
    expect(copies()).toEqual([dup.id])

    // The second undo therefore resolves to a still-valid inverse and
    // removes the copy cleanly. Before the fix this left a stranded
    // copy (the redo's new id) that no undo entry pointed at.
    expect(undoOne(db).applied).toBe(true)
    expect(copies()).toEqual([])
  })
})

describe('scopeBoardId (ADR-0036 revision: per-board Ctrl+Z)', () => {
  it('undoOne with a scope only touches that board; ignores other boards', () => {
    // Two boards, each with a card.update on top of the undo stack.
    const a = seedBoard('A')
    const b = seedBoard('B')
    applyMutationRecorded(db, {
      type: 'card.update',
      id: a.cardId,
      patch: { title: 'A-edited' }
    })
    applyMutationRecorded(db, {
      type: 'card.update',
      id: b.cardId,
      patch: { title: 'B-edited' }
    })
    // Most-recent undoable is B's edit. Scope to A → that's skipped,
    // we go to A's edit instead. Only A is reverted; B stays edited.
    const r = undoOne(db, a.boardId)
    expect(r.applied).toBe(true)
    expect(r.boardId).toBe(a.boardId)
    expect(
      getBoardView(db, a.boardId)?.lists[0]?.cards[0]?.title
    ).toBe('T')
    expect(
      getBoardView(db, b.boardId)?.lists[0]?.cards[0]?.title
    ).toBe('B-edited')
  })

  it('undoOne with no scope picks the most recent across all boards', () => {
    const a = seedBoard('A')
    const b = seedBoard('B')
    applyMutationRecorded(db, {
      type: 'card.update',
      id: a.cardId,
      patch: { title: 'A-edit' }
    })
    applyMutationRecorded(db, {
      type: 'card.update',
      id: b.cardId,
      patch: { title: 'B-edit' }
    })
    const r = undoOne(db) // no scope = global
    expect(r.applied).toBe(true)
    // B's edit was most recent; result.boardId should report B so the
    // renderer can auto-navigate from home / settings.
    expect(r.boardId).toBe(b.boardId)
  })

  it('returns applied:false when the scope has no entries', () => {
    const a = seedBoard('A')
    const b = seedBoard('B')
    // Wipe the seed's recorded creates so board A is genuinely
    // empty on the stack.
    clearUndoLog(db)
    applyMutationRecorded(db, {
      type: 'card.update',
      id: b.cardId,
      patch: { title: 'B-edit' }
    })
    // Scope to A - no eligible entries.
    const r = undoOne(db, a.boardId)
    expect(r.applied).toBe(false)
  })

  it('redoOne respects the scope too', () => {
    const a = seedBoard('A')
    const b = seedBoard('B')
    applyMutationRecorded(db, {
      type: 'card.update',
      id: a.cardId,
      patch: { title: 'A-edit' }
    })
    applyMutationRecorded(db, {
      type: 'card.update',
      id: b.cardId,
      patch: { title: 'B-edit' }
    })
    // Undo both (most-recent first).
    expect(undoOne(db).applied).toBe(true) // B
    expect(undoOne(db).applied).toBe(true) // A
    // Now redo with scope=A → only A's redo fires, B's stays undone.
    const r = redoOne(db, a.boardId)
    expect(r.applied).toBe(true)
    expect(r.boardId).toBe(a.boardId)
    expect(
      getBoardView(db, a.boardId)?.lists[0]?.cards[0]?.title
    ).toBe('A-edit')
    expect(
      getBoardView(db, b.boardId)?.lists[0]?.cards[0]?.title
    ).toBe('T')
  })
})

describe('clearUndoLog (Settings → Data escape hatch)', () => {
  it('wipes both stacks; canUndo + canRedo flip false; DB itself untouched', () => {
    const { boardId, cardId } = seedBoard()
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { title: 'X' }
    })
    expect(undoOne(db).applied).toBe(true) // populate redo stack
    expect(undoStatus(db).canUndo).toBe(true)
    expect(undoStatus(db).canRedo).toBe(true)
    clearUndoLog(db)
    expect(undoStatus(db).canUndo).toBe(false)
    expect(undoStatus(db).canRedo).toBe(false)
    // DB untouched - the card title reflects the last-applied state
    // before clearing (the undo above reverted X → T).
    expect(
      getBoardView(db, boardId)?.lists[0]?.cards.find((c) => c.id === cardId)
        ?.title
    ).toBe('T')
  })
})

describe('undo/redo drift is silent + drops the bad entry', () => {
  it('redo whose parent FK has gone away soft-fails and drops the entry', () => {
    // Scenario: create a list under a board, undo it (list gone),
    // then nuke the board out-of-band so the list's parent FK is
    // gone, then try to redo the list.create. Before the fix this
    // spammed "Error occurred in handler for 'redo:apply'" repeatedly
    // because the cleanup ran inside the failed transaction and got
    // rolled back. Now: applied:false, entry dropped, no throw.
    const { boardId } = seedBoard()
    applyMutationRecorded(db, {
      type: 'list.create',
      boardId,
      name: 'will-orphan'
    })
    expect(undoOne(db).applied).toBe(true) // list deleted
    expect(undoStatus(db).canRedo).toBe(true)
    // Out-of-band nuke. The recorder is bypassed so the undo log
    // doesn't pick up the board.delete; it just leaves the redo
    // stack referencing a board id that's now gone.
    applyMutation(db, { type: 'board.delete', id: boardId })
    // The bad redo entry is on top of the redo stack.
    const r = redoOne(db)
    expect(r.applied).toBe(false)
    // And the next attempt either targets a different entry or
    // (when there's nothing else to redo) cleanly returns
    // applied:false again. Critically: no throw on either call.
    expect(() => redoOne(db)).not.toThrow()
  })
})

describe('out-of-scope: mutations the recorder intentionally skips', () => {
  it('project.update does not push to the undo stack', () => {
    // Projects are hidden in the UI and have no user-facing edit
    // surface; their mutations are intentionally non-undoable.
    // ensureDefaultProjectId() seeded one already.
    const before = undoStatus(db).canUndo
    applyMutationRecorded(db, {
      type: 'project.update',
      id: projectId,
      patch: { name: 'Renamed' }
    })
    // Stack should be unchanged.
    expect(undoStatus(db).canUndo).toBe(before)
  })

  it('a restore mutation is never itself recorded', () => {
    // Restores happen only as the inverse of a delete-style mutation
    // when undo fires (silent re-apply). A renderer-issued restore
    // wouldn't get recorded either (the recorder short-circuits).
    const { boardId } = seedBoard()
    const undoCountBefore = undoStatus(db).canUndo
    // Synthesise a minimal snapshot and fire restore through the
    // recorder (mimicking what would happen if a caller dispatched
    // it directly - they shouldn't, but the contract is "no record").
    applyMutationRecorded(db, {
      type: 'restore',
      payload: {
        kind: 'card',
        card: {
          id: 'restore-test-card',
          listId: getBoardView(db, boardId)!.lists[0]!.id,
          title: 'fake',
          description: null,
          position: 'a0',
          dueAt: null,
          completed: false,
          coverAttachmentId: null,
          archived: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          labelIds: [],
          checklists: [],
          comments: [],
          attachments: []
        }
      }
    })
    // Same canUndo as before - the restore went through but no log
    // row was added.
    expect(undoStatus(db).canUndo).toBe(undoCountBefore)
  })
})

describe('multi-step undo + redo round-trip is stable', () => {
  // Activity log row identities (id, createdAt) don't round-trip
  // across undo/redo by design - the inverse mutation re-fires
  // `logActivity`, so each cycle adds a fresh activity row. The
  // user-visible state (titles, descriptions, ordering, etc.) does
  // round-trip exactly, which is what this test pins.
  type StateShape = {
    name: string
    lists: Array<{
      name: string
      cards: Array<{
        id: string
        title: string
        description: string | null
        completed: boolean
        labelIds: string[]
        position: string
      }>
    }>
  }
  const visibleShape = (boardId: string): StateShape => {
    const v = getBoardView(db, boardId)!
    return {
      name: v.board.name,
      lists: v.lists.map((l) => ({
        name: l.name,
        cards: l.cards.map((c) => ({
          id: c.id,
          title: c.title,
          description: c.description,
          completed: c.completed,
          labelIds: c.labelIds,
          position: c.position
        }))
      }))
    }
  }

  it('undo all → redo all returns the user-visible state to exact pre-undo shape', () => {
    const { boardId, listId, cardId } = seedBoard()
    // Pile up a few entries on top of the seed (already 3 entries).
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { title: 'X' }
    })
    applyMutationRecorded(db, {
      type: 'card.create',
      listId,
      title: 'Y'
    })
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { description: 'desc' }
    })
    const before = visibleShape(boardId)
    // Undo everything that's undoable for this board.
    while (undoOne(db, boardId).applied) {
      /* loop */
    }
    // After full undo the board itself is gone (board.create was on
    // the stack and got reversed).
    expect(getBoardView(db, boardId)).toBeNull()
    // Redo everything that's redoable for this board.
    while (redoOne(db, boardId).applied) {
      /* loop */
    }
    const after = visibleShape(boardId)
    expect(after).toEqual(before)
  })
})

describe('restoreCard tolerates labels that were deleted out-of-band', () => {
  it('restores the card minus any missing label references; no FK throw', () => {
    const { boardId, cardId } = seedBoard()
    // Attach a label, then delete the card AND the label (via
    // applyMutation, NOT the recorder - so the recorder's snapshot
    // for the card.delete that follows captures labelIds including
    // the about-to-be-pruned label.id).
    const lbl = applyMutationRecorded(db, {
      type: 'label.create',
      boardId,
      name: 'bug',
      color: '#f00'
    })
    applyMutationRecorded(db, {
      type: 'card.setLabels',
      id: cardId,
      labelIds: [lbl.id]
    })
    // Delete the card via the recorder (snapshot captures labelIds=[lbl.id]).
    applyMutationRecorded(db, { type: 'card.delete', id: cardId })
    // Now delete the label out-of-band - bypasses the recorder so
    // there's no inverse for the label.delete on the stack. The card
    // snapshot still references it.
    applyMutation(db, { type: 'label.delete', id: lbl.id })
    // Undo the card.delete. The restore would FK-violate without the
    // labelId stillExist filter - this test pins the fix.
    expect(() => undoOne(db, boardId)).not.toThrow()
    const v = getBoardView(db, boardId)!
    const restored = v.lists[0]?.cards.find((c) => c.id === cardId)
    expect(restored).toBeDefined()
    // Card came back, but with no labels - the missing one was
    // filtered out instead of crashing the whole restore.
    expect(restored?.labelIds).toEqual([])
  })
})

describe('snapshots are self-contained', () => {
  it('snapshotCard captures every dependent row needed for restore', () => {
    const { cardId } = seedBoard()
    applyMutationRecorded(db, {
      type: 'card.update',
      id: cardId,
      patch: { description: 'desc' }
    })
    const cl = applyMutationRecorded(db, {
      type: 'checklist.create',
      cardId,
      name: 'cl'
    })
    applyMutationRecorded(db, {
      type: 'checklistItem.create',
      checklistId: cl.id,
      text: 'i1'
    })
    applyMutationRecorded(db, {
      type: 'comment.create',
      cardId,
      body: 'cmt'
    })
    const snap = snapshotCard(db, cardId)
    expect(snap).toBeDefined()
    expect(snap?.description).toBe('desc')
    expect(snap?.checklists).toHaveLength(1)
    expect(snap?.checklists[0]?.items).toHaveLength(1)
    expect(snap?.comments).toHaveLength(1)
  })

  it('snapshotBoard captures lists + cards + labels nested', () => {
    const { boardId } = seedBoard()
    applyMutationRecorded(db, {
      type: 'label.create',
      boardId,
      name: 'lbl',
      color: '#fff'
    })
    const snap = snapshotBoard(db, boardId)
    expect(snap?.lists).toHaveLength(1)
    expect(snap?.lists[0]?.cards).toHaveLength(1)
    expect(snap?.labels).toHaveLength(1)
  })
})
