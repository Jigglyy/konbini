import { expect, test, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Frame-by-frame guard against the PICKUP SNAP (see the drag-polish-deadends
// memory). dnd-kit's PointerSensor activates only after a 6px move, so by the
// time the drag exists the pointer has already travelled. WITHOUT the
// smooth-pickup ease, the overlay parks at the source then TELEPORTS to the
// cursor in a single frame (the snap). WITH it (createSmoothPickup + the rAF
// tick in board.tsx), the overlay eases from the source up to the cursor
// across many frames.
//
// We sample the DragOverlay's top-left every animation frame during a
// pickup. The robust signal is how many frames the overlay DWELLS at
// intermediate positions (the "climb", 10%-90% of the move): a smooth ease
// climbs through several of them; a teleport has ZERO (it is at 0 then at the
// full move, never in between). We assert >= 2 climb frames. We log maxJump
// too (≈13px eased, =150px snapped) but don't assert on it - a single big
// jump is sensitive to frame-drop jitter in the parallel test env, whereas
// the climb-frame COUNT is not.
//
// THE KEY to making the drive expose a regression: a LARGE activating move in
// just TWO events. A small nudge hides the snap (tiny activation delta,
// nothing to teleport - this fooled an earlier version into "can't
// reproduce"); a single event (steps:1) doesn't drive a dnd-kit drag at all.
//
// These pass today. If the snap regresses (the ease is removed/broken) the
// overlay teleports, the climb-frame count drops to ~0, and these go red.
// (A DISTANCE-based ease - the rejected scale-by-progress - would ALSO fail:
// one 150px jump exceeds its catch-up distance so it lands at the cursor in
// one frame, no climb. Only the TIME-based ease climbs, which is the bar.)

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const MOVE_PX = 150
// "Climb" = strictly between these fractions of the move. A smooth ease
// passes through this band over several frames; a teleport skips it entirely.
// The band is generous (10-90%) and the threshold low (2) on purpose: under
// 4-worker parallel load the renderer's rAF is starved, so the 180ms ease is
// sampled in only a handful of frames (~3-4 in band instead of ~10). A real
// snap is DETERMINISTICALLY 0 in-band frames (it's at 0 then at the full move,
// nothing between), so 2 still separates ease from snap with margin while
// surviving a coarse sampler.
const CLIMB_LO = 0.1 * MOVE_PX
const CLIMB_HI = 0.9 * MOVE_PX
const MIN_CLIMB_FRAMES = 2

type Pt = { x: number; y: number }

interface PkState {
  on: boolean
  frames: Array<Pt | null>
}

/** rAF sampler recording the drag overlay's top-left every frame. The
 *  overlay content carries a bare `cursor-grabbing` class token; the resting
 *  card uses `active:cursor-grabbing` (a DIFFERENT token), so `[class~="..."]`
 *  (exact token match) selects only the live overlay. */
async function startOverlayTracking(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __pk?: PkState }
    const state: PkState = { on: true, frames: [] }
    w.__pk = state
    const tick = (): void => {
      if (!state.on) return
      const el = document.querySelector('[class~="cursor-grabbing"]')
      const r = el ? el.getBoundingClientRect() : null
      state.frames.push(r ? { x: r.left, y: r.top } : null)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopOverlayTracking(page: Page): Promise<Array<Pt | null>> {
  return page.evaluate(() => {
    const w = window as unknown as { __pk?: PkState }
    if (!w.__pk) return []
    w.__pk.on = false
    return w.__pk.frames
  })
}

/** Drive a fast pickup from `grab` and return the overlay's sampled top-lefts
 *  (non-null frames) plus `ref` (the source element's top-left). */
async function measurePickup(
  page: Page,
  grab: Pt,
  ref: Pt
): Promise<{ overlay: Pt[]; ref: Pt }> {
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await startOverlayTracking(page)
  // A LARGE activating move in just 2 events: the first event (~MOVE_PX/2)
  // crosses the 6px threshold with a big delta, so without the ease the
  // overlay would teleport the full distance. (A small nudge would hide it;
  // a single event - steps:1 - doesn't drive a drag.)
  await page.mouse.move(grab.x, grab.y + MOVE_PX, { steps: 2 })
  // Hold longer than the catch-up so the ease fully completes + settles.
  await page.waitForTimeout(280)
  const frames = await stopOverlayTracking(page)
  await page.mouse.up()
  const overlay = frames.filter((f): f is Pt => f !== null)
  return { overlay, ref }
}

const dist = (p: Pt, ref: Pt): number => Math.hypot(p.x - ref.x, p.y - ref.y)

/** How many frames the overlay sits at an intermediate (climb) distance from
 *  the source. A smooth ease has several; a teleport has none. */
function climbFrames(overlay: Pt[], ref: Pt): number {
  return overlay.filter((p) => {
    const d = dist(p, ref)
    return d >= CLIMB_LO && d <= CLIMB_HI
  }).length
}

/** Largest single-frame jump (seeded with the source). ~13px eased, 150 if
 *  snapped. Logged for insight; not asserted (frame-drop sensitive). */
function maxJump(overlay: Pt[], ref: Pt): number {
  const path = [ref, ...overlay]
  let max = 0
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(
      path[i]!.x - path[i - 1]!.x,
      path[i]!.y - path[i - 1]!.y
    )
    if (d > max) max = d
  }
  return max
}

/** Compact dump of the path relative to the source, for the run log. */
function trajectory(overlay: Pt[], ref: Pt): string {
  return overlay
    .slice(0, 14)
    .map((p) => `(${(p.x - ref.x).toFixed(0)},${(p.y - ref.y).toFixed(0)})`)
    .join(' ')
}

async function assertSmoothPickup(
  label: string,
  overlay: Pt[],
  ref: Pt
): Promise<void> {
  const climb = climbFrames(overlay, ref)
  const reached = overlay.reduce((m, p) => Math.max(m, dist(p, ref)), 0)
  // eslint-disable-next-line no-console
  console.log(
    `[pickup] ${label}: climbFrames=${climb} (need >=${MIN_CLIMB_FRAMES}),` +
      ` maxJump=${maxJump(overlay, ref).toFixed(1)}px, reached=${reached.toFixed(0)}px` +
      ` over ${overlay.length} frames; path: ${trajectory(overlay, ref)}`
  )
  expect(overlay.length).toBeGreaterThan(0)
  // The drag actually moved the overlay to ~the cursor (drive sanity).
  expect(reached).toBeGreaterThan(0.8 * MOVE_PX)
  // The overlay EASED through intermediate positions instead of teleporting.
  expect(climb).toBeGreaterThanOrEqual(MIN_CLIMB_FRAMES)
}

test('card pickup eases from the source to the cursor (no snap)', async () => {
  const { page } = handle
  await page.getByText('Welcome Board', { exact: true }).click()

  const card = page.locator('[data-card-id]').first()
  await expect(card).toBeVisible()
  const box = await card.boundingBox()
  if (!box) throw new Error('card has no bounding box')

  const { overlay, ref } = await measurePickup(
    page,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: box.x, y: box.y }
  )
  await assertSmoothPickup('card', overlay, ref)
})

test('list pickup eases from the source to the cursor (no snap)', async () => {
  const { page } = handle
  await page.getByText('Welcome Board', { exact: true }).click()

  // The whole list header is the drag handle; its top-left ~ the column
  // (and thus the overlay clone) top-left.
  const header = page.getByRole('heading', { name: /^To Do\b/ })
  await expect(header).toBeVisible()
  const box = await header.boundingBox()
  if (!box) throw new Error('list header has no bounding box')

  const { overlay, ref } = await measurePickup(
    page,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: box.x, y: box.y }
  )
  await assertSmoothPickup('list', overlay, ref)
})
