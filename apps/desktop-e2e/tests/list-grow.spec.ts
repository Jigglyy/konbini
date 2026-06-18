import { expect, test, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Guard that a destination list GROWS SMOOTHLY (height tween) when a card is
// dragged into it, instead of snapping taller in a single frame.
//
// When a card crosses into another list, the live cross-list reorder
// (onDragOver) splices it into that list's cards mid-drag, so the
// destination <section> gains a card's worth of height. Without a tween that
// height change lands in one frame (snappy). With useSmoothHeight on the
// section (enabled during a drag) it eases.
//
// Same robust signal as the pickup detector: sample the destination
// section's height every animation frame while a card enters, and count how
// many frames the height DWELLS at an intermediate value (the climb). A
// smooth grow passes through several; an instant grow has zero (it is at the
// 1-card height then the 2-card height, never in between).

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const MIN_CLIMB_FRAMES = 3

interface HState {
  on: boolean
  heights: number[]
}

/** Sample the named list's <section> height every frame. The list header is
 *  an <h2> inside the column <section>; we find it by text and measure its
 *  nearest section. */
async function startHeightTracking(page: Page, listName: string): Promise<void> {
  await page.evaluate((name) => {
    const w = window as unknown as { __lh?: HState }
    const state: HState = { on: true, heights: [] }
    w.__lh = state
    const tick = (): void => {
      if (!state.on) return
      const h2 = Array.from(document.querySelectorAll('h2')).find((e) =>
        e.textContent?.includes(name)
      )
      const section = h2 ? h2.closest('section') : null
      state.heights.push(section ? section.getBoundingClientRect().height : 0)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, listName)
}

async function stopHeightTracking(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __lh?: HState }
    if (!w.__lh) return []
    w.__lh.on = false
    return w.__lh.heights
  })
}

test('destination list grows smoothly (tweened) when a card enters', async () => {
  const { page } = handle
  await page.getByText('Welcome Board', { exact: true }).click()

  // Source card lives in To Do; target card is in In Progress (which then
  // grows from 1 to 2 cards as our card crosses in).
  const source = page.locator('[data-card-id]', {
    hasText: 'Drag a card to another list'
  })
  const target = page.locator('[data-card-id]', {
    hasText: 'Try the label filter above'
  })
  await expect(source).toBeVisible()
  await expect(target).toBeVisible()
  const from = await source.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error('card bounding box unavailable')

  await startHeightTracking(page, 'In Progress')

  // Drive a real cross-list drag and HOLD over In Progress (don't drop yet)
  // so the sampler captures the destination's growth + any tween.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    from.x + from.width / 2 + 8,
    from.y + from.height / 2 + 8,
    { steps: 4 }
  ) // clear the 6px activation threshold
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 })
  await page.waitForTimeout(320) // hold: capture the grow window
  const heights = (await stopHeightTracking(page)).filter((h) => h > 0)
  await page.mouse.up()

  const min = Math.min(...heights)
  const max = Math.max(...heights)
  const delta = max - min
  const lo = min + 0.15 * delta
  const hi = min + 0.85 * delta
  const climb = heights.filter((h) => h > lo && h < hi).length
  // eslint-disable-next-line no-console
  console.log(
    `[list-grow] In Progress height ${min.toFixed(0)} -> ${max.toFixed(0)}` +
      ` (delta=${delta.toFixed(0)}), climbFrames=${climb} (need >=${MIN_CLIMB_FRAMES});` +
      ` heights: ${heights.slice(0, 24).map((h) => h.toFixed(0)).join(',')}`
  )

  // The card actually entered and grew the list by ~one card (drive sanity).
  expect(delta).toBeGreaterThan(40)
  // The grow EASED through intermediate heights instead of snapping.
  expect(climb).toBeGreaterThanOrEqual(MIN_CLIMB_FRAMES)
})
