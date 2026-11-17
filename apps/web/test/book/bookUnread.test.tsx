/**
 * A book that could not be read as it opened (Important 1): the page waits, calm,
 * with a quiet slip saying so (never a "Loading"), and the book is read again by itself: back
 * online, it comes onto the page and the slip goes, with no reload.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { OPENED } from '../../src/app/opening'
import type { BoardSession } from '../../src/app/session'
import { BookScreen, UNREAD } from '../../src/book/BookScreen'
import { UndoStack } from '../../src/history/UndoStack'
import { createBoardStore } from '../../src/store/boardStore'
import { attachBooks, createBookStore } from '../../src/sync/books/bookStore'
import { createSyncFeed } from '../../src/sync/feed'
import { SyncClient } from '../../src/sync/SyncClient'
import { BOOK, bookServer } from '../helpers/books'
import { BOARD_ID, FakeServer, FakeTransport } from '../helpers/fakeServer'

const stops: Array<() => void> = []
afterEach(() => {
  cleanup()
  attachBooks(null)
  for (const f of stops.splice(0)) f()
})

async function serverSession(server: FakeServer) {
  const transport = new FakeTransport(server)
  let store: ReturnType<typeof createBoardStore> | null = null
  const client = new SyncClient({
    transport,
    onView: (view, cause) => {
      if (cause !== 'local') store?.replace(view)
    },
    onStatus: () => {},
    onNotice: () => {},
  })
  await client.start()
  store = createBoardStore(client.view, (ops, o) =>
    client.submit(ops, o.coalesceKey === undefined ? {} : { coalesceKey: o.coalesceKey }),
  )
  const session: BoardSession = {
    store,
    undo: new UndoStack(),
    sync: client,
    books: createBookStore({ client }),
    boardId: BOARD_ID,
    feed: createSyncFeed(),
    recovered: false,
    opening: OPENED,
    camera: null,
    dispose: () => client.stop(),
  }
  stops.push(() => {
    session.books?.dispose()
    client.stop()
  })
  attachBooks(store)
  return { session, transport }
}

describe('a book that could not be read', () => {
  it('opened with the store out of reach: the page waits under a quiet slip; once it answers, the book comes and the slip goes', async () => {
    const server = bookServer(new FakeServer(), ['the first words', 'and more'])
    const { session, transport } = await serverSession(server)
    const loads = transport.loads
    transport.offline = true
    render(<BookScreen session={session} bookId={BOOK} />)
    const slip = await screen.findByRole('status')
    expect(slip.textContent).toBe(UNREAD)
    expect(UNREAD).toBe('This book couldn’t be read just now. Papertie will try again.')
    expect(document.body.textContent).not.toMatch(/loading/i)
    expect(document.querySelector('.writer-body')?.hasAttribute('inert')).toBe(true)

    // The page asks again after its first wait (a second).
    transport.offline = false
    await vi.waitFor(
      () =>
        expect([...document.querySelectorAll('[data-id]')].map((e) => e.textContent)).toEqual([
          'the first words',
          'and more',
        ]),
      { timeout: 4000 },
    )
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.querySelector('.writer-body')?.hasAttribute('inert')).toBe(false)
    expect(transport.loads).toBe(loads)
  })
})
