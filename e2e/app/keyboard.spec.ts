import type { Page } from '@playwright/test'
import { APP_URL, apiFor, expect, test } from './helpers/app'
import {
  exportJsonl,
  firstRun,
  onlyBoard,
  openBoard,
  serverBoard,
  waitReady,
} from './helpers/server'

/**
 * The whole workflow with the keyboard alone: nothing but
 * `keyboard.press` and `keyboard.type` drives the page, from the first open to the reload. Every step
 * asserts what the page's live region (`apps/web/src/app/liveRegion.ts`) says. The page is read
 * through the DOM and the server; `window.__papertie` is read only after the reload, which opens
 * the board with the test hooks.
 */

const WELCOME = 'Use + to pin a thought'

/** The save dot says Saved (read from the DOM: the test hooks are not on this page). */
const saved = (page: Page) =>
  expect(page.getByTestId('save-dot')).toHaveAttribute('data-status', 'saved', { timeout: 15_000 })

/** What the live region says now (its toggled trailing space left out). */
const said = (page: Page) =>
  page.evaluate(
    () => document.querySelector('[data-live-region]')?.textContent?.replace(/[\s ]+$/, '') ?? '',
  )

/** The live region says `text`. */
async function says(page: Page, text: string): Promise<void> {
  await expect.poll(() => said(page), { timeout: 10_000 }).toBe(text)
}

/** The focused element's accessible name, as far as the page says it. */
const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el) return ''
    return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()
  })

/** Tab (or Shift+Tab) until the focus is on what is named `name`; at most `max` presses. */
async function tabTo(page: Page, name: string, o: { back?: boolean; max?: number } = {}) {
  for (let i = 0; i < (o.max ?? 40); i++) {
    if ((await focusedName(page)) === name) return
    await page.keyboard.press(o.back ? 'Shift+Tab' : 'Tab')
  }
  throw new Error(`Tab never reached "${name}"; the focus is on "${await focusedName(page)}"`)
}

const note = (page: Page, name: string) => page.getByRole('article', { name, exact: true })
const noteId = async (page: Page, name: string) =>
  (await note(page, name).getAttribute('data-note-id')) ?? ''

/**
 * A note from "+": Tab to it, Enter, `arrows` presses of → through the papers (landing on the
 * `position`th of eight), Enter, write.
 */
async function pinWithKeys(
  page: Page,
  text: string,
  arrows: number,
  back: boolean,
  position: number,
) {
  await tabTo(page, 'New note', { back })
  await page.keyboard.press('Enter')
  const picker = page.getByRole('dialog', { name: 'New note' })
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('radio', { checked: true }).first()).toBeFocused()
  const papers = picker.getByRole('group', { name: 'Paper' }).getByRole('radio')
  await expect(papers).toHaveCount(8)
  for (let i = 0; i < arrows; i++) await page.keyboard.press('ArrowRight')
  // "<paper>, selected, radio button, <position> of 8".
  expect(
    await papers.evaluateAll((els) => els.findIndex((e) => (e as HTMLInputElement).checked) + 1),
  ).toBe(position)
  const paper =
    (await picker.getByRole('radio', { checked: true }).first().getAttribute('aria-label')) ?? ''
  await page.keyboard.press('Enter')
  await expect(picker).toHaveCount(0)
  await expect(page.locator('[contenteditable]').first()).toBeFocused()
  await says(page, `New ${paper} note. Write, then Esc.`)
  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
  await expect(note(page, text)).toBeFocused()
  await expect(note(page, text)).toHaveAccessibleDescription('Selected')
  return paper
}

test('the whole workflow works with the keyboard alone', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await firstRun(apiFor(page))

  // 1. The board opens on the welcome note, with no sign-in.
  await page.goto(`${APP_URL}/`)
  await expect(page).toHaveURL(/\/$/)
  await expect(note(page, WELCOME)).toBeVisible()
  await says(page, 'Your board is open: 1 note')
  const boardId = await onlyBoard(apiFor(page))
  // The first Tab reaches the sidebar's mark, which folds the tools away.
  await page.keyboard.press('Tab')
  const mark = page.getByRole('button', { name: 'Papertie — hide tools' })
  await expect(mark).toBeFocused()
  await expect(mark).toHaveAttribute('aria-expanded', 'true')

  // 2. Tab to the sidebar's New note, Enter, an arrow to another paper, Enter: the note is
  // pinned open for writing. Write, then Esc: the note keeps the focus.
  const first = await pinWithKeys(page, 'Spring trip', 3, false, 4)
  expect(first).toBe('Indigo')
  const spring = await noteId(page, 'Spring trip')
  await expect(note(page, 'Spring trip')).toHaveAttribute('data-paper', 'indigo')

  // 3. A second note the same way, on a different paper (the sheet opens on the last one).
  const second = await pinWithKeys(page, 'Packing list', 1, true, 5)
  expect(second).toBe('Sage')
  const packing = await noteId(page, 'Packing list')
  await expect(note(page, 'Packing list')).toHaveAttribute('data-paper', 'sage')
  await expect
    .poll(async () => (await serverBoard(apiFor(page), boardId)).notes.get(packing)?.text)
    .toBe('Packing list')

  // 4. Alt+arrows move it: Shift+Alt for ten world px a press, Alt for one.
  const before = (await serverBoard(apiFor(page), boardId)).notes.get(packing)
  for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+Alt+ArrowRight')
  await page.keyboard.press('Alt+ArrowDown')
  await says(page, 'Moved 1 note')
  await expect
    .poll(async () => {
      const n = (await serverBoard(apiFor(page), boardId)).notes.get(packing)
      return [(n?.x ?? 0) - (before?.x ?? 0), (n?.y ?? 0) - (before?.y ?? 0)]
    })
    .toEqual([120, 1])
  const moved = (await serverBoard(apiFor(page), boardId)).notes.get(packing)

  // 5. C ties it to the first through Connect to…: its description names the note it is tied
  // to, by the thread's colour.
  await page.keyboard.press('c')
  const connect = page.getByRole('dialog', { name: 'Connect to…' })
  await expect(connect).toBeVisible()
  await page.keyboard.type('Spring')
  await expect(connect.getByRole('option', { name: 'Spring trip' })).toBeVisible()
  await expect(connect.getByRole('status')).toHaveText('1 note')
  await page.keyboard.press('Enter')
  await expect(connect).toHaveCount(0)
  await says(page, 'Tied “Packing list” to “Spring trip” with crimson yarn')
  await expect(note(page, 'Packing list')).toBeFocused()
  await expect(note(page, 'Packing list')).toHaveAccessibleDescription(
    'Tied to “Spring trip” by crimson yarn. Selected',
  )
  await expect(note(page, 'Spring trip')).toHaveAccessibleDescription(
    'Tied to “Packing list” by crimson yarn.',
  )
  // And the first to the welcome note, so focus has a second step to take.
  await tabTo(page, 'Spring trip', { back: true })
  await expect(note(page, 'Spring trip')).toBeFocused()
  await page.keyboard.press('c')
  await expect(connect).toBeVisible()
  await page.keyboard.type('pin a thought')
  await expect(connect.getByRole('option', { name: WELCOME })).toBeVisible()
  await page.keyboard.press('Enter')
  await says(page, `Tied “Spring trip” to “${WELCOME}” with crimson yarn`)
  await expect(note(page, 'Spring trip')).toHaveAccessibleDescription(
    `Tied to “Packing list” and “${WELCOME}” by crimson yarn. Selected`,
  )
  await saved(page)

  // 6. F focuses Packing list; Tab to the chip's More steps and Enter: two steps; Esc leaves
  // focus, and the board file is as it was.
  const file = await exportJsonl(apiFor(page), boardId)
  await tabTo(page, 'Packing list')
  await expect(note(page, 'Packing list')).toBeFocused()
  await page.keyboard.press('f')
  const chip = page.getByRole('toolbar', { name: 'Focus' })
  await expect(chip).toContainText('1 step')
  await says(page, 'Focus, 1 step: 2 notes')
  await tabTo(page, 'More steps', { back: true })
  await expect(chip.getByRole('button', { name: 'More steps' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(chip).toContainText('2 steps')
  await says(page, 'Focus, 2 steps: 3 notes')
  await page.keyboard.press('Escape')
  await expect(chip).toHaveCount(0)
  await says(page, 'Showing the whole board')
  await saved(page)
  expect(await exportJsonl(apiFor(page), boardId)).toBe(file)

  // 7. ⌘K finds Spring trip; Enter goes to it.
  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('dialog', { name: 'Search notes' })
  await expect(search).toBeVisible()
  await page.keyboard.type('Spring trip')
  await expect(search.getByRole('option', { name: 'Spring trip' })).toBeVisible()
  await expect(search.getByRole('status')).toHaveText('1 note')
  await page.keyboard.press('Enter')
  await expect(search).toHaveCount(0)
  await says(page, 'Showing Spring trip')

  // 8. ⌘Z undoes the last change: the welcome note's thread.
  await page.keyboard.press('ControlOrMeta+z')
  await says(page, 'Undid tie')
  await expect
    .poll(async () => (await serverBoard(apiFor(page), boardId)).yarns.map((y) => y.noteIds))
    .toEqual([[packing, spring]])

  // 9. Reload: everything persisted.
  await page.goto(`${APP_URL}/?bench`)
  await waitReady(page)
  await says(page, 'Your board is open: 3 notes')
  const after = await serverBoard(apiFor(page), boardId)
  expect(after.notes.get(spring)).toMatchObject({ text: 'Spring trip', paper: 'indigo' })
  expect(after.notes.get(packing)).toMatchObject({
    text: 'Packing list',
    paper: 'sage',
    x: moved?.x,
    y: moved?.y,
  })
  expect(after.yarns.map((y) => y.noteIds)).toEqual([[packing, spring]])
  expect(
    await page.evaluate(() =>
      [...window.__papertie.store.getState().yarns.values()].map((y) => [...y.noteIds]),
    ),
  ).toEqual([[packing, spring]])
  await expect(note(page, 'Packing list')).toHaveAccessibleDescription(
    'Tied to “Spring trip” by crimson yarn.',
  )
  expect(errors).toEqual([])
})

/**
 * The save dot's popover is not modal: Tab leaves it, and ⌘K, a note or Settings can take the
 * keyboard while it stays open. Esc there belongs to what has the focus, never to the popover.
 */
test.describe('Esc while the save-dot popover is open', () => {
  const pop = (page: Page) => page.getByRole('dialog', { name: 'Save status' })

  /** A fresh board, and its popover open with the focus in it (a nudge shows the dot). */
  async function openPopover(page: Page) {
    if (!(await page.getByTestId('canvas').count())) {
      await firstRun(apiFor(page))
      await openBoard(page)
    }
    await note(page, WELCOME).focus()
    await page.keyboard.press('Alt+ArrowRight')
    const dot = page.getByTestId('save-dot')
    await expect(dot).toHaveAttribute('data-shown', 'true')
    await dot.focus()
    await page.keyboard.press('Enter')
    await expect(pop(page)).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => !!document.activeElement?.closest('[aria-label="Save status"]')),
      )
      .toBe(true)
  }

  test('Esc in ⌘K closes the palette', async ({ page }) => {
    await openPopover(page)
    await page.keyboard.press('ControlOrMeta+k')
    const search = page.getByRole('dialog', { name: 'Search notes' })
    await expect(search.getByRole('combobox')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)
    // The focus went back where it was, in the popover: its own Esc closes it.
    await page.keyboard.press('Escape')
    await expect(pop(page)).toHaveCount(0)
  })

  test('Esc in the note editor ends the writing', async ({ page }) => {
    await openPopover(page)
    const welcome = note(page, WELCOME)
    await welcome.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('[contenteditable]').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator('[contenteditable]')).toHaveCount(0)
    await expect(welcome).toBeFocused()
    await expect(pop(page)).toBeVisible()
  })

  test('Esc in Settings closes Settings', async ({ page }) => {
    await openPopover(page)
    await page
      .getByRole('toolbar', { name: 'Tools' })
      .getByRole('button', { name: 'Settings' })
      .focus()
    await page.keyboard.press('Enter')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
  })
})
