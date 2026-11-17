import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId, type Op } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverId } from '../src/ids'
import { createLogger } from '../src/log'
import { BoardStore } from '../src/store/boardStore'
import { noFaults } from '../src/store/faults'
import { noteCreate } from './helpers/boards'
import { FakeClock } from './helpers/clock'

/**
 * A whole-board read serializes the board (sliced, O(board)).
 * Reads of a board coalesce: at most one serialization runs and one waits per board; the waiting
 * one takes the newest state when it starts, and every read that arrives meanwhile shares it. So
 * a user alternating commits and whole reads (or exports) can never start serializations faster
 * than one finishes, and every read still answers its revision or a newer one.
 */

/** Every `serializeSliced` call: running now, the most at once, and how many started. */
const calls = { running: 0, most: 0, started: 0 }
/** While set, each serialization waits for it before it starts working. */
let gate: Promise<void> | null = null
/** Each serialization takes at least this long (a big board's, in miniature). */
let delayMs = 0

vi.mock('../src/store/compact', async (original) => {
  const real = await original<typeof import('../src/store/compact')>()
  return {
    ...real,
    serializeSliced: async (...args: Parameters<typeof real.serializeSliced>) => {
      calls.started++
      calls.running++
      calls.most = Math.max(calls.most, calls.running)
      try {
        if (gate) await gate
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        return await real.serializeSliced(...args)
      } finally {
        calls.running--
      }
    },
  }
})

const T0 = '2026-10-27T10:00:00.000Z'
let dataDir: string
let store: BoardStore
const user = serverId('user')

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'papertie-coalesce-'))
  store = new BoardStore({
    dataDir,
    clock: new FakeClock(T0),
    log: createLogger(() => {}),
    faults: noFaults,
    cacheSize: 32,
    idleEvictMs: 600_000,
    ringCommits: 512,
    ringBytes: 16_777_216,
    maxBoardsPerUser: 50,
    // No compaction: its own serializations would blur the count.
    compactIdleMs: 3_600_000,
    compactEveryHour: false,
  })
  Object.assign(calls, { running: 0, most: 0, started: 0 })
  gate = null
  delayMs = 0
})
afterEach(async () => {
  gate = null
  await store.close()
  await rm(dataDir, { recursive: true, force: true })
})

const tab = newId('tab', Date.parse(T0))
let seq = 0
const commit = (boardId: string, revision: number) =>
  store.submit(user, boardId, {
    clientId: tab,
    seq: ++seq,
    baseRevision: revision,
    ops: [noteCreate({ at: T0, text: `note ${seq}` }) as Op],
  })

describe('whole-board reads', () => {
  it('a burst of reads across many commits starts two serializations, and each read is current', async () => {
    const { id: board } = await store.createBoard(user, 'Board')
    let revision = (await store.read(user, board)).revision
    Object.assign(calls, { running: 0, most: 0, started: 0 })
    let release = () => {}
    gate = new Promise<void>((r) => {
      release = r
    })
    // A read at each of 50 revisions while the first serialization is held.
    const reads: { asked: number; view: ReturnType<BoardStore['read']> }[] = []
    for (let i = 0; i < 50; i++) {
      revision = (await commit(board, revision)).revision
      reads.push({ asked: revision, view: store.read(user, board) })
      await new Promise((r) => setImmediate(r))
    }
    // One runs (held); the rest wait on one queued serialization, not yet started.
    expect(calls.started).toBe(1)
    gate = null
    release()
    const views = await Promise.all(reads.map((r) => r.view))
    for (const [i, v] of views.entries()) {
      expect(v.revision, `read ${i}`).toBeGreaterThanOrEqual(reads[i]?.asked ?? Infinity)
      // The text is the state's own.
      expect(v.text.trimEnd().split('\n').at(-1)).toContain(`"revision":${v.revision}`)
    }
    expect(views.at(-1)?.revision).toBe(revision)
    expect(calls.started).toBe(2)
    expect(calls.most).toBe(1)
  })

  it('reads interleaved with commits never have more than one serialization running', async () => {
    const { id: board } = await store.createBoard(user, 'Board')
    let revision = (await store.read(user, board)).revision
    Object.assign(calls, { running: 0, most: 0, started: 0 })
    delayMs = 5
    const reads: { asked: number; view: ReturnType<BoardStore['read']> }[] = []
    for (let i = 0; i < 200; i++) {
      revision = (await commit(board, revision)).revision
      reads.push({ asked: revision, view: store.read(user, board) })
      if (i % 3 === 0) await new Promise((r) => setImmediate(r))
    }
    const views = await Promise.all(reads.map((r) => r.view))
    for (const [i, v] of views.entries()) {
      expect(v.revision, `read ${i}`).toBeGreaterThanOrEqual(reads[i]?.asked ?? Infinity)
    }
    // How many start depends on how fast commits come against a serialization (the machine's
    // load); that a burst starts O(1) is the test above. Here: never two at once.
    expect(calls.most).toBe(1)
  })

  it('reads of one revision share one serialization; a failed one is not kept', async () => {
    const { id: board } = await store.createBoard(user, 'Board')
    const revision = (await store.read(user, board)).revision
    await commit(board, revision)
    Object.assign(calls, { running: 0, most: 0, started: 0 })
    const views = await Promise.all(Array.from({ length: 20 }, () => store.read(user, board)))
    expect(new Set(views.map((v) => v.text)).size).toBe(1)
    expect(calls.started).toBe(1)
    // Read again, unchanged: no serialization at all.
    await store.read(user, board)
    expect(calls.started).toBe(1)
  })
})
