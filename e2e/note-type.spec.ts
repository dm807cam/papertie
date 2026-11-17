import { expect, type Page, test } from '@playwright/test'
import { newId } from '../packages/core/src'

/**
 * How a note's title is set: a word breaks across lines only when it
 * cannot fit on a line of its own (a title whose longest word is wider than the note steps down
 * a pixel at a time first), and a title is set without tracking.
 */

const W = 202
const TITLES = [
  'Phrasebook',
  'Sketchbook',
  'Calligraphy class',
  'Ferry to the island',
  'Inn by the lake',
  'Lantern festival',
  'Camera batteries',
  'Bibliography',
]

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/bench?board=empty')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  const ids = TITLES.map(() => newId('note'))
  await page.evaluate(
    ([titles, w, ids]) => {
      const now = '2026-11-07T00:00:00.000Z'
      const store = window.__papertie.store as unknown as { commit(ops: unknown[]): void }
      store.commit(
        (titles as string[]).map((text, i) => ({
          op: 'note.create',
          note: {
            type: 'note',
            id: (ids as string[])[i],
            x: (i % 4) * 300,
            y: Math.floor(i / 4) * 260,
            w,
            h: 160,
            z: i,
            paper: 'cream',
            style: 'rustic',
            text,
            image: null,
            createdAt: now,
            updatedAt: now,
          },
        })),
      )
      window.__papertie.debug.setCamera({ x: -40, y: -40, zoom: 1 })
    },
    [TITLES, W, ids] as const,
  )
  await expect(page.locator('article.note .note-title')).toHaveCount(TITLES.length)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  return errors
}

test('no title word is broken across lines when it fits a line of its own', async ({ page }) => {
  const errors = await open(page)
  const split = await page.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('article.note .note-title')) {
      const node = el.firstChild
      if (!(node instanceof Text)) continue
      const text = node.data
      for (const m of text.matchAll(/\S+/g)) {
        const r = document.createRange()
        r.setStart(node, m.index ?? 0)
        r.setEnd(node, (m.index ?? 0) + m[0].length)
        // One line box per word: its rects share a top.
        const tops = new Set([...r.getClientRects()].map((b) => Math.round(b.top)))
        if (tops.size > 1) out.push(`${m[0]} in "${text}"`)
      }
    }
    return out
  })
  expect(split).toEqual([])
  expect(errors).toEqual([])
})

test('titles are set without tracking, at every size', async ({ page }) => {
  await open(page)
  const spacing = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('article.note .note-title')].map((el) => [
        el.textContent,
        parseFloat(getComputedStyle(el).letterSpacing) / parseFloat(getComputedStyle(el).fontSize),
      ]),
    ),
  )
  for (const title of TITLES) expect(spacing[title] || 0).toBe(0)
})

/** Each title's size and its text box's distance from the paper's sides, by its text. */
const titleBoxes = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('article.note .note-title')].map((el) => {
        const paper = el.closest('.note-paper')?.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return [
          el.textContent,
          {
            px: parseFloat(cs.fontSize),
            measure: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
            left: r.left + parseFloat(cs.paddingLeft) - (paper?.left ?? 0),
            right: (paper?.right ?? 0) - (r.right - parseFloat(cs.paddingRight)),
          },
        ]
      }),
    ),
  )

/** The width of the one-word title `word` were it set at `px`, on a line of its own. */
const wordWidthAt = (page: Page, word: string, px: number) =>
  page.evaluate(
    ([word, px]) => {
      const el = [...document.querySelectorAll<HTMLElement>('article.note .note-title')].find(
        (t) => t.textContent === word,
      )
      if (el === undefined) throw new Error(`no title "${word}"`)
      const { fontSize, whiteSpace } = el.style
      el.style.fontSize = `${px}px`
      el.style.whiteSpace = 'nowrap'
      const r = document.createRange()
      r.selectNodeContents(el)
      const w = r.getBoundingClientRect().width
      el.style.fontSize = fontSize
      el.style.whiteSpace = whiteSpace
      return w
    },
    [word, px] as const,
  )

test('a long word steps the title down only as far as it must; 34 px is kept only beside an edge pin', async ({
  page,
}) => {
  await open(page)
  let boxes = await titleBoxes(page)
  // No threads, so no side pins: the paper's own 26 px a side. Each long word is at the largest
  // size at which it fits: a pixel larger and it is wider than the title's measure.
  expect(boxes.Phrasebook?.px).toBe(28)
  for (const word of ['Phrasebook', 'Sketchbook', 'Bibliography']) {
    const b = boxes[word]
    if (b === undefined) throw new Error(`no title "${word}"`)
    expect(b.px).toBeLessThan(30)
    expect(b.px).toBeGreaterThanOrEqual(21)
    expect(await wordWidthAt(page, word, b.px)).toBeLessThanOrEqual(b.measure)
    expect(await wordWidthAt(page, word, b.px + 1)).toBeGreaterThan(b.measure)
  }
  expect(boxes['Ferry to the island']?.px).toBe(30)
  for (const [, b] of Object.entries(boxes)) {
    expect(b.left).toBeGreaterThanOrEqual(25.5)
    expect(b.left).toBeLessThan(30)
    expect(b.right).toBeGreaterThanOrEqual(25.5)
  }
  // Tie "Phrasebook" to "Sketchbook", beside it: an edge pin on each facing side.
  await page.evaluate(() => {
    const st = window.__papertie.store.getState()
    const byText = (t: string) =>
      [...st.notes.entries()].find(([, n]) => n.text === t)?.[0] as string
    window.__papertie.debug.createYarn(byText('Phrasebook'), byText('Sketchbook'))
  })
  await expect(page.locator('.note-paper[data-pin-sides]')).toHaveCount(2)
  boxes = await titleBoxes(page)
  expect(boxes.Phrasebook?.right).toBeGreaterThanOrEqual(33.5)
  expect(boxes.Phrasebook?.left).toBeLessThan(30)
  expect(boxes.Sketchbook?.left).toBeGreaterThanOrEqual(33.5)
  expect(boxes.Sketchbook?.right).toBeLessThan(30)
})
