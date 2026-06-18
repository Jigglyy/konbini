// Shared drag/drop polish constants - the small set of numbers that
// govern how "buttery" the kanban drop feels. Extracted from
// `components/board.tsx` so the invariant tests in
// `__tests__/drag-polish.test.ts` can drift-detect changes to either
// value, and so any future surface that wires up dnd-kit's
// `DragOverlay` (boards-home grid, a future swimlane variant, etc.)
// can stay in lockstep.
//
// All values were arrived at by iterating with the user in front of
// the running app - see ADR-0048 for the full chain of fixes that
// landed here.

/** How long dnd-kit's `DropAnimation` glides the overlay from release
 *  point to landing slot, in ms. The first value the user notices
 *  after letting go - too long and the drop feels sluggish, too
 *  short and there's no time for the shadow to settle. 200 ms is the
 *  fastest value that still reads as "smooth glide" rather than
 *  "instant snap" against the cubic-bezier(0.22, 1, 0.36, 1) ease. */
export const DROP_ANIMATION_DURATION_MS = 200 as const

/** How long the just-dropped `SortableCard` force-paints itself in
 *  the source's `:hover` styles after `isDragging` flips false. Must
 *  outlast `DROP_ANIMATION_DURATION_MS` so the source is still at
 *  the hovered values when the overlay unmounts (otherwise the
 *  :hover-engagement on the visible source fires a 150 ms
 *  transition - the "snap" of the shadow appearing again at handoff).
 *  Tail buffer covers any animation-frame jitter between WAAPI's end
 *  callback and React's next render. */
export const POST_DROP_HOLD_MS = 220 as const

/** How long (ms) the cursor must dwell over a DIFFERENT list before the
 *  dragged card is committed into it (the live cross-list reorder). A fast
 *  sweep across the board crosses each intermediate list in less than this, so
 *  passed-over lists never receive the card - no bounce, no re-render churn,
 *  no opaque flash. Settling over a list for this long commits + grows it. A
 *  drop that beats the timer is handled directly in onDragEnd (it places the
 *  card from the drop target), so nothing is lost by waiting. ~90 ms is below
 *  a deliberate hover but comfortably above a single flick-through frame. */
export const CROSS_LIST_DWELL_MS = 90 as const

/** Duration (ms) of the smooth-pickup catch-up. The PointerSensor activates
 *  only after a 6 px move, so by the time the drag exists the pointer has
 *  already travelled; without this the overlay appears at `source + delta`
 *  and the item SNAPS to the cursor (worse the faster you grab). The fix
 *  (createSmoothPickup) eases the overlay from the source up to the cursor
 *  over this window. ~180 ms reads as a quick "settle into your grip"
 *  without lagging; pinned against the pickup-snap e2e detector. */
export const PICKUP_CATCHUP_MS = 180 as const

/** Easing for the pickup catch-up (ease-out cubic): the overlay leaves the
 *  source quickly then settles into the cursor. Exposed so the unit test and
 *  the modifier share one curve. */
export function pickupEaseOut(t: number): number {
  const c = Math.min(Math.max(t, 0), 1)
  return 1 - (1 - c) ** 3
}

/** Minimal subset of dnd-kit's `Transform` the pickup modifier touches.
 *  Kept local so this module stays dnd-kit-free + unit-testable; the
 *  returned modifier is structurally assignable to dnd-kit's `Modifier`. */
export interface PickupTransform {
  x: number
  y: number
  scaleX: number
  scaleY: number
}

/** Build the smooth-pickup DragOverlay modifier (+ `reset` to re-arm per
 *  drag). It SCALES the live transform by a TIME-based catch-up progress:
 *  `overlay = transform * pickupEaseOut(elapsed / durationMs)`.
 *
 *  - No snap: at activation elapsed~0 -> progress 0 -> overlay = 0 = source,
 *    then it eases to `transform` (the cursor). It rides the LIVE transform,
 *    so even one big activating jump eases instead of teleporting.
 *  - No bounce: the lag is `transform * (1 - progress)` - always along the
 *    CURRENT drag direction, so it can never pull the card opposite to the
 *    drag (the trap a fixed activation-direction offset hit).
 *  - No persistent lag: progress reaches 1 after `durationMs`, after which
 *    overlay = transform (tracks the cursor 1:1).
 *
 *  TIME-based (not distance) so a fast flick still eases, and so a held
 *  pointer mid-catch-up still completes - but that REQUIRES the host to keep
 *  re-rendering the overlay during the window (the modifier only re-runs on
 *  render); board.tsx drives a requestAnimationFrame tick for ~durationMs.
 *  `now` is injectable for the unit test. A `{0,0}` first frame is skipped so
 *  a stray initial render can't start the clock early. */
export function createSmoothPickup(
  durationMs: number = PICKUP_CATCHUP_MS,
  now: () => number = () => performance.now()
): {
  modifier: (args: { transform: PickupTransform }) => PickupTransform
  reset: () => void
} {
  let start: number | null = null
  return {
    modifier: ({ transform }) => {
      if (start === null) {
        if (transform.x === 0 && transform.y === 0) return transform
        start = now()
      }
      const t = durationMs <= 0 ? 1 : (now() - start) / durationMs
      const p = pickupEaseOut(t)
      return { ...transform, x: transform.x * p, y: transform.y * p }
    },
    reset: () => {
      start = null
    }
  }
}
