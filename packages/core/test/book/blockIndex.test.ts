import fc from 'fast-check'
import { bookBlocks, chunkSizeForTests } from '../../src/book/blockIndex'
import {
  applyBatch,
  type Block,
  type BoardState,
  blocksOf,
  commitBatch,
  type Op,
  OpError,
  stateBuilder,
  stateFromRecords,
} from '../../src/index'
import { fixtureId, makeBlock, makeBoard, makeBook } from '../fixtures'

const NOW = '2026-10-27T12:00:00.000Z'
const ctx = { now: NOW }
const BOOKS = [1, 2, 3].map((i) => fixtureId('book', i))
/** Few keys, so blocks often share one and `id` breaks the tie. */
const POS = ['K', 'V', 'V', 'c', 'c1', 'z']

const byPosId = (x: Block, y: Block) =>
  x.pos < y.pos ? -1 : x.pos > y.pos ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0

/** What the index must equal: the book's blocks found by a scan, in `(pos, id)` order. */
function rebuilt(state: BoardState, bookId: string): Block[] {
  return [...state.blocks.values()].filter((b) => b.bookId === bookId).sort(byPosId)
}

type Step =
  | { k: 'create'; book: number; n: number; pos: number; text: string }
  | { k: 'delete'; n: number }
  | { k: 'pos'; n: number; pos: number }
  | { k: 'edit'; n: number; at: number; del: number; ins: string }
  | { k: 'split'; n: number; at: number; m: number; pos: number }
  | { k: 'merge'; n: number; m: number }

const arbStep: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    k: fc.constant('create' as const),
    book: fc.nat(2),
    n: fc.nat(60),
    pos: fc.nat(POS.length - 1),
    text: fc.string({ maxLength: 8 }),
  }),
  fc.record({ k: fc.constant('delete' as const), n: fc.nat(60) }),
  fc.record({ k: fc.constant('pos' as const), n: fc.nat(60), pos: fc.nat(POS.length - 1) }),
  fc.record({
    k: fc.constant('edit' as const),
    n: fc.nat(60),
    at: fc.nat(10),
    del: fc.nat(3),
    ins: fc.string({ maxLength: 5 }),
  }),
  fc.record({
    k: fc.constant('split' as const),
    n: fc.nat(60),
    at: fc.nat(10),
    m: fc.nat(60),
    pos: fc.nat(POS.length - 1),
  }),
  fc.record({ k: fc.constant('merge' as const), n: fc.nat(60), m: fc.nat(60) }),
)

/** The op a step names against `s`, or null when it names nothing there. */
function opOf(s: BoardState, step: Step): Op | null {
  const id = fixtureId('block', step.n)
  const block = s.blocks.get(id)
  switch (step.k) {
    case 'create':
      return {
        op: 'block.create',
        block: makeBlock({ id, bookId: BOOKS[step.book], pos: POS[step.pos], text: step.text }),
      }
    case 'delete':
      return block ? { op: 'block.delete', bookId: block.bookId, id } : null
    case 'pos':
      return block
        ? { op: 'block.set', bookId: block.bookId, id, set: { pos: POS[step.pos] as string } }
        : null
    case 'edit': {
      if (!block) return null
      const at = Math.min(step.at, block.text.length)
      const del = Math.min(step.del, block.text.length - at)
      return {
        op: 'block.edit',
        bookId: block.bookId,
        id,
        splices: [{ at, del, ins: step.ins }],
      }
    }
    case 'split':
      return block
        ? {
            op: 'block.split',
            bookId: block.bookId,
            id,
            at: Math.min(step.at, block.text.length),
            newId: fixtureId('block', step.m),
            pos: POS[step.pos] as string,
            kind: 'p',
          }
        : null
    case 'merge': {
      const into = s.blocks.get(fixtureId('block', step.m))
      return block && into && into.bookId === block.bookId && into.id !== id
        ? { op: 'block.merge', bookId: block.bookId, from: id, into: into.id, at: into.text.length }
        : null
    }
  }
}

function run(steps: readonly Step[], check: (s: BoardState) => void): void {
  let s = stateFromRecords(
    makeBoard(),
    BOOKS.map((id) => makeBook({ id })),
  )
  let rev = 0
  for (const [i, step] of steps.entries()) {
    const op = opOf(s, step)
    if (op === null) continue
    try {
      // Commits and plain batches both keep the index (the commit's stamp rewrites the records).
      s = i % 2 === 0 ? applyBatch(s, [op], ctx) : commitBatch(s, [op], NOW, null)
      rev++
    } catch (e) {
      if (!(e instanceof OpError)) throw e
    }
    if (i % 100 === 99) check(s)
  }
  check(s)
  expect(rev).toBeGreaterThan(0)
}

describe('block index', () => {
  it('blocksOf stays in (pos, id) order and equals a rebuild after 1,000 random ops', () => {
    fc.assert(
      fc.property(fc.array(arbStep, { minLength: 1_000, maxLength: 1_000 }), (steps) => {
        run(steps, (s) => {
          for (const bookId of BOOKS) expect(blocksOf(s, bookId)).toEqual(rebuilt(s, bookId))
          // A state loaded from the same records indexes them the same.
          const loaded = stateFromRecords(s.board, [...s.books.values(), ...s.blocks.values()])
          for (const bookId of BOOKS) expect(blocksOf(loaded, bookId)).toEqual(rebuilt(s, bookId))
        })
      }),
      { numRuns: 8 },
    )
  })

  it('the index’s chars equal the sum of text lengths after 1,000 random ops', () => {
    fc.assert(
      fc.property(fc.array(arbStep, { minLength: 1_000, maxLength: 1_000 }), (steps) => {
        run(steps, (s) => {
          for (const bookId of BOOKS) {
            const sum = rebuilt(s, bookId).reduce((n, b) => n + b.text.length, 0)
            expect(bookBlocks(s.blocks, bookId).chars).toBe(sum)
          }
        })
      }),
      { numRuns: 8 },
    )
  })

  it('an earlier state keeps its index: batches change their own arrays, never a state’s', () => {
    fc.assert(
      fc.property(fc.array(arbStep, { minLength: 600, maxLength: 600 }), (steps) => {
        const kept: Array<[BoardState, Block[][]]> = []
        run(steps, (s) => {
          kept.push([s, BOOKS.map((id) => [...blocksOf(s, id)])])
        })
        for (const [s, lists] of kept) {
          BOOKS.forEach((id, i) => {
            // The chunks themselves (not the list `blocksOf` made of them then).
            expect(bookBlocks(s.blocks, id).chunks.flat()).toEqual(lists[i])
            expect(rebuilt(s, id)).toEqual(lists[i])
          })
        }
      }),
      { numRuns: 4 },
    )
  })

  it('kept states survive chunk splits and joins: many blocks, batches of many ops, tiny chunks', () => {
    // Chunks of 4 (8 at most), so a book of hundreds spans many and every batch splits and joins
    // them, under the draft's in-place edits.
    const restore = chunkSizeForTests(4)
    try {
      const arbBatch = fc.array(
        fc.record({
          create: fc.boolean(),
          n: fc.nat(900),
          book: fc.nat(1),
          pos: fc.nat(POS.length - 1),
        }),
        { minLength: 1, maxLength: 40 },
      )
      fc.assert(
        fc.property(fc.array(arbBatch, { minLength: 20, maxLength: 40 }), (batches) => {
          let s = stateFromRecords(
            makeBoard(),
            BOOKS.map((id) => makeBook({ id })),
          )
          const kept: Array<[BoardState, Block[][]]> = []
          for (const [i, batch] of batches.entries()) {
            const ops: Op[] = []
            const named = new Set<string>()
            for (const step of batch) {
              const id = fixtureId('block', step.n)
              if (named.has(id)) continue
              named.add(id)
              const held = s.blocks.get(id)
              if (held) ops.push({ op: 'block.delete', bookId: held.bookId, id })
              else if (step.create) {
                ops.push({
                  op: 'block.create',
                  block: makeBlock({
                    id,
                    bookId: BOOKS[step.book],
                    pos: POS[step.pos],
                    text: 'ab',
                  }),
                })
              }
            }
            if (ops.length === 0) continue
            s = i % 2 === 0 ? applyBatch(s, ops, ctx) : commitBatch(s, ops, NOW, null)
            kept.push([s, BOOKS.map((id) => bookBlocks(s.blocks, id).chunks.flat())])
          }
          for (const [k, lists] of kept) {
            BOOKS.forEach((id, j) => {
              expect(bookBlocks(k.blocks, id).chunks.flat()).toEqual(lists[j])
              expect(lists[j]).toEqual(rebuilt(k, id))
              for (const chunk of bookBlocks(k.blocks, id).chunks) {
                expect(chunk.length).toBeLessThanOrEqual(8)
              }
            })
          }
          // Big enough to have crossed chunks.
          expect(
            Math.max(...BOOKS.map((id) => bookBlocks(s.blocks, id).chunks.length)),
          ).toBeGreaterThan(2)
        }),
        { numRuns: 25 },
      )
    } finally {
      restore()
    }
  })

  it('keeps equal pos keys apart by id, in a chunked book of thousands', () => {
    const blocks = Array.from({ length: 3_000 }, (_, i) =>
      makeBlock({ id: fixtureId('block', 3_000 - i), bookId: BOOKS[0], pos: i % 2 ? 'V' : 'W' }),
    )
    const s = stateFromRecords(makeBoard(), [makeBook({ id: BOOKS[0] }), ...blocks])
    expect(blocksOf(s, BOOKS[0] as string)).toEqual(rebuilt(s, BOOKS[0] as string))
    expect(blocksOf(s, BOOKS[1] as string)).toEqual([])
    expect(bookBlocks(s.blocks, BOOKS[1] as string).chars).toBe(0)
    // Deleting most of them, a few at a time.
    let t = s
    for (let i = 1; i <= 2_900; i += 50) {
      const ops: Op[] = []
      for (let j = i; j < i + 50; j++) {
        ops.push({ op: 'block.delete', bookId: BOOKS[0] as string, id: fixtureId('block', j) })
      }
      t = applyBatch(t, ops, ctx)
    }
    expect(blocksOf(t, BOOKS[0] as string)).toEqual(rebuilt(t, BOOKS[0] as string))
    expect(blocksOf(t, BOOKS[0] as string)).toHaveLength(100)
  })

  it('a state built a batch at a time indexes its blocks as one built at once', () => {
    const records = [
      makeBook({ id: BOOKS[0] }),
      ...Array.from({ length: 500 }, (_, i) =>
        makeBlock({
          id: fixtureId('block', i),
          bookId: BOOKS[0],
          pos: POS[i % POS.length],
          text: 'ab',
        }),
      ),
    ]
    const b = stateBuilder(makeBoard(), { books: 1, blocks: 500 })
    for (let i = 0; i < records.length; i += 64) b.add(records.slice(i, i + 64))
    // A block given again (the same id) replaces the one before it.
    b.add([makeBlock({ id: fixtureId('block', 3), bookId: BOOKS[0], pos: 'zz', text: 'abcd' })])
    const s = b.finish()
    expect(blocksOf(s, BOOKS[0] as string)).toEqual(rebuilt(s, BOOKS[0] as string))
    expect(bookBlocks(s.blocks, BOOKS[0] as string).chars).toBe(500 * 2 + 2)
    expect(s.blocksHeld).toBe('all')
  })
})
