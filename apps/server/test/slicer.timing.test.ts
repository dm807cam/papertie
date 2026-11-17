/**
 * The slices' and iterations' CPU, timed (`slicer.test.ts` keeps their untimed proofs: the same
 * bytes, the served cut, the slices' count): the timing project runs them, a file at a time
 * (`vitest.config.ts`).
 */
import { loadavg } from 'node:os'
import { type BoardState, type Note, stateFromRecords } from '@papertie/core'
import { describe, expect, it } from 'vitest'
import { bookStream } from '../src/store/bookStream'
import {
  longestSliceCpuMs,
  resetLongestSlice,
  SLICE_MS,
  Slicer,
  serializeSliced,
  stretchSlices,
} from '../src/store/compact'
import { hugeState } from './helpers/boards'
import { libraryState } from './helpers/books'
import { PI, turns } from './helpers/turns'

/**
 * The thread's CPU time per event-loop iteration while `fn` runs, read by a 1 ms timer (timers run
 * once an iteration): what one iteration held the loop for, whatever else the machine runs.
 */
async function cpuPerTurn<T>(fn: () => Promise<T>): Promise<{ result: T; maxCpuMs: number }> {
  let maxCpuMs = 0
  let last = process.threadCpuUsage()
  const tick = setInterval(() => {
    const cpu = process.threadCpuUsage()
    maxCpuMs = Math.max(maxCpuMs, (cpu.user - last.user + cpu.system - last.system) / 1000)
    last = cpu
  }, 1)
  try {
    return { result: await fn(), maxCpuMs }
  } finally {
    clearInterval(tick)
  }
}

describe('Slicer', () => {
  it('sliced jobs take turns: two at once never share an event-loop iteration', async () => {
    const state = hugeState('board_01JBPR0T0SAMP1E000000BRD01', 40_000)
    // Long slices, so two in one iteration (2 × 20 ms) stand well clear of one.
    const budget = 20
    const { result, maxCpuMs } = await cpuPerTurn(() =>
      Promise.all([serializeSliced(state, budget), serializeSliced(state, budget)]),
    )
    console.info(
      `two serializations at once: longest iteration ${maxCpuMs.toFixed(1)} ms CPU, slices ` +
        `${result.map((r) => r.maxSliceMs.toFixed(1)).join(' and ')} ms`,
    )
    expect(result[0].parts.join('')).toBe(result[1].parts.join(''))
    // One slice an iteration: the longest iteration is the longest slice (GC inside it included)
    // and a little else, never two of them (≈ 2 × budget; 61 ms before the slices took turns).
    const slice = Math.max(...result.map((r) => r.maxSliceCpuMs))
    expect(maxCpuMs).toBeLessThanOrEqual(slice + 0.5 * budget)
  }, 60_000)

  it('measures each slice’s CPU time, which no other process can inflate', async () => {
    const s = new Slicer(SLICE_MS)
    for (let i = 0; i < 5; i++) {
      const until = performance.now() + 3
      while (performance.now() < until) {
        // 3 ms of work
      }
      await s.pause()
    }
    s.note()
    expect(s.maxCpuMs).toBeGreaterThan(2)
    expect(s.maxCpuMs).toBeLessThanOrEqual(s.maxMs + 0.5)
  })

  it('a stretched slice is still cut at the budget: the work runs slower, the turn does not', async (ctx) => {
    const state = hugeState('board_01JBPR0T0SAMP1E000000BRD01', 20_000)
    const loadBefore = loadavg()[0] ?? 0
    const plain = await serializeSliced(state)
    stretchSlices(5)
    try {
      const t = performance.now()
      const slow = await serializeSliced(state)
      const ms = performance.now() - t
      console.info(
        `serialization of 20,000 notes, 5× stretched: ${ms.toFixed(0)} ms, longest slice ` +
          `${slow.maxSliceMs.toFixed(1)} ms (${slow.maxSliceCpuMs.toFixed(1)} ms CPU)`,
      )
      expect(slow.parts.join('')).toBe(plain.parts.join(''))
      // The work took about five times as long in all...
      expect(slow.cpuMs).toBeGreaterThan(3 * plain.cpuMs)
      // ...and no slice ran much past its budget for it: a quiet run's reading, as the other
      // per-iteration bounds are (a parallel suite at load1 4.7 once made one 38 ms, the step's
      // CPU stretched 5× on a contended core).
      const load1 = Math.max(loadBefore, loadavg()[0] ?? 0)
      if (load1 >= 4)
        ctx.skip(`not a quiet run (load1 ${load1.toFixed(2)}): the slice bound is not asserted`)
      expect(slow.maxSliceCpuMs).toBeLessThanOrEqual(2 * SLICE_MS)
    } finally {
      stretchSlices(1)
    }
  }, 60_000)
})

/** `hugeState`'s first `notes` notes, the i-th with `text(i)`: long lines, wide characters. */
function withTexts(notes: number, text: (i: number) => string): BoardState {
  const base = hugeState('board_01JBPR0T0SAMP1E000000BRD01', notes)
  const records = [...base.notes.values()].map((n, i): Note => ({ ...n, text: text(i) }))
  return stateFromRecords(base.board, records)
}

describe('serializeSliced into buffers', () => {
  it('a board of long notes yields by the bytes too: no slice runs far past its budget', async () => {
    // 1,000 notes of 120 KB of JSON each: 64 of them (one clock read) were 15 ms of work.
    const state = withTexts(1_000, () => '\u0001'.repeat(20_000))
    await serializeSliced(state)
    const out = await serializeSliced(state)
    console.info(
      `serialization of 1,000 long notes: ${out.bytes} bytes, longest slice ` +
        `${out.maxSliceMs.toFixed(1)} ms (${out.maxSliceCpuMs.toFixed(1)} ms CPU), ${out.parts.length} pieces`,
    )
    expect(out.maxSliceCpuMs).toBeLessThanOrEqual(SLICE_MS + 4)
  }, 120_000)

  // From `slicer.test.ts`: timed only from below, but load shortens it too (its 6 ms is wall
  // time, the count is CPU: a busy machine takes the CPU away mid-step; 29 ms against 44 in a
  // loaded gate run).
  it("a Raspberry Pi's count sees a long step wherever in its slice it ran", async () => {
    // One slice: a 6 ms step with no clock read inside it, then 1 ms steps to the budget. A CPU
    // 8× slower runs the 6 ms step for 48 ms, whatever the slice's budget: the count must say so
    // (it counted only what ran past the budget 8×: about 14 ms).
    const busy = (ms: number) => {
      const until = performance.now() + ms
      while (performance.now() < until) {
        // work
      }
    }
    const t = await turns(async () => {
      const s = await Slicer.start(SLICE_MS)
      busy(6)
      while (!s.due()) busy(1)
      s.note()
    })
    expect(t.worst.stepMs).toBeGreaterThanOrEqual(5.5)
    expect(t.maxScaledMs).toBeGreaterThanOrEqual(8 * 5.5)
  })
})

describe('the lifetime library in slices', () => {
  it('cold load, compaction and the book stream of the lifetime library keep every slice within budget (compaction and book stream, stretched)', async (ctx) => {
    const state = libraryState('board_01JBPR0T0SAMP1E000000BRD01', 100_000)
    const big = [...state.books.values()].find((b) => b.title === 'Book 0')?.id as string
    // Warm (a first run JIT-compiles), then stretched as on a Raspberry Pi.
    await serializeSliced(state)
    await bookStream(state, big)
    const loadBefore = loadavg()[0] ?? 0
    stretchSlices(PI)
    try {
      resetLongestSlice()
      const compaction = await turns(() => serializeSliced(state), { stretched: true })
      const compactionSlice = longestSliceCpuMs()
      resetLongestSlice()
      const stream = await turns(() => bookStream(state, big), { stretched: true })
      const streamSlice = longestSliceCpuMs()
      const out = compaction.result
      console.info(
        `lifetime library, ${PI}× stretched: compaction ${out.slices} slices, longest ` +
          `${compactionSlice.toFixed(1)} ms CPU, iteration ${compaction.maxScaledMs.toFixed(1)} ms; ` +
          `book stream of ${stream.result?.bytes} bytes, longest slice ${streamSlice.toFixed(1)} ms ` +
          `CPU, iteration ${stream.maxScaledMs.toFixed(1)} ms`,
      )
      expect(out.served.bytes).toBeLessThan(out.bytes)
      expect(out.slices).toBeGreaterThan(50)
      const load1 = Math.max(loadBefore, loadavg()[0] ?? 0)
      if (load1 >= 4) ctx.skip(`not a quiet run (load1 ${load1.toFixed(2)})`)
      // A stretched slice is its budget and the step it ends in, stretched (`coldLoad.test.ts`).
      for (const slice of [compactionSlice, streamSlice]) expect(slice).toBeLessThanOrEqual(25)
      for (const t of [compaction, stream]) expect(t.maxScaledMs).toBeLessThanOrEqual(50)
    } finally {
      stretchSlices(1)
    }
  }, 300_000)
})
