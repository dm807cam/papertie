import { loadavg } from 'node:os'
import type { Page } from '@playwright/test'
import { APP_URL, apiFor, expect, test } from './helpers/app'
import { saved } from './helpers/board'
import { bookBlocks, seedBooks } from './helpers/books'
import { touchScreen } from './helpers/page'
import { firstRun, onlyBoard, openBoard } from './helpers/server'
import { settle, tools } from './helpers/states'

/**
 * The shelf in the desktop app: Books opens it over the board
 * (which stays mounted under it) and goes back; a new book is made, titled and kept; a long shelf
 * mounts only the covers near the view and scrolls at the display's rate with no long task.
 * `SHELF_SHOTS=<dir>` keeps screenshots of a twelve-book shelf, under the mouse and on a touch
 * screen.
 */

/** A first run's board, open in the window: its id. */
async function firstBoard(page: Page): Promise<string> {
  await firstRun(apiFor(page))
  await openBoard(page)
  return onlyBoard(apiFor(page))
}

const shelf = (page: Page) => page.getByRole('dialog', { name: 'Books' })
const covers = (page: Page) => shelf(page).locator('.cover')

test('Books opens the shelf over the board and goes back; a new book is made and kept', async ({
  page,
}) => {
  const boardId = await firstBoard(page)
  await seedBooks(page, boardId, 3)
  await page.reload()
  await page.waitForFunction(() => window.__papertie?.ready === true)
  const board = page.getByTestId('canvas')
  const books = tools(page).getByRole('button', { name: 'Books' })
  await books.click()
  await expect(shelf(page)).toBeVisible()
  await expect(page).toHaveURL(/\/shelf$/)
  await expect(books).toHaveAttribute('aria-pressed', 'true')
  await expect(board).toHaveAttribute('data-covered')
  await expect(covers(page)).toHaveCount(3)

  await shelf(page).getByRole('button', { name: 'New book' }).click()
  await expect(page).toHaveURL(/\/book\/book_\w+$/)
  const title = page.getByRole('textbox', { name: 'Title' })
  await expect(title).toBeFocused()
  await page.keyboard.type('Winter notes')
  await page.keyboard.press('Escape')
  await expect(shelf(page)).toBeVisible()
  await expect(shelf(page).getByRole('button', { name: 'Winter notes', exact: true })).toBeVisible()
  await expect(covers(page)).toHaveCount(4)

  // Books, pressed: back to the board, the same one, never opened again.
  await books.click()
  await expect(shelf(page)).toBeHidden()
  await expect(page).toHaveURL(/\/$/)
  await expect(board).not.toHaveAttribute('data-covered')

  // Kept: a reload's shelf has it, last.
  await page.goto(`${APP_URL}/shelf`)
  await expect(shelf(page).getByRole('listitem').nth(3)).toHaveAttribute(
    'data-book-title',
    'Winter notes',
  )
})

test('an empty shelf invites a first book; a new book invites a first line, never saved into it', async ({
  page,
}) => {
  const boardId = await firstBoard(page)
  await page.goto(`${APP_URL}/shelf?bench`)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  const invite = shelf(page).getByText('Begin with a first book')
  await expect(invite).toBeVisible()

  await shelf(page).getByRole('button', { name: 'New book' }).click()
  await expect(page).toHaveURL(/\/book\/book_\w+$/)
  const bookId = page.url().split('/book/')[1] as string
  const first = page.locator('.writer-body[data-shown] .bk-book > .bk-p').first()
  await expect(first).toBeVisible()
  // The invitation is drawn by the page's style alone: no text in the paragraph, none saved.
  const before = () => first.evaluate((el) => getComputedStyle(el, '::before').content)
  await expect.poll(before).toBe('"Begin with a first line"')
  expect(await first.textContent()).toBe('')
  await saved(page)
  expect((await bookBlocks(page, boardId, bookId)).map((b) => b.text)).toEqual([''])

  // Typing takes its place: the line goes, and the paragraph holds only what was typed.
  await page.keyboard.press('Enter')
  await page.keyboard.type('Snow')
  await expect.poll(before).toBe('none')
  await saved(page)
  expect((await bookBlocks(page, boardId, bookId)).map((b) => b.text)).toEqual(['Snow'])

  // A shelf with a book on it invites nothing.
  await page.goto(`${APP_URL}/shelf`)
  await expect(shelf(page).getByRole('button', { name: 'New book' })).toBeVisible()
  await expect(invite).toHaveCount(0)
})

test('a shelf of 500 books mounts only the covers near the viewport, and scrolls at 60 fps with no long task', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const boardId = await firstBoard(page)
  await seedBooks(page, boardId, 500)
  await page.goto(`${APP_URL}/shelf`)
  await expect(shelf(page).getByRole('listitem')).toHaveCount(501)
  await settle(page)
  const near = await covers(page).count()
  console.log(`shelf of 500: ${near} covers mounted at open`)
  expect(near).toBeGreaterThan(0)
  expect(near).toBeLessThan(80)

  // Scroll through about fifty covers' worth, as a hand would, timing every frame.
  const run = await page.evaluate(async () => {
    const scroller = document.querySelector('.shelf-scroll') as HTMLElement
    const long: number[] = []
    const obs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) long.push(e.duration)
    })
    obs.observe({ type: 'longtask', buffered: false })
    const frames: number[] = []
    let mostCovers = 0
    await new Promise<void>((done) => {
      let last = performance.now()
      const start = last
      const step = (t: number) => {
        frames.push(t - last)
        last = t
        scroller.scrollTop += 9
        mostCovers = Math.max(mostCovers, document.querySelectorAll('.shelf .cover').length)
        if (t - start < 4000) requestAnimationFrame(step)
        else done()
      }
      requestAnimationFrame(step)
    })
    obs.disconnect()
    frames.shift()
    const sorted = [...frames].sort((a, b) => a - b)
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    return {
      frames: frames.length,
      fps: frames.length / (frames.reduce((a, b) => a + b, 0) / 1000),
      p50: at(0.5),
      p95: at(0.95),
      max: sorted.at(-1),
      long,
      mostCovers,
      scrolled: scroller.scrollTop,
    }
  })
  const load = loadavg()[0]
  console.log(`shelf scroll: ${JSON.stringify(run)} load1 ${load?.toFixed(2)}`)
  test.info().annotations.push({ type: 'shelf-scroll', description: JSON.stringify(run) })
  expect(run.mostCovers).toBeGreaterThanOrEqual(40)
  expect(run.long).toEqual([])
  // Timed only on a quiet machine (load under 4).
  if ((load ?? 0) < 4) expect(run.p95 ?? 99).toBeLessThanOrEqual(17.5)
})

test('a twelve-book shelf, under the mouse and on a touch screen', async ({ page }) => {
  const shots = process.env.SHELF_SHOTS
  const boardId = await firstBoard(page)
  await seedBooks(page, boardId, 12)
  await page.goto(`${APP_URL}/shelf`)
  await expect(covers(page)).toHaveCount(12)
  await page.evaluate(() => document.fonts.ready)
  await settle(page)
  if (shots) await page.screenshot({ path: `${shots}/shelf-desktop.png` })

  // A touch screen: a finger, no hover (so each book's options show).
  const { tap, tapAt } = await touchScreen(page)
  await page.reload()
  await expect(covers(page)).toHaveCount(12)
  await page.evaluate(() => document.fonts.ready)
  await settle(page)
  await expect(shelf(page).getByRole('button', { name: 'Options for Field notes' })).toBeVisible()
  // Every target a finger's 44 px.
  for (const b of await shelf(page).getByRole('button').all()) {
    const box = await b.boundingBox()
    if (box === null) continue
    expect(
      Math.min(box.width, box.height),
      (await b.getAttribute('aria-label')) ?? '',
    ).toBeGreaterThanOrEqual(44)
  }
  if (shots) await page.screenshot({ path: `${shots}/shelf-touch.png` })

  // Recently deleted, with two books to put back.
  for (const title of ['Winter letters', 'Recipes']) {
    await tap(shelf(page).getByRole('button', { name: `Options for ${title}` }))
    await tap(page.getByRole('dialog', { name: title }).getByRole('button', { name: 'Delete' }))
    await tap(page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }))
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
  }
  await tap(shelf(page).getByRole('button', { name: 'Recently deleted' }))
  await expect(
    page.getByRole('dialog', { name: 'Recently deleted' }).getByRole('listitem'),
  ).toHaveCount(2)
  await settle(page)
  if (shots) await page.screenshot({ path: `${shots}/shelf-touch-deleted.png` })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Recently deleted' })).toBeHidden()

  // A tap 10 px below a cover's top right corner is the book's, not its options' (whose
  // press stands above the cover, only its tab over the edge).
  const cover = await shelf(page)
    .getByRole('button', { name: 'Field notes', exact: true })
    .boundingBox()
  if (cover === null) throw new Error('no cover')
  await tapAt(cover.x + cover.width - 10, cover.y + 10)
  await expect(page).toHaveURL(/\/book\/book_\w+$/)
  await expect(page.getByRole('button', { name: 'Rename' })).toHaveCount(0)
})
