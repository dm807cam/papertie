import { loadavg } from 'node:os'
import type { CDPSession, Page } from '@playwright/test'
import { newId } from '../../packages/core/src'
import { genBook } from '../../tools/src/genBook'
import { keysOf, longTasks, watchLongTasks } from '../bench/eventTiming'
import { axeViolations } from './a11y-exceptions'
import { APP_URL, apiFor, expect, test } from './helpers/app'
import { type BookBlock, bookBlocks, opsOn, seedBook, uploadFigure } from './helpers/books'
import { touchScreen } from './helpers/page'
import { firstRun, onlyBoard, openBoard } from './helpers/server'
import { settle, textStyle, writing } from './helpers/states'

/**
 * The writer in the desktop app: a book opened over the board, typed into as a
 * person does (real keys, a dead key through Chromium's own composition), every edit saved and
 * read back from the store, a change made in the store arriving while the page is open.
 * `WRITER_SHOTS=<dir>` keeps the writer's screenshots; `WRITER_BENCH=1` times typing and opening
 * a 200,000-word book (for information: the budgets are `e2e/desktop/desktop.bench.ts`'s rows).
 */

const SHOTS = process.env.WRITER_SHOTS

/** A first run's board, open in the window: its id. */
async function firstBoard(page: Page): Promise<string> {
  await firstRun(apiFor(page))
  await openBoard(page)
  return onlyBoard(apiFor(page))
}

const writer = (page: Page) => page.locator('.writer')
const blocks = (page: Page) => writer(page).locator('[data-id]')

/** Open `/book/<id>` and wait for its text to be on the page. */
async function openBook(page: Page, bookId: string): Promise<void> {
  await page.goto(`${APP_URL}/book/${bookId}`)
  await expect(blocks(page).first()).toBeVisible()
}

/** The caret into block `i` at `offset` (its end by default), as a click there leaves it. */
async function caretAt(page: Page, i: number, offset?: number): Promise<void> {
  await blocks(page).nth(i).click()
  await page.evaluate(
    ({ i, offset }) => {
      const el = document.querySelectorAll<HTMLElement>('.writer [data-id]')[i] as HTMLElement
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let left = offset ?? (el.textContent ?? '').length
      let node: Node = el
      let at = 0
      for (let n = w.nextNode(); n !== null; n = w.nextNode()) {
        const len = (n as Text).data.length
        node = n
        at = Math.min(left, len)
        if (left <= len) break
        left -= len
      }
      document.getSelection()?.setBaseAndExtent(node, at, node, at)
    },
    { i, offset },
  )
}

/**
 * The book as the server holds it, once what was typed has been sent (a few seconds at most): its
 * texts, and with `kinds` its blocks' kinds too (a format is a commit of its own, after the text's:
 * read too early, the store has not got a quote yet).
 */
async function saved(
  page: Page,
  boardId: string,
  bookId: string,
  texts: string[],
  kinds?: string[],
): Promise<void> {
  await expect
    .poll(
      async () => {
        const held = await bookBlocks(page, boardId, bookId)
        const read = held.map((b) => b.text)
        return kinds ? { texts: read, kinds: held.map((b) => b.kind) } : read
      },
      { timeout: 15_000 },
    )
    .toEqual(kinds ? { texts, kinds } : texts)
}

/** A dead key through Chromium's own composition (CDP's IME: what macOS's ⌥E does). */
async function deadKey(
  cdp: CDPSession,
  mark: string,
  commit: string,
  between?: () => Promise<void>,
) {
  await cdp.send('Input.imeSetComposition', { text: mark, selectionStart: 1, selectionEnd: 1 })
  await between?.()
  await cdp.send('Input.insertText', { text: commit })
}

test('typing "# On collecting" makes a chapter with its label and rule; it is saved and read back', async ({
  page,
}) => {
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, { title: 'Field notes', blocks: [{ text: '' }] })
  await openBook(page, bookId)
  await blocks(page).first().click()
  await page.keyboard.type('# On collecting')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Who writes thinks twice.')
  const h1 = writer(page).locator('h1.bk-h1')
  await expect(h1).toHaveText('On collecting')
  const look = await h1.evaluate((el) => {
    const before = getComputedStyle(el, '::before')
    const after = getComputedStyle(el, '::after')
    return {
      label: before.content,
      transform: before.textTransform,
      rule: [after.width, after.height, after.backgroundColor],
      font: getComputedStyle(el).fontFamily,
    }
  })
  expect(look.label).toBe('"Chapter 1"')
  expect(look.transform).toBe('uppercase')
  expect(look.rule).toEqual(['36px', '2px', 'rgb(184, 54, 74)'])
  expect(look.font).toContain('Newsreader')
  await saved(page, boardId, bookId, ['On collecting', 'Who writes thinks twice.'], ['h1', 'p'])
  const kinds = (await bookBlocks(page, boardId, bookId)).map((b) => b.kind)
  expect(kinds).toEqual(['h1', 'p'])
  // Read back: a reload shows the same page.
  await page.reload()
  await expect(h1).toHaveText('On collecting')
})

test('quotes and dashes are corrected as you type, and not inside a dead-key composition', async ({
  page,
}) => {
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, {
    title: 'Briefe',
    lang: 'de',
    blocks: [{ text: 'Erster Absatz' }, { text: '' }],
  })
  await openBook(page, bookId)
  const cdp = await page.context().newCDPSession(page)
  await caretAt(page, 1)
  await page.keyboard.type('"Ja" -- sagte sie... caf')
  await deadKey(cdp, '´', 'é')
  // A dead key's " (US International) stays as it was composed.
  await page.keyboard.type(' ')
  await deadKey(cdp, '"', '"')
  await expect(blocks(page).nth(1)).toHaveText('„Ja“ – sagte sie… café "')
  await deadKey(cdp, '´', 'é')
  await page.keyboard.type('!')
  await expect(blocks(page).nth(1)).toHaveText('„Ja“ – sagte sie… café "é!')
  await saved(page, boardId, bookId, ['Erster Absatz', '„Ja“ – sagte sie… café "é!'])
})

test('Enter splits keeping the paragraph’s id, Backspace merges, ⌘Z undoes through the board’s history', async ({
  page,
}) => {
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, {
    title: 'Keys',
    blocks: [{ text: 'Once upon a time' }],
  })
  await openBook(page, bookId)
  const id = (await blocks(page).first().getAttribute('data-id')) as string
  await caretAt(page, 0, 4)
  await page.keyboard.press('Enter')
  await expect(blocks(page)).toHaveText(['Once', ' upon a time'])
  expect(await blocks(page).first().getAttribute('data-id')).toBe(id)
  await page.keyboard.press('Backspace')
  await expect(blocks(page)).toHaveText(['Once upon a time'])
  await caretAt(page, 0)
  await page.keyboard.type(' there was')
  await expect(blocks(page)).toHaveText(['Once upon a time there was'])
  await page.keyboard.press('ControlOrMeta+z')
  await expect(blocks(page)).toHaveText(['Once upon a time'])
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(blocks(page)).toHaveText(['Once upon a time there was'])
  await saved(page, boardId, bookId, ['Once upon a time there was'])
  expect((await bookBlocks(page, boardId, bookId))[0]?.id).toBe(id)
})

test('Enter at the end of a quote makes a paragraph; in its middle, two quotes; an empty list item ends the list', async ({
  page,
}) => {
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, {
    title: 'Kinds',
    blocks: [
      { kind: 'quote', text: 'Simplify, simplify.' },
      { kind: 'li', text: 'First' },
    ],
  })
  await openBook(page, bookId)
  // The user's case: a quote, Enter at its end, and the next line is a paragraph.
  await caretAt(page, 0)
  await page.keyboard.press('Enter')
  await page.keyboard.type('Plain words.')
  await saved(
    page,
    boardId,
    bookId,
    ['Simplify, simplify.', 'Plain words.', 'First'],
    ['quote', 'p', 'li'],
  )
  // In the middle, two quotes.
  await caretAt(page, 0, 9)
  await page.keyboard.press('Enter')
  await saved(
    page,
    boardId,
    bookId,
    ['Simplify,', ' simplify.', 'Plain words.', 'First'],
    ['quote', 'quote', 'p', 'li'],
  )
  // A list item goes on as one; Enter in the empty one ends the list as a paragraph.
  await caretAt(page, 3)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('After the list.')
  await saved(
    page,
    boardId,
    bookId,
    ['Simplify,', ' simplify.', 'Plain words.', 'First', 'After the list.'],
    ['quote', 'quote', 'p', 'li', 'p'],
  )
})

test('a multi-paragraph paste makes a paragraph each; a paragraph deleted in the store leaves the page; the sidebar formats', async ({
  page,
}) => {
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, { title: 'Paste', blocks: [{ text: 'Start end' }] })
  await openBook(page, bookId)
  await caretAt(page, 0, 6)
  await page.evaluate(() => {
    const d = new DataTransfer()
    d.setData('text/plain', 'one\ntwo\nthree ')
    document
      .getSelection()
      ?.focusNode?.parentElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }),
      )
  })
  await expect(blocks(page)).toHaveText(['Start one', 'two', 'three end'])
  await saved(page, boardId, bookId, ['Start one', 'two', 'three end'])
  const two = (await blocks(page).nth(1).getAttribute('data-id')) as string
  await opsOn(page, boardId, [{ op: 'block.delete', bookId, id: two }])
  await expect(blocks(page)).toHaveText(['Start one', 'three end'])

  // Select "three" and make it bold, then the paragraph a quote, from the sidebar's tools.
  await blocks(page)
    .nth(1)
    .dblclick({ position: { x: 12, y: 10 } })
  await expect(writing(page).getByRole('button', { name: 'Bold' })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await writing(page).getByRole('button', { name: 'Bold' }).click()
  await expect(blocks(page).nth(1).locator('strong')).toHaveText('three')
  await expect(writing(page).getByRole('button', { name: 'Bold' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await textStyle(page, 'Quote')
  await expect(writer(page).locator('blockquote')).toHaveText('three end')
  await saved(page, boardId, bookId, ['Start one', 'three end'], ['p', 'quote'])
  const last = (await bookBlocks(page, boardId, bookId))[1]
  expect(last).toMatchObject({ kind: 'quote', marks: [{ t: 'b', from: 0, to: 5 }] })
})

test('on a touch screen, the sidebar’s writing tools work with a touch selection', async ({
  page,
}) => {
  const { tap } = await touchScreen(page)
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, {
    title: 'Pocket',
    blocks: [{ text: 'A small book read on the train' }],
  })
  await openBook(page, bookId)
  await tap(blocks(page).first())
  await caretAt(page, 0)
  await page.keyboard.type(', slowly.')
  await expect(blocks(page).first()).toHaveText('A small book read on the train, slowly.')
  // A touch selection (as the system's handles leave it): "small".
  await page.evaluate(() => {
    const t = document.querySelector('.writer [data-id]')?.firstChild as Text
    document.getSelection()?.setBaseAndExtent(t, 2, t, 7)
  })
  await expect(writing(page)).toBeVisible()
  expect(
    await writing(page)
      .getByRole('button')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
  ).toEqual(['Text style', 'Bold', 'Italic', 'Footnote', 'Pin to board'])
  // On touch, Pin offers Pin to board and Move to board (no ⌥ to hold).
  await tap(writing(page).getByRole('button', { name: 'Pin to board' }))
  const choice = page.getByRole('dialog', { name: 'Pin to board' })
  await expect(choice.getByRole('button')).toHaveText(['Pin to board', 'Move to board'])
  // A tap on Italic puts the choice away and acts on the selection, which the taps kept.
  await tap(writing(page).getByRole('button', { name: 'Italic' }))
  await expect(choice).toHaveCount(0)
  await expect(blocks(page).first().locator('em')).toHaveText('small')
  await saved(page, boardId, bookId, ['A small book read on the train, slowly.'])
})

test('prompts sit in the margin beside their paragraph on a wide page and inline on a narrow one; a figure shows its image, Enter at its caption’s end adds a paragraph', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const boardId = await firstBoard(page)
  // The book full width (not beside the board), for the widest page.
  await page.evaluate(() =>
    localStorage.setItem('papertie.split', JSON.stringify({ ratio: 0.5, board: false })),
  )
  const assetId = await uploadFigure(page, boardId)
  const bookId = await seedBook(page, boardId, {
    title: 'Margins',
    blocks: [
      { text: 'The first paragraph, which the prompt annotates.' },
      { kind: 'prompt', text: 'Ask the archivist about the second shelf.' },
      { text: 'The second paragraph.' },
      { kind: 'figure', text: 'The shelf', image: { assetId } },
    ],
  })
  await openBook(page, bookId)
  const first = blocks(page).nth(0)
  const prompt = blocks(page).nth(1)
  const second = blocks(page).nth(2)
  const figure = blocks(page).nth(3)
  await expect(writer(page).locator('.bk-book')).toHaveAttribute('data-asides', 'margin')
  await expect
    .poll(async () => {
      const [a, p, b] = await Promise.all([
        first.boundingBox(),
        prompt.boundingBox(),
        second.boundingBox(),
      ])
      if (!a || !p || !b) return null
      return {
        beside: p.x >= a.x + a.width,
        top: Math.round(p.y - a.y),
        // It takes no height in the text column: the second paragraph follows the first.
        follows: b.y - (a.y + a.height) < 30,
      }
    })
    .toEqual({ beside: true, top: 0, follows: true })
  expect(await prompt.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Patrick Hand')
  // The figure's image at the measure, loaded from its asset, its caption below it.
  const img = figure.locator('img')
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  const box = await img.boundingBox()
  expect(Math.round(box?.width ?? 0)).toBe(576)
  expect(Math.round(box?.height ?? 0)).toBe(384)
  await figure.locator('figcaption').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('After the figure.')
  await saved(page, boardId, bookId, [
    'The first paragraph, which the prompt annotates.',
    'Ask the archivist about the second shelf.',
    'The second paragraph.',
    'The shelf',
    'After the figure.',
  ])
  // Narrow: the prompt inline, between the paragraphs.
  await page.setViewportSize({ width: 820, height: 900 })
  await expect(writer(page).locator('.bk-book')).toHaveAttribute('data-asides', 'inline')
  await expect
    .poll(async () => {
      const [a, p, b] = await Promise.all([
        first.boundingBox(),
        prompt.boundingBox(),
        second.boundingBox(),
      ])
      return a && p && b ? p.y >= a.y + a.height - 1 && b.y >= p.y + p.height - 1 : null
    })
    .toBe(true)
})

test('footnotes: Footnote on a selection and ^[ make numbered footnotes, saved; the numbers are CSS, never text; axe and the CSP', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] }
    w.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`)
    })
  })
  await page.setViewportSize({ width: 1400, height: 900 })
  const boardId = await firstBoard(page)
  await page.evaluate(() =>
    localStorage.setItem('papertie.split', JSON.stringify({ ratio: 0.5, board: false })),
  )
  const bookId = await seedBook(page, boardId, {
    title: 'Notes',
    blocks: [{ text: 'Walden is a book.' }, { text: 'The pond' }],
  })
  await openBook(page, bookId)
  // "Footnote" on a selection: the caret in the new footnote.
  await caretAt(page, 0, 0)
  await page.evaluate(() => {
    const el = document.querySelector('.writer [data-id]') as HTMLElement
    const t = el.firstChild as Text
    document.getSelection()?.setBaseAndExtent(t, 0, t, 6)
  })
  await writing(page).getByRole('button', { name: 'Footnote' }).click()
  await page.keyboard.type('Thoreau, 1854.')
  // `^[` after the word at the second paragraph's end.
  await caretAt(page, 2)
  await page.keyboard.type('^[')
  await page.keyboard.type('Now Walden Pond.')
  await saved(
    page,
    boardId,
    bookId,
    ['Walden is a book.', 'Thoreau, 1854.', 'The pond', 'Now Walden Pond.'],
    ['p', 'footnote', 'p', 'footnote'],
  )
  const notes = writer(page).locator('.bk-footnote')
  await expect(notes.nth(0)).toHaveAttribute('data-n', '1')
  await expect(notes.nth(1)).toHaveAttribute('data-n', '2')
  // The numbers are drawn by CSS: the text is the book's, the anchors' superscripts their own.
  expect(await blocks(page).nth(0).textContent()).toBe('Walden is a book.')
  const after = await writer(page)
    .locator('.bk-anchor')
    .evaluateAll((els) => els.map((e) => getComputedStyle(e, '::after').content))
  expect(after).toEqual(['"1"', '"2"'])
  expect(await notes.nth(1).evaluate((e) => getComputedStyle(e, '::before').content)).toBe('"2."')
  expect(await axeViolations(page)).toEqual([])
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
})

test('screenshots of the writer', async ({ page }) => {
  test.skip(!SHOTS, 'WRITER_SHOTS=<dir> keeps them')
  const boardId = await firstBoard(page)
  const content: BookBlock[] = [
    { kind: 'h1', text: 'On collecting' },
    {
      text: 'Who writes thinks twice: once while reading, when a sentence stays, and once while ordering, when it comes to lie beside another.',
      marks: [{ t: 'i', from: 25, to: 29 }],
    },
    { kind: 'quote', text: '“To remember is to connect. What stays alone, we forget.”' },
    { kind: 'h2', text: 'The card as a partner in conversation' },
    {
      text: 'The cards do not lie in a drawer; they hang side by side, in plain view, and sometimes they answer one another.',
      marks: [{ t: 'b', from: 39, to: 56 }],
    },
    { kind: 'li', text: 'a card for every thought' },
    { kind: 'li', text: 'a thread for every link' },
    {
      text: 'What the board holds, the page tells in order. The words find their places slowly, as paper finds its fold.',
    },
  ]
  const bookId = await seedBook(page, boardId, { title: 'Field notes', blocks: content })
  await openBook(page, bookId)
  await settle(page)
  await page.screenshot({ path: `${SHOTS}/writer-desktop.png` })
  // "partner" in the section heading, selected: the sidebar's writing tools offer it.
  await page.evaluate(() => {
    const t = document.querySelectorAll('.writer [data-id]')[3]?.firstChild as Text
    const at = t.data.indexOf('partner')
    document.getSelection()?.setBaseAndExtent(t, at, t, at + 'partner'.length)
  })
  await expect(writing(page).getByRole('button', { name: 'Bold' })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await settle(page)
  await page.screenshot({ path: `${SHOTS}/writer-tools.png` })
})

test('typing in and opening a 200,000-word book (for information)', async ({ page }) => {
  test.skip(!process.env.WRITER_BENCH, 'WRITER_BENCH=1 runs it')
  test.setTimeout(300_000)
  await watchLongTasks(page.context())
  const boardId = await firstBoard(page)
  const gen = genBook({ seed: 1, words: 200_000 })
  await seedBook(page, boardId, {
    title: 'Lifetime',
    blocks: gen.map((b) => ({ kind: b.kind, text: b.text, marks: b.marks })),
  })
  // Timed from the shelf's click.
  await page.goto(`${APP_URL}/shelf`)
  const cover = page
    .getByRole('dialog', { name: 'Books' })
    .getByRole('button', { name: 'Lifetime', exact: true })
  await expect(cover).toBeVisible()
  await settle(page)
  const t0 = await page.evaluate(() => performance.now())
  await cover.click()
  await expect(blocks(page).first()).toBeVisible()
  const openMs = (await page.evaluate(() => performance.now())) - t0
  const since = Math.round(t0)
  // Halfway through the book: only a window of its blocks is on the page.
  await page.locator('.writer-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2
  })
  await page.waitForTimeout(500)
  const mounted = await blocks(page).count()
  // The window moved with the scroll: a spacer stands for the blocks above it.
  const above = await page.evaluate(() =>
    Number.parseFloat(
      (document.querySelector('.bk-book > .bk-spacer:first-child') as HTMLElement | null)?.style
        .height ?? '0',
    ),
  )
  expect(above).toBeGreaterThan(10_000)
  const mid = Math.floor(mounted / 2)
  await blocks(page).nth(mid).click()
  const typing = await keysOf(page)
  const long = await longTasks(page, since)
  console.log(
    `writer at 200,000 words (${gen.length} blocks): open ${Math.round(openMs)} ms; ${mounted} blocks on the page halfway (${Math.round(above)} px of spacer above); typing p95 ${typing.p95Ms} ms, max ${typing.maxMs} ms; long tasks ${JSON.stringify(long)}; load1 ${loadavg()[0]?.toFixed(2)}`,
  )
  expect(mounted).toBeLessThan(260)
})

test('a book of maxBlocksPerBook paragraphs opens within 300 ms, its first window on the page, no long task', async ({
  page,
}) => {
  test.setTimeout(300_000)
  await watchLongTasks(page.context())
  const boardId = await firstBoard(page)
  const n = 60_000
  await seedBook(page, boardId, {
    title: 'Sixty thousand',
    blocks: Array.from({ length: n }, (_, i) => ({
      text: `Paragraph ${i}, a sentence of a few words.`,
    })),
  })
  await page.goto(`${APP_URL}/shelf`)
  const cover = page
    .getByRole('dialog', { name: 'Books' })
    .getByRole('button', { name: 'Sixty thousand', exact: true })
  await expect(cover).toBeVisible()
  await settle(page)
  // Timed in the page: from the press to the first paragraph of the window on the page.
  await page.evaluate(() => {
    const w = window as unknown as { __open: { at: number; shown: number } }
    w.__open = { at: 0, shown: 0 }
    addEventListener('pointerdown', () => (w.__open.at = performance.now()), {
      capture: true,
      once: true,
    })
    const seen = new MutationObserver(() => {
      if (document.querySelector('.bk-book [data-id]')) {
        w.__open.shown = performance.now()
        seen.disconnect()
      }
    })
    seen.observe(document.body, { childList: true, subtree: true })
  })
  await cover.click()
  await expect(blocks(page).first()).toBeVisible({ timeout: 30_000 })
  // The rest of the open (the window's rest, the word count) in too.
  await expect(page.locator('.writer-count')).toBeVisible({ timeout: 30_000 })
  const t = await page.evaluate(
    () => (window as unknown as { __open: { at: number; shown: number } }).__open,
  )
  const ms = t.shown - t.at
  const long = await longTasks(page, Math.round(t.at))
  const load = loadavg()[0] ?? 0
  console.log(
    `a book of ${n} paragraphs: ${Math.round(ms)} ms, long tasks ${JSON.stringify(long)}; load1 ${load.toFixed(2)}`,
  )
  expect(long).toEqual([])
  // Timed only on a quiet machine (load under 4).
  if (load < 4) expect(ms).toBeLessThanOrEqual(300)
})

test('footnotes sit in the margin beside the line their number is on, one below another, and under the paragraph on a narrow page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const boardId = await firstBoard(page)
  // The book full width (not beside the board), for a page with a margin.
  await page.evaluate(() =>
    localStorage.setItem('papertie.split', JSON.stringify({ ratio: 0.5, board: false })),
  )
  const [a, b, c] = [newId('block'), newId('block'), newId('block')]
  const long =
    'Walden is deep and clear, and the pond keeps its own counsel through the winter. ' +
    'The ice sings at night when the cold comes down from the hills, and by morning the ' +
    'fishermen have cut their holes again. Nobody who has heard it forgets the sound, ' +
    'which carries a mile over the fields.'
  const bookId = await seedBook(page, boardId, {
    title: 'Sidenotes',
    blocks: [
      {
        text: long,
        // A block's marks are kept in the order of their names.
        marks: [
          { t: `n:${a}` as const, from: 0, to: 6 },
          { t: `n:${b}` as const, from: 7, to: 9 },
          { t: `n:${c}` as const, from: long.length - 7, to: long.length - 1 },
        ].sort((x, y) => (x.t < y.t ? -1 : 1)),
      },
      { kind: 'footnote', text: 'Thoreau, Walden, 1854.', id: a },
      {
        kind: 'footnote',
        text: 'A second note on the same line, long enough to run over several lines of the margin and past where the third would begin.',
        id: b,
      },
      { kind: 'footnote', text: 'About the fields.', id: c },
      { text: 'The second paragraph follows at once.' },
    ],
  })
  await openBook(page, bookId)
  const book = writer(page).locator('.bk-book')
  await expect(book).toHaveAttribute('data-asides', 'margin')
  const para = blocks(page).nth(0)
  const firstNote = blocks(page).nth(1)
  const notes = [firstNote, blocks(page).nth(2), blocks(page).nth(3)]
  const next = blocks(page).nth(4)
  /** The top of the line footnote `id`'s number is on. */
  const lineOf = (id: string) =>
    book.locator(`.bk-anchor[data-note="${id}"]`).evaluate((el) => {
      const rects = el.getClientRects()
      return (rects[rects.length - 1] as DOMRect).top
    })
  await expect
    .poll(async () => {
      const [p, n, one, two, three] = await Promise.all([
        para.boundingBox(),
        next.boundingBox(),
        ...notes.map((x) => x.boundingBox()),
      ])
      if (!p || !n || !one || !two || !three) return null
      return {
        beside: [one, two, three].every((x) => x.x >= p.x + p.width),
        // The first beside its number's line, a few px down; the second below it; the third below the second,
        // which runs past the last line.
        level: Math.abs(one.y - (await lineOf(a)) - 4) <= 2,
        second: Math.round(two.y - (one.y + one.height)),
        third: Math.round(three.y - (two.y + two.height)),
        pushed: three.y > (await lineOf(c)) + 8,
        // No height in the text column: the next paragraph follows the first.
        follows: n.y - (p.y + p.height) < 30,
      }
    })
    .toEqual({ beside: true, level: true, second: 8, third: 8, pushed: true, follows: true })
  // No rule above a note in the margin.
  expect(await firstNote.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none')
  if (process.env.WRITER_SHOTS)
    await page.screenshot({ path: `${process.env.WRITER_SHOTS}/footnotes-margin.png` })
  // Written in where it is.
  await caretAt(page, 1)
  await page.keyboard.type(' Ticknor and Fields.')
  await expect(firstNote).toHaveText('Thoreau, Walden, 1854. Ticknor and Fields.')
  // Narrow: under the paragraph, in the text's own column, the next paragraph after them.
  await page.setViewportSize({ width: 820, height: 900 })
  await expect(book).toHaveAttribute('data-asides', 'inline')
  await expect
    .poll(async () => {
      const [p, n, one, three] = await Promise.all([
        para.boundingBox(),
        next.boundingBox(),
        firstNote.boundingBox(),
        blocks(page).nth(3).boundingBox(),
      ])
      if (!p || !n || !one || !three) return null
      return {
        under: one.y >= p.y + p.height - 8 && one.x < p.x + p.width,
        after: n.y >= three.y + three.height,
      }
    })
    .toEqual({ under: true, after: true })
  if (process.env.WRITER_SHOTS)
    await page.screenshot({ path: `${process.env.WRITER_SHOTS}/footnotes-inline.png` })
})
