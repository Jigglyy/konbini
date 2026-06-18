import { expect, test, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Dragging a card over an empty list must give a clear drop hint WITHOUT
// slamming the whole column background opaque. Pre-fix the section flipped
// `bg-muted/60` -> `bg-muted` on hover (isOver), so on a board with a colour /
// gradient / image wallpaper an empty column flashed into a solid block (the
// wallpaper vanished behind it) - which reads as a glitch. The fix keeps the
// background translucent and shows a ring as the drop indicator instead.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

/** Computed background + ring (box-shadow) of the named list's <section>. */
async function sectionStyle(
  page: Page,
  listName: string
): Promise<{ bg: string; shadow: string }> {
  return page.evaluate((name) => {
    const h2 = Array.from(document.querySelectorAll('h2')).find((e) =>
      e.textContent?.includes(name)
    )
    const section = h2 ? h2.closest('section') : null
    if (!section) return { bg: '', shadow: '' }
    const cs = getComputedStyle(section)
    return { bg: cs.backgroundColor, shadow: cs.boxShadow }
  }, listName)
}

interface BgState {
  on: boolean
  bgs: string[]
  shadows: string[]
}

/** Sample the named section's bg + box-shadow every animation frame. */
async function startBgSampling(page: Page, listName: string): Promise<void> {
  await page.evaluate((name) => {
    const w = window as unknown as { __bg?: BgState }
    const state: BgState = { on: true, bgs: [], shadows: [] }
    w.__bg = state
    const tick = (): void => {
      if (!state.on) return
      const h2 = Array.from(document.querySelectorAll('h2')).find((e) =>
        e.textContent?.includes(name)
      )
      const section = h2 ? h2.closest('section') : null
      if (section) {
        const cs = getComputedStyle(section)
        state.bgs.push(cs.backgroundColor)
        state.shadows.push(cs.boxShadow)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, listName)
}

async function stopBgSampling(
  page: Page
): Promise<{ bgs: string[]; shadows: string[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __bg?: BgState }
    if (!w.__bg) return { bgs: [], shadows: [] }
    w.__bg.on = false
    return { bgs: w.__bg.bgs, shadows: w.__bg.shadows }
  })
}

/** True if a computed colour string is (near) fully opaque - no "/ 0.x" alpha
 *  and not an "...a(...)" form ending in a fractional alpha. */
function isOpaque(color: string): boolean {
  const m = color.match(/\/\s*([0-9.]+)\s*\)/) // oklab(L a b / A)
  if (m) return parseFloat(m[1]!) > 0.95
  const rgba = color.match(/rgba?\([^)]*,\s*([0-9.]+)\s*\)/)
  if (rgba) return parseFloat(rgba[1]!) > 0.95
  return true // rgb(...) / oklab(L a b) with no alpha = opaque
}

test('dragging over an empty list shows a drop ring, not an opaque background', async () => {
  const { page } = handle
  await page.getByText('Welcome Board', { exact: true }).click()

  // Empty out Done (seed gives it one card) so we drag onto a known-empty list.
  await page
    .getByText('Scaffold the stack (M0)', { exact: true })
    .click({ button: 'right' })
  await page.getByRole('button', { name: 'Delete card' }).click()
  await expect(
    page.getByText('Scaffold the stack (M0)', { exact: true })
  ).toHaveCount(0)

  const rest = await sectionStyle(page, 'Done')
  expect(rest.bg).not.toBe('') // sanity: found the section
  expect(isOpaque(rest.bg)).toBe(false) // at rest it's translucent

  // Grab a To Do card and sweep it slowly INTO + around Done's area while
  // sampling every frame, so we catch the hover state regardless of whether
  // the live reorder makes the card (not the list) the momentary drop target.
  const movingCard = page.locator('[data-card-id]', {
    hasText: 'Drag a card to another list'
  })
  const doneHeader = page.getByRole('heading', { name: /^Done\b/ })
  await expect(movingCard).toBeVisible()
  const from = await movingCard.boundingBox()
  const done = await doneHeader.boundingBox()
  if (!from || !done) throw new Error('bounding boxes unavailable')

  await startBgSampling(page, 'Done')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    from.x + from.width / 2 + 12,
    from.y + from.height / 2 + 12,
    { steps: 5 }
  )
  // Drift across Done's column - top, then down into the empty body - so some
  // frame has the cursor over the list droppable itself (isOver).
  await page.mouse.move(done.x + done.width / 2, done.y + done.height / 2, {
    steps: 20
  })
  await page.mouse.move(done.x + done.width / 2, done.y + done.height + 80, {
    steps: 12
  })
  await page.waitForTimeout(120)
  const { bgs, shadows } = await stopBgSampling(page)
  await page.mouse.up()

  const opaqueFrames = bgs.filter((b) => isOpaque(b)).length
  const ringFrames = shadows.filter((s) => s !== 'none' && s !== '').length
  // eslint-disable-next-line no-console
  console.log(
    `[empty-dragover] frames=${bgs.length} opaqueFrames=${opaqueFrames}` +
      ` ringFrames=${ringFrames}; distinct bg=${[...new Set(bgs)].join(' | ')}`
  )

  // The empty list NEVER slams its background opaque while a card is dragged
  // over it (so a board wallpaper keeps showing through). Pre-fix, isOver
  // flipped it to a solid `bg-muted`; the fix keeps it translucent + rings.
  expect(opaqueFrames).toBe(0)
  // ...and the drop target IS indicated by a ring at some point on the way in.
  expect(ringFrames).toBeGreaterThan(0)
})
