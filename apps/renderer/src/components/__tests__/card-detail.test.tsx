import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { BoardView, CardView } from '@kanbini/shared'
import { boardKey } from '../../hooks/useBoard'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// Stub the markdown-editor module at the test boundary - same
// strategy as comments.test.tsx. CardDetail's non-editor surfaces
// (title rename, completion toggle, child wiring) are the focus
// here; the TipTap-backed MarkdownField + MarkdownView render as
// plain DOM shims so we can assert against them without standing
// up ProseMirror.
vi.mock('../ui/markdown-editor', () => ({
  MarkdownField: ({
    value,
    onChange
  }: {
    value: string
    onChange: (v: string) => void
  }) => (
    <textarea
      aria-label="card description"
      defaultValue={value}
      onBlur={(e) => onChange(e.target.value)}
    />
  ),
  MarkdownView: ({ value }: { value: string }) => (
    <div data-testid="markdown-view">{value}</div>
  ),
  MarkdownEditor: () => <div data-testid="markdown-editor" />,
  Toolbar: () => <div data-testid="toolbar" />,
  buildExtensions: () => []
}))

// Also stub @tiptap/react because the Comments + Checklists children
// import it for their composers. Stubs are no-op renderers - the
// nested wiring is covered by comments.test.tsx already; CardDetail
// just needs them to mount without throwing.
vi.mock('@tiptap/react', () => ({
  useEditor: () => null,
  useEditorState: ({ selector }: { selector: (ctx: { editor: null }) => unknown }) =>
    selector({ editor: null }),
  EditorContent: () => null
}))

import { CardDetail } from '../card-detail'

function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'c1',
    title: 'Original',
    description: null,
    position: 'a',
    completed: false,
    dueAt: null,
    priority: null,
    labelIds: [],
    checklists: [],
    comments: [],
    attachments: [],
    coverAttachmentId: null,
    activities: [],
    ...overrides
  }
}

function makeBoardView(cards: CardView[]): BoardView {
  return {
    project: { id: 'p1', name: 'Sample' },
    board: {
      id: 'b1',
      name: 'Board',
      color: null,
      background: null,
      swimlaneMode: null
    },
    labels: [],
    lists: [
      {
        id: 'l1',
        name: 'Todo',
        color: null,
        closed: false,
        position: 'a',
        wipLimit: null,
        sortMode: null,
        onEnter: null,
        cards
      }
    ]
  }
}

function renderWithBoard(
  card: CardView,
  options: {
    onClose?: () => void
    cardId?: string | null
  } = {}
) {
  const qc = new QueryClient({
    // staleTime: Infinity keeps the pre-seeded board query fresh -
    // otherwise the default mock's getBoardView (returns null) fires
    // on mount + replaces the cache with null, which the disappear
    // effect immediately catches and closes the modal.
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity }
    }
  })
  const board = makeBoardView([card])
  // Pre-seed the board query the way useBoard reads it so the modal
  // mounts with data already in the cache (no useQuery loading spin).
  qc.setQueryData(boardKey('b1'), board)
  return render(
    <QueryClientProvider client={qc}>
      <CardDetail
        boardId="b1"
        cardId={options.cardId === undefined ? card.id : options.cardId}
        onClose={options.onClose ?? vi.fn()}
      />
    </QueryClientProvider>
  )
}

describe('<CardDetail>', () => {
  it('renders the title input with the current title pre-filled', () => {
    renderWithBoard(makeCard({ title: 'My card' }))
    expect(screen.getByDisplayValue('My card')).toBeInTheDocument()
  })

  it('renders the description field with the stored body', () => {
    renderWithBoard(makeCard({ description: '# Heading' }))
    expect(
      screen.getByRole('textbox', { name: 'card description' })
    ).toHaveValue('# Heading')
  })

  it('title rename via blur fires card.update with the trimmed name', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    renderWithBoard(makeCard({ title: 'Original' }))
    const input = screen.getByDisplayValue('Original')
    await user.clear(input)
    await user.type(input, '  Renamed  ')
    fireEvent.blur(input)
    await waitFor(() => {
      expect(mock.mutate).toHaveBeenCalledWith({
        type: 'card.update',
        id: 'c1',
        patch: { title: 'Renamed' }
      })
    })
  })

  it('title rename via Enter blurs + commits exactly once', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    renderWithBoard(makeCard({ title: 'Original' }))
    const input = screen.getByDisplayValue('Original')
    await user.clear(input)
    await user.type(input, 'Via enter{Enter}')
    await waitFor(() => {
      expect(mock.mutate).toHaveBeenCalledWith({
        type: 'card.update',
        id: 'c1',
        patch: { title: 'Via enter' }
      })
    })
    // Regression: Enter used to call saveTitle() AND blur (which calls it
    // again), firing two card.update mutations + two "renamed" activity rows.
    expect(mock.mutate).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+V while the card is open attaches a clipboard image', async () => {
    const mock = kanbiniMock()
    renderWithBoard(makeCard({ id: 'c1' }))
    fireEvent.keyDown(document, { key: 'v', ctrlKey: true })
    await waitFor(() => {
      expect(mock.attachmentPasteImage).toHaveBeenCalledWith('c1')
    })
  })

  it('a non-paste keystroke does not try to attach a clipboard image', () => {
    const mock = kanbiniMock()
    renderWithBoard(makeCard({ id: 'c1' }))
    fireEvent.keyDown(document, { key: 'a', ctrlKey: true }) // not V
    fireEvent.keyDown(document, { key: 'v' }) // V without a modifier
    expect(mock.attachmentPasteImage).not.toHaveBeenCalled()
  })

  it('title rename no-ops when the trimmed value matches the original', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    renderWithBoard(makeCard({ title: 'Original' }))
    const input = screen.getByDisplayValue('Original')
    await user.clear(input)
    await user.type(input, '   Original   ')
    fireEvent.blur(input)
    // Slight pause to allow any pending IPC to settle.
    await new Promise((r) => setTimeout(r, 50))
    expect(mock.mutate).not.toHaveBeenCalled()
  })

  it('title rename reverts the buffer when the trimmed value is empty', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    renderWithBoard(makeCard({ title: 'Original' }))
    const input = screen.getByDisplayValue('Original')
    await user.clear(input)
    fireEvent.blur(input)
    // No mutation fires + the input snaps back to the original.
    expect(mock.mutate).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('Original')).toBeInTheDocument()
  })

  it('description blur fires card.update with the next body', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    renderWithBoard(makeCard({ description: 'old' }))
    const desc = screen.getByRole('textbox', { name: 'card description' })
    await user.click(desc)
    fireEvent.change(desc, { target: { value: 'new body' } })
    fireEvent.blur(desc)
    await waitFor(() => {
      expect(mock.mutate).toHaveBeenCalledWith({
        type: 'card.update',
        id: 'c1',
        patch: { description: 'new body' }
      })
    })
  })

  it('description blur with empty value writes null (clears the body)', async () => {
    const mock = kanbiniMock()
    renderWithBoard(makeCard({ description: 'old' }))
    const desc = screen.getByRole('textbox', { name: 'card description' })
    fireEvent.change(desc, { target: { value: '   ' } })
    fireEvent.blur(desc)
    await waitFor(() => {
      expect(mock.mutate).toHaveBeenCalledWith({
        type: 'card.update',
        id: 'c1',
        patch: { description: null }
      })
    })
  })

  it("'Mark complete' checkbox fires card.update with completed: true", async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    renderWithBoard(makeCard({ completed: false }))
    await user.click(screen.getByRole('checkbox', { name: /mark complete/i }))
    await waitFor(() => {
      expect(mock.mutate).toHaveBeenCalledWith({
        type: 'card.update',
        id: 'c1',
        patch: { completed: true }
      })
    })
  })

  it("checkbox shows 'Completed' label when the card is already complete", () => {
    renderWithBoard(makeCard({ completed: true }))
    expect(
      screen.getByRole('checkbox', { name: 'Completed' })
    ).toBeChecked()
  })

  it("clicking the X button calls onClose", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderWithBoard(makeCard(), { onClose })
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("calls onClose if the card disappears from the cache (deleted elsewhere)", async () => {
    // Render with a cardId that doesn't exist in the board → the
    // effect that watches (cardId, data, !card) fires onClose.
    const onClose = vi.fn()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    qc.setQueryData(boardKey('b1'), makeBoardView([]))
    render(
      <QueryClientProvider client={qc}>
        <CardDetail boardId="b1" cardId="ghost-card" onClose={onClose} />
      </QueryClientProvider>
    )
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it("renders the labelIds via <CardLabels>", () => {
    const board = makeBoardView([
      makeCard({ id: 'c1', labelIds: ['l1', 'l2'] })
    ])
    board.labels = [
      { id: 'l1', name: 'Bug', color: 'oklch(0.62 0.17 25)' },
      { id: 'l2', name: 'Feature', color: 'oklch(0.62 0.15 250)' }
    ]
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    qc.setQueryData(boardKey('b1'), board)
    render(
      <QueryClientProvider client={qc}>
        <CardDetail boardId="b1" cardId="c1" onClose={vi.fn()} />
      </QueryClientProvider>
    )
    expect(screen.getByText('Bug')).toBeInTheDocument()
    expect(screen.getByText('Feature')).toBeInTheDocument()
  })
})

// M4-H follow-up - the in-detail Cover entry point. CardDetail
// renders <CoverActions> alongside the right-click CardMenu's three
// actions, so a user with the modal open doesn't have to close it,
// right-click the in-list card, then reopen. Same helpers + same
// <UrlCoverModal>; just a second entry surface.
//
// Tests scope to `data-testid="cover-actions"` because the per-
// attachment row ALSO renders a "Remove cover" button on the
// current cover attachment - a bare getByRole would collide.
describe('<CardDetail> Cover actions', () => {
  const coverRow = () =>
    within(screen.getByTestId('cover-actions'))
  const attachmentFixture = {
    id: 'a1',
    filename: 'pic.png',
    relPath: 'attachments/a1/pic.png',
    mime: 'image/png',
    size: 1,
    sourceUrl: null,
    sourceTitle: null,
    createdAt: 0
  }

  it('shows "Set from file…" + "Set from URL…" buttons', () => {
    renderWithBoard(makeCard())
    expect(
      coverRow().getByRole('button', { name: /set from file/i })
    ).toBeInTheDocument()
    expect(
      coverRow().getByRole('button', { name: /set from url/i })
    ).toBeInTheDocument()
  })

  it('hides "Remove cover" when the card has no cover', () => {
    renderWithBoard(makeCard({ coverAttachmentId: null }))
    expect(
      coverRow().queryByRole('button', { name: /remove cover/i })
    ).toBeNull()
  })

  it('shows "Remove cover" only when a cover is set', () => {
    renderWithBoard(
      makeCard({
        coverAttachmentId: 'a1',
        attachments: [attachmentFixture]
      })
    )
    expect(
      coverRow().getByRole('button', { name: /remove cover/i })
    ).toBeInTheDocument()
  })

  it('"Remove cover" fires card.update with coverAttachmentId=null', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    renderWithBoard(
      makeCard({
        coverAttachmentId: 'a1',
        attachments: [attachmentFixture]
      })
    )
    await user.click(
      coverRow().getByRole('button', { name: /remove cover/i })
    )
    expect(mock.mutate).toHaveBeenCalledWith({
      type: 'card.update',
      id: 'c1',
      patch: { coverAttachmentId: null }
    })
  })

  it('"Set from file…" runs the two-step IPC (upload then card.update)', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    mock.attachmentAdd.mockResolvedValueOnce({
      id: 'new-att',
      filename: 'pick.png',
      relPath: 'attachments/new-att/pick.png',
      mime: 'image/png',
      size: 1,
      sourceUrl: null,
      sourceTitle: null,
      createdAt: 0
    })
    renderWithBoard(makeCard())
    await user.click(
      coverRow().getByRole('button', { name: /set from file/i })
    )
    await waitFor(() => {
      expect(mock.attachmentAdd).toHaveBeenCalledWith('c1')
    })
    await waitFor(() => {
      expect(mock.mutate).toHaveBeenCalledWith({
        type: 'card.update',
        id: 'c1',
        patch: { coverAttachmentId: 'new-att' }
      })
    })
  })

  it('"Set from file…" no-ops when the user cancels the picker', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    // Default mock returns null = user cancelled the native dialog.
    renderWithBoard(makeCard())
    await user.click(
      coverRow().getByRole('button', { name: /set from file/i })
    )
    await waitFor(() => {
      expect(mock.attachmentAdd).toHaveBeenCalledWith('c1')
    })
    // No follow-up card.update - cancellation aborts the chain.
    expect(mock.mutate).not.toHaveBeenCalled()
  })

  it('"Set from URL…" opens the UrlCoverModal', async () => {
    const user = userEvent.setup()
    renderWithBoard(makeCard())
    // No URL dialog before the click.
    expect(
      screen.queryByRole('dialog', { name: /set cover from url/i })
    ).toBeNull()
    await user.click(
      coverRow().getByRole('button', { name: /set from url/i })
    )
    // The body-portaled UrlCoverModal now sits alongside the detail.
    expect(
      screen.getByRole('dialog', { name: /set cover from url/i })
    ).toBeInTheDocument()
  })
})
