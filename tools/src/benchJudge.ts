/** Pure judgements for `e2e/bench/canvas.bench.ts`: gates, first paint, memory, hygiene. */

/** A row's frame intervals, summarised (the shape of apps/web's `PerfSnapshot`). */
export interface FrameSummary {
  fps: number
  p95FrameMs: number
  maxFrameMs: number
  longFrames: number
  frames: number
}

/** What a row must meet; an absent field is not judged. */
export interface FrameGate {
  /** Lowest mean fps. A 60 fps target is 59.5: the mean is reported to the nearest frame. */
  minFps?: number
  /** Highest p95 above the blank-page baseline's p95, ms. */
  p95OverBaselineMs?: number
  /** Longest frame, ms, judged with `VSYNC_SLACK_MS`. */
  maxFrameMs?: number
}

/**
 * A p95 at or near the blank-page baseline passes: "near" is no more than 0.5 ms above it.
 */
export const P95_FLOOR_SLACK_MS = 0.5

/**
 * rAF times are vsync-quantised: three vsyncs at 60 Hz read as 50.0x ms, one more as 66.7. A
 * frame fails a max-frame gate of N ms from N + this on.
 */
export const VSYNC_SLACK_MS = 1

/** Every gate `s` misses, as readable lines; empty when it meets them all. */
export function judgeFrames(s: FrameSummary, gate: FrameGate, baseline?: FrameSummary): string[] {
  const out: string[] = []
  if (gate.minFps !== undefined && !(s.fps >= gate.minFps))
    out.push(`mean ${s.fps.toFixed(1)} fps < ${gate.minFps}`)
  if (gate.p95OverBaselineMs !== undefined) {
    if (baseline === undefined) out.push('p95 not judged: no blank-page baseline')
    else if (!(s.p95FrameMs <= baseline.p95FrameMs + gate.p95OverBaselineMs))
      out.push(
        `p95 ${s.p95FrameMs.toFixed(2)} ms > blank page ${baseline.p95FrameMs.toFixed(2)} + ${gate.p95OverBaselineMs} ms`,
      )
  }
  if (gate.maxFrameMs !== undefined && !(s.maxFrameMs < gate.maxFrameMs + VSYNC_SLACK_MS))
    out.push(`max frame ${s.maxFrameMs.toFixed(1)} ms > ${gate.maxFrameMs} ms`)
  return out
}

/** One rAF of a cold load: its time since navigation start and what had been painted by then. */
export interface PaintSample {
  t: number
  /** The app's hooks report ready (the first camera applied). */
  ready: boolean
  notes: boolean
  yarn: boolean
  /** The cork textures, the paper masks and the note images have loaded. */
  assets: boolean
}

/**
 * First paint: navigation start to the rAF after the first one that found hooks ready, notes
 * mounted, yarn drawn and the cork and paper assets loaded (that frame's output is on screen
 * by the next one). Null until that next rAF has run.
 */
export function firstPaintMs(samples: readonly PaintSample[]): number | null {
  const i = samples.findIndex((s) => s.ready && s.notes && s.yarn && s.assets)
  if (i < 0) return null
  return samples[i + 1]?.t ?? null
}

/** The median; NaN for no values. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

/**
 * A memory sample, taken after a forced GC. Every sample of one run is taken with the camera at
 * the same place, so the same notes are mounted and the counts compare like for like.
 */
export interface MemorySample {
  tMs: number
  /** JS heap used, bytes. */
  heapUsed: number
  /** DOM nodes alive. */
  nodes: number
}

export interface MemoryVerdict {
  /** End heap over the baseline heap (the start, or the sample after the warm-up laps), minus 1. */
  heapGrowth: number
  /** End heap over the very first sample's, minus 1: kept for information. */
  heapGrowthFromStart: number
  /** End DOM nodes minus start DOM nodes. */
  nodesDelta: number
  /** Three or more samples whose node count never fell and ended above the start. */
  nodesMonotonic: boolean
  failures: string[]
}

/** DOM nodes may end this fraction above their start (1 % of ~4,000 nodes is about two notes). */
export const NODE_TOLERANCE = 0.01

/**
 * The memory rows' warm-up: the heap's baseline is the sample
 * taken after this many laps, since the first lap's growth is V8's first-pass code and levels off.
 * The targets are unchanged; the growth from the very start stays recorded, for information.
 */
export const WARMUP_LAPS = 1

const mb = (b: number) => (b / 1e6).toFixed(1)

export interface WarmedHeap {
  /** End over the heap after the warm-up lap, minus 1: what is judged. */
  growth: number
  /** End over the heap at the start, minus 1: information only. */
  growthFromStart: number
  failures: string[]
}

/** The end heap at most `tolerance` above the heap after the warm-up lap (see {@link WARMUP_LAPS}). */
export function heapAfterWarmup(
  heap: { start: number; warm: number; end: number },
  tolerance: number,
): WarmedHeap {
  const growth = heap.end / heap.warm - 1
  return {
    growth,
    growthFromStart: heap.end / heap.start - 1,
    failures:
      growth <= tolerance
        ? []
        : [
            `JS heap after GC grew ${(growth * 100).toFixed(1)} % after the warm-up lap (${mb(heap.warm)} → ${mb(heap.end)} MB) > ${tolerance * 100} %`,
          ],
  }
}

/**
 * Memory over a long pan, from samples taken at one camera position, one after each lap: the heap
 * after GC ends at most `heapTolerance` above its baseline (a smaller heap is fine), the DOM node
 * count ends at most `nodeTolerance` above its start, and it does not rise at every sample
 * either. The heap's baseline is the start, or with `warmupLaps` the sample after those laps
 * ({@link WARMUP_LAPS}); the nodes are judged from the start either way.
 */
export function judgeMemory(
  samples: readonly MemorySample[],
  { heapTolerance = 0.05, nodeTolerance = NODE_TOLERANCE, warmupLaps = 0 } = {},
): MemoryVerdict {
  const first = samples[0]
  const base = samples[warmupLaps]
  const last = samples.at(-1)
  const need = warmupLaps + 2
  if (first === undefined || base === undefined || last === undefined || samples.length < need)
    return {
      heapGrowth: Number.NaN,
      heapGrowthFromStart: Number.NaN,
      nodesDelta: Number.NaN,
      nodesMonotonic: false,
      failures: [`need at least ${need} samples, got ${samples.length}`],
    }
  const failures: string[] = []
  let heapGrowth: number
  let heapGrowthFromStart: number
  if (warmupLaps > 0) {
    const warmed = heapAfterWarmup(
      { start: first.heapUsed, warm: base.heapUsed, end: last.heapUsed },
      heapTolerance,
    )
    heapGrowth = warmed.growth
    heapGrowthFromStart = warmed.growthFromStart
    failures.push(...warmed.failures)
  } else {
    heapGrowth = last.heapUsed / first.heapUsed - 1
    heapGrowthFromStart = heapGrowth
    if (!(heapGrowth <= heapTolerance))
      failures.push(
        `JS heap after GC grew ${(heapGrowth * 100).toFixed(1)} % (${mb(first.heapUsed)} → ${mb(last.heapUsed)} MB) > ${heapTolerance * 100} %`,
      )
  }
  const nodesDelta = last.nodes - first.nodes
  const nodeGrowth = last.nodes / first.nodes - 1
  if (!(last.nodes <= first.nodes * (1 + nodeTolerance)))
    failures.push(
      `DOM nodes grew ${(nodeGrowth * 100).toFixed(1)} % (${first.nodes} → ${last.nodes}) > ${nodeTolerance * 100} %`,
    )
  const nodesMonotonic =
    samples.length >= 3 &&
    last.nodes > first.nodes &&
    samples.every((s, i) => i === 0 || s.nodes >= (samples[i - 1] as MemorySample).nodes)
  if (nodesMonotonic)
    failures.push(
      `DOM nodes never fell: ${first.nodes} → ${last.nodes} over ${samples.length} samples`,
    )
  return { heapGrowth, heapGrowthFromStart, nodesDelta, nodesMonotonic, failures }
}

/** `after - before` for each of `names`; a metric missing from either reads as 0. */
export function metricDelta(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
  names: readonly string[],
): Record<string, number> {
  return Object.fromEntries(names.map((n) => [n, (after[n] ?? 0) - (before[n] ?? 0)]))
}

/** Style and layout work in one window of CDP `Performance.getMetrics` samples. */
export interface StyleWindow {
  seconds: number
  recalcCount: number
  recalcMs: number
  layoutCount: number
  layoutMs: number
}

const STYLE_METRICS = [
  'Timestamp',
  'RecalcStyleCount',
  'RecalcStyleDuration',
  'LayoutCount',
  'LayoutDuration',
] as const

function styleWindow(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): StyleWindow {
  const d = metricDelta(a, b, STYLE_METRICS)
  return {
    seconds: d.Timestamp ?? 0,
    recalcCount: d.RecalcStyleCount ?? 0,
    recalcMs: (d.RecalcStyleDuration ?? 0) * 1000,
    layoutCount: d.LayoutCount ?? 0,
    layoutMs: (d.LayoutDuration ?? 0) * 1000,
  }
}

/**
 * Style recalc around a pointer pan, from metrics taken before it (`m0`), shortly after it
 * started (`m1`), as it ended (`m2`) and once it settled (`m3`). The excess is a start or end
 * window's recalc time above the steady window's per-second rate: what toggling the pan state
 * costs.
 */
export function styleWindows(
  m0: Readonly<Record<string, number>>,
  m1: Readonly<Record<string, number>>,
  m2: Readonly<Record<string, number>>,
  m3: Readonly<Record<string, number>>,
): {
  start: StyleWindow
  steady: StyleWindow
  end: StyleWindow
  startExcessMs: number
  endExcessMs: number
} {
  const start = styleWindow(m0, m1)
  const steady = styleWindow(m1, m2)
  const end = styleWindow(m2, m3)
  const rate = steady.seconds > 0 ? steady.recalcMs / steady.seconds : 0
  return {
    start,
    steady,
    end,
    startExcessMs: start.recalcMs - rate * start.seconds,
    endExcessMs: end.recalcMs - rate * end.seconds,
  }
}

/** The power source `pmset -g batt` names. */
export function powerSource(pmset: string): 'ac' | 'battery' | 'unknown' {
  if (pmset.includes("'AC Power'")) return 'ac'
  if (pmset.includes("'Battery Power'")) return 'battery'
  return 'unknown'
}

/** One process line from `top`. */
export interface TopProcess {
  pid: number
  cpu: number
  command: string
}

/**
 * A process at this much CPU or more is heavy (no heavy process from another
 * project).
 */
export const HEAVY_CPU = 50

/**
 * The processes in the last sample of `top -l 2 -n 5 -o cpu -stats pid,cpu,command` (the first
 * sample's CPU figures are not meaningful), highest CPU first as `top` prints them.
 */
export function topProcesses(text: string): TopProcess[] {
  const lines = text.split('\n')
  let header = -1
  lines.forEach((l, i) => {
    if (/^\s*PID\s+%CPU\s+COMMAND/.test(l)) header = i
  })
  if (header < 0) return []
  const out: TopProcess[] = []
  for (const l of lines.slice(header + 1)) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(.+?)\s*$/.exec(l)
    if (m === null) break
    out.push({ pid: Number(m[1]), cpu: Number(m[2]), command: m[3] as string })
  }
  return out
}

/** A 1-minute load at or above this is not a quiet machine. */
export const QUIET_LOAD1 = 4

/**
 * Bench hygiene: numbers count only on mains power, with the 1-minute load under 4
 * and no process at `HEAVY_CPU` or more.
 */
export function hygiene(
  load1: number,
  power: 'ac' | 'battery' | 'unknown',
  top: readonly TopProcess[] = [],
): { quiet: boolean; mains: boolean; calm: boolean; valid: boolean } {
  const quiet = load1 < QUIET_LOAD1
  const mains = power === 'ac'
  const calm = top.every((p) => p.cpu < HEAVY_CPU)
  return { quiet, mains, calm, valid: quiet && mains && calm }
}
