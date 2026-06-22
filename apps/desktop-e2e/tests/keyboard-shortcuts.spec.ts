import { expect, test, type Locator, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for ADR-0035 keyboard shortcuts.
//
// The pure matcher/formatter + the `useShortcutDispatch` hook are
// covered by JSDOM tests in apps/renderer/src/lib/__tests__/
// shortcuts.test.ts. This spec drives the actual per-action
// handlers in board.tsx / App.tsx against the real Electron app so
// the wire-up survives changes to the dispatcher OR the surrounding
// state. `nav.search` / `edit.undo` / `edit.redo` are owned by
// search.spec.ts + undo-redo.spec.ts; this file covers everything
// else in the registry - focus navigation, card actions, card
// moves, creation surfaces, the nav.home back-link, and the
// `isTypingTarget` gate that lets the user type 'c' in an input
// without firing list.newCard.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})
test.afterEach(async () => {
  await handle?.cleanup()
})

// Open the seeded Welcome Board + put keyboard focus into the
// window. Every test starts from the same place so individual
// tests don't repeat the boards-home → board navigation.
async function openBoard(page: Page): Promise<void> {
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(
    page.getByRole('heading', { name: /^To Do\b/ })
  ).toBeVisible()
  // Click the board surface so the very next keystroke lands on
  // `document` rather than the boards-home button we just clicked.
  await page.locator('body').click()
}

// Anchor a cards-`<ul>` on a stable card that doesn't move during
// the test. Lifted from drag-and-drop.spec.ts because the list
// `<section>` has no aria-label - `getByRole('list').filter` is the
// most robust scoping handle.
function cardsListWith(page: Page, anchorCardTitle: string): Locator {
  return page.getByRole('list').filter({ hasText: anchorCardTitle })
}

// The focused card's <li data-card-id> picks up SortableCard's
// `ring-2 ring-ring ring-offset-1 ring-offset-background` classes
// when its `focused` prop is true (board.tsx). Matching `ring-2`
// alone is enough - Tailwind compiles to that literal class name
// and nothing else on the card surface uses it.
function card(page: Page, text: string): Locator {
  return page.locator('li[data-card-id]', { hasText: text })
}

async function expectFocused(page: Page, text: string): Promise<void> {
  await expect(card(page, text)).toHaveClass(/ring-2/)
}

// Put keyboard focus on a specific card. A click sets the board's
// `focusedCardId` (so the keyboard handlers act on this card) and opens
// the detail modal as a side effect; Escape dismisses it. Note: a plain
// click no longer PAINTS the focus ring - only Ctrl/Cmd-click selection
// and keyboard navigation do, so a click-to-open doesn't leave a card
// looking selected. `focusedCardId` is still set independently of the
// modal, so the first arrow / action key in each test operates from this
// card (and a nav key lights the ring on its result, which `expectFocused`
// then checks). The modal-closed wait is the sync point confirming the
// click + focus committed before the test proceeds.
async function focusCard(page: Page, text: string): Promise<void> {
  await card(page, text).click()
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('dialog', { name: text })
  ).not.toBeVisible()
}

// ─── Focus navigation ─────────────────────────────────────────────

test.describe('Card focus navigation', () => {
  test('↓ + j focus the next card in the same list', async () => {
    const { page } = handle
    await openBoard(page)
    await focusCard(page, 'Drag a card to another list')

    await page.keyboard.press('ArrowDown')
    await expectFocused(page, 'Click the checkbox to complete me')

    // Vim alias - second default binding for card.focusNext.
    await page.keyboard.press('j')
    await expectFocused(page, 'Hover for the delete + label buttons')
  })

  test('↑ + k focus the previous card in the same list', async () => {
    const { page } = handle
    await openBoard(page)
    await focusCard(page, 'Hover for the delete + label buttons')

    await page.keyboard.press('ArrowUp')
    await expectFocused(page, 'Click the checkbox to complete me')

    await page.keyboard.press('k')
    await expectFocused(page, 'Drag a card to another list')
  })

  test('→ + l focus the same-row card in the next list', async () => {
    const { page } = handle
    await openBoard(page)
    // Focus card 0 in To Do; → should land on card 0 in In Progress
    // (which only has one card - "Try the label filter above").
    await focusCard(page, 'Drag a card to another list')
    await page.keyboard.press('ArrowRight')
    await expectFocused(page, 'Try the label filter above')

    // l (vim) jumps further right to Done's only card.
    await page.keyboard.press('l')
    await expectFocused(page, 'Scaffold the stack (M0)')
  })

  test('← + h focus the same-row card in the previous list', async () => {
    const { page } = handle
    await openBoard(page)
    await focusCard(page, 'Scaffold the stack (M0)')
    await page.keyboard.press('ArrowLeft')
    await expectFocused(page, 'Try the label filter above')

    await page.keyboard.press('h')
    // In Progress has 1 card → To Do's row 0 is "Drag a card…".
    await expectFocused(page, 'Drag a card to another list')
  })

  test('→ / ← skip past an empty list to reach the populated one beyond', async () => {
    const { page } = handle
    await openBoard(page)

    // Empty In Progress by deleting its only card → layout becomes
    //   [To Do (3 cards)]  [In Progress (0)]  [Done (1)]
    // - exactly the bug-trap scenario for findNextNonEmptyListIndex.
    await card(page, 'Try the label filter above').click({ button: 'right' })
    await page.getByRole('button', { name: 'Delete card' }).click()
    await expect(
      page.getByText('Try the label filter above', { exact: true })
    ).toHaveCount(0)

    // Focus a card in To Do, press →. Before the fix this no-op'd
    // (immediate neighbour was empty). With the fix it lands on
    // Done's card on the far side.
    await focusCard(page, 'Drag a card to another list')
    await page.keyboard.press('ArrowRight')
    await expectFocused(page, 'Scaffold the stack (M0)')

    // Same in reverse - ← from Done skips the empty In Progress to
    // To Do.
    await page.keyboard.press('ArrowLeft')
    await expectFocused(page, 'Drag a card to another list')
  })
})

// ─── Card actions on the focused card ─────────────────────────────

test.describe('Card actions', () => {
  test('Enter + o open the focused card’s detail modal', async () => {
    const { page } = handle
    await openBoard(page)
    await focusCard(page, 'Drag a card to another list')

    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('dialog', { name: 'Drag a card to another list' })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(
      page.getByRole('dialog', { name: 'Drag a card to another list' })
    ).not.toBeVisible()

    // Alternate binding `o`.
    await page.keyboard.press('o')
    await expect(
      page.getByRole('dialog', { name: 'Drag a card to another list' })
    ).toBeVisible()
  })

  test('Space toggles complete on the focused card', async () => {
    const { page } = handle
    await openBoard(page)
    await focusCard(page, 'Click the checkbox to complete me')
    // Title span carries `line-through` when `card.completed` is true
    // (board.tsx). Pre-state on the seeded card: not completed.
    const title = card(page, 'Click the checkbox to complete me')
      .getByText('Click the checkbox to complete me', { exact: true })
      .first()
    await expect(title).not.toHaveClass(/line-through/)

    await page.keyboard.press(' ')
    await expect(title).toHaveClass(/line-through/)

    // Toggle again → uncompleted (line-through gone).
    await page.keyboard.press(' ')
    await expect(title).not.toHaveClass(/line-through/)
  })

  test('Delete removes the focused card + Shift+Backspace works too', async () => {
    const { page } = handle
    await openBoard(page)

    // First: Delete deletes "Drag a card to another list".
    await focusCard(page, 'Drag a card to another list')
    await page.keyboard.press('Delete')
    await expect(
      page.getByText('Drag a card to another list', { exact: true })
    ).toHaveCount(0)

    // Focus auto-handed to the next card in the same list (board.tsx
    // picks below → above → adjacent list before the delete fires).
    // Press Shift+Backspace (the second default binding for
    // card.delete) to delete the new focus target.
    await page.keyboard.press('Shift+Backspace')
    await expect(
      page.getByText('Click the checkbox to complete me', { exact: true })
    ).toHaveCount(0)
  })
})

// ─── Card moves (Alt+arrows) ──────────────────────────────────────

test.describe('Card moves', () => {
  test('Alt+↓ + Alt+↑ reorder a card within its list', async () => {
    const { page } = handle
    await openBoard(page)

    // Anchor the To Do cards-<ul> on a card that won't move within
    // this test - "Hover for the delete + label buttons" stays put
    // at the bottom while we shuffle the top two.
    const todo = cardsListWith(page, 'Hover for the delete + label buttons')
    const cardAt = (i: number): Locator =>
      todo.locator('[data-card-id]').nth(i)

    // Initial order: [Drag…, Click…, Hover…].
    await expect(cardAt(0)).toContainText('Drag a card to another list')
    await expect(cardAt(1)).toContainText('Click the checkbox to complete me')

    // Move the first card down by one - order swaps top two.
    await focusCard(page, 'Drag a card to another list')
    await page.keyboard.press('Alt+ArrowDown')
    await expect(cardAt(0)).toContainText('Click the checkbox to complete me')
    await expect(cardAt(1)).toContainText('Drag a card to another list')

    // And back up.
    await page.keyboard.press('Alt+ArrowUp')
    await expect(cardAt(0)).toContainText('Drag a card to another list')
    await expect(cardAt(1)).toContainText('Click the checkbox to complete me')
  })

  test('Alt+→ + Alt+← move the focused card across lists', async () => {
    const { page } = handle
    await openBoard(page)

    // Move "Drag a card to another list" from To Do → In Progress.
    await focusCard(page, 'Drag a card to another list')
    await page.keyboard.press('Alt+ArrowRight')

    // It now sits in the In Progress cards-<ul> (anchored on the
    // pre-existing card there).
    const inProgress = cardsListWith(page, 'Try the label filter above')
    await expect(
      inProgress.locator('[data-card-id]', {
        hasText: 'Drag a card to another list'
      })
    ).toBeVisible()

    // And it's gone from To Do.
    const todo = cardsListWith(page, 'Hover for the delete + label buttons')
    await expect(
      todo.locator('[data-card-id]', {
        hasText: 'Drag a card to another list'
      })
    ).toHaveCount(0)

    // Alt+← pulls it back. Focus follows the card (the move handler
    // doesn't touch focus state, and the card kept its id so the
    // ring stays on it).
    await page.keyboard.press('Alt+ArrowLeft')
    await expect(
      todo.locator('[data-card-id]', {
        hasText: 'Drag a card to another list'
      })
    ).toBeVisible()
  })
})

// ─── Creation surfaces ────────────────────────────────────────────

test.describe('Creation', () => {
  test('c + n focus the AddCard input on the focused card’s list', async () => {
    const { page } = handle
    await openBoard(page)
    await focusCard(page, 'Drag a card to another list')

    // Press 'c' → dispatcher fires list.newCard → AddCard for To Do
    // focuses its own input (via the `kanbini:add-card` custom event
    // pattern documented in CLAUDE.md). The input becomes the
    // document.activeElement.
    await page.keyboard.press('c')
    const todoAdd = cardsListWith(
      page,
      'Hover for the delete + label buttons'
    )
      // The AddCard input is a sibling of the cards-<ul> inside the
      // same list <section>, so jump up to the section first.
      .locator('xpath=ancestor::section[1]')
      .getByPlaceholder('+ Add a card')
    await expect(todoAdd).toBeFocused()
    // Type something to confirm it actually accepts input.
    await page.keyboard.type('Created via shortcut')
    await page.keyboard.press('Enter')
    await expect(
      page.getByText('Created via shortcut', { exact: true })
    ).toBeVisible()

    // Alternate binding 'n'. Focus a card in a different list to
    // shift the focus context, press 'n', expect THAT list's
    // AddCard input to be focused. (focusCard dismisses the detail
    // modal too - required here since the previous Enter left the
    // AddCard input as document.activeElement; without re-focusing
    // we'd see the wrong list's add-card open up.)
    await focusCard(page, 'Try the label filter above')
    await page.keyboard.press('n')
    const inProgressAdd = cardsListWith(page, 'Try the label filter above')
      .locator('xpath=ancestor::section[1]')
      .getByPlaceholder('+ Add a card')
    await expect(inProgressAdd).toBeFocused()
  })

  test('Shift+L focuses the AddList input', async () => {
    const { page } = handle
    await openBoard(page)

    // No focused-card prerequisite - board.newList is board-scoped.
    await page.keyboard.press('Shift+L')
    const addList = page.getByPlaceholder('+ Add a list')
    await expect(addList).toBeFocused()
    await page.keyboard.type('Created via Shift+L')
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('heading', { name: /^Created via Shift\+L\b/ })
    ).toBeVisible()
  })
})

// ─── App-scoped navigation ────────────────────────────────────────

test.describe('App navigation', () => {
  test('Alt+B returns to the boards home from a board view', async () => {
    const { page } = handle
    await openBoard(page)
    // Confirm we're inside the board.
    await expect(
      page.getByRole('heading', { name: /^To Do\b/ })
    ).toBeVisible()

    await page.keyboard.press('Alt+b')
    // Back at boards home - "Your boards" heading reappears.
    await expect(
      page.getByRole('heading', { name: /your boards/i })
    ).toBeVisible()
    // The board's To Do heading is no longer on the page.
    await expect(
      page.getByRole('heading', { name: /^To Do\b/ })
    ).toHaveCount(0)
  })

  test('Alt+B is swallowed while an overlay is open (back-stack, like Esc)', async () => {
    const { page } = handle
    await openBoard(page)

    // Right-click a card → CardMenu (a [data-overlay] context menu).
    // Right-click doesn't move focus into an input, so the shortcut
    // dispatcher DOES fire - it's the nav.home overlay guard (not the
    // isTypingTarget gate) that must keep us on the board.
    await card(page, 'Drag a card to another list').click({ button: 'right' })
    const menu = page.locator('[data-overlay="context-menu"]')
    await expect(menu).toBeVisible()

    await page.keyboard.press('Alt+b')
    // Still on the board; the menu is still open; home did not appear.
    await expect(menu).toBeVisible()
    await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: /your boards/i })
    ).toHaveCount(0)

    // Dismiss the overlay first, THEN Alt+B navigates home as normal.
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await page.keyboard.press('Alt+b')
    await expect(
      page.getByRole('heading', { name: /your boards/i })
    ).toBeVisible()
  })
})

// ─── isTypingTarget gate ─────────────────────────────────────────

test('typing in an input does NOT fire shortcuts with side effects', async () => {
  const { page } = handle
  await openBoard(page)

  // Focus the AddCard input on the To Do list. It's an <input>, so
  // `useShortcutDispatch`'s `isTypingTarget` check should skip every
  // shortcut - letters land as text in the input instead.
  //
  // The pure-JSDOM hook test in shortcuts.test.ts asserts the gate
  // directly (typing in an input doesn't invoke the handler). Here
  // we assert the user-VISIBLE consequence: pressing 'o' (bound to
  // card.open) while typing in an input does NOT open a card detail
  // modal. That's the failure mode users would actually notice; the
  // exact input-value progression under a fast keyboard.type is too
  // racy to pin reliably (the input's `onBlur=submit` interacts
  // weirdly with mid-type re-renders).
  const todoAdd = cardsListWith(page, 'Hover for the delete + label buttons')
    .locator('xpath=ancestor::section[1]')
    .getByPlaceholder('+ Add a card')
  await todoAdd.click()
  await expect(todoAdd).toBeFocused()

  // 'o' is bound to card.open. If the gate failed, this would open
  // the detail modal of whatever card is focused.
  await page.keyboard.press('o')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // The input is still focused - the gate also prevented the
  // focus-shifting shortcuts from running.
  await expect(todoAdd).toBeFocused()
})
