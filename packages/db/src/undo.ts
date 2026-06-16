import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { type Mutation, type MutationResult, newId } from '@kanbini/shared'
import type { Db } from './client'
import { applyMutation } from './crud'
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
  undoLog
} from './schema'

// ADR-0036 · server-side undo / redo log.
//
// Why server-side: the AI (MCP) and the renderer both write through
// `applyMutation`. Recording at this layer captures every change
// regardless of source so Ctrl+Z can roll back an AI edit too. The
// log survives restarts (it's a sqlite table) and lives globally -
// every recorded entry has a `boardId` field that `undoOne` /
// `redoOne` filter by when the caller passes `scopeBoardId`.
//
// Per-board scoping (revision 6): the renderer passes its current
// board id as `scopeBoardId` so Ctrl+Z on board A never silently
// touches board B. From home / Settings the scope is omitted and the
// most-recent entry across all boards fires - App.tsx auto-navigates
// to the affected board using `result.boardId` so the user actually
// sees the change.
//
// Model: each recorded entry holds a `forward` mutation (for redo)
// and an `inverse` mutation (for undo). Status flips between
// 'undoable' (in the undo stack) and 'undone' (in the redo stack).
// A new mutation clears every 'undone' entry - standard editor
// behavior. The stack is bounded at MAX_UNDO_LOG_SIZE; the oldest
// 'undoable' rows are dropped when the cap is hit. Pruning is
// oldest-first WITHOUT causality tracking - a pruned create whose
// matching delete survives elsewhere in the log can leave the log
// in a state where redo resurrects state the user thought was gone.
// The Settings → Data → "Clear undo history" button is the user's
// escape hatch; causal pruning would fix it properly and is the
// follow-up on this ADR.
//
// Internal `restore` mutation: when the inverse of a destructive op
// can't be expressed as a regular mutation (it needs to recreate a
// whole tree of dependent rows), we use the `{type:'restore',
// payload}` arm whose `applyMutation` case re-inserts the captured
// snapshot. Restore is intentionally NOT exposed through the MCP
// control-channel allow-list so AI tools can't resurrect arbitrary
// state.

/** How many 'undoable' entries the log holds before pruning the
 *  oldest ones (the 'undone' redo tail is cleared on every new
 *  mutation, so it never grows unbounded and isn't counted here).
 *  Tuned to 100 after dogfooding -
 *  the prior 500-cap version surfaced confusing phantom-create
 *  scenarios where an ancient session's surviving creates got
 *  resurrected by a Ctrl+Z all → Ctrl+Y all sweep. A smaller window
 *  bounds how far back Ctrl+Z can reach, which is what most users
 *  intuit anyway ("a few mistakes ago", not "every change ever").
 *
 *  Pruning the oldest still has the same sharp edge it always did -
 *  when a CREATE is pruned out but later entries (its UPDATE / its
 *  children's CREATE) remain, redoing those later entries can fail
 *  FK constraints (the drift code drops them silently) OR resurrect
 *  state the user thought was gone via the older entry's matching
 *  delete. Settings → Data → Undo history "Clear" is the explicit
 *  user escape hatch until causal pruning lands. */
export const MAX_UNDO_LOG_SIZE = 100

/** Verbose `[undo]` logging - on by default in dev so the user can
 *  see exactly what each Ctrl+Z / Ctrl+Y is doing (the undo log is
 *  global + persistent, so Ctrl+Z past today's edits can hit older
 *  entries that may surprise - restoring a list you deleted in a
 *  previous session, for example).
 *
 *  Resolution: `KANBINI_UNDO_LOG=1` forces on, `=0` forces off,
 *  unset = on for NODE_ENV='development' (electron-vite dev), off
 *  otherwise (tests + production). Resolved on every call so a flip
 *  takes effect immediately. All output goes to stdout via
 *  console.log - Electron forwards main's stdout to the parent
 *  terminal, so it shows up alongside the `[main]` boot lines.
 *  Failures always log (separate `warn` helper). */
function verbose(): boolean {
  try {
    if (typeof process === 'undefined') return false
    const explicit = process.env?.KANBINI_UNDO_LOG
    if (explicit === '1') return true
    if (explicit === '0') return false
    return process.env?.NODE_ENV === 'development'
  } catch {
    return false
  }
}

function log(...args: unknown[]): void {
  if (verbose()) console.log('[undo]', ...args)
}

function warn(...args: unknown[]): void {
  // Failures always log - these surface the bad-entry drift cases.
  console.warn('[undo]', ...args)
}

/** Pull the entity id a mutation acts on (or null when N/A). Used in
 *  the [undo] log lines so the reader sees which CARD / LIST got
 *  created/updated/etc. - the previous logs printed the undo_log
 *  row's id (a UUIDv7), whose first 8 chars are a timestamp prefix
 *  and collided constantly across same-second mutations. */
function entityIdOf(m: Mutation): string | null {
  switch (m.type) {
    case 'card.create':
    case 'card.update':
    case 'card.delete':
    case 'card.move':
    case 'card.setLabels':
    case 'list.create':
    case 'list.update':
    case 'list.delete':
    case 'list.move':
    case 'board.create':
    case 'board.update':
    case 'board.delete':
    case 'board.move':
    case 'board.duplicate':
    case 'label.create':
    case 'label.update':
    case 'label.delete':
    case 'checklist.create':
    case 'checklist.update':
    case 'checklist.delete':
    case 'checklistItem.create':
    case 'checklistItem.update':
    case 'checklistItem.delete':
    case 'checklistItem.move':
    case 'comment.create':
    case 'comment.update':
    case 'comment.delete':
    case 'attachment.delete':
    case 'project.create':
    case 'project.update':
    case 'project.delete':
      return (m as { id?: string }).id ?? null
    case 'restore': {
      const p = m.payload as RestorePayload
      switch (p.kind) {
        case 'card':
          return p.card.id
        case 'list':
          return p.list.id
        case 'board':
          return p.board.id
        case 'checklist':
          return p.checklist.id
        case 'checklistItem':
          return p.item.id
        case 'comment':
          return p.comment.id
        case 'label':
          return p.label.id
        case 'attachment':
          return p.attachment.id
      }
    }
  }
}

/** 12-char id prefix - enough that UUIDv7 timestamps (first ~8 chars)
 *  + the random tail's first few chars disambiguate same-millisecond
 *  rows. Below 12 the time prefix collides and every row looks the
 *  same. Falls back to '∅' for null. */
function shortId(id: string | null): string {
  return id ? id.slice(0, 12) : '∅'
}

// -- Snapshot types -----------------------------------------------

export interface CardSnapshot {
  id: string
  listId: string
  title: string
  description: string | null
  position: string
  dueAt: number | null
  completed: boolean
  coverAttachmentId: string | null
  archived: boolean
  /** ADR-0037 card priority; null = unprioritised. */
  priority: string | null
  /** ADR-0032 follow-up: when the card was added to its list. */
  listAddedAt: number
  createdAt: number
  updatedAt: number
  labelIds: string[]
  checklists: ChecklistSnapshot[]
  comments: CommentSnapshot[]
  attachments: AttachmentSnapshot[]
  /** The card's activity-feed rows. Captured so a delete+undo restores
   *  the history too: `activity.boardId` is `onDelete: cascade` (a board
   *  delete WIPES every row) and `activity.cardId` is `onDelete: set
   *  null` (a card/list delete orphans rows to `cardId=null`, where the
   *  card-scoped feed query never finds them again). Without this the
   *  feed came back empty after restoring a deleted card/list/board. */
  activities: ActivitySnapshot[]
}

export interface ActivitySnapshot {
  id: string
  boardId: string | null
  cardId: string | null
  type: string
  data: unknown
  createdAt: number
}

export interface ChecklistSnapshot {
  id: string
  cardId: string
  name: string
  position: string
  createdAt: number
  updatedAt: number
  items: ChecklistItemSnapshot[]
}

export interface ChecklistItemSnapshot {
  id: string
  checklistId: string
  text: string
  completed: boolean
  position: string
  createdAt: number
  updatedAt: number
}

export interface CommentSnapshot {
  id: string
  cardId: string
  body: string
  author: string | null
  createdAt: number
  updatedAt: number
}

export interface AttachmentSnapshot {
  id: string
  cardId: string
  filename: string
  relPath: string
  mime: string | null
  size: number | null
  sourceUrl: string | null
  sourceTitle: string | null
  createdAt: number
}

export interface LabelSnapshot {
  id: string
  boardId: string
  name: string
  color: string
  createdAt: number
  updatedAt: number
  /** Cards the label was attached to - re-stitched into `card_label`
   *  on restore. */
  cardIds: string[]
}

export interface ListSnapshot {
  id: string
  boardId: string
  name: string
  color: string | null
  position: string
  closed: boolean
  wipLimit: number | null
  sortMode: string | null
  /** ADR-0041 on-enter rule (JSON-mode column = unknown shape). */
  onEnter: unknown
  createdAt: number
  updatedAt: number
  cards: CardSnapshot[]
}

export interface BoardSnapshot {
  id: string
  projectId: string
  name: string
  description: string | null
  color: string | null
  background: unknown
  /** ADR-0037 slice 2 swimlane mode; null = off. */
  swimlaneMode: string | null
  position: string
  archived: boolean
  pinned: boolean
  createdAt: number
  updatedAt: number
  labels: LabelSnapshot[]
  lists: ListSnapshot[]
}

/** Discriminated restore payload - what rides in
 *  `{type:'restore', payload}` mutations. */
export type RestorePayload =
  | { kind: 'card'; card: CardSnapshot }
  | { kind: 'list'; list: ListSnapshot }
  | { kind: 'board'; board: BoardSnapshot }
  | { kind: 'checklist'; checklist: ChecklistSnapshot }
  | { kind: 'checklistItem'; item: ChecklistItemSnapshot }
  | { kind: 'comment'; comment: CommentSnapshot }
  | { kind: 'label'; label: LabelSnapshot }
  | { kind: 'attachment'; attachment: AttachmentSnapshot }

// -- Snapshot capture --------------------------------------------

export function snapshotChecklistItem(
  db: Db,
  id: string
): ChecklistItemSnapshot | null {
  const r = db
    .select()
    .from(checklistItem)
    .where(eq(checklistItem.id, id))
    .get()
  return r
    ? {
        id: r.id,
        checklistId: r.checklistId,
        text: r.text,
        completed: r.completed,
        position: r.position,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
      }
    : null
}

export function snapshotChecklist(
  db: Db,
  id: string
): ChecklistSnapshot | null {
  const r = db.select().from(checklist).where(eq(checklist.id, id)).get()
  if (!r) return null
  const items = db
    .select()
    .from(checklistItem)
    .where(eq(checklistItem.checklistId, id))
    .orderBy(asc(checklistItem.position))
    .all()
    .map((it) => ({
      id: it.id,
      checklistId: it.checklistId,
      text: it.text,
      completed: it.completed,
      position: it.position,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt
    }))
  return {
    id: r.id,
    cardId: r.cardId,
    name: r.name,
    position: r.position,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    items
  }
}

export function snapshotComment(db: Db, id: string): CommentSnapshot | null {
  const r = db.select().from(comment).where(eq(comment.id, id)).get()
  return r
    ? {
        id: r.id,
        cardId: r.cardId,
        body: r.body,
        author: r.author,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
      }
    : null
}

export function snapshotAttachment(
  db: Db,
  id: string
): AttachmentSnapshot | null {
  const r = db.select().from(attachment).where(eq(attachment.id, id)).get()
  return r
    ? {
        id: r.id,
        cardId: r.cardId,
        filename: r.filename,
        relPath: r.relPath,
        mime: r.mime,
        size: r.size,
        sourceUrl: r.sourceUrl,
        sourceTitle: r.sourceTitle,
        createdAt: r.createdAt
      }
    : null
}

export function snapshotLabel(db: Db, id: string): LabelSnapshot | null {
  const r = db.select().from(label).where(eq(label.id, id)).get()
  if (!r) return null
  const cardIds = db
    .select({ id: cardLabel.cardId })
    .from(cardLabel)
    .where(eq(cardLabel.labelId, id))
    .all()
    .map((x) => x.id)
  return {
    id: r.id,
    boardId: r.boardId,
    name: r.name,
    color: r.color,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    cardIds
  }
}

export function snapshotCard(db: Db, id: string): CardSnapshot | null {
  const r = db.select().from(card).where(eq(card.id, id)).get()
  if (!r) return null
  const labelIds = db
    .select({ id: cardLabel.labelId })
    .from(cardLabel)
    .where(eq(cardLabel.cardId, id))
    .all()
    .map((x) => x.id)
  const checklists = db
    .select({ id: checklist.id })
    .from(checklist)
    .where(eq(checklist.cardId, id))
    .all()
    .map((row) => snapshotChecklist(db, row.id))
    .filter((x): x is ChecklistSnapshot => x !== null)
  const comments = db
    .select()
    .from(comment)
    .where(eq(comment.cardId, id))
    .all()
    .map((cm) => ({
      id: cm.id,
      cardId: cm.cardId,
      body: cm.body,
      author: cm.author,
      createdAt: cm.createdAt,
      updatedAt: cm.updatedAt
    }))
  const attachments = db
    .select()
    .from(attachment)
    .where(eq(attachment.cardId, id))
    .all()
    .map((at) => ({
      id: at.id,
      cardId: at.cardId,
      filename: at.filename,
      relPath: at.relPath,
      mime: at.mime,
      size: at.size,
      sourceUrl: at.sourceUrl,
      sourceTitle: at.sourceTitle,
      createdAt: at.createdAt
    }))
  const activities = db
    .select()
    .from(activity)
    .where(eq(activity.cardId, id))
    .all()
    .map((a) => ({
      id: a.id,
      boardId: a.boardId,
      cardId: a.cardId,
      type: a.type,
      data: a.data,
      createdAt: a.createdAt
    }))
  return {
    id: r.id,
    listId: r.listId,
    title: r.title,
    description: r.description,
    position: r.position,
    dueAt: r.dueAt,
    completed: r.completed,
    coverAttachmentId: r.coverAttachmentId,
    archived: r.archived,
    priority: r.priority,
    listAddedAt: r.listAddedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    labelIds,
    checklists,
    comments,
    attachments,
    activities
  }
}

export function snapshotList(db: Db, id: string): ListSnapshot | null {
  const r = db.select().from(list).where(eq(list.id, id)).get()
  if (!r) return null
  const cards = db
    .select({ id: card.id })
    .from(card)
    .where(eq(card.listId, id))
    .all()
    .map((row) => snapshotCard(db, row.id))
    .filter((x): x is CardSnapshot => x !== null)
  return {
    id: r.id,
    boardId: r.boardId,
    name: r.name,
    color: r.color,
    position: r.position,
    closed: r.closed,
    wipLimit: r.wipLimit,
    sortMode: r.sortMode,
    onEnter: r.onEnter,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    cards
  }
}

export function snapshotBoard(db: Db, id: string): BoardSnapshot | null {
  const r = db.select().from(board).where(eq(board.id, id)).get()
  if (!r) return null
  const labels = db
    .select({ id: label.id })
    .from(label)
    .where(eq(label.boardId, id))
    .all()
    .map((row) => snapshotLabel(db, row.id))
    .filter((x): x is LabelSnapshot => x !== null)
  const lists = db
    .select({ id: list.id })
    .from(list)
    .where(eq(list.boardId, id))
    .all()
    .map((row) => snapshotList(db, row.id))
    .filter((x): x is ListSnapshot => x !== null)
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    description: r.description,
    color: r.color,
    background: r.background,
    swimlaneMode: r.swimlaneMode,
    position: r.position,
    archived: r.archived,
    pinned: r.pinned,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    labels,
    lists
  }
}

// -- Restore (apply a snapshot) ---------------------------------

/** Re-insert a card snapshot + every dependent row. Wrapped in the
 *  caller's transaction so a half-restore can't leak. Idempotent
 *  only if the id is genuinely absent (otherwise SQLite raises a
 *  PRIMARY KEY violation - by design, restore shouldn't run twice). */
function restoreCard(db: Db, s: CardSnapshot): void {
  db.insert(card)
    .values({
      id: s.id,
      listId: s.listId,
      title: s.title,
      description: s.description,
      position: s.position,
      dueAt: s.dueAt,
      completed: s.completed,
      coverAttachmentId: s.coverAttachmentId,
      archived: s.archived,
      priority: s.priority,
      listAddedAt: s.listAddedAt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    })
    .run()
  if (s.labelIds.length > 0) {
    // Filter to labels that still exist - between snapshot capture
    // and undo, a label can be deleted out-of-band (or by an earlier
    // entry on the undo stack). Without the filter we'd FK-violate
    // and the whole restore transaction would roll back. Same
    // pattern as restoreLabel's `stillExist` check.
    const stillExistLabels = db
      .select({ id: label.id })
      .from(label)
      .where(inArray(label.id, s.labelIds))
      .all()
      .map((r) => r.id)
    if (stillExistLabels.length > 0) {
      db.insert(cardLabel)
        .values(
          stillExistLabels.map((labelId) => ({ cardId: s.id, labelId }))
        )
        .run()
    }
  }
  for (const cl of s.checklists) restoreChecklist(db, cl)
  for (const cm of s.comments) restoreComment(db, cm)
  for (const at of s.attachments) restoreAttachment(db, at)
  restoreActivities(db, s.activities)
}

/** Re-create a card's activity rows. Two delete paths converge here:
 *  a board delete cascades the rows away entirely, while a card/list
 *  delete only NULLs their `cardId` (the row survives, orphaned). So we
 *  delete any surviving row by id first, then re-insert from the
 *  snapshot - re-linking the orphan AND recreating the cascaded ones in
 *  one uniform path. Board + card are already inserted by the time we
 *  get here, so both FKs (boardId, cardId) resolve. The undo log
 *  persists across restarts, so a row captured before this field
 *  existed has `activities` literally absent - guard for that. */
function restoreActivities(
  db: Db,
  activities: ActivitySnapshot[] | undefined
): void {
  if (!activities || activities.length === 0) return
  const ids = activities.map((a) => a.id)
  db.delete(activity).where(inArray(activity.id, ids)).run()
  db.insert(activity)
    .values(
      activities.map((a) => ({
        id: a.id,
        boardId: a.boardId,
        cardId: a.cardId,
        type: a.type,
        data: a.data,
        createdAt: a.createdAt
      }))
    )
    .run()
}

function restoreChecklist(db: Db, s: ChecklistSnapshot): void {
  db.insert(checklist)
    .values({
      id: s.id,
      cardId: s.cardId,
      name: s.name,
      position: s.position,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    })
    .run()
  for (const it of s.items) restoreChecklistItem(db, it)
}

function restoreChecklistItem(db: Db, s: ChecklistItemSnapshot): void {
  db.insert(checklistItem)
    .values({
      id: s.id,
      checklistId: s.checklistId,
      text: s.text,
      completed: s.completed,
      position: s.position,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    })
    .run()
}

function restoreComment(db: Db, s: CommentSnapshot): void {
  db.insert(comment)
    .values({
      id: s.id,
      cardId: s.cardId,
      body: s.body,
      author: s.author,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    })
    .run()
}

function restoreAttachment(db: Db, s: AttachmentSnapshot): void {
  db.insert(attachment)
    .values({
      id: s.id,
      cardId: s.cardId,
      filename: s.filename,
      relPath: s.relPath,
      mime: s.mime,
      size: s.size,
      sourceUrl: s.sourceUrl,
      sourceTitle: s.sourceTitle,
      createdAt: s.createdAt
    })
    .run()
}

function restoreLabel(db: Db, s: LabelSnapshot): void {
  db.insert(label)
    .values({
      id: s.id,
      boardId: s.boardId,
      name: s.name,
      color: s.color,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    })
    .run()
  // Re-attach the label to its cards. Filter to cards that still
  // exist - if one was deleted between the snapshot and the undo,
  // we just skip its association (the cardLabel FK would fail
  // anyway).
  if (s.cardIds.length > 0) {
    const stillExist = db
      .select({ id: card.id })
      .from(card)
      .where(inArray(card.id, s.cardIds))
      .all()
      .map((r) => r.id)
    if (stillExist.length > 0) {
      db.insert(cardLabel)
        .values(stillExist.map((cardId) => ({ cardId, labelId: s.id })))
        .run()
    }
  }
}

function restoreList(db: Db, s: ListSnapshot): void {
  db.insert(list)
    .values({
      id: s.id,
      boardId: s.boardId,
      name: s.name,
      color: s.color,
      position: s.position,
      closed: s.closed,
      wipLimit: s.wipLimit,
      sortMode: s.sortMode,
      onEnter: s.onEnter,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    })
    .run()
  for (const c of s.cards) restoreCard(db, c)
}

function restoreBoard(db: Db, s: BoardSnapshot): void {
  db.insert(board)
    .values({
      id: s.id,
      projectId: s.projectId,
      name: s.name,
      description: s.description,
      color: s.color,
      background: s.background,
      swimlaneMode: s.swimlaneMode,
      position: s.position,
      archived: s.archived,
      pinned: s.pinned,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    })
    .run()
  // Labels FIRST so cards in the lists can attach to them.
  for (const lb of s.labels) restoreLabel(db, lb)
  for (const l of s.lists) restoreList(db, l)
}

/** Apply a restore payload - re-creates the captured subtree atomically.
 *  Returns the affected boardId so the IPC layer can broadcastChange.
 *  Wrapped in a transaction by the caller (`applyMutation`'s restore
 *  arm) so a half-restore can't leak. */
export function applyRestore(db: Db, payload: RestorePayload): MutationResult {
  switch (payload.kind) {
    case 'card':
      restoreCard(db, payload.card)
      return { id: payload.card.id, boardId: cardBoardId(db, payload.card.id) }
    case 'list':
      restoreList(db, payload.list)
      return { id: payload.list.id, boardId: payload.list.boardId }
    case 'board':
      restoreBoard(db, payload.board)
      return { id: payload.board.id, boardId: payload.board.id }
    case 'checklist':
      restoreChecklist(db, payload.checklist)
      return {
        id: payload.checklist.id,
        boardId: cardBoardId(db, payload.checklist.cardId)
      }
    case 'checklistItem':
      restoreChecklistItem(db, payload.item)
      return {
        id: payload.item.id,
        boardId: checklistItemBoardId(db, payload.item.id)
      }
    case 'comment':
      restoreComment(db, payload.comment)
      return {
        id: payload.comment.id,
        boardId: cardBoardId(db, payload.comment.cardId)
      }
    case 'label':
      restoreLabel(db, payload.label)
      return { id: payload.label.id, boardId: payload.label.boardId }
    case 'attachment':
      // NOTE: only the row is restored - the file on disk may already
      // be gone (main unlinks on attachment.delete). The renderer's
      // broken-image fallback covers the missing-file case.
      restoreAttachment(db, payload.attachment)
      return {
        id: payload.attachment.id,
        boardId: cardBoardId(db, payload.attachment.cardId)
      }
  }
}

function cardBoardId(db: Db, cardId: string): string | null {
  const c = db
    .select({ listId: card.listId })
    .from(card)
    .where(eq(card.id, cardId))
    .get()
  if (!c) return null
  return (
    db
      .select({ b: list.boardId })
      .from(list)
      .where(eq(list.id, c.listId))
      .get()?.b ?? null
  )
}

function checklistItemBoardId(db: Db, itemId: string): string | null {
  const it = db
    .select({ checklistId: checklistItem.checklistId })
    .from(checklistItem)
    .where(eq(checklistItem.id, itemId))
    .get()
  if (!it) return null
  const cl = db
    .select({ cardId: checklist.cardId })
    .from(checklist)
    .where(eq(checklist.id, it.checklistId))
    .get()
  return cl ? cardBoardId(db, cl.cardId) : null
}

// -- Inverse computation -----------------------------------------

/** Pure description label for the undo entry - shown in tooltips +
 *  the activity feed. Kept short so the UI doesn't have to truncate. */
function describeMutation(m: Mutation): string {
  switch (m.type) {
    case 'card.create':
      return `Create card "${m.title}"`
    case 'card.update':
      return `Edit card`
    case 'card.delete':
      return `Delete card`
    case 'card.move':
      return `Move card`
    case 'card.setLabels':
      return `Change card labels`
    case 'list.create':
      return `Create list "${m.name}"`
    case 'list.update':
      return `Edit list`
    case 'list.delete':
      return `Delete list`
    case 'list.move':
      return `Move list`
    case 'board.create':
      return `Create board "${m.name}"`
    case 'board.update':
      return `Edit board`
    case 'board.delete':
      return `Delete board`
    case 'board.move':
      return `Move board`
    case 'board.duplicate':
      return `Duplicate board`
    case 'label.create':
      return `Create label "${m.name}"`
    case 'label.update':
      return `Edit label`
    case 'label.delete':
      return `Delete label`
    case 'checklist.create':
      return `Add checklist "${m.name}"`
    case 'checklist.update':
      return `Edit checklist`
    case 'checklist.delete':
      return `Delete checklist`
    case 'checklistItem.create':
      return `Add checklist item`
    case 'checklistItem.update':
      return `Edit checklist item`
    case 'checklistItem.delete':
      return `Delete checklist item`
    case 'checklistItem.move':
      return `Move checklist item`
    case 'comment.create':
      return `Add comment`
    case 'comment.update':
      return `Edit comment`
    case 'comment.delete':
      return `Delete comment`
    case 'attachment.delete':
      return `Delete attachment`
    case 'restore':
      return `Restore`
    case 'project.create':
      return `Create project`
    case 'project.update':
      return `Edit project`
    case 'project.delete':
      return `Delete project`
  }
}

/** Build the inverse mutation for `m` reading the current DB state
 *  BEFORE `m` is applied. For mutations whose inverse depends on the
 *  POST-state (e.g. `card.create` needs the new id), pass
 *  `result` after-the-fact via `inverseAfter`. Returns null when
 *  the mutation is intentionally not recorded (e.g. project.* in v1). */
export function inverseBefore(db: Db, m: Mutation): Mutation | null {
  switch (m.type) {
    // -- Updates: capture old field values --
    case 'card.update': {
      const old = db.select().from(card).where(eq(card.id, m.id)).get()
      if (!old) return null
      const patch: Record<string, unknown> = {}
      if ('title' in m.patch) patch.title = old.title
      if ('description' in m.patch) patch.description = old.description
      if ('completed' in m.patch) patch.completed = old.completed
      if ('dueAt' in m.patch) patch.dueAt = old.dueAt
      if ('coverAttachmentId' in m.patch)
        patch.coverAttachmentId = old.coverAttachmentId
      if ('priority' in m.patch) patch.priority = old.priority
      return { type: 'card.update', id: m.id, patch }
    }
    case 'list.update': {
      const old = db.select().from(list).where(eq(list.id, m.id)).get()
      if (!old) return null
      const patch: Record<string, unknown> = {}
      if ('name' in m.patch) patch.name = old.name
      if ('color' in m.patch) patch.color = old.color
      if ('closed' in m.patch) patch.closed = old.closed
      if ('wipLimit' in m.patch) patch.wipLimit = old.wipLimit
      if ('sortMode' in m.patch) patch.sortMode = old.sortMode
      if ('onEnter' in m.patch) patch.onEnter = old.onEnter
      return { type: 'list.update', id: m.id, patch }
    }
    case 'board.update': {
      const old = db.select().from(board).where(eq(board.id, m.id)).get()
      if (!old) return null
      const patch: Record<string, unknown> = {}
      if ('name' in m.patch) patch.name = old.name
      if ('description' in m.patch) patch.description = old.description
      if ('color' in m.patch) patch.color = old.color
      if ('archived' in m.patch) patch.archived = old.archived
      if ('pinned' in m.patch) patch.pinned = old.pinned
      if ('background' in m.patch) patch.background = old.background
      // ADR-0037 slice 2: swimlaneMode is a view setting, not data -
      // deliberately NOT captured here so Ctrl+Z never reverts a
      // "Group by" toggle. When the patch ONLY touches swimlaneMode
      // the inverse patch is empty → return null and the recorder
      // skips logging the mutation entirely (preserves the redo tail
      // too - a view toggle in the middle of an undo session
      // shouldn't kill the redo stack).
      if (Object.keys(patch).length === 0) return null
      return { type: 'board.update', id: m.id, patch }
    }
    case 'label.update': {
      const old = db.select().from(label).where(eq(label.id, m.id)).get()
      if (!old) return null
      const patch: Record<string, unknown> = {}
      if ('name' in m.patch) patch.name = old.name
      if ('color' in m.patch) patch.color = old.color
      return { type: 'label.update', id: m.id, patch }
    }
    case 'checklist.update': {
      const old = db
        .select()
        .from(checklist)
        .where(eq(checklist.id, m.id))
        .get()
      if (!old) return null
      const patch: Record<string, unknown> = {}
      if ('name' in m.patch) patch.name = old.name
      return { type: 'checklist.update', id: m.id, patch }
    }
    case 'checklistItem.update': {
      const old = db
        .select()
        .from(checklistItem)
        .where(eq(checklistItem.id, m.id))
        .get()
      if (!old) return null
      const patch: Record<string, unknown> = {}
      if ('text' in m.patch) patch.text = old.text
      if ('completed' in m.patch) patch.completed = old.completed
      return { type: 'checklistItem.update', id: m.id, patch }
    }
    case 'comment.update': {
      const old = db.select().from(comment).where(eq(comment.id, m.id)).get()
      if (!old) return null
      const patch: Record<string, unknown> = {}
      if ('body' in m.patch) patch.body = old.body
      return { type: 'comment.update', id: m.id, patch }
    }

    // -- Moves: capture old position --
    case 'card.move': {
      const old = db
        .select({ listId: card.listId, listAddedAt: card.listAddedAt })
        .from(card)
        .where(eq(card.id, m.id))
        .get()
      if (!old) return null
      // Capture siblings as they exist BEFORE the move so we can name
      // the pre-move neighbours.
      const siblings = db
        .select({ id: card.id })
        .from(card)
        .where(eq(card.listId, old.listId))
        .orderBy(asc(card.position))
        .all()
      const myIdx = siblings.findIndex((s) => s.id === m.id)
      const beforeId = siblings[myIdx - 1]?.id ?? null
      const afterId = siblings[myIdx + 1]?.id ?? null
      return {
        type: 'card.move',
        id: m.id,
        toListId: old.listId,
        beforeId,
        afterId,
        // Restore the prior list-entry time so an undone cross-list move
        // doesn't re-stamp "added to list" to the moment of the undo.
        listAddedAt: old.listAddedAt
      }
    }
    case 'board.move': {
      const old = db
        .select({ projectId: board.projectId, position: board.position })
        .from(board)
        .where(eq(board.id, m.id))
        .get()
      if (!old) return null
      const siblings = db
        .select({ id: board.id, position: board.position })
        .from(board)
        .where(eq(board.projectId, old.projectId))
        .orderBy(asc(board.position))
        .all()
      const myIdx = siblings.findIndex((s) => s.id === m.id)
      const beforeId = siblings[myIdx - 1]?.id ?? null
      const afterId = siblings[myIdx + 1]?.id ?? null
      return { type: 'board.move', id: m.id, beforeId, afterId }
    }
    case 'list.move': {
      const old = db
        .select({ boardId: list.boardId })
        .from(list)
        .where(eq(list.id, m.id))
        .get()
      if (!old) return null
      const siblings = db
        .select({ id: list.id, position: list.position })
        .from(list)
        .where(eq(list.boardId, old.boardId))
        .orderBy(asc(list.position))
        .all()
      const myIdx = siblings.findIndex((s) => s.id === m.id)
      const beforeId = siblings[myIdx - 1]?.id ?? null
      const afterId = siblings[myIdx + 1]?.id ?? null
      return { type: 'list.move', id: m.id, beforeId, afterId }
    }
    case 'checklistItem.move': {
      const old = db
        .select({
          checklistId: checklistItem.checklistId,
          position: checklistItem.position
        })
        .from(checklistItem)
        .where(eq(checklistItem.id, m.id))
        .get()
      if (!old) return null
      const siblings = db
        .select({ id: checklistItem.id, position: checklistItem.position })
        .from(checklistItem)
        .where(eq(checklistItem.checklistId, old.checklistId))
        .orderBy(asc(checklistItem.position))
        .all()
      const myIdx = siblings.findIndex((s) => s.id === m.id)
      const beforeId = siblings[myIdx - 1]?.id ?? null
      const afterId = siblings[myIdx + 1]?.id ?? null
      return {
        type: 'checklistItem.move',
        id: m.id,
        toChecklistId: old.checklistId,
        beforeId,
        afterId
      }
    }

    // -- setLabels: capture old labelIds --
    case 'card.setLabels': {
      const oldIds = db
        .select({ id: cardLabel.labelId })
        .from(cardLabel)
        .where(eq(cardLabel.cardId, m.id))
        .all()
        .map((r) => r.id)
      return { type: 'card.setLabels', id: m.id, labelIds: oldIds }
    }

    // -- Deletes: snapshot the full subtree --
    case 'card.delete': {
      const s = snapshotCard(db, m.id)
      if (!s) return null
      return { type: 'restore', payload: { kind: 'card', card: s } }
    }
    case 'list.delete': {
      const s = snapshotList(db, m.id)
      if (!s) return null
      return { type: 'restore', payload: { kind: 'list', list: s } }
    }
    case 'board.delete': {
      const s = snapshotBoard(db, m.id)
      if (!s) return null
      return { type: 'restore', payload: { kind: 'board', board: s } }
    }
    case 'checklist.delete': {
      const s = snapshotChecklist(db, m.id)
      if (!s) return null
      return { type: 'restore', payload: { kind: 'checklist', checklist: s } }
    }
    case 'checklistItem.delete': {
      const s = snapshotChecklistItem(db, m.id)
      if (!s) return null
      return { type: 'restore', payload: { kind: 'checklistItem', item: s } }
    }
    case 'comment.delete': {
      const s = snapshotComment(db, m.id)
      if (!s) return null
      return { type: 'restore', payload: { kind: 'comment', comment: s } }
    }
    case 'label.delete': {
      const s = snapshotLabel(db, m.id)
      if (!s) return null
      return { type: 'restore', payload: { kind: 'label', label: s } }
    }
    case 'attachment.delete': {
      const s = snapshotAttachment(db, m.id)
      if (!s) return null
      return { type: 'restore', payload: { kind: 'attachment', attachment: s } }
    }

    // -- Creates: handled in inverseAfter (need the new id) --
    case 'card.create':
    case 'list.create':
    case 'board.create':
    case 'board.duplicate':
    case 'label.create':
    case 'checklist.create':
    case 'checklistItem.create':
    case 'comment.create':
      return null

    // -- Out of scope for v1 --
    case 'project.create':
    case 'project.update':
    case 'project.delete':
      return null

    // -- Restore itself isn't recorded - undo of a restore would be
    // recreating the situation that prompted the restore. The undo
    // flow flips the entry's status in the log directly. --
    case 'restore':
      return null
  }
}

/** For mutations whose inverse needs the post-state (creates need the
 *  new id), build the inverse after applyMutation runs. */
export function inverseAfter(
  m: Mutation,
  result: MutationResult
): Mutation | null {
  switch (m.type) {
    case 'card.create':
      return { type: 'card.delete', id: result.id }
    case 'list.create':
      return { type: 'list.delete', id: result.id }
    case 'board.create':
    case 'board.duplicate':
      return { type: 'board.delete', id: result.id }
    case 'label.create':
      return { type: 'label.delete', id: result.id }
    case 'checklist.create':
      return { type: 'checklist.delete', id: result.id }
    case 'checklistItem.create':
      return { type: 'checklistItem.delete', id: result.id }
    case 'comment.create':
      return { type: 'comment.delete', id: result.id }
    default:
      return null
  }
}

// -- Log management ----------------------------------------------

interface RecordOptions {
  /** When true (set by the undo / redo handler), this `applyMutation`
   *  call is itself the application of an inverse - don't record. */
  silent?: boolean
  /** Stamp the recorded entry with a bulk-gesture group id so undo /
   *  redo pop the whole gesture as one step. Set by
   *  `applyMutationsRecorded` - callers don't pass this directly. */
  groupId?: string
}

/** Mutation types whose `id` we want to backfill into the stored
 *  forward post-apply (so a future redo recreates the same id, and
 *  downstream entries that reference it still resolve). */
const CREATE_TYPES = new Set([
  'card.create',
  'list.create',
  'board.create',
  'label.create',
  'checklist.create',
  'checklistItem.create',
  'comment.create'
])

function isCreateWithoutId(m: Mutation): boolean {
  if (!CREATE_TYPES.has(m.type)) return false
  // `id` is the optional field added in ADR-0036 revision; if it's
  // already populated (e.g. a redo replay), nothing to backfill.
  return !(m as { id?: string }).id
}

/** Wrap `applyMutation` with undo-log recording. Captures the inverse
 *  before applying (or after, for creates), then inserts the log row +
 *  prunes the stack in a single transaction. The 'undone' (redo) tail
 *  is cleared on every new mutation - standard editor model.
 *
 *  Create mutations get their minted id backfilled into the stored
 *  forward - without that backfill, a redo would mint a NEW id and
 *  every later entry that referenced the original would break the FK
 *  on its parent (the user-visible bug that surfaced in dogfooding).
 */
export function applyMutationRecorded(
  db: Db,
  m: Mutation,
  opts: RecordOptions = {}
): MutationResult {
  if (opts.silent || m.type === 'restore') {
    return applyMutation(db, m)
  }

  return db.transaction((tx) => {
    const txDb = tx as unknown as Db
    const inverseB = inverseBefore(txDb, m)
    const result = applyMutation(txDb, m)
    const inverse = inverseB ?? inverseAfter(m, result)
    if (inverse) {
      // Clear the redo tail (anything in 'undone' status).
      tx.delete(undoLog).where(eq(undoLog.status, 'undone')).run()
      // Backfill the minted id into a stored copy of the forward
      // (creates only - see CREATE_TYPES above).
      const storedForward = isCreateWithoutId(m)
        ? ({ ...m, id: result.id } as Mutation)
        : // board.duplicate is create-like, but its `id` is the SOURCE
          // board - the NEW board's id rides in `newId` so a redo
          // recreates the same duplicate instead of minting a fresh one
          // (which would orphan it and dangle the stored inverse).
          m.type === 'board.duplicate' && !m.newId
          ? ({ ...m, newId: result.id } as Mutation)
          : m
      // Insert the new entry.
      const entryId = newId()
      tx.insert(undoLog)
        .values({
          id: entryId,
          boardId: result.boardId,
          description: describeMutation(m),
          forward: storedForward as unknown,
          inverse: inverse as unknown,
          groupId: opts.groupId ?? null
        })
        .run()
      const entityId = entityIdOf(storedForward) ?? result.id
      log(
        `record [${m.type}] →`,
        describeMutation(m),
        '· entity=' + shortId(entityId),
        '· board=' + shortId(result.boardId)
      )
      // Cap at MAX_UNDO_LOG_SIZE - drop the oldest 'undoable' rows.
      // `id` (UUIDv7, monotonic within this process) tiebreaks rows
      // recorded in the same millisecond - see undoOne for why.
      const undoableIds = tx
        .select({ id: undoLog.id })
        .from(undoLog)
        .where(eq(undoLog.status, 'undoable'))
        .orderBy(asc(undoLog.createdAt), asc(undoLog.id))
        .all()
        .map((r) => r.id)
      if (undoableIds.length > MAX_UNDO_LOG_SIZE) {
        const toDrop = undoableIds.slice(
          0,
          undoableIds.length - MAX_UNDO_LOG_SIZE
        )
        tx.delete(undoLog).where(inArray(undoLog.id, toDrop)).run()
      }
    }
    return result
  })
}

/** Apply a bulk gesture - several mutations in ONE transaction, each
 *  recorded with a shared group id so a single Ctrl+Z unwinds the
 *  whole gesture (and Ctrl+Y replays it). One mutation = no group
 *  (identical to a plain applyMutationRecorded call). Atomic: if any
 *  mutation throws, the entire batch rolls back - a bulk action that
 *  half-applied would be worse than one that cleanly failed. */
export function applyMutationsRecorded(
  db: Db,
  mutations: Mutation[]
): MutationResult[] {
  if (mutations.length === 0) return []
  if (mutations.length === 1) {
    return [applyMutationRecorded(db, mutations[0]!)]
  }
  const groupId = newId()
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db
    return mutations.map((m) => applyMutationRecorded(txDb, m, { groupId }))
  })
}

export interface UndoStatus {
  canUndo: boolean
  canRedo: boolean
  undoDescription: string | null
  redoDescription: string | null
}

/** Size of the bulk group `groupId` belongs to within `status`, for
 *  the status tooltips. */
function groupSize(
  db: Db,
  groupId: string,
  status: 'undoable' | 'undone'
): number {
  return db
    .select({ id: undoLog.id })
    .from(undoLog)
    .where(and(eq(undoLog.status, status), eq(undoLog.groupId, groupId)))
    .all().length
}

/** Tooltip text for an entry - grouped entries surface how many
 *  changes one Ctrl+Z / Ctrl+Y will cover. */
function describeEntry(
  db: Db,
  row: { description: string; groupId: string | null },
  status: 'undoable' | 'undone'
): string {
  if (!row.groupId) return row.description
  const n = groupSize(db, row.groupId, status)
  return n > 1 ? `${row.description} (${n} changes)` : row.description
}

export function undoStatus(db: Db): UndoStatus {
  const nextUndo = db
    .select({ description: undoLog.description, groupId: undoLog.groupId })
    .from(undoLog)
    .where(eq(undoLog.status, 'undoable'))
    .orderBy(desc(undoLog.createdAt), desc(undoLog.id))
    .limit(1)
    .get()
  const nextRedo = db
    .select({ description: undoLog.description, groupId: undoLog.groupId })
    .from(undoLog)
    .where(eq(undoLog.status, 'undone'))
    .orderBy(asc(undoLog.createdAt), asc(undoLog.id))
    .limit(1)
    .get()
  return {
    canUndo: !!nextUndo,
    canRedo: !!nextRedo,
    undoDescription: nextUndo ? describeEntry(db, nextUndo, 'undoable') : null,
    redoDescription: nextRedo ? describeEntry(db, nextRedo, 'undone') : null
  }
}

export interface UndoApplyResult {
  applied: boolean
  boardId: string | null
}

/** Pop the most recent undoable entry, apply its inverse silently,
 *  flip the row to 'undone'. On drift (the target row no longer
 *  exists, an FK constraint fails because a parent was deleted by
 *  some out-of-band path, etc.) the bad entry is dropped from the
 *  log and the call returns `{applied: false}` - no throw, no
 *  console spam. The error is captured for the caller as `failed`
 *  so the renderer can surface a "couldn't undo" hint if it wants
 *  to; today the UI treats it as a silent no-op.
 *
 *  `scopeBoardId` (ADR-0036 revision) - when present, only entries
 *  whose `board_id` matches are eligible. The renderer passes the
 *  currently-open board id so Ctrl+Z on board A never silently edits
 *  board B. From home / settings the renderer omits the scope and
 *  the most-recent entry across all boards is used (and the result's
 *  `boardId` drives an auto-navigate so the user sees the change). */
export function undoOne(
  db: Db,
  scopeBoardId?: string | null
): UndoApplyResult {
  const row = db
    .select()
    .from(undoLog)
    .where(
      scopeBoardId
        ? and(
            eq(undoLog.status, 'undoable'),
            eq(undoLog.boardId, scopeBoardId)
          )
        : eq(undoLog.status, 'undoable')
    )
    // `createdAt` is epoch ms, so bulk gestures (multi-select complete,
    // multi-card drag) record several entries in the SAME millisecond -
    // ordering by createdAt alone leaves the pop order to the query
    // plan (it happened to work via index rowid order, but that's not
    // contractual). `id` is UUIDv7 minted by the `uuid` package, which
    // is monotonic within a process, so it's a true insertion-order
    // tiebreaker.
    .orderBy(desc(undoLog.createdAt), desc(undoLog.id))
    .limit(1)
    .get()
  if (!row) {
    log('undo: nothing to undo')
    return { applied: false, boardId: null }
  }
  // Expand a bulk-gesture group to its full set (newest-first, so the
  // inverses replay in reverse application order). Bulk gestures are
  // single-board today (multi-select lives inside one board), so the
  // scope filter above can't split a group.
  const rows = row.groupId
    ? db
        .select()
        .from(undoLog)
        .where(
          and(
            eq(undoLog.status, 'undoable'),
            eq(undoLog.groupId, row.groupId)
          )
        )
        .orderBy(desc(undoLog.createdAt), desc(undoLog.id))
        .all()
    : [row]
  const forwardForLog = row.forward as Mutation
  const inverse = row.inverse as Mutation
  log(
    `undo [${forwardForLog.type} → ${inverse.type}]`,
    row.description,
    rows.length > 1 ? `· group of ${rows.length}` : '',
    '· entity=' + shortId(entityIdOf(forwardForLog)),
    '· board=' + shortId(row.boardId)
  )
  // Track which entry blew up so drift cleanup drops THAT one, not
  // just the group head.
  let current = row
  try {
    return db.transaction((tx) => {
      const txDb = tx as unknown as Db
      let boardId: string | null = null
      for (const r of rows) {
        current = r
        const result = applyMutationRecorded(txDb, r.inverse as Mutation, {
          silent: true
        })
        boardId = result.boardId ?? r.boardId
        tx.update(undoLog)
          .set({ status: 'undone' })
          .where(eq(undoLog.id, r.id))
          .run()
      }
      return { applied: true, boardId }
    })
  } catch (err) {
    // The cleanup HAS to happen outside the failed transaction -
    // any DELETE inside would be rolled back along with the failed
    // mutation, and the next undo would hit the same bad entry
    // forever (the FK-spam bug reported in dogfooding). For a group,
    // only the entry that failed is dropped; the survivors stay
    // undoable and the next Ctrl+Z retries them.
    warn(
      'undo drift - dropping entry',
      shortId(current.id),
      '·',
      current.description,
      '·',
      err instanceof Error ? err.message : String(err)
    )
    db.delete(undoLog).where(eq(undoLog.id, current.id)).run()
    return { applied: false, boardId: null }
  }
}

/** Pop the most recently undone entry, re-apply its forward mutation,
 *  flip it back to 'undoable'. Same silent-failure-then-drop pattern
 *  as `undoOne` - see its docstring.
 *
 *  Ordering note: undo always pops the most-recent undoable, so the
 *  flip order in the log is *opposite* to createdAt order. Among
 *  status='undone' rows the most-recently-undone is therefore the
 *  one with the SMALLEST createdAt → `asc(createdAt)`. (Easy to flip
 *  to desc and silently regress redo to LIFO-by-createdAt, which
 *  rewinds the user's intent.) */
export function redoOne(
  db: Db,
  scopeBoardId?: string | null
): UndoApplyResult {
  const row = db
    .select()
    .from(undoLog)
    .where(
      scopeBoardId
        ? and(
            eq(undoLog.status, 'undone'),
            eq(undoLog.boardId, scopeBoardId)
          )
        : eq(undoLog.status, 'undone')
    )
    // Same-millisecond tiebreak as undoOne, mirrored for the redo
    // direction (asc createdAt → asc id).
    .orderBy(asc(undoLog.createdAt), asc(undoLog.id))
    .limit(1)
    .get()
  if (!row) {
    log('redo: nothing to redo')
    return { applied: false, boardId: null }
  }
  // Expand a bulk-gesture group (oldest-first - forwards replay in
  // original application order). Mirrors undoOne.
  const rows = row.groupId
    ? db
        .select()
        .from(undoLog)
        .where(
          and(eq(undoLog.status, 'undone'), eq(undoLog.groupId, row.groupId))
        )
        .orderBy(asc(undoLog.createdAt), asc(undoLog.id))
        .all()
    : [row]
  const forward = row.forward as Mutation
  log(
    `redo [${forward.type}]`,
    row.description,
    rows.length > 1 ? `· group of ${rows.length}` : '',
    '· entity=' + shortId(entityIdOf(forward)),
    '· board=' + shortId(row.boardId)
  )
  let current = row
  try {
    return db.transaction((tx) => {
      const txDb = tx as unknown as Db
      let boardId: string | null = null
      for (const r of rows) {
        current = r
        const result = applyMutationRecorded(txDb, r.forward as Mutation, {
          silent: true
        })
        boardId = result.boardId ?? r.boardId
        tx.update(undoLog)
          .set({ status: 'undoable' })
          .where(eq(undoLog.id, r.id))
          .run()
      }
      return { applied: true, boardId }
    })
  } catch (err) {
    warn(
      'redo drift - dropping entry',
      shortId(current.id),
      '·',
      current.description,
      '·',
      err instanceof Error ? err.message : String(err)
    )
    db.delete(undoLog).where(eq(undoLog.id, current.id)).run()
    return { applied: false, boardId: null }
  }
}

/** Wipe the entire undo log - used after a full import (the entire
 *  DB was just replaced; references in the log are dangling). */
export function clearUndoLog(db: Db): void {
  db.delete(undoLog).run()
}
