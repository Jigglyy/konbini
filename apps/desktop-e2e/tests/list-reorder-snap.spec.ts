import { expect, test, type Locator } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Guards the LIST-reorder drop "snap-back": the dragged column briefly
// returns to its ORIGINAL slot, then jumps to its new slot.
//
// THE BUG. onListDragEnd used to persist via `apply` (useBoardMutation),
// whose onMutate is async - it awaits cancelQueries BEFORE writing the
// optimistic cache. So the reorder landed a tick AFTER dnd-kit measured
// the source column for its drop animation: the overlay glided back to
// the column's ORIGINAL slot, and the real column only jumped to its new
// slot once the async write committed. The card drop path avoids this by
// writing the cache synchronously in the drag-end handler; onListDragEnd
// now does the same (a raw, synchronous qc.setQueryData), so the column is
// at its new slot before dnd-kit measures and the overlay glides straight
// into place.
//
// We sample the body-portaled drag OVERLAY's left edge through the ~200ms
// drop animation. Dragging Done (rightmost) onto To Do (leftmost) and
// releasing there, the overlay should settle NEAR the release point (its
// new, leftmost slot). With the bug it instead glides a long way back to
// the RIGHT, toward Done's original slot.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

interface OverlayState {
  on: boolean
  xs: number[]
}

/** Sample the body-portaled DragOverlay's left edge each frame. The list
 *  overlay is the lone `cursor-grabbing` clone while a column is dragging
 *  / dropping. */
async function startOverlayTracking(page: E2EHandle['page']): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ov?: OverlayState }
    const state: OverlayState = { on: true, xs: [] }
    w.__ov = state
    const tick = (): void => {
      if (!state.on) return
      const el = document.querySelector('[class~="cursor-grabbing"]')
      if (el) state.xs.push(el.getBoundingClientRect().left)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopOverlayTracking(page: E2EHandle['page']): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __ov?: OverlayState }
    if (!w.__ov) return []
    w.__ov.on = false
    return w.__ov.xs
  })
}

function listHeader(page: E2EHandle['page'], name: RegExp): Locator {
  return page.getByRole('heading', { name })
}

async function headerX(header: Locator): Promise<number> {
  const box = await header.boundingBox()
  if (!box) throw new Error('list header has no bounding box')
  return box.x
}

test('reordering a list does not snap the dragged column back to its origin', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()

  const todo = listHeader(page, /^To Do\b/)
  const done = listHeader(page, /^Done\b/)
  await expect(todo).toBeVisible()
  await expect(done).toBeVisible()

  const doneBox = await done.boundingBox()
  const todoBox = await todo.boundingBox()
  if (!doneBox || !todoBox) throw new Error('header bounding boxes unavailable')
  const originalDoneX = doneBox.x

  // Drag Done's header onto To Do's header (Done -> leftmost). Release
  // over To Do's centre.
  const start = {
    x: doneBox.x + doneBox.width / 2,
    y: doneBox.y + doneBox.height / 2
  }
  const end = {
    x: todoBox.x + todoBox.width / 2,
    y: todoBox.y + todoBox.height / 2
  }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 5 })
  await page.mouse.move(end.x, end.y, { steps: 20 })
  await page.mouse.up()

  // Sample the drop animation (DROP_ANIMATION_DURATION_MS = 200; sample a
  // touch longer to cover the start-up + tail).
  await startOverlayTracking(page)
  await page.waitForTimeout(280)
  const xs = (await stopOverlayTracking(page)).filter((x) => Number.isFinite(x))

  // The reorder still landed (Done is leftmost now) - settles on the
  // post-move broadcastChange refetch.
  await expect
    .poll(async () => (await headerX(done)) < (await headerX(todo)))
    .toBe(true)

  const last = xs[xs.length - 1] ?? end.x
  // How far right of the release point the overlay drifted - i.e. back
  // toward Done's original (rightmost) slot.
  const rightwardDrift = last - end.x
  // eslint-disable-next-line no-console
  console.log(
    `[list-reorder-snap] overlay frames=${xs.length} ` +
      `last=${last.toFixed(0)} release=${end.x.toFixed(0)} ` +
      `originalDoneX=${originalDoneX.toFixed(0)} ` +
      `rightwardDrift=${rightwardDrift.toFixed(0)}`
  )

  // We must have actually sampled the overlay (else the assertion below is
  // vacuous).
  expect(xs.length).toBeGreaterThanOrEqual(3)
  // With the bug the overlay glides ~2 columns (hundreds of px) back to
  // the right toward Done's old slot. The fix keeps it near the release
  // point (its new slot). 150px clears both.
  expect(rightwardDrift).toBeLessThan(150)
})
