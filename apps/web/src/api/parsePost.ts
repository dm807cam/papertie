/**
 * The parse worker's work (`parseWorker.ts`), in a module of its own so the parser it imports is
 * never in the board's chunk (the budget).
 */
import type { Asset, Book, Note, Yarn } from '@papertie/core'
import { parseBoard } from '@papertie/core/parse'
import { PARSE_BATCH, type ParseMessage } from './boardParse'

/** The worker's work: parse `bytes` (a board's NDJSON) and post what it holds to `post`. */
export function parseAndPost(bytes: ArrayBuffer, post: (m: ParseMessage) => void): void {
  const { state } = parseBoard(new TextDecoder().decode(bytes), { blocksHeld: 'none' })
  if (state === null) {
    post({ type: 'unreadable' })
    return
  }
  const sizes = { assets: state.assets.size, notes: state.notes.size, yarns: state.yarns.size }
  post({ type: 'board', board: state.board, sizes })
  let batch: Array<Asset | Note | Yarn | Book> = []
  const flush = () => {
    if (batch.length === 0) return
    post({ type: 'records', records: batch })
    batch = []
  }
  // Photos before the notes showing them, notes before the threads naming them; the books (no
  // blocks: the board is read without them).
  for (const map of [state.assets, state.notes, state.yarns, state.books] as const) {
    for (const r of map.values()) {
      batch.push(r)
      if (batch.length >= PARSE_BATCH) flush()
    }
  }
  flush()
  post({ type: 'end' })
}
