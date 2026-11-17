import type { Page } from '@playwright/test'
import { axeViolations } from './a11y-exceptions'
import { APP_URL, apiFor, type Desktop, expect, test } from './helpers/app'
import { saved } from './helpers/board'
import { bookBlocks, seedBook } from './helpers/books'
import { firstRun, onlyBoard, openBoard } from './helpers/server'
import { settle, tools, writing } from './helpers/states'

/**
 * The narrow layout in the desktop app. Under 768 CSS px the sidebar gives way to the mini-bar,
 * and a desktop window gets there: its least width is 720 px (`apps/desktop/src/windowState.ts`,
 * `MIN_WIDTH`), and a 1440 px window zoomed to 200 % lays out at 720 too. A narrow window with a
 * mouse and a keyboard, as on a desk: no touch.
 */
const NARROW = { width: 720, height: 800 }

/** The mini-bar's least target, as its stylesheet has it (`.minibar`, `--sb-btn`). */
const TARGET = 44

/** A first run's board, open in a window `NARROW` wide: the window and the board's id. */
async function narrowBoard(desktop: Desktop): Promise<{ page: Page; boardId: string }> {
  const { page } = await desktop.launch({ viewport: NARROW })
  await firstRun(apiFor(page))
  await openBoard(page)
  await saved(page)
  return { page, boardId: await onlyBoard(apiFor(page)) }
}

/** The page is no wider than the window, and `chrome` (what stands over the board) lies in it. */
async function fitsAcross(page: Page, chrome: string): Promise<void> {
  const read = await page.evaluate((chrome) => {
    const root = document.documentElement
    const boxes = [...document.querySelectorAll(chrome)].map((el) => {
      const r = el.getBoundingClientRect()
      return { left: Math.round(r.left), right: Math.round(r.right) }
    })
    return { inner: innerWidth, page: root.scrollWidth, body: document.body.scrollWidth, boxes }
  }, chrome)
  expect(read.inner).toBe(NARROW.width)
  expect(read.page, 'the page scrolls nowhere sideways').toBeLessThanOrEqual(NARROW.width)
  expect(read.body, 'the page scrolls nowhere sideways').toBeLessThanOrEqual(NARROW.width)
  expect(read.boxes.length, `${chrome} is on the page`).toBeGreaterThan(0)
  for (const box of read.boxes) {
    expect(box.left, `${chrome}: its left edge`).toBeGreaterThanOrEqual(0)
    expect(box.right, `${chrome}: its right edge`).toBeLessThanOrEqual(NARROW.width)
  }
}

/** Every control showing in the mini-bar: its name and its smaller side, in CSS px. */
const targets = (page: Page) =>
  tools(page).evaluate((bar) =>
    [...bar.querySelectorAll<HTMLElement>('button, [role="button"], a[href], input')]
      .filter((el) => el.checkVisibility({ visibilityProperty: true }))
      .map((el) => {
        const r = el.getBoundingClientRect()
        return {
          name: el.getAttribute('aria-label') ?? el.textContent ?? el.tagName,
          least: Math.round(Math.min(r.width, r.height) * 100) / 100,
        }
      }),
  )

/** The pointer on bare ground, what opened faded in: axe reads the state as it stands. */
async function clean(page: Page): Promise<void> {
  await page.mouse.move(NARROW.width - 2, NARROW.height - 2)
  await settle(page)
  expect(await axeViolations(page)).toEqual([])
}

test('at 720 px the mini-bar stands in for the sidebar, and every tool in it is in reach', async ({
  desktop,
}) => {
  const { page } = await narrowBoard(desktop)
  const bar = tools(page)
  const tool = (name: string) => bar.getByRole('button', { name, exact: true })

  // The page is the window's size: nothing makes it scroll as a whole.
  expect(
    await page.evaluate(() => {
      const d = document.documentElement
      return [
        d.scrollWidth - d.clientWidth,
        d.scrollHeight - d.clientHeight,
        innerWidth - d.clientWidth,
      ]
    }),
  ).toEqual([0, 0, 0])
  // The mini-bar, and no sidebar: one toolbar, lying along the window's foot.
  await expect(page.locator('.minibar')).toBeVisible()
  await expect(page.locator('.sidebar')).toHaveCount(0)
  await expect(bar).toHaveCount(1)
  await expect(bar).toHaveClass(/\bminibar\b/)
  await expect(bar).toHaveAttribute('aria-orientation', 'horizontal')
  const box = (await bar.boundingBox()) as { x: number; y: number; width: number; height: number }
  expect(box.width).toBeGreaterThan(box.height)
  expect(box.y + box.height).toBeLessThanOrEqual(NARROW.height)
  expect(box.y).toBeGreaterThan(NARROW.height / 2)

  // The board's tools, the sidebar's set, by the names they have there.
  for (const name of ['New note', 'Select', 'Yarn', 'Photo', 'Search', 'Books', 'Settings']) {
    await expect(tool(name), name).toBeVisible()
  }
  const shown = await targets(page)
  expect(shown.length).toBeGreaterThanOrEqual(7)
  for (const t of shown) {
    expect(t.least, `${t.name}: its smaller side`).toBeGreaterThanOrEqual(TARGET)
  }
  await fitsAcross(page, '.minibar')
  await clean(page)

  // New note pins a note.
  const notes = page.locator('article.note')
  await expect(notes).toHaveCount(1)
  await tool('New note').click()
  const picker = page.getByRole('dialog', { name: 'New note' })
  await expect(picker).toBeVisible()
  await fitsAcross(page, '.picker-sheet')
  await picker.getByRole('button', { name: 'Pin note' }).click()
  await expect(notes).toHaveCount(2)
  await expect(page.locator('[contenteditable]').first()).toBeFocused()
  await page.keyboard.type('Pinned in a narrow window')
  await page.keyboard.press('Escape')
  await expect(notes.filter({ hasText: 'Pinned in a narrow window' })).toHaveCount(1)
  await saved(page)

  // Books opens the shelf, the mini-bar still in use over its foot; pressed again, the board.
  await tool('Books').click()
  const shelf = page.getByRole('dialog', { name: 'Books' })
  await expect(shelf).toBeVisible()
  await expect(tool('Books')).toHaveAttribute('aria-pressed', 'true')
  await expect(tool('New note')).toHaveCount(0)
  await expect(tool('Search')).toBeVisible()
  await expect(tool('Settings')).toBeVisible()
  await settle(page)
  await fitsAcross(page, '.shelf, .minibar')
  await tool('Books').click()
  await expect(shelf).toHaveCount(0)
  await expect(tool('New note')).toBeVisible()
  await expect(tool('Books')).toHaveAttribute('aria-pressed', 'false')

  // Search opens the palette.
  await tool('Search').click()
  const search = page.getByRole('dialog', { name: 'Search notes' })
  await expect(search).toBeVisible()
  await settle(page)
  await fitsAcross(page, '.picker')
  await page.keyboard.press('Escape')
  await expect(search).toHaveCount(0)

  // Settings opens over the whole window, and closes from its own sheet.
  await tool('Settings').click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await settle(page)
  await fitsAcross(page, '.settings-sheet')
  const sheet = (await settings.boundingBox()) as { x: number; width: number; height: number }
  expect(Math.round(sheet.x)).toBe(0)
  expect(Math.round(sheet.width)).toBe(NARROW.width)
  expect(Math.round(sheet.height)).toBe(NARROW.height)
  await settings.getByRole('button', { name: 'Close' }).click()
  await expect(settings).toHaveCount(0)
  await expect(tool('Settings')).toHaveAttribute('aria-pressed', 'false')
})

test('at 720 px a book opens across the whole window and is written in', async ({ desktop }) => {
  const { page, boardId } = await narrowBoard(desktop)
  const bookId = await seedBook(page, boardId, {
    title: 'Field notes',
    blocks: [{ text: 'Who writes thinks twice.' }, { text: '' }],
  })
  await page.goto(`${APP_URL}/book/${bookId}`)
  const book = page.getByRole('dialog', { name: 'Field notes' })
  const blocks = page.locator('.writer [data-id]')
  await expect(book).toBeVisible()
  await expect(blocks.first()).toBeVisible()
  await settle(page)

  // Full width: the sheet is the window, not a pane beside the board.
  await expect(page.locator('.book-pane')).toHaveAttribute('data-layout', 'full')
  const sheet = (await page.locator('.writer').boundingBox()) as { x: number; width: number }
  expect(Math.round(sheet.x)).toBe(0)
  expect(Math.round(sheet.width)).toBe(NARROW.width)
  await fitsAcross(page, '.writer, .writer-page, .minibar')

  // The mini-bar under a book: the writer's tools in a row above Books, Search and Settings.
  await expect(page.locator('.sidebar')).toHaveCount(0)
  await expect(page.locator('.minibar')).toHaveAttribute('data-sheet', 'book')
  await expect(writing(page)).toBeVisible()
  for (const name of ['Books', 'Search', 'Settings']) {
    await expect(tools(page).getByRole('button', { name, exact: true }), name).toBeVisible()
  }
  for (const t of await targets(page)) {
    expect(t.least, `${t.name}: its smaller side`).toBeGreaterThanOrEqual(TARGET)
  }

  // Typed in with real keys; the store holds it.
  await blocks.nth(1).click()
  await page.keyboard.type('Written at the least width.')
  await expect(blocks.nth(1)).toHaveText('Written at the least width.')
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).map((b) => b.text), {
      timeout: 15_000,
    })
    .toEqual(['Who writes thinks twice.', 'Written at the least width.'])
  // A line of the measure stays on the page: nothing to scroll sideways for.
  await fitsAcross(page, '.writer, .writer-page, .minibar')
  await clean(page)
})
