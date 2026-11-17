/**
 * Book ops: which ops are block ops, the books they name, and the book chunk
 * (`book/bookSync.ts`), loaded when a book is opened or edited: a board whose books stay closed
 * never fetches it.
 */
import type { BoardState, ClientOp, Op } from '@papertie/core'

export type BookSync = typeof import('../../book/bookSync')

let loaded: BookSync | null = null
let loading: Promise<BookSync> | null = null

/** The book chunk, once loaded; null before. */
export const bookSync = (): BookSync | null => loaded

/** Load the book chunk (once; a failed load is tried again on the next call). */
export function loadBookSync(): Promise<BookSync> {
  loading ??= import('../../book/bookSync').then(
    (m) => {
      loaded = m
      return m
    },
    (e: unknown) => {
      loading = null
      throw e
    },
  )
  return loading
}

/** Whether `s` holds `bookId`'s blocks (core's `isHeld`, kept out of the board's chunk). */
export const held = (s: BoardState, bookId: string): boolean =>
  s.blocksHeld === 'all' || s.blocksHeld.has(bookId)

/**
 * An op on a book's blocks (the server's purges included). The server's `book.cards` is
 * not one: it sets a book record's `cards`, which the page holds for every book, so it applies to a book not
 * held as to any book.
 */
export const isBlockOp = (op: Op): boolean => op.op.startsWith('block.') || op.op === 'book.purge'

export const hasBlockOps = (ops: readonly Op[]): boolean => ops.some(isBlockOp)

/** The book a block op is on; null for any other op. */
export function bookOf(op: Op): string | null {
  if (op.op === 'block.create') return op.block.bookId
  if (op.op === 'book.purge') return op.id
  return op.op.startsWith('block.') ? (op as { bookId: string }).bookId : null
}

/** The books `ops`' block ops are on. */
export function booksOf(ops: readonly Op[]): Set<string> {
  const out = new Set<string>()
  for (const op of ops) {
    const id = bookOf(op)
    if (id !== null) out.add(id)
  }
  return out
}

export type { ClientOp }
