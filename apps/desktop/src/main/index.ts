import { spawnSync } from 'node:child_process'
import * as fsSync from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as nodePath from 'node:path'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
  shell,
  type WebContents
} from 'electron'
import {
  APP_CODENAME,
  IPC,
  newId,
  zAppInfo,
  zAttachmentAddRequest,
  zAttachmentPasteRequest,
  zAttachmentView,
  zBoardBackground,
  zBoardSetBackgroundImageRequest,
  zBoardsListView,
  zBoardView,
  zExportSummary,
  zGetBoardViewRequest,
  zImportSummary,
  zLinkPreviewRequest,
  zLinkPreviewResult,
  zMcpInfo,
  zMutation,
  zMutationBatch,
  zMutationResult,
  zMutationResults,
  zObsidianPushRequest,
  zObsidianPushResult,
  zSearchCardsRequest,
  zSearchHits,
  zTemplateDeleteRequest,
  zTemplateInstantiateRequest,
  zTemplateInstantiateResult,
  zTemplateRenameRequest,
  zTemplateSaveRequest,
  zTemplateSummaryList,
  zTrelloBoard,
  zTrelloImportSummary,
  zUndoApplyRequest,
  zUndoApplyResult,
  zUndoStatus
} from '@kanbini/shared'
import {
  type Db,
  applyMutationRecorded,
  applyMutationsRecorded,
  clearUndoLog,
  createAttachment,
  dbInfo,
  deleteTemplate,
  exportToFolder,
  getAttachmentRelPath,
  getBoardView,
  importFromFolder,
  importFromTrello,
  instantiateBoardTemplate,
  instantiateListTemplate,
  listBoards,
  listTemplates,
  openDatabase,
  redoOne,
  renameTemplate,
  saveBoardTemplate,
  saveListTemplate,
  searchCards,
  seedSampleData,
  undoOne,
  undoStatus
} from '@kanbini/db'
import {
  startControlChannel,
  type ControlChannelHandle
} from './control-channel'
import { sweepOrphanedFiles } from './gc'
import { createLinkPreviewAttachment } from './link-preview'
import { pushToObsidianVault } from './obsidian-push'
import { runRoundTripTest } from './round-trip'
import { attachWindowState, loadWindowState } from './window-state'

// Custom scheme so the renderer can fetch attachment files safely (no
// file:// in the page, no path traversal - the handler clamps to
// userData/attachments). MUST be registered before app.ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kanbini-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // Without corsEnabled Chromium silently blocks <img> loads from
      // a custom scheme when the page origin is anything else
      // (e.g. the Vite dev server at http://localhost:5173).
      corsEnabled: true,
      stream: true
    }
  }
])

/** Minimal extension → MIME map (no extra dep). Returns null for unknown. */
function mimeOf(filename: string): string | null {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'avif':
      return 'image/avif'
    case 'bmp':
      return 'image/bmp'
    case 'ico':
      return 'image/x-icon'
    case 'svg':
      return 'image/svg+xml'
    case 'pdf':
      return 'application/pdf'
    case 'txt':
      return 'text/plain'
    case 'md':
      return 'text/markdown'
    case 'json':
      return 'application/json'
    default:
      return null
  }
}

// DESIGN §4/§5: hardened shell; main is the single SQLite writer and
// the only path to data (renderer reaches it via the typed IPC bridge).

app.setName(APP_CODENAME) // → userData = …/Kanbini

// E2E test isolation (apps/desktop-e2e). The Playwright launcher
// passes a temp directory here so each test runs against a fresh
// userData (own SQLite, own attachments, own mcp.json) without
// touching the user's real data. Symmetric with KANBINI_USERDATA_-
// OVERRIDE in apps/mcp/src/index.ts. Honoured ONLY before
// app.whenReady, which is fine - this runs at module-load time.
{
  const override = process.env['KANBINI_USERDATA_OVERRIDE']
  if (override) app.setPath('userData', override)
}

/** E2E test escape hatch: wrap dialog.showOpenDialog so Playwright
 *  specs can short-circuit native dialogs with a fixed path. Native
 *  dialogs are OS-driven + can't be driven by Playwright. Honoured
 *  ONLY when the relevant env var is set; production never hits
 *  these branches. `openDirectory` dialogs read KANBINI_E2E_DIALOG_DIR;
 *  every other shape (openFile, multi-select) reads
 *  KANBINI_E2E_DIALOG_FILE. Tests set the env var per-launch so
 *  exactly the dialog they care about returns a known path. */
async function showOpenDialogE2E(
  win: BrowserWindow | null,
  opts: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  const wantsDir = opts.properties?.includes('openDirectory')
  const envKey = wantsDir
    ? 'KANBINI_E2E_DIALOG_DIR'
    : 'KANBINI_E2E_DIALOG_FILE'
  const override = process.env[envKey]
  if (override) {
    return { canceled: false, filePaths: [override] }
  }
  return win
    ? dialog.showOpenDialog(win, opts)
    : dialog.showOpenDialog(opts)
}

const isDev = !app.isPackaged

/** One-time rename migration (codename Konbini → product name Kanbini,
 *  2026-05-21). If a previous build wrote data to `<appData>/Konbini/`
 *  and the new `<appData>/Kanbini/` directory doesn't exist yet, move
 *  the whole tree across - attachments, mcp.json + mcp-token, export
 *  folder - then rename the legacy `konbini.sqlite` (+ WAL/SHM
 *  siblings) to the new `kanbini.sqlite` name. Idempotent: each step
 *  no-ops once the destination exists. Synchronous on purpose:
 *  nothing depends on userData before this runs, and we want it
 *  complete before openDatabase resolves the path. */
function migrateUserDataDirRename(newDir: string): void {
  const legacy = nodePath.join(nodePath.dirname(newDir), 'Konbini')
  if (!fsSync.existsSync(newDir) && fsSync.existsSync(legacy)) {
    try {
      fsSync.renameSync(legacy, newDir)
      console.log(`[main] renamed legacy data dir: ${legacy} → ${newDir}`)
    } catch (err) {
      console.error(
        `[main] failed to rename legacy data dir ${legacy} → ${newDir}:`,
        err
      )
      return
    }
  }
  // Inside the (possibly just-renamed) dir, rename the SQLite file
  // and its WAL/SHM siblings: konbini.sqlite → kanbini.sqlite.
  for (const suffix of ['', '-wal', '-shm']) {
    const oldDb = nodePath.join(newDir, `konbini.sqlite${suffix}`)
    const newDb = nodePath.join(newDir, `kanbini.sqlite${suffix}`)
    if (fsSync.existsSync(oldDb) && !fsSync.existsSync(newDb)) {
      try {
        fsSync.renameSync(oldDb, newDb)
        console.log(`[main] renamed legacy db file: ${oldDb} → ${newDb}`)
      } catch (err) {
        console.error(
          `[main] failed to rename legacy db file ${oldDb}:`,
          err
        )
      }
    }
  }
}

// Migrations are generated into packages/db/drizzle (committed). In dev
// the built main runs from apps/desktop/out/main, so walk back to the
// repo. Packaged builds get the folder copied into resources (M5).
const migrationsFolder = isDev
  ? join(__dirname, '../../../../packages/db/drizzle')
  : join(process.resourcesPath, 'drizzle')

// ADR-0054 · third-party NOTICES.md. Generated at repo root by
// `pnpm --filter @kanbini/desktop run build:notices` + committed;
// shipped under <resources>/NOTICES.md via electron-builder
// extraResources. Empty string if neither location exists so the
// Settings → About row can render disabled instead of throwing.
function resolveNoticesPath(): string {
  const candidates = isDev
    ? [join(__dirname, '../../../../NOTICES.md')]
    : [join(process.resourcesPath, 'NOTICES.md')]
  for (const c of candidates) {
    try {
      if (fsSync.existsSync(c)) return c
    } catch {
      /* permission glitch - treat as missing */
    }
  }
  return ''
}
const noticesPath = resolveNoticesPath()

function applyCsp(): void {
  // `kanbini-file:` is allowed for img/connect so attachment thumbnails
  // + previews can load via the custom protocol (handler is sandboxed
  // to userData/attachments - see registerAttachmentProtocol).
  const policy = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: kanbini-file:; font-src 'self' data:; connect-src 'self' ws: http://localhost:* kanbini-file:"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: kanbini-file:; font-src 'self' data:; connect-src 'self' kanbini-file:"

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}

/** Push a coarse change event to every window so renderers refetch. */
function broadcastChange(boardId: string | null): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.changed, { boardId })
  }
}

/** Map a kanbini-file:// URL to a path inside one of the explicit
 *  allowlisted userData roots (attachments, board-backgrounds) and
 *  serve the file. Anything resolving outside both roots is rejected
 *  - keeps path traversal locked down while letting ADR-0034 board
 *  backgrounds reuse the same scheme. */
function registerAttachmentProtocol(
  attachmentsRoot: string,
  backgroundsRoot: string
): void {
  const allowedRoots = [attachmentsRoot, backgroundsRoot]
  protocol.handle('kanbini-file', async (req) => {
    try {
      const url = new URL(req.url)
      // With `standard: true`, Chromium canonicalises
      // `kanbini-file:///attachments/<id>/<file>` into
      // `kanbini-file://attachments/<id>/<file>` - the first path
      // segment becomes the URL host. Combine both so we recover the
      // intended relative path regardless of which form arrived.
      const combined = `${url.host}${url.pathname}`
      const rel = decodeURIComponent(combined).replace(/^\/+/, '')
      const abs = resolve(app.getPath('userData'), rel)
      const ok = allowedRoots.some(
        (root) => abs === root || abs.startsWith(root + sep)
      )
      if (!ok) {
        return new Response('Forbidden', { status: 403 })
      }
      const data = await fsp.readFile(abs)
      const mime = mimeOf(abs) ?? 'application/octet-stream'
      return new Response(new Uint8Array(data), {
        headers: { 'Content-Type': mime }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/** Resolve the absolute path to the built MCP server bundle, if it
 *  exists on disk. In dev the bundle lives at
 *  `<repo>/apps/mcp/dist/index.js` (from `pnpm --filter @kanbini/mcp
 *  run build`); the dev main script runs from
 *  `<repo>/apps/desktop/out/main/index.js`, so walk up four levels.
 *  Packaged builds (post-M5) will copy the bundle into resources -
 *  surface that path too. Returns null if neither exists yet, so the
 *  Settings → MCP snippet can render with a `<path-to-bundle>`
 *  placeholder instead of pretending. */
function resolveMcpBundlePath(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'mcp', 'index.js')]
    : [resolve(__dirname, '../../../../apps/mcp/dist/index.js')]
  for (const c of candidates) {
    try {
      if (fsSync.existsSync(c)) return c
    } catch {
      /* permission glitch - treat as missing */
    }
  }
  return null
}

/** Build the MCP config snippet the user pastes into whatever client
 *  they hook up. Most MCP-capable AIs accept the same `{ mcpServers:
 *  { <name>: { command, args } } }` shape (Claude Desktop, Claude
 *  Code, etc.) - where exactly to drop it is client-specific, so the
 *  UI defers that detail to the user's AI. `bundle` may be null (not
 *  built yet); fall back to a placeholder so the shape is still
 *  copyable. */
function buildMcpClientSnippet(bundle: string | null): string {
  const args = [bundle ?? '<absolute path to apps/mcp/dist/index.js>']
  return JSON.stringify(
    {
      mcpServers: {
        kanbini: { command: 'node', args }
      }
    },
    null,
    2
  )
}

function registerIpc(
  db: Db,
  userDataDir: string,
  attachmentsRoot: string,
  backgroundsRoot: string,
  exportRoot: string,
  getControlChannel: () => ControlChannelHandle | null
): void {
  // Validate request + response at the boundary so the shared zod
  // schema is the contract both sides trust (DESIGN §5 single-writer).
  ipcMain.handle(IPC.boardsList, () => {
    return zBoardsListView.parse(listBoards(db))
  })

  ipcMain.handle(IPC.boardGetView, (_event, raw: unknown) => {
    const { boardId } = zGetBoardViewRequest.parse(raw ?? {})
    return zBoardView.nullable().parse(getBoardView(db, boardId))
  })

  ipcMain.handle(IPC.searchCards, (_event, raw: unknown) => {
    const { query, limit } = zSearchCardsRequest.parse(raw ?? {})
    return zSearchHits.parse(searchCards(db, query, limit))
  })

  ipcMain.handle(IPC.mutate, async (_event, raw: unknown) => {
    const mutation = zMutation.parse(raw)
    // attachment.delete: look up the file path BEFORE deletion (DB
    // owns the row, main owns the filesystem) so we can unlink it.
    let toUnlink: string | null = null
    if (mutation.type === 'attachment.delete') {
      const rel = getAttachmentRelPath(db, mutation.id)
      if (rel) {
        const abs = resolve(app.getPath('userData'), rel)
        if (abs.startsWith(attachmentsRoot + sep)) toUnlink = abs
      }
    }
    // ADR-0036: route through the undo-log recorder so every mutation
    // lands on the stack (renderer-issued or MCP-issued). `restore`
    // is internal-only - see the comment in @kanbini/db/src/undo.ts.
    const result = zMutationResult.parse(applyMutationRecorded(db, mutation))
    if (toUnlink) {
      try {
        await fsp.unlink(toUnlink)
      } catch {
        /* file may have been removed already */
      }
      try {
        await fsp.rmdir(dirname(toUnlink))
      } catch {
        /* dir not empty / already gone - fine */
      }
    }
    broadcastChange(result.boardId)
    return result
  })

  // Bulk gesture: several mutations in ONE transaction, recorded as
  // one undo-log group so a single Ctrl+Z unwinds the whole thing
  // (multi-select complete / label / delete, multi-card drag).
  // attachment.delete is excluded - its file unlink needs the per-
  // mutation pre-read above, and no bulk surface issues it today.
  ipcMain.handle(IPC.mutateBatch, (_event, raw: unknown) => {
    const mutations = zMutationBatch.parse(raw)
    for (const m of mutations) {
      if (m.type === 'restore' || m.type === 'attachment.delete') {
        throw new Error(`${m.type} not allowed in a mutation batch`)
      }
    }
    const results = zMutationResults.parse(
      applyMutationsRecorded(db, mutations)
    )
    // One broadcast per distinct board - bulk surfaces are
    // single-board today, so this is one event in practice.
    const boards = new Set(results.map((r) => r.boardId))
    for (const boardId of boards) broadcastChange(boardId)
    return results
  })

  ipcMain.handle(IPC.attachmentAdd, async (event, raw: unknown) => {
    const { cardId } = zAttachmentAddRequest.parse(raw)
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      title: 'Add attachment'
    }
    const res = await showOpenDialogE2E(win, opts)
    if (res.canceled || res.filePaths.length === 0) return null
    const src = res.filePaths[0]!

    const id = newId()
    const filename = basename(src)
    const destDir = join(attachmentsRoot, id)
    await fsp.mkdir(destDir, { recursive: true })
    const dest = join(destDir, filename)
    await fsp.copyFile(src, dest)
    const stat = await fsp.stat(dest)
    const mime = mimeOf(filename)
    const relPath = `attachments/${id}/${filename}`

    const { boardId } = createAttachment(db, {
      id,
      cardId,
      filename,
      relPath,
      mime,
      size: stat.size
    })
    broadcastChange(boardId)
    return zAttachmentView.parse({
      id,
      filename,
      relPath,
      mime,
      size: stat.size,
      sourceUrl: null,
      sourceTitle: null,
      createdAt: Date.now()
    })
  })

  // Paste an image from the system clipboard onto a card (Ctrl/Cmd+V
  // while a card is open). Unlike attachmentAdd there's no dialog: main
  // reads the clipboard image directly, so we work regardless of which
  // field (if any) has focus in the renderer. Returns null on a non-image
  // paste so the renderer can fire this on every Ctrl+V cheaply and let a
  // plain text paste fall through untouched.
  ipcMain.handle(IPC.attachmentPasteImage, async (_event, raw: unknown) => {
    const { cardId } = zAttachmentPasteRequest.parse(raw)
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    // Normalise to PNG - lossless and what the clipboard hands back for a
    // screenshot anyway.
    const png = image.toPNG()
    if (png.length === 0) return null

    const id = newId()
    const filename = `pasted-${Date.now()}.png`
    const destDir = join(attachmentsRoot, id)
    await fsp.mkdir(destDir, { recursive: true })
    const dest = join(destDir, filename)
    await fsp.writeFile(dest, png)
    const relPath = `attachments/${id}/${filename}`
    const mime = 'image/png'

    const { boardId } = createAttachment(db, {
      id,
      cardId,
      filename,
      relPath,
      mime,
      size: png.length
    })
    broadcastChange(boardId)
    return zAttachmentView.parse({
      id,
      filename,
      relPath,
      mime,
      size: png.length,
      sourceUrl: null,
      sourceTitle: null,
      createdAt: Date.now()
    })
  })

  // ADR-0034 · set a board background from an image file. Opens the
  // native picker (image MIME filter), copies the chosen file into
  // `userData/board-backgrounds/<boardId>/<newId>.<ext>`, applies a
  // `board.update` so the row points at it, deletes the previous
  // image-kind background's file (if any) to keep that folder tidy.
  // Returns the resolved BoardBackground or null on cancel.
  ipcMain.handle(
    IPC.boardSetBackgroundImage,
    async (event, raw: unknown) => {
      const { boardId } = zBoardSetBackgroundImageRequest.parse(raw)
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        title: 'Pick a board background image',
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']
          }
        ]
      }
      const res = await showOpenDialogE2E(win, opts)
      if (res.canceled || res.filePaths.length === 0) return null
      const src = res.filePaths[0]!

      // Discover the current background so we can clean up the
      // previous image file (best-effort - orphans are harmless).
      const prev = listBoards(db).find((b) => b.id === boardId)?.background
      const prevImagePath =
        prev?.kind === 'image' ? prev.relPath : null

      const id = newId()
      const ext = nodePath.extname(src).toLowerCase() || '.png'
      const filename = `${id}${ext}`
      const destDir = join(backgroundsRoot, boardId)
      await fsp.mkdir(destDir, { recursive: true })
      const dest = join(destDir, filename)
      await fsp.copyFile(src, dest)
      const relPath = `board-backgrounds/${boardId}/${filename}`

      const background = zBoardBackground.parse({ kind: 'image', relPath })
      applyMutationRecorded(db, {
        type: 'board.update',
        id: boardId,
        patch: { background }
      })

      if (prevImagePath && prevImagePath !== relPath) {
        const abs = resolve(userDataDir, prevImagePath)
        // Belt + braces: confirm the path stays inside the
        // backgrounds root before unlinking.
        if (
          abs === backgroundsRoot ||
          abs.startsWith(backgroundsRoot + sep)
        ) {
          await fsp.rm(abs, { force: true }).catch(() => {})
        }
      }

      broadcastChange(boardId)
      return zBoardBackground.parse(background)
    }
  )

  // ADR-0023 link-preview fetch. Renderer is responsible for gating
  // on settings.linkPreviews - main runs unconditionally when called.
  ipcMain.handle(IPC.linkPreviewCreate, async (_event, raw: unknown) => {
    const { cardId, url } = zLinkPreviewRequest.parse(raw)
    try {
      const result = await createLinkPreviewAttachment({
        db,
        attachmentsRoot,
        cardId,
        url
      })
      broadcastChange(result.boardId)
      return zLinkPreviewResult.parse({ ok: true, ...result })
    } catch (err) {
      // Expected misses (no preview image, HTTP 404, content-type
      // rejected, byte cap, etc.) flow back as `{ok:false}` so Electron
      // doesn't log them as IPC-handler crashes. The manual modal shows
      // `error`; auto-cover ignores the failure silently.
      const message = err instanceof Error ? err.message : String(err)
      return zLinkPreviewResult.parse({ ok: false, error: message })
    }
  })

  // ADR-0036 · undo/redo log surface. `undoStatus` is the small
  // peek-only read for canUndo/canRedo + tooltip hints; the renderer
  // polls it via TanStack Query + invalidates on every `changed`
  // event. `undoApply` and `redoApply` mutate, broadcastChange so
  // every renderer refetches the affected board.
  ipcMain.handle(IPC.undoStatus, () => {
    return zUndoStatus.parse(undoStatus(db))
  })
  ipcMain.handle(IPC.undoApply, (_event, raw: unknown) => {
    const { scopeBoardId } = zUndoApplyRequest.parse(raw ?? {})
    const out = undoOne(db, scopeBoardId ?? undefined)
    if (out.applied) broadcastChange(out.boardId)
    return zUndoApplyResult.parse(out)
  })
  ipcMain.handle(IPC.redoApply, (_event, raw: unknown) => {
    const { scopeBoardId } = zUndoApplyRequest.parse(raw ?? {})
    const out = redoOne(db, scopeBoardId ?? undefined)
    if (out.applied) broadcastChange(out.boardId)
    return zUndoApplyResult.parse(out)
  })
  ipcMain.handle(IPC.undoClear, () => {
    clearUndoLog(db)
    // Re-broadcast a board-agnostic change so any "canUndo / canRedo"
    // indicators in the renderer refresh. No board view changed, so
    // the board-query invalidation is a cheap no-op.
    broadcastChange(null)
    return zUndoStatus.parse(undoStatus(db))
  })

  // M4-A manual trigger. The auto-export on quit lives in
  // `before-quit` below; this is the renderer-facing "Export now"
  // button (and the future settings screen).
  ipcMain.handle(IPC.exportNow, async () => {
    const summary = await exportToFolder(db, userDataDir, exportRoot)
    return zExportSummary.parse(summary)
  })

  // M4-B restore from a previous export. Opens a directory picker
  // first; null return = the user cancelled. The folder picker
  // doubles as the explicit confirmation step (you can't import by
  // accident - you have to navigate to and choose the folder).
  // boardId = null in the broadcast tells every renderer "you can
  // assume the whole board view changed; refetch from scratch".
  ipcMain.handle(IPC.importFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: 'Pick a Kanbini export folder to restore from'
    }
    const res = await showOpenDialogE2E(win, opts)
    if (res.canceled || res.filePaths.length === 0) return null
    const sourceRoot = res.filePaths[0]!
    const summary = await importFromFolder(db, userDataDir, sourceRoot)
    // ADR-0036: the full-folder import wipes + re-inserts everything,
    // so every id the undo log references is now (likely) dangling.
    // Drop the entire log - the user just chose "restore from
    // snapshot" anyway, undo history doesn't apply to the prior
    // state.
    clearUndoLog(db)
    broadcastChange(null)
    return zImportSummary.parse(summary)
  })

  // Import a Trello board export (.json) as a NEW board - additive,
  // never wipes (unlike importFolder). Opens a file picker; null
  // return = the user cancelled. The Trello JSON is untrusted input,
  // so zTrelloBoard validates it at the boundary before the DB layer
  // touches it; a malformed file surfaces as a thrown IPC error.
  ipcMain.handle(IPC.importTrello, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      title: 'Pick a Trello board export (.json) to import',
      filters: [{ name: 'Trello export', extensions: ['json'] }]
    }
    const res = await showOpenDialogE2E(win, opts)
    if (res.canceled || res.filePaths.length === 0) return null
    const raw = await fsp.readFile(res.filePaths[0]!, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error("That file isn't valid JSON. Pick a Trello board export.")
    }
    let trello
    try {
      trello = zTrelloBoard.parse(parsed)
    } catch {
      throw new Error(
        "That doesn't look like a Trello board export. Expected a JSON file with the board's lists and cards."
      )
    }
    const summary = importFromTrello(db, trello)
    broadcastChange(summary.boardId)
    return zTrelloImportSummary.parse(summary)
  })

  // ADR-0042 Obsidian one-way push. Two channels: pickVault opens
  // a folder picker (returns the absolute path, null on cancel);
  // push writes the current board state as Markdown notes under
  // `<vaultPath>/<subfolder>/<board>/<title>.md`. Renderer is the
  // gate - both calls require `settings.obsidian.enabled` to be on
  // before they fire. The vault path lives outside `userData`, so
  // these are the FIRST FS writes the app does outside its sandbox
  // - main validates + clamps the destination before any write.
  ipcMain.handle(IPC.obsidianPickVault, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: 'Pick your Obsidian vault folder'
    }
    const res = await showOpenDialogE2E(win, opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]!
  })
  ipcMain.handle(IPC.obsidianPush, async (_event, raw: unknown) => {
    const { vaultPath, subfolder } = zObsidianPushRequest.parse(raw)
    const result = await pushToObsidianVault({ db, vaultPath, subfolder })
    return zObsidianPushResult.parse(result)
  })

  // ADR-0038 templates. Save snapshots a board or list into the
  // `template` table; instantiate replays one back into real entities
  // with fresh UUIDv7 ids. Routes bypass the undo log on purpose -
  // template ops aren't undoable in v1 (use board.delete / list.delete
  // on the *result*, which IS undoable through the snapshot path).
  ipcMain.handle(IPC.templateSave, (_event, raw: unknown) => {
    const req = zTemplateSaveRequest.parse(raw)
    return req.kind === 'board'
      ? saveBoardTemplate(db, req.sourceId, req.name)
      : saveListTemplate(db, req.sourceId, req.name)
  })
  ipcMain.handle(IPC.templateList, () => {
    return zTemplateSummaryList.parse(listTemplates(db))
  })
  ipcMain.handle(IPC.templateRename, (_event, raw: unknown) => {
    const { id, name } = zTemplateRenameRequest.parse(raw)
    renameTemplate(db, id, name)
  })
  ipcMain.handle(IPC.templateDelete, (_event, raw: unknown) => {
    const { id } = zTemplateDeleteRequest.parse(raw)
    deleteTemplate(db, id)
  })
  ipcMain.handle(IPC.templateInstantiate, (_event, raw: unknown) => {
    const req = zTemplateInstantiateRequest.parse(raw)
    const result =
      req.kind === 'board'
        ? instantiateBoardTemplate(db, req.templateId)
        : instantiateListTemplate(db, req.templateId, req.targetBoardId)
    broadcastChange(result.boardId)
    return zTemplateInstantiateResult.parse(result)
  })

  // M4-F Settings → About. App version + the same userData/db paths
  // main already knows about, so the panel doesn't have to guess.
  const dbPath = join(userDataDir, 'kanbini.sqlite')
  ipcMain.handle(IPC.appInfo, () => {
    return zAppInfo.parse({
      version: app.getVersion(),
      versions: {
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node
      },
      paths: {
        userData: userDataDir,
        db: dbPath,
        attachments: attachmentsRoot,
        export: exportRoot,
        notices: noticesPath
      },
      platform: process.platform
    })
  })

  // ADR-0054 · open the bundled NOTICES.md with the user's default
  // markdown / text handler. `shell.openPath` returns '' on success or
  // an error message string on failure (no installed handler, missing
  // file). Returned verbatim so the Settings → About button can show
  // a fallback hint.
  ipcMain.handle(IPC.noticesOpen, async () => {
    if (!noticesPath) return 'NOTICES.md not bundled - run `pnpm --filter @kanbini/desktop run build:notices`.'
    return shell.openPath(noticesPath)
  })

  // M5-B / ADR-0049 · persist the "Remove my data on uninstall"
  // choice to HKCU so the NSIS uninstaller can read it after the
  // program folder is gone. spawnSync(reg.exe …) so we don't pull in
  // a registry npm dep (license + maintenance cost for a five-line
  // shell-out). On Mac / Linux this resolves immediately - the NSIS
  // path is Windows-only, so there's nothing to persist.
  ipcMain.handle(
    IPC.uninstallSetRemoveDataOnUninstall,
    (_e, payload: { value: boolean }) => {
      if (process.platform !== 'win32') return
      const data = payload.value ? '1' : '0'
      try {
        const r = spawnSync(
          'reg',
          [
            'add',
            'HKCU\\Software\\Kanbini',
            '/v',
            'RemoveDataOnUninstall',
            '/t',
            'REG_DWORD',
            '/d',
            data,
            '/f'
          ],
          { stdio: 'ignore' }
        )
        if (r.status !== 0) {
          // Non-fatal: surface a warning + leave the toggle UI as-is.
          // The user can flip again later or accept the default
          // (leave data) at uninstall time.
          console.warn(
            `[uninstall-toggle] reg add exited with ${r.status}; toggle didn't persist`
          )
        }
      } catch (err) {
        console.warn('[uninstall-toggle] reg.exe spawn failed:', err)
      }
    }
  )

  // M4-F Settings → MCP. The token is the same value that lives at
  // `<userData>/mcp-token` (0o600) - surfacing it in the user's own
  // UI doesn't widen the trust boundary, and beats asking them to
  // open a file to copy it. Snippets are generated server-side so the
  // bundle path resolution lives in one place.
  ipcMain.handle(IPC.mcpInfo, () => {
    const ch = getControlChannel()
    const bundle = resolveMcpBundlePath()
    return zMcpInfo.parse({
      channel: {
        running: ch !== null,
        port: ch?.port ?? null,
        token: ch?.token ?? null
      },
      paths: {
        mcpJson: join(userDataDir, 'mcp.json'),
        mcpToken: join(userDataDir, 'mcp-token'),
        bundle
      },
      snippets: {
        mcpClientJson: buildMcpClientSnippet(bundle)
      }
    })
  })
}

// Own zoom explicitly. Chromium's default menu binds zoom-in to
// `Ctrl+Plus` (= Ctrl+Shift+=), so plain `Ctrl+=` did nothing while
// `Ctrl+-` worked. We removed that menu, so handle the keys here:
// accept = / + / numpad-add for in, - for out, 0 to reset; clamped.
const ZOOM_MIN = -3
const ZOOM_MAX = 5

function attachZoom(wc: WebContents): void {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return
    const k = input.key
    let next: number | null = null
    if (k === '=' || k === '+' || k === 'Add') {
      next = Math.min(ZOOM_MAX, wc.getZoomLevel() + 1)
    } else if (k === '-' || k === 'Subtract') {
      next = Math.max(ZOOM_MIN, wc.getZoomLevel() - 1)
    } else if (k === '0') {
      next = 0
    }
    if (next !== null) {
      event.preventDefault()
      wc.setZoomLevel(next)
    }
  })
}

/** DevTools shortcuts - replaces the default-menu accelerators that
 *  Menu.setApplicationMenu(null) stripped out. F12 toggles; the more
 *  familiar Ctrl/Cmd+Shift+I also works. Useful in dev for inspecting
 *  the renderer; harmless in a single-user offline app at prod-time
 *  too (user owns their own data and DevTools doesn't grant any
 *  capability they don't already have via the file system). */
function attachDevTools(wc: WebContents): void {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const f12 = input.key === 'F12'
    const ctrlShiftI =
      (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i'
    if (f12 || ctrlShiftI) {
      event.preventDefault()
      wc.toggleDevTools()
    }
  })
}

// The primary window, for the second-instance focus handler. Cleared
// on close so a stale reference never gets focus() called on it.
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // Dev-only window icon (ADR-0051). In a packaged build the .exe
  // (Windows) / .app bundle (macOS) / .desktop entry (Linux) carry
  // the icon natively, so BrowserWindow inherits it automatically -
  // and `apps/desktop/build/` doesn't ship inside the asar anyway.
  // In `pnpm dev` Electron falls back to its default logo unless we
  // point at the build resource explicitly.
  const devIconPath = isDev
    ? join(__dirname, '../../build/icon.png')
    : undefined

  // KANBINI_E2E_HEADLESS=1 ships the window off-screen + opens it
  // via `showInactive()` so Playwright tests don't pop up + steal
  // focus from whatever the dev is doing. The launcher in
  // apps/desktop-e2e/tests/_launch.ts sets the env var by default -
  // opt out with KANBINI_E2E_HEADED=1 when you need to actually
  // watch a spec run for debugging.
  //
  // Why off-screen instead of just `show: false`: a hidden window
  // makes Chromium treat the page as background, throttling rAF +
  // timers down to ~1 Hz - the full E2E suite went from ~30 s to
  // ~6.7 min when first attempted (measured 2026-05-27). Neither
  // `webContents.setBackgroundThrottling(false)` nor the
  // `disable-background-timer-throttling` / `disable-renderer-
  // backgrounding` / `disable-backgrounding-occluded-windows`
  // command-line switches fixed it, because `document.hidden` stays
  // `true` for a `show: false` window and many web APIs key off
  // that flag regardless of throttling settings. Positioning at
  // (-30000, -30000) keeps the window genuinely visible to
  // Chromium (so `document.hidden` is false + no throttling) but
  // off every real display; `showInactive()` brings it up without
  // grabbing focus from the foreground app.
  const headlessE2E = process.env['KANBINI_E2E_HEADLESS'] === '1'
  // Restore the previous session's bounds (skipped for E2E - its
  // off-screen parking position must never persist or be restored).
  const winState = headlessE2E ? null : loadWindowState(app.getPath('userData'))
  const win = new BrowserWindow({
    width: winState?.width ?? 1280,
    height: winState?.height ?? 832,
    show: false,
    autoHideMenuBar: true,
    title: APP_CODENAME,
    backgroundColor: '#0b0b0c',
    ...(devIconPath ? { icon: devIconPath } : {}),
    ...(winState && winState.x !== undefined && winState.y !== undefined
      ? { x: winState.x, y: winState.y }
      : {}),
    ...(headlessE2E ? { x: -30000, y: -30000 } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.once('ready-to-show', () => {
    if (headlessE2E) win.showInactive()
    // maximize() implies show on every platform; calling show() after
    // a maximize would flicker the restored size for a frame.
    else if (winState?.maximized) win.maximize()
    else win.show()
  })
  if (!headlessE2E) attachWindowState(win, app.getPath('userData'))
  attachZoom(win.webContents)
  attachDevTools(win.webContents)

  win.webContents.setWindowOpenHandler(({ url }) => {
    // M4-H: covers fetched from URLs (ADR-0023) include http(s)
    // links in the card-detail surface. Both schemes allowed for
    // shell.openExternal - anything else (file:, javascript:, …)
    // is silently denied.
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// MCP control channel (M3-A). Lives at the module scope so the quit
// handler can call shutdown() - drops the listener and removes
// userData/mcp.json so the MCP server cleanly detects "app offline".
let controlChannel: ControlChannelHandle | null = null

// Captured by app.whenReady so the before-quit hook can run an
// auto-export (M4-A) before the process exits. Module-scoped so the
// handler isn't a closure over `whenReady` locals.
let dbForQuit: Db | null = null
let userDataDirForQuit: string | null = null
let exportRootForQuit: string | null = null

// `--round-trip-test` (M4-C): skip the entire app setup, run the
// export/import round-trip against an in-memory DB + temp userData,
// then exit with 0/1 so CI can gate on it.
const ROUND_TRIP_MODE = process.argv.includes('--round-trip-test')

// `--launch-smoke`: cheaper than round-trip - proves the app can
// boot through the parts that historically break silently (native
// module ABI mismatch, migration failures, control-channel listen
// errors). Opens an in-memory DB, runs migrations, opens the
// control channel, closes everything, exits 0. ~1 s. Run before
// `pnpm dev` from CI / smoke scripts so a busted ABI surfaces as a
// test failure instead of an unhandled rejection at app start.
//
// The packaged Electron binary (M5-A, ADR-0039) rejects unknown
// `--flag` args as Chromium switches before main runs, so accept
// `KANBINI_LAUNCH_SMOKE=1` env var too. Lets the same smoke check
// run against the dev bundle (`electron out/main/index.js
// --launch-smoke`) AND the packaged exe (`KANBINI_LAUNCH_SMOKE=1
// Kanbini.exe`).
const LAUNCH_SMOKE_MODE =
  process.argv.includes('--launch-smoke') ||
  process.env.KANBINI_LAUNCH_SMOKE === '1'

// Single-instance lock. Two mains on the same userData would share the
// SQLite file with NO cross-process change events (the single-writer
// architecture assumes one main), overwrite each other's mcp.json, and
// race the auto-export's .staging/.backup swap on quit - two
// simultaneous quits can destroy each other's export mid-swap. The
// lock is keyed off the userData path, so E2E launches (each with its
// own KANBINI_USERDATA_OVERRIDE temp dir) are unaffected. The headless
// test modes skip the lock entirely - they use in-memory DBs, never
// write mcp.json, and a smoke run while the real app is open should
// still report its own pass/fail rather than silently quitting.
const isPrimaryInstance =
  ROUND_TRIP_MODE || LAUNCH_SMOKE_MODE || app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
} else if (!ROUND_TRIP_MODE && !LAUNCH_SMOKE_MODE) {
  app.on('second-instance', () => {
    // Someone launched Kanbini again - surface the existing window.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

void app.whenReady().then(async () => {
  if (!isPrimaryInstance) return

  if (ROUND_TRIP_MODE) {
    const code = await runRoundTripTest(migrationsFolder)
    app.exit(code)
    return
  }

  if (LAUNCH_SMOKE_MODE) {
    try {
      // openDatabase touches the native binding (PRAGMA calls) AND
      // runs migrations, so a bad ABI or a broken migration both
      // throw here. That's the full surface area worth verifying
      // before a real dev launch.
      const { close } = openDatabase({
        filePath: ':memory:',
        migrationsFolder
      })
      close()
      console.log('[launch-smoke] OK')
      app.exit(0)
    } catch (err) {
      console.error('[launch-smoke] FAIL:', err)
      app.exit(1)
    }
    return
  }

  // Tell Windows the AppUserModelID matches the packaged appId
  // (electron-builder.yml: `appId: app.kanbini.desktop`). Without
  // this, dev launches show the taskbar entry as a generic
  // "Electron" group with the default Electron icon; the packaged
  // .exe sets it automatically via the embedded manifest. No-op on
  // non-Windows platforms. ADR-0051.
  if (process.platform === 'win32') {
    app.setAppUserModelId('app.kanbini.desktop')
  }

  // No native menu (offline single-user kanban); also removes the
  // default menu's inconsistent zoom accelerators - see attachZoom.
  Menu.setApplicationMenu(null)

  const userDataDir = app.getPath('userData')
  // Rename-from-Konbini migration before anything reads/writes inside.
  migrateUserDataDirRename(userDataDir)
  const dbPath = join(userDataDir, 'kanbini.sqlite')
  const attachmentsRoot = resolve(userDataDir, 'attachments')
  // ADR-0034 board image backgrounds live under their own root, off
  // the attachments tree so a per-card delete cascade can't touch a
  // board's wallpaper. Same kanbini-file:// scheme serves both roots.
  const backgroundsRoot = resolve(userDataDir, 'board-backgrounds')
  const exportRoot = resolve(userDataDir, 'export')
  const { db } = openDatabase({ filePath: dbPath, migrationsFolder })
  seedSampleData(db)
  registerAttachmentProtocol(attachmentsRoot, backgroundsRoot)
  registerIpc(
    db,
    userDataDir,
    attachmentsRoot,
    backgroundsRoot,
    exportRoot,
    () => controlChannel
  )
  dbForQuit = db
  userDataDirForQuit = userDataDir
  exportRootForQuit = exportRoot

  // Bring up the MCP control channel before the window so any
  // already-running MCP server sees mcp.json immediately on app start.
  // `onChange = broadcastChange` is what makes AI writes appear live
  // in the open renderer - main fires the `changed` event after every
  // mutation, the renderer invalidates the board query, board refetches.
  try {
    controlChannel = await startControlChannel({
      db,
      userDataDir,
      onChange: broadcastChange
    })
    console.log(
      `[main] MCP control channel on 127.0.0.1:${controlChannel.port}`
    )
  } catch (err) {
    console.error('[main] failed to start MCP control channel:', err)
  }

  applyCsp()
  createWindow()
  console.log(`[main] ${APP_CODENAME} ready - ${dbInfo()} @ ${dbPath}`)

  // Orphaned-file GC, well after boot so it never competes with the
  // first paint. Age-floored (1 h) so in-flight attachment writes and
  // this session's still-undoable deletes are never touched.
  setTimeout(() => {
    void sweepOrphanedFiles({ db, attachmentsRoot, backgroundsRoot })
      .then((s) => {
        if (s.removedAttachmentDirs > 0 || s.removedBackgroundEntries > 0) {
          console.log(
            `[gc] swept ${s.removedAttachmentDirs} orphaned attachment dir(s), ` +
              `${s.removedBackgroundEntries} stale background file(s)`
          )
        }
      })
      .catch((err) => console.warn('[gc] sweep failed:', err))
  }, 15_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// before-quit handler: auto-export (M4-A) → control-channel shutdown →
// app.exit(). before-quit doesn't await, so we preventDefault, run the
// async cleanup, then call app.exit(0) which bypasses the hooks and
// terminates immediately. A `quitting` latch keeps the re-entered
// before-quit (from the eventual quit/exit) from looping.
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  void (async () => {
    if (dbForQuit && userDataDirForQuit && exportRootForQuit) {
      try {
        const summary = await exportToFolder(
          dbForQuit,
          userDataDirForQuit,
          exportRootForQuit
        )
        console.log(
          `[main] auto-export → ${summary.destRoot} (` +
            `${summary.counts.boards} boards, ` +
            `${summary.counts.cards} cards, ` +
            `${summary.counts.attachments} attachments)`
        )
      } catch (err) {
        console.error('[main] auto-export failed:', err)
      }
    }
    if (controlChannel) {
      try {
        await controlChannel.shutdown()
      } catch (err) {
        console.error('[main] control channel shutdown failed:', err)
      }
      controlChannel = null
    }
    app.exit(0)
  })()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
