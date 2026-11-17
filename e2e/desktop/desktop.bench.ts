import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { APP_ORIGIN, createHostApp } from '../../apps/server/src/host'
import { LOD } from '../../apps/web/src/canvas/lod'
import type { Asset, Note } from '../../packages/core/src'
import { P95_FLOOR_SLACK_MS, VSYNC_SLACK_MS } from '../../tools/src/benchJudge'
import { generateClusteredBoard } from '../../tools/src/genBoard'
import {
  BoardClient,
  call,
  type Session,
  seedClustered,
  seedLibrary,
} from '../../tools/src/seedBoard'
import { paperPoint } from '../app/helpers/board'
import { keysOf, percentile } from '../bench/eventTiming'
import { BENCH_BOARD, BENCH_PHOTOS, benchLibrary } from '../bench/library'
import { hygieneLine, type Machine, machine, RUN, repo } from '../bench/run'
import type { PerfSnapshot } from '../hooks'
import { type Launched, launch } from './helpers'

/*
 * The speed targets in the packaged desktop app. The packaged Papertie
 * (`PAPERTIE_DESKTOP_EXE`) on the clustered lifetime board (100,000 notes, 10,000 threads, 12 photos
 * on some 5,000 notes) with the lifetime library (50 books, one of 200,000 words), seeded once
 * through Papertie's app in this process (`createHostApp`, the desktop app's own server code, no
 * port opened) into a data folder that every row copies into a `userData` of its own
 * (`PAPERTIE_USER_DATA`).
 *
 * The rows run in the app's own window (1280 × 800 of content, the Mac's DPR). An open is Papertie
 * quit and opened again: the first paint is timed from the window's navigation start, and from
 * the launch as well. The window is always headed (the app has no headless mode): typing is
 * judged there, beside the same keys in a blank Electron window.
 *
 * Valid only on AC power with load1 < 4 at a row's start and end (each row records both).
 * Results: `e2e/bench/results/desktop/<run>.json`. Run with `pnpm bench:desktop`.
 */

const VIEW = { width: 1280, height: 800 }
/** The seeded data folder, kept between runs (the seed takes minutes); remove it when done. */
const SEED_DIR =
  process.env.PAPERTIE_DESKTOP_BENCH_SEED ?? join(tmpdir(), 'papertie-desktop-bench-seed-1')
const SEED_MARK = join(SEED_DIR, 'seeded.json')

const LIMIT = {
  warmMs: 300,
  coldMs: 1000,
  typingP95Ms: 32,
  typingMaxMs: 50,
  dragMaxFrameMs: 50,
  readingFps: 59.5,
  saveAckP95Ms: 150,
  bookOpenMs: 300,
} as const

const BUDGET = {
  warm: 'warm open, first paint ≤ 300 ms',
  cold: 'cold open on the LAN ≤ 1 s',
  fps: '60 fps at reading zoom, and ≥ 55 fps far',
  typing: 'typing and dragging: Event Timing p95 ≤ 32 ms, max ≤ 50 ms',
  drag: '60 fps at reading zoom, and ≥ 55 fps far; no frame over 50 ms dragging 20 threads',
  saveAck: 'save ack p95 < 150 ms',
  bookTyping:
    'typing in a 200,000-word book with the board under it: Event Timing p95 ≤ 32 ms, max ≤ 50 ms',
  reopen: 'reopening into a book within 300 ms, the writer chunk included',
} as const

const OPENS = { cold: 3, warm: 5, reopen: 5 }
const SAVES = { count: 200, spacingMs: 100 }

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number

interface Seeded {
  boardId: string
  assets: Asset[]
  bookId: string
  blockIds: string[]
}

let seeded: Seeded
let hub: Note
let camera = { x: 0, y: 0, zoom: 1 }
let inView: string[] = []
/** A `userData` with the board, the camera kept at the hub and none of Chromium's caches: a cold open's. */
let coldTemplate = ''
/** The device: a `userData` that has opened the board, Chromium's caches kept (warm). */
let device = ''

// --- Results. -----------------------------------------------------------------------------

const resultsFile = () => join(repo(), 'e2e/bench/results/desktop', `${RUN}.json`)

/** AC power and load1 under 4: the rules a desktop row is judged valid by. */
const validOf = (m: Machine) => m.quiet && m.mains

function record(section: string, atStart: Machine, data: object, failures: string[]): void {
  const atEnd = machine()
  const valid = validOf(atStart) && validOf(atEnd)
  const line = `${hygieneLine(atStart)} → end load ${atEnd.load1.toFixed(2)}, ${atEnd.power}\n${section}: ${JSON.stringify(data)}${failures.length ? `  MISS ${failures.join('; ')}` : ''}${valid ? '' : '  INVALID RUN (load or power)'}`
  console.log(line)
  test.info().annotations.push({ type: section, description: line })
  const file = resultsFile()
  mkdirSync(join(file, '..'), { recursive: true })
  const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { run: RUN }
  all[section] = {
    valid,
    machine: atStart,
    machineAtEnd: atEnd,
    exe: process.env.PAPERTIE_DESKTOP_EXE ?? 'the development build (apps/desktop/dist)',
    ...data,
    failures,
  }
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`)
  expect.soft(failures, `${section}: budget`).toEqual([])
}

// --- The seed: Papertie's app on a data folder, in this process. ----------------------------

async function ensureSeed(): Promise<Seeded> {
  if (existsSync(SEED_MARK)) return JSON.parse(readFileSync(SEED_MARK, 'utf8')) as Seeded
  rmSync(SEED_DIR, { recursive: true, force: true })
  mkdirSync(join(SEED_DIR, 'data'), { recursive: true })
  const host = await createHostApp({
    dataDir: join(SEED_DIR, 'data'),
    webDist: null,
    logSink: () => {},
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await host.close()
  }
  try {
    const s: Session = {
      async fetch(path, init = {}) {
        const headers = new Headers(init.headers)
        headers.set('Origin', APP_ORIGIN)
        return host.app.fetch(new Request(`${APP_ORIGIN}${path}`, { ...init, headers }))
      },
    }
    const began = Date.now()
    const made = await seedClustered(s, BENCH_PHOTOS, BENCH_BOARD)
    const assets = [...made.state.assets.values()]
    const lib = benchLibrary(new Date().toISOString(), assets)
    const client = new BoardClient(s, made.boardId)
    const meta = await call(s, `/api/boards/${made.boardId}/meta`)
    client.revision = ((await meta.json()) as { revision: number }).revision
    await seedLibrary(client, lib)
    const long = lib.books[0]
    if (long === undefined) throw new Error('an empty library')
    console.log(
      `seeded ${made.state.notes.size} notes, ${made.state.yarns.size} threads, ${lib.books.length} books in ${((Date.now() - began) / 1000).toFixed(1)} s`,
    )
    const out: Seeded = {
      boardId: made.boardId,
      assets,
      bookId: long.id,
      blockIds: lib.blocks.filter((b) => b.bookId === long.id).map((b) => b.id),
    }
    // Closed before the mark is written: the folder is whole, its writes durable.
    await close()
    writeFileSync(SEED_MARK, JSON.stringify(out))
    return out
  } finally {
    await close()
  }
}

// --- userData folders. --------------------------------------------------------------------

const made: string[] = []
function freshDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `papertie-desktop-bench-${tag}-`))
  made.push(dir)
  return dir
}

/** A copy of `from` (a userData or the seed) in a fresh userData. */
function copyOf(from: string, tag: string): string {
  const dir = freshDir(tag)
  for (const name of readdirSync(from)) {
    if (name === 'seeded.json') continue
    cpSync(join(from, name), join(dir, name), { recursive: true })
  }
  return dir
}

/** Everything of Chromium's but the page's localStorage goes: no caches. */
function strip(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name === 'data' || name === 'Local Storage' || name === 'window-state.json') continue
    rmSync(join(dir, name), { recursive: true, force: true })
  }
}

type Started = Launched & { launchedAt: number }
const running: Started[] = []
async function start(userData: string, args: string[] = []): Promise<Started> {
  const launchedAt = Date.now()
  const l = { ...(await launch(userData, args)), launchedAt }
  running.push(l)
  return l
}
async function quit(l: Started): Promise<void> {
  await l.app.close()
  running.splice(running.indexOf(l), 1)
}

/**
 * The window state that gives `VIEW` as the window's content: the app keeps the window's outer
 * size, so the title bar's height (read from the open window) is added.
 */
async function quitSized(l: Started, userData: string): Promise<void> {
  const outer = await l.app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds().height ?? 0,
  )
  const bar = outer - (await l.page.evaluate(() => innerHeight))
  // After the quit: the app writes its own state as it closes.
  await quit(l)
  writeFileSync(
    join(userData, 'window-state.json'),
    JSON.stringify({
      width: VIEW.width,
      height: VIEW.height + bar,
      maximized: false,
      fullScreen: false,
    }),
  )
}

const keepCamera = (page: Page) =>
  page.evaluate(([key, cam]) => localStorage.setItem(key, JSON.stringify(cam)), [
    `papertie.camera.${seeded.boardId}`,
    camera,
  ] as const)

// --- What a page says. --------------------------------------------------------------------

async function firstPaint(page: Page): Promise<{ ms: number; ids: string[]; origin: number }> {
  const h = await page.waitForFunction(
    () => {
      const m = performance.getEntriesByName('papertie:first-paint')[0] as
        | PerformanceMark
        | undefined
      return m
        ? {
            ms: m.startTime,
            ids: (m.detail as { ids: string[] }).ids,
            origin: performance.timeOrigin,
          }
        : null
    },
    undefined,
    { timeout: 120_000 },
  )
  return (await h.jsonValue()) as { ms: number; ids: string[]; origin: number }
}

async function opened(page: Page): Promise<number> {
  const h = await page.waitForFunction(
    () => performance.getEntriesByName('papertie:ready')[0]?.startTime ?? null,
    undefined,
    { timeout: 300_000 },
  )
  return (await h.jsonValue()) as number
}

/**
 * The long tasks and long animation frames the page has buffered (it is observed only after it
 * opened: the app's own first window cannot be given an init script before it loads).
 */
const buffered = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ long: Array<{ start: number; ms: number }>; frames: unknown[] }>((done) => {
        const long: Array<{ start: number; ms: number }> = []
        const frames: unknown[] = []
        const obs: PerformanceObserver[] = []
        try {
          const o = new PerformanceObserver((l) => {
            for (const e of l.getEntries())
              long.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) })
          })
          o.observe({ type: 'longtask', buffered: true })
          obs.push(o)
        } catch {}
        try {
          const o = new PerformanceObserver((l) => {
            for (const e of l.getEntries() as unknown as Array<{
              startTime: number
              duration: number
              blockingDuration: number
              scripts: Array<{ sourceFunctionName: string; sourceURL: string; duration: number }>
            }>) {
              if (e.blockingDuration <= 0) continue
              frames.push({
                start: Math.round(e.startTime),
                ms: Math.round(e.duration),
                blocking: Math.round(e.blockingDuration),
                scripts: e.scripts
                  .filter((x) => x.duration > 5)
                  .map(
                    (x) =>
                      `${x.sourceFunctionName}@${x.sourceURL.split('/').pop()} ${Math.round(x.duration)} ms`,
                  ),
              })
            }
          })
          o.observe({ type: 'long-animation-frame', buffered: true })
          obs.push(o)
        } catch {}
        setTimeout(() => {
          for (const o of obs) o.disconnect()
          done({ long, frames })
        }, 100)
      }),
  )

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => !window.__papertiePerf.loopRunning())
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.waitForTimeout(300)
  await page.waitForFunction(() => !window.__papertiePerf.loopRunning())
}

/** The board with the test hooks, opened and whole. */
async function benchBoard(page: Page, path = '/?bench'): Promise<void> {
  await page.goto(`papertie://app${path}`)
  await page.waitForFunction(() => window.__papertie?.ready === true, undefined, {
    timeout: 120_000,
  })
  await opened(page)
}

/**
 * A blank Electron window beside the app's (no Papertie in it): the platform's own frame timing and
 * key latency, the floor the app's headed rows are read against.
 */
async function floors(app: ElectronApplication) {
  const shown = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, v) => {
    const w = new BrowserWindow({ width: v.width, height: v.height, useContentSize: true })
    void w.loadURL(
      `data:text/html,${encodeURIComponent('<!doctype html><body style="margin:0"><div id="d" style="width:100px;height:100px;background:#b08a3a"></div><div id="e" contenteditable style="width:300px;height:200px;font:16px sans-serif"></div></body>')}`,
    )
  }, VIEW)
  const page = await shown
  await page.waitForLoadState()
  await page.bringToFront()
  const frames = await page.evaluate(
    () =>
      new Promise<PerfSnapshot>((resolve) => {
        const el = document.getElementById('d') as HTMLElement
        const iv: number[] = []
        let start: number | null = null
        let prev: number | null = null
        const tick = (t: number) => {
          start ??= t
          el.style.transform = `translateX(${((t - start) / 8) % 600}px)`
          if (t - start >= 500) {
            if (prev !== null) iv.push(t - prev)
            prev = t
          }
          if (t - start < 4500) requestAnimationFrame(tick)
          else {
            const sorted = [...iv].sort((a, b) => a - b)
            const mean = iv.reduce((a, b) => a + b, 0) / iv.length
            resolve({
              fps: 1000 / mean,
              p95FrameMs: sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0,
              maxFrameMs: sorted.at(-1) ?? 0,
              longFrames: iv.filter((v) => v > 20).length,
              frames: iv.length,
            })
          }
        }
        requestAnimationFrame(tick)
      }),
  )
  await page.click('#e')
  const keys = await tracedTyping(page, 'floor', () => keysOf(page))
  await page.close()
  return { frames, keys }
}

// --- Setup. -------------------------------------------------------------------------------

test.beforeAll(async () => {
  test.setTimeout(1_800_000)
  seeded = await ensureSeed()
  const state = generateClusteredBoard({ ...BENCH_BOARD, photoAssets: seeded.assets })
  const count = new Map<string, number>()
  for (const y of state.yarns.values())
    for (const id of y.noteIds) count.set(id, (count.get(id) ?? 0) + 1)
  const hubId = [...count].reduce((a, b) =>
    b[1] > a[1] || (b[1] === a[1] && b[0] < a[0]) ? b : a,
  )[0]
  hub = state.notes.get(hubId) as Note
  camera = {
    x: Math.round(hub.x + hub.w / 2 - VIEW.width / 2),
    y: Math.round(hub.y + hub.h / 2 - VIEW.height / 2),
    zoom: 1,
  }
  const r = { x: camera.x, y: camera.y, w: VIEW.width, h: VIEW.height }
  inView = [...state.notes.values()]
    .filter((n) => n.x < r.x + r.w && n.x + n.w > r.x && n.y < r.y + r.h && n.y + n.h > r.y)
    .map((n) => n.id)
  expect(inView.length).toBeGreaterThan(5)

  // The cold template: the window sized and the camera kept at the hub, then everything of
  // Chromium's but localStorage removed.
  coldTemplate = copyOf(SEED_DIR, 'cold')
  {
    const l = await start(coldTemplate)
    await keepCamera(l.page)
    await l.page.waitForTimeout(1000)
    await quitSized(l, coldTemplate)
  }
  strip(coldTemplate)
  // The device: the board opened once and whole, so Chromium's caches are filled.
  device = copyOf(coldTemplate, 'device')
  {
    const l = await start(device)
    await benchBoard(l.page)
    await settle(l.page)
    await quit(l)
  }
})

test.afterAll(async () => {
  for (const l of running.splice(0)) await l.app.close().catch(() => {})
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Wait (up to 5 min) for the load to fall under 3 before a row: the setup and launches push it. */
async function quiet(): Promise<void> {
  for (const end = Date.now() + 300_000; Date.now() < end; ) {
    if ((loadavg()[0] ?? 0) < 3) return
    await new Promise((r) => setTimeout(r, 5000))
  }
}

// --- Rows. --------------------------------------------------------------------------------

/**
 * `BENCH_TRACE=warm` (or `cold`, `reopen`): the last open of that row traced from the process's
 * start (Chromium's `--trace-startup`: every process's main thread, user timing, JS samples),
 * written beside the results as `<run>-trace-<row>.json`.
 */
function traceArgs(row: string, i: number): string[] {
  if (process.env.BENCH_TRACE !== row || i !== OPENS[row as keyof typeof OPENS] - 1) return []
  const dir = join(repo(), 'e2e/bench/results/desktop')
  mkdirSync(dir, { recursive: true })
  return [
    `--trace-startup=${[
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'blink.user_timing',
      // JS samples on request: starting the profiler holds the main process some 45 ms.
      ...(process.env.BENCH_TRACE_JS === '1' ? ['disabled-by-default-v8.cpu_profiler'] : []),
      'v8',
      'navigation',
      'loading',
      'toplevel',
    ].join(',')}`,
    `--trace-startup-file=${join(dir, `${RUN}-trace-${row}.json`)}`,
    '--trace-startup-duration=6',
    '--trace-startup-format=json',
    // BENCH_NETLOG=1: Chromium's network log of the same open, beside the trace.
    ...(process.env.BENCH_NETLOG === '1'
      ? [
          `--log-net-log=${join(dir, `${RUN}-netlog-${row}.json`)}`,
          '--net-log-capture-mode=Everything',
        ]
      : []),
  ]
}

/**
 * `BENCH_TRACE=typing`: the keys typed (in the note, the book and the blank window) traced through
 * the page's CDP `Tracing`, which records every process at once: the main process's thread (where
 * the server runs and the window's frames are handed to macOS) beside the renderer's and the
 * GPU's. Written beside the results as `<run>-trace-typing-<what>.json`. Off, `fn` runs as it is.
 */
async function tracedTyping<T>(page: Page, what: string, fn: () => Promise<T>) {
  if (process.env.BENCH_TRACE !== 'typing') return fn()
  const dir = join(repo(), 'e2e/bench/results/desktop')
  mkdirSync(dir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    streamFormat: 'json',
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame',
        'blink.user_timing',
        'input',
        'latencyInfo',
        'benchmark',
        'toplevel',
        'viz',
        'gpu',
        'cc',
        'ui',
        'electron',
        'v8',
        'node',
        ...(process.env.BENCH_TRACE_JS === '1' ? ['disabled-by-default-v8.cpu_profiler'] : []),
      ],
      excludedCategories: ['*'],
    },
  })
  try {
    return await fn()
  } finally {
    const done = new Promise<string>((resolve) =>
      cdp.once('Tracing.tracingComplete', (e) => resolve(e.stream as string)),
    )
    await cdp.send('Tracing.end')
    const handle = await done
    const parts: string[] = []
    for (;;) {
      const r = await cdp.send('IO.read', { handle })
      parts.push(r.base64Encoded ? Buffer.from(r.data, 'base64').toString() : r.data)
      if (r.eof) break
    }
    await cdp.send('IO.close', { handle })
    await cdp.detach()
    writeFileSync(join(dir, `${RUN}-trace-typing-${what}.json`), parts.join(''))
  }
}

/** One open of Papertie on `userData`: its first paint, from navigation start and from the launch. */
async function openOnce(userData: string, args: string[] = []) {
  const l = await start(userData, args)
  const out = await measured(l.page, l.launchedAt)
  await quit(l)
  // A traced open keeps the server's log beside its trace (each request's route and time).
  const log = join(userData, 'logs', 'papertie.log')
  if (args.length > 0 && existsSync(log))
    cpSync(log, join(repo(), 'e2e/bench/results/desktop', `${RUN}-papertie.log`))
  return out
}

/**
 * The window closed and opened again in the running app (macOS keeps Papertie without a window; a
 * click on its Dock icon makes a new one, `activate`): a new page in the same browser, with the
 * app's server already open.
 */
async function reopenWindow(l: Started): Promise<Page> {
  await l.app.evaluate(
    ({ BrowserWindow }) =>
      new Promise<void>((done) => {
        const w = BrowserWindow.getAllWindows()[0]
        if (!w) return done()
        w.once('closed', () => done())
        w.close()
      }),
  )
  const next = l.app.waitForEvent('window')
  await l.app.evaluate(({ app }) => {
    app.emit('activate')
  })
  const page = await next
  l.page = page
  return page
}

/** A page's opening: its first paint and what came after, from its navigation start. */
async function measured(page: Page, launchedAt: number | null) {
  const paint = await firstPaint(page)
  expect(paint.ids).toEqual(expect.arrayContaining(inView))
  const readyMs = await opened(page)
  await page.waitForTimeout(500)
  const { long, frames } = await buffered(page)
  return {
    firstPaintMs: Math.round(paint.ms * 10) / 10,
    fromLaunchMs: launchedAt === null ? null : Math.round(paint.origin + paint.ms - launchedAt),
    notes: paint.ids.length,
    readyMs: Math.round(readyMs),
    long: long.filter((t) => t.start >= paint.ms),
    longBeforePaint: long.filter((t) => t.start < paint.ms).length,
    frames: (frames as Array<{ start: number }>).filter((f) => f.start >= paint.ms),
    // Where the time to the first paint went: the page's own document and scripts through the
    // `papertie://` bridge, and the view's region of the board read from the app's server.
    steps: await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined
      const r = (n: number | undefined) => (n === undefined ? null : Math.round(n))
      const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      const scripts = res.filter((e) => e.initiatorType === 'script' || e.name.endsWith('.js'))
      return {
        responseStart: r(nav?.responseStart),
        responseEnd: r(nav?.responseEnd),
        domInteractive: r(nav?.domInteractive),
        domContentLoaded: r(nav?.domContentLoadedEventEnd),
        resources: res.length,
        scriptsEnd: r(Math.max(0, ...scripts.map((e) => e.responseEnd))),
        firstPaintRead: r(performance.getEntriesByName('papertie:first-paint-read')[0]?.startTime),
      }
    }),
    dpr: await page.evaluate(() => devicePixelRatio),
    view: await page.evaluate(() => ({ w: innerWidth, h: innerHeight })),
    documents: await documentsOf(page),
  }
}

/** The documents alive in the page's renderer (one: the page opened afresh). */
async function documentsOf(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page)
  try {
    return (await cdp.send('Memory.getDOMCounters')).documents
  } finally {
    await cdp.detach()
  }
}

test('desktop cold open at 100,000 notes (no caches), the camera at the hub', async () => {
  test.setTimeout(900_000)
  await quiet()
  const atStart = machine()
  const loads = []
  for (let i = 0; i < OPENS.cold; i++) {
    const dir = copyOf(coldTemplate, 'cold-open')
    loads.push(await openOnce(dir, traceArgs('cold', i)))
    rmSync(dir, { recursive: true, force: true })
  }
  const medianMs = median(loads.map((l) => l.firstPaintMs))
  record(
    'desktop cold open',
    atStart,
    {
      budget: BUDGET.cold,
      where:
        'the packaged app opened on a userData with the board and the camera kept, none of Chromium’s caches: from the window’s navigation start',
      medianMs,
      fromLaunchMedianMs: median(loads.map((l) => l.fromLaunchMs ?? Number.NaN)),
      loads,
    },
    [
      ...(medianMs <= LIMIT.coldMs ? [] : [`median ${medianMs} ms > ${LIMIT.coldMs} ms`]),
      ...loads.flatMap((l, i) =>
        l.long.length
          ? [`load ${i + 1}: long tasks after first paint ${JSON.stringify(l.long)}`]
          : [],
      ),
    ],
  )
})

test('desktop warm open at 100,000 notes: Papertie opened again', async () => {
  test.setTimeout(900_000)
  await quiet()
  const atStart = machine()
  const loads = []
  for (let i = 0; i < OPENS.warm; i++) loads.push(await openOnce(device, traceArgs('warm', i)))
  const medianMs = median(loads.map((l) => l.firstPaintMs))
  record(
    'desktop warm open',
    atStart,
    {
      budget: BUDGET.warm,
      where:
        'the packaged app quit and opened again on a device that has opened the board before (Chromium’s caches kept): from the window’s navigation start (fromLaunch: from the launch)',
      medianMs,
      fromLaunchMedianMs: median(loads.map((l) => l.fromLaunchMs ?? Number.NaN)),
      loads,
    },
    [
      ...(medianMs <= LIMIT.warmMs ? [] : [`median ${medianMs} ms > ${LIMIT.warmMs} ms`]),
      ...loads.flatMap((l, i) =>
        l.long.length
          ? [`load ${i + 1}: long tasks after first paint ${JSON.stringify(l.long)}`]
          : [],
      ),
    ],
  )
})

test('desktop warm open at 100,000 notes: the window opened again in the running app', async () => {
  test.setTimeout(900_000)
  const l = await start(device)
  await firstPaint(l.page)
  await opened(l.page)
  await l.page.waitForTimeout(2000)
  await quiet()
  const atStart = machine()
  const loads = []
  for (let i = 0; i < OPENS.warm; i++) loads.push(await measured(await reopenWindow(l), null))
  await quit(l)
  const medianMs = median(loads.map((l) => l.firstPaintMs))
  record(
    'desktop warm open, window',
    atStart,
    {
      budget: BUDGET.warm,
      where:
        'the window closed and opened again in the running packaged app (the Dock icon, `activate`), its server open: from the new window’s navigation start',
      medianMs,
      loads,
    },
    [
      ...(medianMs <= LIMIT.warmMs ? [] : [`median ${medianMs} ms > ${LIMIT.warmMs} ms`]),
      ...loads.flatMap((l, i) =>
        l.long.length
          ? [`load ${i + 1}: long tasks after first paint ${JSON.stringify(l.long)}`]
          : [],
      ),
    ],
  )
})

const gesture = (page: Page, kind: string, options?: object, ms?: number) =>
  page.evaluate(
    ([k, o, d]) =>
      window.__papertiePerf.runGesture(
        k as 'pan',
        d ?? undefined,
        (o ?? undefined) as Record<string, unknown> | undefined,
      ),
    [kind, options ?? null, ms ?? null] as const,
  )

const atHub = async (page: Page) => {
  expect(
    await page.evaluate(([id]) => window.__papertie.debug.focusCamera(id, 1), [hub.id] as const),
  ).toBe(true)
  await page.waitForFunction(() => window.__papertie.debug.lod() === 'full')
  await settle(page)
}

test('desktop board: pan and zoom at reading zoom, typing in a note, the 20-thread drag, the save ack', async () => {
  test.setTimeout(900_000)
  await quiet()
  const atStart = machine()
  const l = await start(device)
  const page = l.page
  await benchBoard(page)
  await page.waitForTimeout(1000)
  const floor = await floors(l.app)
  await page.bringToFront()

  // Pan and zoom at reading zoom at the hub, full detail: `canvas.bench.ts`'s reading rows.
  const READING_BAND = { zoomMin: LOD.lite.exitAtOrAbove + 0.02, zoomMax: 2 }
  await atHub(page)
  const pan = await gesture(page, 'pan')
  await atHub(page)
  const zoom = await gesture(page, 'zoom', READING_BAND)

  // Typing on a paper note in view (not the hub): the editor opened by a double-click.
  await atHub(page)
  const camAt = await page.evaluate(() => window.__papertie.debug.camera())
  const target = (
    await page.evaluate(
      ([ids, hubId]) =>
        ids.filter(
          (id) =>
            id !== hubId &&
            document.querySelector(`article.note[data-note-id="${id}"] .note-paper`) !== null &&
            document.querySelector(`article.note[data-note-id="${id}"] img`) === null,
        ),
      [inView, hub.id] as const,
    )
  )[0]
  if (target === undefined) throw new Error('no paper note in view')
  const p = await paperPoint(page, target)
  await page.mouse.dblclick(p.x, p.y)
  await expect(page.locator('[contenteditable]').first()).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  const typing = await tracedTyping(page, 'note', () => keysOf(page))
  await page.keyboard.press('Escape')

  // The hub's drag with its 20 threads, Alt held (a plain move).
  await atHub(page)
  const drag = await gesture(page, 'drag', { alt: true }, 3000)
  await page.waitForFunction(() => !window.__papertiePerf?.loopRunning())

  // Save ack: 200 single-op commits through the store, 100 ms apart; each `POST …/ops` from the
  // page's fetch to its answer's last byte.
  await page.evaluate(() => {
    const w = window as unknown as { __acks: number[] }
    w.__acks = []
    const orig = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase()
      const t = performance.now()
      const res = await orig(input, init)
      if (
        method === 'POST' &&
        /\/api\/boards\/[^/]+\/ops$/.test(new URL(url, location.href).pathname)
      )
        void res
          .clone()
          .arrayBuffer()
          .then(() => w.__acks.push(performance.now() - t))
      return res
    }
  })
  for (let i = 0; i < SAVES.count; i++) {
    await page.evaluate(
      ([id, i]) => {
        const store = window.__papertie.store as unknown as {
          getState(): { notes: Map<string, { x: number }> }
          commit(ops: unknown[]): void
        }
        const n = store.getState().notes.get(id)
        if (n) store.commit([{ op: 'note.update', id, set: { x: n.x + (i % 2 === 0 ? 1 : -1) } }])
      },
      [hub.id, i] as const,
    )
    await page.waitForTimeout(SAVES.spacingMs)
  }
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __acks: number[] }).__acks.length), {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(SAVES.count)
  const acks = await page.evaluate(() => (window as unknown as { __acks: number[] }).__acks)
  await quit(l)

  const frameFailures = (s: PerfSnapshot, minFps: number) => [
    ...(s.fps >= minFps ? [] : [`mean ${s.fps.toFixed(1)} fps < ${minFps}`]),
    ...(s.p95FrameMs <= floor.frames.p95FrameMs + P95_FLOOR_SLACK_MS
      ? []
      : [
          `p95 ${s.p95FrameMs.toFixed(2)} ms > blank window ${floor.frames.p95FrameMs.toFixed(2)} + ${P95_FLOOR_SLACK_MS} ms`,
        ]),
  ]
  const at = `the hub at reading zoom (1×), full detail, camera ${JSON.stringify(camAt)}`
  record(
    'desktop pan',
    atStart,
    { budget: BUDGET.fps, where: at, ...pan, floor: floor.frames },
    frameFailures(pan, LIMIT.readingFps),
  )
  record(
    'desktop zoom',
    atStart,
    {
      budget: BUDGET.fps,
      where: `${at}, zooming ${JSON.stringify(READING_BAND)}`,
      ...zoom,
      floor: floor.frames,
    },
    frameFailures(zoom, LIMIT.readingFps),
  )
  record(
    'desktop typing',
    atStart,
    {
      budget: BUDGET.typing,
      where: 'the app’s window (headed), a paper note in view at the hub, the whole board in',
      ...typing,
      blankWindowFloor: floor.keys,
    },
    [
      ...(typing.p95Ms <= LIMIT.typingP95Ms
        ? []
        : [`p95 ${typing.p95Ms} ms > ${LIMIT.typingP95Ms}`]),
      ...(typing.maxMs <= LIMIT.typingMaxMs
        ? []
        : [`max ${typing.maxMs} ms > ${LIMIT.typingMaxMs}`]),
    ],
  )
  record('desktop drag 20 threads', atStart, { budget: BUDGET.drag, ...drag }, [
    ...(drag.maxFrameMs < LIMIT.dragMaxFrameMs + VSYNC_SLACK_MS
      ? []
      : [`max frame ${drag.maxFrameMs.toFixed(1)} ms > ${LIMIT.dragMaxFrameMs}`]),
    ...(drag.fps >= LIMIT.readingFps
      ? []
      : [`mean ${drag.fps.toFixed(1)} fps < ${LIMIT.readingFps}`]),
  ])
  const saveAck = {
    batches: acks.length,
    p50Ms: percentile(acks, 0.5),
    p95Ms: percentile(acks, 0.95),
    maxMs: Math.max(...acks),
  }
  record(
    'desktop save ack',
    atStart,
    {
      budget: BUDGET.saveAck,
      where: 'the page’s fetch → protocol.handle → the in-process server',
      ...saveAck,
      acks,
    },
    saveAck.p95Ms < LIMIT.saveAckP95Ms
      ? []
      : [`p95 ${saveAck.p95Ms.toFixed(1)} ms ≥ ${LIMIT.saveAckP95Ms}`],
  )
})

/** The book's text on the page, counted (the open is over). */
async function bookShown(page: Page): Promise<void> {
  await expect(page.locator('.writer-body[data-shown] [data-id]').first()).toBeVisible({
    timeout: 120_000,
  })
  await expect(page.locator('.writer-count')).toBeVisible({ timeout: 120_000 })
}

/** The caret into the paragraph across the view's middle, `at` (0…1) of the way through the book. */
async function caretAt(page: Page, at: number): Promise<string> {
  await page.locator('.writer-scroll').evaluate((el, at) => {
    el.scrollTop = el.scrollHeight * at
  }, at)
  await page.waitForTimeout(600)
  const hit = await page.evaluate(() => {
    const view = (document.querySelector('.writer-scroll') as HTMLElement).getBoundingClientRect()
    const mid = (view.top + view.bottom) / 2
    const near = (p: HTMLElement) => {
      const r = p.getBoundingClientRect()
      if (r.bottom < view.top + 40 || r.top > view.bottom - 40) return Number.POSITIVE_INFINITY
      return Math.abs(
        (Math.max(r.top, view.top + 40) + Math.min(r.bottom, view.bottom - 40)) / 2 - mid,
      )
    }
    const ps = [...document.querySelectorAll<HTMLElement>('.writer .bk-book p.bk')]
    const el = ps.sort((a, b) => near(a) - near(b))[0]
    if (el === undefined || near(el) === Number.POSITIVE_INFINITY) return null
    const r = el.getBoundingClientRect()
    return { id: el.dataset.id as string, y: Math.max(r.top, view.top + 40) - r.top + 8 }
  })
  if (hit === null) throw new Error('no paragraph in view')
  await page.locator(`[data-id="${hit.id}"]`).click({ position: { x: 40, y: hit.y } })
  return hit.id
}

test('desktop book: typing in the 200,000-word book with the board under it', async () => {
  test.setTimeout(900_000)
  await quiet()
  const atStart = machine()
  const l = await start(device)
  const page = l.page
  await benchBoard(page, `/book/${seeded.bookId}?bench`)
  await page.mouse.move(VIEW.width * 0.6, VIEW.height * 0.45)
  await bookShown(page)
  await page.waitForTimeout(1000)
  const floor = await floors(l.app)
  await page.bringToFront()
  await caretAt(page, 0.5)
  const typing = await tracedTyping(page, 'book', () => keysOf(page))
  const { long } = await buffered(page)
  await quit(l)
  record(
    'desktop book typing',
    atStart,
    {
      budget: BUDGET.bookTyping,
      where:
        'the app’s window (headed), the book in the split beside the lifetime board, the caret halfway through',
      blocks: seeded.blockIds.length,
      ...typing,
      blankWindowFloor: floor.keys,
      longTasksInPage: long.length,
    },
    [
      ...(typing.p95Ms <= LIMIT.typingP95Ms
        ? []
        : [`p95 ${typing.p95Ms} ms > ${LIMIT.typingP95Ms}`]),
      ...(typing.maxMs <= LIMIT.typingMaxMs
        ? []
        : [`max ${typing.maxMs} ms > ${LIMIT.typingMaxMs}`]),
    ],
  )
})

/**
 * In the page Papertie opened with: when the place kept for the book is shown, in view and has
 * text, looked for every frame from the moment Playwright reaches the page (its first window
 * cannot be given an init script); then the frame after the next, which has been presented.
 * Read from navigation start.
 */
async function placeShown(page: Page): Promise<{ seen: number; framed: number; url: string }> {
  await page.waitForFunction(
    ([b, k]) => {
      const w = window as unknown as { __framed?: number; __seen?: number }
      if (w.__seen !== undefined) return w.__framed ?? null
      const places = JSON.parse(localStorage.getItem(`papertie.places.${b}`) ?? '{}') as Record<
        string,
        { blockId: string }
      >
      const id = places[k]?.blockId
      if (id === undefined) return null
      const el = document.querySelector(`.writer-body[data-shown] [data-id="${id}"]`)
      const sc = document.querySelector('.writer-scroll')
      if (el === null || sc === null || (el.textContent ?? '') === '') return null
      const r = el.getBoundingClientRect()
      const v = sc.getBoundingClientRect()
      if (!(r.bottom > v.top && r.top < v.bottom)) return null
      w.__seen = performance.now()
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          w.__framed = performance.now()
        }),
      )
      return null
    },
    [seeded.boardId, seeded.bookId] as const,
    { polling: 'raf', timeout: 120_000 },
  )
  return page.evaluate(() => {
    const w = window as unknown as { __framed: number; __seen: number }
    return { seen: w.__seen, framed: w.__framed, url: location.pathname }
  })
}

test('desktop book reopen: Papertie opened again into the book, at its place', async () => {
  test.setTimeout(900_000)
  // Used: opened, written in about two thirds through, kept (book and place).
  {
    const l = await start(device)
    await benchBoard(l.page, `/book/${seeded.bookId}?bench`)
    await bookShown(l.page)
    await caretAt(l.page, 0.66)
    await expect
      .poll(
        () =>
          l.page.evaluate(
            ([b, k]) =>
              (
                JSON.parse(localStorage.getItem(`papertie.places.${b}`) ?? '{}') as Record<
                  string,
                  unknown
                >
              )[k] !== undefined,
            [seeded.boardId, seeded.bookId] as const,
          ),
        { timeout: 60_000 },
      )
      .toBe(true)
    await l.page.waitForTimeout(6000)
    await quit(l)
  }
  await quiet()
  const atStart = machine()
  const opens = []
  for (let i = 0; i < OPENS.reopen; i++) {
    const l = await start(device, traceArgs('reopen', i))
    const at = await placeShown(l.page)
    const fromLaunch = await l.page.evaluate(() => performance.timeOrigin)
    await bookShown(l.page)
    await l.page.waitForTimeout(500)
    const { long } = await buffered(l.page)
    opens.push({
      ms: Math.round(at.framed),
      seenMs: Math.round(at.seen),
      fromLaunchMs: Math.round(fromLaunch + at.framed - l.launchedAt),
      url: at.url,
      long,
    })
    await quit(l)
  }
  const medianMs = median(opens.map((o) => o.ms))
  record(
    'desktop book reopen',
    atStart,
    {
      budget: BUDGET.reopen,
      where:
        'the packaged app quit and opened again; its window opens at the board and goes to the book: navigation start to the place shown and presented (fromLaunch: from the launch)',
      medianMs,
      fromLaunchMedianMs: median(opens.map((o) => o.fromLaunchMs)),
      opens,
    },
    [
      ...(medianMs <= LIMIT.bookOpenMs ? [] : [`median ${medianMs} ms > ${LIMIT.bookOpenMs} ms`]),
      ...opens.flatMap((o, i) =>
        o.url === `/book/${seeded.bookId}` ? [] : [`open ${i + 1}: landed on ${o.url}`],
      ),
    ],
  )

  // The window opened again in the running app.
  const l = await start(device)
  await placeShown(l.page)
  await bookShown(l.page)
  await l.page.waitForTimeout(2000)
  await quiet()
  const atStartWindow = machine()
  const windows = []
  for (let i = 0; i < OPENS.reopen; i++) {
    const page = await reopenWindow(l)
    const at = await placeShown(page)
    await bookShown(page)
    await page.waitForTimeout(500)
    const { long } = await buffered(page)
    windows.push({ ms: Math.round(at.framed), seenMs: Math.round(at.seen), url: at.url, long })
  }
  await quit(l)
  const windowMs = median(windows.map((o) => o.ms))
  record(
    'desktop book reopen, window',
    atStartWindow,
    {
      budget: BUDGET.reopen,
      where:
        'the window closed and opened again in the running packaged app (`activate`): navigation start to the place shown and presented',
      medianMs: windowMs,
      opens: windows,
    },
    [
      ...(windowMs <= LIMIT.bookOpenMs ? [] : [`median ${windowMs} ms > ${LIMIT.bookOpenMs} ms`]),
      ...windows.flatMap((o, i) =>
        o.url === `/book/${seeded.bookId}` ? [] : [`open ${i + 1}: landed on ${o.url}`],
      ),
    ],
  )
})
