import { createHash } from 'node:crypto'
import { type BoardState, bookBlocks } from '@papertie/core'
import { CHECK, SLICE_MS, Slicer } from './compact'
import type { Jsonl } from './servedText'

/** The bytes of one piece of a book's NDJSON (as the board's serializer's pieces). */
const PIECE_BYTES = 131_072

/**
 * One book as the book route serves it (`GET /boards/:id/books/:bookId`, ADR-0001): NDJSON of the
 * book record, its blocks in `(pos, id)` order, then `{"type":"eof", revision, records, sha256}`
 * over those lines (the board file's eof, for the book's lines alone), read from `state`, one
 * immutable version of the board, so the whole answer is of one revision. A `Slicer` job: the
 * lines are stringified and hashed into buffer pieces a few at a time. Null when the board has no
 * such book. The text of the book never leaves these buffers (no log, no error message).
 */
export async function bookStream(state: BoardState, bookId: string): Promise<Jsonl | null> {
  const book = state.books.get(bookId)
  if (!book) return null
  const s = await Slicer.start(SLICE_MS)
  // The book's index, a chunk at a time (never flattened in one step).
  const { chunks, count } = bookBlocks(state.blocks, bookId)
  const hash = createHash('sha256')
  const parts: Buffer[] = []
  let bytes = 0
  let lines: string[] = []
  let size = 0
  const flush = () => {
    if (lines.length === 0) return
    const piece = Buffer.from(lines.join(''), 'utf8')
    hash.update(piece)
    parts.push(piece)
    bytes += piece.length
    lines = []
    size = 0
  }
  /** Adds one line; true when that filled a piece (a clock read is due then). */
  const put = (json: string): boolean => {
    lines.push(`${json}\n`)
    size += json.length + 1
    if (size * 3 < PIECE_BYTES) return false
    flush()
    return true
  }
  put(JSON.stringify(book))
  let i = 0
  for (const chunk of chunks) {
    for (const block of chunk) {
      // By the bytes too: 64 paragraphs at the limit are 1.3 M characters.
      const filled = put(JSON.stringify(block))
      if ((filled || ++i % CHECK === 0) && s.due()) await s.pause()
    }
  }
  flush()
  const eof = Buffer.from(
    `${JSON.stringify({
      type: 'eof',
      revision: state.board.revision,
      records: count + 1,
      sha256: hash.digest('hex'),
    })}\n`,
    'utf8',
  )
  parts.push(eof)
  bytes += eof.length
  s.note()
  return { parts, bytes }
}
