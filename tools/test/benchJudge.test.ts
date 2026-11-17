import {
  type FrameSummary,
  firstPaintMs,
  heapAfterWarmup,
  hygiene,
  judgeFrames,
  judgeMemory,
  median,
  metricDelta,
  NODE_TOLERANCE,
  P95_FLOOR_SLACK_MS,
  powerSource,
  styleWindows,
  topProcesses,
  VSYNC_SLACK_MS,
  WARMUP_LAPS,
} from '../src/benchJudge'

const snap = (o: Partial<FrameSummary> = {}): FrameSummary => ({
  fps: 60,
  p95FrameMs: 18.2,
  maxFrameMs: 20,
  longFrames: 0,
  frames: 240,
  ...o,
})

describe('judgeFrames', () => {
  const base = snap({ p95FrameMs: 18.4 })

  it('passes a row that meets every gate, and one with no gate at all', () => {
    expect(judgeFrames(snap(), { minFps: 59.5, p95OverBaselineMs: 0.5 }, base)).toEqual([])
    expect(judgeFrames(snap({ fps: 3 }), {})).toEqual([])
  })

  it('a 60 fps target counts 59.5 as met and 59.4 as missed', () => {
    const gate = { minFps: 59.5 }
    expect(judgeFrames(snap({ fps: 59.5 }), gate)).toEqual([])
    expect(judgeFrames(snap({ fps: 59.4 }), gate)).toEqual(['mean 59.4 fps < 59.5'])
  })

  it('judges the p95 against the blank-page baseline plus the floor slack', () => {
    const gate = { p95OverBaselineMs: P95_FLOOR_SLACK_MS }
    expect(judgeFrames(snap({ p95FrameMs: 18.4 + P95_FLOOR_SLACK_MS }), gate, base)).toEqual([])
    expect(judgeFrames(snap({ p95FrameMs: 19.5 }), gate, base)).toEqual([
      'p95 19.50 ms > blank page 18.40 + 0.5 ms',
    ])
  })

  it('a p95 gate without a baseline fails rather than passing unjudged', () => {
    expect(judgeFrames(snap(), { p95OverBaselineMs: 0.5 })).toEqual([
      'p95 not judged: no blank-page baseline',
    ])
  })

  it('a max-frame gate allows vsync quantisation but not a missed vsync more', () => {
    const gate = { maxFrameMs: 50 }
    // Three vsyncs at 60 Hz read as 50.0x ms.
    expect(judgeFrames(snap({ maxFrameMs: 50.04 }), gate)).toEqual([])
    expect(judgeFrames(snap({ maxFrameMs: 50 + VSYNC_SLACK_MS }), gate)).toEqual([
      'max frame 51.0 ms > 50 ms',
    ])
    expect(judgeFrames(snap({ maxFrameMs: 66.7 }), gate)).toHaveLength(1)
  })

  it('reports every failing gate, and a row with no frames fails a frame-rate gate', () => {
    const gate = { minFps: 55, maxFrameMs: 50 }
    expect(judgeFrames(snap({ fps: 40, maxFrameMs: 120 }), gate)).toHaveLength(2)
    expect(judgeFrames(snap({ fps: 0, frames: 0 }), { minFps: 55 })).toEqual(['mean 0.0 fps < 55'])
  })
})

describe('firstPaintMs', () => {
  const s = (t: number, ok = false) => ({ t, ready: ok, notes: ok, yarn: ok, assets: ok })

  it('is the frame after the first one with everything painted', () => {
    expect(firstPaintMs([s(100), s(116), s(133, true), s(150, true), s(166, true)])).toBe(150)
  })

  it('needs every part: hooks ready, notes, yarn and the cork and paper assets', () => {
    const partial = [
      { t: 100, ready: true, notes: true, yarn: true, assets: false },
      { t: 116, ready: true, notes: true, yarn: false, assets: true },
      { t: 133, ready: false, notes: true, yarn: true, assets: true },
      { t: 150, ready: true, notes: false, yarn: true, assets: true },
    ]
    expect(firstPaintMs(partial)).toBeNull()
    expect(firstPaintMs([...partial, s(166, true), s(183)])).toBe(183)
  })

  it('is null until the following frame has run', () => {
    expect(firstPaintMs([])).toBeNull()
    expect(firstPaintMs([s(100), s(116, true)])).toBeNull()
  })
})

describe('median', () => {
  it('takes the middle value, or the mean of the middle two, without reordering the input', () => {
    const xs = [900, 400, 700, 500, 600]
    expect(median(xs)).toBe(600)
    expect(xs).toEqual([900, 400, 700, 500, 600])
    expect(median([1, 4, 2, 3])).toBe(2.5)
    expect(median([])).toBeNaN()
  })
})

describe('judgeMemory', () => {
  const m = (tMs: number, heapUsed: number, nodes: number) => ({ tMs, heapUsed, nodes })

  it('passes a heap within 5 % of its start and DOM nodes that end within the tolerance', () => {
    const r = judgeMemory([
      m(0, 20e6, 4000),
      m(30e3, 24e6, 4300),
      m(60e3, 21e6, 4100),
      m(90e3, 23e6, 4400),
      m(120e3, 20.9e6, 4020),
    ])
    expect(r.failures).toEqual([])
    expect(r.heapGrowth).toBeCloseTo(0.045, 9)
    expect(r.nodesDelta).toBe(20)
    expect(r.nodesMonotonic).toBe(false)
  })

  it('fails a leak hidden under samples that go up and down', () => {
    const r = judgeMemory([
      m(0, 20e6, 4000),
      m(30e3, 20e6, 4350),
      m(60e3, 20e6, 4100),
      m(90e3, 20e6, 4450),
      m(120e3, 20e6, 4200),
    ])
    expect(r.nodesMonotonic).toBe(false)
    expect(r.nodesDelta).toBe(200)
    expect(r.failures).toEqual([`DOM nodes grew 5.0 % (4000 → 4200) > ${NODE_TOLERANCE * 100} %`])
  })

  it('the node tolerance is a fraction of the start count, and can be set', () => {
    const at = (end: number) => [m(0, 1e6, 4000), m(120e3, 1e6, end)]
    expect(judgeMemory(at(4000 * (1 + NODE_TOLERANCE))).failures).toEqual([])
    expect(judgeMemory(at(4041)).failures).toHaveLength(1)
    expect(judgeMemory(at(4300), { nodeTolerance: 0.1 }).failures).toEqual([])
    expect(judgeMemory([m(0, 20e6, 9), m(1, 21.2e6, 9)], { heapTolerance: 0.1 }).failures).toEqual(
      [],
    )
  })

  it('fails a heap more than 5 % above its start; a smaller heap is fine', () => {
    expect(judgeMemory([m(0, 20e6, 10), m(120e3, 21.2e6, 9)]).failures).toEqual([
      'JS heap after GC grew 6.0 % (20.0 → 21.2 MB) > 5 %',
    ])
    expect(judgeMemory([m(0, 20e6, 10), m(120e3, 12e6, 9)]).failures).toEqual([])
  })

  it('fails DOM nodes that grow at every sample, even slowly', () => {
    const r = judgeMemory([
      m(0, 20e6, 4000),
      m(30e3, 20e6, 4001),
      m(60e3, 20e6, 4001),
      m(90e3, 20e6, 4003),
      m(120e3, 20e6, 4004),
    ])
    expect(r.nodesMonotonic).toBe(true)
    // Under the tolerance, but rising at every sample taken at the same place.
    expect(r.failures).toEqual(['DOM nodes never fell: 4000 → 4004 over 5 samples'])
  })

  it('a flat node count is not growth', () => {
    const flat = [m(0, 1e6, 500), m(30e3, 1e6, 500), m(60e3, 1e6, 500)]
    expect(judgeMemory(flat)).toMatchObject({ nodesMonotonic: false, failures: [] })
  })

  it('needs a start and an end sample', () => {
    expect(judgeMemory([m(0, 1e6, 500)]).failures).toEqual(['need at least 2 samples, got 1'])
  })

  // The heap's baseline is taken after one
  // warm-up lap; the targets stay as they were.
  it('one warm-up lap: the heap is judged from the sample after it', () => {
    expect(WARMUP_LAPS).toBe(1)
    // The 1000 board's 2-minute pan as measured (9.7 → 10.8 MB): +11.3 % from the start, +3.0 %
    // from the end of the first lap.
    const r = judgeMemory(
      [
        m(0, 9.7e6, 706),
        m(30e3, 10.49e6, 706),
        m(60e3, 10.7e6, 706),
        m(90e3, 10.78e6, 706),
        m(120e3, 10.8e6, 706),
      ],
      { warmupLaps: WARMUP_LAPS },
    )
    expect(r.heapGrowth).toBeCloseTo(10.8 / 10.49 - 1, 9)
    expect(r.heapGrowthFromStart).toBeCloseTo(10.8 / 9.7 - 1, 9)
    expect(r.failures).toEqual([])
  })

  it('after the warm-up the target is unchanged: more than 5 % still fails', () => {
    const r = judgeMemory([m(0, 10e6, 700), m(30e3, 10e6, 700), m(120e3, 10.6e6, 700)], {
      warmupLaps: 1,
    })
    expect(r.failures).toEqual([
      'JS heap after GC grew 6.0 % after the warm-up lap (10.0 → 10.6 MB) > 5 %',
    ])
  })

  it('the DOM nodes are still judged from the start', () => {
    const r = judgeMemory([m(0, 10e6, 4000), m(30e3, 10e6, 4350), m(120e3, 10e6, 4300)], {
      warmupLaps: 1,
    })
    expect(r.failures).toEqual([`DOM nodes grew 7.5 % (4000 → 4300) > ${NODE_TOLERANCE * 100} %`])
  })

  it('with a warm-up lap it needs a sample after it and one at the end', () => {
    expect(judgeMemory([m(0, 1e6, 5), m(1, 1e6, 5)], { warmupLaps: 1 }).failures).toEqual([
      'need at least 3 samples, got 2',
    ])
  })
})

describe('heapAfterWarmup', () => {
  it('judges the end against the heap after the warm-up lap, and keeps the growth from the start', () => {
    // The photo board as measured: 5.62 → 6.40 MB from the start (+13.8 %).
    const r = heapAfterWarmup({ start: 5.62e6, warm: 6.3e6, end: 6.4e6 }, 0.1)
    expect(r.growth).toBeCloseTo(6.4 / 6.3 - 1, 9)
    expect(r.growthFromStart).toBeCloseTo(6.4 / 5.62 - 1, 9)
    expect(r.failures).toEqual([])
  })

  it('fails an end more than the tolerance above the warmed heap', () => {
    expect(heapAfterWarmup({ start: 5e6, warm: 6e6, end: 6.7e6 }, 0.1).failures).toEqual([
      'JS heap after GC grew 11.7 % after the warm-up lap (6.0 → 6.7 MB) > 10 %',
    ])
  })
})

describe('metricDelta and styleWindows', () => {
  const at = (ts: number, count: number, durS: number) => ({
    Timestamp: ts,
    RecalcStyleCount: count,
    RecalcStyleDuration: durS,
    LayoutCount: 0,
    LayoutDuration: 0,
  })

  it('subtracts named metrics; a missing one reads as 0', () => {
    expect(metricDelta({ a: 1, b: 5 }, { a: 4, b: 6, c: 9 }, ['a', 'c'])).toEqual({ a: 3, c: 9 })
  })

  it('reports the recalc cost at pan start and end above the steady per-second rate', () => {
    const w = styleWindows(
      at(10, 0, 0),
      at(10.5, 40, 0.012),
      at(12.5, 160, 0.032),
      at(12.8, 170, 0.04),
    )
    expect(w.start).toMatchObject({ seconds: 0.5, recalcCount: 40 })
    expect(w.start.recalcMs).toBeCloseTo(12, 9)
    expect(w.steady.recalcMs).toBeCloseTo(20, 9)
    // Steady 10 ms/s: 5 ms of the start window and 3 ms of the end window are expected anyway.
    expect(w.startExcessMs).toBeCloseTo(7, 9)
    expect(w.endExcessMs).toBeCloseTo(5, 9)
  })
})

describe('powerSource and hygiene', () => {
  it('reads pmset -g batt', () => {
    expect(powerSource("Now drawing from 'AC Power'\n -InternalBattery-0 100%; charged")).toBe('ac')
    expect(powerSource("Now drawing from 'Battery Power'\n -InternalBattery-0 80%")).toBe('battery')
    expect(powerSource('')).toBe('unknown')
  })

  it('a run is valid only on mains power with the 1-minute load under 4', () => {
    expect(hygiene(1.2, 'ac')).toEqual({ quiet: true, mains: true, calm: true, valid: true })
    expect(hygiene(4, 'ac')).toMatchObject({ quiet: false, valid: false })
    expect(hygiene(0.5, 'battery')).toMatchObject({ mains: false, valid: false })
    expect(hygiene(Number.NaN, 'ac')).toMatchObject({ quiet: false, valid: false })
    expect(hygiene(0.5, 'unknown').valid).toBe(false)
  })

  it('a heavy process (50 % CPU or more) makes the run not valid', () => {
    const top = [
      { pid: 1, cpu: 49.9, command: 'WindowServer' },
      { pid: 2, cpu: 3, command: 'top' },
    ]
    expect(hygiene(1, 'ac', top)).toMatchObject({ calm: true, valid: true })
    const busy = [{ pid: 3, cpu: 312.5, command: 'node' }, ...top]
    expect(hygiene(1, 'ac', busy)).toMatchObject({ calm: false, valid: false })
  })

  it('reads the last sample of top -l 2 -n 5 -o cpu -stats pid,cpu,command', () => {
    const text = [
      'Processes: 640 total, 3 running, 637 sleeping, 3011 threads',
      'Load Avg: 2.10, 2.00, 1.90',
      '',
      'PID    %CPU COMMAND',
      '0      0.0  kernel_task',
      'Processes: 640 total, 4 running, 636 sleeping, 3012 threads',
      'Load Avg: 2.10, 2.00, 1.90',
      '',
      'PID    %CPU COMMAND',
      '4567   312.5 node',
      '89     45.0 Google Chrome Helper (Renderer)',
      '1      0.3  launchd',
      '',
    ].join('\n')
    expect(topProcesses(text)).toEqual([
      { pid: 4567, cpu: 312.5, command: 'node' },
      { pid: 89, cpu: 45, command: 'Google Chrome Helper (Renderer)' },
      { pid: 1, cpu: 0.3, command: 'launchd' },
    ])
    expect(topProcesses('')).toEqual([])
  })
})
