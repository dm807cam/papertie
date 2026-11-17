/**
 * What the writer says of a change the limits refuse (minor 1): the limit the
 * board's own refusal names, in plain words (a paragraph's length or marks, the book's
 * paragraphs or length), read from the very errors core throws.
 */
import {
  applyBatch,
  type ClientOp,
  emptyBoardState,
  LIMITS,
  OpError,
  posKeysBetween,
} from '@papertie/core'
import { describe, expect, it } from 'vitest'
import { limitCopy } from '../../src/book/writer'
import { BOOK, book, para } from '../helpers/books'
import { BOARD_ID, T0 } from '../helpers/fakeServer'

const base = applyBatch(
  emptyBoardState(BOARD_ID, 'Test board', T0),
  [{ op: 'book.create', book: { ...book(BOOK), trashedAt: null } }],
  { now: T0 },
)
const creates = (n: number, text: (i: number) => string, from = 0): ClientOp[] =>
  posKeysBetween(null, null, n).map((pos, i) => ({
    op: 'block.create',
    block: {
      type: 'block',
      id: para(from + i + 1),
      bookId: BOOK,
      pos,
      kind: 'p',
      text: text(i),
      marks: [],
    },
  }))
/** The error core throws applying `batches` in turn (the last one refused). */
function refusal(...batches: ClientOp[][]): OpError {
  let s = base
  try {
    for (const b of batches) s = applyBatch(s, b, { now: T0 })
  } catch (e) {
    if (e instanceof OpError) return e
    throw e
  }
  throw new Error('nothing refused')
}

describe('limitCopy', () => {
  it('names the limit each refusal met', () => {
    const one = creates(1, () => 'a'.repeat(LIMITS.maxBlockText))
    expect(
      limitCopy(
        refusal(one, [
          { op: 'block.edit', bookId: BOOK, id: para(1), splices: [{ at: 0, del: 0, ins: 'b' }] },
        ]),
      ),
    ).toBe('A paragraph can’t be longer than 20,000 characters, so that change wasn’t made.')
    const words = creates(1, () => 'w '.repeat(LIMITS.maxMarksPerBlock + 1))
    const mark = (i: number) => ({ t: 'b' as const, from: 2 * i, to: 2 * i + 1 })
    const all = Array.from({ length: LIMITS.maxMarksPerBlock }, (_, i) => mark(i))
    const edit = (addMarks: ReturnType<typeof mark>[]): ClientOp[] => [
      { op: 'block.edit', bookId: BOOK, id: para(1), splices: [], addMarks },
    ]
    expect(limitCopy(refusal(words, edit(all), edit([mark(LIMITS.maxMarksPerBlock)])))).toBe(
      'A paragraph can’t hold more than 2,000 bold or italic marks, so that change wasn’t made.',
    )
    const many = Array.from({ length: Math.ceil((LIMITS.maxBlocksPerBook + 1) / 500) }, (_, k) =>
      creates(Math.min(500, LIMITS.maxBlocksPerBook + 1 - 500 * k), () => '', 500 * k),
    )
    // (The keys of each batch are their own: only the count matters here.)
    expect(limitCopy(refusal(...many.map((b, k) => b.map((op) => withPos(op, k)))))).toBe(
      'A book can’t have more than 60,000 paragraphs, so that change wasn’t made.',
    )
    const long = Array.from({ length: LIMITS.maxBookChars / LIMITS.maxBlockText + 1 }, (_, k) =>
      creates(1, () => 'x'.repeat(LIMITS.maxBlockText), k).map((op) => withPos(op, k)),
    )
    expect(limitCopy(refusal(...long))).toBe(
      'A book can’t be longer than 4,000,000 characters, so that change wasn’t made.',
    )
    expect(limitCopy(new OpError('not-found', 'block x not found'))).toBeNull()
  })
})

/** `op` (a create) with its key under batch `k`'s own prefix, so the batches' keys never meet. */
function withPos(op: ClientOp, k: number): ClientOp {
  if (op.op !== 'block.create') return op
  return {
    ...op,
    block: { ...op.block, pos: `${'V'}${String(k).padStart(5, '0')}V${op.block.pos}` },
  }
}
