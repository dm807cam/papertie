import type { Page } from '@playwright/test'
import { newId } from '../../packages/core/src'
import { genBookBlocks } from '../../tools/src/genBook'
import { axeViolations } from './a11y-exceptions'
import { APP_URL, apiFor, expect, runningFor, test } from './helpers/app'
import { bookBlocks, opsOn, seedBook } from './helpers/books'
import { firstRun, onlyBoard, openBoard } from './helpers/server'

/**
 * The writer at a lifetime's scale, in the desktop app: a 200,000-word book
 * scrolled end to end with only a window of its blocks on the page, and Papertie opened again
 * after writing in it landing in the book at the caret. The budgets (typing, opening) are
 * `e2e/desktop/desktop.bench.ts`'s rows.
 */

/** The engine's window: `SIDE` blocks each side of the one at the middle, and the focused one. */
const WINDOW = 2 * 60 + 1 + 1

/** A first run's board, open in the window: its id. */
async function firstBoard(page: Page): Promise<string> {
  await firstRun(apiFor(page))
  await openBoard(page)
  return onlyBoard(apiFor(page))
}

/** A 200,000-word book on the board, through the API: its id and its blocks. */
async function lifetimeBook(
  page: Page,
  boardId: string,
  edit?: (blocks: ReturnType<typeof genBookBlocks>) => void,
) {
  const bookId = newId('book')
  const blocks = genBookBlocks({ seed: 3, words: 200_000, bookId })
  edit?.(blocks)
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
        cover: { seed: 7, ink: 'indigo', motif: 'overprint' },
        trashedAt: null,
        createdAt: at,
        updatedAt: at,
      },
    },
    ...blocks.map((block) => ({ op: 'block.create', block })),
  ])
  return { bookId, blocks }
}

const mounted = (page: Page) => page.locator('.writer .bk-book [data-id]')

test('scrolling the whole 200,000-word book mounts at most a window of blocks', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const boardId = await firstBoard(page)
  const { bookId, blocks } = await lifetimeBook(page, boardId)
  await page.goto(`${APP_URL}/book/${bookId}`)
  await expect(mounted(page).first()).toBeVisible()
  await expect(page.locator('.writer-count')).toBeVisible()
  // Down the whole book a screen at a time, each frame; the count read as it goes.
  const seen = await page.evaluate(async () => {
    const sc = document.querySelector('.writer-scroll') as HTMLElement
    const count = () => document.querySelectorAll('.writer .bk-book [data-id]').length
    const frame = () => new Promise((r) => requestAnimationFrame(r))
    let most = count()
    let steps = 0
    for (let last = -1; sc.scrollTop !== last && steps < 20_000; steps++) {
      last = sc.scrollTop
      sc.scrollTop += sc.clientHeight
      await frame()
      await frame()
      most = Math.max(most, count())
    }
    return { most, steps, end: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1 }
  })
  console.log(
    `scrolled ${blocks.length} blocks in ${seen.steps} screens: at most ${seen.most} on the page`,
  )
  expect(seen.end).toBe(true)
  expect(seen.most).toBeLessThanOrEqual(WINDOW)
  // At the end, the book's last block is on the page, and the first is not.
  await expect(page.locator(`[data-id="${blocks.at(-1)?.id}"]`)).toBeVisible()
  await expect(page.locator(`[data-id="${blocks[0]?.id}"]`)).toHaveCount(0)
})

test('reopening Papertie after writing lands in the book at the caret', async ({
  page,
  desktop,
}) => {
  test.setTimeout(240_000)
  const boardId = await firstBoard(page)
  const { bookId, blocks } = await lifetimeBook(page, boardId)
  await page.goto(`${APP_URL}/book/${bookId}`)
  await expect(mounted(page).first()).toBeVisible()
  // Halfway into the book: a paragraph there, the caret four characters in, a word typed.
  await page.locator('.writer-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2
  })
  await page.waitForTimeout(400)
  const target = await page.evaluate(() => {
    const view = (document.querySelector('.writer-scroll') as HTMLElement).getBoundingClientRect()
    const el = [...document.querySelectorAll<HTMLElement>('.writer .bk-book p.bk')].find((p) => {
      const r = p.getBoundingClientRect()
      return r.top > view.top + 100 && r.bottom < view.bottom - 100
    }) as HTMLElement
    return el.dataset.id as string
  })
  const index = blocks.findIndex((b) => b.id === target)
  expect(index).toBeGreaterThan(blocks.length / 4)
  await page.locator(`[data-id="${target}"]`).click()
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-id="${id}"]`) as HTMLElement
    const t = el.firstChild as Text
    document.getSelection()?.setBaseAndExtent(t, 4, t, 4)
  }, target)
  await page.keyboard.type('ink ')
  const top = await page
    .locator(`[data-id="${target}"]`)
    .evaluate((el) => Math.round(el.getBoundingClientRect().top))
  // The place is kept once the page has rested; Papertie quit.
  await page.waitForTimeout(1200)
  const first = runningFor(page)
  await desktop.quit(first)

  // Papertie opened again: it goes to the book, at the caret.
  const again = (await desktop.launch({ userData: first.userData })).page
  await expect(again).toHaveURL(new RegExp(`/book/${bookId}$`))
  const el = again.locator(`[data-id="${target}"]`)
  await expect(el).toBeVisible()
  await expect(el).toHaveText(/^.{4}ink /)
  const at = await again.evaluate((id) => {
    const s = document.getSelection()
    const el = document.querySelector(`[data-id="${id}"]`) as HTMLElement
    if (!s?.focusNode || !el.contains(s.focusNode)) return null
    const r = document.createRange()
    r.setStart(el, 0)
    r.setEnd(s.focusNode, s.focusOffset)
    return { offset: r.toString().length, focused: el.contains(document.activeElement) }
  }, target)
  expect(at).toEqual({ offset: 8, focused: true })
  // Where it was on the screen, near enough (a paragraph's line), however the heights above it
  // were estimated this time.
  const now = await el.evaluate((e) => Math.round(e.getBoundingClientRect().top))
  expect(Math.abs(now - top)).toBeLessThanOrEqual(30)
  // Back goes to the board it opened at (minor 7), and the board, visited again in
  // the same page, stays the board.
  await again.goBack()
  await expect(again).toHaveURL(/\/$/)
  await expect(again.locator('.writer')).toHaveCount(0)
  await again.waitForTimeout(1000)
  await expect(again).toHaveURL(/\/$/)
  // A deep link is not taken elsewhere, the last screen a book all the while.
  await again.goto(`${APP_URL}/settings/history`)
  await again.waitForTimeout(1500)
  await expect(again).toHaveURL(/\/settings\/history$/)
  await again.goto(`${APP_URL}/shelf`)
  await again.getByRole('dialog', { name: 'Books' }).waitFor()
  await again.waitForTimeout(1000)
  await expect(again).toHaveURL(/\/shelf$/)
  // And Papertie opened at the board after the shelf was the last screen opens at the board.
  await again.goto(`${APP_URL}/`)
  await again.waitForTimeout(1000)
  await expect(again).toHaveURL(/\/$/)
})

test('a selection dragged across some 150 paragraphs, past the window: copy, cut and Delete act on all of it, as the model has it', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const boardId = await firstBoard(page)
  const texts = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} of the long book.`)
  const bookId = await seedBook(page, boardId, {
    title: 'Long',
    blocks: texts.map((text) => ({ text })),
  })
  await page.goto(`${APP_URL}/book/${bookId}`)
  await expect(mounted(page).first()).toBeVisible()
  await expect(page.locator('.writer-count')).toBeVisible()
  // What a copy put on the clipboard (the engine's own handler writes it, on the event).
  await page.evaluate(() => {
    const w = window as unknown as { __copied: string[] }
    w.__copied = []
    document.addEventListener('copy', (e) =>
      w.__copied.push(e.clipboardData?.getData('text/plain') ?? ''),
    )
    document.addEventListener('cut', (e) =>
      w.__copied.push(e.clipboardData?.getData('text/plain') ?? ''),
    )
  })
  /** A drag from 7 characters into paragraph 20 to the paragraph at the view's middle some 150 on. */
  const drag = async () => {
    const at = page.locator(`[data-id]`, { hasText: /^Paragraph 20 of/ })
    // From the book's top, where paragraph 20 is on the page.
    await page.locator('.writer-scroll').evaluate((el) => {
      el.scrollTop = 0
    })
    await page.waitForTimeout(300)
    await at.scrollIntoViewIfNeeded()
    // The window settles (its first growth, the view held still) before the press is aimed.
    await page.waitForTimeout(500)
    const box = (await at.boundingBox()) as { x: number; y: number; height: number }
    const charW = await at.evaluate((el) => {
      const r = document.createRange()
      r.setStart(el.firstChild as Text, 0)
      r.setEnd(el.firstChild as Text, 7)
      return r.getBoundingClientRect().width
    })
    await page.mouse.move(box.x + charW + 1, box.y + box.height / 2)
    await page.mouse.down()
    // The drag begins where it was pressed (Chromium takes its start from the press's place on
    // the screen once the pointer moves), then the page scrolls under it.
    await page.mouse.move(box.x + charW + 30, box.y + box.height / 2 + 40, { steps: 4 })
    for (let k = 0; k < 30; k++) {
      await page.locator('.writer-scroll').evaluate((el) => {
        el.scrollTop += 220
      })
      await page.mouse.move(box.x + 60 + (k % 2), 400)
      await page.waitForTimeout(30)
    }
    await page.mouse.up()
    await page.waitForTimeout(200)
    return page.evaluate(() => {
      const s = document.getSelection() as Selection
      const end = (n: Node | null, o: number) => {
        const el = (n?.nodeType === 1 ? (n as Element) : n?.parentElement)?.closest<HTMLElement>(
          '[data-id]',
        )
        if (!el || !n) return null
        const r = document.createRange()
        r.setStart(el, 0)
        r.setEnd(n, o)
        return { text: el.textContent ?? '', offset: r.toString().length }
      }
      return { a: end(s.anchorNode, s.anchorOffset), b: end(s.focusNode, s.focusOffset) }
    })
  }
  const sel = await drag()
  expect(sel.a).toEqual({ text: texts[20], offset: 7 })
  const last = texts.indexOf(sel.b?.text as string)
  expect(last).toBeGreaterThan(150)
  const cutAt = sel.b?.offset as number
  const copied = [
    (texts[20] as string).slice(7),
    ...texts.slice(21, last),
    (texts[last] as string).slice(0, cutAt),
  ].join('\n')
  const left = [
    ...texts.slice(0, 20),
    (texts[20] as string).slice(0, 7) + (texts[last] as string).slice(cutAt),
    ...texts.slice(last + 1),
  ]
  // Copy: all of it, the paragraphs the window never showed too.
  await page.keyboard.press('ControlOrMeta+c')
  expect(
    await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1)),
  ).toBe(copied)
  // Cut: the same on the clipboard, and the book as the model makes it, saved.
  await page.keyboard.press('ControlOrMeta+x')
  expect(
    await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1)),
  ).toBe(copied)
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).map((b) => b.text), {
      timeout: 15_000,
    })
    .toEqual(left)
  // One undo step puts it all back; then the same drag and Delete.
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).map((b) => b.text), {
      timeout: 15_000,
    })
    .toEqual(texts)
  const again = await drag()
  expect(again).toEqual(sel)
  await page.keyboard.press('Delete')
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).map((b) => b.text), {
      timeout: 15_000,
    })
    .toEqual(left)
  // The page shows the book as saved, as far as it is on the page.
  const shown = await mounted(page).allTextContents()
  expect(left.join('\n')).toContain(shown.join('\n'))
})

// --- Find in the writer -----------------------------------------------------

const words = (s: string) => s.match(/\S+/g)?.length ?? 0

test('Enter jumps to a match 150,000 words away and selects it', async ({ page }) => {
  test.setTimeout(240_000)
  const boardId = await firstBoard(page)
  // One word the generator never writes, in a paragraph some 150,000 words in.
  let far = ''
  let before = 0
  const { bookId, blocks } = await lifetimeBook(page, boardId, (bs) => {
    let w = 0
    for (const b of bs) {
      if (w >= 150_000 && b.kind === 'p') {
        b.text = `${b.text.slice(0, 20)} Quillwort ${b.text.slice(20)}`
        far = b.id
        before = w
        return
      }
      w += words(b.text)
    }
  })
  expect(before).toBeGreaterThanOrEqual(150_000)
  await page.goto(`${APP_URL}/book/${bookId}`)
  const first = page.locator(`.writer [data-id="${blocks[0]?.id}"]`)
  await expect(first).toBeVisible()
  await first.click()
  await page.keyboard.press('ControlOrMeta+f')
  const field = page.getByRole('searchbox', { name: 'Find in the book' })
  await expect(field).toBeFocused()
  await field.fill('quillwort')
  await expect(page.locator('.find-count')).toHaveText('1 of 1')
  await field.press('Enter')
  // The far paragraph is on the page, in the view, its match the current highlight.
  const el = page.locator(`.writer [data-id="${far}"]`)
  await expect(el).toBeInViewport()
  const shown = await page.evaluate(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights
    return [...(reg?.get('book-find-current') ?? [])].map((r) => r.toString())
  })
  expect(shown).toEqual(['Quillwort'])
  // Esc: the bar goes, the match is the selection, in its paragraph.
  await field.press('Escape')
  await expect(field).toHaveCount(0)
  const sel = await page.evaluate((id) => {
    const s = document.getSelection()
    const el = document.querySelector(`[data-id="${id}"]`)
    return { text: s?.toString(), inside: el?.contains(s?.anchorNode ?? null) ?? false }
  }, far)
  expect(sel).toEqual({ text: 'Quillwort', inside: true })
  await expect(page).toHaveURL(new RegExp(`/book/${bookId}$`))
})

test('axe: no serious violations with the find bar', async ({ page }) => {
  test.setTimeout(120_000)
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, {
    title: 'Small finds',
    blocks: [
      { text: 'A lantern by the door.' },
      { kind: 'prompt', text: 'Which lantern?' },
      { text: 'Another lantern, far off.' },
    ],
  })
  await page.goto(`${APP_URL}/book/${bookId}`)
  await expect(page.locator('.writer .bk-book [data-id]').first()).toBeVisible()
  await page.getByRole('button', { name: 'Find' }).click()
  const field = page.getByRole('searchbox', { name: 'Find in the book' })
  await field.fill('lantern')
  await expect(page.locator('.find-count')).toHaveText('1 of 3')
  await field.press('Enter')
  await expect(page.locator('.find-count')).toHaveText('2 of 3')
  expect(await axeViolations(page)).toEqual([])
})
