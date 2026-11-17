/**
 * "Add footnote from …" in a pin's peek: a card with a ref offers it,
 * and a pick is a footnote of that ref after the block, anchored over the card's passage there
 * (its whole text when the mark is gone). One commit; it reads the block and the prompts and
 * footnotes after it, never the book.
 */
import { type BoardState, type ClientOp, cardMarkT, newId } from '@papertie/core'
import { changesToOps, withAsides } from '../editorOps'
import { addFootnote, type BlockSeq } from './footnotes'

/** The ops of a footnote of card `noteId`'s ref on block `blockId`; none when it has no ref. */
export function refFootnoteOps(
  state: BoardState,
  bookId: string,
  blockId: string,
  noteId: string,
  id: string = newId('block'),
): ClientOp[] {
  const ref = state.notes.get(noteId)?.ref
  const run = withAsides(state, bookId, blockId)
  const b = run[0]
  if (ref === undefined || b === undefined) return []
  const t = cardMarkT(noteId)
  const passage = b.marks.filter((m) => m.t === t)
  const from = passage[0]?.from ?? 0
  const to = passage.at(-1)?.to ?? b.text.length
  const seq: BlockSeq = {
    at: (i) => run[i],
    indexOf: (x) => run.findIndex((r) => r.id === x),
  }
  const changes = addFootnote(seq, blockId, from, to, id, ref)
  return changes.length === 0 ? [] : changesToOps(state, bookId, changes)
}
