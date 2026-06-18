import { expect, test, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Guards that dragging a card ACROSS multiple lists doesn't churn the lists it
// only passes over.
//
// THE SYMPTOM (before the fix). The live cross-list reorder committed the
// dragged card into whatever list the cursor was over on (nearly) every
// pointer frame. Sweeping across the board therefore inserted + removed the
// card from each list it passed, making each one bounce grow/shrink - laggy,
// jarring, and on empty lists an opaque-background flash. Measured: an
// intermediate list racked up ~1000-3000px of height churn for one sweep.
//
// THE FIX (cross-list DWELL, see board.tsx onDragOver + CROSS_LIST_DWELL_MS):
// a card only commits into a list once the cursor has lingered there; a fast
// sweep never dwells long enough, so passed-over lists are never touched.
//
// WHAT WE ASSERT. During a fast back-and-forth sweep we sample, per frame, the
// intermediate list's (In Progress) card COUNT and section HEIGHT. The card
// must NOT join it (count stays at its resting value) and so its height must
// not move. The destination-grow when a card actually SETTLES is covered +
// still wanted by list-grow.spec. Frame intervals are logged for insight only
// (absolute timing is dominated by the parallel test env).

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

interface JankState {
  on: boolean
  intervals: number[]
  heights: number[] // intermediate list (In Progress) section height
  counts: number[] // cards in that list (its own card + any that joined)
  last: number
}

async function startJankTracking(page: Page, intermediate: string): Promise<void> {
  await page.evaluate((name) => {
    const w = window as unknown as { __jank?: JankState }
    const state: JankState = {
      on: true,
      intervals: [],
      heights: [],
      counts: [],
      last: performance.now()
    }
    w.__jank = state
    const tick = (): void => {
      if (!state.on) return
      const now = performance.now()
      state.intervals.push(now - state.last)
      state.last = now
      const h2 = Array.from(document.querySelectorAll('h2')).find((e) =>
        e.textContent?.includes(name)
      )
      const section = h2 ? h2.closest('section') : null
      state.heights.push(section ? section.getBoundingClientRect().height : 0)
      state.counts.push(
        section ? section.querySelectorAll('[data-card-id]').length : 0
      )
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, intermediate)
}

async function stopJankTracking(
  page: Page
): Promise<{ intervals: number[]; heights: number[]; counts: number[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __jank?: JankState }
    if (!w.__jank) return { intervals: [], heights: [], counts: [] }
    w.__jank.on = false
    return {
      intervals: w.__jank.intervals,
      heights: w.__jank.heights,
      counts: w.__jank.counts
    }
  })
}

/** Sum of |height change| frame-to-frame: how much the list bounced overall. */
function totalVariation(heights: number[]): number {
  let v = 0
  for (let i = 1; i < heights.length; i++) v += Math.abs(heights[i]! - heights[i - 1]!)
  return v
}

test('sweeping a card across lists does not commit it into the lists it passes over', async () => {
  const { page } = handle
  await page.getByText('Welcome Board', { exact: true }).click()

  // In Progress is the intermediate list the card only sweeps over.
  const restingCount = await page.evaluate(() => {
    const h2 = Array.from(document.querySelectorAll('h2')).find((e) =>
      e.textContent?.includes('In Progress')
    )
    const section = h2 ? h2.closest('section') : null
    return section ? section.querySelectorAll('[data-card-id]').length : 0
  })

  const card = page.locator('[data-card-id]', {
    hasText: 'Drag a card to another list'
  })
  await expect(card).toBeVisible()
  const cardBox = await card.boundingBox()
  const todoHeader = await page
    .getByRole('heading', { name: /^To Do\b/ })
    .boundingBox()
  const doneHeader = await page
    .getByRole('heading', { name: /^Done\b/ })
    .boundingBox()
  if (!cardBox || !todoHeader || !doneHeader) {
    throw new Error('bounding boxes unavailable')
  }
  const y = cardBox.y + cardBox.height / 2
  const leftX = todoHeader.x + todoHeader.width / 2
  const rightX = doneHeader.x + doneHeader.width / 2

  await startJankTracking(page, 'In Progress')
  await page.mouse.move(cardBox.x + cardBox.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 8, y + 8, { steps: 4 })
  // FAST sweep across the board and back a few times - a quick flick that
  // never lingers over In Progress. steps:2 puts exactly one pointer event on
  // In Progress's centre per pass (a single frame, < the dwell even when the
  // parallel test env stretches a frame), so the dwell never commits there -
  // the way a real flick across lists behaves.
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(rightX, y, { steps: 2 })
    await page.mouse.move(leftX, y, { steps: 2 })
  }
  const { intervals, heights, counts } = await stopJankTracking(page)
  await page.mouse.up()

  const maxInterval = intervals.length ? Math.max(...intervals) : 0
  const jankFrames = intervals.filter((d) => d > 40).length
  const variation = totalVariation(heights)
  const maxCount = Math.max(...counts)
  // Frames where a card BEYOND In Progress's own joined it (the churn).
  const churnFrames = counts.filter((c) => c > restingCount).length
  // eslint-disable-next-line no-console
  console.log(
    `[drag-jank] frames=${intervals.length} maxInterval=${maxInterval.toFixed(0)}ms` +
      ` jankFrames(>40ms)=${jankFrames} | In Progress resting=${restingCount}` +
      ` maxCount=${maxCount} churnFrames=${churnFrames} heightVariation=${variation.toFixed(0)}px`
  )

  // The swept-past list never receives the dragged card (the dwell keeps it
  // out), so its count stays at rest and its height barely moves. Before the
  // fix the card joined on every pass (churnFrames in the dozens, variation
  // ~1000-3000px). A tiny allowance covers a single transient under heavy
  // parallel load.
  expect(churnFrames).toBeLessThanOrEqual(2)
  expect(variation).toBeLessThan(200)
})
