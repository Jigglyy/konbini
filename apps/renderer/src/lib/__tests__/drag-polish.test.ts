import { describe, expect, it } from 'vitest'
import {
  CROSS_LIST_DWELL_MS,
  DROP_ANIMATION_DURATION_MS,
  PICKUP_CATCHUP_MS,
  POST_DROP_HOLD_MS,
  createSmoothPickup,
  pickupEaseOut,
  type PickupTransform
} from '../drag-polish'

const T = (x: number, y: number): PickupTransform => ({
  x,
  y,
  scaleX: 1,
  scaleY: 1
})

// Drift-detection for the two timing constants that govern how
// "buttery" the kanban drop feels. The invariants below are the
// contracts the choreography depends on - if someone tunes one
// number without re-checking the other, the source's `:hover`
// transition fires at handoff and the user sees the
// "shadow / border appears again" snap that took several rounds of
// front-end iteration to chase down (ADR-0048). These tests pin the
// values so a future "let's bump the drop a bit" PR has to confront
// the relationship explicitly.

describe('drag-polish constants', () => {
  it('DROP_ANIMATION_DURATION_MS is short enough to feel responsive but long enough to read as smooth', () => {
    // < 150 ms tends to feel like a hard snap (insufficient time for
    // ease-out to convey deceleration). > 320 ms starts to feel
    // sluggish - the user reported it explicitly at 360 ms.
    expect(DROP_ANIMATION_DURATION_MS).toBeGreaterThanOrEqual(150)
    expect(DROP_ANIMATION_DURATION_MS).toBeLessThanOrEqual(320)
  })

  it('POST_DROP_HOLD_MS outlasts the drop animation', () => {
    // The hold's job is to keep the source SortableCard painted in
    // its hovered styles until AFTER the overlay unmounts. If the
    // hold expires first, the source's class flips, the source's
    // :hover engagement fires a 150 ms transition, and the user sees
    // the "shadow appears again" snap at handoff. So hold > drop is
    // load-bearing.
    expect(POST_DROP_HOLD_MS).toBeGreaterThan(DROP_ANIMATION_DURATION_MS)
  })

  it('CROSS_LIST_DWELL_MS is below a deliberate hover but above a flick-through', () => {
    // Too low (< ~40 ms) and a fast sweep still commits into passed-over
    // lists (the churn returns); too high (> ~150 ms) and a deliberate drop
    // into an adjacent list feels laggy to commit. ~70 ms is the sweet spot.
    expect(CROSS_LIST_DWELL_MS).toBeGreaterThanOrEqual(40)
    expect(CROSS_LIST_DWELL_MS).toBeLessThanOrEqual(150)
  })

  it('POST_DROP_HOLD_MS buffer past the drop is small (no perceptible "stuck" feel)', () => {
    // Buffer covers animation-frame jitter between WAAPI's end
    // callback and React's next render - empirically ~16 ms is
    // enough; we use 20 ms. More than ~60 ms and the user starts
    // to perceive the card as "stuck" in its hovered styles after
    // the drop has visibly settled.
    const buffer = POST_DROP_HOLD_MS - DROP_ANIMATION_DURATION_MS
    expect(buffer).toBeGreaterThan(0)
    expect(buffer).toBeLessThanOrEqual(60)
  })
})

describe('pickupEaseOut', () => {
  it('runs 0 -> 1 monotonically and is clamped outside [0,1]', () => {
    expect(pickupEaseOut(0)).toBe(0)
    expect(pickupEaseOut(1)).toBe(1)
    expect(pickupEaseOut(-0.5)).toBe(0)
    expect(pickupEaseOut(2)).toBe(1)
    expect(pickupEaseOut(0.5)).toBeGreaterThan(0)
    expect(pickupEaseOut(0.5)).toBeLessThan(1)
    // ease-OUT: front-loaded (past halfway distance by the time midway).
    expect(pickupEaseOut(0.5)).toBeGreaterThan(0.5)
  })
})

describe('createSmoothPickup', () => {
  // A controllable clock so the time-based ease is deterministic.
  let t = 0
  const now = (): number => t

  it('no snap: at activation the overlay sits at the source (transform * 0)', () => {
    t = 1000
    const { modifier } = createSmoothPickup(180, now)
    // First non-zero transform starts the clock; elapsed 0 -> progress 0.
    expect(modifier({ transform: T(150, 0) })).toMatchObject({ x: 0, y: 0 })
  })

  it('eases the LIVE transform over time, not a fixed offset (no bounce)', () => {
    t = 0
    const { modifier } = createSmoothPickup(180, now)
    modifier({ transform: T(150, 0) }) // start clock at t=0
    // A fast single jump still eases: partway through, the overlay is a
    // FRACTION of the (live) transform, scaled by the current direction.
    t = 90 // halfway through 180ms
    const mid = modifier({ transform: T(150, 0) })
    expect(mid.x).toBeGreaterThan(0)
    expect(mid.x).toBeLessThan(150)
    // The lag is along the current transform: drag the OTHER way and the
    // overlay follows that direction (never pulled back toward activation).
    const other = modifier({ transform: T(-150, 0) })
    expect(other.x).toBeLessThan(0)
  })

  it('completes: after the duration the overlay tracks the cursor 1:1', () => {
    t = 0
    const { modifier } = createSmoothPickup(180, now)
    modifier({ transform: T(150, 0) })
    t = 180
    expect(modifier({ transform: T(150, 0) })).toMatchObject({ x: 150, y: 0 })
    t = 5000
    expect(modifier({ transform: T(80, 0) })).toMatchObject({ x: 80, y: 0 })
  })

  it('skips a {0,0} first frame so it does not start the clock early', () => {
    t = 0
    const { modifier } = createSmoothPickup(180, now)
    expect(modifier({ transform: T(0, 0) })).toMatchObject({ x: 0, y: 0 })
    t = 500 // time passes while parked at origin
    // Clock only starts now (first non-zero), so this is still ~source.
    expect(modifier({ transform: T(150, 0) })).toMatchObject({ x: 0, y: 0 })
  })

  it('preserves scaleX / scaleY untouched', () => {
    t = 0
    const { modifier } = createSmoothPickup(180, now)
    const out = modifier({ transform: { x: 8, y: 8, scaleX: 1.5, scaleY: 2 } })
    expect(out).toMatchObject({ scaleX: 1.5, scaleY: 2 })
  })

  it('reset() re-arms the clock for the next drag', () => {
    t = 0
    const { modifier, reset } = createSmoothPickup(180, now)
    modifier({ transform: T(150, 0) }) // start at t=0
    t = 180
    modifier({ transform: T(150, 0) }) // completed
    reset()
    t = 1000
    // Fresh drag: clock restarts at t=1000 -> progress 0 -> source.
    expect(modifier({ transform: T(150, 0) })).toMatchObject({ x: 0, y: 0 })
  })

  it('PICKUP_CATCHUP_MS is a short, smooth glide', () => {
    expect(PICKUP_CATCHUP_MS).toBeGreaterThanOrEqual(100)
    expect(PICKUP_CATCHUP_MS).toBeLessThanOrEqual(300)
  })
})
