import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E: a card shows a small marker in the list once it has a description,
// and none before. Drives the real flow: open a (description-less) card,
// type a description, close the detail (which flushes + saves), and assert
// the marker appears on the in-list card.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})
test.afterEach(async () => {
  await handle?.cleanup()
})

test('a card gains a description marker once it has a description', async () => {
  const { page } = handle
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  const card = page.locator('[data-card-id]', {
    hasText: 'Drag a card to another list'
  })
  await expect(card).toBeVisible()
  // No marker before it has a description.
  await expect(card.getByTitle('Has a description')).toHaveCount(0)

  // Open the card + add a description.
  await card.click()
  const modal = page.getByRole('dialog', {
    name: 'Drag a card to another list'
  })
  await expect(modal).toBeVisible()
  await modal.getByText('Add a description…').click()
  const section = modal.locator('section', { hasText: 'Description' })
  await section.locator('.tiptap[contenteditable="true"]').click()
  await page.keyboard.type('Some notes for this card', { delay: 15 })

  // Close the detail - unmounting the editor flushes + saves the
  // description (the 500ms debounce would otherwise be cancelled).
  await modal.getByRole('button', { name: 'Close' }).click()
  await expect(modal).toBeHidden()

  // The in-list card now carries the description marker.
  await expect(card.getByTitle('Has a description')).toBeVisible({
    timeout: 15_000
  })
})
