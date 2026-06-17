import { expect, test, type Locator } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for dnd-kit LIST-column reorder. The whole list header is the drag
// handle (like a card's whole <li>); the pure index math lives in
// `lib/board-dnd.ts` (planListMove / reorderVisibleLists, unit-tested
// there). This drives the integration through real PointerEvents so the
// type-aware collision detection (card vs `listcol:` droppables), the
// horizontalListSortingStrategy, the optimistic reorder, the list.move
// IPC, and the post-move broadcastChange refetch are all on the path.
//
// Same PointerSensor note as drag-and-drop.spec: dnd-kit needs MULTIPLE
// pointermove events past the 6 px activation distance, so we interpolate
// with `mouse.move(..., { steps })`.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

/** A list header by its name (the <h2> drag handle). The regex anchors on
 *  the start so "Done" doesn't also match a card mentioning "done". */
function listHeader(page: E2EHandle['page'], name: RegExp): Locator {
  return page.getByRole('heading', { name })
}

/** Left edge x of a list header - the column's horizontal position, used
 *  to assert left-to-right order after a reorder. */
async function headerX(header: Locator): Promise<number> {
  const box = await header.boundingBox()
  if (!box) throw new Error('list header has no bounding box')
  return box.x
}

/** Real PointerEvent-backed drag from one element's centre to another's
 *  (mirrors drag-and-drop.spec). */
async function dragBetween(
  page: E2EHandle['page'],
  from: Locator,
  to: Locator
): Promise<void> {
  const fromBox = await from.boundingBox()
  const toBox = await to.boundingBox()
  if (!fromBox || !toBox) {
    throw new Error('boundingBox unavailable for drag source or target')
  }
  const start = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 }
  const end = { x: toBox.x + toBox.width / 2, y: toBox.y + toBox.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  // Clear the 6 px activation threshold first so the PointerSensor commits.
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 5 })
  await page.mouse.move(end.x, end.y, { steps: 25 })
  await page.mouse.up()
}

test('drag a list header to reorder the columns', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()

  const todo = listHeader(page, /^To Do\b/)
  const inProgress = listHeader(page, /^In Progress\b/)
  const done = listHeader(page, /^Done\b/)
  await expect(todo).toBeVisible()
  await expect(inProgress).toBeVisible()
  await expect(done).toBeVisible()

  // Seed order is [To Do, In Progress, Done], so Done starts rightmost.
  expect(await headerX(done)).toBeGreaterThan(await headerX(todo))

  // Drag Done's header all the way onto To Do's header → Done lands at
  // the front (arrayMove last→first).
  await dragBetween(page, done, todo)

  // After the move Done is the leftmost column. Poll because the final
  // position settles on the broadcastChange refetch after the optimistic
  // write.
  await expect
    .poll(async () => (await headerX(done)) < (await headerX(todo)))
    .toBe(true)
  expect(await headerX(done)).toBeLessThan(await headerX(inProgress))
})

test('the reorder survives a board reload (it persisted, not just optimistic)', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()
  const todo = listHeader(page, /^To Do\b/)
  const done = listHeader(page, /^Done\b/)
  await expect(todo).toBeVisible()

  await dragBetween(page, done, todo)
  await expect.poll(async () => (await headerX(done)) < (await headerX(todo))).toBe(true)

  // Leave the board and come back - the order comes from the DB now, not
  // the in-memory optimistic cache. If list.move didn't persist, Done
  // would snap back to the right. Alt+B is the nav.home shortcut (an h2
  // isn't a typing target, so it fires after the drag).
  await page.keyboard.press('Alt+b')
  await expect(page.getByRole('heading', { name: /your boards/i })).toBeVisible()
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(listHeader(page, /^Done\b/)).toBeVisible()
  expect(await headerX(listHeader(page, /^Done\b/))).toBeLessThan(
    await headerX(listHeader(page, /^To Do\b/))
  )
})

test('dropping after a card-filled list lands in that slot, not past the next list', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()
  const todo = listHeader(page, /^To Do\b/) // seeded with 3 cards (tall)
  const inProgress = listHeader(page, /^In Progress\b/)
  const done = listHeader(page, /^Done\b/)
  await expect(todo).toBeVisible()
  await expect(inProgress).toBeVisible()
  await expect(done).toBeVisible()

  // Drag Done (rightmost) onto In Progress - i.e. into the slot directly
  // after the card-filled To Do. It must land BETWEEN To Do and In
  // Progress, not overshoot to the end past In Progress. That overshoot
  // was the closestCorners bug: To Do's height pulled the resolved column
  // one slot too far; the X-only collision fixes it.
  await dragBetween(page, done, inProgress)

  await expect
    .poll(async () => {
      const x = {
        todo: await headerX(todo),
        done: await headerX(done),
        inProgress: await headerX(inProgress)
      }
      // Final order must be: To Do, Done, In Progress.
      return x.todo < x.done && x.done < x.inProgress
    })
    .toBe(true)
})
