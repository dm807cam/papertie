import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverId } from '../src/ids'
import { createLogger } from '../src/log'
import { BoardStore, type BoardStoreOptions } from '../src/store/boardStore'
import { SnapshotRefused } from '../src/store/compact'
import { noFaults } from '../src/store/faults'
import { parseJournal } from '../src/store/journal'
import { blockCreate, blockRecord, bookCreate, bookRecord, edit, ins } from './helpers/books'
import { FakeClock } from './helpers/clock'

/**
 * A compaction the serializer refuses (`SnapshotRefused`): the journal is kept, a
 * restart replays it, the failure is logged once (not per commit), and a whole read fails cleanly.
 * The refusal is forced here: a server's own states always hold every block.
 */
const refuse = vi.hoisted(() => ({ on: false }))
vi.mock('../src/store/compact', async (actual) => {
  const m = await actual<typeof import('../src/store/compact')>()
  return {
    ...m,
    serializeSliced: async (...args: Parameters<typeof m.serializeSliced>) => {
      if (refuse.on) throw new m.SnapshotRefused('blocks-not-held', 'refused for the test')
      return m.serializeSliced(...args)
    },
  }
})

const NOW = '2026-10-27T10:00:00.000Z'
let dataDir: string
let logs: string[]
let store: BoardStore
const clock = new FakeClock(NOW)
const user = serverId('user')

function makeStore(): BoardStore {
  const opts: BoardStoreOptions = {
    dataDir,
    clock,
    log: createLogger((l) => logs.push(l)),
    faults: noFaults,
    cacheSize: 8,
    idleEvictMs: 600_000,
    ringCommits: 512,
    ringBytes: 16_777_216,
    maxBoardsPerUser: 5,
    compactEveryHour: false,
    // Every commit asks for a compaction at once.
    journalMaxCommits: 1,
  }
  return new BoardStore(opts)
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'papertie-refused-'))
  logs = []
  refuse.on = false
  store = makeStore()
})
afterEach(async () => {
  refuse.on = false
  await store.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe('a refused compaction', () => {
  it('keeps the journal, logs once, answers a read with a clean error, and a restart replays it', async () => {
    const boardId = (await store.createBoard(user, 'B')).id
    const dir = join(dataDir, 'users', user, 'boards', boardId)
    const book = bookRecord()
    const block = blockRecord(book.id, 'V', 'kept')
    const tab = newId('tab', clock.now().getTime())
    refuse.on = true
    const r1 = await store.submit(user, boardId, {
      clientId: tab,
      seq: 1,
      baseRevision: 0,
      ops: [bookCreate(book), blockCreate(block)],
    })
    const r2 = await store.submit(user, boardId, {
      clientId: tab,
      seq: 2,
      baseRevision: r1.revision,
      ops: [edit(book.id, block.id, [ins(4, ' safe')])],
    })
    // Give the background compactions their turns.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    const failed = logs.filter((l) => l.includes('compaction failed'))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain('blocks-not-held')
    expect(failed[0]).not.toContain('kept')
    // The journal holds both commits; the snapshot is the empty board still.
    const journal = parseJournal(readFileSync(join(dir, 'journal.jsonl')))
    expect(journal.entries.filter((e) => e.kind === 'commit').map((e) => e.rev)).toEqual([
      r1.revision,
      r2.revision,
    ])
    expect(readFileSync(join(dir, 'board.jsonl'), 'utf8')).not.toContain('"type":"book"')
    expect(existsSync(join(dir, 'board.jsonl.next'))).toBe(false)
    // A whole read fails with the refusal itself (the route's 500), never a file without blocks.
    await expect(store.read(user, boardId)).rejects.toBeInstanceOf(SnapshotRefused)

    refuse.on = false
    await store.close()
    store = makeStore()
    const s = (await store.peek(user, boardId)).state
    expect(s.board.revision).toBe(r2.revision)
    expect(s.blocks.get(block.id)?.text).toBe('kept safe')
    expect((await store.read(user, boardId)).text).toContain('"type":"book"')
  })
})
