/**
 * The writer on a server board (a sync client on the fake server): what was composed into a
 * paragraph deleted under it meanwhile, or that a restore left out, is never lost. It goes
 * the board's rejected-batch way: the slip that says it couldn't be saved, and the unsaved-changes
 * download's `.md` holding the text.
 */
import { type BoardState, bookBlocks, type ClientOp } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { OPENED } from '../../src/app/opening'
import type { BoardSession } from '../../src/app/session'
import { BookScreen } from '../../src/book/BookScreen'
import { UndoStack } from '../../src/history/UndoStack'
import { createBoardStore } from '../../src/store/boardStore'
import { attachBooks, type BookStore, createBookStore } from '../../src/sync/books/bookStore'
import { createSyncFeed } from '../../src/sync/feed'
import { SyncClient } from '../../src/sync/SyncClient'
import { BOOK, bookServer, para, unsavedText } from '../helpers/books'
import { BOARD_ID, FakeServer, FakeTransport } from '../helpers/fakeServer'
import { blockEl, caret, startDeadKey } from './writerKit'

const _USER = 'user_a'
const stops: Array<() => void> = []
afterEach(() => {
  cleanup()
  attachBooks(null)
  for (const f of stops.splice(0)) f()
  history.replaceState(null, '', '/')
})

/** A server session as the app makes one, small: its store on the client's view, its feed. */
async function serverSession(server: FakeServer, books?: (s: BoardSession) => BookStore) {
  const feed = createSyncFeed()
  let store: ReturnType<typeof createBoardStore> | null = null
  const client = new SyncClient({
    transport: new FakeTransport(server),
    onView: (view, cause) => {
      if (cause !== 'local') store?.replace(view)
    },
    onStatus: (s) => feed.status(s),
    onNotice: (n) => feed.notice(n),
  })
  await client.start()
  store = createBoardStore(client.view, (ops, o) =>
    client.submit(ops, {
      ...(o.coalesceKey === undefined ? {} : { coalesceKey: o.coalesceKey }),
      ...(o.label === undefined ? {} : { label: o.label }),
    }),
  )
  const undo = new UndoStack()
  store.onCommit((before, ops, o) => {
    if (o.undo !== 'skip') undo.record(before, ops, o.label ?? 'a change', o.coalesceKey)
  })
  const session: BoardSession = {
    store,
    undo,
    sync: client,
    books: null,
    boardId: BOARD_ID,
    feed,
    recovered: false,
    opening: OPENED,
    camera: null,
    dispose: () => client.stop(),
  }
  session.books = books?.(session) ?? createBookStore({ client })
  stops.push(() => {
    session.books?.dispose()
    client.stop()
  })
  attachBooks(store)
  return { session, client }
}

const texts = (s: BoardState) =>
  bookBlocks(s.blocks, BOOK)
    .chunks.flat()
    .map((b) => b.text)
const rejected = (session: BoardSession) =>
  session.feed.getState().notices.filter((n) => n.kind === 'rejected' && n.slip)

/** A commit of the store's own (its event reaches the client a turn later). */
async function storeCommit(server: FakeServer, ops: ClientOp[]): Promise<void> {
  server.commit(ops)
  await new Promise((r) => setTimeout(r, 0))
}

describe('the writer, its text never lost', () => {
  it('a paragraph deleted under the page while a dead key composes in it: the slip, and the .md holds the composed text', async () => {
    const server = bookServer(new FakeServer(), ['first', 'cafe'])
    const { session, client } = await serverSession(server)
    render(<BookScreen session={session} bookId={BOOK} />)
    await vi.waitFor(() => expect(document.querySelector('[data-id]')).not.toBeNull())
    caret(blockEl(document.body, para(2)), 3)
    const finish = startDeadKey('´')
    await act(async () => {
      await storeCommit(server, [{ op: 'block.delete', bookId: BOOK, id: para(2) }])
    })
    await vi.waitFor(() => expect(texts(session.store.getState())).toEqual(['first']))
    finish('é')
    await vi.waitFor(() => expect(rejected(session)).toHaveLength(1))
    expect(rejected(session)[0]?.message).toMatch(/couldn’t be saved/)
    expect(await unsavedText(client)).toContain('é')
    // The page is the board's: the paragraph is gone, nothing made again.
    expect([...document.querySelectorAll('[data-id]')].map((e) => e.textContent)).toEqual(['first'])
    expect(document.body.textContent).not.toMatch(/longer than a book can be/)
  })

  it('a restore without the paragraph a dead key composes in: the slip, and the .md holds the composed text', async () => {
    const server = bookServer(new FakeServer(), ['first', 'cafe'])
    const resets = new Set<(ids: readonly string[]) => void>()
    const { session, client } = await serverSession(server, () => ({
      open: async () => true,
      close: () => {},
      onReset: (fn) => {
        resets.add(fn)
        return () => resets.delete(fn)
      },
      reset: () => {},
      changed: () => {},
      dispose: () => {},
    }))
    // Held already, so the writer shows it at once.
    const read = await client.fetchBook(BOOK)
    if (read === null) throw new Error('no book')
    expect(await client.holdBook(BOOK, read.blocks, read.revision)).toBe('held')
    render(<BookScreen session={session} bookId={BOOK} />)
    await vi.waitFor(() => expect(document.querySelector('[data-id]')).not.toBeNull())
    caret(blockEl(document.body, para(2)), 3)
    const finish = startDeadKey('´')
    // The restore lands while it composes: a board whose book has only its first paragraph.
    await act(async () => {
      await storeCommit(server, [{ op: 'block.delete', bookId: BOOK, id: para(2) }])
    })
    await vi.waitFor(() => expect(texts(session.store.getState())).toEqual(['first']))
    act(() => {
      for (const fn of resets) fn([BOOK])
    })
    finish('é')
    await vi.waitFor(() => expect(rejected(session)).toHaveLength(1))
    expect(await unsavedText(client)).toContain('é')
  })
})
