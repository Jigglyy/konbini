// IPC channel names - single source of truth. Deliberately ZERO
// imports so the sandboxed preload can import it (via the
// `@kanbini/shared/channels` subpath) without dragging zod/uuid into
// the preload bundle. Main imports it through the barrel.
export const IPC = {
  /** renderer → main: list every board (home picker, M4-G) */
  boardsList: 'boards:list',
  /** renderer → main: read a board view */
  boardGetView: 'board:getView',
  /** renderer → main: apply a mutation (discriminated union) */
  mutate: 'board:mutate',
  /** renderer → main: apply several mutations as ONE bulk gesture -
   *  a single transaction, recorded with a shared undo-log group id
   *  so one Ctrl+Z unwinds the whole gesture (multi-select complete /
   *  label / delete, multi-card drag). Returns MutationResult[]. */
  mutateBatch: 'board:mutateBatch',
  /** renderer → main: open native file dialog, copy file into
   *  userData/attachments, insert row, return the new AttachmentView
   *  (null if the user cancelled). */
  attachmentAdd: 'attachment:add',
  /** renderer → main: attach the image currently on the system clipboard
   *  to a card (Ctrl/Cmd+V while a card is open). Main reads the clipboard
   *  image directly, writes it as a PNG under userData/attachments, and
   *  inserts an attachment row. Returns the new AttachmentView, or null
   *  when the clipboard holds no image (a plain text paste). */
  attachmentPasteImage: 'attachment:pasteImage',
  /** renderer → main: fetch OG metadata + preview image from a URL,
   *  copy the image into userData/attachments, insert an attachment
   *  row (sourceUrl/sourceTitle set), then make it the card's cover.
   *  ADR-0023 - fires only when settings.linkPreviews is on; renderer
   *  gates the call. Returns the new attachment summary. */
  linkPreviewCreate: 'linkPreview:create',
  /** renderer → main: write a plain-text snapshot of the whole DB +
   *  attachments to `userData/export/` (M4-A). Returns ExportSummary. */
  exportNow: 'export:now',
  /** renderer → main: open a folder picker, then restore the DB from
   *  the chosen export folder (M4-B). Wipes all local data. Returns
   *  ImportSummary, or null if the user cancelled the picker. */
  importFolder: 'import:folder',
  /** renderer → main: open a `.json` file picker, then import the
   *  chosen Trello board export as a NEW board (additive - does not
   *  wipe existing data, unlike importFolder). Returns
   *  TrelloImportSummary, or null if the user cancelled the picker. */
  importTrello: 'import:trello',
  /** renderer → main: open an image file picker, copy the chosen file
   *  into `userData/board-backgrounds/<boardId>/`, then apply a
   *  `board.update` setting the board's `background` to point at the
   *  new relPath. Returns the resolved BoardBackground (or null if
   *  the user cancelled the picker). ADR-0034. */
  boardSetBackgroundImage: 'board:setBackgroundImage',
  /** renderer → main: global card search (M4-D). Returns an array
   *  of SearchHit (capped); empty query short-circuits to []. */
  searchCards: 'search:cards',
  /** renderer → main: app version + paths for Settings → About. */
  appInfo: 'app:info',
  /** renderer → main: MCP control-channel status + paths + copy-paste
   *  config snippets for Settings → MCP (M4-F). Includes the bearer
   *  token (renderer is the user's own UI - same trust domain as the
   *  `mcp-token` file mode 0o600). */
  mcpInfo: 'mcp:info',
  /** ADR-0036 server-side undo/redo log. `status` is read-only (the
   *  renderer polls it via TanStack Query + refetches on `changed`
   *  events). `undoApply` pops the most recent undoable entry and
   *  applies its inverse; `redoApply` re-applies the most recent
   *  undone entry. Both broadcast `changed` so renderers refetch
   *  the affected board view. */
  undoStatus: 'undo:status',
  undoApply: 'undo:apply',
  redoApply: 'redo:apply',
  /** ADR-0036 revision · nuke the entire undo log. Settings → Data
   *  exposes this as a "Clear undo history" button; the user reaches
   *  for it when stale entries from past sessions cause surprising
   *  redo behaviour (e.g. phantom items from orphaned create entries
   *  whose matching deletes were pruned out under the cap). Resolves
   *  to the post-clear UndoStatus so the renderer can immediately
   *  reflect the empty state. */
  undoClear: 'undo:clear',
  /** Templates (ADR-0038). Save snapshots a board or list into the
   *  `template` table; list/get fetch summaries / full payloads for
   *  picker + manager UIs; rename/delete are direct DB ops; instantiate
   *  replays a snapshot into real entities with fresh UUIDv7 ids. */
  templateSave: 'template:save',
  templateList: 'template:list',
  templateRename: 'template:rename',
  templateDelete: 'template:delete',
  templateInstantiate: 'template:instantiate',
  /** Obsidian one-way push (ADR-0042). Opens a folder picker for the
   *  vault path (`obsidian:pickVault`) and pushes every card as a
   *  Markdown note with YAML frontmatter under
   *  `<vaultPath>/<subfolder>/<board>/<title>.md` (`obsidian:push`).
   *  Both opt-in: renderer gates the call on `settings.obsidian.enabled`
   *  before invoking. Vault content is never read back - strictly
   *  push, never sync. */
  obsidianPickVault: 'obsidian:pickVault',
  obsidianPush: 'obsidian:push',
  /** M5-B · ADR-0049 · persist the "Remove my data on uninstall"
   *  toggle to a location the Windows NSIS uninstaller can read AFTER
   *  the program folder is gone. Windows: writes 0/1 to
   *  `HKCU\Software\Kanbini\RemoveDataOnUninstall` via reg.exe. Mac
   *  and Linux: silent no-op (NSIS only runs on Windows). Renderer
   *  calls this on every toggle change AND once on Settings mount so
   *  the registry stays in sync if it ever drifts from the
   *  localStorage value (e.g. user nuked the registry key by hand). */
  uninstallSetRemoveDataOnUninstall: 'uninstall:setRemoveDataOnUninstall',
  /** ADR-0054 · open the bundled NOTICES.md (third-party licenses)
   *  with the user's default markdown / text handler. Settings →
   *  About hosts the trigger. Returns the error message string from
   *  `shell.openPath` (empty string on success); the renderer can
   *  surface non-empty results as a fallback. */
  noticesOpen: 'notices:open',
  /** main → renderer: something changed, refetch */
  changed: 'board:changed'
} as const
