/**
 * The shelf's "Recently deleted": the deleted books, newest deletion first. Kept out
 * of the board's chunk: it loads with the shelf.
 */
import type { Book } from '@papertie/core'
import { useBookState } from '../sync/books/bookStore'

const NONE: readonly Book[] = []
const trash = new WeakMap<ReadonlyMap<string, Book>, readonly Book[]>()

/** The deleted books, newest deletion first. */
export function trashedBooks(books: ReadonlyMap<string, Book>): readonly Book[] {
  let out = trash.get(books)
  if (!out) {
    out = [...books.values()]
      .filter((b) => b.trashedAt !== null)
      .sort((a, b) => ((a.trashedAt as string) < (b.trashedAt as string) ? 1 : -1))
    trash.set(books, out)
  }
  return out
}

export const useTrashedBooks = (): readonly Book[] =>
  useBookState((s) => trashedBooks(s.books), NONE)

/** How long a deleted book can be put back: the server purges it after (`BOOK_TRASH_MS`). */
export const TRASH_DAYS = 30
const DAY_MS = 86_400_000

/** The whole days `book` (deleted) can still be put back at `now`; 0 or less once past. */
export function daysLeft(book: Book, now: number): number {
  const at = Date.parse(book.trashedAt ?? '')
  return Number.isNaN(at) ? 0 : Math.ceil((at + TRASH_DAYS * DAY_MS - now) / DAY_MS)
}

/**
 * The deleted books that can still be put back at `now`, newest deletion first: one past its
 * 30 days is left out, though the server's purge may not have reached it yet.
 */
export const restorable = (trashed: readonly Book[], now: number): Book[] =>
  trashed.filter((b) => daysLeft(b, now) > 0)
