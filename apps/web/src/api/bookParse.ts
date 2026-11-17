/** The book route's answer read (`fetchBook`): in the book chunk (`book/bookSync.ts`). */
import { type Block, BlockRecordSchema, type Book, BookRecordSchema } from '@papertie/core'
import { type SlicePace, slicer } from '../sync/pace'
import type { FetchedBook } from './boards'

/** Lines read between looks at the clock. */
const LOOK = 256

/**
 * Read a book route answer: the book record, its blocks, then `{"type":"eof", revision}`. Null
 * for anything else. Read in slices of at most 4 ms, yielding to the page (a long book is 60,000
 * lines, each checked against its schema).
 */
export async function parseBook(text: string, pace?: SlicePace): Promise<FetchedBook | null> {
  let book: Book | null = null
  let revision = -1
  const blocks: Block[] = []
  const pause = slicer(pace)
  let n = 0
  for (const raw of text.split('\n')) {
    if (++n % LOOK === 0) await pause()
    if (raw.trim() === '') continue
    if (revision >= 0) return null
    let line: { type?: unknown; revision?: unknown }
    try {
      line = JSON.parse(raw) as typeof line
    } catch {
      return null
    }
    if (typeof line !== 'object' || line === null) return null
    if (book === null) {
      const r = line.type === 'book' ? BookRecordSchema.safeParse(line) : null
      if (!r?.success) return null
      book = r.data
    } else if (line.type === 'block') {
      const r = BlockRecordSchema.safeParse(line)
      if (!r.success || r.data.bookId !== book.id) return null
      blocks.push(r.data)
    } else if (line.type === 'eof' && Number.isSafeInteger(line.revision)) {
      revision = line.revision as number
      if (revision < 0) return null
    } else return null
  }
  return book !== null && revision >= 0 ? { revision, book, blocks } : null
}
