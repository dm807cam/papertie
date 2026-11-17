/**
 * The board's books as the app reads them: which are on the shelf, which were deleted,
 * and a book's blocks once it is open. A book is held (its blocks in the board's state) from the
 * book route, at the revision that read it (`SyncClient.holdBook`). Always loaded, so it stays small: the shelf,
 * the writer and the book's sync work are chunks of their own.
 */
import { type Block, type BoardState, type Book, bookBlocks } from '@papertie/core'
import { useSyncExternalStore } from 'react'
import type { FetchedBook } from '../../api/boards'
import type { BoardStore } from '../../store/boardStore'
import type { HoldResult } from '../SyncClient'
import type { BookHolder } from './bookHolder'
import { held, loadBookSync } from './bookOps'

/** What the book store needs of the sync client. */
export interface BookClient {
  readonly confirmed: BoardState
  holdBook(bookId: string, blocks: readonly Block[], at: number): Promise<HoldResult>
  releaseBook(bookId: string): void
  hasPendingOn(bookId: string): boolean
  fetchBook(bookId: string): Promise<FetchedBook | null>
  /** Tell `fn` each time the event stream opens again; returns the undo. */
  onStreamUp?(fn: () => void): () => void
}

export interface BookStore {
  /**
   * Hold `bookId`: read from the store and held once the confirmed board reaches the revision
   * it was read at. Resolves once it is held or gone (true), or once a read of it failed (false:
   * the store could not answer, or it was read stale again and again). A book that could not be
   * read is read again by itself while it is open: as the stream opens again, else after a
   * backoff.
   */
  open(bookId: string): Promise<boolean>
  /** The book's screen closed: let it go, unless edits on it still wait to be confirmed. */
  close(bookId: string): void
  /**
   * Told when the board was replaced (loaded whole, restored, imported): the books held then, so
   * the open book's screen starts over. Returns the undo.
   */
  onReset(fn: (bookIds: readonly string[]) => void): () => void
  /** The board was replaced: `onReset` is told of `bookIds` (the open books, by default). */
  reset(bookIds?: readonly string[]): void
  /** The confirmed board changed: a closed book whose edits are all committed is let go. */
  changed(state: BoardState): void
  dispose(): void
}

export interface BookStoreOptions {
  client: BookClient
  /**
   * Settles once the client has started and the board shown has its books (a session still
   * opening): a book is held only from then. Absent: started already.
   */
  started?: Promise<void>
}

/** The board's book store; its work loads with the book chunk, on the first book opened. */
export function createBookStore(o: BookStoreOptions): BookStore {
  let impl: BookHolder | null = null
  let loading: Promise<BookHolder> | null = null
  let disposed = false
  const resets = new Set<(ids: readonly string[]) => void>()
  const holder = () => {
    loading ??= loadBookSync().then((rx) => {
      impl = rx.createBookHolder(o)
      if (disposed) impl.dispose()
      return impl
    })
    return loading
  }
  return {
    open: (bookId) => holder().then((h) => h.open(bookId)),
    close: (bookId) => impl?.close(bookId),
    onReset(fn) {
      resets.add(fn)
      return () => {
        resets.delete(fn)
      }
    },
    reset(bookIds) {
      const ids = bookIds ?? impl?.opened() ?? []
      for (const fn of [...resets]) fn(ids)
      // The board read whole holds no book: the open ones are read again.
      for (const id of impl?.opened() ?? []) void impl?.open(id)
    },
    changed: (state) => impl?.changed(state),
    dispose() {
      disposed = true
      impl?.dispose()
      resets.clear()
    },
  }
}

// ---- selectors: the one board's books (the deleted ones are the shelf's: `book/trashedBooks.ts`)
// --------------------------------------------------------

let active: BoardStore | null = null
let offActive: (() => void) | null = null
const listeners = new Set<() => void>()
const tell = () => {
  for (const fn of [...listeners]) fn()
}

/** The board store the selectors read (the session's); null when no board is open. */
export function attachBooks(store: BoardStore | null): void {
  offActive?.()
  active = store
  offActive = store
    ? store.subscribe((s, prev) =>
        s.books !== prev.books || s.blocks !== prev.blocks ? tell() : undefined,
      )
    : null
  tell()
}

/** Whether `bookId` stands on the shelf now (held or not; not deleted, not gone). */
export const onShelf = (bookId: string): boolean =>
  active?.getState().books.get(bookId)?.trashedAt === null

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

const NONE: readonly Book[] = []
const shelf = new WeakMap<ReadonlyMap<string, Book>, readonly Book[]>()
const flat = new WeakMap<object, readonly Block[]>()

const byShelf = (a: Book, b: Book) =>
  a.shelfPos < b.shelfPos ? -1 : a.shelfPos > b.shelfPos ? 1 : a.id < b.id ? -1 : 1

/** The books on the shelf, in shelf order (`shelfPos`, then id), deleted ones left out. */
export function shelfBooks(books: ReadonlyMap<string, Book>): readonly Book[] {
  let out = shelf.get(books)
  if (!out) {
    out = [...books.values()].filter((b) => b.trashedAt === null).sort(byShelf)
    shelf.set(books, out)
  }
  return out
}

/** A held book's blocks in order; null when it is not held. */
export function blocksOfBook(state: BoardState, bookId: string): readonly Block[] | null {
  if (!state.books.has(bookId) || !held(state, bookId)) return null
  const ix = bookBlocks(state.blocks, bookId)
  let out = flat.get(ix)
  if (!out) {
    out = ix.chunks.flat()
    flat.set(ix, out)
  }
  return out
}

/**
 * A slice of the one board's state, read as the board changes (`pick` must answer a stable
 * value): for selectors kept with what uses them (the shelf's, `book/trashedBooks.ts`).
 */
export const useBookState = <T>(pick: (s: BoardState) => T, none: T): T =>
  useSyncExternalStore(subscribe, () => (active ? pick(active.getState()) : none))
const read = useBookState

export const useBooks = (): readonly Book[] => read((s) => shelfBooks(s.books), NONE)
export const useBook = (id: string): Book | null => read((s) => s.books.get(id) ?? null, null)
export const useBlocks = (id: string): readonly Block[] | null =>
  read((s) => blocksOfBook(s, id), null)
