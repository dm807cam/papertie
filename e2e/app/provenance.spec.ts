import type { Page } from '@playwright/test'
import { newId } from '../../packages/core/src'
import { axeViolations } from './a11y-exceptions'
import { APP_URL, apiFor, expect, test } from './helpers/app'
import { saved } from './helpers/board'
import { bookBlocks, opsOn, seedBook } from './helpers/books'
import { exportJsonl, firstRun, onlyBoard, openBoard, serverBoard } from './helpers/server'

/**
 * Provenance in the built app: the brass pins in the
 * book's margin beside text that came from a card (its peek, a click that shows the card on the
 * board, Remove pin and its undo), and the reverse view, the card's ink mark listing the books
 * using it and the book it came from, each opening its book at the place. Axe finds no serious
 * violation with both shown, and nothing breaks the CSP.
 */

const WIDE = { width: 1440, height: 900 }

/** Card `id` on the board (not a pin's peek of it in the book). */
const noteEl = (page: Page, id: string) =>
  page.locator('main.viewport').locator(`article.note[data-note-id="${id}"]`)

type Rec = { type: string; id: string; x: number; y: number; rev?: number }

/**
 * The board with one card ("Lantern festival"), a book whose third paragraph came from it (its
 * card mark, the store's `cards` stamped), and the book the card came from (`from`).
 */
async function seeded(page: Page) {
  await firstRun(apiFor(page))
  await openBoard(page)
  const boardId = await onlyBoard(apiFor(page))
  const welcome = (await exportJsonl(apiFor(page), boardId))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Rec)
    .find((r) => r.type === 'note') as Rec
  const { rev: _rev, ...base } = welcome
  const card = newId('note')
  const origin = await seedBook(page, boardId, {
    title: 'Where it began',
    blocks: [{ text: 'An opening line.' }, { text: 'The lantern came from here.' }],
  })
  const [, fromBlock] = await bookBlocks(page, boardId, origin)
  await opsOn(page, boardId, [
    {
      op: 'note.create',
      note: {
        ...base,
        id: card,
        x: base.x + 320,
        text: 'Lantern festival\n\nBy the river at dusk',
        from: { book: origin, block: fromBlock?.id },
      },
    },
  ])
  const bookId = await seedBook(page, boardId, {
    title: 'River notes',
    blocks: [
      { text: 'The first paragraph.' },
      { text: 'The second paragraph.' },
      { text: 'Lantern festival', marks: [{ t: `c:${card}`, from: 0, to: 16 }] },
      { text: 'The last paragraph.' },
    ],
  })
  const blocks = await bookBlocks(page, boardId, bookId)
  return { boardId, card, bookId, origin, used: blocks[2]?.id as string, fromBlock: fromBlock?.id }
}

async function openSplit(page: Page, bookId: string): Promise<void> {
  await page.goto(`${APP_URL}/book/${bookId}?bench`)
  await expect(page.locator('.writer-body[data-shown] [data-id]').first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.locator('.board-split')).toHaveAttribute('data-layout', 'split')
  await page.waitForFunction(() => window.__papertie?.ready === true)
}

/** Card `id` brought into the board's view at zoom 1. */
async function showCard(page: Page, id: string) {
  await page.evaluate(
    (id) => (window.__papertie.debug.focusCamera as (id: string, z: number) => void)(id, 1),
    id,
  )
  await page.waitForTimeout(600)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] }
    w.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`)
    })
  })
})

const cspViolations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)

test('a pin beside text from a card: its peek shows the card, a click shows it on the board, Remove pin is one undo step', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize(WIDE)
  const { boardId, card, bookId, used } = await seeded(page)
  await openSplit(page, bookId)
  const pin = page.getByRole('button', { name: 'From a card: Lantern festival' })
  await expect(pin).toBeVisible()
  // In the page's left margin, at its paragraph's top.
  const para = await page.locator(`.writer [data-id="${used}"]`).boundingBox()
  const at = await pin.boundingBox()
  if (para === null || at === null) throw new Error('no paragraph or pin')
  expect(at.x + at.width).toBeLessThanOrEqual(para.x)
  expect(Math.abs(at.y - para.y)).toBeLessThan(24)
  // Hover: the card, drawn as on the board.
  await pin.hover()
  const peek = page.locator('.card-peek')
  await expect(peek).toBeVisible()
  await expect(peek.locator('article.note')).toContainText('Lantern festival')
  expect(await axeViolations(page)).toEqual([])
  // A click: the card on the board, centred and selected.
  await pin.click()
  await expect(noteEl(page, card)).toHaveClass(/note--selected/)
  const view = await page.locator('main.viewport').boundingBox()
  if (view === null) throw new Error('no board')
  // Once the camera has come to it.
  await expect
    .poll(async () => {
      const box = await noteEl(page, card).boundingBox()
      if (box === null) throw new Error('no card')
      return Math.abs(box.x + box.width / 2 - (view.x + view.width / 2))
    })
    .toBeLessThan(view.width / 4)
  // Remove pin: the mark is gone; one undo puts it back.
  await pin.hover()
  await peek.getByRole('button', { name: 'Remove pin' }).click()
  await expect(pin).toHaveCount(0)
  await saved(page)
  await expect.poll(async () => (await bookBlocks(page, boardId, bookId))[2]?.marks).toEqual([])
  await page.locator(`.writer [data-id="${used}"]`).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(pin).toBeVisible()
  await saved(page)
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId))[2]?.marks)
    .toEqual([{ t: `c:${card}`, from: 0, to: 16 }])
  expect(await cspViolations(page)).toEqual([])
})

test('the reverse mark lists the shelf books using the card and the book it came from; each opens the book at the place', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize(WIDE)
  const { card, bookId, origin, used, fromBlock } = await seeded(page)
  await page.goto(`${APP_URL}/?bench`)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await showCard(page, card)
  const ink = noteEl(page, card).locator('.note-ink')
  await expect(ink).toHaveAttribute('data-ink', 'used')
  await ink.click()
  const pop = page.getByRole('dialog', { name: 'Card uses' })
  await expect(pop).toBeVisible()
  const usedIn = pop.getByRole('group', { name: 'Used in' })
  await expect(usedIn.getByRole('button')).toHaveText(['River notes'])
  const from = pop.getByRole('group', { name: 'From' })
  await expect(from.getByRole('button')).toHaveText(['Where it began'])
  expect(await axeViolations(page)).toEqual([])
  // "Used in": the book beside the board, at the paragraph naming the card.
  await usedIn.getByRole('button', { name: 'River notes' }).click()
  await expect(page).toHaveURL(new RegExp(`/book/${bookId}`))
  await expect(page.locator('.board-split')).toHaveAttribute('data-layout', 'split')
  const para = page.locator(`.writer-body[data-shown] [data-id="${used}"]`)
  await expect(para).toBeInViewport()
  // "From": the book it came from, at its paragraph.
  await showCard(page, card)
  await noteEl(page, card).locator('.note-ink').click()
  await page
    .getByRole('dialog', { name: 'Card uses' })
    .getByRole('group', { name: 'From' })
    .getByRole('button', { name: 'Where it began' })
    .click()
  await expect(page).toHaveURL(new RegExp(`/book/${origin}`))
  await expect(page.locator(`.writer-body[data-shown] [data-id="${fromBlock}"]`)).toBeInViewport()
  expect(await cspViolations(page)).toEqual([])
  // The store keeps the uses (its stamp): the card stays on the board, named by the book.
  const s = await serverBoard(apiFor(page), await onlyBoard(apiFor(page)))
  expect(s.notes.has(card)).toBe(true)
})
