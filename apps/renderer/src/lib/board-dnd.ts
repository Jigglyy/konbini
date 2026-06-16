import { arrayMove } from '@dnd-kit/sortable'
import type {
  BoardView,
  CardPriority,
  SwimlaneMode
} from '@kanbini/shared'
import {
  laneKeyOfCard,
  parseLaneDroppable
} from '../components/swimlane-board'

// Pure DnD helpers extracted from board.tsx so they're unit-testable
// without standing up a <DndContext> + a React tree. Used by the
// onDragOver / onDragEnd reducers in board.tsx + swimlane-board.tsx
// to resolve which list / lane owns a given droppable id (which may
// be a card id, a flat `list:<id>` droppable, or a swimlane
// `lane:<key>:list:<id>` droppable). The reducer logic itself stays
// in board.tsx - it needs the query cache + dnd-kit state. These
// helpers are the building blocks the reducer composes.

/** List id that owns a card id, or the list id encoded in a `list:`
 *  (flat mode) or `lane:<key>:list:<id>` (swimlane mode) droppable.
 *  Returns null when the id doesn't resolve (orphaned card, malformed
 *  droppable, etc.) so the reducer can short-circuit instead of
 *  crashing on a missing list. */
export function listOf(b: BoardView, id: string): string | null {
  if (id.startsWith('lane:')) {
    return parseLaneDroppable(id)?.listId ?? null
  }
  if (id.startsWith('list:')) return id.slice(5)
  return b.lists.find((l) => l.cards.some((c) => c.id === id))?.id ?? null
}

/** Swimlane key that owns a target id. For an explicit lane droppable
 *  (`lane:<key>:list:<id>`) it's the encoded key; for a card id it's
 *  whichever lane that card currently belongs to under the active
 *  mode. Returns null in flat (non-swimlane) mode. ADR-0037 slice 2. */
export function laneOf(
  b: BoardView,
  id: string,
  mode: SwimlaneMode | null
): string | null {
  if (!mode) return null
  if (id.startsWith('lane:')) {
    return parseLaneDroppable(id)?.laneKey ?? null
  }
  for (const l of b.lists) {
    const c = l.cards.find((cc) => cc.id === id)
    if (c) return laneKeyOfCard(c, mode)
  }
  return null
}

// ─── focus navigation ─────────────────────────────────────────────
// Pure helper for the Alt+←/→ card-focus shortcuts. Not DnD per se,
// but lives here because the file's role is "pure board-shape helpers
// extracted from board.tsx for unit testing" and the navigation logic
// fits that exact description.

/** Find the next list in `lists` (going `direction` from `fromIdx`)
 *  that has at least one card. Returns the absolute index, or `null`
 *  if every list in that direction is empty (or there's nothing in
 *  that direction at all).
 *
 *  Used by the Alt+←/→ card-focus shortcuts so the keyboard can skip
 *  past an empty column to reach a populated one on the far side.
 *  Without this scan, a layout like `[L1 cards] [L2 empty] [L3 cards]`
 *  trapped focus in L1 - the immediate-neighbour check bailed on L2
 *  and you couldn't reach L3 with the keyboard at all unless you
 *  first clicked a card there.
 *
 *  The card-MOVE variants (`card.moveLeft` / `card.moveRight`) do
 *  NOT use this - moving INTO an empty list is the correct behaviour
 *  for them (it's how you populate a freshly-created column). */
export function findNextNonEmptyListIndex(
  lists: ReadonlyArray<{ cards: ReadonlyArray<unknown> }>,
  fromIdx: number,
  direction: -1 | 1
): number | null {
  for (
    let i = fromIdx + direction;
    i >= 0 && i < lists.length;
    i += direction
  ) {
    if (lists[i]!.cards.length > 0) return i
  }
  return null
}

// ─── reducer projections (onDragOver / onDragEnd) ─────────────────
// Pure functions the closures in board.tsx compose with so the live-
// cache reorder math is testable without standing up a <DndContext>.
// Each takes a BoardView (the cache snapshot) + the drag state +
// returns either a derived value (boolean, target descriptor) or a
// new BoardView. None touch the query cache or dnd-kit's runtime -
// the closures glue these to those layers.

const mapLists = (
  b: BoardView,
  fn: (l: BoardView['lists'][number]) => BoardView['lists'][number]
): BoardView => ({ ...b, lists: b.lists.map(fn) })

/** A cross-list drag would land in a list that's at its WIP cap.
 *  Returns the blocking list id, or null when the drag is safe.
 *  The caller (board.tsx) only consults this when `blockDrag` is
 *  on; we don't gate it here so the reducer stays one-purpose. */
export function findWipBlock(
  b: BoardView,
  activeId: string,
  overId: string
): string | null {
  const fromId = listOf(b, activeId)
  const toId = listOf(b, overId)
  if (!fromId || !toId || fromId === toId) return null
  const to = b.lists.find((l) => l.id === toId)
  if (!to || to.wipLimit == null) return null
  return to.cards.length >= to.wipLimit ? toId : null
}

/** Within-list drag on a sort-overridden list (ADR-0032) should be
 *  skipped: created_at decides the position, so the visual reorder
 *  would snap back on the next read. Cross-list drops INTO a sorted
 *  list are still allowed - the server's ORDER BY resolves them on
 *  refetch. */
export function isSortedListReorder(
  b: BoardView,
  activeId: string,
  overId: string
): boolean {
  const fromId = listOf(b, activeId)
  const toId = listOf(b, overId)
  if (!fromId || !toId || fromId !== toId) return false
  const to = b.lists.find((l) => l.id === toId)
  return !!to?.sortMode
}

/** Cache reorder for a card move. Returns the new board, or `prev`
 *  unchanged when the move is a no-op / unresolvable. `position` is the
 *  caller's resolved insert hint when `overId` is a card id: 'before'
 *  to drop above the over-card, 'after' to drop below. For `list:<id>`
 *  droppables (column-end), pass anything - the function appends to the
 *  end regardless.
 *
 *  Two callers: onDragOver fires it live for CROSS-list moves (the card
 *  must enter the destination's SortableContext to render there);
 *  onDragEnd fires it ONCE for SAME-list moves (those aren't
 *  live-reordered during the drag - dnd-kit's sorting strategy glides
 *  the siblings via transforms instead, which avoids the per-frame
 *  re-render storm + the FLIP crash; see board.tsx onDragOver). */
export function reduceCardMove(
  prev: BoardView,
  activeId: string,
  overId: string,
  position: 'before' | 'after'
): BoardView {
  const fromId = listOf(prev, activeId)
  const toId = listOf(prev, overId)
  if (!fromId || !toId) return prev
  const from = prev.lists.find((l) => l.id === fromId)
  const to = prev.lists.find((l) => l.id === toId)
  const card = from?.cards.find((c) => c.id === activeId)
  if (!from || !to || !card) return prev

  // Same-list reorder onto a sibling card (not a column droppable).
  if (fromId === toId && !overId.startsWith('list:')) {
    const oldIndex = to.cards.findIndex((c) => c.id === activeId)
    const newIndex = to.cards.findIndex((c) => c.id === overId)
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
      return prev
    }
    const cards = arrayMove(to.cards, oldIndex, newIndex)
    return mapLists(prev, (l) => (l.id === toId ? { ...l, cards } : l))
  }

  let insertAt: number
  if (overId.startsWith('list:')) {
    insertAt = to.cards.length
  } else {
    const overIdx = to.cards.findIndex((c) => c.id === overId)
    insertAt = Math.max(0, overIdx) + (position === 'after' ? 1 : 0)
  }
  return mapLists(prev, (l) => {
    // Same-list drop on the column droppable (fromId === toId,
    // overId === 'list:<id>'): the two branches below were mutually
    // exclusive in the original code - the filter ran but the
    // insert never did. Handle it explicitly: remove + re-insert
    // within the SAME list.
    if (l.id === fromId && l.id === toId) {
      const filtered = l.cards.filter((c) => c.id !== activeId)
      filtered.splice(insertAt, 0, card)
      return { ...l, cards: filtered }
    }
    if (l.id === fromId) {
      return { ...l, cards: l.cards.filter((c) => c.id !== activeId) }
    }
    if (l.id === toId) {
      const cards = [...l.cards]
      cards.splice(insertAt, 0, card)
      return { ...l, cards }
    }
    return l
  })
}

/** Pull the (listId, beforeId, afterId) triple needed by the
 *  `card.move` mutation from the post-drag cache. Returns null when
 *  the activeId no longer resolves (orphaned mid-drag, etc.). */
export function computeMoveTarget(
  b: BoardView,
  activeId: string
): { toListId: string; beforeId: string | null; afterId: string | null } | null {
  const toListId = listOf(b, activeId)
  if (!toListId) return null
  const list = b.lists.find((l) => l.id === toListId)
  if (!list) return null
  const idx = list.cards.findIndex((c) => c.id === activeId)
  if (idx < 0) return null
  return {
    toListId,
    beforeId: list.cards[idx - 1]?.id ?? null,
    afterId: list.cards[idx + 1]?.id ?? null
  }
}

/** True when a finished drag put the card back exactly where it
 *  started - same list AND same neighbours. The caller skips the
 *  `card.move` mutation in that case (still restores the snapshot
 *  in case onDragOver perturbed the cache transiently). */
export function isUnchangedMove(
  snap: BoardView | null,
  current: BoardView,
  activeId: string
): boolean {
  if (!snap) return false
  const target = computeMoveTarget(current, activeId)
  if (!target) return false
  const wasId = listOf(snap, activeId)
  const wasList = snap.lists.find((l) => l.id === wasId)
  const wIdx = wasList?.cards.findIndex((c) => c.id === activeId) ?? -1
  return (
    wasId === target.toListId &&
    (wasList?.cards[wIdx - 1]?.id ?? null) === target.beforeId &&
    (wasList?.cards[wIdx + 1]?.id ?? null) === target.afterId
  )
}

// ─── list reorder ─────────────────────────────────────────────────
// Dragging a whole list column (horizontal reorder). Pure helpers so
// the index math + the optimistic board projection are unit-testable
// without a <DndContext>. The board.tsx closure resolves the dnd-kit
// `over` id to a list id, calls planListMove, then fires `list.move`
// with the computed neighbours and applies reorderVisibleLists as the
// optimistic cache write.

/** Compute the post-drop order + the fractional-index neighbours for a
 *  list move. `visibleIds` is the on-screen left-to-right list order
 *  (closed lists already filtered out by the caller); `activeId` is the
 *  dragged list, `overId` the list it was dropped on. Returns null when
 *  either id isn't in the list or the move is a no-op (dropped on
 *  itself / same slot). */
export function planListMove(
  visibleIds: string[],
  activeId: string,
  overId: string
): { orderedIds: string[]; beforeId: string | null; afterId: string | null } | null {
  const from = visibleIds.indexOf(activeId)
  const to = visibleIds.indexOf(overId)
  if (from < 0 || to < 0 || from === to) return null
  const orderedIds = arrayMove(visibleIds, from, to)
  const pos = orderedIds.indexOf(activeId)
  return {
    orderedIds,
    beforeId: orderedIds[pos - 1] ?? null,
    afterId: orderedIds[pos + 1] ?? null
  }
}

/** Optimistic cache projection: reorder `b.lists` so the visible lists
 *  follow `orderedVisibleIds`. Any list not in that set (closed lists,
 *  or one created mid-drag) keeps its relative order and sorts after the
 *  visible block - they're filtered out of the view anyway, and the next
 *  refetch restores the canonical position order. */
export function reorderVisibleLists<T extends { id: string }>(
  lists: T[],
  orderedVisibleIds: string[]
): T[] {
  const rank = new Map(orderedVisibleIds.map((id, i) => [id, i]))
  // Stable sort: visible lists by their new rank; everything else keeps
  // its original relative order, placed after the visible block.
  return lists
    .map((l, i) => ({ l, i }))
    .sort((a, b) => {
      const ra = rank.get(a.l.id)
      const rb = rank.get(b.l.id)
      if (ra != null && rb != null) return ra - rb
      if (ra != null) return -1
      if (rb != null) return 1
      return a.i - b.i
    })
    .map((x) => x.l)
}

// ─── swimlane drag-end planner ────────────────────────────────────
// Swimlane mode is snap-on-drop (no live cache reorder in
// onDragOver), so the drag-end handler has to decide on the spot:
// what list + position to move to, whether the lane changed enough
// to also fire a card.update for the new priority, and whether the
// destination's WIP limit refuses the drop. Returning a discriminated
// union keeps the closure in board.tsx a thin dispatcher.

/** What the swimlane drag-end should do, derived purely from the
 *  cache + drag state. The closure in board.tsx fires the matching
 *  IPC calls; nothing in here touches the cache. */
export type SwimlaneDropPlan =
  /** Drag wasn't actionable (no source card, missing list, missing
   *  lane key, cross-cell dropping onto itself, …) - skip every IPC. */
  | { kind: 'noop' }
  /** Cross-list drop into a list at its WIP limit - caller should
   *  fire an invalidate to clean up any transient state but skip
   *  the mutations. */
  | { kind: 'blocked' }
  /** Card stayed in its lane but moved within or between lists -
   *  caller fires a single card.move. */
  | {
      kind: 'move-only'
      toListId: string
      beforeId: string | null
      afterId: string | null
    }
  /** Card crossed into a new lane (priority changed) - caller fires
   *  card.move then card.update with the new priority. */
  | {
      kind: 'move-and-update'
      toListId: string
      beforeId: string | null
      afterId: string | null
      newPriority: CardPriority | null
    }

export function planSwimlaneDrop(
  b: BoardView,
  activeId: string,
  overId: string,
  mode: SwimlaneMode,
  /** Resolved by the caller from the dnd-kit rect comparison; used
   *  only when `overId` is a card id (not a `lane:` droppable). */
  position: 'before' | 'after',
  blockDrag: boolean
): SwimlaneDropPlan {
  let srcCard: BoardView['lists'][number]['cards'][number] | undefined
  for (const l of b.lists) {
    srcCard = l.cards.find((c) => c.id === activeId)
    if (srcCard) break
  }
  if (!srcCard) return { kind: 'noop' }

  const toListId = listOf(b, overId)
  if (!toListId) return { kind: 'noop' }
  const toLaneKey = laneOf(b, overId, mode)
  if (toLaneKey == null) return { kind: 'noop' }
  const targetList = b.lists.find((l) => l.id === toListId)
  if (!targetList) return { kind: 'noop' }
  const fromListId = listOf(b, activeId)

  if (
    blockDrag &&
    fromListId !== toListId &&
    targetList.wipLimit != null &&
    targetList.cards.length >= targetList.wipLimit
  ) {
    return { kind: 'blocked' }
  }

  const cellCards = targetList.cards.filter(
    (c) => (c.priority ?? 'none') === toLaneKey
  )
  let beforeId: string | null = null
  let afterId: string | null = null
  if (overId.startsWith('lane:')) {
    beforeId = cellCards[cellCards.length - 1]?.id ?? null
    afterId = null
  } else {
    const overIdx = cellCards.findIndex((c) => c.id === overId)
    if (overIdx >= 0) {
      const insertAt = overIdx + (position === 'after' ? 1 : 0)
      beforeId = cellCards[insertAt - 1]?.id ?? null
      afterId = cellCards[insertAt]?.id ?? null
      // Dropping a card next to itself in its own slot is a no-op.
      if (beforeId === activeId || afterId === activeId) {
        return { kind: 'noop' }
      }
    }
  }

  const oldLaneKey = srcCard.priority ?? 'none'
  const listChanged = fromListId !== toListId
  const laneChanged = oldLaneKey !== toLaneKey

  if (!listChanged && !laneChanged) {
    const curIdx = cellCards.findIndex((c) => c.id === activeId)
    const curBefore = cellCards[curIdx - 1]?.id ?? null
    const curAfter = cellCards[curIdx + 1]?.id ?? null
    if (curBefore === beforeId && curAfter === afterId) {
      return { kind: 'noop' }
    }
  }

  if (laneChanged) {
    const newPriority: CardPriority | null =
      toLaneKey === 'none' ? null : (toLaneKey as CardPriority)
    return {
      kind: 'move-and-update',
      toListId,
      beforeId,
      afterId,
      newPriority
    }
  }
  return { kind: 'move-only', toListId, beforeId, afterId }
}
