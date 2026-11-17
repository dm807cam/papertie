/**
 * The trash window of a deleted book: once a book is past its 30
 * days (`BOOK_TRASH_MS`, due for the purge, or being purged), putting it back is refused whole:
 * never a book restored with some of its paragraphs purged. A deletion sent again for a book
 * deleted already keeps the server's first date: a client never extends the window.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId, type Op, posKeysBetween, primeOpSchemas } from '@papertie/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { serverId } from '../src/ids'
import { BOOK_TRASH_MS } from '../src/limits'
import { createLogger } from '../src/log'
import { BoardStore } from '../src/store/boardStore'
import { purgeBooks } from '../src/store/bookPurge'
import { StoreError } from '../src/store/errors'
import { noFaults } from '../src/store/faults'
import { blockCreate, blockRecord, bookCreate, bookRecord, bookText } from './helpers/books'
import { FakeClock } from './helpers/clock'

const NOW = '2026-10-27T10:00:00.000Z'
let dataDir: string
let clock: FakeClock
let store: BoardStore
let user: string

beforeAll(() => {
  primeOpSchemas()
})
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'papertie-trash-'))
  clock = new FakeClock(NOW)
  user = serverId('user')
  store = new BoardStore({
    dataDir,
    clock,
    log: createLogger(() => {}),
    faults: noFaults,
    cacheSize: 32,
    idleEvictMs: 600_000,
    ringCommits: 512,
    ringBytes: 16_777_216,
    maxBoardsPerUser: 50,
    compactEveryHour: false,
  })
})
afterEach(async () => {
  await store.close()
  await rm(dataDir, { recursive: true, force: true })
})

async function withBook(paragraphs: string[]) {
  const boardId = (await store.createBoard(user, 'Board')).id
  const book = bookRecord()
  const keys = posKeysBetween(null, null, paragraphs.length)
  const blocks = paragraphs.map((t, i) => blockRecord(book.id, keys[i] as string, t))
  const ack = await store.submit(user, boardId, {
    clientId: newId('tab', clock.now().getTime()),
    seq: 1,
    baseRevision: 0,
    ops: [bookCreate(book), ...blocks.map(blockCreate)],
  })
  return { boardId, book, revision: ack.revision }
}
function client() {
  const clientId = newId('tab', clock.now().getTime())
  let seq = 0
  return (boardId: string, baseRevision: number, ops: Op[]) =>
    store.submit(user, boardId, { clientId, seq: ++seq, baseRevision, ops })
}
const stateOf = async (boardId: string) => (await store.peek(user, boardId)).state
const putBack = (id: string): Op => ({ op: 'book.update', id, set: { trashedAt: null } })
const trash = (id: string, at = NOW): Op => ({ op: 'book.update', id, set: { trashedAt: at } })

describe('the trash window', () => {
  it('put back within its 30 days: the book is back, whole', async () => {
    const { boardId, book, revision } = await withBook(['one', 'two'])
    const a = client()
    const r = await a(boardId, revision, [trash(book.id)])
    clock.advance(BOOK_TRASH_MS)
    await a(boardId, r.revision, [putBack(book.id)])
    const s = await stateOf(boardId)
    expect(s.books.get(book.id)?.trashedAt).toBeNull()
    expect(bookText(s, book.id)).toEqual(['one', 'two'])
  })

  it('put back past its 30 days (the purge due, not run yet): refused whole, and the purge takes the book', async () => {
    const { boardId, book, revision } = await withBook(['one', 'two'])
    const a = client()
    const r = await a(boardId, revision, [trash(book.id)])
    clock.advance(BOOK_TRASH_MS + 1)
    const e = await a(boardId, r.revision, [putBack(book.id)]).then(
      () => null,
      (err: unknown) => err,
    )
    expect(e).toBeInstanceOf(StoreError)
    expect((e as StoreError).code).toBe('rejected')
    expect((e as StoreError).opError?.code).toBe('conflict')
    expect((await stateOf(boardId)).books.get(book.id)?.trashedAt).not.toBeNull()
    expect(await purgeBooks(store, user, boardId, clock)).toMatchObject({ books: 1, blocks: 2 })
    expect((await stateOf(boardId)).books.has(book.id)).toBe(false)
  })

  it('a deletion sent again keeps the first date: the window is never extended', async () => {
    const { boardId, book, revision } = await withBook(['one'])
    const a = client()
    const r = await a(boardId, revision, [trash(book.id)])
    const first = (await stateOf(boardId)).books.get(book.id)?.trashedAt
    clock.advance(20 * 86_400_000)
    const again = await a(boardId, r.revision, [trash(book.id, clock.now().toISOString())])
    expect((await stateOf(boardId)).books.get(book.id)?.trashedAt).toBe(first)
    expect(again.ops).toEqual([trash(book.id, first as string)])
    // And so its 30 days end when they did: it is purged then.
    clock.advance(10 * 86_400_000 + 1)
    expect(await purgeBooks(store, user, boardId, clock)).toMatchObject({ books: 1 })
  })
  it('put back and deleted again in one batch: the new deletion is dated now, its 30 days from now', async () => {
    const { boardId, book, revision } = await withBook(['one'])
    const a = client()
    const r = await a(boardId, revision, [trash(book.id)])
    clock.advance(20 * 86_400_000)
    const now = clock.now().toISOString()
    const ack = await a(boardId, r.revision, [
      putBack(book.id),
      trash(book.id, '2001-01-01T00:00:00.000Z'),
    ])
    expect((await stateOf(boardId)).books.get(book.id)?.trashedAt).toBe(now)
    expect(ack.ops).toEqual([putBack(book.id), trash(book.id, now)])
    // Its 30 days run from now: not purged when the first deletion's would have ended.
    clock.advance(10 * 86_400_000 + 1)
    expect(await purgeBooks(store, user, boardId, clock)).toMatchObject({ books: 0 })
  })
})
