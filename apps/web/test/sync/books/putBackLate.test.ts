/**
 * Putting a book back too late (minor 3): past its 30 days the server refuses it
 * whole, and so does the shelf before it asks. Either way the user is told it is too late, in
 * words of its own: never the refused-change slip, and nothing for the unsaved-changes download
 * (a put back holds no words).
 */
import { applyBatch, emptyBoardState } from '@papertie/core'
import { openLocalSession } from '../../../src/app/session'
import { restoreBook } from '../../../src/book/shelfActions'
import { tooLateMessage } from '../../../src/sync/notices'
import { BOOK, book, bookServer, para, typeAt, unsavedText } from '../../helpers/books'
import { BOARD_ID, connect, FakeServer, settle, T0 } from '../../helpers/fakeServer'

const DAY = 86_400_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a book put back too late', () => {
  it('refused by the server: said too late, no refused-change slip, nothing to download', async () => {
    const server = bookServer(new FakeServer(), ['kept'])
    server.commit([{ op: 'book.update', id: BOOK, set: { trashedAt: T0 } }])
    vi.setSystemTime(Date.parse(T0) + 31 * DAY)
    const a = connect(server)
    await a.client.start()
    a.client.submit([{ op: 'book.update', id: BOOK, set: { trashedAt: null } }])
    await settle(server, a)
    expect(server.state.books.get(BOOK)?.trashedAt).toBe(T0)
    expect(a.notices.map((n) => [n.kind, n.message])).toEqual([['limit', tooLateMessage()]])
    expect(a.client.unsavedJsonl()).toBe('')
    a.client.stop()
  })

  it('words typed into it behind the refused put-back are refused with it, offered for download, never written into the book the purge takes', async () => {
    const server = bookServer(new FakeServer(), ['kept'])
    server.commit([{ op: 'book.update', id: BOOK, set: { trashedAt: T0 } }])
    const a = connect(server)
    await a.client.start()
    const fetched = await a.client.fetchBook(BOOK)
    if (!fetched) throw new Error('no book')
    expect(await a.client.holdBook(BOOK, fetched.blocks, fetched.revision)).toBe('held')
    // The store out of reach on day 29.9 (the shelf allows it): the book put back and written in,
    // and another book's paragraph left alone. In reach again past day 30.
    a.transport.offline = true
    vi.setSystemTime(Date.parse(T0) + 29.9 * DAY)
    a.client.submit([{ op: 'book.update', id: BOOK, set: { trashedAt: null } }])
    a.client.submit([typeAt(1, 4, ' and new words')])
    a.client.submit([{ op: 'book.update', id: BOOK, set: { title: 'Renamed' } }])
    vi.setSystemTime(Date.parse(T0) + 31 * DAY)
    a.transport.offline = false
    await settle(server, a)
    // Nothing of it reached the book the purge takes.
    expect(server.state.blocks.get(para(1))?.text).toBe('kept')
    expect(server.state.books.get(BOOK)).toMatchObject({ trashedAt: T0, title: 'Shared' })
    expect(a.client.pending).toBe(0)
    // Said too late, and the words behind it refused as other refused writing is: the slip, and
    // the unsaved-changes download holding them.
    expect(a.notices.map((n) => n.message)).toContain(tooLateMessage())
    expect(a.notices.some((n) => n.kind === 'rejected')).toBe(true)
    expect(a.client.unsavedParts().dropped).toEqual([
      [typeAt(1, 4, ' and new words')],
      [{ op: 'book.update', id: BOOK, set: { title: 'Renamed' } }],
    ])
    expect(await unsavedText(a.client)).toContain('and new words')
    a.client.stop()
  })

  it('the shelf’s Put it back past the 30 days: said too late, nothing asked of the board', () => {
    const state = applyBatch(
      emptyBoardState(BOARD_ID, 'Test board', T0),
      [
        { op: 'book.create', book: { ...book(BOOK), trashedAt: null } },
        { op: 'book.update', id: BOOK, set: { trashedAt: T0 } },
      ],
      { now: T0 },
    )
    const s = openLocalSession({ kind: 'local', state, label: 'test' })
    const commits: unknown[] = []
    s.store.onCommit((_b, ops) => commits.push(ops))
    vi.setSystemTime(Date.parse(T0) + 30 * DAY + 1)
    restoreBook(s, BOOK)
    expect(commits).toEqual([])
    expect(s.store.getState().books.get(BOOK)?.trashedAt).toBe(T0)
    expect(s.feed.getState().notices.map((n) => n.message)).toEqual([tooLateMessage()])
    expect(tooLateMessage()).toBe(
      'It’s too late to put that book back: it was deleted more than 30 days ago.',
    )
  })
})
