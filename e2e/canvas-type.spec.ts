import { type Browser, expect, type Page, test } from '@playwright/test'
import type { Cam } from './hooks'

/**
 * Web faces that arrive late move nothing: text is set in a
 * metric-matched local fallback until its face comes, and the runtime settles heights and yarn
 * edge pins when it does.
 */

const VIEW = { width: 1280, height: 800 }
test.use({ viewport: VIEW })

const mine = (n: number) => `note_01JBT6${String(n).padStart(20, '0')}`

interface NewNote {
  id: string
  x: number
  y: number
  w: number
  h: number
  text: string
  paper?: string
}

async function open(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  return errors
}

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

const frames = (page: Page, n = 2) =>
  page.evaluate(
    (n) =>
      new Promise<void>((done) => {
        const step = (k: number) => (k === 0 ? done() : requestAnimationFrame(() => step(k - 1)))
        step(n)
      }),
    n,
  )

/** Commit note.create for each note (fibre, cream unless given). */
async function create(page: Page, notes: NewNote[]): Promise<void> {
  await page.evaluate((notes) => {
    const now = new Date().toISOString()
    const store = window.__papertie.store as unknown as { commit(ops: unknown[]): void }
    store.commit(
      notes.map((n, i) => ({
        op: 'note.create',
        note: {
          type: 'note',
          image: null,
          style: 'rustic',
          paper: 'cream',
          z: 5000 + i,
          createdAt: now,
          updatedAt: now,
          ...n,
        },
      })),
    )
  }, notes)
}

async function camera(page: Page, c: Cam): Promise<void> {
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), c)
  await idle(page)
}

/** Every web face's files (Fontsource woff2), held back by the tests below until released. */
const ALL_FACES = '**/{instrument-sans,newsreader,patrick-hand,cormorant-garamond}-*.woff2'

/** Hold the files matching `glob` until the returned function is called. */
async function holdFaces(page: Page, glob: string): Promise<{ release(): void; asked(): number }> {
  let release = () => {}
  const held = new Promise<void>((r) => {
    release = r
  })
  let asked = 0
  await page.route(glob, async (route) => {
    asked++
    await held
    await route.continue()
  })
  return { release: () => release(), asked: () => asked }
}

/** Text in each face's roles, as the board and its screens set it. */
const SAMPLES: Array<{ face: string; font: string; text: string }> = [
  {
    face: 'Instrument Sans',
    font: '400 16px var(--font-note)',
    text: 'Second flush, 80 degrees, 60 seconds. Ask about the apricot dye workshop.',
  },
  { face: 'Instrument Sans', font: '600 13px var(--font-note)', text: 'Settings Board Account' },
  {
    face: 'Newsreader',
    font: '600 30px var(--font-display)',
    text: 'Tea notes, Stationery Design',
  },
  { face: 'Newsreader', font: '600 30px var(--font-display)', text: 'Paper goods' },
  {
    face: 'Cormorant Garamond',
    font: 'italic 400 21px var(--font-italic)',
    text: 'Spring Journey, Night Shift',
  },
  {
    face: 'Patrick Hand',
    font: '400 16px var(--font-hand)',
    text: 'supports, next step, objection',
  },
]

/** Each sample's set width and height (CSS px), on one line. */
const measure = (page: Page) =>
  page.evaluate(
    (samples) =>
      samples.map(({ font, text }) => {
        const s = document.createElement('span')
        s.style.font = font
        s.style.whiteSpace = 'nowrap'
        s.textContent = text
        document.body.append(s)
        const r = s.getBoundingClientRect()
        s.remove()
        return { w: r.width, h: r.height }
      }),
    SAMPLES,
  )

/**
 * How far a fallback's width may stray from its web face's: 4%. Measured on macOS (2026-11,
 * Chromium): Instrument Sans +1.0% and -0.8%, Newsreader +0.2% and +1.2%, Cormorant Garamond
 * +2.7%, Patrick Hand +0.2%. 4% leaves room for a system font update to move the closest (+2.7%)
 * by a point or so before it fails.
 */
const WIDTH_LIMIT = 0.04

/**
 * The local faces the fallbacks name (`fallbackFonts.css`), found where they load. Elsewhere than
 * on Apple platforms they do not, and the stacks fall through as before: nothing to match.
 */
const missingLocals = (page: Page) =>
  page.evaluate(async () => {
    const fallbacks = [...document.fonts].filter((f) => f.family.endsWith(' Fallback'))
    await Promise.allSettled(fallbacks.map((f) => f.load()))
    return [...new Set(fallbacks.filter((f) => f.status !== 'loaded').map((f) => f.family))].sort()
  })

test('a face still on its way is set in its metric-matched fallback', async ({ page }) => {
  test.skip(process.platform !== 'darwin', 'the fallbacks are macOS system faces (local())')
  const faces = await holdFaces(page, ALL_FACES)
  const errors = await open(page)
  const missing = await missingLocals(page)
  test.skip(missing.length > 0, `local faces missing for: ${missing.join(', ')}`)
  await expect.poll(() => faces.asked()).toBeGreaterThan(0)
  const early = await measure(page)
  // Set in the fallbacks: none of the web faces has come.
  expect(
    await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length),
  ).toBe(
    await page.evaluate(
      () =>
        [...document.fonts].filter((f) => f.status === 'loaded' && f.family.endsWith(' Fallback'))
          .length,
    ),
  )
  faces.release()
  await page.evaluate(async (samples) => {
    const root = getComputedStyle(document.documentElement)
    for (const { font, text } of samples) {
      await document.fonts.load(
        font.replace(/var\((--[\w-]+)\)/, (_m, v: string) => root.getPropertyValue(v)),
        text,
      )
    }
  }, SAMPLES)
  const late = await measure(page)
  const off = SAMPLES.map((s, i) => {
    const a = early[i] as { w: number; h: number }
    const b = late[i] as { w: number; h: number }
    return { face: s.face, text: s.text, width: a.w / b.w - 1, height: a.h - b.h }
  })
  test.info().annotations.push({
    type: 'fallback width / web width - 1',
    description: off.map((o) => `${o.face} ${(o.width * 100).toFixed(1)}%`).join('; '),
  })
  for (const o of off) {
    // Within WIDTH_LIMIT of the web face's width, at its line height.
    expect(Math.abs(o.width), `${o.face}: ${o.text}`).toBeLessThanOrEqual(WIDTH_LIMIT)
    expect(Math.abs(o.height), `${o.face}: ${o.text}`).toBeLessThanOrEqual(0.5)
  }
  expect(errors).toEqual([])
})

/**
 * Beside the demo board's notes (Latin bodies): a long body text, a
 * Latin note below it, and a tea note whose height is its text's. Its paragraph, 192 px wide,
 * sets in 7 lines in Instrument Sans and in its matched fallback, and in 8 in the unmatched
 * system face; a thread leaves its bottom edge for the note below. Every note is in view at once,
 * at full detail.
 */
const TEA = mine(13)
const LATE: NewNote[] = [
  {
    id: mine(10),
    x: 2000,
    y: 60,
    w: 300,
    h: 120,
    text: 'Travel log\nThe morning was quiet; I walked the river and photographed the old streets.Coffee at the corner café, then the market.\n\nLetter paper from the paper shop in the afternoon.',
  },
  {
    id: mine(11),
    x: 2380,
    y: 80,
    w: 260,
    h: 120,
    paper: 'rose',
    text: 'Reminder\nBy tomorrow morning, choose three yarn colours and paste them in the sample book.',
  },
  { id: mine(12), x: 2010, y: 600, w: 260, h: 140, text: 'Below\nA Latin note under the first.' },
  {
    id: TEA,
    x: 2380,
    y: 400,
    w: 244,
    h: 120,
    paper: 'sage',
    text: 'Tea, second flush\n\nSecond flush from Makinohara, 80 degrees, sixty seconds. The first infusion is grassy and bright; the second opens into chestnut and a little smoke.',
  },
  { id: mine(14), x: 2390, y: 940, w: 240, h: 140, text: 'Under the tea\nThe next pour.' },
]
const LATE_ZOOM = 0.45

/**
 * The stacks without the fallbacks (no "… Fallback" family): text waiting for a face is set in a
 * system face at its own metrics; the body's in a wide one (Verdana), so the wait shows.
 */
const UNMATCHED = `:root:root {
  --font-note: "Instrument Sans", Verdana, sans-serif;
  --font-display: "Newsreader", Georgia, serif;
  --font-italic: "Cormorant Garamond", Georgia, serif;
  --font-hand: "Patrick Hand", system-ui, sans-serif;
}`

/** The demo board and the notes above with their threads, rotation off, all in view. */
async function lateBoard(page: Page, fallbacks = true): Promise<string[]> {
  const errors = await open(page)
  if (!fallbacks) await page.addStyleTag({ content: UNMATCHED })
  await page.getByLabel('Paper rotation').uncheck()
  await create(page, LATE)
  await page.evaluate(
    ([a, b, c, tea, under]) => {
      window.__papertie.debug.createYarn(a, c)
      window.__papertie.debug.createYarn(a, b)
      window.__papertie.debug.createYarn(tea, under)
    },
    LATE.map((n) => n.id) as [string, string, string, string, string],
  )
  const all = await page.evaluate(() => window.__papertie.debug.notesRect())
  if (all === null) throw new Error('no notes')
  await camera(page, { x: all.x - 40, y: all.y - 40, zoom: LATE_ZOOM })
  await frames(page)
  return errors
}

/** Each mounted note's laid-out height (world px) and the height the runtime holds for it. */
const heights = (page: Page) =>
  page.evaluate(() => {
    const rt = window.__papertie.runtime as unknown as { measuredH: Map<string, number> }
    const out: Record<string, { dom: number; held: number }> = {}
    for (const el of document.querySelectorAll<HTMLElement>('article.note[data-note-id]')) {
      const id = el.dataset.noteId as string
      out[id] = {
        dom: Number.parseFloat(getComputedStyle(el).height),
        held: rt.measuredH.get(id) ?? 0,
      }
    }
    return out
  })

const layoutShift = (page: Page) =>
  page.evaluate(() => (window as unknown as { __cls: number }).__cls)

/** Every yarn end's edge pin on screen, with the note it is on and its distance in from the outline. */
const pinInsets = (page: Page) =>
  page.evaluate(() => {
    const m = window.__papertie
    const out: Array<{ noteId: string; inset: number; at: string }> = []
    for (const [id, y] of m.store.getState().yarns) {
      for (let seg = 0; seg < y.noteIds.length - 1; seg++) {
        for (const [end, k] of [
          ['a', seg],
          ['b', seg + 1],
        ] as const) {
          const p = m.debug.attachScreen(id, seg, end)
          const noteId = y.noteIds[k] as string
          const el = document.querySelector(`article.note[data-note-id="${noteId}"]`)
          if (p === undefined || el === null) continue
          const r = el.getBoundingClientRect()
          const inset = Math.min(p.x - r.left, r.right - p.x, p.y - r.top, r.bottom - p.y)
          out.push({ noteId, inset, at: `${p.x.toFixed(1)}, ${p.y.toFixed(1)}` })
        }
      }
    }
    return out
  })

/**
 * Lay the board out with the faces matching `route` held back, release them, and read the
 * heights before and after, the final heights (a page whose faces came at once), the layout
 * shift after the release and the yarn ends' insets.
 */
async function lateLoad(page: Page, browser: Browser, route: string, fallbacks: boolean) {
  const fresh = await browser.newPage({ viewport: VIEW })
  await lateBoard(fresh, fallbacks)
  await fresh.evaluate(() => document.fonts.ready)
  await frames(fresh, 3)
  await idle(fresh)
  const final = await heights(fresh)
  await fresh.close()

  const faces = await holdFaces(page, route)
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number }
    w.__cls = 0
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as Array<{
        value: number
        hadRecentInput: boolean
      }>) {
        if (!e.hadRecentInput) w.__cls += e.value
      }
    }).observe({ type: 'layout-shift', buffered: true })
  })
  const errors = await lateBoard(page, fallbacks)
  await expect.poll(() => faces.asked()).toBeGreaterThan(0)
  await frames(page, 3)
  const early = await heights(page)
  const shiftEarly = await layoutShift(page)

  faces.release()
  // The held faces have come, and nothing is still on its way.
  await page.waitForFunction(() =>
    [...document.fonts].some((f) => f.family === 'Instrument Sans' && f.status === 'loaded'),
  )
  await page.waitForFunction(() => [...document.fonts].every((f) => f.status !== 'loading'))
  await frames(page, 3)
  await idle(page)
  const after = await heights(page)
  const shift = (await layoutShift(page)) - shiftEarly
  const moved = Object.entries(after)
    .filter(([id, h]) => Math.abs((early[id]?.dom ?? h.dom) - h.dom) > 1)
    .map(([id, h]) => `${id.slice(-4)} ${early[id]?.dom} → ${h.dom}`)
  test
    .info()
    .annotations.push(
      { type: 'heights that moved when the faces came', description: moved.join('; ') || 'none' },
      { type: 'layout shift after the faces came', description: String(shift) },
    )
  return { errors, early, after, final, shift, moved, insets: await pinInsets(page) }
}

/** Every mounted note at its final height, held by the runtime; every yarn end on its outline. */
function expectSettled(r: Awaited<ReturnType<typeof lateLoad>>): void {
  expect(Object.keys(r.after).length).toBeGreaterThanOrEqual(10)
  for (const [id, h] of Object.entries(r.after)) {
    expect(h.dom, id).toBeCloseTo(r.final[id]?.dom ?? Number.NaN, 0)
    expect(Math.abs(h.held - h.dom), id).toBeLessThanOrEqual(1)
  }
  expect(r.insets.filter((e) => e.noteId.startsWith('note_01JBT6')).length).toBe(6)
  // The edge-pin inset (14 px) in from the note's outline.
  for (const { noteId, inset, at } of r.insets) {
    expect(Math.abs(inset - 14 * LATE_ZOOM), `${noteId} at ${at}`).toBeLessThanOrEqual(1)
  }
}

test('late font load re-measures notes and re-attaches yarn (fallbacks off: the tea note’s height changes)', async ({
  page,
  browser,
}) => {
  // Without the matched fallbacks the tea paragraph is set a line longer until Instrument Sans
  // comes: the note must take its final height and its thread's end must follow its edge.
  const r = await lateLoad(page, browser, '**/instrument-sans-*.woff2', false)
  const tea = r.after[TEA]
  if (tea === undefined) throw new Error('the tea note is not mounted')
  expect((r.early[TEA]?.dom ?? 0) - tea.dom).toBeGreaterThan(10)
  expectSettled(r)
  expect(r.errors).toEqual([])
})

/** Instrument Sans sets every note's body. Held back, its matched fallback stands in. */
test('late font load re-measures notes and re-attaches yarn (Instrument Sans)', async ({
  page,
  browser,
}) => {
  test.skip(process.platform !== 'darwin', 'the fallbacks are macOS system faces (local())')
  const r = await lateLoad(page, browser, '**/instrument-sans-*.woff2', true)
  expectSettled(r)
  // The metric-matched fallbacks set the final height before the faces came, and
  // nothing visible moved when they did.
  expect(r.moved).toEqual([])
  expect(r.shift).toBeLessThanOrEqual(0.01)
  expect(r.errors).toEqual([])
})
