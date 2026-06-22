import { expect, test, type Locator } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Multi-select (ADR-0035 follow-up). Drives the real interaction model
// through Electron's Chromium:
//   - a plain click OPENS a card (the reported bug: it used to only
//     focus/"select" without opening)
//   - Ctrl+click toggles a card into a multi-selection (the floating
//     SelectionBar shows the running count)
//   - a bulk action from the bar applies to every selected card
//   - Clear empties the selection
//
// Runs against the pre-seeded Welcome Board; we add our own cards so the
// list contents are deterministic regardless of the seed.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

test('Ctrl+click multi-selects cards and a bulk action hits them all', async () => {
  const { page } = handle

  await page
    .getByRole('heading', { name: 'Welcome Board', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  // Three deterministic cards in the To Do list.
  const addCard = page.getByPlaceholder('+ Add a card').first()
  for (const title of ['Alpha', 'Beta', 'Gamma']) {
    await addCard.click()
    await addCard.fill(title)
    await addCard.press('Enter')
    await expect(page.getByText(title, { exact: true })).toBeVisible()
  }

  const card = (t: string) =>
    page.locator('[data-card-id]', { hasText: new RegExp(`^${t}$`) })

  // --- the bug fix: a PLAIN click opens the card detail ---------------
  await page.getByText('Alpha', { exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Alpha' })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog', { name: 'Alpha' })).not.toBeVisible()

  // --- Ctrl+click builds a selection; the bar tracks the count -------
  await page.getByText('Alpha', { exact: true }).click({ modifiers: ['Control'] })
  await expect(page.getByText('1 selected')).toBeVisible()
  // Ctrl+click must NOT open the detail.
  await expect(page.getByRole('dialog', { name: 'Alpha' })).not.toBeVisible()

  await page.getByText('Beta', { exact: true }).click({ modifiers: ['Control'] })
  await expect(page.getByText('2 selected')).toBeVisible()

  // --- bulk Complete from the bar hits both selected cards -----------
  await page.getByRole('button', { name: /^Complete$/ }).click()
  await expect(page.getByText('Alpha', { exact: true })).toHaveCSS(
    'text-decoration-line',
    'line-through'
  )
  await expect(page.getByText('Beta', { exact: true })).toHaveCSS(
    'text-decoration-line',
    'line-through'
  )
  // Gamma was never selected, so it stays incomplete.
  await expect(card('Gamma').getByText('Gamma')).not.toHaveCSS(
    'text-decoration-line',
    'line-through'
  )

  // --- Clear empties the selection (bar disappears) ------------------
  await page.getByRole('button', { name: /Clear/ }).click()
  await expect(page.getByText('2 selected')).toHaveCount(0)
})

test('a plain click opens a card without leaving it selected', async () => {
  const { page } = handle

  await page
    .getByRole('heading', { name: 'Welcome Board', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  const addCard = page.getByPlaceholder('+ Add a card').first()
  await addCard.click()
  await addCard.fill('Solo')
  await addCard.press('Enter')
  await expect(page.getByText('Solo', { exact: true })).toBeVisible()

  const solo = page.locator('[data-card-id]', { hasText: /^Solo$/ })

  // A plain click opens the detail. Closing it must leave NO selection
  // visual on the card: no focus/selection ring (`ring-2`) and no count
  // bar. Before the fix, the click moved keyboard focus AND painted the
  // ring, so a click-to-open left the card looking selected (just without
  // the corner checkmark) - the reported bug.
  await page.getByText('Solo', { exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Solo' })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog', { name: 'Solo' })).not.toBeVisible()
  await expect(solo).not.toHaveClass(/ring-2/)
  await expect(page.getByText('1 selected')).toHaveCount(0)

  // Ctrl+click is the ONLY way to select: it paints the ring + shows the
  // count bar and does NOT open the detail.
  await page.getByText('Solo', { exact: true }).click({ modifiers: ['Control'] })
  await expect(solo).toHaveClass(/ring-2/)
  await expect(page.getByText('1 selected')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Solo' })).not.toBeVisible()
})

/** Real PointerEvent drag with enough interpolated steps to clear the
 *  6 px activation threshold (same shape as drag-and-drop.spec). */
async function dragBetween(
  page: E2EHandle['page'],
  from: Locator,
  to: Locator
): Promise<void> {
  const f = await from.boundingBox()
  const t = await to.boundingBox()
  if (!f || !t) throw new Error('boundingBox unavailable')
  const start = { x: f.x + f.width / 2, y: f.y + f.height / 2 }
  const end = { x: t.x + t.width / 2, y: t.y + t.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 5 })
  await page.mouse.move(end.x, end.y, { steps: 25 })
  await page.mouse.up()
}

const listWith = (page: E2EHandle['page'], anchor: string): Locator =>
  page.getByRole('list').filter({ hasText: anchor })

test('dragging one of a multi-selection moves them all', async () => {
  const { page } = handle

  await page
    .getByRole('heading', { name: 'Welcome Board', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  // A fresh empty target list + three deterministic cards in To Do.
  const addList = page.getByPlaceholder('+ Add a list')
  await addList.click()
  await addList.fill('Doing')
  await addList.press('Enter')
  await expect(page.getByRole('heading', { name: /^Doing\b/ })).toBeVisible()

  const addCard = page.getByPlaceholder('+ Add a card').first()
  for (const title of ['Mover1', 'Mover2', 'Stayer']) {
    await addCard.click()
    await addCard.fill(title)
    await addCard.press('Enter')
    await expect(page.getByText(title, { exact: true })).toBeVisible()
  }

  // Select Mover1 + Mover2 (not Stayer).
  await page.getByText('Mover1', { exact: true }).click({ modifiers: ['Control'] })
  await page.getByText('Mover2', { exact: true }).click({ modifiers: ['Control'] })
  await expect(page.getByText('2 selected')).toBeVisible()

  // Drag Mover1 onto the empty Doing list - its "+ Add a card" box is the
  // list-end droppable (Doing is the 4th list: To Do / In Progress /
  // Done / Doing).
  const doingAddCard = page
    .getByRole('main')
    .getByPlaceholder('+ Add a card')
    .nth(3)
  await dragBetween(
    page,
    page.locator('[data-card-id]', { hasText: /^Mover1$/ }),
    doingAddCard
  )

  // Both selected cards land in Doing; Stayer stays in To Do.
  const doing = listWith(page, 'Mover1')
  await expect(
    doing.locator('[data-card-id]', { hasText: /^Mover1$/ })
  ).toBeVisible()
  await expect(
    doing.locator('[data-card-id]', { hasText: /^Mover2$/ })
  ).toBeVisible()
  const todo = listWith(page, 'Stayer')
  await expect(
    todo.locator('[data-card-id]', { hasText: /^Mover1$/ })
  ).toHaveCount(0)
  await expect(
    todo.locator('[data-card-id]', { hasText: /^Mover2$/ })
  ).toHaveCount(0)
})
