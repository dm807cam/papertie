/**
 * The book commits' timed row: an iteration of the purge on a CPU `PI`× slower (`books.test.ts`
 * keeps its untimed proof: the purge's commits of 500): the timing project runs it, a file at a
 * time (`vitest.config.ts`).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId, type Op, posKeysBetween, primeOpSchemas } from '@papertie/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { serverId } from '../src/ids'
import { BOOK_TRASH_MS } from '../src/limits'
import { createLogger } from '../src/log'
import { BoardStore, type BoardStoreOptions, type CommitEvent } from '../src/store/boardStore'
import { purgeBooks } from '../src/store/bookPurge'
import { noFaults } from '../src/store/faults'
import { blockCreate, blockRecord, bookCreate, bookRecord } from './helpers/books'
import { FakeClock } from './helpers/clock'
import { turns } from './helpers/turns'

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
    compactEveryHour: false,
    ...over,
  })
}

// As the app does when it opens (`openApp`).
beforeAll(() => {
  primeOpSchemas()
})

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'papertie-books-'))
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

/** A board with one book of the given paragraphs; the book, its block ids and the revision. */
async function withBook(paragraphs: string[]) {
  const boardId = (await store.createBoard(user, 'Board')).id
  const book = bookRecord()
  const keys = posKeysBetween(null, null, paragraphs.length)
  const blocks = paragraphs.map((t, i) => blockRecord(book.id, keys[i] as string, t))
  const ack = await store.submit(user, boardId, {
    clientId: tab(),
    seq: 1,
    baseRevision: 0,
    ops: [bookCreate(book), ...blocks.map(blockCreate)],
  })
  return { boardId, book, ids: blocks.map((b) => b.id), keys, revision: ack.revision }
}

async function stateOf(boardId: string) {
  return (await store.peek(user, boardId)).state
}

/** The page: its client id and next seq. */
function client() {
  const clientId = tab()
  let seq = 0
  return (boardId: string, baseRevision: number, ops: Op[]) =>
    store.submit(user, boardId, { clientId, seq: ++seq, baseRevision, ops })
}

describe('the purge of deleted books', () => {
  it('the purge commits at most 500 blocks per commit, with a pause between, then the book', async () => {
    const n = 2_300
    const { boardId, book, ids, revision } = await withBook(
      Array.from({ length: n }, (_, i) => `paragraph ${i}`),
    )
    await client()(boardId, revision, [{ op: 'book.update', id: book.id, set: { trashedAt: NOW } }])
    const commits: CommitEvent[] = []
    let iteration = 0
    const ticks: number[] = []
    const tick = setInterval(() => iteration++, 0)
    await store.subscribe(user, boardId, (e) => {
      if (e.type === 'commit') {
        commits.push(e.commit)
        ticks.push(iteration)
      }
    })
    try {
      // Not due yet: nothing happens.
      clock.advance(BOOK_TRASH_MS - 1)
      expect(await purgeBooks(store, user, boardId, clock)).toEqual({
        deferred: false,
        books: 0,
        blocks: 0,
      })
      clock.advance(2)
      const t = await turns(() => purgeBooks(store, user, boardId, clock))
      expect(t.result).toEqual({ deferred: false, books: 1, blocks: n })
      expect(t.maxScaledMs).toBeLessThanOrEqual(50)
    } finally {
      clearInterval(tick)
    }
    const sizes = commits.map((c) =>
      c.ops.map((op) => (op.op === 'block.purge' ? op.ids.length : op.op)).join(','),
    )
    expect(sizes).toEqual(['500', '500', '500', '500', 'book.purge'])
    // Each commit in an iteration of its own.
    expect(new Set(ticks).size).toBe(ticks.length)
    const s = await stateOf(boardId)
    expect(s.books.has(book.id)).toBe(false)
    expect([...s.blocks.values()].some((b) => b.bookId === book.id)).toBe(false)
    expect(ids.length).toBe(n)
  })
})
