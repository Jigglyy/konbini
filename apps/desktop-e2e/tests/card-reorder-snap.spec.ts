import { expect, test, type Locator, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Guards the SAME-LIST card-reorder drop "snap-back": a card moved within
// its own list glides to the drop point, then jumps back to its ORIGINAL
// slot, then snaps to the new one.
//
// Same root cause as the list-column snap (list-reorder-snap.spec): the
// optimistic cache reorder must be visible in the DOM BEFORE dnd-kit
// measures the source card's rect for its drop animation. A same-list card
// move is strategy-only during the drag (onDragOver does NOT touch the
// cache - that avoids the per-frame FLIP reflow storm), so the dragged
// card's DOM node never leaves its original slot during the drag. If the
// reorder isn't committed in time, dnd-kit measures the source at its old
// slot, the overlay glides back there, and the card snaps to its new slot
// only when the reorder lands.
//
// We sample the body-portaled drag OVERLAY's top edge through the ~200ms
// drop animation. Dragging the TOP card to the BOTTOM of a tall list and
// releasing there, the overlay should settle NEAR the bottom (its new
// slot). With the bug it instead glides UP, back toward the card's
// original (top) slot.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

interface OverlayState {
  on: boolean
  tops: number[]
}

async function startOverlayTracking(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ov?: OverlayState }
    const state: OverlayState = { on: true, tops: [] }
    w.__ov = state
    const tick = (): void => {
      if (!state.on) return
      const el = document.querySelector('[class~="cursor-grabbing"]')
      if (el) state.tops.push(el.getBoundingClientRect().top)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopOverlayTracking(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __ov?: OverlayState }
    if (!w.__ov) return []
    w.__ov.on = false
    return w.__ov.tops
  })
}

function listWith(page: Page, anchor: string): Locator {
  return page.getByRole('list').filter({ hasText: anchor })
}

test('reordering a card within a list does not snap it back to its origin', async () => {
  const { page } = handle
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  // Make the To Do list tall + deterministic. Seeded order is
  // [Drag…, Click…, Hover…]; append three so the top→bottom span is big
  // enough to read the snap clearly.
  const addCard = page.getByPlaceholder('+ Add a card').first()
  for (const t of ['Snap1', 'Snap2', 'Snap3']) {
    await addCard.click()
    await addCard.fill(t)
    await addCard.press('Enter')
    await expect(page.getByText(t, { exact: true })).toBeVisible()
  }

  const list = listWith(page, 'Hover for the delete + label buttons')
  const first = list.locator('[data-card-id]', {
    hasText: 'Drag a card to another list'
  })
  const last = list.locator('[data-card-id]', { hasText: /^Snap3$/ })
  const fbox = await first.boundingBox()
  const lbox = await last.boundingBox()
  if (!fbox || !lbox) throw new Error('card bounding boxes unavailable')
  const originalTop = fbox.y

  // Drag the top card down to just past the last card, release there.
  const start = { x: fbox.x + fbox.width / 2, y: fbox.y + fbox.height / 2 }
  const end = { x: lbox.x + lbox.width / 2, y: lbox.y + lbox.height - 4 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x, start.y + 8, { steps: 3 }) // clear activation
  await page.mouse.move(end.x, end.y, { steps: 20 })
  await page.mouse.up()

  // Sample the drop animation (DROP_ANIMATION_DURATION_MS = 200).
  await startOverlayTracking(page)
  await page.waitForTimeout(280)
  const tops = (await stopOverlayTracking(page)).filter((t) => Number.isFinite(t))

  // The reorder actually happened (the dragged card is no longer first).
  const order = await list.locator('[data-card-id]').allInnerTexts()

  const last_s = tops[tops.length - 1] ?? end.y
  // How far the overlay drifted UP toward the card's original (top) slot.
  const upwardDriftToOrigin = last_s - originalTop
  // eslint-disable-next-line no-console
  console.log(
    `[card-reorder-snap] frames=${tops.length} ` +
      `firstTop=${(tops[0] ?? NaN).toFixed(0)} lastTop=${last_s.toFixed(0)} ` +
      `originalTop=${originalTop.toFixed(0)} releaseY=${end.y.toFixed(0)} ` +
      `distToOrigin=${Math.abs(upwardDriftToOrigin).toFixed(0)} ` +
      `order0=${order[0]?.slice(0, 16)}`
  )

  expect(tops.length).toBeGreaterThanOrEqual(3)
  // The dragged card moved (no longer the first card in the list).
  expect(order[0]).not.toContain('Drag a card to another list')
  // The overlay must NOT settle back near the original (top) slot. With the
  // bug it glides up to within a card-height of originalTop; the fix leaves
  // it near the bottom release point, far below originalTop. The list cards
  // are ~40-50px tall and the drag spans ~5 cards, so the original slot sits
  // hundreds of px above the release - 120px cleanly separates the two.
  expect(Math.abs(last_s - originalTop)).toBeGreaterThan(120)
})
