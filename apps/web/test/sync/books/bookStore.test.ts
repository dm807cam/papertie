/**
 * The book store (`sync/books/bookStore.ts`): a book is held from the book route at the revision
 * that read it; the selectors read the one board's books.
 */
import { trashedBooks } from '../../../src/book/trashedBooks'
import { blocksOfBook, createBookStore, shelfBooks } from '../../../src/sync/books/bookStore'
import { BOOK, BOOK2, book, bookServer, para, textOf, typeAt } from '../../helpers/books'
import { apiError, connect, FakeServer, type Harness, settle, T0 } from '../../helpers/fakeServer'

const started: Harness[] = []
async function start(server: FakeServer) {
  const h = connect(server)
  started.push(h)
  await h.client.start()
  return h
}
const storeOf = (h: Harness) => createBookStore({ client: h.client })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
})
afterEach(() => {
  for (const h of started.splice(0)) h.client.stop()
  vi.useRealTimers()
})

describe('bookStore', () => {
  it('an open book is read and held', async () => {
    const server = bookServer(new FakeServer(), ['some text'])
    const a = await start(server)
    const books = storeOf(a)
    expect(await books.open(BOOK)).toBe(true)
    expect(a.transport.bookCalls).toEqual([BOOK])
    expect(textOf(a.client.view, 1)).toBe('some text')
    // Open already: no second read.
    expect(await books.open(BOOK)).toBe(true)
    expect(a.transport.bookCalls).toEqual([BOOK])
  })

  it('a close keeps it held while its edits wait, then lets go', async () => {
    const server = bookServer(new FakeServer(), ['abc'])
    const a = await start(server)
    const books = storeOf(a)
    await books.open(BOOK)
    a.client.submit([typeAt(1, 3, 'd')], { coalesceKey: `block:${para(1)}` })
    books.close(BOOK)
    await vi.advanceTimersByTimeAsync(0)
    expect(textOf(a.client.view, 1)).toBe('abcd') // still held: its edit waits
    await settle(server, a)
    books.changed(a.client.confirmed)
    await vi.advanceTimersByTimeAsync(0)
    expect(a.client.confirmed.blocks.size).toBe(0) // committed, so let go
    expect(textOf(server.state, 1)).toBe('abcd')
  })

  it('the shelf: live books in shelf order, deleted ones newest first, blocks only when held', async () => {
    const books = new Map([
      [BOOK, book(BOOK, { shelfPos: 'W' })],
      [BOOK2, book(BOOK2, { shelfPos: 'V' })],
      [
        'book_00000000000000000000000003',
        book('book_00000000000000000000000003', { trashedAt: T0 }),
      ],
      [
        'book_00000000000000000000000004',
        book('book_00000000000000000000000004', { trashedAt: '2026-10-31T09:00:00.000Z' }),
      ],
    ])
    expect(shelfBooks(books).map((b) => b.id)).toEqual([BOOK2, BOOK])
    expect(shelfBooks(books)).toBe(shelfBooks(books))
    expect(trashedBooks(books).map((b) => b.id.slice(-1))).toEqual(['4', '3'])
    const server = bookServer(new FakeServer(), ['x'])
    expect(blocksOfBook(server.state, BOOK)?.map((b) => b.id)).toEqual([para(1)])
    expect(blocksOfBook(server.served, BOOK)).toBeNull()
  })
})

describe('bookStore, a book that could not be read', () => {
  it('a failed read: read again after a backoff, longer each time, until it is held', async () => {
    const server = bookServer(new FakeServer(), ['far text'])
    const a = await start(server)
    const books = storeOf(a)
    a.transport.failNextBook(apiError(503, 'http-503'), 2)
    expect(await books.open(BOOK)).toBe(false)
    expect(a.transport.bookCalls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.transport.bookCalls).toHaveLength(2)
    expect(a.client.confirmed.blocks.size).toBe(0)
    await vi.advanceTimersByTimeAsync(1999)
    expect(a.transport.bookCalls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(a.transport.bookCalls).toHaveLength(3)
    expect(textOf(a.client.view, 1)).toBe('far text')
  })

  it('read stale three times: read again after a backoff, and held then, its words all there', async () => {
    const server = bookServer(new FakeServer(), ['far text'])
    const a = await start(server)
    const books = storeOf(a)
    let stale = 3
    // The book changes as each read is answered: each read is stale.
    a.transport.afterBookRead = () => {
      if (stale-- > 0) server.commit([typeAt(1, 0, 'x')])
    }
    expect(await books.open(BOOK)).toBe(false)
    expect(a.transport.bookCalls).toHaveLength(3)
    expect(a.client.confirmed.blocks.size).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.transport.bookCalls).toHaveLength(4)
    expect(textOf(a.client.view, 1)).toBe('xxxfar text')
  })

  it('a book closed while it could not be read is not read again', async () => {
    const server = bookServer(new FakeServer(), ['far text'])
    const a = await start(server)
    const books = storeOf(a)
    a.transport.failNextBook(apiError(503, 'http-503'))
    expect(await books.open(BOOK)).toBe(false)
    books.close(BOOK)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(a.transport.bookCalls).toHaveLength(1)
  })
})
