import { expect, test, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Guards the FIRST-CARD same-list "put-back" snap.
//
// THE BUG. Same-list reorder is strategy-only: onDragOver does NOT touch the
// cache (a live same-list reorder crashes dnd-kit's FLIP under StrictMode), so
// dnd-kit's verticalListSortingStrategy shifts the SIBLINGS via transform to
// show the gap, and the drop applies the reorder once. Drag the first card
// down a bit (the 2nd card slides up to show a gap at the 2nd spot), then put
// it back at the top: the drop is a no-op, and the strategy-shifted 2nd card
// resets its transform in a SINGLE frame (no animation) - it teleports back
// down. That instant reset is the "it looked like it'd go to the 2nd spot then
// snapped to the 1st" the user sees.
//
// We sample the 2nd card's viewport top every frame through the gesture +
// the post-drop reset, and assert it never jumps a near-card-height in one
// frame. A glide (or never shifting) keeps every step small; the snap is one
// ~card-height teleport.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

interface SibState {
  on: boolean
  tops: number[]
}

/** Sample the in-list (NOT the body-portaled overlay) card's top each frame. */
async function startSiblingTracking(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const w = window as unknown as { __sib?: SibState }
    const state: SibState = { on: true, tops: [] }
    w.__sib = state
    const tick = (): void => {
      if (!state.on) return
      const el = Array.from(document.querySelectorAll('[data-card-id]')).find(
        (e) =>
          e.textContent?.includes(t) &&
          !e.closest('[class~="cursor-grabbing"]')
      )
      state.tops.push(el ? el.getBoundingClientRect().top : NaN)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, text)
}

async function stopSiblingTracking(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __sib?: SibState }
    if (!w.__sib) return []
    w.__sib.on = false
    return w.__sib.tops
  })
}

/** Largest single-frame change in the sampled top (ignoring NaN gaps). */
function maxJump(tops: number[]): number {
  let max = 0
  for (let i = 1; i < tops.length; i++) {
    if (Number.isNaN(tops[i]!) || Number.isNaN(tops[i - 1]!)) continue
    const d = Math.abs(tops[i]! - tops[i - 1]!)
    if (d > max) max = d
  }
  return max
}

test('putting the first card back does not snap the 2nd card', async () => {
  const { page } = handle
  await page.getByText('Welcome Board', { exact: true }).click()

  const list = page
    .getByRole('list')
    .filter({ hasText: 'Drag a card to another list' })
  const first = list.locator('[data-card-id]', {
    hasText: 'Drag a card to another list'
  })
  const second = list.locator('[data-card-id]', {
    hasText: 'Click the checkbox to complete me'
  })
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()
  const fbox = await first.boundingBox()
  const sbox = await second.boundingBox()
  if (!fbox || !sbox) throw new Error('card bounding boxes unavailable')
  const fcx = fbox.x + fbox.width / 2
  const fcy = fbox.y + fbox.height / 2

  await startSiblingTracking(page, 'Click the checkbox to complete me')
  await page.mouse.move(fcx, fcy)
  await page.mouse.down()
  await page.mouse.move(fcx, fcy + 8, { steps: 3 }) // clear activation
  // Drag DOWN over the 2nd card so the strategy slides it up (gap at 2nd spot).
  await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2 + 6, {
    steps: 8
  })
  await page.waitForTimeout(90) // let the sibling shift settle
  // Put it BACK at the top FAST and release immediately - the snap case.
  await page.mouse.move(fcx, fcy, { steps: 2 })
  await page.mouse.up()
  await page.waitForTimeout(220) // capture the post-drop reset
  const tops = await stopSiblingTracking(page)

  // Confirm it was a genuine put-back (the first card is still first).
  const order = await list.locator('[data-card-id]').allInnerTexts()
  const jump = maxJump(tops)
  // eslint-disable-next-line no-console
  console.log(
    `[first-card-snap] 2nd card maxJump=${jump.toFixed(1)}px over ${tops.length}` +
      ` frames; first card still first=${order[0]?.includes('Drag a card to another list')}`
  )

  expect(order[0]).toContain('Drag a card to another list') // no-op put-back
  // The 2nd card never teleports a card-height back into place. The snap is a
  // deterministic ~85px single-frame reset; the fix glides it (largest sampled
  // step ~24-31px, ~45px worst-case under heavy parallel load as the ease-out
  // front-loads). 55px sits clear of both: a regressed snap (85) fails, the
  // glide passes.
  expect(jump).toBeLessThan(55)
})
