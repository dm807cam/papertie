import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeBoard } from '@papertie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serverId } from '../src/ids'
import { createLogger } from '../src/log'
import { BoardStore } from '../src/store/boardStore'
import {
  longestSliceCpuMs,
  resetLongestSlice,
  SLICE_MS,
  slicedCpuMs,
  stretchSlices,
} from '../src/store/compact'
import { noFaults } from '../src/store/faults'
import { TILE } from '../src/store/region'
import { hugeState } from './helpers/boards'
import { FakeClock } from './helpers/clock'

/**
 * A region answer at the densest viewport a board open asks for:
 * 64 tiles of the 100,000-note grid board hold 13,970 notes, 21–31 ms of `regionText` in one turn
 * on a Mac, so over 100 ms on a CPU 5× slower. It is built in slices now. Its CPU split, slices
 * and iterations: the timing project runs these, a file at a time (`regionSliced.test.ts` keeps
 * the answer's untimed proof, its notes).
 */

const PI = 5

function onAC(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    return execFileSync('pmset', ['-g', 'ps'], { encoding: 'utf8' }).includes("'AC Power'")
  } catch {
    return false
  }
}

let dataDir: string
let store: BoardStore
const user = serverId('user')
let board: string
/** The densest 64-tile viewport of the grid board: the origin's. */
const RECT = { x0: 0, y0: 0, x1: 8 * TILE, y1: 8 * TILE }

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'papertie-region-'))
  store = new BoardStore({
    dataDir,
    clock: new FakeClock(),
    log: createLogger(() => {}),
    faults: noFaults,
    cacheSize: 4,
    idleEvictMs: 600_000,
    ringCommits: 64,
    ringBytes: 1_048_576,
    maxBoardsPerUser: 5,
    compactIdleMs: 3_600_000,
    compactEveryHour: false,
  })
  board = (await store.createBoard(user, 'Board')).id
  await store.close()
  await writeFile(
    join(dataDir, 'users', user, 'boards', board, 'board.jsonl'),
    serializeBoard(hugeState(board, 100_000)),
  )
  store = new BoardStore({
    dataDir,
    clock: new FakeClock(),
    log: createLogger(() => {}),
    faults: noFaults,
    cacheSize: 4,
    idleEvictMs: 600_000,
    ringCommits: 64,
    ringBytes: 1_048_576,
    maxBoardsPerUser: 5,
    compactIdleMs: 3_600_000,
    compactEveryHour: false,
  })
  // Loaded (and warmed: one answer) before anything is measured.
  await store.region(user, board, RECT)
}, 120_000)
afterAll(async () => {
  await store.close()
  await rm(dataDir, { recursive: true, force: true })
})

/** One region answer, each event-loop iteration's CPU time split into the slices' and the rest. */
async function answer() {
  let maxCpuMs = 0
  let maxScaledMs = 0
  let lastCpu = process.threadCpuUsage()
  let lastSliced = slicedCpuMs()
  const tick = setInterval(() => {
    const cpu = process.threadCpuUsage()
    const ms = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000
    const sliced = slicedCpuMs() - lastSliced
    maxCpuMs = Math.max(maxCpuMs, ms)
    maxScaledMs = Math.max(maxScaledMs, sliced + PI * Math.max(0, ms - sliced))
    lastCpu = cpu
    lastSliced = slicedCpuMs()
  }, 1)
  const loadBefore = loadavg()[0] ?? 0
  resetLongestSlice()
  const cpu0 = process.threadCpuUsage()
  const sliced0 = slicedCpuMs()
  const r = await store.region(user, board, RECT)
  const cpu1 = process.threadCpuUsage()
  const totalMs = (cpu1.user - cpu0.user + cpu1.system - cpu0.system) / 1000
  const slicedMs = slicedCpuMs() - sliced0
  clearInterval(tick)
  const load1 = Math.max(loadBefore, loadavg()[0] ?? 0)
  const notes = r.text.split('\n').filter((l) => l.startsWith('{"type":"note"')).length
  const longest = longestSliceCpuMs()
  return {
    notes,
    totalMs,
    slicedMs,
    longest,
    maxCpuMs,
    maxScaledMs,
    load1,
    quiet: load1 < 4 && onAC(),
  }
}

const line = (what: string, r: Awaited<ReturnType<typeof answer>>) =>
  `${what}: ${r.notes} notes, ${r.totalMs.toFixed(1)} ms CPU (${r.slicedMs.toFixed(1)} in slices), ` +
  `iteration max ${r.maxCpuMs.toFixed(1)} ms CPU (${r.maxScaledMs.toFixed(1)} ms on a CPU ${PI}× ` +
  `slower), longest slice ${r.longest.toFixed(1)} ms CPU; load1 ${r.load1.toFixed(2)}, ${onAC() ? 'AC' : 'battery'}`

describe('region answer at the densest viewport', () => {
  it('is built in slices: nearly all its CPU time is in them', async (ctx) => {
    const r = await answer()
    console.info(line('region answer', r))
    expect(r.notes).toBe(13_970)
    // The work's own split, whatever the machine's load: what is outside the slices is the
    // index search and the lock, a few percent.
    expect(r.slicedMs).toBeGreaterThanOrEqual(0.8 * r.totalMs)
    expect(r.longest).toBeLessThanOrEqual(2 * SLICE_MS)
    if (!r.quiet)
      ctx.skip(
        `not a quiet run (load1 ${r.load1.toFixed(2)}, AC ${onAC()}): wall-free CPU split asserted, iteration bound not`,
      )
    expect(r.maxCpuMs).toBeLessThanOrEqual(2 * SLICE_MS + 5)
  })

  it(`on a CPU ${PI}× slower too: no iteration over 50 ms`, async (ctx) => {
    stretchSlices(PI)
    let r: Awaited<ReturnType<typeof answer>>
    try {
      r = await answer()
    } finally {
      stretchSlices(1)
    }
    console.info(line(`region answer, slices stretched ${PI}×`, r))
    expect(r.notes).toBe(13_970)
    expect(r.slicedMs).toBeGreaterThanOrEqual(0.8 * r.totalMs)
    // A stretched slice is its budget and the step it ends in, 5× as long; a young-generation
    // collection inside a step (1–2.5 ms here) is stretched too (as in coldLoad.test.ts): half of
    // an iteration's 50 ms is the bound.
    expect(r.longest).toBeLessThanOrEqual(25)
    if (!r.quiet)
      ctx.skip(
        `not a quiet run (load1 ${r.load1.toFixed(2)}, AC ${onAC()}): the count for a slower CPU is not asserted`,
      )
    expect(r.maxScaledMs).toBeLessThanOrEqual(50)
  })
})
