/**
 * The outline's chapter move: a chapter (its heading and the blocks up to the
 * next) placed before another chapter, or at the book's end, as `block.set pos` ops of whichever
 * side has fewer blocks: the chapter, or the chapters it passes.
 */
import {
  applyBatch,
  type Block,
  type BoardState,
  bookBlocks,
  type ClientOp,
  emptyBoardState,
  LIMITS,
  posKeysBetween,
  stateFromRecords,
} from '@papertie/core'
import { chaptersOf, planChapterMove } from '../../src/book/chapterMove'
import { book } from '../helpers/books'
import { BOARD_ID, idOf, T0 } from '../helpers/fakeServer'

const BOOK = idOf('book', 7)

/** A board with `BOOK` of `kinds.length` blocks: `idOf('block', i + 1)`, text `w<i>`, in order. */
function bookOf(kinds: readonly Block['kind'][]): BoardState {
  const keys = posKeysBetween(null, null, kinds.length)
  const blocks: Block[] = kinds.map((kind, i) => ({
    type: 'block',
    id: idOf('block', i + 1),
    bookId: BOOK,
    pos: keys[i] as string,
    kind,
    text: `w${i}`,
    marks: [],
  }))
  const empty = emptyBoardState(BOARD_ID, 'Test board', T0)
  return stateFromRecords(empty.board, [book(BOOK), ...blocks])
}

/** Chapters of `sizes` blocks each (a heading and paragraphs), after a preface of `preface`. */
const chapters = (sizes: readonly number[], preface = 0): Block['kind'][] => [
  ...Array<Block['kind']>(preface).fill('p'),
  ...sizes.flatMap((n) => ['h1' as const, ...Array<Block['kind']>(n - 1).fill('p')]),
]

const order = (s: BoardState) =>
  bookBlocks(s.blocks, BOOK)
    .chunks.flat()
    .map((b) => b.text)
const heading = (s: BoardState, k: number) =>
  bookBlocks(s.blocks, BOOK)
    .chunks.flat()
    .filter((b) => b.kind === 'h1')[k] as Block

/** The texts `w<from>` to `w<to - 1>`. */
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `w${from + i}`)

describe('planChapterMove', () => {
  it('a chapter move of 30,001 blocks past 29,999 emits 29,999 ops and keeps every word', () => {
    // 60,000 blocks: the first chapter 30,001, the two after it 15,000 and 14,999.
    const s = bookOf(chapters([30_001, 15_000, 14_999]))
    expect(bookBlocks(s.blocks, BOOK).count).toBe(LIMITS.maxBlocksPerBook)
    const first = heading(s, 0)
    const ops = planChapterMove(s, BOOK, first.id, null)
    // The two chapters it passes move ahead of it: they are fewer.
    expect(ops).toHaveLength(29_999)
    expect(ops.length).toBeLessThanOrEqual(LIMITS.maxBlocksPerBook / 2)
    expect(ops.length).toBeLessThanOrEqual(64 * LIMITS.maxOpsPerBatch)
    for (const op of ops) {
      expect(op.op).toBe('block.set')
      if (op.op !== 'block.set') continue
      expect(Object.keys(op.set)).toEqual(['pos'])
      expect((op.set.pos as string).length).toBeLessThanOrEqual(LIMITS.maxPosLength)
      expect(op.bookId).toBe(BOOK)
    }
    const after = applyBatch(s, ops, { now: T0 })
    // Every word kept, in the order asked: the two chapters, then the moved one.
    expect(order(after)).toEqual([...range(30_001, 60_000), ...range(0, 30_001)])
    for (const b of bookBlocks(after.blocks, BOOK).chunks.flat())
      expect(b.text).toBe(s.blocks.get(b.id)?.text)
  })

  it('never moves more than half a book: with no room for the smaller side, none (minor 1)', () => {
    // A preface paragraph and the first chapter's heading keyed with no key between them
    // (maxPosLength digits each), then the rest: chapter A of 30,001 blocks, B of 29,998.
    const tight = (d: string) => `${'0'.repeat(LIMITS.maxPosLength - 1)}${d}`
    const n = 1 + 30_001 + 29_998
    const rest = posKeysBetween('1', null, n - 2)
    const kinds: Block['kind'][] = ['p', ...chapters([30_001, 29_998])]
    const blocks: Block[] = kinds.map((kind, i) => ({
      type: 'block',
      id: idOf('block', i + 1),
      bookId: BOOK,
      pos: i === 0 ? tight('1') : i === 1 ? tight('2') : (rest[i - 2] as string),
      kind,
      text: `w${i}`,
      marks: [],
    }))
    const s = stateFromRecords(emptyBoardState(BOARD_ID, 'Test board', T0).board, [
      book(BOOK),
      ...blocks,
    ])
    // A to the end: B (the fewer) would go before A, where there is no key; A itself is more
    // than a staged batch may carry. Nothing is moved.
    expect(planChapterMove(s, BOOK, heading(s, 0).id, null)).toEqual([])
  })

  it('moves whichever side is fewer, either way, past a preface; a move to where it is is none', () => {
    // A preface of 2, then chapters of 3, 5 and 2 blocks: w2–w4, w5–w9, w10–w11.
    const s = bookOf(chapters([3, 5, 2], 2))
    const [a, b, c] = [heading(s, 0), heading(s, 1), heading(s, 2)]
    expect(chaptersOf(s, BOOK)).toEqual([
      { id: a.id, title: 'w2' },
      { id: b.id, title: 'w5' },
      { id: c.id, title: 'w10' },
    ])
    const apply = (ops: ClientOp[]) => order(applyBatch(s, ops, { now: T0 }))
    const pre = range(0, 2)
    const A = range(2, 5)
    const B = range(5, 10)
    const C = range(10, 12)

    // A (3) to the end, past B and C (7): A's blocks move.
    let ops = planChapterMove(s, BOOK, a.id, null)
    expect(ops).toHaveLength(3)
    expect(apply(ops)).toEqual([...pre, ...B, ...C, ...A])
    // A before C, past B (5): A moves.
    ops = planChapterMove(s, BOOK, a.id, c.id)
    expect(ops).toHaveLength(3)
    expect(apply(ops)).toEqual([...pre, ...B, ...A, ...C])
    // B (5) before A (3): A moves after B instead.
    ops = planChapterMove(s, BOOK, b.id, a.id)
    expect(ops).toHaveLength(3)
    expect(apply(ops)).toEqual([...pre, ...B, ...A, ...C])
    // C (2) before A, past A and B (8): C moves; the preface stays first.
    ops = planChapterMove(s, BOOK, c.id, a.id)
    expect(ops).toHaveLength(2)
    expect(apply(ops)).toEqual([...pre, ...C, ...A, ...B])
    // B to the end, past C (2): C moves.
    ops = planChapterMove(s, BOOK, b.id, null)
    expect(ops).toHaveLength(2)
    expect(apply(ops)).toEqual([...pre, ...A, ...C, ...B])

    // Where it is already: before itself, before the chapter after it, the last to the end.
    expect(planChapterMove(s, BOOK, b.id, b.id)).toEqual([])
    expect(planChapterMove(s, BOOK, b.id, c.id)).toEqual([])
    expect(planChapterMove(s, BOOK, c.id, null)).toEqual([])
    // Not a chapter, or not this book's: nothing.
    expect(planChapterMove(s, BOOK, idOf('block', 1), null)).toEqual([])
    expect(planChapterMove(s, BOOK, idOf('block', 99), null)).toEqual([])
    expect(planChapterMove(s, BOOK, a.id, idOf('block', 7))).toEqual([])
    expect(planChapterMove(s, idOf('book', 8), a.id, null)).toEqual([])
  })

  it('each block moved says the block it follows', () => {
    // A preface of 2, then chapters of 3, 5 and 2 blocks: w2–w4, w5–w9, w10–w11.
    const s = bookOf(chapters([3, 5, 2], 2))
    const [a, b, c] = [heading(s, 0), heading(s, 1), heading(s, 2)]
    const ids = bookBlocks(s.blocks, BOOK)
      .chunks.flat()
      .map((x) => x.id)
    const follows = (ops: ClientOp[]) => ops.map((op) => (op.op === 'block.set' ? op.after : 0))
    // A before C: A's blocks go after B's last (w9), each after the one before.
    expect(follows(planChapterMove(s, BOOK, a.id, c.id))).toEqual([ids[9], ids[2], ids[3]])
    // C before A: C's blocks go after the preface's last (w1).
    expect(follows(planChapterMove(s, BOOK, c.id, a.id))).toEqual([ids[1], ids[10]])
    // B to the end: C (fewer) goes before B, after A's last (w4).
    expect(follows(planChapterMove(s, BOOK, b.id, null))).toEqual([ids[4], ids[10]])
    // To the book's start: after nothing.
    const t = bookOf(chapters([3, 2]))
    const [, second] = [heading(t, 0), heading(t, 1)]
    const tIds = bookBlocks(t.blocks, BOOK)
      .chunks.flat()
      .map((x) => x.id)
    expect(follows(planChapterMove(t, BOOK, second.id, heading(t, 0).id))).toEqual([null, tIds[3]])
  })
})
