// Renderer-side type for the preload bridge. Declared locally (not
// imported from apps/desktop) to avoid an app->app coupling; the
// payload shapes come from the shared contract.
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

export {}

declare global {
  interface Window {
    kanbini?: {
      versions: { electron: string; chrome: string }
      listBoards: () => Promise<BoardsListView>
      getBoardView: (boardId?: string) => Promise<BoardView | null>
      mutate: (m: Mutation) => Promise<MutationResult>
      mutateBatch: (ms: Mutation[]) => Promise<MutationResult[]>
      attachmentAdd: (cardId: string) => Promise<AttachmentView | null>
      attachmentPasteImage: (cardId: string) => Promise<AttachmentView | null>
      linkPreviewCreate: (
        req: LinkPreviewRequest
      ) => Promise<LinkPreviewResult>
      exportNow: () => Promise<ExportSummary>
      importFolder: () => Promise<ImportSummary | null>
      importTrello: () => Promise<TrelloImportSummary | null>
      boardSetBackgroundImage: (
        req: BoardSetBackgroundImageRequest
      ) => Promise<BoardBackground | null>
      undoStatus: () => Promise<UndoStatus>
      undoApply: (req: UndoApplyRequest) => Promise<UndoApplyResult>
      redoApply: (req: UndoApplyRequest) => Promise<UndoApplyResult>
      undoClear: () => Promise<UndoStatus>
      searchCards: (req: SearchCardsRequest) => Promise<SearchHits>
      appInfo: () => Promise<AppInfo>
      mcpInfo: () => Promise<McpInfo>
      obsidianPickVault: () => Promise<string | null>
      obsidianPush: (req: ObsidianPushRequest) => Promise<ObsidianPushResult>
      uninstallSetRemoveDataOnUninstall: (value: boolean) => Promise<void>
      noticesOpen: () => Promise<string>
      templateSave: (req: TemplateSaveRequest) => Promise<{ id: string }>
      templateList: () => Promise<TemplateSummaryList>
      templateRename: (req: TemplateRenameRequest) => Promise<void>
      templateDelete: (req: TemplateDeleteRequest) => Promise<void>
      templateInstantiate: (
        req: TemplateInstantiateRequest
      ) => Promise<TemplateInstantiateResult>
      onChange: (cb: (e: ChangeEvent) => void) => () => void
    }
  }
}
