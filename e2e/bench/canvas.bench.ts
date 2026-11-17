import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CDPSession, expect, type Page, test } from '@playwright/test'
import { ZOOM_MAX, ZOOM_MIN } from '../../apps/web/src/canvas/Camera'
import { LOD } from '../../apps/web/src/canvas/lod'
import { GESTURE } from '../../apps/web/src/perf/benchGestures'
import {
  type FrameGate,
  firstPaintMs,
  judgeFrames,
  judgeMemory,
  type MemorySample,
  median,
  NODE_TOLERANCE,
  P95_FLOOR_SLACK_MS,
  type PaintSample,
  styleWindows,
  WARMUP_LAPS,
} from '../../tools/src/benchJudge'
import {
  BENCH_SIZES,
  benchBoard,
  benchHubId,
  CLUSTERED_LIFETIME,
  WIDE_SIZE,
  wideBoard,
} from '../../tools/src/genBoard'
import type { Gesture, GestureOptions, PerfSnapshot } from '../hooks'
import { checkHygiene, hygieneLine, loadRun, type Machine, machine, RUN, repo, save } from './run'

/**
 * The targets. Never lower one: a miss is reported with the
 * measured value and its reason. The 500/500 pan's gate (mean ≥ 58 fps, p95 at the blank-page
 * floor) is inside `full60`.
 */
const TARGET = {
  /** 60 fps pan and zoom at 500/500 and 1000/1000, the p95 judged against the blank page. */
  full60: { minFps: 59.5, p95OverBaselineMs: P95_FLOOR_SLACK_MS },
  /** No frame over 50 ms while dragging a note with 20 threads (every bench hub has 20). */
  drag: { maxFrameMs: 50 },
  /** ≥ 55 fps on the 5,000 board in overview and in lite. */
  wide: { minFps: 55 },
  /** Fit-all and long zoom-outs are reported; one frame of a second or more is a stall. */
  stall: { maxFrameMs: 1000 },
  /** Demo board first paint on the production build, median of `coldLoads`. */
  firstPaintMs: 1000,
  coldLoads: 5,
  /** The heap after GC at the end of the 2-minute pan, above its start. */
  heapTolerance: 0.05,
  /** One remote `note.update` on the 1000 board, event to frame, p95 below this (ms). */
  remoteCommitP95Ms: 4,
  remoteCommits: 60,
  /** Entering focus at depth 2 on the 1000 board's hub, at 60 fps with no long stall. */
  focusEnter: { minFps: 59.5, maxFrameMs: 50 },
  focusEnters: 8,
  /** At 100,000 notes: the budgets, and their frame gates. */
  lifetimeReading: { minFps: 59.5, p95OverBaselineMs: P95_FLOOR_SLACK_MS },
  lifetimeFar: { minFps: 55 },
  lifetimeDrag: { minFps: 59.5, maxFrameMs: 50 },
  /**
   * No frame of a fit-all over 50 ms (ADR-0003 parked its 133 ms frame: the eased
   * fit's first frame in lite mounted ~450 notes of the lifetime grid at once).
   */
  fitAll: { maxFrameMs: 50 },
} as const satisfies Record<string, FrameGate | number>

/** The budget each 100,000-note row carries. */
const BUDGET_4B = {
  fps: '60 fps at reading zoom, and ≥ 55 fps far',
  drag: '60 fps at reading zoom, and ≥ 55 fps far; no frame over 50 ms dragging 20 threads',
} as const

const GESTURES: readonly Gesture[] = ['pan', 'zoom', 'drag']

/** Zoom bands that stay inside one level of detail, with room for the hysteresis. */
const LITE_BAND = { zoomMin: LOD.overview.enterBelow + 0.01, zoomMax: LOD.lite.enterBelow - 0.01 }
const OVERVIEW_BAND = { zoomMin: 0.025, zoomMax: LOD.overview.enterBelow - 0.03 }
/** The 5,000 board fits at about 0.021: a drifting pan would leave it, so it sweeps 240 px. */
const OVERVIEW_PAN: GestureOptions = { sweepSec: 1 }
/**
 * The 2-minute pan: a warm-up lap (`WARMUP_LAPS`), then four
 * 30 s laps measured, over the middle of the 1000 board, each sweeping 1,800 px down and back
 * twice. Before every memory sample the camera is put back exactly where it started, so each
 * sample mounts the same notes and the node counts compare like for like.
 */
const LONG_PAN = { laps: WARMUP_LAPS + 4, lapMs: 30_000, sweepSec: 7.5 }

type Lod = 'full' | 'lite' | 'overview'

interface Row extends PerfSnapshot {
  id: string
  board: string
  lod: Lod
  gesture: string
  gate: FrameGate
  failures: string[]
  /** For rows with no target of their own: the target that would apply, judged for information. */
  info?: { target: FrameGate; failures: string[] }
  /** The budget as worded where it was set. */
  budget?: string
}

/** Every file under `dir` whose name ends in one of `exts`. */
function files(dir: string, exts: readonly string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p, exts)
    return exts.some((e) => name.endsWith(e)) ? [p] : []
  })
}

/** A `data:` URL: the scheme then a media type (or nothing) up to the comma. */
const DATA_URL =
  /\bdata:(?:(?:image|font|application|text|audio|video)\/[\w.+-]+)?(?:;[\w.+=-]+)*,/i

const ms = (v: number) => v.toFixed(2).padStart(7)

function status(r: Row, valid: boolean): string {
  const info =
    r.info === undefined
      ? ''
      : r.info.failures.length === 0
        ? '  (info: would meet its target)'
        : `  (info: would miss: ${r.info.failures.join('; ')})`
  if (r.failures.length > 0) return `  MISS ${r.failures.join('; ')}${info}`
  return `${valid ? '  ok' : '  INVALID RUN (hygiene)'}${info}`
}

const fmt = (r: Row, valid: boolean) =>
  [
    r.id.padEnd(30),
    r.fps.toFixed(1).padStart(6),
    ms(r.p95FrameMs),
    ms(r.maxFrameMs),
    String(r.longFrames).padStart(5),
    String(r.frames).padStart(6),
    status(r, valid),
  ].join('  ')

const HEADER = `${'row'.padEnd(30)}     fps   p95 ms   max ms   long  frames`

/**
 * Judge rows, print them under the start-of-test hygiene line, save them with the machine at the
 * start and at the end, and fail softly on every missed target.
 */
function report(
  section: string,
  rows: Row[],
  extra: object,
  atStart: Machine,
  baseline?: PerfSnapshot,
): void {
  for (const r of rows) {
    r.failures = judgeFrames(r, r.gate, baseline)
    if (r.info !== undefined) r.info.failures = judgeFrames(r, r.info.target, baseline)
  }
  const v = atStart.valid
  console.log(['', hygieneLine(atStart), HEADER, ...rows.map((r) => fmt(r, v)), ''].join('\n'))
  save(section, { machine: atStart, machineAtEnd: machine(), ...extra, rows })
  for (const r of rows) {
    test.info().annotations.push({
      type: r.id,
      description: `${fmt(r, v).trim()}${r.budget ? `  [budget: ${r.budget}]` : ''}`,
    })
    expect.soft(r.failures, `${r.id}: targets`).toEqual([])
  }
}

// --- Page set-up. ---------------------------------------------------------------------------

async function open(page: Page, board: string, size: number): Promise<void> {
  await page.goto(`/bench?board=${board}&bench=1`)
  // A window behind another app gets irregular frames: keep it in front.
  await page.bringToFront()
  await page.waitForFunction(() => window.__papertie?.ready === true && !!window.__papertiePerf)
  expect(await page.evaluate(() => window.__papertie.store.getState().notes.size)).toBe(size)
}

/** Let the recull, the note mounts and their measured heights settle. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => !window.__papertiePerf.loopRunning())
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.waitForTimeout(300)
  await page.waitForFunction(() => !window.__papertiePerf.loopRunning())
}

const lodNow = (page: Page) => page.evaluate(() => window.__papertie.debug.lod())

/** Jump to note `id` at `zoom` and wait for level `lod`. */
async function focus(page: Page, id: string, zoom: number, lod: Lod): Promise<void> {
  expect(
    await page.evaluate(([n, z]) => window.__papertie.debug.focusCamera(n, z), [id, zoom] as const),
  ).toBe(true)
  await page.waitForFunction((l) => window.__papertie.debug.lod() === l, lod)
}

/** Jump to the middle of the board at `zoom` and wait for level `lod`. */
async function centre(page: Page, zoom: number, lod: Lod): Promise<void> {
  await page.evaluate((z) => {
    const m = window.__papertie
    const r = m.debug.notesRect()
    if (r === null) return
    const { innerWidth: w, innerHeight: h } = window
    m.debug.setCamera({ x: r.x + r.w / 2 - w / 2 / z, y: r.y + r.h / 2 - h / 2 / z, zoom: z })
  }, zoom)
  await page.waitForFunction((l) => window.__papertie.debug.lod() === l, lod)
}

/**
 * Come to `lod` from full detail: a jump straight from overview to lite's lowest zoom would stay
 * in overview (it is left only at ≥ 0.18).
 */
async function centreFromFull(page: Page, zoom: number, lod: Lod): Promise<void> {
  await centre(page, 1, 'full')
  await page.waitForFunction(() => !window.__papertiePerf.loopRunning())
  await centre(page, zoom, lod)
}

const gesture = (page: Page, kind: Gesture, options?: GestureOptions, durationMs?: number) =>
  page.evaluate(
    ([k, o, d]) => window.__papertiePerf.runGesture(k, d ?? undefined, o ?? undefined),
    [kind, options ?? null, durationMs ?? null] as const,
  )

/** A row measured at level `lod`, checked to have stayed there. */
async function row(
  page: Page,
  r: Omit<Row, keyof PerfSnapshot | 'failures'>,
  run: () => Promise<PerfSnapshot>,
  endLod: Lod = r.lod,
): Promise<Row> {
  expect(await lodNow(page), `${r.id}: level at start`).toBe(r.lod)
  const snap = await run()
  expect.soft(await lodNow(page), `${r.id}: level at end`).toBe(endLod)
  return { ...r, ...snap, failures: [] }
}

const metricsOf = async (cdp: CDPSession): Promise<Record<string, number>> =>
  Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value] as const),
  )

/**
 * The same 4 s of rAF intervals on a blank page that moves one div: the machine's own frame
 * timing, saved beside the results so a p95 at this floor reads as the platform, not the app.
 */
async function baseline(page: Page): Promise<PerfSnapshot> {
  await page.goto('about:blank')
  await page.bringToFront()
  await page.setContent('<div id="d" style="width:100px;height:100px;background:#b08a3a"></div>')
  return page.evaluate(
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
}

/** A trace's categories for a frame's whole pipeline: main thread, compositor, raster and GPU. */
const PIPELINE_TRACE = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'blink.user_timing',
  'disabled-by-default-v8.cpu_profiler',
  'v8',
  'disabled-by-default-v8.gc',
  'cc',
  'gpu',
  'viz',
  'benchmark',
]

/**
 * While tracing: a `t9c:long-frame` mark (detail: the interval) at each rAF that comes more than
 * 20 ms after the last, so a trace's slow frames can be found by their marks.
 */
const markLongFrames = (page: Page) =>
  page.evaluate(() => {
    let prev: number | null = null
    const tick = (t: number) => {
      if (prev !== null && t - prev > 20)
        performance.mark('t9c:long-frame', { detail: { ms: t - prev, at: t } })
      prev = t
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

// --- Rows. ----------------------------------------------------------------------------------

test('the production build inlines no data: URLs (fonts and textures stay files from self)', () => {
  const dist = join(repo(), 'apps/web/dist')
  const found = files(dist, ['.css', '.js', '.html'])
    .filter((f) => DATA_URL.test(readFileSync(f, 'utf8')))
    .map((f) => f.slice(dist.length + 1))
  expect(DATA_URL.test('url(data:image/svg+xml;base64,PHN2Zy8+)')).toBe(true)
  expect(DATA_URL.test('src:url("data:font/woff2;base64,d09G")')).toBe(true)
  expect(DATA_URL.test('{pending:!1,data:null,method:null}')).toBe(false)
  expect(files(dist, ['.html']).length).toBeGreaterThan(0)
  expect(found).toEqual([])
})

test('panning the whole 500 board in lite keeps its notes in one compositor layer', async ({
  page,
}) => {
  await open(page, '500', 500)
  // Fit-all now lands in overview (no DOM notes): centre the board at lite's lowest zoom instead,
  // where the cull rect still mounts all 500.
  await centre(page, LOD.overview.exitAtOrAbove, 'lite')
  await page.waitForFunction(() => !window.__papertiePerf.loopRunning())
  expect(await page.evaluate(() => document.querySelectorAll('article.note').length)).toBe(500)
  const cdp = await page.context().newCDPSession(page)
  let layers = 0
  cdp.on('LayerTree.layerTreeDidChange', (e) => {
    if (e.layers) layers = Math.max(layers, e.layers.length)
  })
  await cdp.send('LayerTree.enable')
  const pan = gesture(page, 'pan', undefined, 600)
  await page.waitForFunction(() => window.__papertie.runtime.camera.moving)
  await page.waitForTimeout(400)
  await pan
  // Without the world's backdrop, a moving world gave every scattered note its own layer (~500).
  expect(layers).toBeGreaterThan(0)
  expect(layers).toBeLessThan(40)
})

test('full detail on the 100/500/1000 boards: pan, zoom, drag of the 20-thread hub, and the blank-page baseline', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000)
  const atStart = machine()
  checkHygiene(atStart)
  const trace = process.env.BENCH_TRACE === '1'
  if (trace) mkdirSync(join(repo(), 'e2e/bench/results'), { recursive: true })
  const rows: Row[] = []
  for (const size of BENCH_SIZES) {
    const hub = benchHubId(benchBoard(size))
    for (const g of GESTURES) {
      await open(page, String(size), size)
      await focus(page, hub, 1, 'full')
      await settle(page)
      const traced = trace && size === 500 && g === 'pan'
      if (traced) await browser.startTracing(page, { screenshots: false })
      // BENCH_TRACE=zoom1000: the 1000 board's zoom row, traced, its slow frames marked.
      const tracedZoom = process.env.BENCH_TRACE === 'zoom1000' && size === 1000 && g === 'zoom'
      if (tracedZoom) {
        await browser.startTracing(page, { categories: PIPELINE_TRACE })
        await markLongFrames(page)
      }
      const gate = g === 'drag' ? TARGET.drag : size === 100 ? {} : TARGET.full60
      // The zoom gesture swings 0.25..2, through lite and back.
      rows.push(
        await row(
          page,
          { id: `${size} ${g}`, board: String(size), lod: 'full', gesture: g, gate },
          () => gesture(page, g),
        ),
      )
      if (traced)
        writeFileSync(
          join(repo(), 'e2e/bench/results', `${RUN}-trace-500-pan.json`),
          await browser.stopTracing(),
        )
      if (tracedZoom) {
        mkdirSync(join(repo(), 'e2e/artifacts/traces'), { recursive: true })
        writeFileSync(
          join(repo(), 'e2e/artifacts/traces', '1000-zoom.json'),
          await browser.stopTracing(),
        )
      }
    }
  }
  const atBaseline = machine()
  const floor = await baseline(page)
  save('baseline', { machine: atBaseline, ...floor })
  console.log(
    `blank page (no app): ${floor.fps.toFixed(1)} fps, p95 ${floor.p95FrameMs.toFixed(2)} ms, max ${floor.maxFrameMs.toFixed(2)} ms, ${floor.longFrames} long, ${floor.frames} frames`,
  )
  report('full', rows, {}, atStart, floor)
  for (const r of rows) expect(r.frames, `${r.id}: recorded frames`).toBeGreaterThan(100)
})

test('the 5,000 board in overview and in lite: pan, zoom, drag of the 20-thread hub', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const atStart = machine()
  checkHygiene(atStart)
  const hub = benchHubId(wideBoard())
  const board = String(WIDE_SIZE)
  const dragGate = { ...TARGET.wide, ...TARGET.drag }
  const rows: Row[] = []
  const base = (lod: Lod, g: Gesture) => ({
    id: `${board} ${lod} ${g}`,
    board,
    lod,
    gesture: g,
    gate: g === 'drag' ? dragGate : TARGET.wide,
  })

  // Overview at fit-all (the first camera): all 5,000 cards drawn. The hub is note 0, at the
  // board's corner (by the sidebar at fit), so the drag centres it at the same zoom and presses
  // its card through `noteAt`: overview mounts no DOM notes.
  for (const g of GESTURES) {
    await open(page, board, WIDE_SIZE)
    if (g === 'drag') {
      const fit = await page.evaluate(() => window.__papertie.debug.camera().zoom)
      await focus(page, hub, fit, 'overview')
    }
    await settle(page)
    const options = g === 'pan' ? OVERVIEW_PAN : g === 'zoom' ? OVERVIEW_BAND : undefined
    rows.push(await row(page, base('overview', g), () => gesture(page, g, options)))
  }
  // Lite at its lowest zoom: the most DOM notes lite mounts on this board.
  for (const g of GESTURES) {
    await open(page, board, WIDE_SIZE)
    if (g === 'drag') {
      await focus(page, hub, 1, 'full')
      await page.waitForFunction(() => !window.__papertiePerf.loopRunning())
      await focus(page, hub, LITE_BAND.zoomMin, 'lite')
    } else await centreFromFull(page, LITE_BAND.zoomMin, 'lite')
    await settle(page)
    const mounted = await page.evaluate(() => document.querySelectorAll('article.note').length)
    test.info().annotations.push({
      type: `${board} lite ${g}`,
      description: `${mounted} notes mounted at start`,
    })
    rows.push(
      await row(page, base('lite', g), () =>
        gesture(page, g, g === 'zoom' ? LITE_BAND : undefined),
      ),
    )
  }
  report(
    'wide',
    rows,
    {
      hub,
      liteBand: LITE_BAND,
      overviewBand: OVERVIEW_BAND,
      overviewPan: OVERVIEW_PAN,
    },
    atStart,
  )
  for (const r of rows) expect(r.frames, `${r.id}: recorded frames`).toBeGreaterThan(100)
})

test('jumps into lite and overview: Shift+1 fit-all from zoom 1 on the 5,000 board, long zoom-outs from 2', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const atStart = machine()
  checkHygiene(atStart)
  const rows: Row[] = []
  const board = String(WIDE_SIZE)
  // No target of their own: the target of the level and board they end in is judged for
  // information (the gated 1000 zoom row covers only 0.25–2 of this zoom range).
  const saved = loadRun().baseline as PerfSnapshot | undefined

  // Fit-all eases from full detail through lite into overview (50–167 ms frames were seen in
  // dev). Frames are recorded from the key press until the camera has settled.
  await open(page, board, WIDE_SIZE)
  await focus(page, benchHubId(wideBoard()), 1, 'full')
  await settle(page)
  rows.push(
    await row(
      page,
      {
        id: `${board} fit-all from 1`,
        board,
        lod: 'full',
        gesture: 'Shift+1',
        gate: { ...TARGET.stall, ...TARGET.fitAll },
        info: { target: TARGET.wide, failures: [] },
      },
      async () => {
        await page.evaluate(() => window.__papertiePerf.record())
        await page.keyboard.press('Shift+Digit1')
        await page.waitForFunction(
          () =>
            window.__papertie.debug.lod() === 'overview' && !window.__papertiePerf.loopRunning(),
          undefined,
          { timeout: 60_000 },
        )
        await page.waitForTimeout(300)
        return page.evaluate(() => window.__papertiePerf.stop())
      },
      'overview',
    ),
  )

  // A long ctrl-wheel zoom-out from the closest zoom (2×) to lite's
  // lowest zoom: the world keeps its raster scale while it moves, the risk behind the 22 s
  // overview stall once seen there.
  for (const size of [WIDE_SIZE, 1000] as const) {
    await open(page, String(size), size)
    await centre(page, ZOOM_MAX, 'full')
    await settle(page)
    rows.push(
      await row(
        page,
        {
          id: `${size} zoom-out ${ZOOM_MAX} → ${LITE_BAND.zoomMin.toFixed(2)}`,
          board: String(size),
          lod: 'full',
          gesture: 'zoom-out',
          gate: TARGET.stall,
          info: { target: size === WIDE_SIZE ? TARGET.wide : TARGET.full60, failures: [] },
        },
        async () => {
          // BENCH_TRACE=zoomout: a Chrome trace of the 1000 board's zoom-out, kept in
          // e2e/artifacts/traces (its one 50 ms frame).
          const trace = process.env.BENCH_TRACE === 'zoomout' && size === 1000
          const browser = page.context().browser()
          if (trace && browser !== null)
            await browser.startTracing(page, {
              categories: [
                'devtools.timeline',
                'disabled-by-default-devtools.timeline',
                'disabled-by-default-devtools.timeline.frame',
                'blink.user_timing',
                'disabled-by-default-v8.cpu_profiler',
                'v8',
                'disabled-by-default-v8.gc',
                'cc',
                'gpu',
                'viz',
              ],
            })
          const snap = await page.evaluate(
            (z) => window.__papertiePerf.zoomTo(z),
            LITE_BAND.zoomMin,
          )
          if (trace && browser !== null) {
            const dir = join(repo(), 'e2e/artifacts/traces')
            mkdirSync(dir, { recursive: true })
            writeFileSync(join(dir, '1000-zoom-out.json'), await browser.stopTracing())
          }
          return snap
        },
        'lite',
      ),
    )
  }
  report('jumps', rows, { baselineForInfo: saved ?? null }, atStart, saved)
  for (const r of rows) {
    expect(r.frames, `${r.id}: recorded frames`).toBeGreaterThan(10)
    if (r.maxFrameMs > TARGET.drag.maxFrameMs)
      test.info().annotations.push({
        type: 'warning',
        description: `${r.id}: max frame ${r.maxFrameMs.toFixed(1)} ms`,
      })
  }
})

test('the lifetime grid board: Shift+1 fit-all from reading zoom, no frame over 50 ms', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const atStart = machine()
  checkHygiene(atStart)
  // genBoard's grid of 100,000 notes: the eased fit's first frame lands in lite over about 450
  // of them (ADR-0003's parked 133 ms frame).
  const board = 'lifetime'
  await open(page, board, 100_000)
  await page.waitForFunction(
    () =>
      (window.__papertie.debug as unknown as { pyramid(): PyramidState | null }).pyramid()
        ?.ready === true,
    undefined,
    { timeout: 120_000 },
  )
  const middle = await page.evaluate(
    () => [...window.__papertie.store.getState().notes.keys()][50_000],
  )
  await focus(page, middle as string, 1, 'full')
  await settle(page)
  const rows: Row[] = [
    await row(
      page,
      {
        id: 'grid 100k fit-all from 1',
        board,
        lod: 'full',
        gesture: 'Shift+1',
        gate: { ...TARGET.lifetimeFar, ...TARGET.stall, ...TARGET.fitAll },
        budget: BUDGET_4B.fps,
      },
      async () => {
        await page.evaluate(() => window.__papertiePerf.record())
        await page.keyboard.press('Shift+Digit1')
        await page.waitForFunction(
          () =>
            window.__papertie.debug.lod() === 'overview' && !window.__papertiePerf.loopRunning(),
          undefined,
          { timeout: 60_000 },
        )
        await page.waitForTimeout(300)
        return page.evaluate(() => window.__papertiePerf.stop())
      },
      'overview',
    ),
  ]
  report('grid fit-all', rows, { budgets: BUDGET_4B }, atStart)
  for (const r of rows) expect(r.frames, `${r.id}: recorded frames`).toBeGreaterThan(10)
})

/**
 * Runs in the page before any of its scripts: one sample per rAF of what is painted, until the
 * frame after the first one with everything (`firstPaintMs`). Cork and paper assets count as
 * loaded when Resource Timing has an entry for every url() the cork layers and the mounted notes
 * use (their ::before and ::after included), and every note image is complete.
 */
function paintProbe(): void {
  performance.setResourceTimingBufferSize(4000)
  const w = window as unknown as { __paint: PaintSample[]; __paintDone: boolean; __fontsAt: number }
  const samples: PaintSample[] = []
  w.__paint = samples
  w.__paintDone = false
  document.fonts.ready.then(() => {
    w.__fontsAt = performance.now()
  })
  const PROPS = [
    'background-image',
    'mask-image',
    '-webkit-mask-image',
    '-webkit-mask-box-image-source',
  ]
  const urlsOf = (): string[] => {
    const els = document.querySelectorAll('.cork, .cork *, article.note, article.note *')
    const found = new Set<string>()
    for (const el of els) {
      // The fibre fibre texture lives on ::after (note.css): read the pseudo-elements too.
      for (const pseudo of [null, '::before', '::after']) {
        const cs = getComputedStyle(el, pseudo)
        for (const p of PROPS)
          for (const m of cs.getPropertyValue(p).matchAll(/url\("?([^")]+)"?\)/g))
            if (m[1] !== undefined) found.add(m[1])
      }
    }
    return [...found]
  }
  let urls: string[] | null = null
  let at = -1
  const tick = (t: number) => {
    const h = window.__papertie
    const ready = h?.ready === true
    const notes = document.querySelector('article.note') !== null
    const stats = ready ? h.debug.stats() : undefined
    const yarn = stats !== undefined && stats.segmentsStatic + stats.segmentsDynamic > 0
    let assets = false
    if (ready && notes && yarn) {
      urls ??= urlsOf()
      assets =
        urls.every((u) => performance.getEntriesByName(u).length > 0) &&
        [...document.querySelectorAll<HTMLImageElement>('article.note img')].every(
          (i) => i.complete,
        )
    }
    samples.push({ t, ready, notes, yarn, assets })
    if (at < 0 && ready && notes && yarn && assets) at = samples.length
    else if (at >= 0) {
      w.__paintDone = true
      return
    }
    if (samples.length < 3000) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

test(`demo board first paint: median of ${TARGET.coldLoads} cold loads of the production build`, async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const atStart = machine()
  checkHygiene(atStart)
  const loads: {
    firstPaintMs: number | null
    readyMs: number | null
    fontsMs: number | null
    frames: number
    /** The probe never saw everything painted within the wait. */
    timedOut: boolean
    /** What the last sample still lacked: ready, notes, yarn or assets. */
    missing: string[]
  }[] = []
  for (let i = 0; i < TARGET.coldLoads; i++) {
    // A new context has an empty HTTP cache: a cold load.
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport: { width: 1200, height: 720 },
      deviceScaleFactor: 2,
    })
    const page = await context.newPage()
    await page.addInitScript(paintProbe)
    await page.goto('/bench?bench=1')
    await page.bringToFront()
    let timedOut = false
    try {
      await page.waitForFunction(
        () => (window as unknown as { __paintDone: boolean }).__paintDone,
        undefined,
        { timeout: 30_000 },
      )
    } catch {
      // A stuck load is a result (null, with what it lacked), not the end of the row.
      timedOut = true
    }
    const { samples, fontsAt } = await page.evaluate(() => {
      const w = window as unknown as { __paint?: PaintSample[]; __fontsAt?: number }
      return { samples: w.__paint ?? [], fontsAt: w.__fontsAt ?? null }
    })
    const last = samples.at(-1)
    const missing =
      last === undefined
        ? ['ready', 'notes', 'yarn', 'assets']
        : (['ready', 'notes', 'yarn', 'assets'] as const).filter((k) => !last[k])
    loads.push({
      firstPaintMs: timedOut ? null : firstPaintMs(samples),
      readyMs: samples.find((s) => s.ready)?.t ?? null,
      fontsMs: fontsAt,
      frames: samples.length,
      timedOut,
      missing: timedOut ? missing : [],
    })
    await context.close()
  }
  const paints = loads.map((l) => l.firstPaintMs).filter((v): v is number => v !== null)
  const medianMs = median(paints)
  const failures = [
    ...(paints.length < loads.length
      ? [
          `${loads.length - paints.length} loads never painted (missing: ${loads
            .filter((l) => l.firstPaintMs === null)
            .map((l) => l.missing.join('+') || 'unknown')
            .join(', ')})`,
        ]
      : []),
    ...(medianMs < TARGET.firstPaintMs
      ? []
      : [`median ${medianMs.toFixed(0)} ms ≥ ${TARGET.firstPaintMs} ms`]),
  ]
  const line = `${hygieneLine(atStart)}\ndemo first paint: median ${medianMs.toFixed(0)} ms over ${paints.length} loads (${paints.map((v) => v.toFixed(0)).join(', ')})${atStart.valid ? '' : ' INVALID RUN (hygiene)'}`
  console.log(line)
  test.info().annotations.push({ type: 'first paint', description: line })
  save('firstPaint', {
    machine: atStart,
    machineAtEnd: machine(),
    definition:
      'navigation start to the rAF after the first one with hooks ready (that includes loading the perf-hooks chunk, which users never load), a note mounted, yarn drawn, and the cork and paper url()s (::before and ::after included) and note images loaded',
    budget: `demo board first paint ≤ ${TARGET.firstPaintMs} ms (median of ${TARGET.coldLoads} cold loads)`,
    targetMs: TARGET.firstPaintMs,
    medianMs,
    loads,
    failures,
  })
  expect.soft(failures, 'first paint: targets').toEqual([])
})

test('pointer pan start and end on the 1000 board: style recalc of the hover selectors', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const atStart = machine()
  checkHygiene(atStart)
  // note.css hover rules hang on the root's data-panning / data-space: a pointer pan toggles
  // them at its start and end, restyling every mounted note. A wheel pan does
  // not toggle them, so this row grabs the board with the middle button.
  const out: object[] = []
  const rows: Row[] = []
  for (const [lod, zoom] of [
    ['full', 1],
    ['lite', LOD.overview.exitAtOrAbove],
  ] as const) {
    await open(page, '1000', 1000)
    if (lod === 'full') await centre(page, zoom, lod)
    else await centreFromFull(page, zoom, lod)
    await settle(page)
    const mounted = await page.evaluate(() => document.querySelectorAll('article.note').length)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const panning = (on: boolean) =>
      page.waitForFunction(
        (o) => document.querySelector('[data-testid="canvas"]')?.hasAttribute('data-panning') === o,
        on,
      )
    const m0 = await metricsOf(cdp)
    // Held at the end, so m2 is taken while still panning and the end restyle falls in m2..m3.
    const run = gesture(page, 'grab', { hold: true }, 2000)
    await panning(true)
    await page.waitForTimeout(250)
    const m1 = await metricsOf(cdp)
    const snap = await run
    const m2 = await metricsOf(cdp)
    // The pointerup, then two frames: the restyle for the ended pan has run.
    await page.evaluate(() => window.__papertiePerf.release())
    await panning(false)
    await page.waitForFunction(() => !window.__papertiePerf.loopRunning())
    await page.waitForTimeout(300)
    const m3 = await metricsOf(cdp)
    await cdp.detach()
    const w = styleWindows(m0, m1, m2, m3)
    rows.push({
      id: `1000 ${lod} grab`,
      board: '1000',
      lod,
      gesture: 'grab',
      gate: {},
      ...snap,
      failures: [],
    })
    out.push({ lod, zoom, mounted, ...w })
    const line = `1000 ${lod} (${mounted} notes): pan start ${w.start.recalcCount} recalcs ${w.start.recalcMs.toFixed(1)} ms (excess ${w.startExcessMs.toFixed(1)}), end ${w.end.recalcCount} / ${w.end.recalcMs.toFixed(1)} ms (excess ${w.endExcessMs.toFixed(1)}), steady ${w.steady.recalcMs.toFixed(1)} ms over ${w.steady.seconds.toFixed(2)} s`
    console.log(line)
    test.info().annotations.push({ type: 'style recalc', description: line })
  }
  // A watch row: reported for the later run to judge, with no target of its own.
  report('styleRecalc', rows, { windows: out }, atStart)
})

/** Nearest-rank percentile of `values`. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(p * sorted.length) - 1] ?? 0
}

/** One row of several recordings: frames pooled, the worst p95 and max kept. */
function pooled(snaps: readonly PerfSnapshot[]): PerfSnapshot {
  const frames = snaps.reduce((n, s) => n + s.frames, 0)
  const ms = snaps.reduce((t, s) => t + (s.fps > 0 ? (s.frames * 1000) / s.fps : 0), 0)
  return {
    fps: ms > 0 ? (frames * 1000) / ms : 0,
    p95FrameMs: Math.max(0, ...snaps.map((s) => s.p95FrameMs)),
    maxFrameMs: Math.max(0, ...snaps.map((s) => s.maxFrameMs)),
    longFrames: snaps.reduce((n, s) => n + s.longFrames, 0),
    frames,
  }
}

test('the 1000 board: a remote commit applied, and focus entered and left at depth 2', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const atStart = machine()
  checkHygiene(atStart)
  const hub = benchHubId(benchBoard(1000))
  await open(page, '1000', 1000)
  await focus(page, hub, 1, 'full')
  await settle(page)

  // A remote edit of the hub's text (its 20 threads hang from it), as an SSE commit would bring
  // it: main-thread ms from the event to the end of the frame that draws it.
  const costs: { eventMs: number; frameMs: number }[] = []
  // BENCH_TRACE=remote: a Chrome trace of the remote commits, in e2e/artifacts/traces.
  const traceRemote = process.env.BENCH_TRACE === 'remote' ? page.context().browser() : null
  if (traceRemote !== null)
    await traceRemote.startTracing(page, {
      categories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'blink.user_timing',
        'disabled-by-default-v8.cpu_profiler',
        'v8',
      ],
    })
  for (let i = 0; i < TARGET.remoteCommits; i++) {
    costs.push(
      await page.evaluate(
        ([id, i]) =>
          window.__papertiePerf.remoteCommit([
            { op: 'note.update', id, set: { text: `Remote edit ${i % 2 === 0 ? 'one' : 'two'}` } },
          ]),
        [hub, i] as const,
      ),
    )
    await page.waitForFunction(() => !window.__papertiePerf.loopRunning())
  }
  if (traceRemote !== null) {
    const dir = join(repo(), 'e2e/artifacts/traces')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'remote-commit.json'), await traceRemote.stopTracing())
  }
  const totals = costs.map((c) => c.eventMs + c.frameMs)
  const remote = {
    samples: costs.length,
    p50Ms: percentile(totals, 0.5),
    p95Ms: percentile(totals, 0.95),
    maxMs: Math.max(...totals),
    eventP95Ms: percentile(
      costs.map((c) => c.eventMs),
      0.95,
    ),
    frameP95Ms: percentile(
      costs.map((c) => c.frameMs),
      0.95,
    ),
    targetP95Ms: TARGET.remoteCommitP95Ms,
  }
  const remoteMiss =
    remote.p95Ms < TARGET.remoteCommitP95Ms
      ? []
      : [`p95 ${remote.p95Ms.toFixed(2)} ms ≥ ${TARGET.remoteCommitP95Ms} ms`]
  const remoteLine = `remote commit apply (1000, one note.update on the hub): p50 ${remote.p50Ms.toFixed(2)} ms, p95 ${remote.p95Ms.toFixed(2)} ms (event ${remote.eventP95Ms.toFixed(2)}, frame ${remote.frameP95Ms.toFixed(2)}), max ${remote.maxMs.toFixed(2)} ms over ${remote.samples}${remoteMiss.length > 0 ? `  MISS ${remoteMiss.join('; ')}` : atStart.valid ? '  ok' : '  INVALID RUN (hygiene)'}`
  console.log(remoteLine)
  test.info().annotations.push({ type: 'remote commit apply', description: remoteLine })

  // Focus on the hub at depth 2 (its 20 threads and their notes), from the whole board: every
  // frame from the call until the fade and the camera have settled, over several entries.
  const enters: PerfSnapshot[] = []
  const exits: PerfSnapshot[] = []
  // BENCH_TRACE=focus: a Chrome trace of the entries and exits, in e2e/artifacts/traces.
  const traceFocus = process.env.BENCH_TRACE === 'focus' ? page.context().browser() : null
  if (traceFocus !== null) {
    await traceFocus.startTracing(page, { categories: PIPELINE_TRACE })
    await markLongFrames(page)
  }
  for (let i = 0; i < TARGET.focusEnters; i++) {
    enters.push(
      await page.evaluate(async (id) => {
        const perf = window.__papertiePerf
        const rt = window.__papertie.runtime
        perf.record()
        rt.setFocus({ seeds: [id], depth: 2, include: [] })
        await new Promise<void>((resolve) => {
          const done = () =>
            !perf.loopRunning() && rt.focusPaint?.fade == null && !rt.camera.moving
              ? resolve()
              : requestAnimationFrame(done)
          requestAnimationFrame(done)
        })
        return perf.stop()
      }, hub),
    )
    expect(await page.evaluate(() => window.__papertie.runtime.focusState?.depth)).toBe(2)
    await settle(page)
    // And left again, every frame until the fade and the camera
    // have settled.
    exits.push(
      await page.evaluate(async () => {
        const perf = window.__papertiePerf
        const rt = window.__papertie.runtime
        perf.record()
        rt.setFocus(null)
        await new Promise<void>((resolve) => {
          const done = () =>
            !perf.loopRunning() && rt.focusPaint?.fade == null && !rt.camera.moving
              ? resolve()
              : requestAnimationFrame(done)
          requestAnimationFrame(done)
        })
        return perf.stop()
      }),
    )
    expect(await page.evaluate(() => window.__papertie.runtime.focusState)).toBeNull()
    await focus(page, hub, 1, 'full')
    await settle(page)
  }
  if (traceFocus !== null) {
    const dir = join(repo(), 'e2e/artifacts/traces')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '1000-focus.json'), await traceFocus.stopTracing())
  }
  const rows: Row[] = [
    {
      id: '1000 focus enter at depth 2',
      board: '1000',
      lod: 'full',
      gesture: 'focus',
      gate: TARGET.focusEnter,
      ...pooled(enters),
      failures: [],
    },
    {
      id: '1000 focus exit from depth 2',
      board: '1000',
      lod: 'full',
      gesture: 'focus',
      gate: TARGET.focusEnter,
      budget: 'focus enter and exit at depth 2, 1000 board: 60 fps, no frame over 50 ms',
      ...pooled(exits),
      failures: [],
    },
  ]
  save('phase4Remote', {
    machine: atStart,
    budget: `remote note.update apply p95 < ${TARGET.remoteCommitP95Ms} ms (1000 board)`,
    ...remote,
    costs,
    failures: remoteMiss,
  })
  report('phase4', rows, { enters, exits, focusEnters: TARGET.focusEnters }, atStart)
  expect.soft(remoteMiss, 'remote commit apply: targets').toEqual([])
  expect(rows[0]?.frames, 'focus enter: recorded frames').toBeGreaterThan(10)
  expect(rows[1]?.frames, 'focus exit: recorded frames').toBeGreaterThan(10)
})

/** Watch the main thread's long tasks (over 50 ms) from now; {@link takeLongTasks} reads them. */
const watchLongTasks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __long: number[] }
    w.__long = []
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__long.push(Math.round(e.duration))
    }).observe({ type: 'longtask' })
  })
const takeLongTasks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __long?: number[] }).__long?.splice(0) ?? [])

/** The far-zoom pyramid's state, as the debug hooks report it (canvas-pyramid.spec). */
interface PyramidState {
  ready: boolean
  on: boolean
  inFlight: number
  last: { fallback: number; missing: number; patched: number } | null
}

const pyramidOf = (page: Page) =>
  page.evaluate(() =>
    (window.__papertie.debug as unknown as { pyramid(): PyramidState | null }).pyramid(),
  )

/** The pyramid draws the view from its own level's tiles, all fresh, and nothing moves. */
async function pyramidSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const p = (window.__papertie.debug as unknown as { pyramid(): PyramidState | null }).pyramid()
      const l = p?.last
      return (
        p?.on === true &&
        p.inFlight === 0 &&
        l != null &&
        l.fallback === 0 &&
        l.missing === 0 &&
        l.patched === 0
      )
    },
    undefined,
    { timeout: 60_000, polling: 100 },
  )
  await page.waitForFunction(() => !window.__papertiePerf.loopRunning())
}

test('the lifetime board at 100,000 notes in clusters: reading, lite and pyramid zoom, fit-all, drag with 20 threads', async ({
  page,
}) => {
  test.setTimeout(600_000)
  const atStart = machine()
  checkHygiene(atStart)
  const board = 'clusters'
  const size = CLUSTERED_LIFETIME.notes
  // The bench hub, note 0 of the first cluster: on 20 threads.
  const hub = await (async () => {
    await open(page, board, size)
    return page.evaluate(() => {
      let best = ''
      let most = -1
      const count = new Map<string, number>()
      for (const y of window.__papertie.store.getState().yarns.values())
        for (const id of y.noteIds) count.set(id, (count.get(id) ?? 0) + 1)
      for (const [id, n] of count) if (n > most || (n === most && id < best)) [best, most] = [id, n]
      return best
    })
  })()
  const rows: Row[] = []
  const base = (lod: Lod, g: string, gate: FrameGate, id = `100k ${lod} ${g}`) => ({
    id,
    board,
    lod,
    gesture: g,
    gate,
    budget: g === 'drag' ? BUDGET_4B.drag : BUDGET_4B.fps,
  })

  // Reading zoom (1×, full detail) at the hub: pan, a zoom that stays in full (0.4-2), and the
  // drag of the hub with its 20 threads. The drag holds Alt: a plain move, as the row
  // measures it. In a cluster this dense the drag's circle passes beside notes, and without Alt
  // a merge bridge forms: that drag is a row of its own, with the main thread's long tasks from
  // the press on (the frames are recorded only after the warm-up).
  const READING_BAND = { zoomMin: LOD.lite.exitAtOrAbove + 0.02, zoomMax: ZOOM_MAX }
  const longTasks: Record<string, number[]> = {}
  for (const g of [...GESTURES, 'drag beside notes'] as const) {
    await open(page, board, size)
    await focus(page, hub, 1, 'full')
    await settle(page)
    const drag = g === 'drag' || g === 'drag beside notes'
    const gate = drag ? TARGET.lifetimeDrag : TARGET.lifetimeReading
    const options: GestureOptions | undefined =
      g === 'zoom' ? READING_BAND : g === 'drag' ? { alt: true } : undefined
    await watchLongTasks(page)
    rows.push(
      await row(
        page,
        g === 'drag beside notes'
          ? {
              ...base('full', 'drag', {}, '100k full drag beside notes (no Alt)'),
              info: { target: gate, failures: [] },
            }
          : base('full', g, gate),
        () => gesture(page, drag ? 'drag' : g, options),
      ),
    )
    longTasks[rows.at(-1)?.id ?? g] = await takeLongTasks(page)
  }

  // Lite at its lowest zoom, at the hub's cluster: the most DOM notes lite mounts there.
  for (const g of ['pan', 'zoom'] as const) {
    await open(page, board, size)
    await focus(page, hub, 1, 'full')
    await page.waitForFunction(() => !window.__papertiePerf.loopRunning())
    await focus(page, hub, LITE_BAND.zoomMin, 'lite')
    await settle(page)
    const mounted = await page.evaluate(() => document.querySelectorAll('article.note').length)
    test.info().annotations.push({ type: `100k lite ${g}`, description: `${mounted} mounted` })
    rows.push(
      await row(page, base('lite', g, TARGET.lifetimeFar), () =>
        gesture(page, g, g === 'zoom' ? LITE_BAND : undefined),
      ),
    )
  }

  // Far out, drawn from the picture pyramid: at 0.03 over the hub's cluster, and at fit-all
  // (about 0.006: the whole board).
  await open(page, board, size)
  await page.waitForFunction(
    () =>
      (window.__papertie.debug as unknown as { pyramid(): PyramidState | null }).pyramid()
        ?.ready === true,
    undefined,
    { timeout: 120_000 },
  )
  const fit = await page.evaluate(() => window.__papertie.debug.camera())
  for (const [label, zoom] of [
    ['0.03', 0.03],
    ['fit', fit.zoom],
  ] as const) {
    for (const g of ['pan', 'zoom'] as const) {
      if (label === 'fit') await page.evaluate((c) => window.__papertie.debug.setCamera(c), fit)
      else await focus(page, hub, zoom, 'overview')
      await pyramidSettled(page)
      const options: GestureOptions =
        g === 'zoom'
          ? { zoomMin: Math.max(ZOOM_MIN, zoom / 1.5), zoomMax: zoom * 1.5 }
          : label === 'fit'
            ? OVERVIEW_PAN
            : {}
      rows.push(
        await row(
          page,
          base('overview', g, TARGET.lifetimeFar, `100k pyramid ${g} at ${label}`),
          () => gesture(page, g, options),
        ),
      )
    }
  }
  const pyramid = await pyramidOf(page)

  // Fit-all (Shift+1) from reading zoom at the hub, until the camera has settled in overview.
  await open(page, board, size)
  await page.waitForFunction(
    () =>
      (window.__papertie.debug as unknown as { pyramid(): PyramidState | null }).pyramid()
        ?.ready === true,
    undefined,
    { timeout: 120_000 },
  )
  await focus(page, hub, 1, 'full')
  await settle(page)
  rows.push(
    await row(
      page,
      {
        ...base(
          'full',
          'Shift+1',
          { ...TARGET.lifetimeFar, ...TARGET.stall, ...TARGET.fitAll },
          '100k fit-all from 1',
        ),
      },
      async () => {
        await page.evaluate(() => window.__papertiePerf.record())
        await page.keyboard.press('Shift+Digit1')
        await page.waitForFunction(
          () =>
            window.__papertie.debug.lod() === 'overview' && !window.__papertiePerf.loopRunning(),
          undefined,
          { timeout: 60_000 },
        )
        await page.waitForTimeout(300)
        return page.evaluate(() => window.__papertiePerf.stop())
      },
      'overview',
    ),
  )

  // The blank-page floor for the reading rows' p95, from this run if the full-detail test made it.
  const saved = loadRun().baseline as PerfSnapshot | undefined
  const floor = saved ?? (await baseline(page))
  if (saved === undefined) save('baseline', { machine: machine(), ...floor })
  report(
    'lifetime',
    rows,
    { hub, fitZoom: fit.zoom, pyramid, budgets: BUDGET_4B, longTasks },
    atStart,
    floor,
  )
  console.log(`long tasks by row (from the press or the first wheel): ${JSON.stringify(longTasks)}`)
  for (const r of rows) expect(r.frames, `${r.id}: recorded frames`).toBeGreaterThan(10)
})

test('memory over a 2-minute pan on the 1000 board (BENCH_LONG=1)', async ({ page }) => {
  test.skip(process.env.BENCH_LONG !== '1', 'the 2-minute row runs only with BENCH_LONG=1')
  test.setTimeout(6 * 60_000)
  const atStart = machine()
  checkHygiene(atStart)
  await open(page, '1000', 1000)
  await centre(page, 1, 'full')
  await settle(page)
  const home = await page.evaluate(() => window.__papertie.debug.camera())
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('HeapProfiler.enable')
  const t0 = Date.now()
  const sample = async (): Promise<MemorySample> => {
    await cdp.send('HeapProfiler.collectGarbage')
    const m = await metricsOf(cdp)
    return {
      tMs: Date.now() - t0,
      heapUsed: m.JSHeapUsedSize ?? Number.NaN,
      nodes: m.Nodes ?? Number.NaN,
    }
  }
  // Every sample is taken with the camera back at `home`, so the same notes are mounted.
  // BENCH_MEMORY_LAPS (diagnosis only): more laps, saved as a section of their own, so the row
  // keeps its four. BENCH_TRACE=memory: heap snapshots at the start, after lap 1 and the last.
  const lapCount = Number(process.env.BENCH_MEMORY_LAPS ?? LONG_PAN.laps)
  const snapshot = async (name: string) => {
    if (process.env.BENCH_TRACE !== 'memory') return
    const chunks: string[] = []
    const take = (e: { chunk: string }) => chunks.push(e.chunk)
    cdp.on('HeapProfiler.addHeapSnapshotChunk', take)
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
    cdp.off('HeapProfiler.addHeapSnapshotChunk', take)
    const dir = join(repo(), 'e2e/artifacts/traces')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `memory-1000-${name}.heapsnapshot`), chunks.join(''))
  }
  const cameras = [await page.evaluate(() => window.__papertie.debug.camera())]
  const samples: MemorySample[] = [await sample()]
  await snapshot('start')
  const laps: PerfSnapshot[] = []
  for (let lap = 0; lap < lapCount; lap++) {
    laps.push(
      await gesture(
        page,
        'pan',
        { sweepSec: LONG_PAN.sweepSec },
        LONG_PAN.lapMs - GESTURE.warmupMs,
      ),
    )
    await page.evaluate((c) => window.__papertie.debug.setCamera(c), home)
    await settle(page)
    cameras.push(await page.evaluate(() => window.__papertie.debug.camera()))
    samples.push(await sample())
    if (lap === 0 || lap === lapCount - 1) await snapshot(`lap-${lap + 1}`)
  }
  await cdp.detach()
  for (const c of cameras) expect.soft(c, 'memory samples: camera back at the start').toEqual(home)
  // The heap's baseline is the sample after one warm-up lap.
  const verdict = judgeMemory(samples, {
    heapTolerance: TARGET.heapTolerance,
    warmupLaps: WARMUP_LAPS,
  })
  const first = samples[0] as MemorySample
  const warmed = samples[WARMUP_LAPS] as MemorySample
  const last = samples.at(-1) as MemorySample
  const line = `${hygieneLine(atStart)}\nmemory: heap ${(warmed.heapUsed / 1e6).toFixed(1)} → ${(last.heapUsed / 1e6).toFixed(1)} MB after the warm-up lap (${(verdict.heapGrowth * 100).toFixed(1)} %; from the start ${(first.heapUsed / 1e6).toFixed(1)} MB, ${(verdict.heapGrowthFromStart * 100).toFixed(1)} %), nodes ${first.nodes} → ${last.nodes} (${verdict.nodesDelta >= 0 ? '+' : ''}${verdict.nodesDelta}), samples ${samples.map((s) => s.nodes).join(' ')}${atStart.valid ? '' : ' INVALID RUN (hygiene)'}`
  console.log(line)
  test.info().annotations.push({ type: 'memory', description: line })
  save(lapCount === LONG_PAN.laps ? 'memory' : `memory diagnosis (${lapCount} laps)`, {
    machine: atStart,
    machineAtEnd: machine(),
    budget: `JS heap after GC ≤ +${TARGET.heapTolerance * 100} %, DOM nodes ≤ +${NODE_TOLERANCE * 100} % and not rising at every sample over a 2-minute pan`,
    definition: `The heap's baseline is the sample after ${WARMUP_LAPS} warm-up lap; the growth from the very start is kept as heapGrowthFromStart, for information. DOM nodes are judged from the start.`,
    warmupLaps: WARMUP_LAPS,
    pan: LONG_PAN,
    laps,
    heapTolerance: TARGET.heapTolerance,
    nodeTolerance: NODE_TOLERANCE,
    home,
    samples,
    ...verdict,
  })
  expect.soft(verdict.failures, 'memory: targets').toEqual([])
})
