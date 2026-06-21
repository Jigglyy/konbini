import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@kanbini/shared/channels'
import type {
  AppInfo,
  AttachmentView,
  BoardBackground,
  BoardSetBackgroundImageRequest,
  BoardsListView,
  BoardView,
  ChangeEvent,
  ExportSummary,
  ImportSummary,
  LinkPreviewRequest,
  LinkPreviewResult,
  McpInfo,
  Mutation,
  MutationResult,
  ObsidianPushRequest,
  ObsidianPushResult,
  SearchCardsRequest,
  SearchHits,
  TemplateDeleteRequest,
  TemplateInstantiateRequest,
  TemplateInstantiateResult,
  TemplateRenameRequest,
  TemplateSaveRequest,
  TemplateSummaryList,
  TrelloImportSummary,
  UndoApplyRequest,
  UndoApplyResult,
  UndoStatus
} from '@kanbini/shared'

// Minimal, typed contextBridge surface (contextIsolation + sandbox).
// Type-only imports are erased, channel names come from the zero-dep
// subpath - so zod/uuid never enter the preload bundle.
const api = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome
  },
  /** M4-G: enumerate every board for the home picker. */
  listBoards: (): Promise<BoardsListView> =>
    ipcRenderer.invoke(IPC.boardsList),
  getBoardView: (boardId?: string): Promise<BoardView | null> =>
    ipcRenderer.invoke(IPC.boardGetView, { boardId }),
  mutate: (mutation: Mutation): Promise<MutationResult> =>
    ipcRenderer.invoke(IPC.mutate, mutation),
  /** Bulk gesture: several mutations in one transaction, recorded as
   *  ONE undo-log group so a single Ctrl+Z unwinds the whole thing
   *  (multi-select complete / label / delete, multi-card drag). */
  mutateBatch: (mutations: Mutation[]): Promise<MutationResult[]> =>
    ipcRenderer.invoke(IPC.mutateBatch, mutations),
  attachmentAdd: (cardId: string): Promise<AttachmentView | null> =>
    ipcRenderer.invoke(IPC.attachmentAdd, { cardId }),
  /** Attach the clipboard image to a card (Ctrl/Cmd+V). Resolves null when
   *  the clipboard holds no image, so the renderer can call it on any
   *  paste and let a text paste fall through. */
  attachmentPasteImage: (cardId: string): Promise<AttachmentView | null> =>
    ipcRenderer.invoke(IPC.attachmentPasteImage, { cardId }),
  /** M4-H / ADR-0023: opt-in link-preview fetch. Renderer must gate
   *  on settings.linkPreviews - main does the network egress and the
   *  fetched preview is stored as a normal local attachment so the
   *  CSP stays strict. */
  linkPreviewCreate: (req: LinkPreviewRequest): Promise<LinkPreviewResult> =>
    ipcRenderer.invoke(IPC.linkPreviewCreate, req),
  /** M4-A: write a plain-text snapshot of the DB + attachments to
   *  userData/export. Auto-runs on quit too - this is the manual
   *  "Backup now" trigger. */
  exportNow: (): Promise<ExportSummary> =>
    ipcRenderer.invoke(IPC.exportNow),
  /** M4-B: restore from a previous export. Opens a folder picker;
   *  resolves to null if cancelled, otherwise to ImportSummary
   *  after wiping and re-inserting. */
  importFolder: (): Promise<ImportSummary | null> =>
    ipcRenderer.invoke(IPC.importFolder),
  /** Import a Trello board export (.json) as a new board. Opens a
   *  file picker; resolves to null if cancelled, otherwise to a
   *  TrelloImportSummary. Additive - never wipes existing data. */
  importTrello: (): Promise<TrelloImportSummary | null> =>
    ipcRenderer.invoke(IPC.importTrello),
  /** ADR-0034: pick an image file, copy it into userData/board-
   *  backgrounds/<boardId>/, set the board's `background` to the new
   *  path. Null on picker cancel; otherwise the new BoardBackground. */
  boardSetBackgroundImage: (
    req: BoardSetBackgroundImageRequest
  ): Promise<BoardBackground | null> =>
    ipcRenderer.invoke(IPC.boardSetBackgroundImage, req),
  /** ADR-0036 · undo / redo log peek + apply. */
  undoStatus: (): Promise<UndoStatus> => ipcRenderer.invoke(IPC.undoStatus),
  undoApply: (req: UndoApplyRequest): Promise<UndoApplyResult> =>
    ipcRenderer.invoke(IPC.undoApply, req),
  redoApply: (req: UndoApplyRequest): Promise<UndoApplyResult> =>
    ipcRenderer.invoke(IPC.redoApply, req),
  undoClear: (): Promise<UndoStatus> => ipcRenderer.invoke(IPC.undoClear),
  /** M4-D: global card search across all boards. Empty query → []. */
  searchCards: (req: SearchCardsRequest): Promise<SearchHits> =>
    ipcRenderer.invoke(IPC.searchCards, req),
  /** M4-F: app version + userData paths for Settings → About. */
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),
  /** M4-F: MCP control-channel status + paths + copy-paste config
   *  snippets for Settings → MCP. */
  mcpInfo: (): Promise<McpInfo> => ipcRenderer.invoke(IPC.mcpInfo),
  /** ADR-0042 Obsidian one-way push. Opt-in (gated on
   *  `settings.obsidian.enabled`); vault content is never read for
   *  cross-direction sync - strictly push, never pull. */
  obsidianPickVault: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.obsidianPickVault),
  obsidianPush: (req: ObsidianPushRequest): Promise<ObsidianPushResult> =>
    ipcRenderer.invoke(IPC.obsidianPush, req),
  /** M5-B / ADR-0049 - persist the "Remove my data on uninstall"
   *  choice to a location the Windows NSIS uninstaller can read
   *  after the program folder is gone (HKCU registry on Windows;
   *  no-op on Mac/Linux). */
  uninstallSetRemoveDataOnUninstall: (value: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.uninstallSetRemoveDataOnUninstall, { value }),
  /** ADR-0054 - open the bundled NOTICES.md with the user's default
   *  markdown / text handler. Returns the error message string from
   *  `shell.openPath` ('' on success). */
  noticesOpen: (): Promise<string> => ipcRenderer.invoke(IPC.noticesOpen),
  /** ADR-0038 templates surface. */
  templateSave: (req: TemplateSaveRequest): Promise<{ id: string }> =>
    ipcRenderer.invoke(IPC.templateSave, req),
  templateList: (): Promise<TemplateSummaryList> =>
    ipcRenderer.invoke(IPC.templateList),
  templateRename: (req: TemplateRenameRequest): Promise<void> =>
    ipcRenderer.invoke(IPC.templateRename, req),
  templateDelete: (req: TemplateDeleteRequest): Promise<void> =>
    ipcRenderer.invoke(IPC.templateDelete, req),
  templateInstantiate: (
    req: TemplateInstantiateRequest
  ): Promise<TemplateInstantiateResult> =>
    ipcRenderer.invoke(IPC.templateInstantiate, req),
  /** Subscribe to change events; returns an unsubscribe fn. */
  onChange: (cb: (e: ChangeEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: ChangeEvent): void => cb(payload)
    ipcRenderer.on(IPC.changed, handler)
    return () => ipcRenderer.removeListener(IPC.changed, handler)
  }
} as const

contextBridge.exposeInMainWorld('kanbini', api)

export type KanbiniApi = typeof api
