import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E: Ctrl+V while a card is open attaches the clipboard image.
//
// Drives the full path that can't be exercised in JSDOM: a real image
// on the OS clipboard (written from the Electron main process) → the
// card-detail keydown listener → the attachment:pasteImage IPC → main's
// clipboard.readImage() → a PNG written under userData/attachments →
// createAttachment → broadcastChange → the Attachments list shows the
// new file. A plain text paste (no image) is left untouched, covered by
// the renderer unit test.

let handle: E2EHandle

test.afterEach(async () => {
  await handle?.cleanup()
})

// A valid 1x1 PNG (same bytes as card-cover.spec). Round-tripped through
// the OS clipboard it reads back as a non-empty image, which is all the
// handler needs.
const PNG_BYTES = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
]

test('Ctrl+V in an open card attaches the clipboard image', async () => {
  handle = await launchKanbini()
  const { page, app } = handle

  // Put a real PNG on the system clipboard via the main process.
  await app.evaluate(({ clipboard, nativeImage }, bytes) => {
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(bytes)))
  }, PNG_BYTES)

  await page.getByText('Welcome Board', { exact: true }).click()
  await page
    .getByText('Click the checkbox to complete me', { exact: true })
    .click()
  const detail = page.getByRole('dialog', {
    name: 'Click the checkbox to complete me'
  })
  await expect(detail).toBeVisible()

  // No image attachment yet (each image attachment renders one
  // "Preview image" thumbnail button - an unambiguous per-attachment
  // count, unlike getByText which also matches the row wrapping the
  // filename span).
  const thumbs = detail.getByRole('button', { name: 'Preview image' })
  await expect(thumbs).toHaveCount(0)

  await page.keyboard.press('Control+v')

  // The clipboard image lands as exactly ONE attachment (a single Ctrl+V
  // must not double-attach). 15 s covers full-suite system load; the
  // happy path is well under 1 s.
  await expect(thumbs).toHaveCount(1, { timeout: 15_000 })
  await expect(detail.getByText(/pasted-\d+\.png/).first()).toBeVisible()
})
