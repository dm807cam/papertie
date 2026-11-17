import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serverId } from '../src/ids'
import { createLogger } from '../src/log'
import { BoardStore } from '../src/store/boardStore'
import { noFaults } from '../src/store/faults'
import { FakeClock } from './helpers/clock'

/**
 * `engines` allows Node 22.12 and later; `process.threadCpuUsage` came in Node 23.9. Production
 * code must work without it.
 */

const real = process.threadCpuUsage
let dataDir: string | null = null

afterEach(async () => {
  process.threadCpuUsage = real
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  dataDir = null
})

describe('on a Node without process.threadCpuUsage', () => {
  it('a board is created, loaded, written and compacted', async () => {
    // As on Node 22: the property is not there at all.
    delete (process as { threadCpuUsage?: unknown }).threadCpuUsage
    expect(typeof process.threadCpuUsage).toBe('undefined')
    dataDir = await mkdtemp(join(tmpdir(), 'papertie-node22-'))
    const opts = {
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
    }
    const user = serverId('user')
    let store = new BoardStore(opts)
    const { id } = await store.createBoard(user, 'Board')
    await store.submitServer(user, id, [
      {
        op: 'note.create',
        note: {
          type: 'note',
          id: serverId('note'),
          x: 0,
          y: 0,
          w: 240,
          h: 160,
          z: 0,
          paper: 'cream',
          style: 'rustic',
          text: 'still here',
          image: null,
          createdAt: '2026-10-27T10:00:00.000Z',
          updatedAt: '2026-10-27T10:00:00.000Z',
        },
      },
    ])
    await store.close()
    // A cold load (sliced) and a compaction (sliced) on a fresh store.
    store = new BoardStore(opts)
    expect((await store.read(user, id)).state.notes.size).toBe(1)
    expect((await store.compact(user, id)).rev).toBe(1)
    expect((await store.region(user, id, { x0: 0, y0: 0, x1: 100, y1: 100 })).text).toContain(
      'still here',
    )
    await store.close()
  })
})
