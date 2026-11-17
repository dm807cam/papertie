import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { Eof } from '../schema/records'
import type { BoardState } from '../state'

/** Code-unit comparison (not locale-aware) so ordering is identical on every platform. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Build the trailing `eof` record for the given body lines (no trailing newlines).
 * `sha256` is the lowercase hex SHA-256 of the UTF-8 bytes of every line followed by `\n`.
 */
export function computeEof(bodyLines: string[], revision: number): Eof {
  const body = bodyLines.map((l) => `${l}\n`).join('')
  return {
    type: 'eof',
    revision,
    records: bodyLines.length,
    sha256: bytesToHex(sha256(new TextEncoder().encode(body))),
  }
}

/**
 * Canonical JSONL: board, assets by id, notes by (z, id), yarns by id, books by (shelfPos, id),
 * blocks by (bookId, pos, id), then eof; ends with `\n`. Key order within a line is whatever the
 * record carries (schema order for parsed records). A state that does not hold every book's blocks (a
 * client's) is never a file: it throws `RangeError`.
 */
export function serializeBoard(state: BoardState): string {
  if (state.blocksHeld !== 'all') {
    throw new RangeError('serializeBoard: the state does not hold every book’s blocks')
  }
  const assets = [...state.assets.values()].sort((a, b) => cmp(a.id, b.id))
  const notes = [...state.notes.values()].sort((a, b) => a.z - b.z || cmp(a.id, b.id))
  const yarns = [...state.yarns.values()].sort((a, b) => cmp(a.id, b.id))
  const books = [...state.books.values()].sort(
    (a, b) => cmp(a.shelfPos, b.shelfPos) || cmp(a.id, b.id),
  )
  const blocks = [...state.blocks.values()].sort(
    (a, b) => cmp(a.bookId, b.bookId) || cmp(a.pos, b.pos) || cmp(a.id, b.id),
  )
  const body = [state.board, ...assets, ...notes, ...yarns, ...books, ...blocks].map((r) =>
    JSON.stringify(r),
  )
  const eof = computeEof(body, state.board.revision)
  return `${[...body, JSON.stringify(eof)].join('\n')}\n`
}
