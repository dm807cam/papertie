/** Books for sync tests: a book record, its paragraphs, and edits of them. */
import type { Block, BoardState, Book, ClientOp } from '@papertie/core'
import { loadBookSync } from '../../src/sync/books/bookOps'
import type { SyncClient } from '../../src/sync/SyncClient'
import { type FakeServer, idOf, T0 } from './fakeServer'

export const BOOK = idOf('book', 1)
export const BOOK2 = idOf('book', 2)
export const para = (n: number) => idOf('block', n)

export function book(id = BOOK, over: Partial<Book> = {}): Book {
  return {
    type: 'book',
    id,
    title: 'Shared',
    lang: 'en',
    shelfPos: 'V',
    cover: { seed: 1, ink: 'indigo', motif: 'overprint' },
    trashedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

export function block(n: number, text: string, bookId = BOOK, pos = `V${n}`): Block {
  return { type: 'block', id: para(n), bookId, pos, kind: 'p', text, marks: [] }
}

/** The ops making `bookId` with one paragraph per text, `para(first + i)`. */
export function makeBook(texts: readonly string[], bookId = BOOK, first = 1): ClientOp[] {
  return [
    { op: 'book.create', book: { ...book(bookId), trashedAt: null } },
    ...texts.map((t, i) => ({ op: 'block.create' as const, block: block(first + i, t, bookId) })),
  ]
}

/** Type `ins` at `at` in paragraph `n`. */
export const typeAt = (n: number, at: number, ins: string, bookId = BOOK): ClientOp => ({
  op: 'block.edit',
  bookId,
  id: para(n),
  splices: [{ at, del: 0, ins }],
})

/** Paragraph `n`'s text in `s` (empty when it is not there). */
export const textOf = (s: BoardState, n: number) => s.blocks.get(para(n))?.text ?? ''

/** A server holding a book of `texts`, at revision 1. */
export function bookServer(server: FakeServer, texts: readonly string[]): FakeServer {
  server.commit(makeBook(texts))
  return server
}

/** The `.md` of `client`'s unsaved-changes download (what `offerUnsaved` hands the user). */
export async function unsavedText(client: SyncClient): Promise<string> {
  return (await loadBookSync()).unsavedFile(client.unsavedJsonl(), client.unsavedParts())
}
