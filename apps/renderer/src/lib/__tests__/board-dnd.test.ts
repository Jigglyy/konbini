import { describe, expect, it } from 'vitest'
import type { BoardView, CardPriority, CardView } from '@kanbini/shared'
import {
  computeMoveTarget,
  findNextNonEmptyListIndex,
  findWipBlock,
  isSortedListReorder,
  isUnchangedMove,
  laneOf,
  listOf,
  planListMove,
  planSwimlaneDrop,
  reduceCardMove,
  reorderVisibleLists
} from '../board-dnd'
import {
  laneKeyOfCard,
  lanesForMode,
  parseLaneDroppable
} from '../../components/swimlane-board'
import { priorityColor } from '../../components/priority'

// Tests for the pure DnD helpers - both the freshly-extracted listOf
// + laneOf (lib/board-dnd.ts) and the swimlane-board exports they
// compose with. Covers the four droppable-id shapes the reducer sees:
//   - bare card id      → walk lists to find the owning list
//   - "list:<id>"       → flat-mode list-end droppable
//   - "lane:<key>:list:<id>" → swimlane per-cell droppable
//   - unknown id        → null (reducer short-circuits)

function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'c1',
    title: 'Card',
    description: null,
    position: 'a',
    completed: false,
    dueAt: null,
    priority: null,
    labelIds: [],
    checklists: [],
    comments: [],
    attachments: [],
    coverAttachmentId: null,
    activities: [],
    ...overrides
  }
}

function makeBoard(
  lists: Array<{
    id: string
    cards: CardView[]
    wipLimit?: number | null
    sortMode?: 'created-asc' | 'created-desc' | null
  }>
): BoardView {
  return {
    project: { id: 'p1', name: 'Sample' },
    board: {
      id: 'b1',
      name: 'Board',
      color: null,
      background: null,
      swimlaneMode: null
    },
    labels: [],
    lists: lists.map((l) => ({
      id: l.id,
      name: l.id,
      color: null,
      closed: false,
      position: 'a',
      wipLimit: l.wipLimit ?? null,
      sortMode: l.sortMode ?? null,
      onEnter: null,
      cards: l.cards
    }))
  }
}

// ─── listOf ───────────────────────────────────────────────────────

describe('listOf', () => {
  it('resolves a bare card id to its owning list', () => {
    const b = makeBoard([
      { id: 'todo', cards: [makeCard({ id: 'c1' })] },
      { id: 'doing', cards: [makeCard({ id: 'c2' })] }
    ])
    expect(listOf(b, 'c1')).toBe('todo')
    expect(listOf(b, 'c2')).toBe('doing')
  })

  it("decodes a flat-mode 'list:<id>' droppable", () => {
    const b = makeBoard([{ id: 'todo', cards: [] }])
    expect(listOf(b, 'list:todo')).toBe('todo')
    // Decoding is purely string surgery - doesn't even need the list
    // to exist (the reducer trusts dnd-kit's droppable registry).
    expect(listOf(b, 'list:does-not-exist')).toBe('does-not-exist')
  })

  it("decodes a swimlane 'lane:<key>:list:<id>' droppable", () => {
    const b = makeBoard([{ id: 'todo', cards: [] }])
    expect(listOf(b, 'lane:high:list:todo')).toBe('todo')
    expect(listOf(b, 'lane:none:list:doing')).toBe('doing')
  })

  it('returns null when the id is malformed or unknown', () => {
    const b = makeBoard([{ id: 'todo', cards: [] }])
    // Empty card id, malformed lane droppable, unknown card id.
    expect(listOf(b, 'lane:no-separator')).toBeNull()
    expect(listOf(b, 'unknown-card-id')).toBeNull()
  })
})

// ─── laneOf ───────────────────────────────────────────────────────

describe('laneOf', () => {
  it('returns null in flat mode (no swimlanes)', () => {
    const b = makeBoard([
      { id: 'todo', cards: [makeCard({ id: 'c1', priority: 'high' })] }
    ])
    expect(laneOf(b, 'c1', null)).toBeNull()
  })

  it('decodes the lane key from an explicit lane droppable', () => {
    const b = makeBoard([])
    expect(laneOf(b, 'lane:urgent:list:todo', 'priority')).toBe('urgent')
    expect(laneOf(b, 'lane:none:list:todo', 'priority')).toBe('none')
  })

  it("resolves a card id to its lane key under 'priority' mode", () => {
    const b = makeBoard([
      {
        id: 'todo',
        cards: [
          makeCard({ id: 'cu', priority: 'urgent' }),
          makeCard({ id: 'ch', priority: 'high' }),
          makeCard({ id: 'cn', priority: null })
        ]
      }
    ])
    expect(laneOf(b, 'cu', 'priority')).toBe('urgent')
    expect(laneOf(b, 'ch', 'priority')).toBe('high')
    // null priority maps to the "none" lane.
    expect(laneOf(b, 'cn', 'priority')).toBe('none')
  })

  it('returns null for an unknown card id in swimlane mode', () => {
    const b = makeBoard([])
    expect(laneOf(b, 'no-such-card', 'priority')).toBeNull()
  })

  it('returns null for a malformed lane droppable', () => {
    const b = makeBoard([])
    expect(laneOf(b, 'lane:no-separator', 'priority')).toBeNull()
  })
})

// ─── swimlane helpers (parseLaneDroppable / laneKeyOfCard / lanesForMode) ───

describe('parseLaneDroppable', () => {
  it("returns null for ids that don't start with 'lane:'", () => {
    expect(parseLaneDroppable('list:todo')).toBeNull()
    expect(parseLaneDroppable('some-card-uuid')).toBeNull()
    expect(parseLaneDroppable('')).toBeNull()
  })

  it('parses lane:<key>:list:<id> into its parts', () => {
    expect(parseLaneDroppable('lane:high:list:todo')).toEqual({
      laneKey: 'high',
      listId: 'todo'
    })
    expect(parseLaneDroppable('lane:none:list:l-1')).toEqual({
      laneKey: 'none',
      listId: 'l-1'
    })
  })

  it("returns null when the ':list:' separator is missing", () => {
    expect(parseLaneDroppable('lane:high')).toBeNull()
    expect(parseLaneDroppable('lane:high:cardId')).toBeNull()
  })

  it('handles lane keys / list ids that contain plain colons', () => {
    // Future label-mode keys look like `label:<uuid>` - must round-trip.
    expect(
      parseLaneDroppable('lane:label:abc123:list:l-1')
    ).toEqual({ laneKey: 'label:abc123', listId: 'l-1' })
  })
})

describe('laneKeyOfCard', () => {
  it('maps each priority to its own lane key', () => {
    const priorities: Array<CardPriority> = ['urgent', 'high', 'medium', 'low']
    for (const p of priorities) {
      expect(laneKeyOfCard(makeCard({ priority: p }), 'priority')).toBe(p)
    }
  })

  it('maps null priority to the "none" lane', () => {
    expect(laneKeyOfCard(makeCard({ priority: null }), 'priority')).toBe(
      'none'
    )
  })
})

describe('lanesForMode', () => {
  it("returns the five priority lanes in display order for 'priority' mode", () => {
    const lanes = lanesForMode('priority')
    expect(lanes.map((l) => l.key)).toEqual([
      'urgent',
      'high',
      'medium',
      'low',
      'none'
    ])
  })

  it('each lane carries label + priority + (sometimes) color', () => {
    const lanes = lanesForMode('priority')
    for (const lane of lanes) {
      expect(typeof lane.key).toBe('string')
      expect(typeof lane.label).toBe('string')
      expect(lane.priority === null || typeof lane.priority === 'string').toBe(
        true
      )
    }
    // "No priority" lane carries null priority + null color.
    const none = lanes.find((l) => l.key === 'none')!
    expect(none.priority).toBeNull()
    expect(none.color).toBeNull()
  })

  it('lane colours match the priority badge palette (no drift)', () => {
    // The swimlane headers used to hardcode a copy of the priority
    // colours that fell out of sync when the ramp was re-tuned; they
    // now derive from priorityColor, pinned here.
    for (const lane of lanesForMode('priority')) {
      if (lane.priority) {
        expect(lane.color).toBe(priorityColor(lane.priority))
      }
    }
  })
})

// ─── reducer projections (onDragOver / onDragEnd) ─────────────────

describe('findWipBlock', () => {
  it('returns null when fromList === toList (within-list reorder)', () => {
    const b = makeBoard([
      {
        id: 'todo',
        wipLimit: 2,
        cards: [makeCard({ id: 'c1' }), makeCard({ id: 'c2' })]
      }
    ])
    expect(findWipBlock(b, 'c1', 'c2')).toBeNull()
  })

  it('returns null when the destination list has no WIP limit', () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1' })] },
      { id: 'b', wipLimit: null, cards: [] }
    ])
    expect(findWipBlock(b, 'c1', 'list:b')).toBeNull()
  })

  it('returns null when the destination is below its WIP limit', () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1' })] },
      { id: 'b', wipLimit: 5, cards: [makeCard({ id: 'c2' })] }
    ])
    expect(findWipBlock(b, 'c1', 'list:b')).toBeNull()
  })

  it('returns the blocking list id when destination is at its WIP limit', () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1' })] },
      {
        id: 'b',
        wipLimit: 1,
        cards: [makeCard({ id: 'c2' })]
      }
    ])
    expect(findWipBlock(b, 'c1', 'list:b')).toBe('b')
  })

  it('respects the limit on cross-list drops onto a sibling card', () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1' })] },
      { id: 'b', wipLimit: 1, cards: [makeCard({ id: 'c2' })] }
    ])
    // Dropping c1 onto c2 → cross-list → b is full.
    expect(findWipBlock(b, 'c1', 'c2')).toBe('b')
  })
})

describe('isSortedListReorder', () => {
  it('returns false when fromList !== toList (cross-list drop into sorted list is allowed)', () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1' })] },
      {
        id: 'b',
        sortMode: 'created-desc',
        cards: [makeCard({ id: 'c2' })]
      }
    ])
    expect(isSortedListReorder(b, 'c1', 'c2')).toBe(false)
  })

  it('returns false on a manual-sort list (no sortMode override)', () => {
    const b = makeBoard([
      {
        id: 'a',
        cards: [makeCard({ id: 'c1' }), makeCard({ id: 'c2' })]
      }
    ])
    expect(isSortedListReorder(b, 'c1', 'c2')).toBe(false)
  })

  it('returns true for within-list reorder on a sortMode-overridden list', () => {
    const b = makeBoard([
      {
        id: 'a',
        sortMode: 'created-desc',
        cards: [makeCard({ id: 'c1' }), makeCard({ id: 'c2' })]
      }
    ])
    expect(isSortedListReorder(b, 'c1', 'c2')).toBe(true)
  })
})

describe('reduceCardMove', () => {
  it('returns prev unchanged when activeId is missing from the board', () => {
    const b = makeBoard([{ id: 'a', cards: [makeCard({ id: 'c1' })] }])
    expect(reduceCardMove(b, 'ghost', 'c1', 'before')).toBe(b)
  })

  it('returns prev unchanged when over neighbour is missing', () => {
    const b = makeBoard([{ id: 'a', cards: [makeCard({ id: 'c1' })] }])
    expect(reduceCardMove(b, 'c1', 'unknown', 'before')).toBe(b)
  })

  it('same-list reorder uses arrayMove to swap positions', () => {
    const b = makeBoard([
      {
        id: 'a',
        cards: [
          makeCard({ id: 'c1' }),
          makeCard({ id: 'c2' }),
          makeCard({ id: 'c3' })
        ]
      }
    ])
    const next = reduceCardMove(b, 'c1', 'c3', 'after')
    expect(next.lists[0]!.cards.map((c) => c.id)).toEqual(['c2', 'c3', 'c1'])
  })

  it('same-list reorder no-ops when target equals current position', () => {
    const b = makeBoard([
      {
        id: 'a',
        cards: [makeCard({ id: 'c1' }), makeCard({ id: 'c2' })]
      }
    ])
    expect(reduceCardMove(b, 'c1', 'c1', 'before')).toBe(b)
  })

  it("cross-list drop on 'list:<id>' droppable appends to destination", () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1' })] },
      { id: 'b', cards: [makeCard({ id: 'c2' }), makeCard({ id: 'c3' })] }
    ])
    const next = reduceCardMove(b, 'c1', 'list:b', 'before')
    expect(next.lists[0]!.cards.map((c) => c.id)).toEqual([])
    expect(next.lists[1]!.cards.map((c) => c.id)).toEqual(['c2', 'c3', 'c1'])
  })

  it("cross-list drop on a sibling with position='before' inserts above it", () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1' })] },
      { id: 'b', cards: [makeCard({ id: 'c2' }), makeCard({ id: 'c3' })] }
    ])
    const next = reduceCardMove(b, 'c1', 'c3', 'before')
    expect(next.lists[1]!.cards.map((c) => c.id)).toEqual(['c2', 'c1', 'c3'])
  })

  it("cross-list drop on a sibling with position='after' inserts below it", () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1' })] },
      { id: 'b', cards: [makeCard({ id: 'c2' }), makeCard({ id: 'c3' })] }
    ])
    const next = reduceCardMove(b, 'c1', 'c2', 'after')
    expect(next.lists[1]!.cards.map((c) => c.id)).toEqual(['c2', 'c1', 'c3'])
  })

  it("same-list drop on the column's own droppable rotates the card to the end", () => {
    // Reproduces the bug the explicit "if (l.id === fromId && l.id ===
    // toId)" branch fixes - without it the card vanished from the
    // cache because filter ran but insert didn't.
    const b = makeBoard([
      {
        id: 'a',
        cards: [
          makeCard({ id: 'c1' }),
          makeCard({ id: 'c2' }),
          makeCard({ id: 'c3' })
        ]
      }
    ])
    const next = reduceCardMove(b, 'c1', 'list:a', 'before')
    expect(next.lists[0]!.cards.map((c) => c.id)).toEqual(['c2', 'c3', 'c1'])
  })
})

describe('computeMoveTarget', () => {
  it('returns null when activeId is missing from the board', () => {
    const b = makeBoard([{ id: 'a', cards: [makeCard({ id: 'c1' })] }])
    expect(computeMoveTarget(b, 'ghost')).toBeNull()
  })

  it('returns the list + null neighbours for a single-card list', () => {
    const b = makeBoard([{ id: 'a', cards: [makeCard({ id: 'c1' })] }])
    expect(computeMoveTarget(b, 'c1')).toEqual({
      toListId: 'a',
      beforeId: null,
      afterId: null
    })
  })

  it("for the middle card, returns both neighbours", () => {
    const b = makeBoard([
      {
        id: 'a',
        cards: [
          makeCard({ id: 'c1' }),
          makeCard({ id: 'c2' }),
          makeCard({ id: 'c3' })
        ]
      }
    ])
    expect(computeMoveTarget(b, 'c2')).toEqual({
      toListId: 'a',
      beforeId: 'c1',
      afterId: 'c3'
    })
  })

  it("for the first card, beforeId is null + afterId is the next", () => {
    const b = makeBoard([
      {
        id: 'a',
        cards: [makeCard({ id: 'c1' }), makeCard({ id: 'c2' })]
      }
    ])
    expect(computeMoveTarget(b, 'c1')).toEqual({
      toListId: 'a',
      beforeId: null,
      afterId: 'c2'
    })
  })

  it("for the last card, afterId is null + beforeId is the prev", () => {
    const b = makeBoard([
      {
        id: 'a',
        cards: [makeCard({ id: 'c1' }), makeCard({ id: 'c2' })]
      }
    ])
    expect(computeMoveTarget(b, 'c2')).toEqual({
      toListId: 'a',
      beforeId: 'c1',
      afterId: null
    })
  })
})

describe('isUnchangedMove', () => {
  it('returns false when there is no snapshot to compare against', () => {
    const b = makeBoard([{ id: 'a', cards: [makeCard({ id: 'c1' })] }])
    expect(isUnchangedMove(null, b, 'c1')).toBe(false)
  })

  it("returns true when neighbours + list match the snapshot exactly", () => {
    const before = makeBoard([
      {
        id: 'a',
        cards: [
          makeCard({ id: 'c1' }),
          makeCard({ id: 'c2' }),
          makeCard({ id: 'c3' })
        ]
      }
    ])
    // Same board state.
    const after = makeBoard([
      {
        id: 'a',
        cards: [
          makeCard({ id: 'c1' }),
          makeCard({ id: 'c2' }),
          makeCard({ id: 'c3' })
        ]
      }
    ])
    expect(isUnchangedMove(before, after, 'c2')).toBe(true)
  })

  it('returns false when the card moved to a new list', () => {
    const before = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1' })] },
      { id: 'b', cards: [] }
    ])
    const after = makeBoard([
      { id: 'a', cards: [] },
      { id: 'b', cards: [makeCard({ id: 'c1' })] }
    ])
    expect(isUnchangedMove(before, after, 'c1')).toBe(false)
  })

  it("returns false when the card kept its list but neighbours changed", () => {
    const before = makeBoard([
      {
        id: 'a',
        cards: [
          makeCard({ id: 'c1' }),
          makeCard({ id: 'c2' }),
          makeCard({ id: 'c3' })
        ]
      }
    ])
    const after = makeBoard([
      {
        id: 'a',
        cards: [
          makeCard({ id: 'c2' }),
          makeCard({ id: 'c1' }),
          makeCard({ id: 'c3' })
        ]
      }
    ])
    expect(isUnchangedMove(before, after, 'c1')).toBe(false)
  })

  it("returns false when the active card vanished from the current board", () => {
    const before = makeBoard([{ id: 'a', cards: [makeCard({ id: 'c1' })] }])
    const after = makeBoard([{ id: 'a', cards: [] }])
    expect(isUnchangedMove(before, after, 'c1')).toBe(false)
  })
})

// ─── planSwimlaneDrop ─────────────────────────────────────────────

describe('planSwimlaneDrop', () => {
  it("returns 'noop' when the active card isn't on the board", () => {
    const b = makeBoard([{ id: 'a', cards: [] }])
    expect(
      planSwimlaneDrop(b, 'ghost', 'lane:high:list:a', 'priority', 'before', false)
    ).toEqual({ kind: 'noop' })
  })

  it("returns 'noop' when the destination list is missing", () => {
    const b = makeBoard([{ id: 'a', cards: [makeCard({ id: 'c1' })] }])
    expect(
      planSwimlaneDrop(b, 'c1', 'lane:high:list:nope', 'priority', 'before', false)
    ).toEqual({ kind: 'noop' })
  })

  it("returns 'noop' when overId doesn't resolve to a lane key", () => {
    const b = makeBoard([{ id: 'a', cards: [makeCard({ id: 'c1' })] }])
    expect(
      planSwimlaneDrop(b, 'c1', 'unknown-id', 'priority', 'before', false)
    ).toEqual({ kind: 'noop' })
  })

  it("returns 'blocked' for a cross-list drop into a list at its WIP limit (blockDrag on)", () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1' })] },
      {
        id: 'b',
        wipLimit: 1,
        cards: [makeCard({ id: 'c2', priority: 'high' })]
      }
    ])
    expect(
      planSwimlaneDrop(b, 'c1', 'lane:high:list:b', 'priority', 'before', true)
    ).toEqual({ kind: 'blocked' })
  })

  it("does NOT block when blockDrag is off, even at the WIP limit", () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1' })] },
      {
        id: 'b',
        wipLimit: 1,
        cards: [makeCard({ id: 'c2', priority: 'high' })]
      }
    ])
    const plan = planSwimlaneDrop(
      b,
      'c1',
      'lane:high:list:b',
      'priority',
      'before',
      false
    )
    expect(plan.kind).not.toBe('blocked')
  })

  it("does NOT block within-list reorder even when the list is at its limit", () => {
    const b = makeBoard([
      {
        id: 'b',
        wipLimit: 2,
        cards: [
          makeCard({ id: 'c1', priority: 'high' }),
          makeCard({ id: 'c2', priority: 'high' })
        ]
      }
    ])
    const plan = planSwimlaneDrop(
      b,
      'c1',
      'lane:high:list:b',
      'priority',
      'before',
      true
    )
    expect(plan.kind).not.toBe('blocked')
  })

  it("'move-only' when the lane key is unchanged (same priority)", () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1', priority: 'high' })] },
      {
        id: 'b',
        cards: [
          makeCard({ id: 'c2', priority: 'high' }),
          makeCard({ id: 'c3', priority: 'high' })
        ]
      }
    ])
    // Cross-list drop, lane stays 'high' (priority unchanged).
    const plan = planSwimlaneDrop(b, 'c1', 'c3', 'priority', 'before', false)
    expect(plan).toEqual({
      kind: 'move-only',
      toListId: 'b',
      beforeId: 'c2',
      afterId: 'c3'
    })
  })

  it("'move-and-update' carries the new priority when the lane changed", () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1', priority: 'low' })] },
      { id: 'a-other', cards: [] }
    ])
    const plan = planSwimlaneDrop(
      b,
      'c1',
      'lane:urgent:list:a',
      'priority',
      'before',
      false
    )
    expect(plan).toEqual({
      kind: 'move-and-update',
      toListId: 'a',
      beforeId: null,
      afterId: null,
      newPriority: 'urgent'
    })
  })

  it("'move-and-update' for the 'none' lane maps to priority: null", () => {
    const b = makeBoard([
      { id: 'a', cards: [makeCard({ id: 'c1', priority: 'high' })] }
    ])
    const plan = planSwimlaneDrop(
      b,
      'c1',
      'lane:none:list:a',
      'priority',
      'before',
      false
    )
    expect(plan).toMatchObject({
      kind: 'move-and-update',
      newPriority: null
    })
  })

  it("drop on a lane droppable appends to the cell's bottom (beforeId = last card)", () => {
    const b = makeBoard([
      {
        id: 'a',
        cards: [
          makeCard({ id: 'c1', priority: 'high' }),
          makeCard({ id: 'c2', priority: 'high' }),
          makeCard({ id: 'c-mover', priority: 'low' })
        ]
      }
    ])
    const plan = planSwimlaneDrop(
      b,
      'c-mover',
      'lane:high:list:a',
      'priority',
      'before',
      false
    )
    expect(plan).toMatchObject({
      kind: 'move-and-update',
      beforeId: 'c2',
      afterId: null,
      newPriority: 'high'
    })
  })

  it("position='after' on a card slots below it inside the lane", () => {
    const b = makeBoard([
      {
        id: 'a',
        cards: [
          makeCard({ id: 'c1', priority: 'high' }),
          makeCard({ id: 'c2', priority: 'high' }),
          makeCard({ id: 'c-mover', priority: 'low' })
        ]
      }
    ])
    const plan = planSwimlaneDrop(
      b,
      'c-mover',
      'c1',
      'priority',
      'after',
      false
    )
    expect(plan).toMatchObject({
      kind: 'move-and-update',
      beforeId: 'c1',
      afterId: 'c2'
    })
  })

  it("returns 'noop' when same-list-same-lane-same-neighbours (no actual change)", () => {
    const b = makeBoard([
      {
        id: 'a',
        cards: [
          makeCard({ id: 'c1', priority: 'high' }),
          makeCard({ id: 'c2', priority: 'high' })
        ]
      }
    ])
    // Drop c1 'before' itself in its own lane → unchanged.
    const plan = planSwimlaneDrop(
      b,
      'c1',
      'c2',
      'priority',
      'before',
      false
    )
    expect(plan).toEqual({ kind: 'noop' })
  })
})

describe('findNextNonEmptyListIndex', () => {
  // Pure scan helper used by the Alt+←/→ card-focus shortcuts. Regression
  // pin for the TODO bug where an empty list between two populated ones
  // trapped keyboard focus on the near side (board.tsx focusLeft /
  // focusRight used to bail on the immediate-neighbour check).
  //
  // Loose shape - the helper only needs `cards.length`, so we mint
  // arrays of nulls instead of building full CardView objects.
  const list = (n: number): { cards: ReadonlyArray<unknown> } => ({
    cards: Array.from({ length: n }, () => null)
  })

  it('returns the immediate neighbour when it has cards', () => {
    const lists = [list(2), list(3), list(1)]
    expect(findNextNonEmptyListIndex(lists, 0, 1)).toBe(1)
    expect(findNextNonEmptyListIndex(lists, 2, -1)).toBe(1)
  })

  it('skips a single empty list to reach the populated one beyond', () => {
    // The bug case: [populated, EMPTY, populated]. Used to return null
    // because the L1→L2 check found L2.cards.length === 0 and bailed.
    const lists = [list(2), list(0), list(3)]
    expect(findNextNonEmptyListIndex(lists, 0, 1)).toBe(2)
    expect(findNextNonEmptyListIndex(lists, 2, -1)).toBe(0)
  })

  it('skips consecutive empty lists', () => {
    const lists = [list(1), list(0), list(0), list(0), list(2)]
    expect(findNextNonEmptyListIndex(lists, 0, 1)).toBe(4)
    expect(findNextNonEmptyListIndex(lists, 4, -1)).toBe(0)
  })

  it('returns null when every list in that direction is empty', () => {
    const lists = [list(1), list(0), list(0)]
    expect(findNextNonEmptyListIndex(lists, 0, 1)).toBeNull()
  })

  it('returns null when starting at the edge of the array', () => {
    const lists = [list(1), list(2)]
    // Past the right edge.
    expect(findNextNonEmptyListIndex(lists, 1, 1)).toBeNull()
    // Past the left edge.
    expect(findNextNonEmptyListIndex(lists, 0, -1)).toBeNull()
  })

  it('returns null for a single-list board (nowhere to scan)', () => {
    expect(findNextNonEmptyListIndex([list(3)], 0, 1)).toBeNull()
    expect(findNextNonEmptyListIndex([list(3)], 0, -1)).toBeNull()
  })

  it('returns null for an empty board (no lists at all)', () => {
    expect(findNextNonEmptyListIndex([], 0, 1)).toBeNull()
    expect(findNextNonEmptyListIndex([], 0, -1)).toBeNull()
  })

  it('skips an empty starting list when scanning past it (caller is one further over)', () => {
    // Useful safety check: even if the caller passes a fromIdx pointing
    // at an empty list (shouldn't happen in practice - focus implies a
    // card lives there - but cheap to honour), the scan still kicks off
    // at the NEXT index and behaves consistently.
    const lists = [list(2), list(0), list(0), list(1)]
    expect(findNextNonEmptyListIndex(lists, 1, 1)).toBe(3)
    expect(findNextNonEmptyListIndex(lists, 2, -1)).toBe(0)
  })
})

describe('planListMove', () => {
  it('moving a list earlier puts it between the right neighbours', () => {
    // [a, b, c, d]: move c before b → [a, c, b, d].
    const plan = planListMove(['a', 'b', 'c', 'd'], 'c', 'b')
    expect(plan).toEqual({
      orderedIds: ['a', 'c', 'b', 'd'],
      beforeId: 'a',
      afterId: 'b'
    })
  })

  it('moving a list later puts it between the right neighbours', () => {
    // [a, b, c, d]: move a onto c → [b, c, a, d].
    const plan = planListMove(['a', 'b', 'c', 'd'], 'a', 'c')
    expect(plan).toEqual({
      orderedIds: ['b', 'c', 'a', 'd'],
      beforeId: 'c',
      afterId: 'd'
    })
  })

  it('moving to the front has a null beforeId; to the end a null afterId', () => {
    expect(planListMove(['a', 'b', 'c'], 'c', 'a')).toEqual({
      orderedIds: ['c', 'a', 'b'],
      beforeId: null,
      afterId: 'a'
    })
    expect(planListMove(['a', 'b', 'c'], 'a', 'c')).toEqual({
      orderedIds: ['b', 'c', 'a'],
      beforeId: 'c',
      afterId: null
    })
  })

  it('returns null for a no-op (same id) or an unknown id', () => {
    expect(planListMove(['a', 'b'], 'a', 'a')).toBeNull()
    expect(planListMove(['a', 'b'], 'x', 'a')).toBeNull()
    expect(planListMove(['a', 'b'], 'a', 'x')).toBeNull()
  })
})

describe('reorderVisibleLists', () => {
  const L = (id: string) => ({ id })

  it('reorders the visible lists to follow the given id order', () => {
    const lists = [L('a'), L('b'), L('c')]
    expect(reorderVisibleLists(lists, ['c', 'a', 'b']).map((l) => l.id)).toEqual([
      'c',
      'a',
      'b'
    ])
  })

  it('keeps lists outside the visible set (e.g. closed) after the block, in original order', () => {
    // `closed1` / `closed2` aren't in the visible order; they stay in
    // their relative order, sorted after the reordered visible block.
    const lists = [L('a'), L('closed1'), L('b'), L('closed2'), L('c')]
    expect(
      reorderVisibleLists(lists, ['c', 'b', 'a']).map((l) => l.id)
    ).toEqual(['c', 'b', 'a', 'closed1', 'closed2'])
  })
})
