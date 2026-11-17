import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type BoardSession, openServerSession } from '../../src/app/session'
import { createSyncFeed } from '../../src/sync/feed'
import { resetMessage } from '../../src/sync/notices'
import { BOOK, BOOK2, bookServer, textOf } from '../helpers/books'
import { BOARD_ID, FakeServer, FakeTransport, T0 } from '../helpers/fakeServer'

const serverReset = (revision: number) => ({
  kind: 'reset' as const,
  count: 0,
  message: resetMessage(),
  server: true as const,
  revision,
})
const said = (feed: ReturnType<typeof createSyncFeed>) =>
  feed.getState().notices.map((n) => n.message)

describe('the feed and a reset this page asked for', () => {
  it('says nothing of the reset its own import brings, matched by revision, whichever comes first', () => {
    const feed = createSyncFeed()
    // The server's reset before the request's answer: held, then known as its own.
    let own = feed.ownReset()
    feed.notice(serverReset(7))
    expect(said(feed)).toEqual([])
    own.done(7)
    expect(said(feed)).toEqual([])
    // The answer first: the reset that follows with that revision is its own.
    own = feed.ownReset()
    own.done(9)
    feed.notice(serverReset(9))
    expect(said(feed)).toEqual([])
  })

  it('never swallows a reset it did not ask for: a different revision is said, at any time', () => {
    const feed = createSyncFeed()
    const own = feed.ownReset()
    // A reset not asked for here while the page's request is out: held, then said when it is not ours.
    feed.notice(serverReset(5))
    own.done(6)
    expect(said(feed)).toEqual([resetMessage()])
    feed.clearNotices()
    // The own reset never came (the stream was down): a later reset of another revision is said,
    // however soon.
    feed.notice(serverReset(8))
    expect(said(feed)).toEqual([resetMessage()])
  })

  it('a request that failed lets what it held be said, and keeps the photo slips that share the kind', () => {
    const feed = createSyncFeed()
    const own = feed.ownReset()
    feed.notice({ kind: 'reset', count: 0, message: 'That photo is too large.' })
    feed.notice(serverReset(3))
    expect(said(feed)).toEqual(['That photo is too large.'])
    own.failed()
    // Said now (a newer reset slip takes the older's place, as always).
    expect(said(feed)).toEqual([resetMessage()])
  })
})

describe('a reset the recovery slip says', () => {
  it('holds the server reset’s slip until the recovery check: folded into the recovery slip, or shown', () => {
    const feed = createSyncFeed()
    const off = feed.watchResets()
    feed.notice(serverReset(4))
    const [held] = feed.getState().notices
    expect(held?.held).toBe(true)
    // The recovery slip says it (a board replaced under the page): one slip, not two.
    feed.releaseReset(held?.id ?? 0, true)
    expect(feed.getState().notices).toEqual([])
    feed.notice(serverReset(5))
    const [next] = feed.getState().notices
    feed.releaseReset(next?.id ?? 0, false)
    expect(feed.getState().notices.map((n) => [n.message, n.held ?? false])).toEqual([
      [resetMessage(), false],
    ])
    off()
    feed.clearNotices()
    feed.notice(serverReset(6))
    expect(feed.getState().notices[0]?.held).toBeUndefined()
  })
})

describe('the feed and the books', () => {
  const sessions: BoardSession[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T0))
  })
  afterEach(() => {
    for (const s of sessions.splice(0)) s.dispose()
    vi.useRealTimers()
  })

  async function openBook(server: FakeServer) {
    const transport = new FakeTransport(server)
    const session = await openServerSession(BOARD_ID, {
      transport,
      env: null,
      camera: null,
    })
    sessions.push(session)
    await session.books?.open(BOOK)
    const told: Array<readonly string[]> = []
    session.books?.onReset((ids) => told.push(ids))
    return { session, transport, told }
  }

  it('a reset tells the open book: an import or restore asked here', async () => {
    const server = bookServer(new FakeServer(), ['kept'])
    const { session, told } = await openBook(server)
    const asked = session.feed.ownReset()
    await vi.advanceTimersByTimeAsync(0)
    expect(told).toEqual([[BOOK]])
    asked.failed()
  })

  it('a reset tells the open book: the board restored', async () => {
    const server = bookServer(new FakeServer(), ['before'])
    const { session, transport, told } = await openBook(server)
    const restored = bookServer(new FakeServer(), ['restored text'])
    server.restore(restored.state)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(told).toEqual([[BOOK]])
    // The book is read again and held anew, as it now is.
    await vi.advanceTimersByTimeAsync(100)
    expect(transport.bookCalls).toEqual([BOOK, BOOK])
    expect(textOf(session.store.getState(), 1)).toBe('restored text')
  })

  it('a book gone under the writer: one notice for it, with its id', () => {
    const feed = createSyncFeed()
    const gone = { kind: 'book-gone' as const, count: 1, message: 'gone', bookId: BOOK }
    feed.notice(gone)
    feed.notice(gone)
    feed.notice({ ...gone, bookId: BOOK2 })
    expect(feed.getState().notices.map((n) => [n.kind, n.bookId])).toEqual([
      ['book-gone', BOOK],
      ['book-gone', BOOK2],
    ])
  })
})

describe('a limit slip', () => {
  it('keeps a slot of its own: a reset never takes its place, nor it a reset’s', () => {
    const feed = createSyncFeed()
    const kinds = () => feed.getState().notices.map((n) => [n.kind, n.message])
    feed.notice({ kind: 'reset', count: 0, message: 'Board reloaded.' })
    feed.notice({ kind: 'limit', count: 0, message: 'No room.' })
    expect(kinds()).toEqual([
      ['reset', 'Board reloaded.'],
      ['limit', 'No room.'],
    ])
    feed.notice({ kind: 'reset', count: 0, message: 'Restored.' })
    expect(kinds()).toEqual([
      ['limit', 'No room.'],
      ['reset', 'Restored.'],
    ])
    // A newer limit slip takes the older one's place; dismissed, it goes.
    feed.notice({ kind: 'limit', count: 0, message: 'Too late.' })
    expect(kinds()).toEqual([
      ['reset', 'Restored.'],
      ['limit', 'Too late.'],
    ])
    const limit = feed.getState().notices.find((n) => n.kind === 'limit')
    feed.hideSlip(limit?.id ?? 0)
    expect(kinds()).toEqual([['reset', 'Restored.']])
  })
})
