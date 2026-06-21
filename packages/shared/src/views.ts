import { z } from 'zod'

// Read-side DTOs + the typed IPC contract, shared by main, preload, the
// renderer, and (later) MCP. zod is the single source of truth: the
// inferred types flow to TS, and main validates at the IPC boundary.
// This is the minimal read path for M0; CRUD/write schemas land in M1.

export const zLabelView = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string()
})
export type LabelView = z.infer<typeof zLabelView>

export const zAttachmentView = z.object({
  id: z.string(),
  filename: z.string(),
  /** Relative to Electron userData (e.g. `attachments/<id>/<filename>`). */
  relPath: z.string(),
  mime: z.string().nullable(),
  size: z.number().nullable(),
  /** Provenance for URL-sourced covers (ADR-0023, M4-H). Both null
   *  for normal local-file attachments. */
  sourceUrl: z.string().nullable(),
  sourceTitle: z.string().nullable(),
  createdAt: z.number()
})
export type AttachmentView = z.infer<typeof zAttachmentView>

/** Request payload for the `attachment:add` IPC channel (file dialog). */
export const zAttachmentAddRequest = z.object({ cardId: z.string() })
export type AttachmentAddRequest = z.infer<typeof zAttachmentAddRequest>

/** Request payload for `attachment:pasteImage` (clipboard image paste). */
export const zAttachmentPasteRequest = z.object({ cardId: z.string() })
export type AttachmentPasteRequest = z.infer<typeof zAttachmentPasteRequest>

/** Request payload for `board:setBackgroundImage` (ADR-0034). Opens
 *  a file dialog in main, copies the chosen image under
 *  `userData/board-backgrounds/<boardId>/`, then applies the
 *  corresponding `board.update` mutation. */
export const zBoardSetBackgroundImageRequest = z.object({
  boardId: z.string()
})
export type BoardSetBackgroundImageRequest = z.infer<
  typeof zBoardSetBackgroundImageRequest
>

/** ADR-0036 · server-side undo/redo status. `canUndo` / `canRedo`
 *  drive the menu / shortcut UX; the descriptions are short labels
 *  ("Move card 'Reply to PR'") for future tooltip hints. */
export const zUndoStatus = z.object({
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  undoDescription: z.string().nullable(),
  redoDescription: z.string().nullable()
})
export type UndoStatus = z.infer<typeof zUndoStatus>

/** Sent to `undo:apply` / `redo:apply`. The renderer passes the
 *  currently-open board id as `scopeBoardId` so Ctrl+Z on board A
 *  never silently edits board B (ADR-0036 revision). From home /
 *  settings the field is omitted and any board's entries are
 *  eligible - the result's `boardId` drives an auto-navigate so the
 *  user sees the change. */
export const zUndoApplyRequest = z.object({
  scopeBoardId: z.string().nullable().optional()
})
export type UndoApplyRequest = z.infer<typeof zUndoApplyRequest>

/** Returned by `undo:apply` / `redo:apply`. `applied:false` = nothing
 *  to undo/redo (handler stayed a no-op); otherwise carries the
 *  affected boardId so the renderer can navigate / refetch. */
export const zUndoApplyResult = z.object({
  applied: z.boolean(),
  boardId: z.string().nullable()
})
export type UndoApplyResult = z.infer<typeof zUndoApplyResult>

/** Request payload for the `linkPreview:create` IPC channel
 *  (ADR-0023). The renderer is responsible for gating the call on
 *  `settings.linkPreviews`. */
export const zLinkPreviewRequest = z.object({
  cardId: z.string(),
  url: z.string().min(1).max(2048)
})
export type LinkPreviewRequest = z.infer<typeof zLinkPreviewRequest>

/** Discriminated link-preview response. The IPC handler always
 *  resolves - `{ ok: false }` carries the user-facing message for
 *  the expected misses (no preview image, 404, content-type
 *  rejected, etc.) so Electron's default `ipcMain.handle` error log
 *  doesn't fire for what's really just "page had no cover." Auto-
 *  cover ignores the failure silently; the manual URL-cover modal
 *  surfaces `error` as the modal's red banner. */
export const zLinkPreviewResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    attachmentId: z.string(),
    boardId: z.string().nullable(),
    sourceUrl: z.string(),
    sourceTitle: z.string().nullable()
  }),
  z.object({
    ok: z.literal(false),
    error: z.string()
  })
])
export type LinkPreviewResult = z.infer<typeof zLinkPreviewResult>

export const zCommentView = z.object({
  id: z.string(),
  body: z.string(),
  /** null = human user; 'ai' = AI/MCP author (DESIGN §6). */
  author: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type CommentView = z.infer<typeof zCommentView>

// Card activity log (M2-E). One row per discrete change worth showing
// in the feed (renamed, moved, labels, etc.). Detail-pane renders the
// last ~30; future MCP will surface these as AI context.
export const zActivityView = z.object({
  id: z.string(),
  /** Null if the card was deleted (the cardId FK is `set null`). */
  cardId: z.string().nullable(),
  type: z.string(),
  /** Activity-kind-specific payload; the renderer narrows per `type`. */
  data: z.unknown().nullable(),
  createdAt: z.number()
})
export type ActivityView = z.infer<typeof zActivityView>

export const zChecklistItemView = z.object({
  id: z.string(),
  text: z.string(),
  completed: z.boolean(),
  position: z.string()
})
export type ChecklistItemView = z.infer<typeof zChecklistItemView>

export const zChecklistView = z.object({
  id: z.string(),
  name: z.string(),
  position: z.string(),
  items: z.array(zChecklistItemView)
})
export type ChecklistView = z.infer<typeof zChecklistView>

/** Card priority (ADR-0037). null = unprioritised - today's default
 *  and the most common state. The four levels match Trello/Jira muscle
 *  memory; new values can ride in without a schema migration because
 *  the column is plain text + the renderer falls back to the neutral
 *  badge for anything it doesn't recognise. */
export const zCardPriority = z.enum(['low', 'medium', 'high', 'urgent'])
export type CardPriority = z.infer<typeof zCardPriority>

/** Per-board swimlane grouping mode (ADR-0037 slice 2). null = off
 *  (today's default, flat row of lists). `'priority'` = cards
 *  group into horizontal lanes by `card.priority`. Stored as
 *  plain text on `board.swimlane_mode` so future modes
 *  (`'label:<labelId>'`) can ride in without a schema migration -
 *  the renderer / read view soft-narrow unknowns to null. */
export const zSwimlaneMode = z.literal('priority')
export type SwimlaneMode = z.infer<typeof zSwimlaneMode>

export const zCardView = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  position: z.string(),
  completed: z.boolean(),
  dueAt: z.number().nullable(),
  /** Optional priority (ADR-0037); null = unprioritised. */
  priority: zCardPriority.nullable(),
  labelIds: z.array(z.string()),
  checklists: z.array(zChecklistView),
  comments: z.array(zCommentView),
  attachments: z.array(zAttachmentView),
  coverAttachmentId: z.string().nullable(),
  activities: z.array(zActivityView)
})
export type CardView = z.infer<typeof zCardView>

/** Per-list sort override (ADR-0032). null = manual (fractional-index,
 *  today's default). Any non-null mode renders cards in a computed
 *  order and the renderer freezes DnD on that list.
 *   - created-*  : by the card's global creation time
 *   - added-*    : by when the card entered THIS list (card.listAddedAt)
 *   - due-asc    : soonest due first, cards with no due date last
 *   - title-*    : alphabetical by title (case-insensitive)
 *   - priority-desc : urgent -> high -> medium -> low -> unprioritised
 *  The read side (data.ts) + the headless reader soft-narrow an
 *  unrecognised value to null, so a mode written by a newer build
 *  degrades to manual on an older one instead of throwing. */
export const zListSortMode = z.enum([
  'created-asc',
  'created-desc',
  'added-asc',
  'added-desc',
  'due-asc',
  'title-asc',
  'title-desc',
  'priority-desc'
])
export type ListSortMode = z.infer<typeof zListSortMode>

/** ADR-0041 · per-list automation that fires when a card enters the
 *  list. v1 ships two kinds - flip completed on/off - both stateless
 *  so they're idempotent (re-running the rule on an already-completed
 *  card is a no-op). Future kinds (`set-label`, `set-due`, etc.)
 *  extend the discriminated union; renderer + db both soft-narrow
 *  unknown shapes to null and skip rather than throw. */
export const zListOnEnterRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('complete') }),
  z.object({ kind: z.literal('uncomplete') })
])
export type ListOnEnterRule = z.infer<typeof zListOnEnterRule>

export const zListView = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  closed: z.boolean(),
  position: z.string(),
  /** Optional card limit: cap on card count, null = none. Enforcement
   *  (block create / block drag-in) is renderer-settings-gated. */
  wipLimit: z.number().nullable(),
  /** Sort override; null = manual. */
  sortMode: zListSortMode.nullable(),
  /** On-card-enter automation (ADR-0041); null = no automation. */
  onEnter: zListOnEnterRule.nullable(),
  cards: z.array(zCardView)
})
export type ListView = z.infer<typeof zListView>

/** Rich background painted behind the board's lists / on its home-
 *  picker card (ADR-0034). Independent of `board.color`, which still
 *  drives header + list-stripe tints regardless of the background.
 *  - `color`: free-choice solid colour (any valid CSS colour string,
 *    capped at 64 chars to keep IPC payloads small).
 *  - `gradient`: a preset key resolved by `lib/palette.ts` on the
 *    renderer to a CSS gradient string - storing the key keeps the
 *    actual palette mutable without a schema migration.
 *  - `image`: a userData-relative path under `board-backgrounds/`
 *    served via the existing `kanbini-file://` scheme. The renderer
 *    never invents this path; main writes it and pushes it back. */
export const zBoardBackground = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('color'),
    value: z.string().min(1).max(64)
  }),
  z.object({
    kind: z.literal('gradient'),
    preset: z.string().min(1).max(48)
  }),
  z.object({
    kind: z.literal('image'),
    relPath: z.string().min(1).max(256)
  })
])
export type BoardBackground = z.infer<typeof zBoardBackground>

export const zBoardView = z.object({
  project: z.object({ id: z.string(), name: z.string() }),
  // `color` (M4-G+) lets the board-view header echo the home-picker
  // card's accent - same hue throughout the app once you pick one.
  // `background` (ADR-0034) is the optional rich back-plate painted
  // behind the lists (color / gradient / image); independent of
  // `color` so the header tint keeps working over any background.
  board: z.object({
    id: z.string(),
    name: z.string(),
    color: z.string().nullable(),
    background: zBoardBackground.nullable(),
    /** ADR-0037 slice 2: null = flat row of lists; 'priority' =
     *  swimlane layout grouped by card.priority. */
    swimlaneMode: zSwimlaneMode.nullable()
  }),
  labels: z.array(zLabelView),
  lists: z.array(zListView)
})
export type BoardView = z.infer<typeof zBoardView>

/** Home-picker summary (M4-G): one row per board across the whole DB.
 *  `updatedAt` blends the board's own stamp with the most recent
 *  activity-log entry for it, so the picker can sort by real recency.
 *  `color` and `pinned` were added in M4-G+ for the recolour / favourite
 *  surface. */
export const zBoardSummary = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  /** ADR-0034: rich background painted on the home-picker card. null
   *  = use `color` accent only (today's default). */
  background: zBoardBackground.nullable(),
  archived: z.boolean(),
  pinned: z.boolean(),
  position: z.string(),
  listCount: z.number().int().nonnegative(),
  cardCount: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type BoardSummary = z.infer<typeof zBoardSummary>

export const zBoardsListView = z.array(zBoardSummary)
export type BoardsListView = z.infer<typeof zBoardsListView>

/** `board:getView` request payload. */
export const zGetBoardViewRequest = z.object({
  boardId: z.string().optional()
})
export type GetBoardViewRequest = z.infer<typeof zGetBoardViewRequest>

/** MCP control channel: fetch one card by id. */
export const zGetCardViewRequest = z.object({ id: z.string() })
export type GetCardViewRequest = z.infer<typeof zGetCardViewRequest>

/** Global card-search request (M4-D). Empty query → empty results
 *  (the renderer skips the IPC entirely; this guard is belt-and-braces). */
export const zSearchCardsRequest = z.object({
  query: z.string(),
  limit: z.number().int().positive().max(100).optional()
})
export type SearchCardsRequest = z.infer<typeof zSearchCardsRequest>

/** One hit in the global search result list (M4-D). Carries enough
 *  board context for the renderer to render and navigate to it without
 *  a follow-up fetch. */
export const zSearchHit = z.object({
  cardId: z.string(),
  title: z.string(),
  /** Short window around the first match - only when description matched. */
  descriptionSnippet: z.string().nullable(),
  boardId: z.string(),
  boardName: z.string(),
  listName: z.string(),
  /** Names of labels on the card that matched (may be empty). */
  matchedLabels: z.array(z.string()),
  matchKind: z.enum(['title', 'label', 'description']),
  updatedAt: z.number()
})
export type SearchHit = z.infer<typeof zSearchHit>
export const zSearchHits = z.array(zSearchHit)
export type SearchHits = z.infer<typeof zSearchHits>

/** Returned by `export:now` IPC + the on-quit auto-export (M4-A). */
export const zExportSummary = z.object({
  exportedAt: z.number(),
  destRoot: z.string(),
  formatVersion: z.number(),
  counts: z.object({
    projects: z.number(),
    boards: z.number(),
    lists: z.number(),
    cards: z.number(),
    labels: z.number(),
    cardLabels: z.number(),
    checklists: z.number(),
    checklistItems: z.number(),
    comments: z.number(),
    attachments: z.number(),
    activities: z.number()
  })
})
export type ExportSummary = z.infer<typeof zExportSummary>

/** Returned by `import:folder` IPC (M4-B). null = picker cancelled. */
export const zImportSummary = z.object({
  importedAt: z.number(),
  sourceRoot: z.string(),
  formatVersion: z.number(),
  counts: z.object({
    projects: z.number(),
    boards: z.number(),
    lists: z.number(),
    cards: z.number(),
    labels: z.number(),
    cardLabels: z.number(),
    checklists: z.number(),
    checklistItems: z.number(),
    comments: z.number(),
    attachments: z.number(),
    activities: z.number(),
    descriptionsFromMd: z.number(),
    attachmentFilesCopied: z.number()
  })
})
export type ImportSummary = z.infer<typeof zImportSummary>

/** Returned by `app:info` (M4-F). Surfaced by the Settings → About
 *  panel and used by the Data section's "Show in folder" affordances.
 *  Pure read - no writes; safe to call any time after main is ready. */
export const zAppInfo = z.object({
  version: z.string(),
  versions: z.object({
    electron: z.string(),
    chrome: z.string(),
    node: z.string()
  }),
  paths: z.object({
    userData: z.string(),
    db: z.string(),
    attachments: z.string(),
    export: z.string(),
    /** ADR-0054 · absolute path to the bundled NOTICES.md (third-party
     *  licenses). May be empty string if main couldn't locate the file
     *  (e.g. someone packaged without running `build:notices` first);
     *  the renderer renders the Settings → About row as disabled in
     *  that case. */
    notices: z.string(),
  }),
  /** Node-style platform identifier (`'win32' | 'darwin' | 'linux' | …`).
   *  Lets renderer gate platform-specific UI (e.g. Windows-only
   *  uninstall-data toggle, ADR-0049) without having to wire its own
   *  detection logic. */
  platform: z.string()
})
export type AppInfo = z.infer<typeof zAppInfo>

/** ADR-0042 · request payload for `obsidian:push`. The renderer
 *  carries the vault path + subfolder from `settings.obsidian` (not
 *  main, so main never decides where to write - keeps the trust
 *  boundary on the user's explicit choice). Subfolder is required;
 *  empty string would dump notes loose into the vault root which is
 *  almost never what the user wants. */
export const zObsidianPushRequest = z.object({
  vaultPath: z.string().min(1).max(1024),
  subfolder: z.string().min(1).max(256)
})
export type ObsidianPushRequest = z.infer<typeof zObsidianPushRequest>

/** Returned by `obsidian:push`. Counts give the Settings panel
 *  something to show. `skipped` covers two cases (vault contained a
 *  user-owned file at the target path, or a path-traversal guard
 *  rejected something); the renderer surfaces one combined number. */
export const zObsidianPushResult = z.object({
  pushedAt: z.number(),
  boardCount: z.number().int().nonnegative(),
  cardCount: z.number().int().nonnegative(),
  written: z.number().int().nonnegative(),
  /** Files at the target path that didn't carry our `kanbini.id`
   *  frontmatter - left alone for safety. */
  skippedForeign: z.number().int().nonnegative(),
  /** Per-skipped-file reasons (capped at 20 so the IPC payload
   *  stays tight; the Settings panel just shows the count + a
   *  truncated peek). */
  warnings: z.array(z.string()).max(20),
  /** Notes we own (kanbini.id frontmatter) that no longer correspond
   *  to a live card, or that moved to a new filename/board folder
   *  this push - deleted so renames/deletes stop accumulating stale
   *  copies in the vault. Foreign files are never touched. */
  pruned: z.number().int().nonnegative().default(0)
})
export type ObsidianPushResult = z.infer<typeof zObsidianPushResult>

/** Returned by `mcp:info` (M4-F). Powers the Settings → MCP panel.
 *  `channel.running` is false when main couldn't bring up the control
 *  channel (port collision, etc.); in that case `port` and `token` are
 *  null. `paths.bundle` is null when the @kanbini/mcp bundle hasn't
 *  been built yet - the snippet still renders with a placeholder so
 *  users see the shape. The snippets are formatted JSON / shell-ready
 *  strings, generated server-side so the renderer just prints them. */
export const zMcpInfo = z.object({
  channel: z.object({
    running: z.boolean(),
    port: z.number().nullable(),
    token: z.string().nullable()
  }),
  paths: z.object({
    mcpJson: z.string(),
    mcpToken: z.string(),
    bundle: z.string().nullable()
  }),
  /** The MCP config block to drop into whatever client the user
   *  hooks up. Most MCP-capable AIs accept the same shape; client-
   *  specific placement is something the user can ask their AI. */
  snippets: z.object({
    mcpClientJson: z.string()
  })
})
export type McpInfo = z.infer<typeof zMcpInfo>
