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

// Thin typed accessor over the preload bridge so components don't
// repeat the window.kanbini guard.
function bridge() {
  const b = window.kanbini
  if (!b) throw new Error('preload bridge unavailable')
  return b
}

export const ipc = {
  listBoards: (): Promise<BoardsListView> => bridge().listBoards(),
  getBoardView: (boardId?: string): Promise<BoardView | null> =>
    bridge().getBoardView(boardId),
  mutate: (m: Mutation): Promise<MutationResult> => bridge().mutate(m),
  /** Bulk gesture - one transaction, one undo-log group (one Ctrl+Z). */
  mutateBatch: (ms: Mutation[]): Promise<MutationResult[]> =>
    bridge().mutateBatch(ms),
  attachmentAdd: (cardId: string): Promise<AttachmentView | null> =>
    bridge().attachmentAdd(cardId),
  /** Attach the clipboard image to a card; resolves null on a non-image
   *  (text) paste. */
  attachmentPasteImage: (cardId: string): Promise<AttachmentView | null> =>
    bridge().attachmentPasteImage(cardId),
  linkPreviewCreate: (req: LinkPreviewRequest): Promise<LinkPreviewResult> =>
    bridge().linkPreviewCreate(req),
  exportNow: (): Promise<ExportSummary> => bridge().exportNow(),
  importFolder: (): Promise<ImportSummary | null> => bridge().importFolder(),
  importTrello: (): Promise<TrelloImportSummary | null> =>
    bridge().importTrello(),
  boardSetBackgroundImage: (
    req: BoardSetBackgroundImageRequest
  ): Promise<BoardBackground | null> => bridge().boardSetBackgroundImage(req),
  undoStatus: (): Promise<UndoStatus> => bridge().undoStatus(),
  undoApply: (req: UndoApplyRequest = {}): Promise<UndoApplyResult> =>
    bridge().undoApply(req),
  redoApply: (req: UndoApplyRequest = {}): Promise<UndoApplyResult> =>
    bridge().redoApply(req),
  undoClear: (): Promise<UndoStatus> => bridge().undoClear(),
  searchCards: (req: SearchCardsRequest): Promise<SearchHits> =>
    bridge().searchCards(req),
  appInfo: (): Promise<AppInfo> => bridge().appInfo(),
  mcpInfo: (): Promise<McpInfo> => bridge().mcpInfo(),
  obsidianPickVault: (): Promise<string | null> => bridge().obsidianPickVault(),
  obsidianPush: (req: ObsidianPushRequest): Promise<ObsidianPushResult> =>
    bridge().obsidianPush(req),
  uninstallSetRemoveDataOnUninstall: (value: boolean): Promise<void> =>
    bridge().uninstallSetRemoveDataOnUninstall(value),
  noticesOpen: (): Promise<string> => bridge().noticesOpen(),
  templateSave: (req: TemplateSaveRequest): Promise<{ id: string }> =>
    bridge().templateSave(req),
  templateList: (): Promise<TemplateSummaryList> => bridge().templateList(),
  templateRename: (req: TemplateRenameRequest): Promise<void> =>
    bridge().templateRename(req),
  templateDelete: (req: TemplateDeleteRequest): Promise<void> =>
    bridge().templateDelete(req),
  templateInstantiate: (
    req: TemplateInstantiateRequest
  ): Promise<TemplateInstantiateResult> => bridge().templateInstantiate(req),
  onChange: (cb: (e: ChangeEvent) => void): (() => void) =>
    bridge().onChange(cb)
}
