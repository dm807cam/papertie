import type { Locator, Page } from '@playwright/test'
import { reloadMessage } from '../../apps/web/src/sync/notices'
import { newId } from '../../packages/core/src'
import { APP_URL, apiFor, expect, test } from './helpers/app'
import { noteEl, paperPoint, saved } from './helpers/board'
import { bookBlocks, opsOn, seedBook } from './helpers/books'
import { exportJsonl, firstRun, onlyBoard, openBoard, serverBoard } from './helpers/server'

/**
 * The split view in the desktop app: an open book beside the live board on a
 * wide window, the board's Part 1 gestures working beside it, the seam dragged and kept,
 * ⌘\ between split and full width, and Papertie opened again into
 * the split view where the writing was left.
 */

const WIDE = { width: 1440, height: 900 }

/** A first run's board, open in the window: its id. */
async function firstBoard(page: Page): Promise<string> {
  await page.setViewportSize(WIDE)
  await firstRun(apiFor(page))
  await openBoard(page)
  return onlyBoard(apiFor(page))
}

const split = (page: Page) => page.locator('.board-split')
const pane = (page: Page) => page.locator('.book-pane')
const board = (page: Page) => page.locator('main.viewport')
const blocks = (page: Page) => page.locator('.writer [data-id]')

async function openSplit(page: Page, bookId: string): Promise<void> {
  await page.goto(`${APP_URL}/book/${bookId}?bench`)
  await expect(blocks(page).first()).toBeVisible()
  await expect(split(page)).toHaveAttribute('data-layout', 'split')
  await page.waitForFunction(() => window.__papertie?.ready === true)
}

const camera = (page: Page) =>
  page.evaluate(() =>
    (window.__papertie.debug.camera as () => { x: number; y: number; zoom: number })(),
  )

test('a book opens beside the live board on a wide window; the board’s Part 1 gestures work beside it', async ({
  page,
}) => {
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, {
    title: 'Beside',
    blocks: [{ text: 'Written beside the board.' }],
  })
  // A second card to tie to, through the app's routes: the welcome card's record, moved.
  const welcome = (await exportJsonl(apiFor(page), boardId))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { type: string; id: string; x: number; rev?: number })
    .find((r) => r.type === 'note')
  const { rev: _rev, ...card } = welcome as { type: string; id: string; x: number; rev?: number }
  const welcomeId = card.id
  await opsOn(page, boardId, [
    {
      op: 'note.create',
      note: { ...card, id: newId('note'), x: card.x + 320, text: 'Second card' },
    },
  ])
  await openSplit(page, bookId)
  // The board's root shrank beside the book; nothing of it is covered.
  const b = await board(page).boundingBox()
  const p = await pane(page).boundingBox()
  expect(b && p && Math.round(b.x + b.width) <= Math.round(p.x) + 1).toBe(true)
  expect(b?.width ?? 0).toBeGreaterThanOrEqual(360)
  expect(p?.width ?? 0).toBeGreaterThanOrEqual(600)
  await expect(board(page)).not.toHaveAttribute('data-covered', /.*/)
  // Pan: a drag on bare cork in the board's half.
  const before = await camera(page)
  const cx = (b?.x ?? 0) + (b?.width ?? 0) * 0.7
  const cy = (b?.y ?? 0) + (b?.height ?? 0) * 0.9
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx - 80, cy - 40, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await camera(page)).x).not.toBe(before.x)
  // Zoom: the wheel with ⌘ over the board.
  const z = (await camera(page)).zoom
  await page.mouse.move(cx, cy)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -200)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await camera(page)).zoom).not.toBe(z)
  // A card dragged.
  // The welcome card (the one the board was made with), wherever the pan and zoom left it.
  const id = welcomeId
  await page.evaluate(
    (id) => (window.__papertie.debug.focusCamera as (id: string, z: number) => void)(id, 1),
    id,
  )
  await page.waitForTimeout(600)
  const at = await paperPoint(page, id)
  const was = (await serverBoard(apiFor(page), boardId)).notes.get(id)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x - 60, at.y + 30, { steps: 8 })
  await page.mouse.up()
  await saved(page)
  await expect
    .poll(async () => (await serverBoard(apiFor(page), boardId)).notes.get(id)?.x)
    .not.toBe(was?.x)
  // A thread tied with C, from the selected card (Connect to…), to the second card.
  const threads = (await serverBoard(apiFor(page), boardId)).yarns.length
  await noteEl(page, id).click()
  await page.keyboard.press('c')
  const connect = page.getByRole('dialog', { name: 'Connect to…' })
  await expect(connect).toBeVisible()
  await page.keyboard.type('Second card')
  await expect(connect.getByRole('option', { name: 'Second card' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(connect).toHaveCount(0)
  await saved(page)
  await expect
    .poll(async () => (await serverBoard(apiFor(page), boardId)).yarns.length)
    .toBe(threads + 1)
  // Focus mode: F on the selected card; Esc leaves it.
  await noteEl(page, id).click()
  await page.keyboard.press('f')
  await expect(page.getByRole('toolbar', { name: 'Focus' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('toolbar', { name: 'Focus' })).toHaveCount(0)
  // The book beside it is still open and still writes.
  await blocks(page).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Still.')
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).map((x) => x.text))
    .toEqual(['Written beside the board. Still.'])
})

test('the seam is dragged and kept; ⌘\\ goes between split and full width; Papertie opened again lands in the split view', async ({
  page,
}) => {
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, {
    title: 'Seam',
    blocks: [{ text: 'A paragraph to come back to.' }],
  })
  await openSplit(page, bookId)
  const seam = page.getByRole('separator', { name: 'Book width' })
  const box = await seam.boundingBox()
  const x = (box?.x ?? 0) + 6
  const y = (box?.y ?? 0) + 300
  await page.mouse.move(x, y)
  await page.mouse.down()
  // Far to the left: the board keeps 360 px.
  await page.mouse.move(40, y, { steps: 10 })
  await expect(pane(page)).toHaveAttribute('data-seam', 'drag')
  await page.mouse.up()
  await expect(pane(page)).not.toHaveAttribute('data-seam', /.*/)
  await expect.poll(async () => Math.round((await board(page).boundingBox())?.width ?? 0)).toBe(360)
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('papertie.split') ?? '{}'))
  expect(kept.ratio).toBeCloseTo(1 - 360 / 1440, 2)
  // The keyboard path: ← grows the book by 5 % (it is at its most: no further), → shrinks it.
  await seam.focus()
  await page.keyboard.press('ArrowRight')
  await expect(seam).toHaveAttribute('aria-valuenow', '70')

  // ⌘\ in the writer: full width, then the board beside it again.
  await blocks(page).first().click()
  await page.keyboard.press('ControlOrMeta+Backslash')
  await expect(split(page)).toHaveAttribute('data-layout', 'full')
  await expect(board(page)).toHaveAttribute('data-covered', 'true')
  await page.keyboard.press('ControlOrMeta+Backslash')
  await expect(split(page)).toHaveAttribute('data-layout', 'split')

  // Written in the split view, then Papertie opened again at the board: back in the book, beside it.
  await blocks(page).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Again.')
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).map((b) => b.text))
    .toEqual(['A paragraph to come back to. Again.'])
  await page.goto(`${APP_URL}/?bench`)
  await expect(page).toHaveURL(new RegExp(`/book/${bookId}`))
  await expect(split(page)).toHaveAttribute('data-layout', 'split')
  await expect(blocks(page).first()).toBeVisible()
  await expect(seam).toHaveAttribute('aria-valuenow', '70')
})

test('a slip over the split view stands on the pane worked in, never across the seam', async ({
  page,
}) => {
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, {
    title: 'Slip',
    blocks: [{ text: 'Written beside the board.' }],
  })
  await openSplit(page, bookId)
  const box = async (loc: Locator) => {
    const b = await loc.boundingBox()
    if (b === null) throw new Error('not laid out')
    return b
  }
  const middle = async (loc: Locator) => {
    const b = await box(loc)
    return b.x + b.width / 2
  }
  const slip = page.locator('.sync-updated [role="note"]')

  // Writing in the book: the slip that asks for a reload comes over the book's pane.
  await blocks(page).first().click()
  await page.evaluate((message) => {
    const m = window.__papertie as unknown as {
      session: { feed: { notice(n: { kind: string; count: number; message: string }): void } }
    }
    m.session.feed.notice({ kind: 'updated', count: 0, message })
  }, reloadMessage())
  await expect(slip).toBeVisible()
  const book = await middle(pane(page))
  await expect.poll(async () => Math.abs((await middle(slip)) - book)).toBeLessThan(2)
  expect((await box(slip)).x).toBeGreaterThan((await box(pane(page))).x)

  // A press on the board's cork: the user works there now, and the slip moves to the board.
  const cork = await box(board(page))
  await page.mouse.click(cork.x + cork.width - 80, cork.y + 80)
  const onBoard = await middle(board(page))
  await expect.poll(async () => Math.abs((await middle(slip)) - onBoard)).toBeLessThan(2)
  const s = await box(slip)
  expect(s.x + s.width).toBeLessThan((await box(pane(page))).x)
})

test('below 1024 px the book is full width, and Board goes to the board', async ({ page }) => {
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, { title: 'Narrow', blocks: [{ text: 'Small.' }] })
  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto(`${APP_URL}/book/${bookId}?bench`)
  await expect(blocks(page).first()).toBeVisible()
  await expect(split(page)).toHaveAttribute('data-layout', 'full')
  await page.getByRole('button', { name: 'Board', exact: true }).click()
  await expect(page).toHaveURL(/\/(\?bench)?$/)
  await expect(pane(page)).toHaveCount(0)
})
