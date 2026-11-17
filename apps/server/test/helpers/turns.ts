import { constants, PerformanceObserver } from 'node:perf_hooks'
import { recordSlices, type SliceSpan, slicedCpuMs } from '../../src/store/compact'

/**
 * How much slower a Raspberry Pi runs this server's code than a Mac the tests time on: 8× (its own profiles).
 */
export const PI = 8

/**
 * The longest major collection (mark-compact) a Raspberry Pi paused for during a compaction: 40.7 ms
 * (5999866, its run 9), at the 100,000-note board's heap. It can land in any iteration, inside a
 * slice or not; an iteration must leave room for it (`roomMs`).
 */
export const PI_MAJOR_GC_MS = 40

/** `PerformanceObserver` gc entries' `detail.kind` (`perf_hooks.constants.NODE_PERFORMANCE_GC_*`). */
const GC_KINDS: Record<number, string> = {
  [constants.NODE_PERFORMANCE_GC_MINOR]: 'scavenge',
  [constants.NODE_PERFORMANCE_GC_MAJOR]: 'mark-compact',
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental marking',
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weak callbacks',
}

interface Turn {
  /** `performance.now()` at the turn's start and end (two ticks of a 1 ms timer). */
  from: number
  to: number
  cpuMs: number
  slicedMs: number
  gcMs: number
  /** Of `gcMs`, the pauses that started inside a slice. */
  gcInSlicesMs: number
  /** The pauses, as `<kind> <ms>`. */
  gcKinds: string[]
  /** The longest indivisible step of a slice that ended in it, ms (less any GC inside it). */
  stepMs: number
}

export interface Turns<T> {
  result: T
  /** The most CPU one event-loop iteration took here, ms. */
  maxCpuMs: number
  /**
   * The longest iteration as a CPU `PI`× slower would run it. A slice ends at the first clock read
   * past its budget, so there it takes `min(PI·work, budget + PI·step)`: all its work `PI`×, but
   * never more than the budget plus its longest indivisible step `PI`× (`SliceSpan.stepMs`, the
   * stretch between two clock reads, whenever in the slice it ran). The rest of the iteration's
   * CPU is `PI`×, and every GC pause `PI`× wherever it landed (one outside the slices by the
   * larger of its wall time and the rest's CPU: V8's helper threads do part of a parallel pause).
   */
  maxScaledMs: number
  /**
   * The longest iteration counted as `maxScaledMs` is, but without its GC pauses: what an
   * iteration holds besides a collection. With `PI_MAJOR_GC_MS` added it is the iteration a
   * major collection landing in it would make on a Raspberry Pi.
   */
  maxScaledNoGcMs: number
  /** That iteration's parts. */
  worstNoGc: { cpuMs: number; slicedMs: number; stepMs: number; slices: number }
  /** The factor the rest was counted with. */
  pi: number
  /** That iteration's parts, ms. */
  worst: {
    cpuMs: number
    slicedMs: number
    gcMs: number
    gcInSlicesMs: number
    gcKinds: string[]
    stepMs: number
  }
}

/**
 * Each event-loop iteration's CPU time while `fn` runs, read by a 1 ms timer (timers run once an
 * iteration), split into the `Slicer` jobs' (`slicedCpuMs`), the rest, and the GC pauses that
 * started in it. With `stretched` (the slices' work stretched `pi`× by `stretchSlices`), a pause
 * inside a slice is stretched with it already, so it is not counted again.
 */
export async function turns<T>(
  fn: () => Promise<T>,
  { pi = PI, stretched = false } = {},
): Promise<Turns<T>> {
  const all: Turn[] = []
  const gcs: Array<{ at: number; ms: number; kind: string }> = []
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const kind = (e as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind
      gcs.push({ at: e.startTime, ms: e.duration, kind: GC_KINDS[kind ?? 0] ?? 'gc' })
    }
  })
  observer.observe({ entryTypes: ['gc'] })
  let last = performance.now()
  let lastCpu = process.threadCpuUsage()
  let lastSliced = slicedCpuMs()
  recordSlices(true)
  const close = () => {
    const now = performance.now()
    const cpu = process.threadCpuUsage()
    const sliced = slicedCpuMs()
    all.push({
      from: last,
      to: now,
      cpuMs: (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000,
      slicedMs: sliced - lastSliced,
      gcMs: 0,
      gcInSlicesMs: 0,
      gcKinds: [],
      stepMs: 0,
    })
    last = now
    lastCpu = cpu
    lastSliced = sliced
  }
  const tick = setInterval(close, 1)
  let result: T
  let spans: SliceSpan[]
  try {
    result = await fn()
  } finally {
    clearInterval(tick)
    // The iteration `fn` ended in, up to here.
    close()
    spans = recordSlices(false)
    // The observer's entries arrive a little later than the pauses.
    await new Promise((r) => setTimeout(r, 20))
    observer.disconnect()
  }
  const inside = (at: number, from: number, to: number) => at >= from && at < to
  const turnOf = (at: number) => all.find((x) => inside(at, x.from, x.to))
  for (const g of gcs) {
    const t = turnOf(g.at)
    if (!t) continue
    t.gcMs += g.ms
    t.gcKinds.push(`${g.kind} ${g.ms.toFixed(1)}`)
    if (spans.some((x) => inside(g.at, x.from, x.to))) t.gcInSlicesMs += g.ms
  }
  /** Each turn's slices (a slice belongs to the turn its end falls in). */
  const slicesOf = new Map<Turn, SliceSpan[]>()
  for (const x of spans) {
    const t = turnOf(x.to)
    if (!t) continue
    const list = slicesOf.get(t) ?? []
    list.push(x)
    slicesOf.set(t, list)
  }
  let maxCpuMs = 0
  let maxScaledMs = 0
  let maxScaledNoGcMs = 0
  let worstNoGc = { cpuMs: 0, slicedMs: 0, stepMs: 0, slices: 0 }
  let worst: Turns<T>['worst'] = {
    cpuMs: 0,
    slicedMs: 0,
    gcMs: 0,
    gcInSlicesMs: 0,
    gcKinds: [],
    stepMs: 0,
  }
  for (const t of all) {
    maxCpuMs = Math.max(maxCpuMs, t.cpuMs)
    const sliced = Math.min(t.slicedMs, t.cpuMs)
    const rest = t.cpuMs - sliced
    let scaled: number
    let noGc: number
    if (stretched) {
      // The slices ran as on the slower CPU already: only the rest is counted pi×.
      scaled = sliced + pi * rest
      noGc = sliced - t.gcInSlicesMs + pi * Math.max(0, rest - (t.gcMs - t.gcInSlicesMs))
    } else {
      scaled = 0
      noGc = 0
      for (const x of slicesOf.get(t) ?? []) {
        const gcs_ = gcs.filter((g) => inside(g.at, x.from, x.to))
        const gcIn = Math.min(
          x.cpuMs,
          gcs_.reduce((n, g) => n + g.ms, 0),
        )
        const work = x.cpuMs - gcIn
        // The step's own work: a pause inside it is counted on its own, below.
        const inStep = gcs_.filter((g) => inside(g.at, x.stepFrom, x.stepTo))
        const step = Math.max(0, x.stepMs - inStep.reduce((n, g) => n + g.ms, 0))
        t.stepMs = Math.max(t.stepMs, step)
        scaled += Math.min(pi * work, x.budgetMs + pi * step) + pi * gcIn
        noGc += Math.min(pi * work, x.budgetMs + pi * step)
      }
      // Outside the slices: the rest's CPU, or the pauses' wall time if that is more.
      scaled += pi * Math.max(rest, t.gcMs - t.gcInSlicesMs)
      noGc += pi * Math.max(0, rest - (t.gcMs - t.gcInSlicesMs))
    }
    if (noGc > maxScaledNoGcMs) {
      maxScaledNoGcMs = noGc
      worstNoGc = {
        cpuMs: t.cpuMs,
        slicedMs: t.slicedMs,
        stepMs: t.stepMs,
        slices: slicesOf.get(t)?.length ?? 0,
      }
    }
    if (scaled > maxScaledMs) {
      maxScaledMs = scaled
      worst = t
    }
  }
  return { result, maxCpuMs, maxScaledMs, maxScaledNoGcMs, worstNoGc, worst, pi }
}

export const turnLine = (
  t: Pick<
    Turns<unknown>,
    'maxCpuMs' | 'maxScaledMs' | 'maxScaledNoGcMs' | 'worstNoGc' | 'worst' | 'pi'
  >,
) =>
  `iteration max ${t.maxCpuMs.toFixed(1)} ms CPU, ${t.maxScaledMs.toFixed(1)} ms on a CPU ${t.pi}× ` +
  `slower (${t.maxScaledNoGcMs.toFixed(1)} besides GC: ${t.worstNoGc.cpuMs.toFixed(1)} ms CPU, ` +
  `${t.worstNoGc.slicedMs.toFixed(1)} in ${t.worstNoGc.slices} slices, step ` +
  `${t.worstNoGc.stepMs.toFixed(1)}) ` +
  `(that one: ${t.worst.cpuMs.toFixed(1)} ms CPU, ${t.worst.slicedMs.toFixed(1)} sliced, ` +
  `${t.worst.gcMs.toFixed(1)} GC${t.worst.gcKinds.length ? ` [${t.worst.gcKinds.join(', ')}]` : ''}, ` +
  `${t.worst.gcInSlicesMs.toFixed(1)} of it in slices, longest step ${t.worst.stepMs.toFixed(1)})`
