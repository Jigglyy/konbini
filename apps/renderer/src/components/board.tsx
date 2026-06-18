import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import { flushSync } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  defaultDropAnimationSideEffects,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
  type Modifier
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  ArrowDownUp,
  Check,
  Globe,
  GripVertical,
  ListPlus,
  Pencil
} from 'lucide-react'
// Inline SVG (currentColor inherits the text colour, light/dark
// theme-aware without two assets). Vite's `?raw` returns the file
// source as a string; rendered via dangerouslySetInnerHTML. Using
// a relative path (not the `@/` alias) so the `*.svg?raw` ambient
// declaration in env.d.ts matches under Bundler module resolution.
import emptyBoardSvg from '../assets/empty-board.svg?raw'
import type {
  BoardView,
  CardPriority,
  CardView,
  LabelView,
  ListSortMode,
  Mutation,
  SwimlaneMode
} from '@kanbini/shared'
import { type Optimistic, useBoardMutation } from '../hooks/useBoardMutation'
import { boardKey } from '../hooks/useBoard'
import { useSmoothHeight } from '../hooks/useSmoothHeight'
import { useJustCompleted } from '../lib/animations'
import { ipc } from '../lib/ipc'
import { tint } from '../lib/palette'
import { useSettings } from '../lib/settings'
import {
  resolveBindings,
  useShortcutDispatch,
  type ActionId
} from '../lib/shortcuts'
import { detectFirstUrl, domainOf } from '../lib/url'
import {
  bulkCompleteTarget,
  bulkLabelAction,
  clickIntent,
  planMultiCardMove,
  rangeWithinList,
  toggleSelection
} from '../lib/card-selection'
import { cn } from '../lib/utils'
import { ContextMenu } from './ui/context-menu'
import { CardLabels } from './labels'
import { CardDetail } from './card-detail'
import { CardChecklistPreview } from './checklists'
import { DueBadge } from './due-date'
import { PriorityBadge } from './priority'
import { CardMenu } from './card-menu'
import {
  BulkCardMenu,
  SelectionBar,
  type BulkActions,
  type LabelPresence
} from './selection'
import { SwimlaneBoard } from './swimlane-board'
import { CardCoverThumb } from './attachments'
import { ListEditor } from './list-menu'
import { SaveTemplateDialog, TemplatePickerDialog } from './templates'
import { UrlCoverModal } from './url-cover-modal'
import {
  computeMoveTarget,
  findNextNonEmptyListIndex,
  findWipBlock,
  isSortedListReorder,
  isUnchangedMove,
  listOf,
  planListMove,
  planSwimlaneDrop,
  reduceCardMove,
  reorderVisibleLists
} from '../lib/board-dnd'
import {
  CROSS_LIST_DWELL_MS,
  DROP_ANIMATION_DURATION_MS,
  PICKUP_CATCHUP_MS,
  POST_DROP_HOLD_MS,
  createSmoothPickup
} from '../lib/drag-polish'

// Buttery drop in 200 ms. Two-keyframe LIFT → REST with a strong
// ease-out so the card decelerates into the slot instead of gliding
// at constant speed. We previously split the keyframes with an offset
// (position lands at 0.55, shadow fades to 1.0) to disguise a
// shadow-snap at handoff - that's no longer needed now that
// REST_SHADOW matches the source's hovered `shadow-md` exactly AND
// the source pre-paints itself to the same value during postDropHold
// (`SortableCard` below). With handoff smooth, the extended tail
// just felt slow.
//
// REST_SHADOW = Tailwind v4 `shadow-md` (the source's `:hover` value).
// Typical drops end with the cursor still on the landing card; source
// :hover engages the instant the overlay unmounts → matched shadow
// means no transition fires. The source's class-force during
// postDropHold makes this match hold even when :hover wasn't already
// computed (source is opacity-0 during drag, so its computed shadow
// would otherwise be `shadow-sm` and the visible-on-unmount switch to
// `shadow-md` via :hover would fire a 150 ms transition - the "shadow
// appears again" pop we keep chasing).
const LIFT_SHADOW = '0 14px 30px -8px rgb(0 0 0 / 0.55)'
const REST_SHADOW =
  '0 4px 6px -1px rgb(0 0 0 / 0.10), 0 2px 4px -2px rgb(0 0 0 / 0.10)'

// Stable empty-selection identity so "no cards selected" never produces a
// fresh Set each render (which would bust the memoised cards).
const EMPTY_SELECTION: ReadonlySet<string> = new Set()

// List reorder: the column sortable id is namespaced so it never
// collides with a raw card id (card sortables) or the `list:<id>`
// droppable (the card-drop target on the same column). The type-aware
// collision detection keys off this prefix so a card drag never
// resolves a column-reorder droppable and vice versa.
const LIST_SORTABLE_PREFIX = 'listcol:'
const isListSortableId = (id: string): boolean =>
  id.startsWith(LIST_SORTABLE_PREFIX)
const listIdFromSortable = (id: string): string =>
  id.slice(LIST_SORTABLE_PREFIX.length)

// Horizontal-only collision for the list-column reorder. Columns are a
// single non-wrapping row of wildly varying height (a list with many
// cards vs an empty one), so the built-in detectors misbehave: both
// closestCorners and closestCenter fold the Y axis into the distance, and
// a tall neighbour's corner/centre can land closer to the dragged column
// than the column the cursor is horizontally over. Resolving purely on
// the X axis (nearest column centre to the dragged column's centre)
// returns the slot the cursor is actually over, regardless of height.
const closestColumnByX: CollisionDetection = ({
  collisionRect,
  droppableRects,
  droppableContainers
}) => {
  const activeCenterX = collisionRect.left + collisionRect.width / 2
  let closest: (typeof droppableContainers)[number] | null = null
  let closestDist = Number.POSITIVE_INFINITY
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id)
    if (!rect) continue
    const centerX = rect.left + rect.width / 2
    const dist = Math.abs(centerX - activeCenterX)
    if (dist < closestDist) {
      closestDist = dist
      closest = container
    }
  }
  return closest ? [{ id: closest.id }] : []
}

const DROP_ANIMATION: DropAnimation = {
  duration: DROP_ANIMATION_DURATION_MS,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  keyframes: ({ transform }) => [
    {
      transform: CSS.Transform.toString(transform.initial) ?? '',
      boxShadow: LIFT_SHADOW
    },
    {
      transform: CSS.Transform.toString(transform.final) ?? '',
      boxShadow: REST_SHADOW
    }
  ],
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: '0' } }
  })
}

// Auto cover from URL in title (ADR-0033). When linkPreviews +
// autoCoverFromUrl are both on, this hook silently calls
// `linkPreview:create` for any (cardId, url-in-title) pair we
// haven't seen before AND that has no cover yet. The per-board
// "seen" Set is persisted to localStorage so reloads don't refire,
// and the first ever effect run on each mount is a *priming* pass:
// it records current state without firing, so flipping the toggle
// on doesn't surprise-fetch every existing URL-titled card (the
// scenario the TODO explicitly calls out). Subsequent renders
// fire on each genuinely new (cardId, url) - the user just pasted
// it, or the MCP/another window just changed it.
const AUTO_COVER_STORAGE_PREFIX = 'kanbini.autoCoverSeen.'

function loadSeen(boardId: string): Set<string> {
  try {
    const raw = localStorage.getItem(AUTO_COVER_STORAGE_PREFIX + boardId)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    // Guard against non-array storage shapes: a string would otherwise
    // be iterated as individual chars by `new Set(...)`, and an object
    // would throw. Either way the seen set is meant to be a list of
    // (cardId, url) strings; anything else starts fresh.
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

function saveSeen(boardId: string, seen: Set<string>): void {
  try {
    localStorage.setItem(
      AUTO_COVER_STORAGE_PREFIX + boardId,
      JSON.stringify([...seen])
    )
  } catch {
    /* full disk / private mode - auto-cover may refire after reload */
  }
}

function useAutoCoverFromUrl({
  boardId,
  data,
  enabled
}: {
  boardId: string
  data: BoardView
  enabled: boolean
}): void {
  const seenRef = useRef<Set<string> | null>(null)
  const primedRef = useRef(false)
  // Reset both refs when the board changes - a fresh board gets a
  // fresh priming pass.
  useEffect(() => {
    seenRef.current = loadSeen(boardId)
    primedRef.current = false
  }, [boardId])

  useEffect(() => {
    const seen = seenRef.current
    if (!seen) return
    const wasPrimed = primedRef.current
    primedRef.current = true

    let changed = false
    for (const list of data.lists) {
      for (const card of list.cards) {
        const url = detectFirstUrl(card.title)
        if (!url) continue
        const key = `${card.id}:${url}`
        if (seen.has(key)) continue
        seen.add(key)
        changed = true
        // Priming pass - record current state silently so the toggle
        // never retro-fetches the cards that pre-existed it.
        if (!wasPrimed) continue
        if (!enabled) continue
        // Don't overwrite an already-set cover; manual / earlier
        // auto-cover wins.
        if (card.coverAttachmentId) continue
        // Skip optimistic placeholder ids - the real id arrives on
        // the next refetch and we'll fire then.
        if (card.id.startsWith('tmp-')) continue
        // Fire-and-forget. Expected misses come back as
        // `{ok:false}` and are ignored; the manual "Set cover from
        // URL…" modal is the path that surfaces errors. The .catch
        // is defense-in-depth for unexpected transport failures.
        void ipc
          .linkPreviewCreate({ cardId: card.id, url })
          .catch(() => {})
      }
    }
    if (changed) saveSeen(boardId, seen)
  }, [data, enabled, boardId])
}

/** Small chip rendered just under the title when the title text
 *  contains a URL. Visual cue only - doesn't open the link (the card
 *  opens on click). M4-H slice 7. */
function TitleUrlChip({ title }: { title: string }) {
  const url = detectFirstUrl(title)
  const domain = url ? domainOf(url) : null
  if (!domain) return null
  return (
    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
      <Globe className="size-2.5 shrink-0" />
      <span className="truncate" title={url ?? undefined}>
        {domain}
      </span>
    </div>
  )
}

/** Static card visual - shared by the list item and the drag overlay
 *  so a dragged card looks identical (labels included) start to end. */
function CardFace({
  card,
  labels,
  dragging,
  focused,
  selected,
  showChecklist,
  labelsExpanded,
  resting
}: {
  card: CardView
  labels: LabelView[]
  dragging?: boolean
  // Mirrors the resting <li>'s `focused` ring (ADR-0035 keyboard nav).
  // The source <li> is `opacity-0` while dragging, so without this the
  // ring blinks out for the whole drag and snaps back on drop - pass
  // it through to the DragOverlay's CardFace and the highlight stays
  // continuous. Composed into the inline box-shadow (not a `ring-*`
  // class) because Tailwind's ring utilities are themselves
  // `box-shadow`, and the inline LIFT_SHADOW would clobber them.
  focused?: boolean
  /** Mirrors the resting <li>'s multi-select ring so a dragged selected
   *  card keeps its highlight (same reason as `focused`). Takes
   *  precedence over the focus ring. */
  selected?: boolean
  showChecklist?: boolean
  /** Mirror of the source card's label display so the overlay matches
   *  (bars vs names). No toggle here - the overlay is a frozen clone. */
  labelsExpanded?: boolean
  /** Render like a card AT REST (not hovered): hide the completion
   *  checkbox unless the card is actually completed, and don't reserve
   *  the checkbox column for the checklist shift. The single-card drag
   *  overlay leaves this off (the grabbed card was hovered, so its
   *  checkbox was showing - keep it for continuity); the list-reorder
   *  clone sets it so the cards inside look exactly like the resting
   *  column, not the hover-expanded state. */
  resting?: boolean
}) {
  // Replicates `ring-2 ring-ring ring-offset-1 ring-offset-background`
  // as a two-shadow stack: a 1px solid in the background colour right
  // against the card (the "offset" gap), then a 3px solid in the ring
  // colour beyond that - the first shadow paints OVER the inner 1px
  // of the second (CSS box-shadow paints earlier-listed shadows on
  // top), leaving a 2px visible ring with a 1px gap. Same visual the
  // Tailwind class produces.
  //
  // The LIFT_SHADOW used to be merged in here too, but dnd-kit's drop
  // animation animates the OVERLAY WRAPPER's box-shadow - not this
  // inner element's - so a constant LIFT_SHADOW here was dominating
  // any animation up at the wrapper level (the shadow looked like it
  // snapped off the instant the overlay unmounted). The lift now
  // lives on the DragOverlay's wrapper via its `style` prop (see the
  // DragOverlay below); keeping only the ring here means the
  // wrapper's animated shadow is the only big shadow visible.
  const ringShadow = selected
    ? '0 0 0 2px var(--color-background), 0 0 0 4px var(--color-primary)'
    : focused
      ? '0 0 0 1px var(--color-background), 0 0 0 3px var(--color-ring)'
      : ''
  return (
    <div
      style={
        dragging && ringShadow ? { boxShadow: ringShadow } : undefined
      }
      className={`flex flex-col gap-1 overflow-hidden rounded-md border bg-card px-3 py-2 text-sm transition-[border-color] duration-150 ease-out ${
        // The dragging overlay is "in the user's hand" - mirror the
        // SortableCard's :hover border-color (border-ring/60). Drives
        // off the `group/dragoverlay` :hover on the wrapper in the
        // DragOverlay below (NOT React state), because dnd-kit clones
        // the previous render of these children for the drop
        // animation and any prop-threaded state wouldn't reach that
        // frozen snapshot - but the live DOM node still responds to
        // :hover, so the cascade works through cloning. When the
        // cursor leaves the gliding overlay post-drop, the CSS
        // transition fades the border back to neutral instead of
        // holding blue and snapping off at unmount.
        dragging
          ? 'border-border group-hover/dragoverlay:border-ring/60'
          : 'border-border shadow-sm'
      } ${card.completed ? 'opacity-70' : ''} ${
        !dragging && focused
          ? 'ring-2 ring-ring ring-offset-1 ring-offset-background'
          : ''
      }`}
    >
      <CardCoverThumb card={card} />
      <CardLabels
        labelIds={card.labelIds}
        labels={labels}
        expanded={labelsExpanded}
      />
      <div className="flex items-start gap-2">
        {/* Resting clone hides the checkbox for an incomplete card (it's
            w-0 / hidden until hover on the real card); a completed card
            keeps it visible at rest, so show it then. */}
        {(!resting || card.completed) && (
          <span
            className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
              card.completed
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border'
            }`}
          >
            {card.completed && <Check className="size-3" />}
          </span>
        )}
        {/* `pr-5` mirrors the in-list SortableCard title's reserved
            space for the absolute pencil button. `min-w-0` +
            `wrap-anywhere` let unbreakable strings wrap so a long
            title can't blow the card out of the list. */}
        <span
          className={`min-w-0 flex-1 wrap-anywhere pr-5 ${card.completed ? 'text-muted-foreground line-through' : ''}`}
        >
          {card.title}
        </span>
      </div>
      <TitleUrlChip title={card.title} />
      <div className="flex flex-wrap items-center gap-1.5">
        <PriorityBadge card={card} />
        <DueBadge card={card} />
      </div>
      {showChecklist && (
        // Match SortableCard's hovered-state ml - its wrapper shifts the
        // checklist right (16 px) to clear the now-visible checkbox
        // column. The overlay's CardFace ALWAYS shows the checkbox
        // column, so it always needs the same shift; without it the
        // checklist items had 16 px more width than in the source's
        // hovered state, wrapped to fewer lines, and the overlay's
        // visible card was shorter than the source the user just
        // grabbed → "card shrinks from the bottom on drag start."
        // Completed cards use ml-1 (matches SortableCard's completed
        // branch); everyone else gets ml-4. A resting clone has no
        // checkbox column to clear, so it uses ml-0 (the real card's
        // non-hovered margin) instead.
        <div className={card.completed ? 'ml-1' : resting ? 'ml-0' : 'ml-4'}>
          <CardChecklistPreview card={card} />
        </div>
      )}
    </div>
  )
}

// Drag uses the canonical dnd-kit pattern: reorder the query cache LIVE
// in onDragOver so siblings animate under the drag and "drop = what you
// saw"; onDragEnd just persists via card.move (server mints the
// fractional key, ADR-0011; the `changed` event reconciles). Other
// CRUD stays optimistic via useBoardMutation.

const mapLists = (
  b: BoardView,
  fn: (l: BoardView['lists'][number]) => BoardView['lists'][number]
): BoardView => ({ ...b, lists: b.lists.map(fn) })

export function Board({
  board,
  blockCreate,
  blockDrag,
  showChecklist,
  labelsExpanded,
  onToggleLabelsExpanded,
  linkPreviews,
  autoCoverFromUrl,
  boardZoom,
  initialOpenCardId,
  onConsumedOpenCard
}: {
  board: BoardView
  blockCreate: boolean
  blockDrag: boolean
  showChecklist: boolean
  /** Trello-style label display (mirror of settings.labelsExpanded).
   *  When false, in-list cards collapse their label chips to compact
   *  colour bars; when true they show named chips. The card detail
   *  always shows names. */
  labelsExpanded?: boolean
  /** Flip the board-wide label-names display. Clicking a label bar (or
   *  a name chip) on any card calls this; App writes settings. */
  onToggleLabelsExpanded?: () => void
  /** Mirror of settings.linkPreviews - required for the auto-cover
   *  side effect (no-op when off; the safety gate that keeps the
   *  app strict-offline by default - ADR-0023). */
  linkPreviews: boolean
  /** Mirror of settings.autoCoverFromUrl - when both flags are on,
   *  pasting a URL into a card title silently fetches the cover. */
  autoCoverFromUrl: boolean
  /** Mirror of settings.boardZoom - App applies CSS `zoom` to the
   *  outer board wrapper. We re-apply it to the dnd-kit DragOverlay
   *  contents because the overlay is body-portaled (escapes the
   *  wrapper) - dnd-kit sizes the overlay container to the source's
   *  zoom-aware getBoundingClientRect, so the wrapper IS the right
   *  visual size but its 1× contents would render at half text/
   *  padding scale without this re-zoom. */
  boardZoom: number
  /** When the command palette navigates to a card, App passes its id
   *  through the route; we mirror it into local state on mount /
   *  prop change so the CardDetail modal opens. */
  initialOpenCardId?: string | null
  /** Called once we've consumed `initialOpenCardId` into local state.
   *  App clears the route's openCardId in response, so the prop is a
   *  true one-shot - re-activating the SAME card id from the palette
   *  (undefined → id again) is then a real prop change that reopens the
   *  detail, instead of a silent no-op (the value never changed). */
  onConsumedOpenCard?: () => void
}) {
  useAutoCoverFromUrl({
    boardId: board.board.id,
    data: board,
    enabled: linkPreviews && autoCoverFromUrl
  })
  const apply = useBoardMutation(board.board.id)
  const qc = useQueryClient()
  const key = boardKey(board.board.id)
  const snapshot = useRef<BoardView | null>(null)
  const [dragging, setDragging] = useState<CardView | null>(null)
  // List-column reorder. Holds the id of the list being
  // dragged so the DragOverlay can render a column preview; null when no
  // list drag is in flight. Card drags leave this null (and list drags
  // leave `dragging` null) so the two paths never interleave.
  const [draggingListId, setDraggingListId] = useState<string | null>(null)
  // Multi-card drag: true while dragging a card that's part of a 2+
  // selection. The lead card follows the cursor (live reorder); the
  // other selected cards ghost in place and re-cluster at the drop spot
  // on release. `multiDragBlockRef` holds the selection ids in their
  // pre-drag order (the block to re-cluster).
  const [multiDragActive, setMultiDragActive] = useState(false)
  const multiDragBlockRef = useRef<string[]>([])
  // Cursor-on-overlay tracker. The live DragOverlay's inner div fires
  // mouseenter/leave on `overlayHoveredRef`; at onDragEnd we snapshot
  // it into `postDropHoverMatch`. The matching SortableCard (the one
  // just dropped) reads `postDropHoverMatch` and force-paints itself
  // in the source's hovered style (`border-ring/60` + `shadow-md`)
  // for the duration of postDropHold - so when the overlay unmounts
  // at the end of the drop animation, the source is ALREADY at the
  // hovered values and the browser doesn't fire a 150 ms
  // transition-[box-shadow,border-color] when :hover engages
  // (cursor-stays case). Cursor-off case lands here as `false` →
  // no force → source paints defaults → matches the overlay's
  // CSS-faded neutral border. Both cases buttery, neither snappy.
  const overlayHoveredRef = useRef(true)
  const [postDropHoverMatch, setPostDropHoverMatch] = useState(false)
  // Tracks the auto-clear timeout so a rapid second drag doesn't have
  // the first drag's leftover timeout clear its postDropHoverMatch
  // mid-hold. Cleared + replaced on every onDragEnd / onDragCancel,
  // and on unmount.
  const dropResetTimeoutRef = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (dropResetTimeoutRef.current !== null) {
        window.clearTimeout(dropResetTimeoutRef.current)
      }
    }
  }, [])
  const captureHoverForDrop = (): void => {
    if (dropResetTimeoutRef.current !== null) {
      window.clearTimeout(dropResetTimeoutRef.current)
    }
    setPostDropHoverMatch(overlayHoveredRef.current)
    dropResetTimeoutRef.current = window.setTimeout(() => {
      setPostDropHoverMatch(false)
      dropResetTimeoutRef.current = null
    }, POST_DROP_HOLD_MS)
  }
  // Set while a cross-list drag hovers a list that is at its card
  // limit (when `blockDrag` is on) - drives the list's shake + red ring.
  const [blockedListId, setBlockedListId] = useState<string | null>(null)
  const [openCardId, setOpenCardId] = useState<string | null>(
    initialOpenCardId ?? null
  )
  // ADR-0035 keyboard-shortcut focus. null = nothing focused (no ring,
  // first arrow press lands on the first visible card). Cleared if the
  // focused card disappears from the view (deleted / archived / list
  // closed). The card-detail modal opens via the existing setOpenCardId.
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null)
  // Multi-select (separate from `focusedCardId`, which is keyboard nav):
  // a set of cards picked with Ctrl/Cmd+click (toggle) or Shift+click
  // (range within a list), acted on as a group via the floating
  // SelectionBar + the bulk right-click menu. Refs mirror the latest
  // board + selection so the click handler and bulk ops stay
  // referentially stable - the memoised cards depend on that for drag
  // perf (a new callback each render would re-render every card).
  const [selectedIds, setSelectedIds] =
    useState<ReadonlySet<string>>(EMPTY_SELECTION)
  const selectionAnchorRef = useRef<string | null>(null)
  const boardRef = useRef(board)
  boardRef.current = board
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds
  const clearSelection = useCallback((): void => {
    setSelectedIds(EMPTY_SELECTION)
    selectionAnchorRef.current = null
  }, [])
  // Sync if the route changes the requested card after mount (e.g.,
  // palette → palette → different card on the same board). Tell App to
  // clear the route's openCardId once consumed so the prop is a true
  // one-shot - otherwise re-opening the SAME card (its id never changes
  // on the route) wouldn't re-fire this effect.
  useEffect(() => {
    if (initialOpenCardId) {
      setOpenCardId(initialOpenCardId)
      onConsumedOpenCard?.()
    }
  }, [initialOpenCardId, onConsumedOpenCard])
  const sensors = useSensors(
    // Distance constraint so clicking the card buttons still works.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  // Smooth pickup (cards AND lists share this one DragOverlay). The 6px
  // activation distance means the pointer has already moved by the time the
  // drag exists; without this the overlay appears at source+delta and the
  // item snaps to the cursor. The modifier scales the live transform by a
  // TIME-based ease so the overlay lifts off at the source and glides to the
  // cursor (no snap; the lag rides the current drag direction so it can't
  // bounce). DragOverlay modifiers are visual-only - collision uses the
  // unmodified transform (drops stay accurate) and the drop animation reads
  // the overlay's live computed transform (release glides cleanly).
  //
  // The ease is time-based, so the modifier must keep re-applying while the
  // pointer is HELD (otherwise it freezes mid-glide). dnd-kit only re-renders
  // the overlay on pointermove, so we drive our own requestAnimationFrame
  // tick for the catch-up window that forces the overlay to re-render (and
  // re-run the modifier) each frame. The tick only changes a counter - it
  // never touches SortableContext.items, so no FLIP churn / StrictMode loop.
  const pickup = useMemo(() => createSmoothPickup(), [])
  const overlayModifiers = useMemo<Modifier[]>(
    () => [pickup.modifier as Modifier],
    [pickup]
  )
  const [, forcePickupTick] = useReducer((n: number) => n + 1, 0)
  const pickupRaf = useRef<number | null>(null)
  const stopPickupAnim = useCallback((): void => {
    if (pickupRaf.current !== null) {
      cancelAnimationFrame(pickupRaf.current)
      pickupRaf.current = null
    }
  }, [])
  const startPickupAnim = useCallback((): void => {
    stopPickupAnim()
    const t0 = performance.now()
    const step = (): void => {
      forcePickupTick()
      // Run a couple of frames past the ease so the final progress=1 frame
      // paints; the modifier clamps progress, so over-running is harmless.
      if (performance.now() - t0 < PICKUP_CATCHUP_MS + 48) {
        pickupRaf.current = requestAnimationFrame(step)
      } else {
        pickupRaf.current = null
      }
    }
    pickupRaf.current = requestAnimationFrame(step)
  }, [stopPickupAnim])
  useEffect(() => stopPickupAnim, [stopPickupAnim])

  // Cross-list DWELL gate. The live reorder used to splice the dragged card
  // into whatever list the cursor was over EVERY frame, so sweeping across the
  // board made every passed-over list bounce (laggy + jarring). Instead we
  // hold the would-be cross-list move in `pendingCrossRef` and only commit it
  // once the cursor has lingered over that list for CROSS_LIST_DWELL_MS - a
  // fast sweep never dwells long enough, so passed-over lists stay untouched.
  // The timer fires the commit even if the cursor then stops (no more
  // onDragOver events); a drop that beats it is placed directly in onDragEnd.
  const pendingCrossRef = useRef<{
    activeId: string
    overId: string
    toListId: string
    position: 'before' | 'after'
  } | null>(null)
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function clearCrossDwell(): void {
    if (dwellTimerRef.current !== null) {
      clearTimeout(dwellTimerRef.current)
      dwellTimerRef.current = null
    }
    pendingCrossRef.current = null
  }
  function commitCrossDwell(): void {
    const p = pendingCrossRef.current
    dwellTimerRef.current = null
    pendingCrossRef.current = null
    if (!p) return
    qc.setQueryData<BoardView | null>(key, (prev) =>
      prev ? reduceCardMove(prev, p.activeId, p.overId, p.position) : prev
    )
  }
  // Clear a lingering dwell timer if the board unmounts mid-drag.
  useEffect(
    () => () => {
      if (dwellTimerRef.current !== null) clearTimeout(dwellTimerRef.current)
    },
    []
  )

  const findCard = (id: string): CardView | undefined =>
    board.lists.flatMap((l) => l.cards).find((c) => c.id === id)

  // Drop focus when the focused card disappears (deleted, archived,
  // its list closed, or restored-from-folder under our feet). Without
  // this the ring would point at nothing and the next arrow press
  // would still try to navigate "from" the dead id.
  useEffect(() => {
    if (focusedCardId && !findCard(focusedCardId)) {
      setFocusedCardId(null)
    }
    // Drop selected ids whose card disappeared (deleted, archived, list
    // closed) so the bulk bar count + actions never reference a ghost.
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (findCard(id)) next.add(id)
        else changed = true
      }
      return changed ? (next.size === 0 ? EMPTY_SELECTION : next) : prev
    })
    // findCard depends only on board.lists - same dep as board itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, focusedCardId])

  // Esc clears the selection (when no modal / popover owns Escape). App's
  // own Escape handler bails while the selection bar is up (it's a
  // [data-overlay]), so this is the single place that consumes it; a
  // bar popover (data-overlay="popover") still gets Escape first.
  useEffect(() => {
    if (selectedIds.size === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (
        document.querySelector(
          '[role="dialog"], [data-overlay]:not([data-overlay="selection-bar"])'
        )
      )
        return
      clearSelection()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selectedIds.size, clearSelection])

  // ADR-0035 shortcut wiring. Card-scoped actions only - App.tsx owns
  // nav.search / nav.home / Esc separately. Bindings resolve to the
  // user's customizations (or registry defaults when nothing set).
  const [settings] = useSettings()
  const bindings = useMemo(
    () => resolveBindings(settings.shortcuts),
    [settings.shortcuts]
  )

  // Common preamble for every action handler: stop the browser's
  // default + bubbling so e.g. Space doesn't scroll the page.
  const consume = (e: KeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
  }

  // Helpers used by the focus/move actions. Computed from the current
  // view on each call so they don't go stale.
  const visibleListsFn = (): BoardView['lists'] =>
    board.lists.filter((l) => !l.closed)

  const locateCard = (
    cardId: string
  ): { listIdx: number; cardIdx: number; list: BoardView['lists'][number] } | null => {
    const vis = visibleListsFn()
    for (let i = 0; i < vis.length; i++) {
      const list = vis[i]!
      const idx = list.cards.findIndex((c) => c.id === cardId)
      if (idx >= 0) return { listIdx: i, cardIdx: idx, list }
    }
    return null
  }

  /** First visible card on the board, or null if every list is empty. */
  const firstAnyCard = (): string | null => {
    for (const l of visibleListsFn()) {
      if (l.cards[0]) return l.cards[0].id
    }
    return null
  }

  /** Re-focus a card and scroll it into view (smoothly, but cheap -
   *  the browser handles the actual scroll). Uses a data attribute so
   *  the card components don't need to expose refs upward. */
  const focusCard = useCallback((id: string | null): void => {
    setFocusedCardId(id)
    if (!id) return
    // requestAnimationFrame lets React commit the focused style + any
    // sibling reorder first, so scrollIntoView lands on the final box.
    requestAnimationFrame(() => {
      // Use the browser's CSS.escape via `window` - the imported `CSS`
      // from @dnd-kit/utilities is a different namespace (transform
      // helpers only).
      const node = document.querySelector(
        `[data-card-id="${window.CSS.escape(id)}"]`
      )
      if (node instanceof HTMLElement) {
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    })
  }, [])

  /** Card-move handler (kept local so it can be reused by the keyboard
   *  Alt+arrow actions without going through the dnd-kit path). Same
   *  contract as the drag-end mutation: server mints the fractional
   *  key, broadcastChange triggers the renderer refetch. */
  const moveCardTo = useCallback(
    (cardId: string, toListId: string, beforeId: string | null, afterId: string | null): void => {
      void ipc
        .mutate({
          type: 'card.move',
          id: cardId,
          toListId,
          beforeId,
          afterId
        })
        .catch(() => {})
        .finally(() => {
          void qc.invalidateQueries({ queryKey: key })
        })
    },
    [key, qc]
  )

  // --- List reorder ------------------------------------------------------
  //
  // Lists drag horizontally via a grip in each column header (ADR
  // list-move). The dnd-kit machinery is shared with the card path: a
  // single <DndContext>, but each handler branches on the active id's
  // `listcol:` prefix so the carefully-tuned card logic is untouched.
  // The optimistic order is written through the normal `apply` path so a
  // list move undoes with Ctrl+Z like everything else.

  // Stable list-sortable id array for the outer <SortableContext>. Keyed
  // on the visible list ids' signature (NOT board.lists identity, which a
  // card drag churns every onDragOver frame) so a card drag doesn't hand
  // the list context a fresh array each frame.
  const visibleListIdsSig = board.lists
    .filter((l) => !l.closed)
    .map((l) => l.id)
    .join(' ')
  const listColItemIds = useMemo(
    () =>
      visibleListIdsSig === ''
        ? []
        : visibleListIdsSig
            .split(' ')
            .map((id) => `${LIST_SORTABLE_PREFIX}${id}`),
    [visibleListIdsSig]
  )

  /** Keyboard / menu fallback for list reorder (mirrors the label bar's
   *  Move left/right). `dir` is -1 (left) / +1 (right). Reads the live
   *  board off the ref so its identity stays stable for the memoised
   *  ListColumns. */
  const moveListByDir = useCallback(
    (listId: string, dir: -1 | 1): void => {
      const vis = boardRef.current.lists.filter((l) => !l.closed)
      const idx = vis.findIndex((l) => l.id === listId)
      const target = vis[idx + dir]
      if (idx < 0 || !target) return
      const plan = planListMove(vis.map((l) => l.id), listId, target.id)
      if (!plan) return
      apply(
        {
          type: 'list.move',
          id: listId,
          beforeId: plan.beforeId,
          afterId: plan.afterId
        },
        (b) => ({ ...b, lists: reorderVisibleLists(b.lists, plan.orderedIds) })
      )
    },
    [apply]
  )

  // Type-aware collision detection: a card drag only ever resolves card /
  // `list:` / `lane:` droppables (never a `listcol:` column-reorder
  // target), and a list drag only resolves `listcol:` targets. Filtering
  // the candidate set keeps the card path byte-identical to before (those
  // `listcol:` droppables simply didn't exist).
  //
  // Cards keep closestCorners. Lists use an X-only resolver instead: the
  // columns vary wildly in height (a list with cards vs an empty one), and
  // closestCorners/closestCenter both fold the Y axis in, so a tall
  // neighbour's corner could read as "closer" than the column the cursor
  // is actually over - dropping after a list with cards then overshot past
  // the next list. Nearest-column-centre-on-X makes the slot match what
  // the cursor is horizontally over, regardless of height.
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const activeIsList = isListSortableId(String(args.active.id))
    const droppableContainers = args.droppableContainers.filter((c) =>
      activeIsList
        ? isListSortableId(String(c.id))
        : !isListSortableId(String(c.id))
    )
    const scoped = { ...args, droppableContainers }
    return activeIsList ? closestColumnByX(scoped) : closestCorners(scoped)
  }, [])

  // --- Multi-select click + bulk actions ---------------------------------
  //
  // One click handler for the whole card surface (the SortableCard exempts
  // interactive children before calling this). Plain click opens the card
  // and exits selection; Ctrl/Cmd toggles it; Shift range-selects within
  // the card's list. Stable (reads refs) so the memoised cards don't all
  // re-render each board update.
  const onCardClick = useCallback(
    (cardId: string, e: React.MouseEvent): void => {
      // Any click on a card moves the keyboard-nav focus there so mouse
      // + keyboard stay in sync (opening a card also focuses it -
      // intentional, same as pre-multi-select). The multi-select
      // refactor dropped this when it replaced the per-card
      // onClick={() => onFocus(card.id)} with this handler - every
      // focus-dependent shortcut silently broke until you arrow-keyed
      // first (caught by keyboard-shortcuts.spec).
      focusCard(cardId)
      const intent = clickIntent(e)
      if (intent === 'open') {
        setSelectedIds(EMPTY_SELECTION)
        selectionAnchorRef.current = null
        setOpenCardId(cardId)
        return
      }
      e.preventDefault()
      if (intent === 'toggle') {
        setSelectedIds((prev) => toggleSelection(prev, cardId))
      } else {
        // range: anchor..cardId within the same list; cross-list or no
        // anchor falls back to adding just this card.
        const anchor = selectionAnchorRef.current
        const list = boardRef.current.lists.find((l) =>
          l.cards.some((c) => c.id === cardId)
        )
        const ids =
          anchor && list
            ? rangeWithinList(list.cards.map((c) => c.id), anchor, cardId)
            : []
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (ids.length === 0) next.add(cardId)
          else for (const id of ids) next.add(id)
          return next
        })
      }
      selectionAnchorRef.current = cardId
    },
    // focusCard is a stable useCallback([]) - listed for lint
    // completeness, never changes identity (the memoised cards
    // depend on this handler staying stable).
    [focusCard]
  )

  /** Selected cards in board (list-then-position) order, off the latest
   *  board + selection refs. */
  const currentSelectedCards = (): CardView[] =>
    boardRef.current.lists
      .flatMap((l) => l.cards)
      .filter((c) => selectedIdsRef.current.has(c.id))

  /** Apply the whole gesture as ONE batch: a single transaction
   *  server-side, recorded as one undo-log group - so a single Ctrl+Z
   *  unwinds the entire bulk action instead of one card at a time.
   *  The batch's broadcastChange streams the result in; the final
   *  invalidate is a belt-and-braces catch-up. */
  const runBulk = (ms: Mutation[]): void => {
    if (ms.length === 0) return
    void ipc
      .mutateBatch(ms)
      .catch(() => {})
      .finally(() => {
        void qc.invalidateQueries({ queryKey: key })
      })
  }

  const bulkToggleComplete = useCallback((): void => {
    const cards = currentSelectedCards()
    const completed = bulkCompleteTarget(cards)
    runBulk(
      cards
        .filter((c) => c.completed !== completed)
        .map((c) => ({ type: 'card.update', id: c.id, patch: { completed } }))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, qc])

  const bulkSetPriority = useCallback(
    (priority: CardPriority | null): void => {
      const cards = currentSelectedCards()
      runBulk(
        cards
          .filter((c) => c.priority !== priority)
          .map((c) => ({ type: 'card.update', id: c.id, patch: { priority } }))
      )
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [key, qc]
  )

  const bulkToggleLabel = useCallback(
    (labelId: string): void => {
      const cards = currentSelectedCards()
      const { add, targets } = bulkLabelAction(cards, labelId)
      const byId = new Map(cards.map((c) => [c.id, c]))
      runBulk(
        targets.map((id) => {
          const c = byId.get(id)!
          const labelIds = add
            ? [...c.labelIds, labelId]
            : c.labelIds.filter((x) => x !== labelId)
          return { type: 'card.setLabels', id, labelIds }
        })
      )
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [key, qc]
  )

  // Move appends the selection to the target list in their current order.
  // The moves chain `beforeId` through the batch - the server applies
  // them sequentially inside one transaction, so each card's fractional
  // key still lands after the previous one.
  const bulkMoveTo = useCallback(
    (toListId: string): void => {
      const cards = currentSelectedCards()
      const target = boardRef.current.lists.find((l) => l.id === toListId)
      let lastId = target?.cards[target.cards.length - 1]?.id ?? null
      const moves: Mutation[] = []
      for (const c of cards) {
        if (c.id === lastId) continue
        moves.push({
          type: 'card.move',
          id: c.id,
          toListId,
          beforeId: lastId,
          afterId: null
        })
        lastId = c.id
      }
      runBulk(moves)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [key, qc]
  )

  const bulkDelete = useCallback((): void => {
    const ids = [...selectedIdsRef.current]
    clearSelection()
    runBulk(ids.map((id) => ({ type: 'card.delete', id })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, qc, clearSelection])

  const labelPresence = useCallback((labelId: string): LabelPresence => {
    const cards = currentSelectedCards()
    if (cards.length === 0) return 'none'
    const have = cards.filter((c) => c.labelIds.includes(labelId)).length
    return have === 0 ? 'none' : have === cards.length ? 'all' : 'some'
  }, [])

  const selectedCards = useMemo(
    () =>
      board.lists.flatMap((l) => l.cards).filter((c) => selectedIds.has(c.id)),
    [board, selectedIds]
  )
  const bulkActions: BulkActions = {
    count: selectedIds.size,
    allComplete:
      selectedCards.length > 0 && selectedCards.every((c) => c.completed),
    labels: board.labels,
    labelPresence,
    lists: board.lists
      .filter((l) => !l.closed)
      .map((l) => ({ id: l.id, name: l.name })),
    onToggleComplete: bulkToggleComplete,
    onSetPriority: bulkSetPriority,
    onToggleLabel: bulkToggleLabel,
    onMoveTo: bulkMoveTo,
    onDelete: bulkDelete,
    onClear: clearSelection
  }
  // Ref + stable render fn so a card's `bulkMenu` prop identity never
  // changes (keeps the memoised cards from re-rendering every update).
  const bulkActionsRef = useRef(bulkActions)
  bulkActionsRef.current = bulkActions
  const multiSelectActive = selectedIds.size > 1
  const renderBulkMenu = useCallback(
    (close: () => void) => (
      <BulkCardMenu actions={bulkActionsRef.current} close={close} />
    ),
    []
  )

  const handlers: Partial<Record<ActionId, (e: KeyboardEvent) => void>> = {
    // --- Focus navigation ---
    'card.focusNext': (e) => {
      consume(e)
      if (!focusedCardId) {
        focusCard(firstAnyCard())
        return
      }
      const loc = locateCard(focusedCardId)
      if (!loc) return
      const next = loc.list.cards[loc.cardIdx + 1]
      if (next) focusCard(next.id)
    },
    'card.focusPrev': (e) => {
      consume(e)
      if (!focusedCardId) {
        focusCard(firstAnyCard())
        return
      }
      const loc = locateCard(focusedCardId)
      if (!loc) return
      const prev = loc.list.cards[loc.cardIdx - 1]
      if (prev) focusCard(prev.id)
    },
    'card.focusLeft': (e) => {
      consume(e)
      if (!focusedCardId) {
        focusCard(firstAnyCard())
        return
      }
      const loc = locateCard(focusedCardId)
      if (!loc) return
      const vis = visibleListsFn()
      // Scan past any empty lists so a layout like
      //   [L1 cards] [L2 empty] [L3 cards]
      // doesn't trap focus in L1 (the immediate-neighbour bail used to
      // make L3 keyboard-unreachable from L1).
      const leftIdx = findNextNonEmptyListIndex(vis, loc.listIdx, -1)
      if (leftIdx === null) return
      const leftList = vis[leftIdx]!
      // Match the row index when possible so vertical-then-horizontal
      // navigation lands on the same "row" - Trello does this too.
      const targetIdx = Math.min(loc.cardIdx, leftList.cards.length - 1)
      focusCard(leftList.cards[targetIdx]!.id)
    },
    'card.focusRight': (e) => {
      consume(e)
      if (!focusedCardId) {
        focusCard(firstAnyCard())
        return
      }
      const loc = locateCard(focusedCardId)
      if (!loc) return
      const vis = visibleListsFn()
      const rightIdx = findNextNonEmptyListIndex(vis, loc.listIdx, 1)
      if (rightIdx === null) return
      const rightList = vis[rightIdx]!
      const targetIdx = Math.min(loc.cardIdx, rightList.cards.length - 1)
      focusCard(rightList.cards[targetIdx]!.id)
    },

    // --- Card actions ---
    'card.open': (e) => {
      if (!focusedCardId) return
      consume(e)
      setOpenCardId(focusedCardId)
    },
    // Keyboard equivalent of Ctrl/Cmd+click: toggle the focused card in
    // the multi-selection. Makes the select feature reachable (and
    // discoverable in Settings -> Shortcuts) without a pointer.
    'card.toggleSelect': (e) => {
      if (!focusedCardId) return
      consume(e)
      const id = focusedCardId
      setSelectedIds((prev) => toggleSelection(prev, id))
      selectionAnchorRef.current = id
    },
    'card.toggleComplete': (e) => {
      if (!focusedCardId) return
      const card = findCard(focusedCardId)
      if (!card) return
      consume(e)
      apply(
        {
          type: 'card.update',
          id: card.id,
          patch: { completed: !card.completed }
        },
        (b) =>
          mapLists(b, (l) => ({
            ...l,
            cards: l.cards.map((c) =>
              c.id === card.id ? { ...c, completed: !c.completed } : c
            )
          }))
      )
    },
    'card.delete': (e) => {
      if (!focusedCardId) return
      consume(e)
      // Pick a neighbour to inherit focus BEFORE firing the delete so
      // the user can keep deleting / navigating without scrolling
      // back. Preference order: next card in the same list → previous
      // card in the same list → first card in an adjacent list →
      // null. Computed off the current board view (synchronous) so
      // it's reliable even though the delete + refetch are async.
      const loc = locateCard(focusedCardId)
      let nextFocus: string | null = null
      if (loc) {
        const siblings = loc.list.cards
        const below = siblings[loc.cardIdx + 1]
        const above = siblings[loc.cardIdx - 1]
        if (below) nextFocus = below.id
        else if (above) nextFocus = above.id
        else {
          // List would become empty - jump to whichever adjacent list
          // has a card. Try right first, then left.
          const vis = visibleListsFn()
          const right = vis[loc.listIdx + 1]?.cards[0]
          const left = vis[loc.listIdx - 1]?.cards[0]
          nextFocus = right?.id ?? left?.id ?? null
        }
      }
      // No confirm prompt - the user explicitly invoked the shortcut,
      // and there's no Undo button anywhere else in the app either.
      // Fire-and-forget; the next refetch reconciles.
      void ipc
        .mutate({ type: 'card.delete', id: focusedCardId })
        .catch(() => {})
        .finally(() => {
          void qc.invalidateQueries({ queryKey: key })
        })
      // Hand focus to the neighbour now - focusCard scrolls it into
      // view too, so spam-delete keeps the cursor anchored where the
      // user is reading.
      focusCard(nextFocus)
    },
    'card.moveUp': (e) => {
      if (!focusedCardId) return
      const loc = locateCard(focusedCardId)
      if (!loc) return
      // Sorted lists own ordering server-side - refuse with no-op
      // rather than a confusing "moves and snaps back."
      if (loc.list.sortMode != null) return
      if (loc.cardIdx === 0) return
      consume(e)
      const target = loc.list.cards[loc.cardIdx - 1]!
      const before = loc.list.cards[loc.cardIdx - 2]?.id ?? null
      moveCardTo(focusedCardId, loc.list.id, before, target.id)
    },
    'card.moveDown': (e) => {
      if (!focusedCardId) return
      const loc = locateCard(focusedCardId)
      if (!loc) return
      if (loc.list.sortMode != null) return
      if (loc.cardIdx >= loc.list.cards.length - 1) return
      consume(e)
      const target = loc.list.cards[loc.cardIdx + 1]!
      const after = loc.list.cards[loc.cardIdx + 2]?.id ?? null
      moveCardTo(focusedCardId, loc.list.id, target.id, after)
    },
    'card.moveLeft': (e) => {
      if (!focusedCardId) return
      const loc = locateCard(focusedCardId)
      if (!loc) return
      const vis = visibleListsFn()
      const leftList = vis[loc.listIdx - 1]
      if (!leftList) return
      consume(e)
      // Drop at the end of the target list so the keyboard move is
      // predictable (no guessing about which slot to insert into).
      const lastId = leftList.cards.at(-1)?.id ?? null
      moveCardTo(focusedCardId, leftList.id, lastId, null)
    },
    'card.moveRight': (e) => {
      if (!focusedCardId) return
      const loc = locateCard(focusedCardId)
      if (!loc) return
      const vis = visibleListsFn()
      const rightList = vis[loc.listIdx + 1]
      if (!rightList) return
      consume(e)
      const lastId = rightList.cards.at(-1)?.id ?? null
      moveCardTo(focusedCardId, rightList.id, lastId, null)
    },

    // --- Creation ---
    'list.newCard': (e) => {
      // If a card is focused, target its list; otherwise the first
      // visible list. AddCard listens for this custom event on its
      // own list id and focuses the input - keeps the cross-cut
      // decoupled from a ref chain.
      const vis = visibleListsFn()
      let targetListId: string | null = null
      if (focusedCardId) {
        const loc = locateCard(focusedCardId)
        if (loc) targetListId = loc.list.id
      }
      if (!targetListId) targetListId = vis[0]?.id ?? null
      if (!targetListId) return
      consume(e)
      document.dispatchEvent(
        new CustomEvent('kanbini:add-card', { detail: { listId: targetListId } })
      )
    },
    'board.newList': (e) => {
      consume(e)
      document.dispatchEvent(new CustomEvent('kanbini:add-list'))
    }
  }

  useShortcutDispatch(bindings, handlers)

  function onDragStart(e: DragStartEvent): void {
    const activeId = String(e.active.id)
    // Re-arm the smooth-pickup ease (cards + lists) and drive its rAF tick
    // for the catch-up window so the overlay glides off the source.
    pickup.reset()
    startPickupAnim()
    clearCrossDwell() // no stale pending cross-list commit from a prior drag
    // List-column drag: record which list is moving (drives the overlay
    // preview) and bail before any of the card-specific setup.
    if (isListSortableId(activeId)) {
      setDraggingListId(listIdFromSortable(activeId))
      return
    }
    snapshot.current = qc.getQueryData<BoardView | null>(key) ?? null
    setDragging(findCard(activeId) ?? null)
    // Multi-card drag: grabbing one of 2+ selected cards drags the whole
    // selection. Capture the block in pre-drag board order (off the
    // snapshot) so they re-cluster in that order on drop. Swimlane mode
    // keeps single-card drag for now (its drop math is separate).
    const sel = selectedIdsRef.current
    if (!board.board.swimlaneMode && sel.has(activeId) && sel.size > 1) {
      const snap = snapshot.current
      multiDragBlockRef.current = (snap ?? board).lists
        .flatMap((l) => l.cards)
        .filter((c) => sel.has(c.id))
        .map((c) => c.id)
      setMultiDragActive(true)
    } else {
      multiDragBlockRef.current = []
      setMultiDragActive(false)
    }
    // Cursor starts on the source card you just clicked, so the
    // overlay that mounts at that rect is under the cursor too.
    // Mouse handlers on the live inner div take over from here.
    overlayHoveredRef.current = true
  }

  // Reorder the cache LIVE while dragging so the placeholder is the
  // final position (consistency) and siblings animate (no drop snap).
  function onDragOver(e: DragOverEvent): void {
    const { active, over } = e
    // List-column drag: horizontalListSortingStrategy glides the sibling
    // columns via pure CSS transforms, so there's nothing to reorder in
    // the cache here. The final order is applied once on drop.
    if (isListSortableId(String(active.id))) return
    if (!over) {
      setBlockedListId(null)
      clearCrossDwell()
      return
    }
    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId === overId) return

    // ADR-0037 slice 2 swimlane mode: skip live cache reorder. The
    // priority + position transition during cross-lane drag is
    // tricky to optimistically reflect (cards live in `list.cards`
    // ordered by fractional index; lanes are filtered views), so for
    // v1 we snap on drop and let the broadcastChange refetch settle
    // the new positions. Same-cell reorder loses the buttery feel -
    // tradeoff for shipping the feature now; can be revisited.
    if (board.board.swimlaneMode) return

    // Card-limit drag block: refuse a cross-list move into a list
    // that's at its limit. Leave the cache untouched so the card never
    // enters (nothing to snap back) and flag the list so it shakes.
    if (blockDrag) {
      const cur = qc.getQueryData<BoardView | null>(key)
      if (cur) {
        const blocked = findWipBlock(cur, activeId, overId)
        if (blocked) {
          setBlockedListId(blocked)
          clearCrossDwell()
          return
        }
      }
    }
    setBlockedListId(null)

    const cur = qc.getQueryData<BoardView | null>(key)
    if (!cur) return
    // ADR-0032: only block *within-list* reorders on sorted lists -
    // a card's position there is decided by created_at, so dragging
    // it next to a sibling would visually re-snap on the next read.
    // Cross-list drops INTO a sorted list are allowed: the card
    // lands with whatever optimistic slot we pick here and the
    // server-side ORDER BY puts it in its created_at position on
    // refetch (~10–50 ms - a brief settle, no permanent oddness).
    if (isSortedListReorder(cur, activeId, overId)) return

    const fromId = listOf(cur, activeId)
    const toId = listOf(cur, overId)

    // SAME-LIST reorder: do NOT mutate the cache here. dnd-kit's
    // verticalListSortingStrategy already glides the siblings via pure
    // CSS transforms (cheap, GPU-composited). Live-reordering the array
    // on top of that re-renders EVERY card in the list on every
    // onDragOver frame AND triggers dnd-kit's internal
    // `useDerivedTransform` FLIP - which is the per-frame getClientRect
    // reflow storm behind the drag jank, and the StrictMode-dev
    // "Maximum update depth exceeded" crash (the FLIP's layout effect
    // sets state keyed on the item's index, which the live reorder
    // churns every frame). Skipping the reorder leaves `index` stable
    // so the FLIP never fires; the final order is applied once on drop
    // (onDragEnd). Also stand down any pending cross-list commit - we're
    // back over the card's own list.
    if (fromId && toId && fromId === toId) {
      clearCrossDwell()
      return
    }
    if (!toId) return

    // CROSS-LIST: resolve the drop slot from rect math, then DWELL before
    // committing. We do NOT splice the card into this list yet - only once the
    // cursor has lingered here for CROSS_LIST_DWELL_MS. A fast sweep crosses a
    // list in less than that, so it never commits (no bounce, no re-render
    // churn, no opaque flash). The timer fires the commit even if the cursor
    // then stops; a drop that beats it is placed directly in onDragEnd.
    const aRect = active.rect.current.translated
    const oRect = over.rect
    const below = !!aRect && aRect.top > oRect.top + oRect.height / 2
    const position: 'before' | 'after' = below ? 'after' : 'before'
    const pending = pendingCrossRef.current
    if (!pending || pending.toListId !== toId) {
      // Newly over this list: arm the dwell timer from first entry.
      pendingCrossRef.current = { activeId, overId, toListId: toId, position }
      if (dwellTimerRef.current !== null) clearTimeout(dwellTimerRef.current)
      dwellTimerRef.current = setTimeout(commitCrossDwell, CROSS_LIST_DWELL_MS)
    } else {
      // Still over the same list, moving within it: refine the drop slot but
      // let the timer keep counting from when we first entered.
      pending.overId = overId
      pending.position = position
    }
  }

  function onDragEnd(e: DragEndEvent): void {
    // Stop the pickup catch-up tick - the drop animation owns the release.
    stopPickupAnim()
    // Cancel any pending cross-list dwell - the drop below decides placement
    // directly; a timer firing after the drop would corrupt the cache.
    clearCrossDwell()
    // List-column drag has its own persist path (no card snapshot /
    // multi-select / hover bookkeeping applies).
    if (isListSortableId(String(e.active.id))) {
      onListDragEnd(e)
      return
    }
    setDragging(null)
    setBlockedListId(null)
    const isMulti = multiDragActive
    const block = multiDragBlockRef.current
    setMultiDragActive(false)
    multiDragBlockRef.current = []
    // Snapshot cursor-on-overlay at the moment of release into the
    // React state that the dropped SortableCard reads via prop.
    // captureHoverForDrop clears any prior timeout first - second
    // drag mid-cooldown would otherwise have the first drag's
    // pending reset flip its hover-match off too early.
    captureHoverForDrop()
    const snap = snapshot.current
    snapshot.current = null
    const activeId = String(e.active.id)

    if (!e.over) {
      // Dropped outside any droppable: revert. flushSync makes the
      // DOM reflect the snapshot BEFORE dnd-kit measures the source
      // for its drop animation, so the overlay glides to the
      // original slot (buttery) instead of snapping.
      if (snap) flushSync(() => qc.setQueryData(key, snap))
      // Belt-and-braces: if `snap` was somehow missed, a refetch from
      // the DB (which still has the truth) corrects the cache.
      void qc.invalidateQueries({ queryKey: key })
      return
    }
    // ADR-0037 slice 2: swimlane mode has its own drag-end path
    // because onDragOver did NOT pre-place the card in the new cell
    // (no live cache reorder). Determine the target from `over.id`
    // and persist via card.move + (if lane changed) card.update.
    const mode = board.board.swimlaneMode
    if (mode) {
      onSwimlaneDragEnd(e, mode)
      return
    }
    let b = qc.getQueryData<BoardView | null>(key)
    if (!b) return
    // Place the dropped card at its final slot. With the cross-list DWELL,
    // onDragOver may NOT have committed the move (a fast drop can beat the
    // dwell timer), so onDragEnd is self-sufficient: it reduces from `over`
    // for CROSS-list drops too, not just same-list. dnd-kit's sorting strategy
    // animated same-list siblings during the drag, so applying the reorder
    // once here lands the card where it visually sat. A WIP-full target is
    // refused here (so the limit holds on a fast drop, not only on hover) by
    // skipping the placement - the card then resolves to wherever it currently
    // sits (its source if uncommitted) and the unchanged-move check reverts
    // it. Sorted-list same-list reorders stay a no-op (isSortedListReorder),
    // and a drop back on the source slot is a no-op (reduceCardMove returns
    // `prev`). Multi-drag + single move below both read this reordered `b`.
    {
      const overId = String(e.over.id)
      const wipBlocked = blockDrag && !!findWipBlock(b, activeId, overId)
      if (!wipBlocked && !isSortedListReorder(b, activeId, overId)) {
        const aRect = e.active.rect.current.translated
        const oRect = e.over.rect
        const below = !!aRect && aRect.top > oRect.top + oRect.height / 2
        const position: 'before' | 'after' = below ? 'after' : 'before'
        const reordered = reduceCardMove(b, activeId, overId, position)
        if (reordered !== b) {
          b = reordered
          qc.setQueryData<BoardView | null>(key, b)
        }
      }
    }
    const target = computeMoveTarget(b, activeId)
    if (!target) return
    const { toListId: toId, beforeId, afterId } = target

    // Unchanged vs the pre-drag snapshot → restore & skip the write.
    if (isUnchangedMove(snap, b, activeId)) {
      if (snap) qc.setQueryData(key, snap)
      return
    }

    // Multi-card drag: re-cluster the WHOLE selection at the lead's drop
    // spot instead of moving only the lead. The lead is already placed in
    // `b` by the live reorder; planMultiCardMove finds the non-selected
    // neighbours that bound the block, then we move each selected card
    // there in order, chaining `beforeId` so they land contiguous. The
    // whole gesture ships as ONE mutateBatch - applied sequentially in
    // one transaction server-side (each fractional key minted against
    // the previous card's freshly-written position) and recorded as a
    // single undo-log group, so one Ctrl+Z puts the entire block back.
    if (isMulti && block.length > 1) {
      const destList = b.lists.find((l) =>
        l.cards.some((c) => c.id === activeId)
      )
      const plan = destList
        ? planMultiCardMove(destList.cards, activeId, selectedIdsRef.current, block)
        : null
      if (destList && plan) {
        let prev = plan.beforeId
        const moves: Mutation[] = plan.orderedIds.map((id) => {
          const m: Mutation = {
            type: 'card.move',
            id,
            toListId: destList.id,
            beforeId: prev,
            afterId: plan.afterId
          }
          prev = id
          return m
        })
        void ipc
          .mutateBatch(moves)
          .catch(() => {})
          .finally(() => {
            void qc.invalidateQueries({ queryKey: key })
          })
        return
      }
      // plan failed (lead vanished) → fall through to the single move.
    }

    // dnd-kit's drop animation runs `scrollIntoView` on the source
    // card when it landed fully off-screen - which happens on a fast
    // flick the viewport couldn't autoscroll fast enough to follow.
    // Untouched, that reveal is an instant 200px+ yank. Flip the
    // scroll container to `scroll-behavior: smooth` for the drop
    // window so it glides instead, then clear it so the NEXT drag's
    // autoscroll stays instant (smooth autoscroll feels laggy).
    const scroller = document.querySelector('main')
    if (scroller instanceof HTMLElement) {
      scroller.style.scrollBehavior = 'smooth'
      setTimeout(() => {
        scroller.style.scrollBehavior = ''
      }, 500)
    }
    void ipc
      .mutate({
        type: 'card.move',
        id: activeId,
        toListId: toId,
        beforeId,
        afterId
      })
      .catch(() => {
        if (snap) qc.setQueryData(key, snap)
      })
      .finally(() => {
        void qc.invalidateQueries({ queryKey: key })
      })
  }

  /** Swimlane-mode drag end (ADR-0037 slice 2). Snap-on-drop: the
   *  cache wasn't pre-reordered in `onDragOver`, so the target list /
   *  lane / position all come from the live drop event. May fire TWO
   *  mutations - `card.move` for list+position, `card.update` for
   *  the new priority - sequential, both recorded on the undo stack
   *  (each step is independently undoable). The renderer's broadcast-
   *  change subscription invalidates and the lanes re-render. */
  function onSwimlaneDragEnd(e: DragEndEvent, mode: SwimlaneMode): void {
    const b = qc.getQueryData<BoardView | null>(key)
    if (!b || !e.over) return
    const activeId = String(e.active.id)
    const overId = String(e.over.id)
    const aRect = e.active.rect.current.translated
    const oRect = e.over.rect
    const below = !!aRect && aRect.top > oRect.top + oRect.height / 2
    const position: 'before' | 'after' = below ? 'after' : 'before'
    const plan = planSwimlaneDrop(b, activeId, overId, mode, position, blockDrag)
    if (plan.kind === 'noop') return
    if (plan.kind === 'blocked') {
      void qc.invalidateQueries({ queryKey: key })
      return
    }
    void ipc
      .mutate({
        type: 'card.move',
        id: activeId,
        toListId: plan.toListId,
        beforeId: plan.beforeId,
        afterId: plan.afterId
      })
      .then(() => {
        if (plan.kind === 'move-and-update') {
          return ipc.mutate({
            type: 'card.update',
            id: activeId,
            patch: { priority: plan.newPriority }
          })
        }
      })
      .catch(() => {
        /* let the invalidate snap state back to truth */
      })
      .finally(() => {
        void qc.invalidateQueries({ queryKey: key })
      })
  }

  /** List-column drag end. The strategy already glided the siblings, so
   *  we just resolve the dropped-on column, compute the fractional-index
   *  neighbours, and persist via the standard `apply` path (optimistic
   *  reorder + undo-recorded list.move). */
  function onListDragEnd(e: DragEndEvent): void {
    setDraggingListId(null)
    const { active, over } = e
    if (!over) return
    const overId = String(over.id)
    if (!isListSortableId(overId)) return
    const activeListId = listIdFromSortable(String(active.id))
    const overListId = listIdFromSortable(overId)
    const visibleIds = board.lists
      .filter((l) => !l.closed)
      .map((l) => l.id)
    const plan = planListMove(visibleIds, activeListId, overListId)
    if (!plan) return
    apply(
      {
        type: 'list.move',
        id: activeListId,
        beforeId: plan.beforeId,
        afterId: plan.afterId
      },
      (b) => ({ ...b, lists: reorderVisibleLists(b.lists, plan.orderedIds) })
    )
  }

  function onDragCancel(): void {
    stopPickupAnim()
    clearCrossDwell()
    // A cancelled list drag just clears the overlay state - no cache was
    // touched during the drag.
    if (draggingListId) {
      setDraggingListId(null)
      return
    }
    setDragging(null)
    setBlockedListId(null)
    setMultiDragActive(false)
    multiDragBlockRef.current = []
    // Cancel still runs dnd-kit's drop animation (overlay glides back
    // to the source position), so the same handoff problem applies -
    // capture cursor-on-overlay state for the cancelled card too.
    captureHoverForDrop()
    const snap = snapshot.current
    snapshot.current = null
    if (snap) flushSync(() => qc.setQueryData(key, snap))
    void qc.invalidateQueries({ queryKey: key })
  }

  const draggingList = draggingListId
    ? (board.lists.find((l) => l.id === draggingListId) ?? null)
    : null

  return (
    <>
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {/* Click anywhere on the board surface that *isn't* a card
          clears the keyboard-nav focus ring. Without this, focusing
          a card then clicking elsewhere (the list header, empty list
          space, the AddCard input) leaves the orphan ring in place
          until you press Esc or arrow-key to a new card. Scoped to
          the board's children only so popovers / modals / the header
          aren't affected; uses event delegation on a single wrapper
          rather than per-element bubbling listeners. */}
      <div
        onClick={(e) => {
          // A click on the board surface that isn't a card clears both
          // the keyboard-nav focus ring AND the multi-selection.
          if (!(e.target as HTMLElement).closest('[data-card-id]')) {
            focusCard(null)
            clearSelection()
          }
        }}
      >
      {(() => {
        const visibleLists = board.lists.filter((list) => !list.closed)
        const addList = (name: string): void => {
          apply(
            { type: 'list.create', boardId: board.board.id, name },
            (b) => ({
              ...b,
              lists: [
                ...b.lists,
                {
                  id: `tmp-${crypto.randomUUID()}`,
                  name,
                  color: null,
                  closed: false,
                  position: 'zzzz',
                  wipLimit: null,
                  sortMode: null,
                  onEnter: null,
                  cards: []
                }
              ]
            })
          )
        }
        // Fresh boards (zero non-closed lists) get a centered welcome
        // panel instead of just the small "+ Add a list" stub - a
        // brand-new user shouldn't have to hunt for the affordance.
        // Once any list exists, the regular kanban row + the small
        // stub are back so adding more lists works the way it always
        // has.
        if (visibleLists.length === 0) {
          return <BoardEmptyState onAdd={addList} />
        }
        // ADR-0037 slice 2 swimlane layout - when the board carries a
        // non-null `swimlaneMode` we re-flow into lane rows. The
        // parent's <DndContext> is unchanged; per-(list, lane) cells
        // register their own droppables under `lane:<key>:list:<id>`.
        if (board.board.swimlaneMode) {
          return (
            <SwimlaneBoard
              board={board}
              mode={board.board.swimlaneMode}
              addList={addList}
              apply={apply}
              blockCreate={blockCreate}
              renderCards={(_list, _laneKey, cards) =>
                cards.map((card) => (
                  <SortableCard
                    key={card.id}
                    card={card}
                    labels={board.labels}
                    apply={apply}
                    showChecklist={showChecklist}
                    labelsExpanded={labelsExpanded}
                    onToggleLabelsExpanded={onToggleLabelsExpanded}
                    anyDragging={dragging != null}
                    focused={focusedCardId === card.id}
                    selected={selectedIds.has(card.id)}
                    multiActive={multiSelectActive}
                    multiDragActive={multiDragActive}
                    onCardClick={onCardClick}
                    bulkMenu={renderBulkMenu}
                    postDropHoverMatch={postDropHoverMatch}
                  />
                ))
              }
            />
          )
        }
        return (
          <div className="flex items-start gap-4">
            <SortableContext
              items={listColItemIds}
              strategy={horizontalListSortingStrategy}
            >
              {visibleLists.map((list, i) => (
                <ListColumn
                  key={list.id}
                  list={list}
                  labels={board.labels}
                  apply={apply}
                  blockCreate={blockCreate}
                  blocked={blockedListId === list.id}
                  showChecklist={showChecklist}
                  labelsExpanded={labelsExpanded}
                  onToggleLabelsExpanded={onToggleLabelsExpanded}
                  anyDragging={dragging != null || draggingListId != null}
                  focusedCardId={focusedCardId}
                  selectedIds={selectedIds}
                  multiActive={multiSelectActive}
                  multiDragActive={multiDragActive}
                  onCardClick={onCardClick}
                  bulkMenu={renderBulkMenu}
                  postDropHoverMatch={postDropHoverMatch}
                  onMoveList={moveListByDir}
                  canMoveLeft={i > 0}
                  canMoveRight={i < visibleLists.length - 1}
                />
              ))}
            </SortableContext>
            <AddList onAdd={addList} boardId={board.board.id} />
          </div>
        )
      })()}
      </div>

      <DragOverlay
        dropAnimation={DROP_ANIMATION}
        // Smooth pickup: eases the overlay from the source to the cursor so
        // it doesn't snap on grab (see the `pickup` comment above). Visual
        // only - collision + drop animation are unaffected.
        modifiers={overlayModifiers}
        // LIFT_SHADOW lives HERE on the overlay wrapper (not on
        // CardFace's inline style) so DROP_ANIMATION's keyframes -
        // which `.animate()` runs against this wrapper element -
        // are the only thing painting the visible big shadow. With
        // the shadow also on CardFace it summed with the animated
        // one and the animation was invisible to the eye. The
        // `rounded-md` border-radius matches CardFace so the
        // shadow follows the card's rounded corners cleanly.
        style={{ boxShadow: LIFT_SHADOW, borderRadius: '0.375rem' }}
      >
        {dragging && (
          // No explicit width: dnd-kit sets the overlay container to
          // the source element's exact dimensions, so the CardFace
          // inside renders at the same width as the resting card and
          // the title wraps identically. Setting `w-68` here used to
          // make the overlay ~2 px wider, enough to shift a wrap.
          // `zoom` mirrors the App.tsx wrapper so the dragged card's
          // text/padding scale matches the source - see the prop's
          // docstring above. Omitted at 1× so the resulting style
          // attribute stays empty.
          //
          // `group/dragoverlay` + `h-full w-full` make this div a
          // CSS-:hover group whose hit area matches the visible card.
          // CardFace below uses `group-hover/dragoverlay:border-ring/60`
          // so the blue hover border is purely CSS-cascade driven -
          // no React state, no prop, no useEffect. That's load-bearing
          // because dnd-kit clones the LAST render of these children
          // for the drop animation (a frozen snapshot); any
          // React state we tried to thread through `hovered={…}`
          // wouldn't reach the snapshot. CSS :hover responds to the
          // cursor directly on the live DOM node regardless.
          //
          // mouseenter/leave separately update a REF - read at
          // onDragEnd to decide whether the dropped SortableCard
          // should force-paint hover styles during postDropHold. This
          // is the live render (pre-clone), so handlers do fire here;
          // the value they write is what we snapshot to make the
          // cursor-stays vs cursor-off branches resolve correctly.
          <div
            className="group/dragoverlay relative h-full w-full cursor-grabbing"
            style={
              boardZoom !== 1
                ? ({ zoom: boardZoom } as CSSProperties)
                : undefined
            }
            onMouseEnter={() => {
              overlayHoveredRef.current = true
            }}
            onMouseLeave={() => {
              overlayHoveredRef.current = false
            }}
          >
            <CardFace
              card={dragging}
              labels={board.labels}
              dragging
              focused={focusedCardId === dragging.id}
              selected={selectedIds.has(dragging.id)}
              showChecklist={showChecklist}
              labelsExpanded={labelsExpanded}
            />
            {/* Multi-card drag: a count badge so it's clear the whole
                selection is moving, not just the grabbed card. */}
            {multiDragActive && selectedIds.size > 1 && (
              <span className="absolute -right-2 -top-2 z-10 flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-xs font-semibold text-primary-foreground shadow">
                {selectedIds.size}
              </span>
            )}
          </div>
        )}
        {draggingList && (
          // A static clone of the dragged column. dnd-kit sizes the
          // overlay to the source column's rect, so the preview matches
          // pixel-for-pixel; `zoom` mirrors App's board wrapper (the
          // overlay is body-portaled, same caveat as the card overlay).
          <div
            className="cursor-grabbing"
            style={
              boardZoom !== 1 ? ({ zoom: boardZoom } as CSSProperties) : undefined
            }
          >
            <ListColumnPreview
              list={draggingList}
              labels={board.labels}
              showChecklist={showChecklist}
              labelsExpanded={labelsExpanded}
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
    <SelectionBar actions={bulkActions} />
    <CardDetail
      boardId={board.board.id}
      cardId={openCardId}
      onClose={() => setOpenCardId(null)}
    />
    </>
  )
}

/** Short label + full description for the list-header "sorted" chip, one
 *  per non-manual sort mode. The chip is a tiny uppercase pill, so the
 *  short text stays terse; the full string is the aria-label + tooltip. */
const SORT_CHIP: Record<ListSortMode, { short: string; full: string }> = {
  'created-desc': { short: 'New', full: 'Sorted by newest created' },
  'created-asc': { short: 'Old', full: 'Sorted by oldest created' },
  'added-desc': { short: 'Recent', full: 'Sorted by recently added to list' },
  'added-asc': { short: 'First', full: 'Sorted by first added to list' },
  'due-asc': { short: 'Due', full: 'Sorted by due date' },
  'title-asc': { short: 'A-Z', full: 'Sorted A to Z' },
  'title-desc': { short: 'Z-A', full: 'Sorted Z to A' },
  'priority-desc': { short: 'Priority', full: 'Sorted by priority' }
}

/** The list's coloured header strip - name + sort chip + WIP count +
 *  pencil → ListEditor context menu. Extracted from `ListColumn` so
 *  the swimlane layout (ADR-0037 slice 2) can render a single row of
 *  list headers at the top of the board instead of repeating one in
 *  each lane cell. Width-flexible: caller controls the surrounding
 *  container (`w-72` in both kanban layouts today). */
export function ListHeader({
  list,
  apply,
  dragListeners,
  onMove,
  canMoveLeft,
  canMoveRight
}: {
  list: BoardView['lists'][number]
  apply: (m: Mutation, o: Optimistic) => void
  /** dnd-kit pointer listeners for the whole-header drag handle. When
   *  omitted (e.g. the swimlane header row) the header isn't draggable.
   *  Listeners only - NOT `attributes` (see the <h2> for why). */
  dragListeners?: DraggableSyntheticListeners
  /** Menu fallback for reorder (no-pointer / keyboard path). */
  onMove?: (dir: -1 | 1) => void
  canMoveLeft?: boolean
  canMoveRight?: boolean
}) {
  const atLimit =
    list.wipLimit != null && list.cards.length >= list.wipLimit
  const [saveTplOpen, setSaveTplOpen] = useState(false)
  return (
    <>
    <ContextMenu
      width={256}
      menu={(close) => (
        <ListEditor
          list={list}
          apply={apply}
          close={close}
          onSaveAsTemplate={() => setSaveTplOpen(true)}
          onMove={onMove}
          canMoveLeft={canMoveLeft}
          canMoveRight={canMoveRight}
        />
      )}
    >
      {(open) => (
        // The WHOLE header is the drag handle (like a card's whole <li>),
        // so a list reorders by grabbing it anywhere - not just a tiny
        // grip. The 6 px PointerSensor distance keeps a plain click
        // (pencil / nothing) from starting a drag, and interactive
        // children stop pointerdown propagation so they never start one
        // either. Cards inside the column have their own listeners on
        // their own <li>, so grabbing a card drags the card, not the
        // list. The grip icon is now just a visual "you can drag this"
        // cue.
        //
        // Only the drag LISTENERS go here, NOT dnd-kit's `attributes`:
        // those set role="button", which would clobber the <h2>'s heading
        // role (breaks a11y + the getByRole('heading') the e2e specs use
        // to find list headers). Pointer dragging only needs the
        // listeners; the keyboard reorder path is the menu's Move
        // left/right (there's no KeyboardSensor registered anyway).
        <h2
          {...dragListeners}
          onContextMenu={open}
          title={dragListeners ? 'Drag to reorder list' : undefined}
          style={
            list.color
              ? { backgroundColor: tint(list.color, 45, 'var(--color-background)') }
              : undefined
          }
          className={`flex items-center gap-2 px-3 py-2 text-sm font-medium ${
            dragListeners
              ? 'cursor-grab touch-none active:cursor-grabbing'
              : ''
          }`}
        >
          {dragListeners && (
            <GripVertical
              aria-hidden
              className="-ml-1 size-4 shrink-0 text-muted-foreground/50"
            />
          )}
          <span className="flex-1 truncate">{list.name}</span>
          {list.sortMode && (
            <span
              aria-label={SORT_CHIP[list.sortMode].full}
              title={SORT_CHIP[list.sortMode].full}
              className="inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              <ArrowDownUp className="size-3" />
              {SORT_CHIP[list.sortMode].short}
            </span>
          )}
          <span
            className={`text-xs ${
              atLimit ? 'text-red-400' : 'text-muted-foreground'
            }`}
          >
            {list.wipLimit != null
              ? `${list.cards.length} / ${list.wipLimit}`
              : list.cards.length}
          </span>
          <button
            aria-label="Edit list"
            onClick={open}
            onPointerDown={(e) => e.stopPropagation()}
            className="text-muted-foreground hover:text-foreground"
          >
            <Pencil className="size-3.5" />
          </button>
        </h2>
      )}
    </ContextMenu>
    <SaveTemplateDialog
      open={saveTplOpen}
      kind="list"
      sourceId={list.id}
      defaultName={list.name}
      onClose={() => setSaveTplOpen(false)}
    />
    </>
  )
}

const ListColumn = memo(function ListColumn({
  list,
  labels,
  apply,
  blockCreate,
  blocked,
  showChecklist,
  labelsExpanded,
  onToggleLabelsExpanded,
  anyDragging,
  focusedCardId,
  selectedIds,
  multiActive,
  multiDragActive,
  onCardClick,
  bulkMenu,
  postDropHoverMatch,
  onMoveList,
  canMoveLeft,
  canMoveRight
}: {
  list: BoardView['lists'][number]
  labels: LabelView[]
  apply: (m: Mutation, o: Optimistic) => void
  blockCreate: boolean
  blocked: boolean
  showChecklist: boolean
  /** Trello-style label display + its board-wide toggle, threaded down
   *  to each SortableCard. See Board's props for the full story. */
  labelsExpanded?: boolean
  onToggleLabelsExpanded?: () => void
  /** True while ANY card on the board is being dragged. Forwarded to
   *  each SortableCard so the hover height tween is suspended for the
   *  whole gesture (see `useSmoothHeight`). */
  anyDragging: boolean
  /** ADR-0035 keyboard focus - the one focused card on the board, or
   *  null when nothing is focused. Drives the focus ring on the
   *  matching `<SortableCard>`. */
  focusedCardId: string | null
  /** Multi-select set + helpers (Board owns them). `selectedIds` drives
   *  each card's selected ring; `onCardClick` decides open vs
   *  toggle/range; a right-click on a selected card (when `multiActive`)
   *  shows the `bulkMenu` instead of the single-card menu. */
  selectedIds: ReadonlySet<string>
  multiActive: boolean
  /** True while a multi-card drag is in flight - non-lead selected cards
   *  ghost in place until they re-cluster at the drop spot. */
  multiDragActive: boolean
  onCardClick: (id: string, e: React.MouseEvent) => void
  bulkMenu: (close: () => void) => React.ReactNode
  /** True when a drop just landed AND the cursor was on the overlay at
   *  release time. The matching SortableCard force-paints itself in
   *  the source's hovered styles so the unmount-handoff doesn't fire
   *  a 150 ms :hover transition. See Board's postDropHoverMatch
   *  comment for the full rationale. */
  postDropHoverMatch: boolean
  /** List reorder (header grip drag + the menu fallback). `onMoveList`
   *  is Board's stable handler; the booleans gate the menu's Move
   *  left/right at the ends. Omitted in layouts that don't reorder. */
  onMoveList?: (id: string, dir: -1 | 1) => void
  canMoveLeft?: boolean
  canMoveRight?: boolean
}) {
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `list:${list.id}`
  })
  // The whole column is a horizontal sortable. The header is the drag
  // activator (listeners spread on the <h2>, not the section, so a card
  // drag and a header drag never start from the same element); the
  // section gets the sort transform so siblings glide as it's dragged.
  // isDragging hides the source while the DragOverlay shows the preview.
  const {
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging: isListDragging,
    listeners: dragListeners
  } = useSortable({
    id: `${LIST_SORTABLE_PREFIX}${list.id}`,
    animateLayoutChanges: ({ isSorting }) => isSorting,
    transition: {
      duration: DROP_ANIMATION_DURATION_MS,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
    }
  })
  // Tee the dnd-kit refs (card-drop droppable + list sortable) AND our own
  // height-tween ref onto the one <section> node.
  const sectionElRef = useRef<HTMLElement | null>(null)
  const setSectionRef = useCallback(
    (node: HTMLElement | null): void => {
      setDroppableRef(node)
      setSortableRef(node)
      sectionElRef.current = node
    },
    [setDroppableRef, setSortableRef]
  )
  // Grow/shrink the column smoothly when a card enters/leaves it during a drag
  // (the height change snaps a card's worth of height in one frame otherwise).
  // This stays cheap + churn-free because the cross-list DWELL (see onDragOver)
  // means a card only ever enters the list it SETTLES in, not every list it
  // sweeps past - so this fires at most once per settle, never per frame.
  // Enabled only during a drag; outside one, card add/delete stays instant.
  useSmoothHeight(sectionElRef, anyDragging)
  // At/over the card limit: the badge tints, and (when the setting is
  // on) the add-card box is blocked.
  const atLimit =
    list.wipLimit != null && list.cards.length >= list.wipLimit
  // `blocked` = a card from another list is being dragged onto this
  // full list right now. The red ring holds while it hovers; the list
  // also shakes once each time a block STARTS (a false→true edge).
  // The shake alternates two identical animation classes so the CSS
  // animation reliably restarts - re-applying the same class would
  // not replay it, which left fast / back-to-back drags with no shake.
  const [shakeTick, setShakeTick] = useState(0)
  const wasBlocked = useRef(false)
  useEffect(() => {
    if (blocked && !wasBlocked.current) setShakeTick((t) => t + 1)
    wasBlocked.current = blocked
  }, [blocked])
  const shakeClass =
    shakeTick === 0 ? '' : shakeTick % 2 === 1 ? 'shake-a' : 'shake-b'
  // Stable items identity across re-renders that DON'T change the card
  // order. During a drag Board re-renders on every dragging /
  // blockedListId / sibling-card change; a fresh `list.cards.map(...)`
  // each time hands dnd-kit's SortableContext a new array, churning its
  // internal index derivation - the documented trigger for the
  // `useDerivedTransform` "Maximum update depth exceeded" crash and a
  // source of needless per-frame recompute. `list.cards` only changes
  // identity when the cache actually reorders, so key the memo on it.
  const itemIds = useMemo(() => list.cards.map((c) => c.id), [list.cards])
  return (
    <section
      ref={setSectionRef}
      style={{
        ...(list.color ? { borderColor: list.color } : null),
        transform: CSS.Transform.toString(transform),
        transition
      }}
      className={`flex w-72 shrink-0 flex-col overflow-hidden rounded-lg border bg-muted/60 pb-1 transition-colors ${
        list.color ? '' : 'border-border'
      } ${
        blocked
          ? 'ring-2 ring-red-400/70'
          : isOver
            ? 'ring-2 ring-primary/70'
            : ''
      } ${isListDragging ? 'opacity-0' : ''} ${shakeClass}`}
    >
      <ListHeader
        list={list}
        apply={apply}
        dragListeners={dragListeners}
        onMove={onMoveList ? (dir) => onMoveList(list.id, dir) : undefined}
        canMoveLeft={canMoveLeft}
        canMoveRight={canMoveRight}
      />

      <SortableContext
        items={itemIds}
        strategy={verticalListSortingStrategy}
      >
        <ul className="flex min-h-2 flex-col gap-2 px-2 pt-2">
          {list.cards.map((card) => (
            <SortableCard
              key={card.id}
              card={card}
              labels={labels}
              apply={apply}
              showChecklist={showChecklist}
              labelsExpanded={labelsExpanded}
              onToggleLabelsExpanded={onToggleLabelsExpanded}
              anyDragging={anyDragging}
              focused={focusedCardId === card.id}
              selected={selectedIds.has(card.id)}
              multiActive={multiActive}
              multiDragActive={multiDragActive}
              onCardClick={onCardClick}
              bulkMenu={bulkMenu}
              postDropHoverMatch={postDropHoverMatch}
            />
          ))}
        </ul>
      </SortableContext>

      <AddCard
        listId={list.id}
        full={atLimit && blockCreate}
        onAdd={(title) =>
          apply({ type: 'card.create', listId: list.id, title }, (b) =>
            mapLists(b, (l) =>
              l.id === list.id
                ? {
                    ...l,
                    cards: [
                      ...l.cards,
                      {
                        id: `tmp-${crypto.randomUUID()}`,
                        title,
                        description: null,
                        position: 'zzzz',
                        completed: false,
                        dueAt: null,
                        priority: null,
                        labelIds: [],
                        checklists: [],
                        comments: [],
                        attachments: [],
                        coverAttachmentId: null,
                        activities: []
                      }
                    ]
                  }
                : l
            )
          )
        }
      />
    </section>
  )
})

/** Static clone of a list column, rendered inside the DragOverlay while a
 *  list is being reordered. No dnd-kit hooks / droppables (the overlay
 *  must not register drag nodes) and no interactive chrome - just the
 *  header strip + the cards as static CardFaces so the floating column
 *  reads like the real one. dnd-kit sizes the overlay to the source
 *  column's rect, so this matches it.
 *
 *  `aria-hidden`: the real column is still in the tree during the drag,
 *  so this clone is a visual duplicate - hide it from the accessibility
 *  tree so screen readers don't announce two of every list/card, and so
 *  role queries (and the e2e getByRole('heading')) see only the real
 *  header. */
function ListColumnPreview({
  list,
  labels,
  showChecklist,
  labelsExpanded
}: {
  list: BoardView['lists'][number]
  labels: LabelView[]
  showChecklist: boolean
  labelsExpanded?: boolean
}) {
  return (
    <section
      aria-hidden
      style={list.color ? { borderColor: list.color } : undefined}
      // bg-muted/60 matches the resting column (the real section is
      // bg-muted/60 unless a card is being dragged over it); the clone
      // used opaque bg-muted, which read as the list darkening on grab.
      className={`flex w-72 shrink-0 flex-col overflow-hidden rounded-lg border bg-muted/60 pb-1 ${
        list.color ? '' : 'border-border'
      }`}
    >
      <h2
        style={
          list.color
            ? { backgroundColor: tint(list.color, 45, 'var(--color-background)') }
            : undefined
        }
        className="flex items-center gap-2 px-3 py-2 text-sm font-medium"
      >
        <GripVertical className="-ml-1 size-4 shrink-0 text-muted-foreground/60" />
        <span className="flex-1 truncate">{list.name}</span>
        <span className="text-xs text-muted-foreground">{list.cards.length}</span>
      </h2>
      <ul className="flex min-h-2 flex-col gap-2 px-2 pt-2">
        {list.cards.map((card) => (
          <li key={card.id}>
            <CardFace
              card={card}
              labels={labels}
              showChecklist={showChecklist}
              labelsExpanded={labelsExpanded}
              resting
            />
          </li>
        ))}
      </ul>
      {/* Static stand-in for the AddCard input. dnd-kit sizes the overlay
          to the SOURCE column's rect, which includes the "+ Add a card"
          row; without a matching element here the clone was shorter than
          its container and the lift shadow wrapped the empty gap below
          the cards. Mirrors AddCard's box metrics (m-2 + px-3 py-2 +
          text-sm) so the preview height matches the real column. */}
      <div className="m-2 rounded-md border border-transparent px-3 py-2 text-sm text-muted-foreground">
        + Add a card
      </div>
    </section>
  )
}

const SortableCard = memo(function SortableCard({
  card,
  labels,
  apply,
  showChecklist,
  labelsExpanded,
  onToggleLabelsExpanded,
  anyDragging,
  focused,
  selected,
  multiActive,
  multiDragActive,
  onCardClick,
  bulkMenu,
  postDropHoverMatch
}: {
  card: CardView
  labels: LabelView[]
  apply: (m: Mutation, o: Optimistic) => void
  showChecklist: boolean
  /** Trello-style label display + the board-wide toggle. Forwarded to
   *  the in-list `<CardLabels>` so a bar-click reveals names everywhere. */
  labelsExpanded?: boolean
  onToggleLabelsExpanded?: () => void
  /** True while any card on the board is being dragged - suspends this
   *  card's hover height tween for the whole gesture. */
  anyDragging: boolean
  /** ADR-0035 keyboard-focus ring (j/k nav). Separate from `selected`. */
  focused: boolean
  /** Multi-select: this card is in the selection (gets the primary ring +
   *  the corner check badge). */
  selected: boolean
  /** True when 2+ cards are selected - a right-click on a SELECTED card
   *  then shows the bulk menu instead of the single-card one. */
  multiActive: boolean
  /** True while a multi-card drag is happening. A selected card that
   *  isn't the lead ghosts in place (it re-clusters at the drop spot). */
  multiDragActive: boolean
  /** Whole-card click: open (plain) / toggle (Ctrl/Cmd) / range (Shift).
   *  Called only for clicks that didn't land on an interactive child. */
  onCardClick: (id: string, e: React.MouseEvent) => void
  /** Renders the bulk action menu for the current selection. */
  bulkMenu: (close: () => void) => React.ReactNode
  /** Board-level snapshot from onDragEnd: true when the cursor was on
   *  the overlay at release. The just-dropped card combines this with
   *  its own `postDropHold` to decide whether to force-paint the
   *  source's hovered styles. See Board's state declaration. */
  postDropHoverMatch: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: card.id,
      // Gate dnd-kit's post-drop transition (getTransition in the sortable
      // source applies the glide CSS only when this is true, or while
      // sorting). During the drag we want it ON so displaced siblings glide.
      // After the drag it must be OFF for a REAL move - otherwise the
      // just-dropped card FLIP-slides from its old slot to its new one on top
      // of the DragOverlay's drop animation (the M-review snap bug).
      //
      // BUT there's an exception that fixes the first-card "put-back" snap:
      // same-list reorder is strategy-only (onDragOver never mutates the
      // cache), so `items` is referentially UNCHANGED for the whole drag, and
      // a no-op put-back leaves it unchanged on drop too -> `previousItems ===
      // items`. A REAL move (same- or cross-list) changes the cache in
      // onDragEnd -> `previousItems !== items`. So `previousItems === items`
      // is true ONLY for the no-op case, where there's no DOM reorder and thus
      // no slide to cause - and keeping the transition ON there lets the
      // strategy-displaced sibling glide its transform back to 0 instead of
      // teleporting (the snap). Real moves fall through to `isSorting` (false
      // post-drop) exactly as before, so the slide stays fixed.
      animateLayoutChanges: ({ isSorting, previousItems, items }) =>
        isSorting || previousItems === items,
      // Match the drop animation's duration + easing so sibling shifts
      // and the released card feel like one consistent motion. Pulling
      // from the shared constant keeps them in lockstep automatically
      // if someone re-tunes the drop later.
      transition: {
        duration: DROP_ANIMATION_DURATION_MS,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
      }
    })
  // Lifted state - the ContextMenu unmounts its panel on close, so the
  // modal needs to live above it (a sibling of <ContextMenu>) to
  // survive the menu closing as it opens.
  const [urlCoverOpen, setUrlCoverOpen] = useState(false)

  // Layout-hold across the drop animation. dnd-kit clears `isDragging`
  // the instant `onDragEnd` fires - BEFORE the 200 ms drop animation
  // runs. The drag-revealed checkbox column has a 200 ms width
  // transition, so without this it'd collapse to w-0 well before the
  // overlay unmounts, and the visible card snap-shrinks at handoff.
  // 220 ms = drop duration + a 20 ms buffer so the hold survives any
  // animation-frame jitter between WAAPI's end callback and React's
  // next render. Once the hold releases, the existing 200 ms width
  // transition takes over for a graceful slide-closed if the cursor
  // isn't on the dropped card.
  const [postDropHold, setPostDropHold] = useState(false)
  const wasDraggingRef = useRef(false)
  useEffect(() => {
    if (wasDraggingRef.current && !isDragging) {
      setPostDropHold(true)
      const t = window.setTimeout(
        () => setPostDropHold(false),
        POST_DROP_HOLD_MS
      )
      wasDraggingRef.current = isDragging
      return () => window.clearTimeout(t)
    }
    wasDraggingRef.current = isDragging
  }, [isDragging])

  const toggleComplete = (): void =>
    apply(
      {
        type: 'card.update',
        id: card.id,
        patch: { completed: !card.completed }
      },
      (b) =>
        mapLists(b, (l) => ({
          ...l,
          cards: l.cards.map((c) =>
            c.id === card.id ? { ...c, completed: !c.completed } : c
          )
        }))
    )

  // Fire the card-completed celebration on every incomplete→complete
  // edge, including flips driven from the card-detail modal or from
  // an MCP write - the underlying card preview stays mounted, so the
  // hook sees the `card.completed` prop transition either way.
  // Returns 'a' / 'b' (alternating) while the animation is playing,
  // null otherwise - the alternation is what lets a rapid second
  // flip restart the CSS animation cleanly.
  const completePhase = useJustCompleted(card.completed)

  // Tween the card's height when hover-revealing the checkbox column
  // wraps the title to an extra line (or any other content reflow), so
  // it grows/shrinks smoothly instead of snapping. dnd-kit owns the
  // `<li>` via `setNodeRef`; we tee off our own ref to the same node to
  // observe it. Disabled during the drag + the post-drop hold so a
  // mid-flight height animation can't corrupt the bounding-rect dnd-kit
  // measures for the drag overlay.
  const cardElRef = useRef<HTMLLIElement | null>(null)
  const setCardRef = useCallback(
    (node: HTMLLIElement | null): void => {
      setNodeRef(node)
      cardElRef.current = node
    },
    [setNodeRef]
  )
  // Suspend the height tween for the entire drag gesture (any card),
  // not just while THIS card is the one being dragged - a sibling
  // reflow mid-drag shouldn't animate, and it keeps the observers quiet
  // while dnd-kit is measuring rects.
  useSmoothHeight(cardElRef, !anyDragging && !postDropHold)

  // Memoize the heavy, drag-invariant subtrees. A live-reorder drag
  // re-renders EVERY card in the SortableContext on every onDragOver
  // frame (they subscribe to the context to pick up their new
  // transform) - measured at ~1900 SortableCard renders for a 7-card
  // list over a few sweeps. The card's VISUAL content (cover image,
  // label chips, checklist preview) doesn't change during a drag - only
  // the `<li>`'s transform does - so memoizing these elements lets
  // React skip reconciling their subtrees entirely when the deps are
  // unchanged (same element reference => reconciler bails). The wrapper
  // still re-renders to apply the transform; the expensive children
  // don't. Cuts the per-frame work that makes dev-mode drags janky.
  // All deps are stable during a drag: `card` only changes identity on
  // a real data edit, `labels`/`apply`/`onToggleLabelsExpanded` are
  // referentially stable (board.labels, useBoardMutation, App
  // useCallback).
  const coverEl = useMemo(() => <CardCoverThumb card={card} />, [card])
  const labelsEl = useMemo(
    () => (
      <CardLabels
        labelIds={card.labelIds}
        labels={labels}
        expanded={labelsExpanded}
        onToggleExpand={onToggleLabelsExpanded}
      />
    ),
    [card.labelIds, labels, labelsExpanded, onToggleLabelsExpanded]
  )
  const checklistEl = useMemo(
    () =>
      showChecklist ? (
        <div
          className={cn(
            'transition-[margin-left] duration-200 ease-out',
            card.completed
              ? 'ml-1'
              : 'ml-0 group-hover/card:ml-4 group-focus-within/card:ml-4'
          )}
        >
          <CardChecklistPreview card={card} apply={apply} />
        </div>
      ) : null,
    [showChecklist, card, apply]
  )
  const metaEl = useMemo(
    () => (
      <div className="flex flex-wrap items-center gap-1.5">
        <PriorityBadge card={card} />
        <DueBadge card={card} />
      </div>
    ),
    [card]
  )
  // TitleUrlChip runs a URL regex over the title on every render -
  // memoize on the title so a drag's per-frame wrapper renders don't
  // re-scan it.
  const titleChipEl = useMemo(
    () => <TitleUrlChip title={card.title} />,
    [card.title]
  )

  return (
    <>
    <ContextMenu
      width={236}
      menu={(close) =>
        // Right-clicking a card that's part of a multi-selection acts on
        // the whole selection; otherwise it's the normal single-card menu.
        selected && multiActive ? (
          bulkMenu(close)
        ) : (
          <CardMenu
            card={card}
            labels={labels}
            apply={apply}
            close={close}
            onRequestCoverFromUrl={() => setUrlCoverOpen(true)}
          />
        )
      }
    >
      {(open) => (
        // Drag listeners on the whole <li> so the entire card surface
        // is a drag handle. The PointerSensor's 6 px activation
        // constraint keeps clicks from starting drags. Interactive
        // children (checkbox, pencil, title-click) stop pointerdown
        // propagation so dnd-kit never starts tracking from them -
        // belt-and-braces against any future sensor tweaks.
        <li
          ref={setCardRef}
          {...attributes}
          {...listeners}
          data-card-id={card.id}
          style={{ transform: CSS.Transform.toString(transform), transition }}
          onContextMenu={open}
          // Whole-card click: open (plain), toggle-select (Ctrl/Cmd), or
          // range-select (Shift). `onClick` only fires when pointer
          // down+up land without enough motion to trip dnd-kit's 6 px
          // activation, so a real drag never triggers this. The click
          // bubbles up from every non-interactive child (title, cover,
          // body); we bail when it originated on an interactive control
          // (the checkbox, pencil, checklist toggles, label chips, links)
          // so those keep their own behaviour and never open/select.
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button, a, input')) return
            onCardClick(card.id, e)
          }}
          className={cn(
            // `focus:outline-none` only - we deliberately DO NOT add
            // `focus-visible:ring-*` here. dnd-kit's a11y layer calls
            // `.focus()` on the source element after a drop, which
            // would paint a focus-visible ring competing with the
            // `focused` state ring (double-highlight bug seen when
            // arrow-keying after a drag). The `focused` state IS the
            // single source of truth for the keyboard-nav indicator.
            'group/card relative flex flex-col gap-1 overflow-hidden rounded-md border bg-card px-3 py-2 text-sm transition-[border-color,box-shadow] cursor-grab active:cursor-grabbing focus:outline-none',
            // Default vs `cursor-was-on-overlay-at-drop-end` styling.
            // The post-drop force matches what the DragOverlay's last
            // frame is painting (border-ring/60 + shadow-md), so when
            // the overlay unmounts the source is ALREADY at those
            // values and no transition fires. When postDropHold
            // expires (220 ms after drop), the class flips to defaults
            // - if the cursor IS still on the card, :hover-prefixed
            // utilities keep the same values (no transition); if it
            // isn't, the existing `transition-[border-color,box-shadow]`
            // 150 ms ease softens the settle.
            postDropHold && postDropHoverMatch
              ? 'border-ring/60 shadow-md'
              : 'border-border shadow-sm hover:border-ring/60 hover:shadow-md',
            // Multi-select ring (primary, slightly wider offset) takes
            // precedence over the ADR-0035 keyboard focus ring (a card can
            // be both focused and selected; the selection wins visually +
            // the corner badge below removes any ambiguity).
            selected
              ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
              : focused
                ? 'ring-2 ring-ring ring-offset-1 ring-offset-background'
                : '',
            isDragging
              ? 'opacity-0'
              : multiDragActive && selected
                ? // ghost the other selected cards - they're "coming along"
                  // and re-cluster at the drop spot
                  'opacity-40'
                : card.completed
                  ? 'opacity-70 hover:opacity-100'
                  : '',
            completePhase && `complete-celebrate-${completePhase}`
          )}
        >
          {/* No onClick: the cover is part of the card surface, so a
              click bubbles to the <li> handler (open / select).
              Memoized (coverEl / labelsEl) - see the useMemo block. */}
          {coverEl}
          {labelsEl}
          {/* Complete-checkbox hidden until card hover (or focus, or
              already-completed). The wrapper transitions width 0→6 so
              the checkbox is revealed by clipping and the title slides
              right with the flex layout - Trello-style. A completed
              card keeps the box visible so its state is obvious without
              a hover. */}
          <div className="flex items-start">
            <div
              className={cn(
                'shrink-0 overflow-hidden transition-[width] duration-200 ease-out',
                // `isDragging` keeps the column open for the duration of
                // the drag itself; `postDropHold` keeps it open for the
                // additional ~420 ms the drop animation needs to land.
                // Together they bridge the entire drag→drop window so
                // the source layout matches the overlay's captured
                // dimensions when it unmounts (no snap-shrink at
                // handoff). After the hold releases, the existing
                // 200 ms width transition reads as a graceful settle
                // if the cursor isn't already over the dropped card.
                card.completed || isDragging || postDropHold
                  ? 'w-6'
                  : 'w-0 group-hover/card:w-6 group-focus-within/card:w-6'
              )}
            >
              <button
                aria-label={
                  card.completed ? 'Mark incomplete' : 'Mark complete'
                }
                title={card.completed ? 'Mark incomplete' : 'Mark complete'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  toggleComplete()
                  // Drop focus immediately - Chrome focuses buttons on
                  // mouse click, which would otherwise leave the
                  // wrapper's group-focus-within state "on" and the
                  // checkbox stuck visible after a click (especially
                  // noticeable on cards with covers). Keyboard Tab
                  // navigation still triggers focus-within naturally.
                  ;(e.currentTarget as HTMLButtonElement).blur()
                }}
                className={cn(
                  'mt-0.5 mr-2 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border',
                  card.completed
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border',
                  completePhase && `complete-pop-${completePhase}`
                )}
              >
                {card.completed && (
                  <Check
                    className={cn(
                      'size-3',
                      completePhase && `complete-check-pop-in-${completePhase}`
                    )}
                  />
                )}
              </button>
            </div>
            {/* Title is part of the drag surface and carries no onClick:
                a click bubbles to the <li> handler (open / select), and
                the 6 px activation distance lets a drag-move start the
                drag. The span isn't a button, so the <li>'s interactive-
                child bail doesn't skip it. */}
            <span
              className={cn(
                'min-w-0 flex-1 wrap-anywhere pr-5',
                card.completed && 'text-muted-foreground line-through'
              )}
            >
              {card.title}
            </span>
          </div>
          {titleChipEl}
          {/* Memoized meta (priority + due) + checklist preview - the
              hover-reveal slide is pure CSS (group-hover), so memoizing
              the element doesn't affect it. See the useMemo block. */}
          {metaEl}
          {checklistEl}

          {/* Multi-select badge - a filled check in the top-right corner
              (where the pencil sits), so the selection reads at a glance
              even on a card with a cover. */}
          {selected && (
            <span
              aria-hidden
              className="absolute right-1.5 top-1.5 z-10 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow"
            >
              <Check className="size-3" />
            </span>
          )}

          {/* Hover edit affordance - same menu as right-click. Hidden
              while selected so it doesn't collide with the badge. */}
          {!selected && (
            <button
              aria-label="Edit card"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={open}
              className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/card:opacity-100"
            >
              <Pencil className="size-3.5" />
            </button>
          )}
        </li>
      )}
    </ContextMenu>
    <UrlCoverModal
      card={card}
      open={urlCoverOpen}
      onClose={() => setUrlCoverOpen(false)}
    />
    </>
  )
})

// Exported so the swimlane layout can render an AddCard per (list,
// lane) cell that presets the new card's priority - see
// SwimlaneBoard's onAdd wiring.
export function AddCard({
  listId,
  onAdd,
  full
}: {
  listId: string
  onAdd: (title: string) => void
  full?: boolean
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const submit = (): void => {
    const t = value.trim()
    if (!t) return
    onAdd(t)
    setValue('')
  }
  // ADR-0035 - focus this list's input when the shortcut handler
  // dispatches `kanbini:add-card`. Filtered by listId so only the
  // targeted list's box pops, no matter how many lists are rendered.
  useEffect(() => {
    if (full) return
    const onAddRequest = (e: Event): void => {
      const detail = (e as CustomEvent<{ listId: string }>).detail
      if (detail?.listId === listId) inputRef.current?.focus()
    }
    document.addEventListener('kanbini:add-card', onAddRequest)
    return () => document.removeEventListener('kanbini:add-card', onAddRequest)
  }, [listId, full])
  // List is at its card limit - show why instead of the add-card input.
  if (full) {
    return (
      <div className="m-2 px-3 py-2 text-sm text-muted-foreground">
        Card limit reached
      </div>
    )
  }
  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && submit()}
      onBlur={submit}
      placeholder="+ Add a card"
      className="m-2 rounded-md border border-transparent bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground hover:border-border focus:border-ring focus:outline-none"
    />
  )
}

// Exported so the swimlane layout (which renders its own board chrome
// instead of the regular kanban row) can reuse the same inline input
// + kanbini:add-list shortcut wiring instead of duplicating the
// behaviour or falling back to window.prompt (which Electron disables
// in the renderer).
export function AddList({
  onAdd,
  boardId
}: {
  onAdd: (name: string) => void
  // Passed through to the template picker so an instantiated list
  // lands on this board. Optional - when omitted, the "From template"
  // affordance is hidden (no host to add the list to).
  boardId?: string
}) {
  const [value, setValue] = useState('')
  const [tplOpen, setTplOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const qc = useQueryClient()
  const submit = (): void => {
    const t = value.trim()
    if (!t) return
    onAdd(t)
    setValue('')
  }
  // ADR-0035 - focus on `kanbini:add-list` (e.g. user pressed the
  // "new list" shortcut). Mounted once per board, no filter needed.
  useEffect(() => {
    const onAddRequest = (): void => inputRef.current?.focus()
    document.addEventListener('kanbini:add-list', onAddRequest)
    return () => document.removeEventListener('kanbini:add-list', onAddRequest)
  }, [])
  return (
    <div className="flex w-72 shrink-0 flex-col gap-1">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        onBlur={submit}
        placeholder="+ Add a list"
        className="rounded-lg border border-dashed border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none"
      />
      {boardId && (
        <button
          type="button"
          onClick={() => setTplOpen(true)}
          className="rounded-md border border-dashed border-transparent px-3 py-1.5 text-left text-xs text-muted-foreground hover:border-border hover:text-foreground"
        >
          + From template
        </button>
      )}
      {boardId && (
        <TemplatePickerDialog
          open={tplOpen}
          kind="list"
          targetBoardId={boardId}
          onClose={() => setTplOpen(false)}
          onCreated={({ boardId: bId }: { boardId: string }) => {
            // The new list lives in the cached board view - invalidate
            // so it renders without a manual refetch.
            void qc.invalidateQueries({ queryKey: ['board', bId] })
          }}
        />
      )}
    </div>
  )
}

// Centered welcome panel shown when a board has no non-closed lists
// (brand-new board, or every list has been closed). One input + a
// primary submit button - same flow as the inline AddList stub but
// bigger and easier to find. The button is wired to the same submit
// path so users can either press Enter or click.
function BoardEmptyState({ onAdd }: { onAdd: (name: string) => void }) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const submit = (): void => {
    const t = value.trim()
    if (!t) {
      inputRef.current?.focus()
      return
    }
    onAdd(t)
    setValue('')
  }
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-lg border border-dashed border-border bg-card/40 p-10 text-center">
      <div
        className="size-28 text-muted-foreground [&>svg]:h-full [&>svg]:w-full"
        dangerouslySetInnerHTML={{ __html: emptyBoardSvg }}
      />
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-foreground">
          This board is empty
        </h3>
        <p className="text-sm text-muted-foreground">
          Lists are the columns on your board. Call them anything (To
          do, In progress, Done). Add your first one to start.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className="flex w-full flex-col gap-2"
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="List name"
          autoFocus
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          disabled={value.trim() === ''}
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ListPlus className="size-4" />
          Create first list
        </button>
      </form>
    </div>
  )
}
