import fc from 'fast-check'
import { CARD_WORK } from '../../src/book/cards'
import {
  applyBatch,
  type Block,
  BlockRecordSchema,
  type BoardState,
  BookRecordSchema,
  blocksOf,
  type ClientOp,
  ClientOpSchema,
  cardCounts,
  cardMarkT,
  cardStamps,
  cardsFromBlocks,
  cardsOfBlock,
  commitChanges,
  commitSteps,
  invertBatch,
  LIMITS,
  type Mark,
  MarkSchema,
  NoteRecordSchema,
  type Op,
  OpError,
  OpSchema,
  posBetween,
  posKeysBetween,
  SERVER_OPS,
  stateFromRecords,
  stripTimestamps,
} from '../../src/index'
import { drain } from '../../src/ops/draft'
import { fixtureId, makeAsset, makeBlock, makeBoard, makeBook, makeNote } from '../fixtures'

const NOW = '2026-11-13T12:00:00.000Z'
const ctx = { now: NOW }
const BOOK = fixtureId('book', 1)
const BOOK2 = fixtureId('book', 2)
const B1 = fixtureId('block', 1)
const B2 = fixtureId('block', 2)
const B3 = fixtureId('block', 3)
const NOTE_A = fixtureId('note', 1)
const NOTE_B = fixtureId('note', 2)
const NOTE_C = fixtureId('note', 3)
const ASSET = fixtureId('asset', 1)
const ASSET2 = fixtureId('asset', 2)
const A = cardMarkT(NOTE_A)
const B = cardMarkT(NOTE_B)
const tab = fixtureId('tab', 1)

const mark = (t: Mark['t'], from: number, to: number): Mark => ({ t, from, to })

function state(blocks: Partial<Block>[], books = [makeBook({ id: BOOK })]): BoardState {
  const pos = posKeysBetween(null, null, Math.max(1, blocks.length))
  return stateFromRecords(makeBoard({ revision: 3 }), [
    makeAsset({ id: ASSET }),
    makeAsset({ id: ASSET2 }),
    makeNote({ id: NOTE_A }),
    makeNote({ id: NOTE_B }),
    ...books,
    ...blocks.map((b, k) => makeBlock({ id: fixtureId('block', k + 1), pos: pos[k], ...b })),
  ])
}

const apply = (s: BoardState, ops: readonly Op[]) => applyBatch(s, ops, ctx)
const edit = (id: string, over: object, bookId = BOOK): ClientOp => ({
  op: 'block.edit',
  bookId,
  id,
  splices: [],
  ...over,
})
const figure = (over: Partial<Block> = {}): Partial<Block> => ({
  kind: 'figure',
  text: 'A caption',
  image: { assetId: ASSET, card: NOTE_A },
  ...over,
})

describe('card marks', () => {
  it('a card mark is c: and a note id', () => {
    expect(A).toBe(`c:${NOTE_A}`)
  })

  it('a mark type that is not b, i or c:<note id> is refused', () => {
    expect(MarkSchema.safeParse(mark(A, 0, 1)).success).toBe(true)
    for (const t of [
      'u',
      'c:',
      'c:x',
      `c:${fixtureId('book', 1)}`,
      `c:${NOTE_A}x`,
      `C:${NOTE_A}`,
      NOTE_A,
    ]) {
      expect(MarkSchema.safeParse({ t, from: 0, to: 1 }).success).toBe(false)
      expect(
        BlockRecordSchema.safeParse(makeBlock({ marks: [{ t, from: 0, to: 1 } as Mark] })).success,
      ).toBe(false)
    }
    // `takes` names card types too, at most 8 a splice and each once.
    const typed = (takes: unknown) =>
      ClientOpSchema.safeParse(edit(B1, { splices: [{ at: 0, del: 0, ins: 'x' }], takes })).success
    expect(typed([[A, 'b']])).toBe(true)
    expect(
      typed([['b', 'i', A, B, ...[3, 4, 5, 6].map((n) => cardMarkT(fixtureId('note', n)))]]),
    ).toBe(true)
    expect(
      typed([['b', 'i', A, B, ...[3, 4, 5, 6, 7].map((n) => cardMarkT(fixtureId('note', n)))]]),
    ).toBe(false)
    expect(typed([[A, A]])).toBe(false)
    expect(typed([['c:nope']])).toBe(false)
  })

  it('cardsOfBlock names the card marks’ notes and a figure’s card', () => {
    const b = makeBlock({
      text: 'Hello pinned world',
      marks: [mark('b', 0, 5), mark(A, 6, 12), mark(A, 13, 18), mark(B, 0, 2)],
    })
    expect([...cardsOfBlock(b)].sort()).toEqual([NOTE_A, NOTE_B].sort())
    const f = makeBlock({ ...figure({ marks: [mark(B, 0, 1)] }) } as Partial<Block>)
    expect([...cardsOfBlock(f)].sort()).toEqual([NOTE_A, NOTE_B].sort())
    expect(cardsFromBlocks([b, f, makeBlock({ marks: [mark('i', 0, 1)] })])).toEqual(
      [NOTE_A, NOTE_B].sort(),
    )
  })

  it('typing inside or at the end of pinned text keeps the pin on both sides; deleting all of a card’s text removes its mark', () => {
    const base = state([{ text: 'Hello world', marks: [mark(A, 6, 11)] }])
    // Typing inside the pinned text and at its end, saying it takes the card.
    const inside = edit(B1, {
      splices: [
        { at: 8, del: 0, ins: 'XY' },
        { at: 13, del: 0, ins: '!' },
      ],
      takes: [[A], [A]],
    })
    expect(blocksOf(apply(base, [inside]), BOOK)[0]).toMatchObject({
      text: 'Hello woXYrld!',
      marks: [mark(A, 6, 14)],
    })
    // Deleting every character of the passage takes the pin off the block.
    const gone = apply(base, [edit(B1, { splices: [{ at: 5, del: 6, ins: '' }] })])
    expect(blocksOf(gone, BOOK)[0]?.marks).toEqual([])
    expect(cardCounts(gone, BOOK).get(NOTE_A)).toBeUndefined()
  })

  it('a split keeps a card mark on each part that has marked text; a merge carries both cards', () => {
    const base = state([
      { text: 'one two three', marks: [mark(A, 4, 13)] },
      { text: 'four', marks: [mark(B, 0, 4)] },
    ])
    const split = apply(base, [
      {
        op: 'block.split',
        bookId: BOOK,
        id: B1,
        at: 8,
        newId: B3,
        pos: posBetween(blocksOf(base, BOOK)[0]?.pos ?? null, blocksOf(base, BOOK)[1]?.pos ?? null),
        kind: 'p',
      },
    ])
    expect(blocksOf(split, BOOK).map((b) => [b.text, b.marks])).toEqual([
      ['one two ', [mark(A, 4, 8)]],
      ['three', [mark(A, 0, 5)]],
      ['four', [mark(B, 0, 4)]],
    ])
    expect(cardCounts(split, BOOK).get(NOTE_A)).toBe(2)
    const merged = apply(split, [{ op: 'block.merge', bookId: BOOK, from: B2, into: B3, at: 5 }])
    expect(blocksOf(merged, BOOK)[1]).toMatchObject({
      text: 'threefour',
      marks: [mark(A, 0, 5), mark(B, 5, 9)],
    })
    expect(Object.fromEntries(cardCounts(merged, BOOK))).toEqual({ [NOTE_A]: 2, [NOTE_B]: 1 })
  })

  it('two cards’ marks on the same text both stay, in plain string order (b < c:… < i)', () => {
    const s = apply(state([{ text: 'Hello' }]), [
      edit(B1, { addMarks: [mark('i', 0, 5), mark(B, 0, 5), mark(A, 1, 3), mark('b', 0, 2)] }),
    ])
    expect(blocksOf(s, BOOK)[0]?.marks).toEqual([
      mark('b', 0, 2),
      mark(A, 1, 3),
      mark(B, 0, 5),
      mark('i', 0, 5),
    ])
  })
})

// ── cardCounts ─────────────────────────────────────────────────────────────────────────────────

const NOTES = [NOTE_A, NOTE_B, NOTE_C]

/** A rebuild of a book's counts from its blocks, as `cardCounts` must equal. */
function rebuilt(s: BoardState, bookId: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const b of blocksOf(s, bookId)) for (const n of cardsOfBlock(b)) out[n] = (out[n] ?? 0) + 1
  return out
}

const arbStep = fc.record({
  kind: fc.nat(8),
  r: fc.array(fc.nat(1_000), { minLength: 6, maxLength: 6 }),
})

/** One random op against `s` (null where none fits): every block op, figures and card marks too. */
function stepOp(s: BoardState, { kind, r }: { kind: number; r: number[] }, n: number): Op | null {
  const rr = (k: number) => r[k] as number
  const bookId = rr(5) % 4 === 0 ? BOOK2 : BOOK
  const blocks = blocksOf(s, bookId)
  const block = blocks[rr(0) % Math.max(1, blocks.length)]
  const card = cardMarkT(NOTES[rr(1) % 3] as string)
  const t = (['b', 'i', card, card] as Mark['t'][])[rr(2) % 4] as Mark['t']
  const newId = fixtureId('block', 10_000 + n)
  const last = blocks[blocks.length - 1]
  if (kind <= 1 || !block) {
    const isFigure = rr(3) % 3 === 0
    return {
      op: 'block.create',
      block: makeBlock({
        id: newId,
        bookId,
        pos: posBetween(last?.pos ?? null, null),
        text: 'abcdef'.slice(0, rr(4) % 7),
        marks: rr(4) % 7 > 1 ? [mark(t, 0, 1)] : [],
        ...(isFigure
          ? {
              kind: 'figure',
              image: { assetId: ASSET, ...(rr(2) % 2 ? { card: NOTES[rr(1) % 3] } : {}) },
            }
          : {}),
      }),
    }
  }
  const len = block.text.length
  if (kind <= 4) {
    const at = rr(3) % (len + 1)
    const del = Math.min(len - at, rr(4) % 3)
    const out = len - del + 1
    const a = rr(1) % out
    const b = Math.min(out, a + 1 + (rr(2) % 3))
    const marks = [mark(t, a, b)]
    return edit(
      block.id,
      {
        splices: [{ at, del, ins: 'x' }],
        ...(kind === 3 ? { addMarks: marks } : kind === 4 ? { removeMarks: marks } : {}),
      },
      bookId,
    ) as Op
  }
  if (kind === 5) {
    if (block.kind === 'figure') {
      return {
        op: 'block.set',
        bookId,
        id: block.id,
        set: {
          image: {
            assetId: rr(3) % 2 ? ASSET : ASSET2,
            ...(rr(2) % 2 ? { card: NOTES[rr(1) % 3] } : {}),
          },
        },
      }
    }
    const k = blocks.indexOf(block)
    return {
      op: 'block.split',
      bookId,
      id: block.id,
      at: rr(3) % (len + 1),
      newId,
      pos: posBetween(block.pos, blocks[k + 1]?.pos ?? null),
      kind: 'p',
    }
  }
  if (kind === 6) {
    const k = blocks.indexOf(block)
    const into = blocks[k - 1]
    if (!into || into.kind === 'figure' || block.kind === 'figure') return null
    return { op: 'block.merge', bookId, from: block.id, into: into.id, at: into.text.length }
  }
  if (kind === 7) return { op: 'block.delete', bookId, id: block.id }
  if (block.kind === 'figure') return null
  return { op: 'block.set', bookId, id: block.id, set: { kind: rr(3) % 2 ? 'quote' : 'prompt' } }
}

describe('cardCounts', () => {
  it('cardCounts equals a rebuild from the blocks after 1,000 random ops', () => {
    fc.assert(
      fc.property(fc.array(arbStep, { minLength: 1, maxLength: 30 }), (steps) => {
        let s = state(
          [{ text: 'Hello', marks: [mark(A, 0, 2)] }],
          [makeBook({ id: BOOK, cards: [NOTE_A] }), makeBook({ id: BOOK2, shelfPos: 'a' })],
        )
        for (const [n, step] of steps.entries()) {
          const op = stepOp(s, step, n)
          if (op === null) continue
          // A whole commit at a time, as the server makes them (stamps too).
          try {
            s = drain(commitSteps(s, [op], NOW, null, { stamp: cardStamps })).state
          } catch (e) {
            expect(e).toBeInstanceOf(OpError)
          }
          for (const id of [BOOK, BOOK2]) {
            expect(Object.fromEntries(cardCounts(s, id))).toEqual(rebuilt(s, id))
            // The book's stamped cards are the counts' notes, sorted.
            expect(s.books.get(id)?.cards ?? []).toEqual(Object.keys(rebuilt(s, id)).sort())
          }
        }
      }),
      { numRuns: 1_000 },
    )
  })
})

// ── Stamping ───────────────────────────────────────────────────────────────────────────────────

describe('cardStamps and commitSteps', () => {
  it('cardStamps names only books whose card set changed, and costs the touched blocks’ cards', () => {
    const base = state(
      [
        { text: 'Hello world', marks: [mark(A, 0, 5)] },
        { text: 'Second', marks: [mark(A, 0, 6)] },
        { bookId: BOOK2, text: 'Other book', marks: [mark(B, 0, 5)] },
      ],
      [
        makeBook({ id: BOOK, cards: [NOTE_A] }),
        makeBook({ id: BOOK2, shelfPos: 'a', cards: [NOTE_B] }),
      ],
    )
    // Typing inside one book's pinned text, and pinning a second card in the other.
    const ops: Op[] = [
      edit(B1, { splices: [{ at: 2, del: 0, ins: 'yy' }], takes: [[A]] }) as Op,
      edit(B3, { addMarks: [mark(cardMarkT(NOTE_C), 6, 10)] }, BOOK2) as Op,
    ]
    const { state: after, written } = commitChanges(base, ops, NOW, null)
    CARD_WORK.calls = 0
    const stamps = cardStamps(base, after, written)
    expect(CARD_WORK.calls).toBeLessThanOrEqual(2 * written.blocks.size)
    expect(stamps).toEqual([{ op: 'book.cards', id: BOOK2, add: [NOTE_C] }])
    // Deleting a block one of two passages of a card are in changes nothing; the last one unstamps.
    const one = commitChanges(base, [{ op: 'block.delete', bookId: BOOK, id: B2 }], NOW, null)
    expect(cardStamps(base, one.state, one.written)).toEqual([])
    const both = commitChanges(one.state, [{ op: 'block.delete', bookId: BOOK, id: B1 }], NOW, null)
    expect(cardStamps(one.state, both.state, both.written)).toEqual([
      { op: 'book.cards', id: BOOK, remove: [NOTE_A] },
    ])
  })

  it('commitSteps with a stamper appends book.cards in the same revision; without it, none', () => {
    const base = state([{ text: 'Hello world' }])
    const ops: Op[] = [edit(B1, { addMarks: [mark(A, 0, 5)] }) as Op]
    const mark1 = { clientId: tab, seq: 1 }
    const stamped = drain(commitSteps(base, ops, NOW, mark1, { stamp: cardStamps }))
    expect(stamped.stamps).toEqual([{ op: 'book.cards', id: BOOK, add: [NOTE_A] }])
    expect(stamped.state.board.revision).toBe(base.board.revision + 1)
    expect(stamped.state.books.get(BOOK)).toMatchObject({ cards: [NOTE_A], rev: 4 })
    expect(stamped.written.books.has(BOOK)).toBe(true)
    // Replayed as journaled (the batch and its stamps, no flag), the very same state.
    const replayed = drain(commitSteps(base, [...ops, ...stamped.stamps], NOW, mark1))
    expect(replayed.stamps).toEqual([])
    expect(stripTimestamps(replayed.state)).toEqual(stripTimestamps(stamped.state))
    expect(replayed.state.books.get(BOOK)).toEqual(stamped.state.books.get(BOOK))
    // Without the flag (a client, a replay), nothing is stamped.
    const plain = drain(commitSteps(base, ops, NOW, mark1))
    expect(plain.stamps).toEqual([])
    expect(plain.state.books.get(BOOK)?.cards).toBeUndefined()
    // A batch that changes no book's cards stamps nothing.
    const none = drain(
      commitSteps(
        stamped.state,
        [edit(B1, { splices: [{ at: 0, del: 0, ins: 'x' }] }) as Op],
        NOW,
        mark1,
        {
          stamp: cardStamps,
        },
      ),
    )
    expect(none.stamps).toEqual([])
  })

  it('a write that leaves a book’s cards unchanged keeps the same cards array', () => {
    const base = state(
      [{ text: 'Hello world', marks: [mark(A, 0, 5)] }],
      [makeBook({ id: BOOK, cards: [NOTE_A] })],
    )
    const cards = base.books.get(BOOK)?.cards
    const typed = drain(
      commitSteps(
        base,
        [edit(B1, { splices: [{ at: 1, del: 0, ins: 'x' }], takes: [[A]] }) as Op],
        NOW,
        null,
        {
          stamp: cardStamps,
        },
      ),
    )
    expect(typed.stamps).toEqual([])
    expect(typed.state.books.get(BOOK)?.cards).toBe(cards)
    const titled = drain(
      commitSteps(
        typed.state,
        [{ op: 'book.update', id: BOOK, set: { title: 'New' } }],
        NOW,
        null,
        {
          stamp: cardStamps,
        },
      ),
    )
    expect(titled.state.books.get(BOOK)?.title).toBe('New')
    expect(titled.state.books.get(BOOK)?.cards).toBe(cards)
  })

  it('book.cards is server-only and sets the cards in sorted order, on a book not held too', () => {
    expect(SERVER_OPS).toContain('book.cards')
    const op: Op = { op: 'book.cards', id: BOOK, add: [NOTE_B, NOTE_A] }
    expect(OpSchema.safeParse(op).success).toBe(false)
    const sorted: Op = { op: 'book.cards', id: BOOK, add: [NOTE_A, NOTE_B] }
    expect(OpSchema.safeParse(sorted).success).toBe(true)
    expect(ClientOpSchema.safeParse(sorted).success).toBe(false)
    const unheld = { ...state([]), blocksHeld: new Set<string>() as ReadonlySet<string> }
    const s = apply(unheld, [sorted])
    expect(s.books.get(BOOK)?.cards).toEqual([NOTE_A, NOTE_B])
    const less = apply(s, [{ op: 'book.cards', id: BOOK, remove: [NOTE_A], add: [NOTE_C] }])
    expect(less.books.get(BOOK)?.cards).toEqual([NOTE_B, NOTE_C].sort())
    // Emptied, the key goes (absent = none), and the record keeps the schema's key order.
    const empty = apply(less, [{ op: 'book.cards', id: BOOK, remove: [NOTE_B, NOTE_C].sort() }])
    expect('cards' in (empty.books.get(BOOK) as object)).toBe(false)
    expect(Object.keys(less.books.get(BOOK) as object)).toEqual(
      Object.keys(BookRecordSchema.shape).filter((k) => k !== 'rev'),
    )
    // Never undone: it has no client inverse.
    expect(invertBatch(s, [{ op: 'book.cards', id: BOOK, remove: [NOTE_A] }])).toEqual([])
  })

  it('a client cannot set a book’s cards through book.create', () => {
    const book = { ...makeBook({ id: BOOK2 }), trashedAt: null }
    expect(ClientOpSchema.safeParse({ op: 'book.create', book }).success).toBe(true)
    // A held record's list (a stale one, or a forged one) is refused, client side and server side.
    const listed = { op: 'book.create', book: { ...book, cards: [NOTE_A] } }
    expect(ClientOpSchema.safeParse(listed).success).toBe(false)
    expect(OpSchema.safeParse(listed).success).toBe(false)
    expect(ClientOpSchema.safeParse({ ...listed, book: { ...book, cards: [] } }).success).toBe(
      false,
    )
    // The record itself keeps the field: the server stamps it, an import recomputes it.
    expect(BookRecordSchema.safeParse({ ...makeBook(), cards: [NOTE_A] }).success).toBe(true)
  })

  it('cardStamps stops at maxBookCards and never throws', () => {
    const many = Array.from({ length: LIMITS.maxBookCards - 1 }, (_, k) =>
      fixtureId('note', 100 + k),
    )
    expect(LIMITS.maxBookCards).toBe(60_000)
    const base = state([{ text: 'abc' }], [makeBook({ id: BOOK, cards: many.sort() })])
    const ops: Op[] = [
      edit(B1, {
        addMarks: [mark(A, 0, 1), mark(B, 1, 2), mark(cardMarkT(NOTE_C), 2, 3)],
      }) as Op,
    ]
    const out = drain(commitSteps(base, ops, NOW, null, { stamp: cardStamps }))
    const added = out.stamps.flatMap((o) => (o.op === 'book.cards' ? (o.add ?? []) : []))
    expect(added).toHaveLength(1)
    expect(out.state.books.get(BOOK)?.cards).toHaveLength(LIMITS.maxBookCards)
  })
})

// ── Figures ────────────────────────────────────────────────────────────────────────────────────

describe('figures', () => {
  it('a figure needs its asset; a figure cannot change kind, split or merge', () => {
    const base = state([{ text: 'Before' }, figure()])
    expect(blocksOf(base, BOOK)[1]?.image).toEqual({ assetId: ASSET, card: NOTE_A })
    const make = (b: Partial<Block>) =>
      apply(base, [{ op: 'block.create', block: makeBlock({ id: B3, pos: 'z', ...b }) }])
    // An image exactly on a figure, and its asset there.
    expect(() => make(figure({ image: { assetId: fixtureId('asset', 9) } }))).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    )
    expect(() => make({ kind: 'figure' })).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => make({ kind: 'p', image: { assetId: ASSET } })).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    )
    expect(make(figure({ text: '' })).blocks.get(B3)?.text).toBe('')
    const refused: Op[] = [
      { op: 'block.set', bookId: BOOK, id: B2, set: { kind: 'p' } },
      { op: 'block.set', bookId: BOOK, id: B1, set: { kind: 'figure' } },
      { op: 'block.set', bookId: BOOK, id: B1, set: { image: { assetId: ASSET } } },
      { op: 'block.split', bookId: BOOK, id: B2, at: 1, newId: B3, pos: 'z', kind: 'p' },
      { op: 'block.merge', bookId: BOOK, from: B2, into: B1, at: 6 },
    ]
    for (const op of refused) {
      expect(() => apply(base, [op])).toThrow(expect.objectContaining({ code: 'invalid' }))
    }
    const tail = apply(base, [
      { op: 'block.create', block: makeBlock({ id: B3, pos: 'z', text: 'After' }) },
    ])
    expect(() =>
      apply(tail, [{ op: 'block.merge', bookId: BOOK, from: B3, into: B2, at: 9 }]),
    ).toThrow(expect.objectContaining({ code: 'invalid' }))
    // Its caption is text with marks, card marks too.
    const captioned = apply(base, [edit(B2, { addMarks: [mark(B, 0, 1), mark('i', 2, 9)] })])
    expect(blocksOf(captioned, BOOK)[1]?.marks).toEqual([mark(B, 0, 1), mark('i', 2, 9)])
  })

  it('asset.remove of an asset a figure shows breaks missing-asset', () => {
    const base = state([figure()])
    expect(() => apply(base, [{ op: 'asset.remove', id: ASSET }])).toThrow(
      /missing-asset on block_/,
    )
    expect(apply(base, [{ op: 'asset.remove', id: ASSET2 }]).assets.has(ASSET2)).toBe(false)
  })

  it('block.set image and note.update from invert exactly', () => {
    const base = state([figure()])
    for (const ops of [
      [{ op: 'block.set', bookId: BOOK, id: B1, set: { image: { assetId: ASSET2 } } }],
      [{ op: 'block.set', bookId: BOOK, id: B1, set: { image: { assetId: ASSET, card: NOTE_B } } }],
      [{ op: 'note.update', id: NOTE_A, set: { from: { book: BOOK, block: B1 } } }],
    ] as Op[][]) {
      const after = apply(base, ops)
      expect(stripTimestamps(after)).not.toEqual(stripTimestamps(base))
      const back = apply(after, invertBatch(base, ops))
      expect(stripTimestamps(back)).toEqual(stripTimestamps(base))
    }
    const from = { book: BOOK, block: B1 }
    const made = apply(base, [{ op: 'note.update', id: NOTE_A, set: { from } }])
    expect(made.notes.get(NOTE_A)?.from).toEqual(from)
    // Removable: `from: null` takes it off, and that inverts too.
    const ops: Op[] = [{ op: 'note.update', id: NOTE_A, set: { from: null } }]
    const off = apply(made, ops)
    expect('from' in (off.notes.get(NOTE_A) as object)).toBe(false)
    expect(apply(off, invertBatch(made, ops)).notes.get(NOTE_A)?.from).toEqual(from)
    // Nothing checks that the book or block is there (a book can be purged later).
    const stale = { book: fixtureId('book', 77), block: fixtureId('block', 77) }
    expect(NoteRecordSchema.safeParse(makeNote({ from: stale })).success).toBe(true)
    expect(
      apply(base, [{ op: 'note.update', id: NOTE_A, set: { from: stale } }]).notes.get(NOTE_A)
        ?.from,
    ).toEqual(stale)
  })
})
