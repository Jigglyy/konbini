import { vi } from 'vitest'

// Preload-bridge mock for renderer tests (ADR-0044). The renderer code
// reaches `window.kanbini` via the wrapper in `src/lib/ipc.ts` -
// every test gets a fresh set of vi.fn()s with sensible default
// returns, plus a `setKanbini(overrides)` helper for the test-specific
// behaviour.
//
// The shape mirrors `apps/desktop/src/preload/index.ts` exactly; new
// IPC channels added there should be reflected here so tests don't
// silently break with `is not a function`.

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

const EMPTY_BOARDS_LIST: BoardsListView = []

const EMPTY_UNDO_STATUS: UndoStatus = {
  canUndo: false,
  canRedo: false,
  undoDescription: null,
  redoDescription: null
}

const NOOP_MUTATION_RESULT: MutationResult = {
  id: 'mock-id',
  boardId: 'mock-board'
}

/** Build a fresh bridge stub. Every method is a vi.fn - tests inspect
 *  call args via `.toHaveBeenCalledWith(...)`. Defaults satisfy the
 *  zero-state read path (no boards, no undo). Tests override per-call
 *  via `setKanbini({ ... })` or by calling `.mockResolvedValueOnce`. */
function makeBridge() {
  return {
    versions: { electron: 'test', chrome: 'test' },
    listBoards: vi.fn(async (): Promise<BoardsListView> => EMPTY_BOARDS_LIST),
    getBoardView: vi.fn(
      async (_boardId?: string): Promise<BoardView | null> => null
    ),
    mutate: vi.fn(
      async (_m: Mutation): Promise<MutationResult> => NOOP_MUTATION_RESULT
    ),
    mutateBatch: vi.fn(
      async (ms: Mutation[]): Promise<MutationResult[]> =>
        ms.map(() => NOOP_MUTATION_RESULT)
    ),
    attachmentAdd: vi.fn(
      async (_cardId: string): Promise<AttachmentView | null> => null
    ),
    attachmentPasteImage: vi.fn(
      async (_cardId: string): Promise<AttachmentView | null> => null
    ),
    linkPreviewCreate: vi.fn(
      async (_req: LinkPreviewRequest): Promise<LinkPreviewResult> => ({
        ok: false,
        error: 'mocked'
      })
    ),
    exportNow: vi.fn(
      async (): Promise<ExportSummary> => ({
        exportedAt: 0,
        destRoot: '/mock',
        formatVersion: 1,
        counts: {
          projects: 0,
          boards: 0,
          lists: 0,
          cards: 0,
          labels: 0,
          cardLabels: 0,
          checklists: 0,
          checklistItems: 0,
          comments: 0,
          attachments: 0,
          activities: 0
        }
      })
    ),
    importFolder: vi.fn(async (): Promise<ImportSummary | null> => null),
    importTrello: vi.fn(
      async (): Promise<TrelloImportSummary | null> => null
    ),
    boardSetBackgroundImage: vi.fn(
      async (
        _req: BoardSetBackgroundImageRequest
      ): Promise<BoardBackground | null> => null
    ),
    undoStatus: vi.fn(async (): Promise<UndoStatus> => EMPTY_UNDO_STATUS),
    undoApply: vi.fn(
      async (_req: UndoApplyRequest): Promise<UndoApplyResult> => ({
        applied: false,
        boardId: null
      })
    ),
    redoApply: vi.fn(
      async (_req: UndoApplyRequest): Promise<UndoApplyResult> => ({
        applied: false,
        boardId: null
      })
    ),
    undoClear: vi.fn(async (): Promise<UndoStatus> => EMPTY_UNDO_STATUS),
    searchCards: vi.fn(
      async (_req: SearchCardsRequest): Promise<SearchHits> => []
    ),
    appInfo: vi.fn(
      async (): Promise<AppInfo> => ({
        version: '0.0.0',
        versions: { electron: 'test', chrome: 'test', node: 'test' },
        paths: {
          userData: '/mock',
          db: '/mock/db',
          attachments: '/mock/att',
          export: '/mock/export',
          notices: '/mock/NOTICES.md'
        },
        // Default to 'linux' so the Windows-only UI (M5-B uninstall
        // toggle) stays hidden by default - tests that care assert
        // via `setKanbini({ appInfo: vi.fn(async () => ({ ...,
        // platform: 'win32' })) })`.
        platform: 'linux'
      })
    ),
    mcpInfo: vi.fn(
      async (): Promise<McpInfo> => ({
        channel: { running: false, port: null, token: null },
        paths: { mcpJson: '/mock/mcp.json', mcpToken: '/mock/mcp-token', bundle: null },
        snippets: { mcpClientJson: '{}' }
      })
    ),
    obsidianPickVault: vi.fn(async (): Promise<string | null> => null),
    obsidianPush: vi.fn(
      async (_req: ObsidianPushRequest): Promise<ObsidianPushResult> => ({
        pushedAt: 0,
        boardCount: 0,
        cardCount: 0,
        written: 0,
        skippedForeign: 0,
        warnings: [],
        pruned: 0
      })
    ),
    uninstallSetRemoveDataOnUninstall: vi.fn(
      async (_value: boolean): Promise<void> => {}
    ),
    noticesOpen: vi.fn(async (): Promise<string> => ''),
    templateSave: vi.fn(
      async (_req: TemplateSaveRequest): Promise<{ id: string }> => ({
        id: 'tmpl-mock'
      })
    ),
    templateList: vi.fn(async (): Promise<TemplateSummaryList> => []),
    templateRename: vi.fn(async (_req: TemplateRenameRequest): Promise<void> => {}),
    templateDelete: vi.fn(async (_req: TemplateDeleteRequest): Promise<void> => {}),
    templateInstantiate: vi.fn(
      async (
        _req: TemplateInstantiateRequest
      ): Promise<TemplateInstantiateResult> => ({
        kind: 'board',
        boardId: 'mock-board',
        listId: null
      })
    ),
    onChange: vi.fn((_cb: (e: ChangeEvent) => void) => () => {})
  }
}

export type KanbiniBridgeMock = ReturnType<typeof makeBridge>

/** Called from `_setup.ts`'s beforeEach. Reinstalls a fresh mock
 *  bridge on `window.kanbini`, wiping any state from the prior test
 *  (call args, mockResolvedValueOnce queues, etc). */
export function resetKanbiniMock(): KanbiniBridgeMock {
  const bridge = makeBridge()
  ;(window as unknown as { kanbini: KanbiniBridgeMock }).kanbini = bridge
  return bridge
}

/** Test-side accessor - returns the currently-installed mock so the
 *  test can `.mockResolvedValueOnce(...)` or assert against
 *  `.mock.calls`. */
export function kanbiniMock(): KanbiniBridgeMock {
  return (window as unknown as { kanbini: KanbiniBridgeMock }).kanbini
}
