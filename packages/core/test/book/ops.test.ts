import fc from 'fast-check'
import {
  applyBatch,
  applyOp,
  type Block,
  BlockRecordSchema,
  type BoardState,
  blocksOf,
  ClientOpSchema,
  commitChanges,
  invertBatch,
  invertOp,
  LIMITS,
  type Mark,
  normalizeMarks,
  type Op,
  OpError,
  OpSchema,
  releaseBook,
  stateFromRecords,
  stripTimestamps,
  validateInvariants,
} from '../../src/index'
import { fixtureId, makeBlock, makeBoard, makeBook, T0 } from '../fixtures'

const NOW = '2026-10-27T12:00:00.000Z'
const ctx = { now: NOW }
const BOOK = fixtureId('book', 1)
const B1 = fixtureId('block', 1)
const B2 = fixtureId('block', 2)
const B3 = fixtureId('block', 3)
const tab = fixtureId('tab', 1)

function state(blocks: Block[] = [makeBlock({ id: B1, text: 'Hello world', marks: [] })]) {
  return stateFromRecords(makeBoard({ revision: 3 }), [makeBook({ id: BOOK }), ...blocks])
}

const undo = (before: BoardState, ops: Op[]) => {
  const after = applyBatch(before, ops, ctx)
  const back = applyBatch(after, invertBatch(before, ops), ctx)
  return { after, back }
}

describe('block ops', () => {
  it('block.edit applies splices in order and inverts exactly', () => {
    const before = state([
      makeBlock({ id: B1, text: 'Hello world', marks: [{ t: 'b', from: 6, to: 11 }] }),
    ])
    const op: Op = {
      op: 'block.edit',
      bookId: BOOK,
      id: B1,
      splices: [
        { at: 0, del: 5, ins: 'Goodbye' },
        { at: 13, del: 0, ins: '!' },
        { at: 8, del: 5, ins: '' },
      ],
      addMarks: [{ t: 'i', from: 0, to: 7 }],
    }
    const { after, back } = undo(before, [op])
    // "Goodbye world" → "Goodbye world!" (typed at the bold's end: bold) → "Goodbye !".
    expect(after.blocks.get(B1)).toMatchObject({
      text: 'Goodbye !',
      marks: [
        { t: 'b', from: 8, to: 9 },
        { t: 'i', from: 0, to: 7 },
      ],
    })
    expect(stripTimestamps(back)).toEqual(stripTimestamps(before))
    expect(back.blocks.get(B1)).toMatchObject({
      text: 'Hello world',
      marks: [{ t: 'b', from: 6, to: 11 }],
    })

    // Marks removed and added against the spliced text, inverted exactly too.
    const op2: Op = {
      op: 'block.edit',
      bookId: BOOK,
      id: B1,
      splices: [{ at: 11, del: 0, ins: ' again' }],
      removeMarks: [{ t: 'b', from: 8, to: 17 }],
      addMarks: [{ t: 'b', from: 0, to: 2 }],
    }
    const r2 = undo(before, [op2])
    expect(r2.after.blocks.get(B1)?.marks).toEqual([
      { t: 'b', from: 0, to: 2 },
      { t: 'b', from: 6, to: 8 },
    ])
    expect(stripTimestamps(r2.back)).toEqual(stripTimestamps(before))
  })

  it('block.edit refuses splices past the text, marks past the result, and too many splices', () => {
    const s = state()
    const edit = (over: object) => ({
      op: 'block.edit',
      bookId: BOOK,
      id: B1,
      splices: [],
      ...over,
    })
    expect(() => applyOp(s, edit({ splices: [{ at: 12, del: 0, ins: 'x' }] }) as Op, ctx)).toThrow(
      OpError,
    )
    expect(() => applyOp(s, edit({ addMarks: [{ t: 'b', from: 0, to: 12 }] }) as Op, ctx)).toThrow(
      OpError,
    )
    const many = Array.from({ length: LIMITS.maxSplicesPerEdit + 1 }, () => ({
      at: 0,
      del: 0,
      ins: 'x',
    }))
    expect(() => applyOp(s, edit({ splices: many }) as Op, ctx)).toThrow(OpError)
    // An edit to a block that is gone is refused whole (the one "block gone" policy).
    expect(() =>
      applyOp(s, edit({ id: B3, splices: [{ at: 0, del: 0, ins: 'x' }] }) as Op, ctx),
    ).toThrow(expect.objectContaining({ code: 'not-found' }))
  })

  it('block.split then its inverse merge restores text, marks and both ids', () => {
    const arbMarks = (len: number) =>
      fc
        .array(
          fc
            .record({
              t: fc.constantFrom<'b' | 'i'>('b', 'i'),
              a: fc.nat(len),
              b: fc.nat(len),
            })
            .map(({ t, a, b }): Mark => ({ t, from: Math.min(a, b), to: Math.max(a, b) })),
          { maxLength: 6 },
        )
        .map(normalizeMarks)
    const arbCase = fc.string({ maxLength: 40 }).chain((text) =>
      fc.record({
        text: fc.constant(text),
        marks: arbMarks(text.length),
        at: fc.nat(text.length),
      }),
    )
    fc.assert(
      fc.property(arbCase, ({ text, marks, at }) => {
        const before = state([
          makeBlock({ id: B1, pos: 'V', text, marks }),
          makeBlock({ id: B3, pos: 'k', text: 'after' }),
        ])
        const split: Op = {
          op: 'block.split',
          bookId: BOOK,
          id: B1,
          at,
          newId: B2,
          pos: 'W',
          kind: 'li',
        }
        const after = applyOp(before, split, ctx)
        expect(after.blocks.get(B1)?.text).toBe(text.slice(0, at))
        expect(after.blocks.get(B2)).toMatchObject({ text: text.slice(at), kind: 'li', pos: 'W' })
        expect(blocksOf(after, BOOK).map((b) => b.id)).toEqual([B1, B2, B3])
        const inverse = invertOp(before, split)
        expect(inverse).toEqual([{ op: 'block.merge', bookId: BOOK, from: B2, into: B1, at }])
        const back = applyBatch(after, inverse, ctx)
        expect(back.blocks.get(B1)).toEqual(before.blocks.get(B1))
        expect(back.blocks.has(B2)).toBe(false)
        expect(stripTimestamps(back)).toEqual(stripTimestamps(before))
        // And the merge's inverse is the split again.
        expect(invertOp(after, inverse[0] as Op)).toEqual([split])
      }),
      { numRuns: 2_000 },
    )
  })

  it('block.merge refuses an into whose length is not at', () => {
    const s = state([
      makeBlock({ id: B1, text: 'ab' }),
      makeBlock({ id: B2, pos: 'W', text: 'cd' }),
    ])
    const merge = (at: number): Op => ({ op: 'block.merge', bookId: BOOK, from: B2, into: B1, at })
    expect(() => applyOp(s, merge(1), ctx)).toThrow(OpError)
    expect(applyOp(s, merge(2), ctx).blocks.get(B1)?.text).toBe('abcd')
  })

  it('block.create, block.set and block.delete invert to each other', () => {
    const before = state()
    const created = makeBlock({
      id: B2,
      pos: 'W',
      text: 'two',
      marks: [{ t: 'i', from: 0, to: 3 }],
    })
    const ops: Op[] = [
      { op: 'block.create', block: created },
      { op: 'block.set', bookId: BOOK, id: B1, set: { kind: 'h2', pos: 'X' } },
      { op: 'block.delete', bookId: BOOK, id: B1 },
    ]
    const { after, back } = undo(before, ops)
    expect([...after.blocks.keys()]).toEqual([B2])
    expect(stripTimestamps(back)).toEqual(stripTimestamps(before))
  })

  it('a create and a move that say what they follow (`after`) apply and invert as the others; the block does not store it', () => {
    const before = state()
    const created = makeBlock({ id: B2, pos: 'W', text: 'two' })
    const ops: Op[] = [
      { op: 'block.create', block: created, after: B1 },
      { op: 'block.set', bookId: BOOK, id: B1, set: { pos: 'X' }, after: B2 },
    ]
    const { after, back } = undo(before, ops)
    expect(after.blocks.get(B2)).toEqual(expect.not.objectContaining({ after: expect.anything() }))
    expect(after.blocks.get(B1)).toEqual(expect.not.objectContaining({ after: expect.anything() }))
    expect(after.blocks.get(B1)?.pos).toBe('X')
    expect(stripTimestamps(back)).toEqual(stripTimestamps(before))
    // `after: null` (first in the book) is valid; any other value is not.
    const first = { op: 'block.create', block: created, after: null }
    expect(() => applyOp(before, first as Op, ctx)).not.toThrow()
    expect(() => applyOp(before, { ...first, after: 'x' } as unknown as Op, ctx)).toThrow()
  })

  it('book.update trashedAt inverts to the previous value', () => {
    const before = state()
    const del: Op = { op: 'book.update', id: BOOK, set: { trashedAt: NOW } }
    expect(invertOp(before, del)).toEqual([
      { op: 'book.update', id: BOOK, set: { trashedAt: null } },
    ])
    const after = applyOp(before, del, ctx)
    expect(after.books.get(BOOK)).toMatchObject({ trashedAt: NOW, updatedAt: NOW })
    // Putting it back inverts to the time it was deleted.
    expect(invertOp(after, { op: 'book.update', id: BOOK, set: { trashedAt: null } })).toEqual([
      { op: 'book.update', id: BOOK, set: { trashedAt: NOW } },
    ])
    // The blocks are left as they are: undoing a delete is O(1).
    expect(after.blocks).toBe(before.blocks)
  })

  it('book.purge removes the book and its held blocks', () => {
    const s = state([makeBlock({ id: B1 }), makeBlock({ id: B2, pos: 'W' })])
    const purge: Op = { op: 'book.purge', id: BOOK }
    // Only a deleted book is purged.
    expect(() => applyOp(s, purge, ctx)).toThrow(OpError)
    const trashed = applyOp(s, { op: 'book.update', id: BOOK, set: { trashedAt: NOW } }, ctx)
    const gone = applyOp(trashed, purge, ctx)
    expect(gone.books.size).toBe(0)
    expect(gone.blocks.size).toBe(0)
    expect(blocksOf(gone, BOOK)).toEqual([])
    // Server-only, as block.purge.
    expect(OpSchema.safeParse(purge).success).toBe(true)
    expect(ClientOpSchema.safeParse(purge).success).toBe(false)
    const blockPurge = { op: 'block.purge', bookId: BOOK, ids: [B1] }
    expect(OpSchema.safeParse(blockPurge).success).toBe(true)
    expect(ClientOpSchema.safeParse(blockPurge).success).toBe(false)
    const left = applyOp(s, blockPurge as Op, ctx)
    expect([...left.blocks.keys()]).toEqual([B2])
  })

  it('book.create marks the book held where blocks are held by book', () => {
    const s = releaseBook(state(), BOOK)
    expect(s.blocksHeld).toEqual(new Set())
    const BOOK2 = fixtureId('book', 2)
    const next = applyOp(
      s,
      { op: 'book.create', book: { ...makeBook({ id: BOOK2 }), trashedAt: null } },
      ctx,
    )
    expect(next.blocksHeld).toEqual(new Set([BOOK2]))
    // A new book is created live, never trashed.
    expect(() =>
      applyOp(s, { op: 'book.create', book: makeBook({ id: BOOK2, trashedAt: T0 }) } as Op, ctx),
    ).toThrow(OpError)
  })

  it('block ops for a book whose blocks are not held change nothing and throw nothing', () => {
    const s = releaseBook(state([makeBlock({ id: B1, text: 'ab' })]), BOOK)
    expect(s.blocks.size).toBe(0)
    const ops: Op[] = [
      { op: 'block.create', block: makeBlock({ id: B2, pos: 'W' }) },
      { op: 'block.edit', bookId: BOOK, id: B1, splices: [{ at: 99, del: 0, ins: 'x' }] },
      { op: 'block.set', bookId: BOOK, id: B1, set: { kind: 'h1' } },
      { op: 'block.split', bookId: BOOK, id: B1, at: 1, newId: B3, pos: 'X', kind: 'p' },
      { op: 'block.merge', bookId: BOOK, from: B2, into: B1, at: 2 },
      { op: 'block.delete', bookId: BOOK, id: B1 },
      { op: 'block.purge', bookId: BOOK, ids: [B1] },
    ]
    expect(applyBatch(s, ops, ctx)).toBe(s)
    for (const op of ops) expect(invertOp(s, op)).toEqual([])
    expect(invertBatch(s, ops)).toEqual([])
    const { state: committed, written } = commitChanges(s, ops, NOW, { clientId: tab, seq: 1 })
    expect([...written.books]).toEqual([BOOK])
    expect([...written.blocks]).toEqual([])
    // The commit stamps the book: its rev is the last revision anything in it changed.
    expect(committed.books.get(BOOK)?.rev).toBe(4)
    expect(committed.blocks.size).toBe(0)
  })

  it('every block op stamps its book with the commit revision', () => {
    const s = state()
    const { state: next, written } = commitChanges(
      s,
      [{ op: 'block.edit', bookId: BOOK, id: B1, splices: [{ at: 0, del: 0, ins: 'x' }] }],
      NOW,
      { clientId: tab, seq: 1 },
    )
    expect([...written.books]).toEqual([BOOK])
    expect([...written.blocks]).toEqual([B1])
    expect(next.books.get(BOOK)?.rev).toBe(4)
    expect(next.blocks.get(B1)?.rev).toBe(4)
    // The book's own fields are left as they are.
    expect(next.books.get(BOOK)?.updatedAt).toBe(T0)
  })
})

describe('limits', () => {
  it('limits: maxBlockText, maxBlocksPerBook, maxBookChars and maxBooks reject the batch whole', () => {
    const s = state([makeBlock({ id: B1, text: 'x'.repeat(LIMITS.maxBlockText - 1) })])
    const first: Op = { op: 'block.create', block: makeBlock({ id: B2, pos: 'W', text: 'ok' }) }
    const reject = (ops: Op[]) => {
      expect(() => applyBatch(s, [first, ...ops], ctx)).toThrow(OpError)
    }
    // maxBlockText: by an edit, and by a merge.
    reject([{ op: 'block.edit', bookId: BOOK, id: B1, splices: [{ at: 0, del: 0, ins: 'yy' }] }])
    reject([{ op: 'block.merge', bookId: BOOK, from: B2, into: B1, at: LIMITS.maxBlockText - 1 }])

    // maxBookChars and maxBlocksPerBook: one block more than the book may have.
    const perBlock = Math.ceil(LIMITS.maxBookChars / 200)
    const big = Array.from({ length: 200 }, (_, i) =>
      makeBlock({ id: fixtureId('block', 100 + i), pos: 'a', text: 'x'.repeat(perBlock) }),
    )
    const full = stateFromRecords(makeBoard(), [makeBook({ id: BOOK }), ...big])
    expect(() =>
      applyBatch(
        full,
        [{ op: 'block.create', block: makeBlock({ id: B2, pos: 'W', text: 'x' }) }],
        ctx,
      ),
    ).toThrow(/book-too-long/)
    const many = Array.from({ length: LIMITS.maxBlocksPerBook }, (_, i) =>
      makeBlock({ id: fixtureId('block', 100 + i), pos: 'a', text: '' }),
    )
    const crowded = stateFromRecords(makeBoard(), [makeBook({ id: BOOK }), ...many])
    expect(() =>
      applyBatch(crowded, [{ op: 'block.create', block: makeBlock({ id: B2, pos: 'W' }) }], ctx),
    ).toThrow(/too-many-blocks/)
    // A split adds a block too.
    expect(() =>
      applyBatch(
        crowded,
        [
          {
            op: 'block.split',
            bookId: BOOK,
            id: fixtureId('block', 100),
            at: 0,
            newId: B2,
            pos: 'b',
            kind: 'p',
          },
        ],
        ctx,
      ),
    ).toThrow(/too-many-blocks/)

    // maxBooks.
    const books = Array.from({ length: LIMITS.maxBooks }, (_, i) =>
      makeBook({ id: fixtureId('book', 100 + i) }),
    )
    const shelf = stateFromRecords(makeBoard(), books)
    expect(() =>
      applyBatch(shelf, [{ op: 'book.create', book: { ...makeBook(), trashedAt: null } }], ctx),
    ).toThrow(OpError)
  })

  it('a block naming a missing book is refused, and breaks the invariants where it is', () => {
    const s = state()
    const orphan = makeBlock({ id: B2, bookId: fixtureId('book', 9) })
    expect(() => applyOp(s, { op: 'block.create', block: orphan }, ctx)).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    )
    const handBuilt = stateFromRecords(makeBoard(), [makeBook({ id: BOOK }), orphan])
    expect(validateInvariants(handBuilt)).toEqual([{ kind: 'missing-book', id: B2 }])
    expect(() =>
      applyBatch(
        s,
        [
          {
            op: 'block.create',
            block: makeBlock({ id: B2, pos: 'W', text: 'ab', marks: [{ t: 'b', from: 1, to: 3 }] }),
          },
        ],
        ctx,
      ),
    ).toThrow(/mark-range/)
    expect(() =>
      applyBatch(
        s,
        [
          {
            op: 'block.create',
            block: makeBlock({
              id: B2,
              pos: 'W',
              text: 'abcd',
              marks: [
                { t: 'b', from: 0, to: 2 },
                { t: 'b', from: 2, to: 3 },
              ],
            }),
          },
        ],
        ctx,
      ),
    ).toThrow(/mark-range/)
  })
})

describe('edge cases', () => {
  it('block.edit inverts exactly for random text, marks, splices and mark changes', () => {
    const arbMarks = (len: number) =>
      fc
        .array(
          fc
            .record({ t: fc.constantFrom<'b' | 'i'>('b', 'i'), a: fc.nat(len), b: fc.nat(len) })
            .map(({ t, a, b }): Mark => ({ t, from: Math.min(a, b), to: Math.max(a, b) })),
          { maxLength: 6 },
        )
        .map(normalizeMarks)
    const arbCase = fc.string({ maxLength: 30 }).chain((text) =>
      fc.record({
        text: fc.constant(text),
        marks: arbMarks(text.length),
        steps: fc.array(
          fc.record({ at: fc.nat(1000), del: fc.nat(4), ins: fc.string({ maxLength: 4 }) }),
          { maxLength: 8 },
        ),
        add: fc.array(
          fc.record({
            t: fc.constantFrom<'b' | 'i'>('b', 'i'),
            a: fc.nat(1000),
            n: fc.integer({ min: 1, max: 5 }),
          }),
          { maxLength: 3 },
        ),
        remove: fc.array(
          fc.record({
            t: fc.constantFrom<'b' | 'i'>('b', 'i'),
            a: fc.nat(1000),
            n: fc.integer({ min: 1, max: 5 }),
          }),
          { maxLength: 3 },
        ),
      }),
    )
    fc.assert(
      fc.property(arbCase, ({ text, marks, steps, add, remove }) => {
        const splices: Array<{ at: number; del: number; ins: string }> = []
        let len = text.length
        for (const s of steps) {
          const at = s.at % (len + 1)
          const del = Math.min(s.del, len - at)
          splices.push({ at, del, ins: s.ins })
          len += s.ins.length - del
        }
        const within = (r: { t: 'b' | 'i'; a: number; n: number }): Mark | null => {
          if (len === 0) return null
          const from = r.a % len
          return { t: r.t, from, to: Math.min(len, from + r.n) }
        }
        const addMarks = add.map(within).filter((m): m is Mark => m !== null)
        const removeMarks = remove.map(within).filter((m): m is Mark => m !== null)
        const before = state([makeBlock({ id: B1, text, marks })])
        const op: Op = {
          op: 'block.edit',
          bookId: BOOK,
          id: B1,
          splices,
          ...(addMarks.length > 0 ? { addMarks } : {}),
          ...(removeMarks.length > 0 ? { removeMarks } : {}),
        }
        const after = applyOp(before, op, ctx)
        const back = applyBatch(after, invertOp(before, op), ctx)
        expect(back.blocks.get(B1)).toEqual(before.blocks.get(B1))
      }),
      { numRuns: 3_000 },
    )
  })

  it('maxMarksPerBlock bounds a block’s marks: the schema, an edit and a merge', () => {
    const many = (n: number, t: 'b' | 'i' = 'b'): Mark[] =>
      Array.from({ length: n }, (_, k) => ({ t, from: 2 * k, to: 2 * k + 1 }))
    const text = 'x'.repeat(2 * LIMITS.maxMarksPerBlock + 2)
    expect(
      BlockRecordSchema.safeParse(makeBlock({ text, marks: many(LIMITS.maxMarksPerBlock) }))
        .success,
    ).toBe(true)
    expect(
      BlockRecordSchema.safeParse(makeBlock({ text, marks: many(LIMITS.maxMarksPerBlock + 1) }))
        .success,
    ).toBe(false)
    const full = state([makeBlock({ id: B1, text, marks: many(LIMITS.maxMarksPerBlock) })])
    // One more mark by an edit is refused as a limit.
    const more: Op = {
      op: 'block.edit',
      bookId: BOOK,
      id: B1,
      splices: [],
      addMarks: [{ t: 'i', from: 0, to: 1 }],
    }
    expect(() => applyOp(full, more, ctx)).toThrow(expect.objectContaining({ code: 'limit' }))
    // And by a merge of two blocks whose marks together are too many.
    const two = state([
      makeBlock({ id: B1, text, marks: many(LIMITS.maxMarksPerBlock) }),
      makeBlock({ id: B2, pos: 'W', text: 'ab', marks: [{ t: 'i', from: 0, to: 1 }] }),
    ])
    expect(() =>
      applyOp(two, { op: 'block.merge', bookId: BOOK, from: B2, into: B1, at: text.length }, ctx),
    ).toThrow(expect.objectContaining({ code: 'limit' }))
  })

  it('book.purge is refused while more than maxPurgeBlocks of its blocks remain', () => {
    const blocks = Array.from({ length: LIMITS.maxPurgeBlocks + 1 }, (_, i) =>
      makeBlock({ id: fixtureId('block', 100 + i), pos: 'a', text: '' }),
    )
    const s = stateFromRecords(makeBoard(), [makeBook({ id: BOOK, trashedAt: T0 }), ...blocks])
    expect(() => applyOp(s, { op: 'book.purge', id: BOOK }, ctx)).toThrow(
      expect.objectContaining({ code: 'limit' }),
    )
    // The sweep's order: a batch of blocks first, then the book with what is left.
    const fewer = applyOp(
      s,
      { op: 'block.purge', bookId: BOOK, ids: [blocks[0]?.id as string] },
      ctx,
    )
    const gone = applyOp(fewer, { op: 'book.purge', id: BOOK }, ctx)
    expect(gone.books.size + gone.blocks.size).toBe(0)
  })

  it('book.create inverts to a delete dated when the book was made, and back', () => {
    const s = state([])
    const BOOK2 = fixtureId('book', 2)
    const create: Op = { op: 'book.create', book: { ...makeBook({ id: BOOK2 }), trashedAt: null } }
    const inverse = invertOp(s, create)
    expect(inverse).toEqual([{ op: 'book.update', id: BOOK2, set: { trashedAt: T0 } }])
    const after = applyOp(s, create, ctx)
    const undone = applyBatch(after, inverse, ctx)
    expect(undone.books.get(BOOK2)?.trashedAt).toBe(T0)
    // A create repeating the book already there changes nothing and inverts to nothing.
    expect(invertOp(after, create)).toEqual([])
  })
})
