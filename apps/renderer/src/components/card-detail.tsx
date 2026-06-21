import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { BoardView, CardView } from '@kanbini/shared'
import { useBoard } from '../hooks/useBoard'
import { useBoardMutation } from '../hooks/useBoardMutation'
import { Activity } from './activity'
import { Attachments, CoverActions, CoverImage } from './attachments'
import { CardLabels } from './labels'
import { Checklists } from './checklists'
import { Comments } from './comments'
import { DueBadge } from './due-date'
import { PriorityBadge } from './priority'
import { Modal } from './ui/modal'
import { MarkdownField } from './ui/markdown-editor'
import { UrlCoverModal } from './url-cover-modal'
import { ipc } from '../lib/ipc'

// Card detail modal (M2 chunk A): editable title + description (TipTap
// → Markdown). Labels, due, completion are shown read-only here; they
// remain editable via the card right-click / pencil menu in the list.
// Checklists, comments, attachments, activity log land in later chunks.

const mapCard = (
  b: BoardView,
  id: string,
  fn: (c: CardView) => CardView
): BoardView => ({
  ...b,
  lists: b.lists.map((l) => ({
    ...l,
    cards: l.cards.map((c) => (c.id === id ? fn(c) : c))
  }))
})

function findCard(b: BoardView | null | undefined, id: string): CardView | null {
  if (!b) return null
  for (const l of b.lists) {
    const c = l.cards.find((x) => x.id === id)
    if (c) return c
  }
  return null
}

export function CardDetail({
  boardId,
  cardId,
  onClose
}: {
  boardId: string
  cardId: string | null
  onClose: () => void
}) {
  const { data } = useBoard(boardId)
  const apply = useBoardMutation(boardId)
  const card = cardId ? findCard(data, cardId) : null

  // Local title; sync when card swaps.
  const [title, setTitle] = useState(card?.title ?? '')
  useEffect(() => {
    setTitle(card?.title ?? '')
  }, [card?.id, card?.title])

  // Second entry point for Set cover from URL (M4-H follow-up). The
  // modal lives at this level so it portals to the body alongside the
  // detail modal - the detail modal stays open behind it while the
  // user pastes a URL. Reset to closed whenever the card changes so a
  // stale modal can't bleed across cards.
  const [urlCoverOpen, setUrlCoverOpen] = useState(false)
  useEffect(() => {
    setUrlCoverOpen(false)
  }, [card?.id])

  // The cached card vanished (deleted elsewhere): close.
  useEffect(() => {
    if (cardId && data && !card) onClose()
  }, [cardId, data, card, onClose])

  // Ctrl/Cmd+V while a card is open: if the clipboard holds an image,
  // attach it to this card. Main returns null for a non-image paste, so a
  // plain text paste into the title/description falls through untouched;
  // we don't preventDefault for that reason. The broadcast after a
  // successful attach refetches the board, so the new attachment appears.
  // Debounced so one Ctrl+V is one attach: it guards against key-repeat
  // (holding the keys), an accidental rapid double-press of the same
  // clipboard, and a duplicate keydown observed in the Electron env.
  const lastPasteAtRef = useRef(0)
  useEffect(() => {
    const id = card?.id
    if (!id) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat) return
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.key !== 'v' && e.key !== 'V') return
      const now = Date.now()
      if (now - lastPasteAtRef.current < 800) return
      lastPasteAtRef.current = now
      void ipc.attachmentPasteImage(id).catch(() => {})
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [card?.id])

  if (!card) return <Modal open={false} onClose={onClose}>{null}</Modal>

  const saveTitle = (): void => {
    const t = title.trim()
    if (!t || t === card.title) {
      setTitle(card.title)
      return
    }
    apply({ type: 'card.update', id: card.id, patch: { title: t } }, (b) =>
      mapCard(b, card.id, (c) => ({ ...c, title: t }))
    )
  }
  const saveDescription = (md: string): void => {
    const next = md.trim() === '' ? null : md
    if (next === (card.description ?? null)) return
    apply(
      { type: 'card.update', id: card.id, patch: { description: next } },
      (b) => mapCard(b, card.id, (c) => ({ ...c, description: next }))
    )
  }
  const toggleComplete = (): void => {
    apply(
      {
        type: 'card.update',
        id: card.id,
        patch: { completed: !card.completed }
      },
      (b) =>
        mapCard(b, card.id, (c) => ({ ...c, completed: !c.completed }))
    )
  }

  return (
    <>
    <Modal open onClose={onClose} label={card.title}>
      <CoverImage card={card} />
      <div className="flex flex-col gap-4 p-5">
        {/* Header: labels + close */}
        <div className="flex items-start gap-3">
          <div className="flex flex-1 flex-col gap-2">
            <CardLabels
              labelIds={card.labelIds}
              labels={data?.labels ?? []}
            />
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  // Just blur: onBlur runs saveTitle once. Calling
                  // saveTitle() here AND blurring fired it twice (the
                  // optimistic update hasn't synced card.title back yet, so
                  // the blur's saveTitle still sees a changed title) - two
                  // card.update mutations + two "renamed" activity rows.
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              className="-mx-1 rounded border border-transparent bg-transparent px-1 text-xl font-semibold text-foreground hover:border-border focus:border-ring focus:outline-none"
            />
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={card.completed}
                  onChange={toggleComplete}
                  className="size-3.5 cursor-pointer accent-primary"
                />
                {card.completed ? 'Completed' : 'Mark complete'}
              </label>
              <PriorityBadge card={card} />
              <DueBadge card={card} />
            </div>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Description - read-only by default; click to edit. The
            key={card.id} guarantees a fresh editor when switching cards
            so the previous card's content can't leak in. */}
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            Description
          </h3>
          <MarkdownField
            key={card.id}
            value={card.description ?? ''}
            onChange={saveDescription}
          />
        </section>

        <Checklists card={card} apply={apply} />

        <CoverActions
          card={card}
          apply={apply}
          onRequestUrl={() => setUrlCoverOpen(true)}
        />

        <Attachments card={card} apply={apply} />

        <Comments card={card} apply={apply} />

        <Activity card={card} labels={data?.labels ?? []} />
      </div>
    </Modal>
    {/* URL cover modal lives as a sibling of the detail Modal so it
        portals to the body on its own and stacks on top - same pattern
        SortableCard already uses (the context menu unmounts when the
        URL modal opens; the modal needs to survive that unmount). */}
    <UrlCoverModal
      card={card}
      open={urlCoverOpen}
      onClose={() => setUrlCoverOpen(false)}
    />
    </>
  )
}
