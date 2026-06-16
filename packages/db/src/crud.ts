import { and, desc, eq, inArray } from 'drizzle-orm'
import {
  type Mutation,
  type MutationResult,
  newId,
  orderKeyBetween,
  orderKeysBetween
} from '@kanbini/shared'
import type { Db } from './client'
// ADR-0036 restore - applyMutation's `restore` arm delegates to the
// snapshot replayer in undo.ts. Circular-ish module shape (undo →
// crud → undo) but only for types + the applyRestore function; runtime
// import is fine since undo.ts only depends on applyMutation INSIDE
// applyMutationRecorded.
import { applyRestore, type RestorePayload } from './undo'
import { cardOrdering, parseListSortMode } from './data'
import {
  activity,
  attachment,
  board,
  card,
  cardLabel,
  checklist,
  checklistItem,
  comment,
  label,
  list,
  project
} from './schema'

// Data-access for the mutation union. Returns the affected board id so
// main can scope the change event / renderer refetch. Ordering stays
// server-authoritative: positions are minted here via fractional keys.

const now = (): number => Date.now()

/** Append one row to the activity log. No-op without a boardId, so the
 *  feed never holds dangling cross-board events. Safe to call inside a
 *  transaction (uses the passed `db`, which can be a tx). */
function logActivity(
  db: Db,
  params: {
    boardId: string | null
    cardId: string | null
    type: string
    data?: Record<string, unknown> | null
  }
): void {
  if (!params.boardId) return
  db.insert(activity)
    .values({
      id: newId(),
      boardId: params.boardId,
      cardId: params.cardId,
      type: params.type,
      data: params.data ?? null
    })
    .run()
}

/** Append position: a key after the last sibling (by position). */
/** Resolve the projectId for a hidden-projects `board.create` (M4-G):
 *  reuse the lone existing project; if none exist, create a "Default"
 *  one. Idempotent. The renderer never invents projectIds. */
export function ensureDefaultProjectId(db: Db): string {
  const existing = db.select({ id: project.id }).from(project).limit(1).get()
  if (existing) return existing.id
  const id = newId()
  db.insert(project).values({ id, name: 'Default' }).run()
  return id
}

function appendListKey(db: Db, boardId: string): string {
  const last = db
    .select({ p: list.position })
    .from(list)
    .where(eq(list.boardId, boardId))
    .orderBy(desc(list.position))
    .limit(1)
    .get()
  return orderKeyBetween(last?.p ?? null, null)
}

function appendCardKey(db: Db, listId: string): string {
  const last = db
    .select({ p: card.position })
    .from(card)
    .where(eq(card.listId, listId))
    .orderBy(desc(card.position))
    .limit(1)
    .get()
  return orderKeyBetween(last?.p ?? null, null)
}

function listBoardId(db: Db, listId: string): string | null {
  return (
    db
      .select({ b: list.boardId })
      .from(list)
      .where(eq(list.id, listId))
      .get()?.b ?? null
  )
}

function cardBoardId(db: Db, cardId: string): string | null {
  const c = db
    .select({ listId: card.listId })
    .from(card)
    .where(eq(card.id, cardId))
    .get()
  return c ? listBoardId(db, c.listId) : null
}

/** Apply a validated mutation; returns the affected entity + board. */
export function applyMutation(db: Db, m: Mutation): MutationResult {
  switch (m.type) {
    case 'project.create': {
      const id = newId()
      db.insert(project)
        .values({ id, name: m.name, description: m.description, color: m.color })
        .run()
      return { id, boardId: null }
    }
    case 'project.update': {
      db.update(project)
        .set({ ...m.patch, updatedAt: now() })
        .where(eq(project.id, m.id))
        .run()
      return { id: m.id, boardId: null }
    }
    case 'project.delete': {
      db.delete(project).where(eq(project.id, m.id)).run()
      return { id: m.id, boardId: null }
    }

    case 'board.create': {
      // ADR-0036 - `m.id` may be supplied by the undo recorder when
      // redoing a previously-applied forward, so the recreated board
      // keeps the original id and downstream undo entries that
      // reference it still resolve.
      const id = m.id ?? newId()
      const projectId = m.projectId ?? ensureDefaultProjectId(db)
      const position = orderKeyBetween(
        db
          .select({ p: board.position })
          .from(board)
          .where(eq(board.projectId, projectId))
          .orderBy(desc(board.position))
          .limit(1)
          .get()?.p ?? null,
        null
      )
      db.insert(board)
        .values({
          id,
          projectId,
          name: m.name,
          description: m.description,
          position
        })
        .run()
      return { id, boardId: id }
    }
    case 'board.update': {
      db.update(board)
        .set({ ...m.patch, updatedAt: now() })
        .where(eq(board.id, m.id))
        .run()
      return { id: m.id, boardId: m.id }
    }
    case 'board.delete': {
      db.delete(board).where(eq(board.id, m.id)).run()
      return { id: m.id, boardId: m.id }
    }
    case 'board.move': {
      // Mirror card.move: read the two neighbour positions in a tx,
      // mint a fractional key between them, write. The renderer
      // guarantees beforeId/afterId are siblings of `id`'s project,
      // so we don't re-validate the project edge here.
      return db.transaction((tx) => {
        const projectIdRow = tx
          .select({ p: board.projectId })
          .from(board)
          .where(eq(board.id, m.id))
          .get()
        if (!projectIdRow) return { id: m.id, boardId: m.id }
        const keyOf = (id: string | null | undefined): string | null =>
          id
            ? (tx
                .select({ p: board.position })
                .from(board)
                .where(
                  and(eq(board.id, id), eq(board.projectId, projectIdRow.p))
                )
                .get()?.p ?? null)
            : null
        const position = orderKeyBetween(keyOf(m.beforeId), keyOf(m.afterId))
        tx.update(board)
          .set({ position, updatedAt: now() })
          .where(eq(board.id, m.id))
          .run()
        return { id: m.id, boardId: m.id }
      })
    }
    case 'board.duplicate': {
      return db.transaction((tx) => {
        const src = tx.select().from(board).where(eq(board.id, m.id)).get()
        if (!src) return { id: m.id, boardId: null }
        // Honour a caller-supplied id so a redo recreates the SAME
        // duplicate board (ADR-0036 - the undo recorder backfills it).
        const newId_ = m.newId ?? newId()
        // Append to the end of the project's boards. We could slot
        // the duplicate right after the original, but the home
        // picker lets the user reorder freely and end-append keeps
        // this path identical to board.create.
        const after =
          tx
            .select({ p: board.position })
            .from(board)
            .where(eq(board.projectId, src.projectId))
            .orderBy(desc(board.position))
            .limit(1)
            .get()?.p ?? null
        // Carry color / gradient backgrounds across; drop image
        // backgrounds since the underlying file lives under the
        // source board's folder and we don't want a duplicate
        // pointing at a path that vanishes when the source goes.
        // (Renderer parses background defensively, so a bad pointer
        // would silently no-op anyway - this just keeps the duplicate
        // tidy.)
        const srcBg = src.background as
          | { kind: 'color' | 'gradient' | 'image' }
          | null
        const carriedBg = srcBg && srcBg.kind !== 'image' ? src.background : null
        tx.insert(board)
          .values({
            id: newId_,
            projectId: src.projectId,
            name: `${src.name} (copy)`,
            description: src.description,
            color: src.color,
            background: carriedBg,
            // Carry the swimlane grouping like the other view-ish
            // settings (color / gradient) - a duplicate of a
            // priority-grouped board should open priority-grouped.
            swimlaneMode: src.swimlaneMode,
            position: orderKeyBetween(after, null),
            archived: false,
            pinned: false
          })
          .run()

        // Clone lists (with same names/colors/positions) under the
        // new board. List ids change; nothing else points at them
        // yet because we're not cloning cards.
        const srcLists = tx
          .select()
          .from(list)
          .where(eq(list.boardId, src.id))
          .all()
        for (const l of srcLists) {
          tx.insert(list)
            .values({
              id: newId(),
              boardId: newId_,
              name: l.name,
              color: l.color,
              position: l.position,
              closed: l.closed
            })
            .run()
        }

        // Clone labels (board-scoped). New ids - cards on the source
        // board still reference the originals.
        const srcLabels = tx
          .select()
          .from(label)
          .where(eq(label.boardId, src.id))
          .all()
        for (const lb of srcLabels) {
          tx.insert(label)
            .values({
              id: newId(),
              boardId: newId_,
              name: lb.name,
              color: lb.color
            })
            .run()
        }

        return { id: newId_, boardId: newId_ }
      })
    }

    case 'list.create': {
      const id = m.id ?? newId()
      db.insert(list)
        .values({
          id,
          boardId: m.boardId,
          name: m.name,
          color: m.color,
          position: appendListKey(db, m.boardId)
        })
        .run()
      return { id, boardId: m.boardId }
    }
    case 'list.update': {
      const boardId = listBoardId(db, m.id)
      // ADR-0032 sortMode snapshot: when a sorted list goes back to
      // manual, the cards on screen are in the previous mode's computed
      // order - write those positions as fresh fractional keys so the
      // manual order matches what the user just saw. Uses the same
      // cardOrdering as the read side, so freezing works for every mode
      // (priority, due, title, ...), not just created. Atomic with the
      // column update so a crash mid-flip can't desync them.
      if ('sortMode' in m.patch && m.patch.sortMode === null) {
        const prev = db
          .select({ sortMode: list.sortMode })
          .from(list)
          .where(eq(list.id, m.id))
          .get()
        if (prev && prev.sortMode != null) {
          db.transaction((tx) => {
            const ordered = tx
              .select({ id: card.id })
              .from(card)
              .where(eq(card.listId, m.id))
              .orderBy(...cardOrdering(parseListSortMode(prev.sortMode)))
              .all()
            const keys = orderKeysBetween(null, null, ordered.length)
            ordered.forEach((c, i) => {
              tx.update(card)
                .set({ position: keys[i]!, updatedAt: now() })
                .where(eq(card.id, c.id))
                .run()
            })
            tx.update(list)
              .set({ ...m.patch, updatedAt: now() })
              .where(eq(list.id, m.id))
              .run()
          })
          return { id: m.id, boardId }
        }
      }
      db.update(list)
        .set({ ...m.patch, updatedAt: now() })
        .where(eq(list.id, m.id))
        .run()
      return { id: m.id, boardId }
    }
    case 'list.delete': {
      const boardId = listBoardId(db, m.id)
      db.delete(list).where(eq(list.id, m.id)).run()
      return { id: m.id, boardId }
    }
    case 'list.move': {
      // Mirror board.move: read the two neighbour positions in a tx,
      // mint a fractional key between them, write. The renderer
      // reorders the visible lists, so beforeId/afterId are guaranteed
      // siblings on this list's board - we scope the neighbour lookup
      // to that board so a stray id from another board can't shift the
      // computed key.
      return db.transaction((tx) => {
        const boardIdRow = tx
          .select({ b: list.boardId })
          .from(list)
          .where(eq(list.id, m.id))
          .get()
        if (!boardIdRow) return { id: m.id, boardId: null }
        const keyOf = (id: string | null | undefined): string | null =>
          id
            ? (tx
                .select({ p: list.position })
                .from(list)
                .where(and(eq(list.id, id), eq(list.boardId, boardIdRow.b)))
                .get()?.p ?? null)
            : null
        const position = orderKeyBetween(keyOf(m.beforeId), keyOf(m.afterId))
        tx.update(list)
          .set({ position, updatedAt: now() })
          .where(eq(list.id, m.id))
          .run()
        return { id: m.id, boardId: boardIdRow.b }
      })
    }

    case 'card.create': {
      const id = m.id ?? newId()
      const boardId = listBoardId(db, m.listId)
      db.insert(card)
        .values({
          id,
          listId: m.listId,
          title: m.title,
          position: appendCardKey(db, m.listId),
          // ADR-0037 slice 2: optional starting priority so the
          // renderer can create a card directly into a swimlane.
          // Drizzle skips undefined → the column's default (null)
          // applies for the common unprioritised case.
          priority: m.priority ?? undefined
        })
        .run()
      logActivity(db, {
        boardId,
        cardId: id,
        type: 'created',
        data: { title: m.title }
      })
      return { id, boardId }
    }
    case 'card.update': {
      const boardId = cardBoardId(db, m.id)
      // Guard the cover pointer: a non-null coverAttachmentId must
      // reference an attachment that belongs to THIS card. Otherwise an
      // MCP / control-channel caller (or a malformed renderer call)
      // could point a card's cover at another card's attachment - or a
      // non-existent id - surfacing a foreign image as the cover.
      // Clearing the cover (null) is always allowed. Restore bypasses
      // this (it writes coverAttachmentId directly, trusted).
      if (m.patch.coverAttachmentId != null) {
        const att = db
          .select({ cardId: attachment.cardId })
          .from(attachment)
          .where(eq(attachment.id, m.patch.coverAttachmentId))
          .get()
        if (!att || att.cardId !== m.id) {
          throw new Error(
            `coverAttachmentId ${m.patch.coverAttachmentId} does not belong to card ${m.id}`
          )
        }
      }
      db.update(card)
        .set({ ...m.patch, updatedAt: now() })
        .where(eq(card.id, m.id))
        .run()
      // One activity row per field changed - keeps the feed terse and
      // makes each event independently filterable by `type`.
      if (m.patch.title !== undefined) {
        logActivity(db, {
          boardId,
          cardId: m.id,
          type: 'renamed',
          data: { to: m.patch.title }
        })
      }
      if (m.patch.completed !== undefined) {
        logActivity(db, {
          boardId,
          cardId: m.id,
          type: m.patch.completed ? 'completed' : 'reopened'
        })
      }
      if (m.patch.dueAt !== undefined) {
        logActivity(db, {
          boardId,
          cardId: m.id,
          type: m.patch.dueAt === null ? 'due-cleared' : 'due-set',
          data: m.patch.dueAt === null ? null : { dueAt: m.patch.dueAt }
        })
      }
      if (m.patch.description !== undefined) {
        logActivity(db, { boardId, cardId: m.id, type: 'description' })
      }
      if (m.patch.coverAttachmentId !== undefined) {
        logActivity(db, {
          boardId,
          cardId: m.id,
          type: m.patch.coverAttachmentId === null
            ? 'cover-cleared'
            : 'cover-set'
        })
      }
      if (m.patch.priority !== undefined) {
        logActivity(db, {
          boardId,
          cardId: m.id,
          type: m.patch.priority === null ? 'priority-cleared' : 'priority-set',
          data: m.patch.priority === null ? null : { priority: m.patch.priority }
        })
      }
      return { id: m.id, boardId }
    }
    case 'card.delete': {
      const boardId = cardBoardId(db, m.id)
      db.delete(card).where(eq(card.id, m.id)).run()
      // Don't log: the cardId FK cascades to `set null`, so a
      // 'deleted' row would dangle on the board scope only - and the
      // card-detail UI for this card is gone anyway.
      return { id: m.id, boardId }
    }
    case 'card.move': {
      return db.transaction((tx) => {
        // Capture the source list + current completion BEFORE the
        // move so the on-enter rule (ADR-0041) can decide whether
        // this is a cross-list arrival and whether the rule would
        // actually flip anything.
        const before = tx
          .select({ listId: card.listId, completed: card.completed })
          .from(card)
          .where(eq(card.id, m.id))
          .get()
        // No such card (stale MCP id, raced delete): bail before the
        // activity insert - the UPDATE below would no-op anyway, but
        // logActivity used to fire regardless, writing a phantom
        // 'moved' row into the target board's feed.
        if (!before) return { id: m.id, boardId: null }
        const sourceListId = before.listId
        const wasCompleted = before.completed
        // A genuine cross-list arrival (an in-list reorder doesn't count
        // as "entering" the list). Drives both the listAddedAt stamp and
        // the ADR-0041 on-enter rule below.
        const crossedList = sourceListId !== m.toListId

        // Target-list metadata, read up front: a sorted list (ADR-0032)
        // ignores manual order - the read view re-sorts by sort_mode, and
        // its stored fractional keys are in a DIFFERENT order than what's
        // shown. So the dropped before/after (taken from the visible
        // order) can be two keys in reverse fractional order, which makes
        // orderKeyBetween throw - exactly the "drop into the middle of a
        // sorted list does nothing" bug (the renderer's card.move rejects
        // and snaps the card back). For a sorted target we append a valid
        // key and let the ORDER BY resolve the real slot on the next read;
        // only a manual list honours the requested neighbours.
        const toListRow = tx
          .select({
            name: list.name,
            onEnter: list.onEnter,
            sortMode: list.sortMode
          })
          .from(list)
          .where(eq(list.id, m.toListId))
          .get()
        const keyOf = (cardId: string | null | undefined): string | null =>
          cardId
            ? (tx
                .select({ p: card.position })
                .from(card)
                .where(and(eq(card.id, cardId), eq(card.listId, m.toListId)))
                .get()?.p ?? null)
            : null
        const position = toListRow?.sortMode
          ? appendCardKey(tx as unknown as Db, m.toListId)
          : orderKeyBetween(keyOf(m.beforeId), keyOf(m.afterId))
        tx.update(card)
          .set({
            listId: m.toListId,
            position,
            // Stamp "added to this list" only on a real cross-list move.
            // undo passes the prior value (m.listAddedAt) to restore it;
            // a normal move omits it and stamps now().
            ...(crossedList
              ? { listAddedAt: m.listAddedAt ?? now() }
              : {}),
            updatedAt: now()
          })
          .where(eq(card.id, m.id))
          .run()
        const boardId = listBoardId(tx as unknown as Db, m.toListId)
        logActivity(tx as unknown as Db, {
          boardId,
          cardId: m.id,
          type: 'moved',
          data: {
            toListId: m.toListId,
            toListName: toListRow?.name ?? null
          }
        })

        // ADR-0041 on-enter rule. Fires only on a genuine cross-list
        // arrival (in-list reorder doesn't count as "entering"), and
        // only when the rule would change something - re-running
        // complete-on-enter against an already-completed card is a
        // no-op + skips the activity row. Same tx as the move, so
        // either both happen or neither does. The `onEnter` column
        // is JSON-mode (drizzle already parsed) - soft-narrow the
        // shape here so unknown kinds (older builds, future shapes)
        // silently skip the rule rather than throw.
        if (crossedList && toListRow?.onEnter) {
          const raw = toListRow.onEnter as { kind?: unknown }
          const kind =
            raw.kind === 'complete' || raw.kind === 'uncomplete'
              ? raw.kind
              : null
          if (kind) {
            const shouldComplete = kind === 'complete'
            if (wasCompleted !== shouldComplete) {
              tx.update(card)
                .set({ completed: shouldComplete, updatedAt: now() })
                .where(eq(card.id, m.id))
                .run()
              logActivity(tx as unknown as Db, {
                boardId,
                cardId: m.id,
                type: shouldComplete
                  ? 'rule-completed'
                  : 'rule-uncompleted',
                data: {
                  toListId: m.toListId,
                  toListName: toListRow.name ?? null
                }
              })
            }
          }
        }
        return { id: m.id, boardId }
      })
    }
    case 'card.setLabels': {
      const boardId = cardBoardId(db, m.id)
      return db.transaction((tx) => {
        const oldIds = tx
          .select({ id: cardLabel.labelId })
          .from(cardLabel)
          .where(eq(cardLabel.cardId, m.id))
          .all()
          .map((r) => r.id)
        const newIds = m.labelIds
        const addedIds = newIds.filter((id) => !oldIds.includes(id))
        const removedIds = oldIds.filter((id) => !newIds.includes(id))

        tx.delete(cardLabel).where(eq(cardLabel.cardId, m.id)).run()
        if (newIds.length > 0) {
          tx.insert(cardLabel)
            .values(newIds.map((labelId) => ({ cardId: m.id, labelId })))
            .run()
        }

        if (addedIds.length > 0 || removedIds.length > 0) {
          // Resolve names so the renderer can show them without an
          // extra lookup. A removed label may still exist (we don't
          // delete labels here, just associations).
          const touched = [...addedIds, ...removedIds]
          const rows =
            touched.length > 0
              ? tx
                  .select({ id: label.id, name: label.name })
                  .from(label)
                  .where(inArray(label.id, touched))
                  .all()
              : []
          const nameById = new Map(rows.map((r) => [r.id, r.name]))
          logActivity(tx as unknown as Db, {
            boardId,
            cardId: m.id,
            type: 'labels',
            data: {
              added: addedIds.map((id) => ({ id, name: nameById.get(id) ?? id })),
              removed: removedIds.map((id) => ({
                id,
                name: nameById.get(id) ?? id
              }))
            }
          })
        }
        return { id: m.id, boardId }
      })
    }

    case 'label.create': {
      const id = m.id ?? newId()
      db.insert(label)
        .values({ id, boardId: m.boardId, name: m.name, color: m.color })
        .run()
      return { id, boardId: m.boardId }
    }
    case 'label.update': {
      const boardId =
        db
          .select({ b: label.boardId })
          .from(label)
          .where(eq(label.id, m.id))
          .get()?.b ?? null
      db.update(label)
        .set({ ...m.patch, updatedAt: now() })
        .where(eq(label.id, m.id))
        .run()
      return { id: m.id, boardId }
    }
    case 'label.delete': {
      const boardId =
        db
          .select({ b: label.boardId })
          .from(label)
          .where(eq(label.id, m.id))
          .get()?.b ?? null
      db.delete(label).where(eq(label.id, m.id)).run()
      return { id: m.id, boardId }
    }

    // checklist (card-scoped) - boardId resolved via card → list → board.
    case 'checklist.create': {
      const id = m.id ?? newId()
      const boardId = cardBoardId(db, m.cardId)
      const lastKey =
        db
          .select({ p: checklist.position })
          .from(checklist)
          .where(eq(checklist.cardId, m.cardId))
          .orderBy(desc(checklist.position))
          .limit(1)
          .get()?.p ?? null
      db.insert(checklist)
        .values({
          id,
          cardId: m.cardId,
          name: m.name,
          position: orderKeyBetween(lastKey, null)
        })
        .run()
      logActivity(db, {
        boardId,
        cardId: m.cardId,
        type: 'checklist-added',
        data: { checklistId: id, name: m.name }
      })
      return { id, boardId }
    }
    case 'checklist.update': {
      const row = db
        .select({ cardId: checklist.cardId })
        .from(checklist)
        .where(eq(checklist.id, m.id))
        .get()
      const boardId = row ? cardBoardId(db, row.cardId) : null
      db.update(checklist)
        .set({ ...m.patch, updatedAt: now() })
        .where(eq(checklist.id, m.id))
        .run()
      return { id: m.id, boardId }
    }
    case 'checklist.delete': {
      const row = db
        .select({ cardId: checklist.cardId, name: checklist.name })
        .from(checklist)
        .where(eq(checklist.id, m.id))
        .get()
      const boardId = row ? cardBoardId(db, row.cardId) : null
      db.delete(checklist).where(eq(checklist.id, m.id)).run()
      if (row) {
        logActivity(db, {
          boardId,
          cardId: row.cardId,
          type: 'checklist-removed',
          data: { name: row.name }
        })
      }
      return { id: m.id, boardId }
    }

    // checklist item (checklist-scoped).
    case 'checklistItem.create': {
      const id = m.id ?? newId()
      const cl = db
        .select({ cardId: checklist.cardId })
        .from(checklist)
        .where(eq(checklist.id, m.checklistId))
        .get()
      const boardId = cl ? cardBoardId(db, cl.cardId) : null
      const lastKey =
        db
          .select({ p: checklistItem.position })
          .from(checklistItem)
          .where(eq(checklistItem.checklistId, m.checklistId))
          .orderBy(desc(checklistItem.position))
          .limit(1)
          .get()?.p ?? null
      db.insert(checklistItem)
        .values({
          id,
          checklistId: m.checklistId,
          text: m.text,
          position: orderKeyBetween(lastKey, null)
        })
        .run()
      return { id, boardId }
    }
    case 'checklistItem.update': {
      const row = db
        .select({ checklistId: checklistItem.checklistId })
        .from(checklistItem)
        .where(eq(checklistItem.id, m.id))
        .get()
      const cl = row
        ? db
            .select({ cardId: checklist.cardId })
            .from(checklist)
            .where(eq(checklist.id, row.checklistId))
            .get()
        : null
      const boardId = cl ? cardBoardId(db, cl.cardId) : null
      db.update(checklistItem)
        .set({ ...m.patch, updatedAt: now() })
        .where(eq(checklistItem.id, m.id))
        .run()
      return { id: m.id, boardId }
    }
    case 'checklistItem.delete': {
      const row = db
        .select({ checklistId: checklistItem.checklistId })
        .from(checklistItem)
        .where(eq(checklistItem.id, m.id))
        .get()
      const cl = row
        ? db
            .select({ cardId: checklist.cardId })
            .from(checklist)
            .where(eq(checklist.id, row.checklistId))
            .get()
        : null
      const boardId = cl ? cardBoardId(db, cl.cardId) : null
      db.delete(checklistItem).where(eq(checklistItem.id, m.id)).run()
      return { id: m.id, boardId }
    }
    case 'checklistItem.move': {
      return db.transaction((tx) => {
        const keyOf = (itemId: string | null | undefined): string | null =>
          itemId
            ? (tx
                .select({ p: checklistItem.position })
                .from(checklistItem)
                .where(
                  and(
                    eq(checklistItem.id, itemId),
                    eq(checklistItem.checklistId, m.toChecklistId)
                  )
                )
                .get()?.p ?? null)
            : null
        const position = orderKeyBetween(keyOf(m.beforeId), keyOf(m.afterId))
        tx.update(checklistItem)
          .set({
            checklistId: m.toChecklistId,
            position,
            updatedAt: now()
          })
          .where(eq(checklistItem.id, m.id))
          .run()
        const cl = tx
          .select({ cardId: checklist.cardId })
          .from(checklist)
          .where(eq(checklist.id, m.toChecklistId))
          .get()
        const boardId = cl ? cardBoardId(tx as unknown as Db, cl.cardId) : null
        return { id: m.id, boardId }
      })
    }

    // comment (card-scoped). `author` defaults to null (= human user);
    // MCP-posted comments will pass `'ai'`.
    case 'comment.create': {
      const id = m.id ?? newId()
      const boardId = cardBoardId(db, m.cardId)
      db.insert(comment)
        .values({
          id,
          cardId: m.cardId,
          body: m.body,
          author: m.author ?? null
        })
        .run()
      // Only AI comments surface in the activity feed (human comments
      // are already visible in the comments section, so logging them
      // there would double-display).
      if (m.author === 'ai') {
        logActivity(db, {
          boardId,
          cardId: m.cardId,
          type: 'ai-comment',
          data: { commentId: id }
        })
      }
      return { id, boardId }
    }
    case 'comment.update': {
      const row = db
        .select({ cardId: comment.cardId })
        .from(comment)
        .where(eq(comment.id, m.id))
        .get()
      const boardId = row ? cardBoardId(db, row.cardId) : null
      db.update(comment)
        .set({ ...m.patch, updatedAt: now() })
        .where(eq(comment.id, m.id))
        .run()
      return { id: m.id, boardId }
    }
    case 'comment.delete': {
      const row = db
        .select({ cardId: comment.cardId })
        .from(comment)
        .where(eq(comment.id, m.id))
        .get()
      const boardId = row ? cardBoardId(db, row.cardId) : null
      db.delete(comment).where(eq(comment.id, m.id)).run()
      return { id: m.id, boardId }
    }

    // ADR-0036 restore - replay a captured snapshot. The payload is a
    // discriminated union narrowed in `applyRestore`. Used exclusively
    // by the undo flow (`applyMutationRecorded` → undoOne); the
    // renderer never fires this directly and the MCP control-channel
    // allow-list excludes 'restore' so AI tools can't either.
    case 'restore': {
      return db.transaction((tx) =>
        applyRestore(tx as unknown as Db, m.payload as RestorePayload)
      )
    }

    // Attachment delete: clear any card.coverAttachmentId that
    // references this attachment, then remove the row. The file on
    // disk is unlinked by main (it owns the filesystem) - main does a
    // relPath lookup BEFORE invoking this mutation.
    case 'attachment.delete': {
      const row = db
        .select({ cardId: attachment.cardId, filename: attachment.filename })
        .from(attachment)
        .where(eq(attachment.id, m.id))
        .get()
      const boardId = row ? cardBoardId(db, row.cardId) : null
      db.transaction((tx) => {
        tx.update(card)
          .set({ coverAttachmentId: null, updatedAt: now() })
          .where(eq(card.coverAttachmentId, m.id))
          .run()
        tx.delete(attachment).where(eq(attachment.id, m.id)).run()
        if (row) {
          logActivity(tx as unknown as Db, {
            boardId,
            cardId: row.cardId,
            type: 'attachment-removed',
            data: { filename: row.filename }
          })
        }
      })
      return { id: m.id, boardId }
    }
  }
}

/** Insert an attachment row (file already copied to disk by main).
 *  The caller passes the id - it's also the per-attachment directory
 *  name under `userData/attachments/`, so generation has to live in
 *  main where the filesystem work happens. */
export function createAttachment(
  db: Db,
  input: {
    id: string
    cardId: string
    filename: string
    relPath: string
    mime: string | null
    size: number | null
    /** ADR-0023: set when the attachment was produced by the link-
     *  preview fetcher; null for normal local-file uploads. */
    sourceUrl?: string | null
    sourceTitle?: string | null
  }
): { id: string; boardId: string | null } {
  const boardId = cardBoardId(db, input.cardId)
  db.insert(attachment)
    .values({
      id: input.id,
      cardId: input.cardId,
      filename: input.filename,
      relPath: input.relPath,
      mime: input.mime,
      size: input.size,
      sourceUrl: input.sourceUrl ?? null,
      sourceTitle: input.sourceTitle ?? null
    })
    .run()
  logActivity(db, {
    boardId,
    cardId: input.cardId,
    type: 'attachment-added',
    data: {
      filename: input.filename,
      // Only include the URL in the activity if it actually came
      // from a URL - keeps the feed terse for file uploads.
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {})
    }
  })
  return { id: input.id, boardId }
}

/** Look up an attachment's relative file path (for main to unlink it
 *  AFTER the row is deleted via applyMutation). */
export function getAttachmentRelPath(db: Db, id: string): string | null {
  return (
    db
      .select({ p: attachment.relPath })
      .from(attachment)
      .where(eq(attachment.id, id))
      .get()?.p ?? null
  )
}
