/**
 * The asset sweep's wall-time and CPU rows (`assetSweep.test.ts` keeps their untimed proofs: what
 * is removed and kept, an unloaded board left unloaded): the timing project runs them, a file at
 * a time (`vitest.config.ts`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { type Asset, type Note, newId, serializeBoard, stateFromRecords } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ASSET_SIZES } from '../src/limits'
import { backupName } from '../src/store/backups'
import { boardDir, boardFile, createBoard, hugeState } from './helpers/boards'
import type { TestUser } from './helpers/client'
import { FakeClock } from './helpers/clock'
import { startTestServer, type TestServer } from './helpers/harness'

const T0 = '2026-10-01T10:00:00.000Z'
const DAY_MS = 86_400_000

let server: TestServer
let user: TestUser
let board: string
/** Data dirs a test made itself (`startTestServer` removes only its own). */
const owned: string[] = []

async function start(dataDir?: string, at = T0) {
  server = await startTestServer({
    clock: new FakeClock(at),
    // Backups come only from the compactions these tests make.
    config: { store: { compactEveryHour: false } },
    ...(dataDir ? { dataDir } : {}),
  })
}

beforeEach(async () => {
  await start()
  user = server.user
  board = await createBoard(user)
})
afterEach(async () => {
  await server.close()
  for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true })
})

const deps = () => {
  const { store, quota, log } = server.deps
  if (!store || !quota) throw new Error('the server has no store or quota')
  return { store, quota, log }
}

/** The board's asset sweep through the server's sweeper, after any run a load or compaction began. */
const sweep = async (boardId = board) => {
  await server.assets.settled()
  return server.assets.sweep(user.id, boardId)
}

/** On AC power (always true off macOS, where the gate is load only). */
function onAC(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    return execFileSync('pmset', ['-g', 'ps'], { encoding: 'utf8' }).includes("'AC Power'")
  } catch {
    return false
  }
}

/** A 100,000-note board on disk, unloaded: 5,000 notes show 12 photos, and `extra` are shown by none. */
async function hugeBoardOnDisk(extra: number) {
  const at = server.clock.now().toISOString()
  const photo = (): Asset => ({
    type: 'asset',
    id: newId('asset', server.clock.now().getTime()),
    mime: 'image/webp',
    width: 64,
    height: 48,
    bytes: 100,
    sha256: '0'.repeat(64),
    createdAt: at,
  })
  const shown = Array.from({ length: 12 }, photo)
  const loose = Array.from({ length: extra }, photo)
  const huge = hugeState(board, 100_000, at)
  const notes = [...huge.notes.values()].map(
    (n, i): Note =>
      i % 20 === 0
        ? { ...n, image: { assetId: (shown[(i / 20) % 12] as Asset).id, frame: 'print' } }
        : n,
  )
  const records = [...shown, ...loose]
  const text = serializeBoard(
    stateFromRecords(huge.board, [...records, ...notes, ...huge.yarns.values()]),
  )
  const dir = boardDir(server, user.id, board)
  await writeFile(boardFile(server, user.id, board), text)
  for (const a of records) {
    await mkdir(join(dir, 'assets', a.id))
    for (const size of ASSET_SIZES) {
      await writeFile(join(dir, 'assets', a.id, `${size}.webp`), Buffer.alloc(100))
    }
  }
  return { dir, text, notes, records, huge, loose }
}

/** How long the event loop is held while `fn` runs: wall (event-loop delay) and CPU per turn. */
async function holding<T>(fn: () => Promise<T>) {
  const delay = monitorEventLoopDelay({ resolution: 1 })
  let maxCpuMs = 0
  let lastCpu = process.threadCpuUsage()
  const tick = setInterval(() => {
    const cpu = process.threadCpuUsage()
    const ms = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000
    if (ms > maxCpuMs) maxCpuMs = ms
    lastCpu = cpu
  }, 1)
  const loadBefore = loadavg()[0] ?? 0
  delay.enable()
  const t0 = performance.now()
  const result = await fn()
  const ms = performance.now() - t0
  delay.disable()
  clearInterval(tick)
  const load1 = Math.max(loadBefore, loadavg()[0] ?? 0)
  return { result, ms, wallMaxMs: delay.max / 1e6, maxCpuMs, load1, quiet: load1 < 4 && onAC() }
}

describe('the sweep at 100,000 notes', () => {
  it('sweeping a loaded 100,000-note board (loaded before the run) holds the event loop ≤ 50 ms, with three full backups read', async () => {
    // One more photo shown only by the oldest backup, one shown by nothing, and one directory
    // with no record: every backup is read to its end.
    const { dir, text: live, notes, records, huge, loose } = await hugeBoardOnDisk(2)
    const [old, doomed] = loose as [Asset, Asset]
    const first = notes[1] as Note
    const then = serializeBoard(
      stateFromRecords(huge.board, [
        ...records,
        { ...first, image: { assetId: old.id, frame: 'print' } },
        ...notes.filter((n) => n.id !== first.id),
        ...huge.yarns.values(),
      ]),
    )
    for (const [i, text] of [then, live, live].entries()) {
      const t = new Date(server.clock.now().getTime() - (3 - i) * 3_600_000)
      await writeFile(join(dir, 'backups', backupName(t, 0)), text)
    }
    const orphan = newId('asset', server.clock.now().getTime())
    await mkdir(join(dir, 'assets', orphan))
    await writeFile(join(dir, 'assets', orphan, '256.webp'), Buffer.alloc(300))
    // Measured on a loaded board: an unloaded one is never swept (the next test).
    expect((await deps().store.read(user.id, board)).state.notes.size).toBe(100_000)
    await server.assets.settled()
    server.clock.advance(31 * DAY_MS)

    const run = await holding(() => sweep())
    console.info(
      `asset sweep at 100,000 notes (board loaded before the run): ${run.ms.toFixed(0)} ms ` +
        `total for ${4 * live.length} chars read, loop block max ${run.wallMaxMs.toFixed(1)} ms ` +
        `wall, ${run.maxCpuMs.toFixed(1)} ms CPU; load1 ${run.load1.toFixed(2)}, ` +
        `${onAC() ? 'AC' : 'battery'}${run.quiet ? '' : ' (not a quiet run: wall time is reported, not asserted)'}`,
    )
    expect(run.result).toEqual({ removed: [doomed.id], freedBytes: 300 })
    expect(existsSync(join(dir, 'assets', old.id))).toBe(true)
    expect(run.maxCpuMs).toBeLessThanOrEqual(25)
    if (run.quiet) expect(run.wallMaxMs).toBeLessThanOrEqual(50)
  }, 300_000)

  it('an unloaded 100,000-note board is not loaded by the sweep, and is swept after its next load', async () => {
    const { dir, loose } = await hugeBoardOnDisk(1)
    const [doomed] = loose as [Asset]
    const { store } = deps()
    expect(store.isCached(user.id, board)).toBe(false)
    server.clock.advance(31 * DAY_MS)

    const loads = store.stats.loads
    const rss = process.memoryUsage().rss
    const run = await holding(() => sweep())
    const grew = (process.memoryUsage().rss - rss) / 1_048_576
    console.info(
      `asset sweep of an unloaded 100,000-note board: ${run.ms.toFixed(1)} ms, ` +
        `RSS +${grew.toFixed(0)} MB, loop block max ${run.maxCpuMs.toFixed(1)} ms CPU`,
    )
    expect(run.result).toEqual({ removed: [], freedBytes: 0, deferred: true })
    expect(store.stats.loads).toBe(loads)
    expect(store.isCached(user.id, board)).toBe(false)
    // Nothing read: a load would take hundreds of ms and hundreds of MB.
    expect(run.ms).toBeLessThan(50)
    expect(grew).toBeLessThan(50)
    expect(run.maxCpuMs).toBeLessThanOrEqual(25)

    // Its next load (a user opening it) starts the sweep, off the request path.
    await store.since(user.id, board, 0)
    expect(store.stats.loads).toBe(loads + 1)
    await new Promise((resolve) => setImmediate(resolve))
    await server.assets.settled()
    expect((await store.read(user.id, board)).state.assets.has(doomed.id)).toBe(false)
    expect(existsSync(join(dir, 'assets', doomed.id))).toBe(true)
  }, 300_000)
})
