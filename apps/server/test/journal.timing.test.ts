/**
 * The journal's compaction at 100,000 notes, timed: the event loop's iterations and the slices,
 * here and on a CPU `PI`× slower (`journal.test.ts` keeps their untimed proofs: the revision, the
 * notes, every batch kept). The timing project runs them, a file at a time (`vitest.config.ts`).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'
import { type BoardState, newId, type Op, parseBoard, serializeBoard } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serverId } from '../src/ids'
import { createLogger } from '../src/log'
import { BoardStore, type BoardStoreOptions } from '../src/store/boardStore'
import { SLICE_MS, stretchSlices } from '../src/store/compact'
import { noFaults } from '../src/store/faults'
import { hugeState } from './helpers/boards'
import { FakeClock } from './helpers/clock'
import { PI, PI_MAJOR_GC_MS, turnLine, turns } from './helpers/turns'

const NOW = '2026-10-27T10:00:00.000Z'

let dataDir: string
let clock: FakeClock
let logs: string[]
let store: BoardStore
let user: string

function makeStore(over: Partial<BoardStoreOptions> = {}): BoardStore {
  return new BoardStore({
    dataDir,
    clock,
    log: createLogger((l) => logs.push(l)),
    faults: noFaults,
    cacheSize: 32,
    idleEvictMs: 600_000,
    ringCommits: 512,
    ringBytes: 16_777_216,
    maxBoardsPerUser: 50,
    // Compaction only when a test asks for it.
    compactIdleMs: 3_600_000,
    compactEveryHour: false,
    ...over,
  })
}

async function useStore(over: Partial<BoardStoreOptions> = {}): Promise<BoardStore> {
  await store.close()
  store = makeStore(over)
  return store
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'papertie-journal-'))
  clock = new FakeClock(NOW)
  logs = []
  user = serverId('user')
  store = makeStore()
})
afterEach(async () => {
  await store.close()
  await rm(dataDir, { recursive: true, force: true })
})

const tab = () => newId('tab', clock.now().getTime())
const dirOf = (boardId: string) => join(dataDir, 'users', user, 'boards', boardId)
const boardFileOf = (boardId: string) => join(dirOf(boardId), 'board.jsonl')
const text = (path: string) => readFileSync(path, 'utf8')

function fileState(boardId: string): BoardState {
  const r = parseBoard(text(boardFileOf(boardId)))
  expect(r.integrity).toBe('ok')
  if (!r.state) throw new Error('board.jsonl did not load')
  return r.state
}

function createOp(id = newId('note'), body = 'hello'): Op {
  const at = clock.now().toISOString()
  return {
    op: 'note.create',
    note: {
      type: 'note',
      id,
      x: 0,
      y: 0,
      w: 240,
      h: 160,
      z: 0,
      paper: 'cream',
      style: 'rustic',
      text: body,
      image: null,
      createdAt: at,
      updatedAt: at,
    },
  }
}

async function newBoard(): Promise<string> {
  return (await store.createBoard(user, 'Board')).id
}

/** `n` commits from one tab, each creating a note; returns the note ids. */
async function commit(boardId: string, n: number, t = tab(), from = 0): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = newId('note')
    const rev = from + i
    await store.submit(user, boardId, {
      clientId: t,
      seq: rev + 1,
      baseRevision: rev,
      ops: [createOp(id, `note ${rev + 1}`)],
    })
    ids.push(id)
  }
  return ids
}

// ---- 100,000 notes --------------------------------------------------------------------------

/** On AC power (always true off macOS, where the gate is load only). */
function onAC(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    return execFileSync('pmset', ['-g', 'ps'], { encoding: 'utf8' }).includes("'AC Power'")
  } catch {
    return false
  }
}

describe('compaction at 100,000 notes', () => {
  it('compaction never blocks the event loop for more than 50 ms on a 100,000-note board', async (ctx) => {
    const id = await newBoard()
    // 99,999 notes, and the commit in the journal makes 100,000 (the limit).
    await writeFile(boardFileOf(id), serializeBoard(hugeState(id, 99_999)))
    expect((await store.read(user, id)).state.notes.size).toBe(99_999)
    await commit(id, 1)
    // The setup's garbage (a 43 MB serialization, a load) collected first: a major collection for
    // it (16–18 ms here) would otherwise land in the compaction's first iteration. The
    // compaction's own collections are counted where they land.
    globalThis.gc?.()

    // Two views of each block: wall time (event-loop delay, inflated when other processes take
    // the CPU) and this thread's CPU time between two timer ticks (what our code holds the loop
    // for, whatever the machine's load).
    const delay = monitorEventLoopDelay({ resolution: 1 })
    let maxCpuMs = 0
    let lastCpu = process.threadCpuUsage()
    const tick = setInterval(() => {
      const cpu = process.threadCpuUsage()
      const ms = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000
      if (ms > maxCpuMs) maxCpuMs = ms
      lastCpu = cpu
    }, 1)
    // The machine's load before and after: a burst (the rest of a parallel suite) shows in the
    // 1-minute average late, so one reading after the run can call a loaded run quiet.
    const loadBefore = loadavg()[0] ?? 0
    // V8's own pauses, so a long turn names its cause in the line below.
    let gcMaxMs = 0
    const gc = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) gcMaxMs = Math.max(gcMaxMs, e.duration)
    })
    gc.observe({ entryTypes: ['gc'] })
    delay.enable()
    const result = await store.compact(user, id)
    delay.disable()
    clearInterval(tick)
    gc.disconnect()

    const wallMaxMs = delay.max / 1e6
    const wallP99Ms = delay.percentile(99) / 1e6
    const load1 = Math.max(loadBefore, loadavg()[0] ?? 0)
    const quiet = load1 < 4 && onAC()
    console.info(
      `compaction at 100,000 notes: ${result.ms.toFixed(0)} ms total, ` +
        `${(await stat(boardFileOf(id))).size} bytes, slice max ${result.maxSliceMs.toFixed(1)} ms ` +
        `(${result.maxSliceCpuMs.toFixed(1)} ms CPU), ` +
        `loop block max ${wallMaxMs.toFixed(1)} ms wall (p99 ${wallP99Ms.toFixed(1)}), ` +
        `${maxCpuMs.toFixed(1)} ms CPU, longest GC pause ${gcMaxMs.toFixed(1)} ms; ` +
        `load1 ${load1.toFixed(2)} (the higher of before and after), ${onAC() ? 'AC' : 'battery'}` +
        `${quiet ? '' : ' (not a quiet run)'}`,
    )
    expect(result.rev).toBe(1)
    expect(fileState(id).notes.size).toBe(100_000)
    // The budget is 50 ms and slices are 8 ms. Each slice's own CPU time is the code's, which
    // machine load cannot inflate (a slice ends at 8 ms of wall time, and CPU time never exceeds
    // it but by the step it was in): asserted on every run.
    expect(result.maxSliceCpuMs).toBeLessThanOrEqual(2 * SLICE_MS)
    if (!quiet) {
      ctx.skip(
        `not a quiet run (load1 ${load1.toFixed(2)}, ${onAC() ? 'AC' : 'battery'}): only the ` +
          'per-slice CPU bound was asserted',
      )
    }
    expect(result.maxSliceMs).toBeLessThanOrEqual(2 * SLICE_MS)
    expect(wallMaxMs).toBeLessThanOrEqual(50)
    // Anything near 25 ms of CPU in one iteration is a step that stopped yielding (an unsliced
    // pass over the board took 35 ms here). On a loaded machine the same step runs on a slower
    // core for longer, so this reading is a quiet run's.
    expect(maxCpuMs).toBeLessThanOrEqual(25)
  }, 300_000)

  it("large batches committed while a compaction runs (the bench's fill): no iteration over 50 ms on a CPU 8× slower", async (ctx) => {
    const id = await newBoard()
    const state = hugeState(id, 99_999)
    await writeFile(boardFileOf(id), serializeBoard(state))
    expect((await store.read(user, id)).state.notes.size).toBe(99_999)
    await commit(id, 1)
    globalThis.gc?.()
    const notes = [...state.notes.keys()]
    const long = 'ễ'.repeat(600)
    const t0 = tab()
    const loadBefore = loadavg()[0] ?? 0
    const t = await turns(async () => {
      const compaction = store.compact(user, id)
      // Eight batches of 400 notes rewritten, as a seeding run fills the journal: each one
      // commit (validated, applied, journaled and acked as a whole).
      for (let b = 0; b < 8; b++) {
        await store.submit(user, id, {
          clientId: t0,
          seq: b + 1,
          baseRevision: 1 + b,
          ops: notes
            .slice(b * 400, (b + 1) * 400)
            .map((n, i) => ({ op: 'note.update', id: n, set: { text: `${long}${i}` } })),
        })
      }
      return compaction
    })
    const load1 = Math.max(loadBefore, loadavg()[0] ?? 0)
    const quiet = load1 < 4 && onAC()
    console.info(
      `compaction at 100,000 notes with 8 batches of 400 long notes meanwhile: ${turnLine(t)}; ` +
        `load1 ${load1.toFixed(2)}, ${onAC() ? 'AC' : 'battery'}${quiet ? '' : ' (not a quiet run)'}`,
    )
    expect(t.result.rev).toBe(1)
    // Every batch is in, live and after a restart (the journal passed 4 MiB with them, so a second
    // compaction may have folded them in by then).
    const check = (view: Awaited<ReturnType<typeof store.read>>) => {
      expect(view.revision).toBe(9)
      for (let i = 0; i < 3200; i++) {
        expect(view.state.notes.get(notes[i] as string)?.text).toBe(`${long}${i % 400}`)
      }
      expect(view.state.notes.get(notes[3200] as string)?.text).not.toContain(long)
    }
    check(await store.read(user, id))
    await useStore()
    check(await store.read(user, id))
    expect(t.maxCpuMs).toBeLessThanOrEqual(50)
    if (!quiet) {
      ctx.skip(
        `not a quiet run (load1 ${load1.toFixed(2)}, ${onAC() ? 'AC' : 'battery'}): only the ` +
          'iteration CPU bound was asserted',
      )
    }
    expect(t.maxScaledMs).toBeLessThanOrEqual(50)
    // With a batch's commit beside the compaction an iteration holds 11–12 ms (counted 8×)
    // besides GC: a 40 ms mark-compact landing in one would make it 51–52 (see the compaction's
    // own bound below, which leaves the room).
  }, 300_000)

  // Stretched, 5×; counted, a Raspberry Pi's 8×: what ran past each slice's
  // budget, the rest and every GC pause.
  for (const [how, stretched, pi] of [
    ['every slice stretched 5×', true, 5],
    ['the rest, slice overruns and every GC pause counted 8×', false, PI],
  ] as const)
    it(`on a slower CPU too (${how}): no iteration over 50 ms`, async (ctx) => {
      const id = await newBoard()
      await writeFile(boardFileOf(id), serializeBoard(hugeState(id, 99_999)))
      expect((await store.read(user, id)).state.notes.size).toBe(99_999)
      await commit(id, 1)
      globalThis.gc?.()
      const loadBefore = loadavg()[0] ?? 0
      if (stretched) stretchSlices(pi)
      let t: Awaited<ReturnType<typeof turns<Awaited<ReturnType<typeof store.compact>>>>>
      try {
        t = await turns(() => store.compact(user, id), { stretched, pi })
      } finally {
        stretchSlices(1)
      }
      const result = t.result
      const load1 = Math.max(loadBefore, loadavg()[0] ?? 0)
      const quiet = load1 < 4 && onAC()
      console.info(
        `compaction at 100,000 notes${stretched ? `, slices stretched ${pi}×` : ''}: ` +
          `${result.ms.toFixed(0)} ms total, slice max ${result.maxSliceMs.toFixed(1)} ms ` +
          `(${result.maxSliceCpuMs.toFixed(1)} ms CPU), ${turnLine(t)}; ` +
          `load1 ${load1.toFixed(2)}, ${onAC() ? 'AC' : 'battery'}` +
          `${quiet ? '' : ' (not a quiet run)'}`,
      )
      expect(result.rev).toBe(1)
      expect(fileState(id).notes.size).toBe(100_000)
      // A stretched slice still ends at its budget: its CPU time is the work's own.
      expect(result.maxSliceCpuMs).toBeLessThanOrEqual(2 * SLICE_MS)
      // What is not sliced is counted so, and a loaded machine's slower cores inflate it.
      if (!quiet) {
        ctx.skip(
          `not a quiet run (load1 ${load1.toFixed(2)}, ${onAC() ? 'AC' : 'battery'}): only the ` +
            'per-slice CPU bound was asserted',
        )
      }
      expect(t.maxScaledMs).toBeLessThanOrEqual(50)
      // Room for a Raspberry Pi's longest major collection in any iteration (5999866, its run 9: a slice
      // and a 40.7 ms mark-compact inside it held the loop for 50.7 ms). 8 ms slices left 13.5 ms
      // besides GC (53.5 with it); 4 ms slices leave 9. A 10 ms margin counted 8× is 1.25 ms of
      // CPU here, which a parallel suite's load (load1 near 4) can take by itself from one
      // iteration's bookkeeping: this reading is a very quiet run's (load1 < 2.5).
      if (!stretched && load1 < 2.5) {
        expect(t.maxScaledNoGcMs + PI_MAJOR_GC_MS).toBeLessThanOrEqual(50)
      }
    }, 300_000)
})
