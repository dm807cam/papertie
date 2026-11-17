import type { Page } from '@playwright/test'
import { newId } from '../../packages/core/src'
import { genBookBlocks } from '../../tools/src/genBook'
import { axeViolations } from './a11y-exceptions'
import { APP_URL, apiFor, expect, test } from './helpers/app'
import { paperPoint, saved } from './helpers/board'
import { bookBlocks, opsOn, seedBook } from './helpers/books'
import { touchScreen } from './helpers/page'
import { exportJsonl, firstRun, onlyBoard, openBoard, serverBoard } from './helpers/server'
import { writing } from './helpers/states'

/**
 * Cards across the seam in the desktop app: a card
 * dragged from the board into the book beside it lands in the gap the line shows, as a copy or
 * (⌥ held) a move that one undo takes back; the chooser after it; a drop deep in a long, windowed
 * book; and on a touch screen, a long press's Copy · Move.
 */

const WIDE = { width: 1440, height: 900 }
const TABLET = { width: 1366, height: 1024 }

type Rec = { type: string; id: string; x: number; y: number; rev?: number }

/** A first run's board with two cards beside its welcome card, all three on one thread. */
async function boardWithCards(page: Page) {
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
  const other = newId('note')
  const thread = newId('yarn')
  const at = new Date().toISOString()
  await opsOn(page, boardId, [
    {
      op: 'note.create',
      note: {
        ...base,
        id: card,
        x: base.x + 320,
        text: 'Lantern festival\n\nBy the river at dusk',
      },
    },
    { op: 'note.create', note: { ...base, id: other, x: base.x + 640, text: 'Second card' } },
    {
      op: 'yarn.create',
      yarn: {
        type: 'yarn',
        id: thread,
        noteIds: [welcome.id, card, other],
        color: 'apricot',
        label: '',
        createdAt: at,
        updatedAt: at,
      },
    },
  ])
  return { boardId, card, other, thread, welcome: welcome.id }
}

async function openSplit(page: Page, bookId: string): Promise<void> {
  await page.goto(`${APP_URL}/book/${bookId}?bench`)
  await expect(page.locator('.writer-body[data-shown] [data-id]').first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.locator('.board-split')).toHaveAttribute('data-layout', 'split')
  await page.waitForFunction(() => window.__papertie?.ready === true)
}

/** Card `id` brought into the board's view at zoom 1; a point on its paper. */
async function cardPoint(page: Page, id: string) {
  await page.evaluate(
    (id) => (window.__papertie.debug.focusCamera as (id: string, z: number) => void)(id, 1),
    id,
  )
  await page.waitForTimeout(600)
  return paperPoint(page, id)
}

/** The page's point at the lower part of block `blockId` (its gap after it). */
async function belowMiddleOf(page: Page, blockId: string) {
  const box = await page.locator(`.writer [data-id="${blockId}"]`).boundingBox()
  if (box === null) throw new Error(`block ${blockId} not shown`)
  return { x: box.x + box.width / 2, y: box.y + box.height * 0.8 }
}

const said = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-live-region]')?.textContent?.trim() ?? '')

test('a card dropped into the book is a copy with its pin; ⌥ at the drop moves: the card leaves the board, its threads close, and one undo brings both back', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize(WIDE)
  const { boardId, card, other, thread, welcome } = await boardWithCards(page)
  const bookId = await seedBook(page, boardId, {
    title: 'River notes',
    blocks: [{ text: 'The first paragraph.' }, { text: 'The last paragraph.' }],
  })
  await openSplit(page, bookId)
  const [first] = await bookBlocks(page, boardId, bookId)

  // A copy: the card stays, its text lands after the first paragraph, pinned to it.
  let at = await cardPoint(page, card)
  let to = await belowMiddleOf(page, first?.id as string)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 40, at.y + 10, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await expect(page.locator('.bk-drop-gap')).toHaveAttribute('data-after', first?.id as string)
  await expect(page.locator('.card-ghost')).toContainText('Lantern festival')
  await page.mouse.up()
  await expect(page.locator('.bk-drop-gap')).toHaveCount(0)
  await saved(page)
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).map((b) => [b.kind, b.text]))
    .toEqual([
      ['p', 'The first paragraph.'],
      ['p', 'Lantern festival'],
      ['p', 'By the river at dusk'],
      ['p', 'The last paragraph.'],
    ])
  const copied = (await bookBlocks(page, boardId, bookId))[1]
  expect(copied?.marks).toEqual([{ t: `c:${card}`, from: 0, to: 16 }])
  expect(await said(page)).toBe('Added to “River notes” as a paragraph.')
  // The chooser beside the new text; the board's card did not move and stays selected.
  const chooser = page.getByRole('radiogroup', { name: 'Add as' })
  await expect(chooser).toBeVisible()
  const board = await serverBoard(apiFor(page), boardId)
  expect(board.notes.has(card)).toBe(true)
  expect(
    await page.evaluate(() => [...(window.__papertie.runtime.selection as ReadonlySet<string>)]),
  ).toEqual([card])
  // axe: no serious violations with the chooser shown.
  expect(await axeViolations(page)).toEqual([])
  // 2: a quote, in place.
  await page.keyboard.press('2')
  await saved(page)
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).slice(1, 3).map((b) => b.kind))
    .toEqual(['quote', 'quote'])
  await page.keyboard.press('Escape')
  await expect(chooser).toHaveCount(0)

  // ⌥ at the drop: a move. The card leaves the board, its thread closes up.
  at = await cardPoint(page, card)
  const last = (await bookBlocks(page, boardId, bookId)).at(-1)
  to = await belowMiddleOf(page, last?.id as string)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 40, at.y + 10, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.keyboard.down('Alt')
  await page.mouse.move(to.x, to.y + 1)
  await expect(page.locator('.card-ghost-move')).toBeVisible()
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await saved(page)
  // It lands in the form chosen most: the switch above counted a quote.
  expect(await said(page)).toBe('Moved into “River notes” as a quote.')
  let s = await serverBoard(apiFor(page), boardId)
  expect(s.notes.has(card)).toBe(false)
  expect(s.yarns.find((y) => y.id === thread)?.noteIds).toEqual([welcome, other])
  expect((await bookBlocks(page, boardId, bookId)).map((b) => b.text).slice(-2)).toEqual([
    'Lantern festival',
    'By the river at dusk',
  ])
  // One undo brings both back: the card and its place on the thread, the text out of the book.
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+z')
  await saved(page)
  await expect
    .poll(async () => (await serverBoard(apiFor(page), boardId)).notes.has(card))
    .toBe(true)
  s = await serverBoard(apiFor(page), boardId)
  expect(s.yarns.find((y) => y.id === thread)?.noteIds).toEqual([welcome, card, other])
  expect((await bookBlocks(page, boardId, bookId)).map((b) => b.text)).toEqual([
    'The first paragraph.',
    'Lantern festival',
    'By the river at dusk',
    'The last paragraph.',
  ])
})

test('a drop deep in a windowed 200,000-word book lands at the shown gap', async ({ page }) => {
  test.setTimeout(300_000)
  await page.setViewportSize(WIDE)
  const { boardId, card } = await boardWithCards(page)
  const bookId = newId('book')
  const at = new Date().toISOString()
  await opsOn(page, boardId, [
    {
      op: 'book.create',
      book: {
        type: 'book',
        id: bookId,
        title: 'A lifetime',
        lang: 'en',
        shelfPos: 'V',
        cover: { seed: 1, ink: 'indigo', motif: 'overprint' },
        trashedAt: null,
        createdAt: at,
        updatedAt: at,
      },
    },
    ...genBookBlocks({ seed: 1, words: 200_000, bookId }).map((block) => ({
      op: 'block.create',
      block,
    })),
  ])
  await openSplit(page, bookId)
  // Far into the book: spacers above and below the window.
  await page.evaluate(() => {
    const sc = document.querySelector('.writer-scroll') as HTMLElement
    sc.scrollTop = sc.scrollHeight * 0.6
  })
  await page.waitForTimeout(800)
  // A point on the page well inside the view, clear of the edges where the page scrolls by itself:
  // whatever gap the line shows there is where the card must land.
  const target = await page.evaluate(() => {
    const page = (document.querySelector('.writer-page') as HTMLElement).getBoundingClientRect()
    const sc = (document.querySelector('.writer-scroll') as HTMLElement).getBoundingClientRect()
    return { x: page.left + Math.min(page.width, 700) / 2, y: sc.top + sc.height * 0.6 }
  })
  expect(target).not.toBeNull()
  const from = await cardPoint(page, card)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 40, from.y + 10, { steps: 4 })
  await page.mouse.move(target?.x as number, target?.y as number, { steps: 12 })
  await expect(page.locator('.bk-drop-gap')).toHaveCount(1, { timeout: 10_000 })
  const shown = await page.locator('.bk-drop-gap').getAttribute('data-after')
  expect(shown).not.toBeNull()
  await page.mouse.up()
  await saved(page)
  const blocks = await bookBlocks(page, boardId, bookId)
  const i = blocks.findIndex((b) => b.id === shown)
  expect(i).toBeGreaterThan(0)
  expect(blocks.slice(i + 1, i + 3).map((b) => b.text)).toEqual([
    'Lantern festival',
    'By the river at dusk',
  ])
})

test('on touch, a long press on a card offers Copy and Move, and Move moves', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize(TABLET)
  const { touch, tap } = await touchScreen(page)
  const { boardId, card } = await boardWithCards(page)
  const bookId = await seedBook(page, boardId, {
    title: 'Tablet notes',
    blocks: [{ text: 'Only paragraph.' }],
  })
  await openSplit(page, bookId)
  const at = await cardPoint(page, card)
  // Held still: the chip at the card.
  await touch('touchStart', at.x, at.y)
  await page.waitForTimeout(700)
  await touch('touchEnd')
  const chip = page.getByRole('group', { name: 'Copy or move' })
  await expect(chip).toBeVisible()
  await tap(chip.getByRole('button', { name: 'Move' }))
  await expect(chip.getByRole('button', { name: 'Move' })).toHaveAttribute('aria-pressed', 'true')
  // The drag it armed: into the book. The chip goes once the drag starts.
  const [only] = await bookBlocks(page, boardId, bookId)
  const to = await belowMiddleOf(page, only?.id as string)
  await touch('touchStart', at.x, at.y)
  await expect(chip).toHaveCount(0)
  for (let k = 1; k <= 16; k++) {
    await touch('touchMove', at.x + ((to.x - at.x) * k) / 16, at.y + ((to.y - at.y) * k) / 16)
    await page.waitForTimeout(16)
  }
  await touch('touchEnd')
  await saved(page)
  expect((await serverBoard(apiFor(page), boardId)).notes.has(card)).toBe(false)
  expect((await bookBlocks(page, boardId, bookId)).map((b) => b.text)).toEqual([
    'Only paragraph.',
    'Lantern festival',
    'By the river at dusk',
  ])
})

/** Select `from`..`to` of block `blockId`'s text on the page (as a drag over it would). */
async function selectIn(page: Page, blockId: string, from: number, to: number) {
  await page.locator(`.writer [data-id="${blockId}"]`).click()
  await page.evaluate(
    ({ blockId, from, to }) => {
      const el = document.querySelector(`.writer [data-id="${blockId}"]`)
      const t = el?.firstChild as Text
      document.getSelection()?.setBaseAndExtent(t, from, t, to)
    },
    { blockId, from, to },
  )
}

/** The cards the book made (those with an origin), in the server's board. */
async function cardsFromBook(page: Page, boardId: string) {
  const s = await serverBoard(apiFor(page), boardId)
  return [...s.notes.values()].filter((n) => n.from !== undefined)
}

test('Pin to board makes the card at the view’s centre; with ⌥ held it reads Move to board and moves', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize(WIDE)
  const { boardId } = await boardWithCards(page)
  const bookId = await seedBook(page, boardId, {
    title: 'River notes',
    blocks: [{ text: 'The first paragraph.' }, { text: 'The last paragraph.' }],
  })
  await openSplit(page, bookId)
  const [first, last] = await bookBlocks(page, boardId, bookId)
  // The writing tools in the sidebar, while the user works in the book beside the board.
  const pop = writing(page)

  // "first", pinned: a card of its text at the board's view centre, selected; the text stays.
  await selectIn(page, first?.id as string, 4, 9)
  await expect(pop.getByRole('button', { name: 'Pin to board' })).toBeVisible()
  await pop.getByRole('button', { name: 'Pin to board' }).click()
  await saved(page)
  expect(await said(page)).toBe('Pinned to the board.')
  await expect.poll(async () => (await cardsFromBook(page, boardId)).length).toBe(1)
  const [pinned] = await cardsFromBook(page, boardId)
  expect(pinned?.text).toBe('first')
  expect(pinned?.from).toEqual({ book: bookId, block: first?.id })
  // In the board's view, beside the book, and selected there.
  const card = page.locator(`article.note[data-note-id="${pinned?.id}"]`)
  await expect(card).toBeVisible()
  const view = await page.locator('main.viewport').boundingBox()
  const box = await card.boundingBox()
  if (view === null || box === null) throw new Error('no view or card')
  expect(box.x >= view.x && box.x + box.width <= view.x + view.width).toBe(true)
  await expect(card).toHaveClass(/note--selected/)
  expect((await bookBlocks(page, boardId, bookId)).map((b) => b.text)).toEqual([
    'The first paragraph.',
    'The last paragraph.',
  ])

  // "last", with ⌥ held: the control reads Move to board, and the text leaves the book.
  await selectIn(page, last?.id as string, 4, 8)
  await expect(pop.getByRole('button', { name: 'Pin to board' })).toBeVisible()
  await page.keyboard.down('Alt')
  await expect(pop.getByRole('button', { name: 'Move to board' })).toBeVisible()
  await pop.getByRole('button', { name: 'Move to board' }).click()
  await page.keyboard.up('Alt')
  await saved(page)
  expect(await said(page)).toBe('Moved to the board.')
  await expect.poll(async () => (await cardsFromBook(page, boardId)).length).toBe(2)
  expect((await cardsFromBook(page, boardId)).map((n) => n.text).sort()).toEqual(['first', 'last'])
  expect((await bookBlocks(page, boardId, bookId)).map((b) => b.text)).toEqual([
    'The first paragraph.',
    'The  paragraph.',
  ])
  // One undo puts the text back and takes the card away.
  await page.keyboard.press('ControlOrMeta+z')
  await saved(page)
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).map((b) => b.text))
    .toEqual(['The first paragraph.', 'The last paragraph.'])
  expect((await cardsFromBook(page, boardId)).map((n) => n.text)).toEqual(['first'])
})

test('a selection dragged out of the book onto the board is a card at the drop point; a release over the book makes nothing', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize(WIDE)
  const { boardId } = await boardWithCards(page)
  const bookId = await seedBook(page, boardId, {
    title: 'River notes',
    blocks: [{ text: 'Paper lanterns on the water.' }],
  })
  await openSplit(page, bookId)
  const [only] = await bookBlocks(page, boardId, bookId)
  await selectIn(page, only?.id as string, 0, 13)
  // A press inside the selection ("Paper lantern"), dragged a little way: nothing over the book.
  const words = await page.evaluate(() => {
    const r = document.getSelection()?.getRangeAt(0).getClientRects()[0]
    return r ? { x: r.left + 20, y: r.top + r.height / 2 } : null
  })
  if (words === null) throw new Error('no selection box')
  await page.mouse.move(words.x, words.y)
  await page.mouse.down()
  await page.mouse.move(words.x + 30, words.y + 20, { steps: 4 })
  await expect(page.locator('.card-ghost')).toContainText('Paper lantern')
  await page.mouse.up()
  await expect(page.locator('.card-ghost')).toHaveCount(0)
  expect(await cardsFromBook(page, boardId)).toEqual([])
  // Again, out onto the board's cork.
  const view = await page.locator('main.viewport').boundingBox()
  if (view === null) throw new Error('no board')
  const drop = { x: view.x + 120, y: view.y + view.height - 140 }
  await selectIn(page, only?.id as string, 0, 13)
  await page.mouse.move(words.x, words.y)
  await page.mouse.down()
  await page.mouse.move(words.x - 30, words.y, { steps: 4 })
  await page.mouse.move(drop.x, drop.y, { steps: 16 })
  await page.mouse.up()
  await saved(page)
  expect(await said(page)).toBe('Pinned to the board.')
  await expect.poll(async () => (await cardsFromBook(page, boardId)).length).toBe(1)
  const [made] = await cardsFromBook(page, boardId)
  expect(made?.text).toBe('Paper lantern')
  // Its paper is under the drop point; the book's text is as it was.
  const box = await page.locator(`article.note[data-note-id="${made?.id}"]`).boundingBox()
  if (box === null) throw new Error('card not shown')
  expect(Math.abs(box.x + box.width / 2 - drop.x)).toBeLessThan(40)
  expect(Math.abs(box.y + box.height / 2 - drop.y)).toBeLessThan(40)
  expect((await bookBlocks(page, boardId, bookId)).map((b) => b.text)).toEqual([
    'Paper lanterns on the water.',
  ])
})

test('a card with a ref drops as a quote with its ref as its footnote, whatever the likely form; one undo takes both', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize(WIDE)
  const { boardId, welcome } = await boardWithCards(page)
  const raw = (await serverBoard(apiFor(page), boardId)).notes.get(welcome) as
    | (Record<string, unknown> & { x: number; y: number; rev?: number })
    | undefined
  if (raw === undefined) throw new Error('no welcome card')
  const { rev: _rev, ...base } = raw
  const quote = newId('note')
  await opsOn(page, boardId, [
    {
      op: 'note.create',
      note: {
        ...base,
        id: quote,
        y: base.y + 320,
        text: 'Simplify, simplify.',
        ref: 'Henry David Thoreau, Walden, 1854, p. 92',
      },
    },
  ])
  // The form chosen most is a prompt; a card with a ref is a quote all the same.
  await page.evaluate(() =>
    localStorage.setItem('papertie.dropForms', JSON.stringify({ prompt: 4 })),
  )
  const bookId = await seedBook(page, boardId, {
    title: 'Walden notes',
    blocks: [{ text: 'The first paragraph.' }],
  })
  await openSplit(page, bookId)
  const [first] = await bookBlocks(page, boardId, bookId)
  const from = await cardPoint(page, quote)
  const to = await belowMiddleOf(page, first?.id as string)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 40, from.y + 10, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
  await saved(page)
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).map((b) => [b.kind, b.text]))
    .toEqual([
      ['p', 'The first paragraph.'],
      ['quote', 'Simplify, simplify.'],
      ['footnote', 'Henry David Thoreau, Walden, 1854, p. 92'],
    ])
  expect(await said(page)).toBe('Added to “Walden notes” as a quote.')
  await expect(page.locator('.writer .bk-footnote')).toHaveAttribute('data-n', '1')
  await expect(page.locator('.writer .bk-quote .bk-anchor')).toHaveAttribute('data-n', '1')
  expect(await axeViolations(page)).toEqual([])
  // One undo takes the quote and its footnote.
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+z')
  await saved(page)
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).map((b) => b.text))
    .toEqual(['The first paragraph.'])
})
