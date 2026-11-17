/**
 * What the shelf does to the board's books: each a commit of the session's store, so it goes the
 * board's own way (the undo stack, the store), as every edit of the board does.
 */
import {
  type Block,
  type Book,
  type ClientOp,
  LIMITS,
  newId,
  OpError,
  posBetween,
  posKeysBetween,
} from '@papertie/core'
import { useEffect, useState } from 'react'
import { navigate } from '../app/router'
import { rememberScreen, type Screen } from '../app/screenMemory'
import type { BoardSession } from '../app/session'
import { tooLateMessage } from '../sync/notices'
import { newCover } from './cover/cover'
import { sayLimit } from './sayLimit'
import { daysLeft } from './trashedBooks'

/**
 * While a book screen is shown, it is this board's last screen (and last book screen, for the
 * Books button); once it goes, the board is (a book screen that follows says itself after).
 */
export function useRememberedScreen(session: BoardSession, s: Screen): void {
  const id = session.boardId
  const book = s.screen === 'book' ? s.bookId : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: the screen is `s.screen` and `book`
  useEffect(() => {
    if (id === null) return
    rememberScreen(id, s)
    return () => rememberScreen(id, { screen: 'board' })
  }, [id, s.screen, book])
}

/**
 * A book screen gives the focus back as it goes, as Settings does: once it has gone (a turn later,
 * the board no longer inert), and only if the focus was lost with it, to what had it when the
 * screen opened if that is still there, else to Books (the way back).
 */
export function useFocusBack(): void {
  // What had the focus as the screen was made: before any effect of it moves the focus, and
  // whatever StrictMode runs twice.
  const [from] = useState(() => (typeof document === 'undefined' ? null : document.activeElement))
  useEffect(
    () => () =>
      queueMicrotask(() => {
        const at = document.activeElement
        if (at !== null && at !== document.body && at.isConnected) return
        const back =
          from instanceof HTMLElement && from !== document.body && from.isConnected
            ? from
            : document.querySelector<HTMLElement>('[data-books]')
        back?.focus({ preventScroll: true })
      }),
    [from],
  )
}

/** A new book's language: German where the browser speaks it, else English. */
export const langFor = (language: string | undefined): Book['lang'] =>
  language !== undefined && /^de\b/i.test(language) ? 'de' : 'en'

/** The last shelf position of any book (put-back ones return where they stood). */
function lastPos(books: Iterable<Book>): string | null {
  let last: string | null = null
  for (const b of books) if (last === null || b.shelfPos > last) last = b.shelfPos
  return last
}

/**
 * A new book's batch: the book (untitled, in the browser's language, a fresh cover, after every
 * book on the shelf) and its one empty paragraph.
 */
export function newBookOps(
  books: Iterable<Book>,
  now: string,
  language: string | undefined,
): { id: string; ops: ClientOp[] } {
  const id = newId('book')
  const book: Book & { trashedAt: null } = {
    type: 'book',
    id,
    title: '',
    lang: langFor(language),
    shelfPos: posBetween(lastPos(books), null),
    cover: newCover(),
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  const first: Block = {
    type: 'block',
    id: newId('block'),
    bookId: id,
    pos: posBetween(null, null),
    kind: 'p',
    text: '',
    marks: [],
  }
  return {
    id,
    ops: [
      { op: 'book.create', book },
      { op: 'block.create', block: first, after: null },
    ],
  }
}

/** How the writer is to open a book's title: focused (a new book) or selected (Rename). */
export type TitleIntent = 'focus' | 'select'
let intent: { bookId: string; title: TitleIntent } | null = null

/** Open `bookId` in the writer, its title field `title` (once, for the screen that opens). */
export function openBook(bookId: string, title?: TitleIntent): void {
  intent = title === undefined ? null : { bookId, title }
  navigate({ name: 'book', id: bookId })
}

/**
 * What the writer opening `bookId` is to do with its title: read when its screen is made (and
 * kept with that mount, so StrictMode's second effect sees it too), and let go of as the screen
 * shows (`forgetTitleIntent`), so a later visit opens as asked then.
 */
export const titleIntent = (bookId: string): TitleIntent | null =>
  intent?.bookId === bookId ? intent.title : null

export function forgetTitleIntent(bookId: string): void {
  if (intent?.bookId === bookId) intent = null
}

/**
 * Make a book and open it with its title ready to type. With the shelf full (`maxBooks`, the
 * server's cap on the board's books, counting those in Recently deleted: a deleted book keeps its
 * words for 30 days, to be put back whole), nothing is made: a calm slip says why. Null then.
 */
export function createBook(session: BoardSession): string | null {
  const books = session.store.getState().books
  const { id, ops } = newBookOps(
    books.values(),
    new Date().toISOString(),
    typeof navigator === 'undefined' ? undefined : navigator.language,
  )
  try {
    session.store.commit(ops, { label: 'New book' })
  } catch (e) {
    if (!(e instanceof OpError) || e.code !== 'limit') throw e
    const deleted = [...books.values()].some((b) => b.trashedAt !== null)
    const say = `There’s no room for a new book: the shelf holds ${LIMITS.maxBooks}${deleted ? ', counting those in Recently deleted' : ''}.`
    sayLimit(session, say)
    return null
  }
  openBook(id, 'focus')
  return id
}

/**
 * The ops that put `id` at place `to` (0-based) of `shelf` (the books in shelf order): its own key
 * between its new neighbours, or none when it is there already. When they leave no room (the same
 * key, as an imported file may hold; or a gap halved until a key would pass `maxPosLength`), the
 * whole shelf is spaced out again in the same batch, in its new order.
 */
export function placeOps(shelf: readonly Book[], id: string, to: number): ClientOp[] {
  const from = shelf.findIndex((b) => b.id === id)
  const rest = shelf.filter((b) => b.id !== id)
  const at = Math.max(0, Math.min(rest.length, to))
  const moving = shelf[from]
  if (!moving || from === at) return []
  const a = rest[at - 1]?.shelfPos ?? null
  const b = rest[at]?.shelfPos ?? null
  if (a === null || b === null || a < b) {
    const pos = posBetween(a, b)
    if (pos.length <= LIMITS.maxPosLength)
      return [{ op: 'book.update', id, set: { shelfPos: pos } }]
  }
  const order = [...rest.slice(0, at), moving, ...rest.slice(at)]
  const keys = posKeysBetween(null, null, order.length)
  const ops: ClientOp[] = []
  order.forEach((book, i) => {
    const pos = keys[i] as string
    if (book.shelfPos !== pos) ops.push({ op: 'book.update', id: book.id, set: { shelfPos: pos } })
  })
  return ops
}

export function moveBook(session: BoardSession, shelf: readonly Book[], id: string, to: number) {
  const ops = placeOps(shelf, id, to)
  if (ops.length === 0) return false
  session.store.commit(ops, { label: 'Move book' })
  return true
}

export function trashBook(session: BoardSession, id: string): void {
  session.store.commit([{ op: 'book.update', id, set: { trashedAt: new Date().toISOString() } }], {
    label: 'Delete book',
  })
}

/**
 * Put a deleted book back on the shelf. Past its 30 days it is too late (the server purges it
 * then, and refuses it back): said so, nothing asked of the board.
 */
export function restoreBook(session: BoardSession, id: string): void {
  const book = session.store.getState().books.get(id)
  if (book?.trashedAt != null && daysLeft(book, Date.now()) <= 0) {
    sayLimit(session, tooLateMessage())
    return
  }
  session.store.commit([{ op: 'book.update', id, set: { trashedAt: null } }], {
    label: 'Put back book',
  })
}

export function setBookLang(session: BoardSession, id: string, lang: Book['lang']): void {
  session.store.commit([{ op: 'book.update', id, set: { lang } }], { label: 'Book language' })
}

export function redrawCover(session: BoardSession, id: string): void {
  session.store.commit([{ op: 'book.update', id, set: { cover: newCover() } }], {
    label: 'New cover',
  })
}

export function renameBook(session: BoardSession, id: string, title: string): void {
  session.store.commit([{ op: 'book.update', id, set: { title } }], {
    label: 'Rename book',
    coalesceKey: `title:${id}`,
  })
}
