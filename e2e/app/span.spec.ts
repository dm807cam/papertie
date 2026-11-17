import type { Page } from '@playwright/test'
import { APP_URL, apiFor, expect, test } from './helpers/app'
import { bookBlocks, seedBook } from './helpers/books'
import { firstRun, onlyBoard, openBoard } from './helpers/server'

/**
 * The span switch in the writer: a press that leaves its paragraph makes the book one editing host
 * (the book element's contenteditable alone), and a plain click writes nothing. No timing here:
 * the bounds are the bench's.
 */

/** The app as on a first run, its board open; the board's id. */
async function firstBoard(page: Page): Promise<string> {
  await firstRun(apiFor(page))
  await openBoard(page)
  return onlyBoard(apiFor(page))
}

const blocks = (page: Page) => page.locator('.writer .bk-book [data-id]')

const TEXTS = [
  'The first paragraph of the book.',
  'A second one, a little longer than the first.',
  'The third paragraph, in the middle.',
  'A fourth, short.',
  'The fifth paragraph closes the page.',
]

async function openBook(page: Page) {
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, {
    title: 'Spans',
    blocks: TEXTS.map((text) => ({ text })),
  })
  await page.goto(`${APP_URL}/book/${bookId}`)
  await expect(blocks(page).nth(TEXTS.length - 1)).toBeVisible()
  await expect(page.locator('.writer-count')).toBeVisible()
  // The writer settles (its first window, the fonts) before a press is aimed.
  await page.waitForTimeout(500)
  return { boardId, bookId }
}

/** Where character `offset` of block `i` is on the screen (its left edge, the line's middle). */
async function pointAt(page: Page, i: number, offset: number) {
  return blocks(page)
    .nth(i)
    .evaluate((el, offset) => {
      const text = el.firstChild as Text
      const r = document.createRange()
      r.setStart(text, offset)
      r.setEnd(text, Math.min(text.length, offset + 1))
      const box = r.getClientRects()[0] as DOMRect
      return { x: box.left + 0.5, y: box.top + box.height / 2 }
    }, offset)
}

/** A press at character `a` of block `i`, dragged to character `b` of block `j`. */
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const p = await pointAt(page, ...from)
  const q = await pointAt(page, ...to)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 })
  await page.mouse.move(q.x, q.y, { steps: 4 })
  await page.mouse.up()
}

/** The selection's ends as (block index, character offset). */
const ends = (page: Page) =>
  page.evaluate(() => {
    const all = [...document.querySelectorAll<HTMLElement>('.writer .bk-book [data-id]')]
    const s = document.getSelection() as Selection
    const end = (n: Node | null, o: number) => {
      const el = (n?.nodeType === 1 ? (n as Element) : n?.parentElement)?.closest<HTMLElement>(
        '[data-id]',
      )
      if (!el || !n) return null
      const r = document.createRange()
      r.setStart(el, 0)
      r.setEnd(n, o)
      return [all.indexOf(el), r.toString().length]
    }
    return { a: end(s.anchorNode, s.anchorOffset), b: end(s.focusNode, s.focusOffset) }
  })

const saved = async (page: Page, boardId: string, bookId: string, texts: string[]) =>
  expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).map((b) => b.text), {
      timeout: 15_000,
    })
    .toEqual(texts)

test('span switch: a drag that leaves its paragraph selects across, and a key replaces it all', async ({
  page,
}) => {
  const { boardId, bookId } = await openBook(page)
  await drag(page, [1, 9], [3, 6])
  expect(await ends(page)).toEqual({ a: [1, 9], b: [3, 6] })
  await expect(page.locator('.writer .bk-book')).toHaveAttribute('contenteditable', 'true')
  await page.keyboard.type('Z')
  const merged = `${(TEXTS[1] as string).slice(0, 9)}Z${(TEXTS[3] as string).slice(6)}`
  await expect(blocks(page)).toHaveText([TEXTS[0] as string, merged, TEXTS[4] as string])
  await saved(page, boardId, bookId, [TEXTS[0] as string, merged, TEXTS[4] as string])
})

test('span switch: after a selection across paragraphs, a click puts the caret where it is clicked, and typing, an accented letter, Enter and Backspace go there', async ({
  page,
}) => {
  const { boardId, bookId } = await openBook(page)
  await drag(page, [0, 4], [2, 3])
  await expect(page.locator('.writer .bk-book')).toHaveAttribute('contenteditable', 'true')
  // A plain click back in one paragraph: the caret where it is pressed.
  const at = await pointAt(page, 3, 2)
  await page.mouse.click(at.x, at.y)
  expect(await ends(page)).toEqual({ a: [3, 2], b: [3, 2] })
  await page.keyboard.type('ab')
  // The letter a dead key commits.
  await page.keyboard.insertText('é')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  const fourth = `${(TEXTS[3] as string).slice(0, 2)}ab${(TEXTS[3] as string).slice(2)}`
  const texts = [...TEXTS.slice(0, 3), fourth, ...TEXTS.slice(4)] as string[]
  await expect(blocks(page)).toHaveText(texts)
  await saved(page, boardId, bookId, texts)
  // And a press at another paragraph's start.
  const start = await pointAt(page, 1, 0)
  await page.mouse.click(start.x, start.y)
  expect(await ends(page)).toEqual({ a: [1, 0], b: [1, 0] })
  await page.keyboard.type('So ')
  texts[1] = `So ${TEXTS[1]}`
  await saved(page, boardId, bookId, texts)
})

test('span switch: Shift+click in another paragraph selects from the caret to it, and a key replaces it all', async ({
  page,
}) => {
  const { boardId, bookId } = await openBook(page)
  const from = await pointAt(page, 1, 9)
  await page.mouse.click(from.x, from.y)
  expect(await ends(page)).toEqual({ a: [1, 9], b: [1, 9] })
  const to = await pointAt(page, 3, 6)
  await page.keyboard.down('Shift')
  await page.mouse.click(to.x, to.y)
  await page.keyboard.up('Shift')
  expect(await ends(page)).toEqual({ a: [1, 9], b: [3, 6] })
  await page.keyboard.type('Z')
  const merged = `${(TEXTS[1] as string).slice(0, 9)}Z${(TEXTS[3] as string).slice(6)}`
  await expect(blocks(page)).toHaveText([TEXTS[0] as string, merged, TEXTS[4] as string])
  await saved(page, boardId, bookId, [TEXTS[0] as string, merged, TEXTS[4] as string])
})

test('span switch: Shift+Arrow keys grow the selection across paragraphs, and Delete takes it', async ({
  page,
}) => {
  const { boardId, bookId } = await openBook(page)
  const from = await pointAt(page, 1, 9)
  await page.mouse.click(from.x, from.y)
  // Down two lines (each paragraph is one line here), then right past the next one's start.
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  const sel = await ends(page)
  expect(sel.a).toEqual([1, 9])
  expect(sel.b?.[0]).toBe(3)
  await page.keyboard.press('Delete')
  const at = sel.b?.[1] as number
  const merged = `${(TEXTS[1] as string).slice(0, 9)}${(TEXTS[3] as string).slice(at)}`
  await saved(page, boardId, bookId, [TEXTS[0] as string, merged, TEXTS[4] as string])
  // And Shift+→ from a paragraph's end into the next.
  const end = (TEXTS[0] as string).length
  const p = await pointAt(page, 0, end - 1)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  expect(await ends(page)).toEqual({ a: [0, end], b: [1, 1] })
  await page.keyboard.press('Delete')
  await saved(page, boardId, bookId, [`${TEXTS[0]}${merged.slice(1)}`, TEXTS[4] as string])
})

test('span switch: a font of the book loading mid-book keeps the paragraph on screen where it is; one of the board’s leaves the page alone', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const boardId = await firstBoard(page)
  const texts = Array.from(
    { length: 400 },
    (_, i) => `Paragraph ${i} of the long book, a line or two of it to wrap at the measure.`,
  )
  const bookId = await seedBook(page, boardId, {
    title: 'Long',
    blocks: texts.map((text) => ({ text })),
  })
  // Two faces in the page's font set from its first byte, loaded only later (as a font the CSS
  // names comes in once text asks for it): one of the book's family, one of the notes' hand.
  await page.addInitScript(() => {
    const src = 'local("Helvetica Neue"), local("Helvetica"), local("Arial")'
    const faces = {
      book: new FontFace('Instrument Sans', src, { weight: '900' }),
      board: new FontFace('Patrick Hand', src, { weight: '900' }),
    }
    ;(window as unknown as { __faces: typeof faces }).__faces = faces
    document.fonts.add(faces.book)
    document.fonts.add(faces.board)
  })
  await page.goto(`${APP_URL}/book/${bookId}`)
  await expect(blocks(page).first()).toBeVisible()
  await expect(page.locator('.writer-count')).toBeVisible()
  await page.waitForTimeout(500)
  await page.locator('.writer-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight * 0.5
  })
  await page.waitForTimeout(800)
  /** The paragraph across the view's middle, and its top on the screen; the spacers' heights. */
  const where = () =>
    page.evaluate(() => {
      const view = (document.querySelector('.writer-scroll') as HTMLElement).getBoundingClientRect()
      const mid = (view.top + view.bottom) / 2
      const p = [...document.querySelectorAll<HTMLElement>('.writer .bk-book [data-id]')].find(
        (el) => {
          const r = el.getBoundingClientRect()
          return r.top <= mid && r.bottom > mid
        },
      ) as HTMLElement
      return {
        id: p.dataset.id,
        top: Math.round(p.getBoundingClientRect().top),
        spacers: [...document.querySelectorAll<HTMLElement>('.writer .bk-spacer')].map(
          (s) => s.style.height,
        ),
      }
    })
  const load = (face: 'book' | 'board') =>
    page.evaluate(async (face) => {
      await (window as unknown as { __faces: Record<string, FontFace> }).__faces[face]?.load()
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    }, face)
  const before = await where()
  // A font of the board's (not the book's): the page as it was.
  await load('board')
  expect(await where()).toEqual(before)
  // One the book is set in: its heights estimated again, the paragraph where it was on screen.
  await load('book')
  const after = await where()
  expect(after.spacers).not.toEqual(before.spacers) // estimated again
  expect(after.id).toBe(before.id)
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
})
