import { execSync } from 'node:child_process'
import { loadavg } from 'node:os'
import type { Page } from '@playwright/test'
import { newId } from '../../packages/core/src'
import { freshUserData } from '../desktop/helpers'
import { APP_URL, apiFor, expect, sharedDesktop, test } from './helpers/app'
import { paperPoint, saved } from './helpers/board'
import { lifetimeRecords, notesIn, seedBoard } from './helpers/lifetime'
import { serverBoard } from './helpers/server'

/**
 * Open where you left off, on a lifetime board of 100,000
 * notes: the view remembered is painted first, from the store's region for it, and the rest
 * arrives nearest first, with nothing on screen saying it is loading. Edits made before the
 * whole board is in are kept and saved once.
 *
 * Timings are from navigation start to the animation frame after the remembered view's notes are
 * in the DOM (the app's `papertie:first-paint` mark). They count only from a quiet machine (load
 * average under 4, on AC power): the load average is printed with each.
 */

test.describe.configure({ mode: 'serial' })

/** Where the board was left: the middle of the grid, at reading zoom. */
const CAMERA = { x: 50_000, y: 40_000, zoom: 1 }
/** What that camera shows in the window's 1280 × 800. */
const VIEW = { x: CAMERA.x, y: CAMERA.y, w: 1280, h: 800 }

/** The data folder of the lifetime board: each test launches Papertie on it. */
let lifetime: { dir: string; dispose(): void }
let boardId = ''
/** The notes in VIEW, as seeded. */
let inView: string[] = []
/** The note with the most threads (genBoard's hub: 20). */
let hubId = ''

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number
const load = () => loadavg()[0]?.toFixed(2)
/** The power source, as `pmset` says it ('AC Power', 'Battery Power'). */
const power = () => {
  try {
    return /'([^']+)'/.exec(execSync('pmset -g batt', { encoding: 'utf8' }))?.[1] ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

test.beforeAll(async () => {
  test.setTimeout(900_000)
  lifetime = freshUserData()
  const { desktop, end } = sharedDesktop()
  try {
    const { page, api } = await desktop.launch({ userData: lifetime.dir })
    // The window off the board while it is filled.
    await page.goto(`${APP_URL}/api/health`)
    const { notes, ops } = lifetimeRecords()
    const began = Date.now()
    boardId = await seedBoard(api, ops)
    console.log(`seeded ${notes.length} notes in ${((Date.now() - began) / 1000).toFixed(1)} s`)
    inView = notesIn(notes, VIEW)
    expect(inView.length).toBeGreaterThan(5)
    hubId = (notes[0] as { id: string }).id
  } finally {
    await end()
  }
})

test.afterAll(() => {
  lifetime?.dispose()
})

/**
 * Watch the page from its first byte for anything that says it is loading: a progress bar (by
 * role or element), a visible element marked busy, or text saying "loading". Read back with
 * {@link loadingSeen}. Also records the main thread's long tasks ({@link longTasks}) and every
 * request for a region ({@link regions}).
 */
async function watchForLoading(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __loadingSeen: string[] }).__loadingSeen = seen
    const check = (root: ParentNode) => {
      for (const el of root.querySelectorAll('[role="progressbar"], progress')) {
        seen.push(`progress: ${el.outerHTML.slice(0, 80)}`)
      }
      for (const el of root.querySelectorAll('[aria-busy="true"]')) {
        if (el.getClientRects().length > 0) seen.push(`busy: ${el.outerHTML.slice(0, 80)}`)
      }
      const text = document.body?.textContent ?? ''
      if (/loading/i.test(text)) seen.push(`text: ${text.slice(0, 80)}`)
    }
    // Long tasks (over 50 ms) on the main thread.
    const long: Array<{ start: number; ms: number }> = []
    ;(window as unknown as { __longTasks: typeof long }).__longTasks = long
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          long.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) })
        }
      }).observe({ type: 'longtask', buffered: true })
    } catch {
      // no Long Tasks API
    }
    new MutationObserver(() => check(document)).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['role', 'aria-busy'],
    })
  })
}

type LongTask = { start: number; ms: number }

/** The main thread's long tasks since the page began (from navigation start, ms). */
const longTasks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __longTasks?: LongTask[] }).__longTasks ?? [])

/** The long tasks after the first paint, every one of them a freeze of the board shown. */
async function freezesAfterPaint(page: Page, paintMs: number): Promise<LongTask[]> {
  return (await longTasks(page)).filter((t) => t.start >= paintMs)
}

const show = (ts: LongTask[]) => ts.map((t) => `${t.ms}@${t.start}`).join(', ')

const loadingSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __loadingSeen?: string[] }).__loadingSeen ?? [])

/** `page` (a Papertie's window) with the camera remembered, watched from its next load on. */
async function leftAt(page: Page, board = boardId): Promise<Page> {
  await watchForLoading(page)
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.endsWith('/region'))
      regionAsked.set(page, (regionAsked.get(page) ?? 0) + 1)
  })
  // Off the board, so the page that leaves does not remember a view of its own.
  await page.goto(`${APP_URL}/api/health`)
  await page.evaluate(([key, cam]) => localStorage.setItem(key, JSON.stringify(cam)), [
    `papertie.camera.${board}`,
    CAMERA,
  ] as const)
  return page
}

/** Requests for a region, per page (reset by the test as it reloads). */
const regionAsked = new WeakMap<Page, number>()

/** The first paint's time from navigation start, and the notes it drew. */
async function firstPaint(page: Page): Promise<{ ms: number; ids: string[] }> {
  const h = await page.waitForFunction(
    () => {
      const m = performance.getEntriesByName('papertie:first-paint')[0] as
        | PerformanceMark
        | undefined
      return m ? { ms: m.startTime, ids: (m.detail as { ids: string[] }).ids } : null
    },
    undefined,
    { timeout: 60_000 },
  )
  return (await h.jsonValue()) as { ms: number; ids: string[] }
}

/** The opening is over (the whole board is in); when, from navigation start. */
async function opened(page: Page): Promise<number> {
  const h = await page.waitForFunction(
    () => performance.getEntriesByName('papertie:ready')[0]?.startTime ?? null,
    undefined,
    { timeout: 180_000 },
  )
  return (await h.jsonValue()) as number
}

test('a first open in a Papertie just launched paints within 1 s', async ({ desktop }) => {
  test.setTimeout(600_000)
  const samples: number[] = []
  for (let i = 0; i < 3; i++) {
    const running = await desktop.launch({ userData: lifetime.dir })
    try {
      const page = await leftAt(running.page)
      regionAsked.set(page, 0)
      await page.goto(`${APP_URL}/?bench`)
      const paint = await firstPaint(page)
      expect(paint.ids).toEqual(expect.arrayContaining(inView))
      samples.push(paint.ms)
      const ready = await opened(page)
      await page.waitForTimeout(500)
      const freezes = await freezesAfterPaint(page, paint.ms)
      console.log(
        `launch ${i + 1}: first paint ${paint.ms.toFixed(0)} ms, whole board ${ready.toFixed(0)} ms, ` +
          `long tasks [${show(await longTasks(page))}], load ${load()}`,
      )
      // One region, then the whole board.
      expect(regionAsked.get(page)).toBe(1)
      expect(freezes, `long tasks after the first paint: ${show(freezes)}`).toEqual([])
      expect(await loadingSeen(page)).toEqual([])
    } finally {
      await desktop.quit(running)
    }
  }
  console.log(`first open median ${median(samples).toFixed(0)} ms, load ${load()}`)
  expect(median(samples)).toBeLessThanOrEqual(1000)
})

test('no spinner, progress bar or loading text is ever shown', async ({ desktop }) => {
  test.setTimeout(300_000)
  const page = await leftAt((await desktop.launch({ userData: lifetime.dir })).page)
  // A slow read: the whole board takes seconds to come, the opening stays open meanwhile.
  await page.route(`**/api/boards/${boardId}`, async (r) => {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await r.continue()
  })
  await page.goto(`${APP_URL}/?bench`)
  await firstPaint(page)
  await opened(page)
  await page.reload()
  await firstPaint(page)
  await opened(page)
  expect(await loadingSeen(page)).toEqual([])
  expect(await page.getByRole('progressbar').count()).toBe(0)
})

test('press + / choose a design / type during opening survives a reload', async ({ desktop }) => {
  test.setTimeout(300_000)
  const page = await leftAt((await desktop.launch({ userData: lifetime.dir })).page)
  // The board is held back (its whole load, or its resume) while a gate is shut: the opening is
  // still under way meanwhile. Sending (POST) is never held.
  let gate: Promise<void> = Promise.resolve()
  let release: () => void = () => {}
  const shut = () => {
    gate = new Promise<void>((r) => {
      release = r
    })
  }
  const board = `/api/boards/${boardId}`
  await page.route(
    (url) =>
      url.pathname === board || (url.pathname === `${board}/ops` && url.searchParams.has('since')),
    async (r) => {
      if (r.request().method() === 'GET') await gate
      await r.continue()
    },
  )
  const sent: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/ops')) sent.push(r.url())
  })
  const stillOpening = () =>
    page.evaluate(
      () =>
        (window.__papertie as unknown as { session: { opening: { open: boolean } } }).session
          .opening.open,
    )
  const mine = (text: string) =>
    page.evaluate(
      (text) =>
        [...window.__papertie.store.getState().notes.values()]
          .filter((n) => n.text === text)
          .map((n) => (n as unknown as { paper: string }).paper),
      text,
    )
  const inStore = async (text: string) =>
    [...(await serverBoard(apiFor(page), boardId)).notes.values()]
      .filter((n) => n.text === text)
      .map((n) => n.paper)
  /** A note from "+" on rose paper, written on, while the board opens. */
  const pin = async (text: string) => {
    await page
      .getByRole('toolbar', { name: 'Tools' })
      .getByRole('button', { name: 'New note' })
      .click()
    const picker = page.getByRole('dialog', { name: 'New note' })
    // The Paper row's (the Sheet row has the same names, folded away).
    await picker.getByRole('radio', { name: 'Rose' }).first().check()
    await picker.getByRole('button', { name: 'Pin note' }).click()
    await expect(page.locator('[contenteditable]').first()).toBeFocused()
    await page.keyboard.type(text)
    await page.keyboard.press('Escape')
  }

  // 1. Written while the board opens: shown, held, not sent; saved once it is in.
  shut()
  await page.goto(`${APP_URL}/?bench`)
  await firstPaint(page)
  expect(await stillOpening()).toBe(true)
  const first = 'Written while it opened'
  await pin(first)
  expect(await stillOpening()).toBe(true)
  expect(await mine(first)).toEqual(['rose'])
  expect(sent).toEqual([])
  release()
  await opened(page)
  await saved(page)
  expect(await mine(first)).toEqual(['rose'])

  // 2. Written while the board opens, then the page reloads before it is in: the edits go as the
  // page leaves, and are there, once, when it is back.
  shut()
  await page.reload()
  await firstPaint(page)
  expect(await stillOpening()).toBe(true)
  const second = 'Closed while it loaded'
  await pin(second)
  expect(await inStore(second)).toEqual([])
  await page.reload() // a real pagehide, mid-opening
  await firstPaint(page)
  release()
  await opened(page)
  await saved(page)
  expect(await mine(second)).toEqual(['rose'])

  // Once each, in the store and after one more reload.
  await page.reload()
  await firstPaint(page)
  await opened(page)
  for (const text of [first, second]) {
    expect(await mine(text)).toEqual(['rose'])
    expect(await inStore(text)).toEqual(['rose'])
  }
  expect(await loadingSeen(page)).toEqual([])
})

/**
 * Event Timing of the keys typed from now: each interaction's duration (keydown to the frame
 * after it), from entries of 16 ms or more (the least the API reports; the rest were quicker).
 */
async function watchKeys(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __keys: Map<number, number> }
    w.__keys = new Map()
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[]) {
        if (!e.interactionId || !e.name.startsWith('key')) continue
        w.__keys.set(e.interactionId, Math.max(w.__keys.get(e.interactionId) ?? 0, e.duration))
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit)
  })
}
const keyTimes = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { __keys: Map<number, number> }).__keys.values()])

/** The keys typed: 60 of them, 60 ms apart. */
const TYPED = 'the lifetime board keeps every thought, one key at a time ok'

/** `TYPED` typed where the caret is: each key's time to its frame (16 for one not reported). */
async function typeTimed(page: Page): Promise<{ p95: number; max: number; slow: number }> {
  await watchKeys(page)
  await page.keyboard.type(TYPED, { delay: 60 })
  await page.waitForTimeout(300)
  const slow = await keyTimes(page)
  const all = [...slow, ...Array(Math.max(0, TYPED.length - slow.length)).fill(16)].sort(
    (a, b) => a - b,
  )
  return {
    p95: all[Math.ceil(all.length * 0.95) - 1] as number,
    max: all.at(-1) as number,
    slow: slow.length,
  }
}

/**
 * The window's own floor: the same keys in a bare editable, on a page with nothing else. A key's
 * time runs to the frame that shows it, so the window's frames set the least it can be (some two
 * frames here); the board is judged against that, not against a number of its own.
 */
async function bareTyping(page: Page): Promise<{ p95: number; max: number }> {
  await page.evaluate(() => {
    document.body.innerHTML =
      '<div id="bare" contenteditable="true" style="font: 16px sans-serif; padding: 40px">x</div>'
  })
  await page.bringToFront()
  await page.click('#bare')
  // The best of three: the floor is what the window can do.
  let best = await typeTimed(page)
  for (let i = 0; i < 2; i++) {
    const t = await typeTimed(page)
    if (t.p95 < best.p95 || (t.p95 === best.p95 && t.max < best.max)) best = t
  }
  return best
}

/** One frame of the window (60 Hz), as Event Timing rounds it (8 ms steps). */
const FRAME_MS = 16

test('on the lifetime board, typing stays within a frame of the bare window’s and a drag with 20 threads within its budget', async ({
  desktop,
}) => {
  test.setTimeout(300_000)
  const page = await leftAt((await desktop.launch({ userData: lifetime.dir })).page)
  const floor = await bareTyping(page)
  console.log(`typing in a bare editable: p95 ${floor.p95} ms, max ${floor.max} ms`)
  await page.goto(`${APP_URL}/?bench`)
  await firstPaint(page)
  await opened(page)
  await page.waitForTimeout(1000) // the first frames behind
  await page.bringToFront()
  const machine = () => `load ${load()}, ${power()}`
  const since = await page.evaluate(() => performance.now())

  // Typing: one note in view, written on. A timing counts only from a quiet machine (load under
  // 4, as the other timings here): taken again, up to three times, until one is quiet.
  const target = inView[Math.floor(inView.length / 2)] as string
  const budget = { p95: floor.p95 + FRAME_MS, max: floor.max + 2 * FRAME_MS }
  const typeOnce = async () => {
    const p = await paperPoint(page, target)
    await page.mouse.dblclick(p.x, p.y)
    await expect(page.locator('[contenteditable]').first()).toBeFocused()
    await page.keyboard.press('ControlOrMeta+a')
    const loadBefore = loadavg()[0] ?? 0
    const t = await typeTimed(page)
    await page.keyboard.press('Escape')
    const quiet = Math.max(loadBefore, loadavg()[0] ?? 0) < 4
    console.log(
      `typing at 100,000 notes: ${TYPED.length} keys, p95 ${t.p95.toFixed(0)} ms, max ${t.max.toFixed(0)} ms ` +
        `(${t.slow} at 16 ms or more; within ${budget.p95} and ${budget.max}), ${machine()}${quiet ? '' : ' (not quiet: not counted)'}`,
    )
    return { ...t, quiet }
  }
  let typing = await typeOnce()
  for (let i = 0; i < 2 && !typing.quiet; i++) typing = await typeOnce()

  // A drag of the hub, with its 20 threads, at reading zoom.
  expect(
    await page.evaluate(([id]) => window.__papertie.debug.focusCamera(id, 1), [hubId] as const),
  ).toBe(true)
  await page.waitForFunction(() => !window.__papertiePerf?.loopRunning())
  await page.waitForTimeout(300)
  const drag = await page.evaluate(() => window.__papertiePerf?.runGesture('drag', 3000))
  if (drag === undefined) throw new Error('no perf hooks')
  console.log(
    `drag with 20 threads at 100,000 notes: ${drag.frames} frames, p95 ${drag.p95FrameMs.toFixed(1)} ms, ` +
      `max ${drag.maxFrameMs.toFixed(1)} ms, ${machine()}`,
  )
  await page.waitForTimeout(500)
  const freezes = await freezesAfterPaint(page, since)
  console.log(`long tasks while typing and dragging: [${show(freezes)}]`)

  if (typing.quiet) {
    // No more than a frame over the bare window at the 95th percentile, two at the worst key.
    expect(typing.p95).toBeLessThanOrEqual(budget.p95)
    expect(typing.max).toBeLessThanOrEqual(budget.max)
  } else {
    test.info().annotations.push({ type: 'warning', description: `typing timed at ${machine()}` })
  }
  expect(drag.maxFrameMs).toBeLessThanOrEqual(50)
  expect(freezes, `long tasks: ${show(freezes)}`).toEqual([])
})

/** One trace event, as Chrome's tracing reports it. */
interface TraceEvent {
  name: string
  cat: string
  ph?: string
  ts: number
  dur?: number
  args?: { startTime?: number }
}

test('a board swapped in whole on the lifetime board (a restore) is taken in without a long task', async ({
  desktop,
}) => {
  test.setTimeout(300_000)
  const page = await leftAt((await desktop.launch({ userData: lifetime.dir })).page)
  await page.goto(`${APP_URL}/?bench`)
  await firstPaint(page)
  await opened(page)
  await page.waitForTimeout(1000)
  await page.bringToFront()
  // The same board, every note a copy a little to the right and every thread a copy: built
  // first (that build is the test's, not the app's), then swapped in.
  await page.evaluate(() => {
    const store = window.__papertie.store as unknown as {
      getState(): { notes: Map<string, { x: number }>; yarns: Map<string, object> }
    }
    const s = store.getState()
    const notes = new Map([...s.notes].map(([k, n]) => [k, { ...n, x: n.x + 7 }]))
    const yarns = new Map([...s.yarns].map(([k, y]) => [k, { ...y }]))
    ;(window as unknown as { __restored: unknown }).__restored = { ...s, notes, yarns }
  })
  await page.waitForTimeout(500)
  // Chrome's trace, to tell a slice the page stretched from one V8's collector stopped.
  const cdp = await page.context().newCDPSession(page)
  const events: TraceEvent[] = []
  cdp.on('Tracing.dataCollected', (e) => {
    for (const ev of e.value as unknown as TraceEvent[]) events.push(ev)
  })
  await cdp.send('Tracing.start', {
    categories: 'blink.user_timing,devtools.timeline,v8,disabled-by-default-v8.gc',
    transferMode: 'ReportEvents',
  })
  const at = await page.evaluate(() => {
    const store = window.__papertie.store as unknown as { replace(s: unknown, t?: unknown): void }
    performance.clearMeasures('papertie:catch-up')
    const t = performance.now()
    store.replace((window as unknown as { __restored: unknown }).__restored, 'all')
    return t
  })
  // Caught up: the notes drawn are the store's again.
  await page.waitForFunction(
    () => {
      const v = (
        window.__papertie.runtime as unknown as { view: { getState(): { drawn: unknown } } }
      ).view
      return v.getState().drawn === null
    },
    undefined,
    { timeout: 120_000 },
  )
  await page.waitForTimeout(500)
  const traced = new Promise((r) => cdp.once('Tracing.tracingComplete', r))
  await cdp.send('Tracing.end')
  await traced
  // Each slice is measured to the end of its task (the notes drawn rendered with it).
  const slices = await page.evaluate(() =>
    performance.getEntriesByName('papertie:catch-up').map((e) => ({
      start: e.startTime,
      ms: e.duration,
      detail: (e as PerformanceMeasure).detail,
    })),
  )
  /** The collector's full pauses (mark-compact) inside a slice, ms. */
  const majorGcIn = (slice: { start: number; ms: number }) => {
    const b = events.find(
      (e) =>
        e.name === 'papertie:catch-up' &&
        e.ph === 'b' &&
        Math.abs((e.args?.startTime ?? -1) - slice.start) < 0.01,
    )
    if (b === undefined) return 0
    return events
      .filter((e) => e.name === 'MajorGC' && e.ts >= b.ts && e.ts < b.ts + slice.ms * 1000)
      .reduce((ms, e) => ms + (e.dur ?? 0) / 1000, 0)
  }
  const over = slices
    .filter((s) => s.ms > 8)
    .map((s) => ({
      ms: Math.round(s.ms * 10) / 10,
      gc: Math.round(majorGcIn(s) * 10) / 10,
      ...s.detail,
    }))
  const long = (await longTasks(page)).filter((t) => t.start >= at)
  console.log(
    `restore at 100,000 notes: ${slices.length} slices, longest ${Math.max(...slices.map((s) => s.ms)).toFixed(1)} ms; ` +
      `over 8 ms: ${JSON.stringify(over)}; long tasks [${show(long)}], load ${load()}, ${power()}`,
  )
  expect(slices.length).toBeGreaterThan(10)
  expect(long, `long tasks: ${show(long)}`).toEqual([])
  // Each slice is an idle chunk of 8 ms, but for one V8's collector stopped for a full collection
  // (its pause, not the slice's work): counted on a quiet machine only.
  if ((loadavg()[0] ?? 0) < 4) {
    expect(over.filter((s) => s.ms - s.gc > 8)).toEqual([])
  } else test.info().annotations.push({ type: 'warning', description: `restore at load ${load()}` })
})

test('the board’s first paint never waits on books (a board with 50 books)', async ({
  page,
  api,
}) => {
  test.setTimeout(300_000)
  // A board of its own (a Papertie on fresh data), of a few hundred notes and 50 books of 40
  // paragraphs each: the books' records come with the board, their text only with a book opened.
  const notes = Array.from({ length: 300 }, (_, i) => ({
    op: 'note.create' as const,
    note: {
      type: 'note' as const,
      id: newId('note', Date.now() + i),
      x: CAMERA.x + (i % 20) * 340 - 3000,
      y: CAMERA.y + Math.floor(i / 20) * 300 - 2000,
      w: 240,
      h: 160,
      z: i + 1,
      paper: 'cream' as const,
      style: 'rustic' as const,
      text: `note ${i}`,
      image: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }))
  const books = Array.from({ length: 50 }, (_, b) => {
    const id = newId('book', Date.now() + 1000 + b)
    const at = new Date().toISOString()
    return [
      {
        op: 'book.create' as const,
        book: {
          type: 'book' as const,
          id,
          title: `Book ${b + 1}`,
          lang: 'en' as const,
          shelfPos: `V${String(b + 1).padStart(3, '0')}V`,
          cover: { seed: b + 1, ink: 'indigo' as const, motif: 'overprint' as const },
          trashedAt: null,
          createdAt: at,
          updatedAt: at,
        },
      },
      ...Array.from({ length: 40 }, (_, p) => ({
        op: 'block.create' as const,
        block: {
          type: 'block' as const,
          id: newId('block', Date.now() + 100_000 + b * 100 + p),
          bookId: id,
          pos: `V${String(p + 1).padStart(3, '0')}V`,
          kind: 'p' as const,
          text: `Paragraph ${p} of book ${b}. `.repeat(20),
          marks: [],
        },
      })),
    ]
  }).flat()
  const booksBoard = await seedBoard(api, [...notes, ...books])
  const asked: Array<{ path: string; at: number }> = []
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (path.startsWith('/api/boards/')) asked.push({ path, at: Date.now() })
  })
  await leftAt(page, booksBoard)
  for (const run of ['first', 'second']) {
    asked.length = 0
    await page.goto(`${APP_URL}/?bench`)
    const paint = await firstPaint(page)
    expect(paint.ids.length).toBeGreaterThan(5)
    const ready = await opened(page)
    await page.waitForTimeout(500)
    const freezes = await freezesAfterPaint(page, paint.ms)
    console.log(
      `50 books, ${run} open: first paint ${paint.ms.toFixed(0)} ms, whole board ${ready.toFixed(0)} ms, ` +
        `long tasks [${show(await longTasks(page))}], load ${load()}`,
    )
    // The shelf is closed: no book is read, so the first paint waits on none.
    expect(asked.filter((a) => a.path.includes('/books/'))).toEqual([])
    // The board's books are on it (their records), without one paragraph of their text.
    const held = await page.evaluate(() => {
      const s = (
        window.__papertie.store as unknown as {
          getState(): { books: Map<string, unknown>; blocks: Map<string, unknown> }
        }
      ).getState()
      return { books: s.books.size, blocks: s.blocks.size }
    })
    expect(held).toEqual({ books: 50, blocks: 0 })
    expect(freezes, `long tasks after the first paint: ${show(freezes)}`).toEqual([])
    expect(await loadingSeen(page)).toEqual([])
  }
})
