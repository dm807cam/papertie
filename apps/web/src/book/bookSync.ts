/**
 * The book work of the page's client, in a chunk of its own: loaded once a book is
 * opened or edited (`sync/books/bookOps.ts`), never with the board. It holds what a board whose
 * books stay closed never needs: the book route's parser, the holder of open books, the undo
 * stack's book steps and the text of an unsaved-changes download.
 */
import {
  appendSplice,
  type BoardState,
  type ClientOp,
  emptyBoardState,
  fitBatch,
  LIMITS,
  statedSplices,
  takenSplices,
} from '@papertie/core'
import { unsavedMarkdown } from '../sync/books/unsavedText'
import type { UnsavedParts } from '../sync/offerUnsaved'

export { parseBook } from '../api/bookParse'
export { createBookHolder } from '../sync/books/bookHolder'
export { unsavedMarkdown }

/**
 * An undo or redo step's ops (`UndoStack.step`), its keys fitted to the board it applies to
 * (core's `fitBatch`): a paragraph a step splits off again goes right after its head, and one it
 * moves right after the block the move names, as the board has them now. `ops` itself where no
 * key changes. O(ops × log book), once per step taken.
 */
export function fitStep(current: BoardState, ops: readonly ClientOp[]): ClientOp[] {
  return fitBatch(current, ops)
}

/**
 * `newer` (undone first) put before `older`, a `block.edit` of one paragraph composed into the
 * edit of it that comes next (its splices first, then the older ones: one op per paragraph a
 * typing session put back, never one per keystroke). Neither is ever covered: each keystroke's
 * inverse matters.
 */
export function compose(newer: readonly ClientOp[], older: readonly ClientOp[]): ClientOp[] {
  const last = newer.at(-1)
  const first = older[0]
  if (
    last?.op !== 'block.edit' ||
    first?.op !== 'block.edit' ||
    last.id !== first.id ||
    last.bookId !== first.bookId ||
    last.addMarks ||
    last.removeMarks
  ) {
    return [...newer, ...older]
  }
  let splices = takenSplices(last.splices, last.takes)
  for (const sp of takenSplices(first.splices, first.takes)) splices = appendSplice(splices, sp)
  if (splices.length > LIMITS.maxSplicesPerEdit) return [...newer, ...older]
  const { op: _o, bookId, id, splices: _s, takes: _t, ...marks } = first
  return [
    ...newer.slice(0, -1),
    { op: 'block.edit', bookId, id, ...statedSplices(splices), ...marks },
    ...older.slice(1),
  ]
}

/**
 * The `.md` of an unsaved-changes download (`offerUnsaved`): from `parts` (this page's view and
 * batches), else from the JSONL alone, whose book edits are given by what they typed.
 */
export function unsavedFile(jsonl: string, parts?: UnsavedParts): string {
  if (parts?.view) return unsavedMarkdown(parts.view, parts.pending, parts.dropped)
  const ops: ClientOp[] = []
  for (const line of jsonl.split('\n')) {
    try {
      const op = JSON.parse(line) as ClientOp
      if (typeof op?.op === 'string') ops.push(op)
    } catch {
      // not an op
    }
  }
  const view = emptyBoardState(`board_${'0'.repeat(26)}`, '', new Date().toISOString())
  return unsavedMarkdown(view, [], [ops])
}
