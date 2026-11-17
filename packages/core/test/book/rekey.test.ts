import fc from 'fast-check'
import { chunkSizeForTests } from '../../src/book/blockIndex'
import { fitBatch } from '../../src/book/rekey'
import {
  applyBatch,
  type Block,
  type BoardState,
  blocksOf,
  LIMITS,
  type Op,
  posBetween,
  posKeysBetween,
  stateFromRecords,
} from '../../src/index'
import { fixtureId, makeBlock, makeBoard, makeBook } from '../fixtures'

const ctx = { now: '2026-10-27T12:00:00.000Z' }
const BOOK = fixtureId('book', 1)
const OTHER = fixtureId('book', 2)
const id = (n: number) => fixtureId('block', n)

/** A book of blocks `[n, pos]`, each with the text `abcdef`; `others` are blocks of a second book. */
function book(blocks: [number, string][], others: [number, string][] = []): BoardState {
  const of = (bookId: string) => (b: [number, string]) =>
    makeBlock({ id: id(b[0]), bookId, pos: b[1], text: 'abcdef' })
  return stateFromRecords(makeBoard(), [
    makeBook({ id: BOOK }),
    makeBook({ id: OTHER }),
    ...blocks.map(of(BOOK)),
    ...others.map(of(OTHER)),
  ])
}

type Split = Extract<Op, { op: 'block.split' }>

const split = (head: number, newN: number, pos: string): Split => ({
  op: 'block.split',
  bookId: BOOK,
  id: id(head),
  at: 3,
  newId: id(newN),
  pos,
  kind: 'p',
})
const move = (n: number, pos: string, after: number | null): Op => ({
  op: 'block.set',
  bookId: BOOK,
  id: id(n),
  set: { pos },
  after: after === null ? null : id(after),
})
/** A key set without saying what the block follows: the editor's re-spacing. */
const respace = (n: number, pos: string): Op => ({
  op: 'block.set',
  bookId: BOOK,
  id: id(n),
  set: { pos },
})
const create = (n: number, pos: string, after?: number): Op => ({
  op: 'block.create',
  block: makeBlock({ id: id(n), bookId: BOOK, pos, text: 'abcdef' }),
  ...(after === undefined ? {} : { after: id(after) }),
})

/** The book's block numbers in order once `ops`, fitted, apply. */
function orderAfter(state: BoardState, ops: Op[]): number[] {
  const numbers = new Map<string, number>()
  for (let n = 0; n < 100; n++) numbers.set(id(n), n)
  const after = applyBatch(state, fitBatch(state, ops), ctx)
  return blocksOf(after, BOOK).map((b) => numbers.get(b.id) as number)
}

/** The key `ops`, fitted, give op `i`'s block. */
function keyAt(state: BoardState, ops: Op[], i: number): string | undefined {
  const op = fitBatch(state, ops)[i] as Op
  if (op.op === 'block.split') return op.pos
  return op.op === 'block.set' ? op.set.pos : undefined
}

describe('fitBatch: nothing to fit', () => {
  const s = book([
    [1, 'K'],
    [2, 'V'],
    [3, 'c'],
  ])

  it('returns the very ops of a batch without a split or a move that names a block', () => {
    const ops: Op[] = [
      { op: 'block.edit', bookId: BOOK, id: id(1), splices: [{ at: 0, del: 1, ins: 'x' }] },
      // A create is never fitted, even one that says what it follows.
      create(4, 'z', 1),
      respace(2, 'd'),
      { op: 'block.set', bookId: BOOK, id: id(3), set: { kind: 'h1' } },
      { op: 'block.merge', bookId: BOOK, from: id(3), into: id(1), at: 6 },
      { op: 'block.delete', bookId: BOOK, id: id(2) },
    ]
    expect(fitBatch(s, ops)).toBe(ops)
    expect(fitBatch(s, [])).toEqual([])
  })

  it('returns the very ops when every key already lies between its two neighbours', () => {
    const ops = [split(1, 4, 'P'), move(3, 'L', 1), move(2, 'z', 4), move(2, 'A', null)]
    expect(fitBatch(s, ops)).toBe(ops)
  })
})

describe('fitBatch: a split', () => {
  const s = book([
    [1, 'K'],
    [2, 'V'],
    [3, 'c'],
  ])

  it('keys the new block between its head and the block after it, when its key is past that block', () => {
    const ops = [split(1, 4, 'X')]
    const fitted = fitBatch(s, ops)
    expect(fitted).not.toBe(ops)
    expect(fitted).toEqual([split(1, 4, posBetween('K', 'V'))])
    expect(orderAfter(s, ops)).toEqual([1, 4, 2, 3])
  })

  it('keys it after its head when its key is at or before the head’s', () => {
    expect(orderAfter(s, [split(2, 4, 'A')])).toEqual([1, 2, 4, 3])
    expect(keyAt(s, [split(2, 4, 'V')], 0)).toBe(posBetween('V', 'c'))
  })

  it('never leaves it on the key of the block after its head', () => {
    expect(keyAt(s, [split(1, 4, 'V')], 0)).toBe(posBetween('K', 'V'))
  })

  it('keys it after the last block when its head is the last', () => {
    expect(keyAt(s, [split(3, 4, 'd')], 0)).toBe('d')
    expect(keyAt(s, [split(3, 4, 'A')], 0)).toBe(posBetween('c', null))
  })

  it('changes only the ops it re-keys, and copies those', () => {
    const ops = [split(1, 4, 'P'), split(2, 5, 'z')]
    const fitted = fitBatch(s, ops)
    expect(fitted[0]).toBe(ops[0])
    expect(fitted[1]).not.toBe(ops[1])
    expect(ops[1]).toEqual(split(2, 5, 'z'))
  })

  it('keeps its key when its head is not in the book', () => {
    const ops = [split(9, 4, 'z')]
    expect(fitBatch(s, ops)).toBe(ops)
  })
})

describe('fitBatch: a split whose head has notes beside it', () => {
  /** Paragraph 1, a footnote and a prompt beside it, paragraph 2. */
  const withNotes = (pos6 = 'k') =>
    stateFromRecords(makeBoard(), [
      makeBook({ id: BOOK }),
      makeBlock({ id: id(1), bookId: BOOK, pos: 'K', text: 'abcdef' }),
      makeBlock({ id: id(5), bookId: BOOK, pos: 'V', kind: 'footnote', text: 'abcdef' }),
      makeBlock({ id: id(6), bookId: BOOK, pos: 'c', kind: 'prompt', text: 'abcdef' }),
      makeBlock({ id: id(2), bookId: BOOK, pos: pos6, text: 'abcdef' }),
    ])
  const s = withNotes()

  it('keeps a key past the notes, before the block after them', () => {
    // As the undo of a join past the notes has it: the paragraph's own key of before.
    const ops = [split(1, 4, 'f')]
    expect(fitBatch(s, ops)).toBe(ops)
    expect(orderAfter(s, ops)).toEqual([1, 5, 6, 4, 2])
  })

  it('keeps a key between two of the notes', () => {
    const ops = [split(1, 4, 'X')]
    expect(fitBatch(s, ops)).toBe(ops)
    expect(orderAfter(s, ops)).toEqual([1, 5, 4, 6, 2])
  })

  it('keeps a key past the notes when they end the book', () => {
    const end = applyBatch(s, [{ op: 'block.delete', bookId: BOOK, id: id(2) }], ctx)
    const ops = [split(1, 4, 'z')]
    expect(fitBatch(end, ops)).toBe(ops)
    expect(orderAfter(end, ops)).toEqual([1, 5, 6, 4])
  })

  it('keys it right after its head when its key is past the block after the notes, or on a block’s key', () => {
    const first = posBetween('K', 'V')
    // Past paragraph 2; on paragraph 2's key; on a note's key.
    for (const pos of ['z', 'k', 'V', 'c']) expect(keyAt(s, [split(1, 4, pos)], 0)).toBe(first)
    expect(orderAfter(s, [split(1, 4, 'z')])).toEqual([1, 4, 5, 6, 2])
  })

  it('does not pass a block that is not a note', () => {
    // Paragraph 3 between the head and its key, then a prompt.
    const t = stateFromRecords(makeBoard(), [
      makeBook({ id: BOOK }),
      makeBlock({ id: id(1), bookId: BOOK, pos: 'K', text: 'abcdef' }),
      makeBlock({ id: id(3), bookId: BOOK, pos: 'V', text: 'abcdef' }),
      makeBlock({ id: id(6), bookId: BOOK, pos: 'c', kind: 'prompt', text: 'abcdef' }),
    ])
    expect(orderAfter(t, [split(1, 4, 'f')])).toEqual([1, 4, 3, 6])
  })

  it('does not pass the notes after a head that is a note itself', () => {
    expect(keyAt(s, [split(5, 4, 'f')], 0)).toBe(posBetween('V', 'c'))
  })

  it('reads the kinds as the batch leaves them', () => {
    // A prompt the batch makes after the head is passed; one it turns into a paragraph is not.
    const made: Op = {
      op: 'block.create',
      block: makeBlock({ id: id(7), bookId: BOOK, pos: 'M', kind: 'prompt', text: 'abcdef' }),
    }
    const plain = book([
      [1, 'K'],
      [2, 'k'],
    ])
    expect(orderAfter(plain, [made, split(1, 4, 'f')])).toEqual([1, 7, 4, 2])
    const toParagraph: Op = { op: 'block.set', bookId: BOOK, id: id(6), set: { kind: 'p' } }
    expect(orderAfter(s, [toParagraph, split(1, 4, 'f')])).toEqual([1, 4, 5, 6, 2])
    // A block split off as a prompt is a note for the split after it.
    const asPrompt = { ...split(1, 8, 'M'), kind: 'prompt' as const }
    expect(orderAfter(plain, [asPrompt, split(1, 4, 'f')])).toEqual([1, 8, 4, 2])
  })

  it('a move after a block with notes goes right after the block it names', () => {
    // A move names the very block before it (a note too), so it never passes one.
    expect(orderAfter(s, [move(2, 'f', 1)])).toEqual([1, 2, 5, 6])
    const ops = [move(2, 'f', 6)]
    expect(fitBatch(s, ops)).toBe(ops)
  })
})

describe('fitBatch: a move that names the block it follows', () => {
  const s = book(
    [
      [1, 'K'],
      [2, 'V'],
      [3, 'c'],
      [4, 'k'],
    ],
    [[20, 'V']],
  )

  it('keys the block between the one it follows and the block after that', () => {
    expect(keyAt(s, [move(4, 'z', 1)], 0)).toBe(posBetween('K', 'V'))
    expect(orderAfter(s, [move(4, 'z', 1)])).toEqual([1, 4, 2, 3])
  })

  it('keys it before the first block for `after: null`', () => {
    expect(keyAt(s, [move(3, 'z', null)], 0)).toBe(posBetween(null, 'K'))
    expect(orderAfter(s, [move(3, 'z', null)])).toEqual([3, 1, 2, 4])
  })

  it('does not count the moved block’s own place as the block after', () => {
    // Block 2 is right after block 1: its new key need only come before block 3's.
    const ops = [move(2, 'a', 1)]
    expect(fitBatch(s, ops)).toBe(ops)
    expect(keyAt(s, [move(2, 'd', 1)], 0)).toBe(posBetween('K', 'c'))
  })

  it('keeps its key when the block it follows is gone, in another book, or deleted by the batch', () => {
    for (const ops of [
      [move(4, 'A', 9)],
      [move(4, 'A', 20)],
      [{ op: 'block.delete', bookId: BOOK, id: id(2) } as Op, move(4, 'A', 2)],
    ]) {
      expect(fitBatch(s, ops)).toBe(ops)
    }
  })

  it('keeps its key when the moved block is gone', () => {
    const ops = [move(9, 'z', 1)]
    expect(fitBatch(s, ops)).toBe(ops)
  })

  it('keys a run of moves, each after the one before, together over the gap', () => {
    // Blocks 3 and 4 and then 2 put after block 1, with keys that are past the gap.
    const s5 = book([
      [1, 'K'],
      [5, 'M'],
      [2, 'V'],
      [3, 'c'],
      [4, 'k'],
    ])
    const ops = [move(3, 'x', 1), move(4, 'y', 3), move(2, 'z', 4)]
    const keys = posKeysBetween('K', 'M', 3)
    expect(fitBatch(s5, ops)).toEqual([
      move(3, keys[0] as string, 1),
      move(4, keys[1] as string, 3),
      move(2, keys[2] as string, 4),
    ])
    expect(orderAfter(s5, ops)).toEqual([1, 3, 4, 2, 5])
  })

  it('keys moves after the same block each right after it, the last one first', () => {
    // As the undo of a chapter move has them: in reverse, each after the same block.
    expect(orderAfter(s, [move(4, 'z', 1), move(3, 'z', 1)])).toEqual([1, 3, 4, 2])
  })
})

describe('fitBatch: the book as the batch leaves it', () => {
  const s = book([
    [1, 'K'],
    [2, 'V'],
    [3, 'c'],
  ])

  it('fits against a block the batch made, moved or re-keyed before the op', () => {
    expect(orderAfter(s, [create(4, 'M'), split(1, 5, 'P')])).toEqual([1, 5, 4, 2, 3])
    expect(orderAfter(s, [respace(3, 'L'), split(1, 5, 'P')])).toEqual([1, 5, 3, 2])
    expect(orderAfter(s, [split(1, 4, 'P'), split(1, 5, 'Q')])).toEqual([1, 5, 4, 2, 3])
  })

  it('does not fit against a block the batch deleted or joined away before the op', () => {
    const deleted: Op[] = [{ op: 'block.delete', bookId: BOOK, id: id(2) }, split(1, 4, 'X')]
    expect(fitBatch(s, deleted)).toBe(deleted)
    const joined: Op[] = [
      { op: 'block.merge', bookId: BOOK, from: id(2), into: id(1), at: 6 },
      split(1, 2, 'X'),
    ]
    expect(fitBatch(s, joined)).toBe(joined)
    expect(orderAfter(s, joined)).toEqual([1, 2, 3])
  })

  it('follows a block to where the batch moved it', () => {
    // Block 1 goes to the end; the split's new block follows it there.
    expect(orderAfter(s, [respace(1, 'x'), split(1, 4, 'L')])).toEqual([2, 3, 1, 4])
    // A block made by a split earlier in the batch is a head like any other.
    expect(orderAfter(s, [split(1, 4, 'P'), split(4, 5, 'z')])).toEqual([1, 4, 5, 2, 3])
  })

  it('keeps the key of an op whose head the batch re-keys later', () => {
    const ops = [split(1, 4, 'z'), respace(1, 'y')]
    expect(fitBatch(s, ops)).toBe(ops)
    const moves = [move(3, 'A', 2), respace(2, '9')]
    expect(fitBatch(s, moves)).toBe(moves)
  })
})

describe('fitBatch: where no key is left', () => {
  it('keeps the op’s key between two blocks of one key', () => {
    const s = book([
      [1, 'V'],
      [2, 'V'],
    ])
    const ops = [split(1, 4, 'z')]
    expect(fitBatch(s, ops)).toBe(ops)
  })

  it('keeps the op’s key where a key between would pass `maxPosLength`', () => {
    const tight = `V${'0'.repeat(LIMITS.maxPosLength - 2)}1`
    expect(posBetween('V', tight).length).toBeGreaterThan(LIMITS.maxPosLength)
    const s = book([
      [1, 'V'],
      [2, tight],
    ])
    const ops = [split(1, 4, 'z')]
    expect(fitBatch(s, ops)).toBe(ops)
    // A run that finds no room for its keys together: each move keeps its own.
    const t = book([
      [1, 'V'],
      [2, tight],
      [3, 'c'],
      [5, 'd'],
    ])
    const run = [move(3, 'x', 1), move(5, 'y', 3)]
    expect(fitBatch(t, run)).toBe(run)
  })
})

describe('fitBatch: any book', () => {
  /** Few keys, so blocks often share one. */
  const POS = ['8', 'K', 'V', 'V', 'c', 'c1', 'z']
  const arbBook = fc.uniqueArray(fc.nat(40), { minLength: 1, maxLength: 30 }).chain((ns) =>
    fc.record({
      blocks: fc.tuple(
        ...ns.map((n) => fc.nat(POS.length - 1).map((p) => [n + 1, POS[p]] as [number, string])),
      ),
      head: fc.nat(ns.length - 1),
      pos: fc.nat(POS.length - 1),
    }),
  )

  it('a split’s new block is right after its head wherever their keys leave room', () => {
    fc.assert(
      fc.property(arbBook, ({ blocks, head, pos }) => {
        const restore = chunkSizeForTests(4)
        try {
          const s = book(blocks)
          const order = blocksOf(s, BOOK)
          const h = order[head] as Block
          const next = order[head + 1]
          const op = { ...split(1, 99, POS[pos] as string), id: h.id }
          const [fitted] = fitBatch(s, [op]) as [Split]
          if (next !== undefined && next.pos === h.pos) expect(fitted).toBe(op)
          else {
            expect(h.pos < fitted.pos).toBe(true)
            if (next !== undefined) expect(fitted.pos < next.pos).toBe(true)
            const after = blocksOf(applyBatch(s, [fitted], ctx), BOOK).map((b) => b.id)
            expect(after[after.indexOf(h.id) + 1]).toBe(id(99))
          }
        } finally {
          restore()
        }
      }),
      { numRuns: 200 },
    )
  })
})

describe('fitBatch: at size', () => {
  it('fits a split deep in a book of many chunks, and a long run of moves', () => {
    const n = 5000
    const keys = posKeysBetween(null, null, n)
    const blocks = keys.map((pos, i) => makeBlock({ id: id(i), bookId: BOOK, pos, text: 'abcdef' }))
    const s = stateFromRecords(makeBoard(), [makeBook({ id: BOOK }), ...blocks])
    const far = keys[n - 1] as string
    const [fitted] = fitBatch(s, [split(3210, n, far)]) as [Split]
    expect((keys[3210] as string) < fitted.pos && fitted.pos < (keys[3211] as string)).toBe(true)

    // The last `maxOpsPerBatch` blocks moved to after block 9, each after the one before.
    const count = LIMITS.maxOpsPerBatch
    const run: Op[] = []
    for (let i = 0; i < count; i++) {
      run.push(move(n - count + i, far, i === 0 ? 9 : n - count + i - 1))
    }
    const moved = fitBatch(s, run).map((op) =>
      op.op === 'block.set' ? (op.set.pos as string) : '',
    )
    expect(moved).toEqual(posKeysBetween(keys[9] as string, keys[10] as string, count))
    const order = blocksOf(applyBatch(s, fitBatch(s, run), ctx), BOOK).map((b) => b.id)
    expect(order.slice(9, 12)).toEqual([id(9), id(n - count), id(n - count + 1)])
    expect(order[10 + count]).toBe(id(10))
  })
})
