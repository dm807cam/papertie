import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeBoard } from '@papertie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serverId } from '../src/ids'
import { createLogger } from '../src/log'
import { BoardStore } from '../src/store/boardStore'
import { stretchSlices } from '../src/store/compact'
import { noFaults } from '../src/store/faults'
import { TILE } from '../src/store/region'
import { hugeState } from './helpers/boards'
import { FakeClock } from './helpers/clock'

/**
 * A region answer at the densest viewport a board open asks for:
 * 64 tiles of the 100,000-note grid board hold 13,970 notes, 21–31 ms of `regionText` in one turn
 * on a Mac, so over 100 ms on a CPU 5× slower. It is built in slices now. Here the answer; its
 * CPU split, slices and iterations are the timing rows' (`regionSliced.timing.test.ts`).
 */

const PI = 5

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

/** The notes of one region answer. */
async function answer() {
  const r = await store.region(user, board, RECT)
  return { notes: r.text.split('\n').filter((l) => l.startsWith('{"type":"note"')).length }
}

describe('region answer at the densest viewport', () => {
  it('is built in slices: nearly all its CPU time is in them', async () => {
    expect((await answer()).notes).toBe(13_970)
  })

  it(`on a CPU ${PI}× slower too: no iteration over 50 ms`, async () => {
    stretchSlices(PI)
    let r: Awaited<ReturnType<typeof answer>>
    try {
      r = await answer()
    } finally {
      stretchSlices(1)
    }
    expect(r.notes).toBe(13_970)
  })
})
