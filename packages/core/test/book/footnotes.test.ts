import {
  applyBatch,
  type Block,
  type BoardState,
  blocksOf,
  computeEof,
  footnoteOfMark,
  numberFootnotes,
  type Op,
  OpError,
  orphanFootnotes,
  parseBoard,
  stateFromRecords,
} from '../../src/index'
import { fixtureId, makeBlock, makeBoard, makeBook } from '../fixtures'

/** The mark type of the anchor of footnote block `footnoteId`. */
const noteMarkT = (footnoteId: string) => `n:${footnoteId}` as const

const ctx = { now: '2026-11-13T12:00:00.000Z' }
const BOOK = fixtureId('book', 1)
const BOOK2 = fixtureId('book', 2)
const P1 = fixtureId('block', 1)
const P2 = fixtureId('block', 2)
const FA = fixtureId('block', 11)
const FB = fixtureId('block', 12)
const FC = fixtureId('block', 13)
const FD = fixtureId('block', 14)

const para = (id: string, pos: string, text: string, anchors: [string, number, number][] = []) =>
  makeBlock({
    id,
    pos,
    text,
    marks: anchors
      .map(([fn, from, to]) => ({ t: noteMarkT(fn), from, to }))
      .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.from - b.from)),
  })
const foot = (id: string, pos: string, text = 'A note.', bookId = BOOK) =>
  makeBlock({ id, pos, text, kind: 'footnote', bookId })

function book(blocks: Block[]): BoardState {
  return stateFromRecords(makeBoard({ revision: 3 }), [
    makeBook({ id: BOOK }),
    makeBook({ id: BOOK2, shelfPos: 'W' }),
    ...blocks,
  ])
}
const apply = (s: BoardState, ops: readonly Op[]) => applyBatch(s, ops, ctx)

describe('footnote marks', () => {
  it('an n: mark names its footnote block', () => {
    expect(footnoteOfMark(noteMarkT(FA))).toBe(FA)
    expect(footnoteOfMark('b')).toBeNull()
    expect(footnoteOfMark(`c:${fixtureId('note', 1)}`)).toBeNull()
  })

  it('typing inside an anchor extends it; deleting all of it orphans the footnote', () => {
    const s = book([para(P1, 'K', 'One word here.', [[FA, 4, 8]]), foot(FA, 'L')])
    const typed = apply(s, [
      { op: 'block.edit', bookId: BOOK, id: P1, splices: [{ at: 6, del: 0, ins: 'XY' }] },
    ])
    expect(typed.blocks.get(P1)?.marks).toEqual([{ t: noteMarkT(FA), from: 4, to: 10 }])
    expect(orphanFootnotes(blocksOf(typed, BOOK))).toEqual(new Set())

    const gone = apply(typed, [
      { op: 'block.edit', bookId: BOOK, id: P1, splices: [{ at: 4, del: 6, ins: '' }] },
    ])
    expect(gone.blocks.get(P1)?.marks).toEqual([])
    // The footnote stays, shown as an orphan: never dropped.
    expect(gone.blocks.get(FA)?.kind).toBe('footnote')
    expect(orphanFootnotes(blocksOf(gone, BOOK))).toEqual(new Set([FA]))
  })
})

describe('numberFootnotes', () => {
  it('numberFootnotes numbers by anchor order through the book', () => {
    // Within a paragraph by the anchors' places (marks sort by type first); across paragraphs
    // in book order; a footnote anchored twice (a split paragraph) counts at its first anchor.
    const blocks = [
      para(P1, 'K', 'Alpha beta gamma delta', [
        [FB, 2, 4],
        [FA, 12, 16],
      ]),
      foot(FA, 'L'),
      foot(FB, 'M'),
      para(P2, 'N', 'Epsilon zeta', [
        [FC, 0, 3],
        [FB, 8, 12],
      ]),
      foot(FC, 'P'),
    ]
    expect([...numberFootnotes(blocks)]).toEqual([
      [FB, 1],
      [FA, 2],
      [FC, 3],
    ])
    // Only the blocks given: an anchor whose footnote is not among them is not numbered.
    expect([...numberFootnotes(blocks.slice(0, 3))]).toEqual([
      [FB, 1],
      [FA, 2],
    ])
  })

  it('numbers follow the references, by where each anchor ends', () => {
    // "the sentence with a footnoted word": FA over the whole sentence, FB over a word inside it.
    // FB's reference (at 9) is read before FA's (at 22): FB is 1.
    const blocks = [
      para(P1, 'K', 'Alpha beta gamma delta', [
        [FA, 0, 22],
        [FB, 6, 10],
      ]),
      foot(FA, 'L'),
      foot(FB, 'M'),
    ]
    expect([...numberFootnotes(blocks)]).toEqual([
      [FB, 1],
      [FA, 2],
    ])
  })

  it('an anchor in a prompt counts for nothing: its footnote is an orphan', () => {
    const blocks = [
      para(P1, 'K', 'Alpha beta', [[FA, 0, 5]]),
      foot(FA, 'L'),
      { ...para(P2, 'M', 'Gamma delta', [[FB, 0, 5]]), kind: 'prompt' as const },
      foot(FB, 'N'),
      para(fixtureId('block', 3), 'P', 'Epsilon', [[FC, 0, 7]]),
      foot(FC, 'Q'),
    ]
    expect([...numberFootnotes(blocks)]).toEqual([
      [FA, 1],
      [FC, 2],
      [FB, 3],
    ])
    expect(orphanFootnotes(blocks)).toEqual(new Set([FB]))
  })

  it('orphans come last', () => {
    const blocks = [
      foot(FD, 'J'),
      para(P1, 'K', 'Alpha beta', [[FB, 0, 5]]),
      foot(FA, 'L'),
      foot(FB, 'M'),
    ]
    expect([...numberFootnotes(blocks)]).toEqual([
      [FB, 1],
      [FD, 2],
      [FA, 3],
    ])
    expect(orphanFootnotes(blocks)).toEqual(new Set([FD, FA]))
  })
})

describe('footnote blocks', () => {
  it('a footnote cannot change kind, split or merge', () => {
    const s = book([para(P1, 'K', 'Alpha beta', [[FA, 0, 5]]), foot(FA, 'L', 'Note text')])
    const refused = (op: Op) => expect(() => apply(s, [op])).toThrow(OpError)
    refused({ op: 'block.set', bookId: BOOK, id: FA, set: { kind: 'p' } })
    refused({ op: 'block.set', bookId: BOOK, id: P1, set: { kind: 'footnote' } })
    refused({
      op: 'block.split',
      bookId: BOOK,
      id: FA,
      at: 4,
      newId: fixtureId('block', 50),
      pos: 'Lm',
      kind: 'footnote',
    })
    refused({
      op: 'block.split',
      bookId: BOOK,
      id: P1,
      at: 5,
      newId: fixtureId('block', 50),
      pos: 'Km',
      kind: 'footnote',
    })
    refused({ op: 'block.merge', bookId: BOOK, from: FA, into: P1, at: 10 })
    refused({ op: 'block.merge', bookId: BOOK, from: P1, into: FA, at: 9 })
    // Its text takes bold and italic only.
    refused({
      op: 'block.edit',
      bookId: BOOK,
      id: FA,
      splices: [],
      addMarks: [{ t: noteMarkT(FA), from: 0, to: 4 }],
    })
    expect(() =>
      apply(s, [
        {
          op: 'block.create',
          block: { ...foot(FB, 'M'), marks: [{ t: `c:${fixtureId('note', 1)}`, from: 0, to: 1 }] },
        },
      ]),
    ).toThrow(OpError)
    // A footnote made whole, bold and italic, a move and its text are fine.
    const ok = apply(s, [
      { op: 'block.create', block: foot(FB, 'M', 'Made'), after: FA },
      {
        op: 'block.edit',
        bookId: BOOK,
        id: FA,
        splices: [],
        addMarks: [{ t: 'i', from: 0, to: 4 }],
      },
      { op: 'block.set', bookId: BOOK, id: FA, set: { pos: 'Lb' } },
    ])
    expect(ok.blocks.get(FA)).toMatchObject({ kind: 'footnote', pos: 'Lb' })
  })

  it('a dangling n: mark is stripped quietly on load: a leftover, not damage', () => {
    const MISSING = fixtureId('block', 99)
    const bad = para(P1, 'K', 'Alpha beta gamma delta', [
      [FA, 0, 5],
      [MISSING, 6, 10],
      [P2, 11, 16],
      [FB, 17, 22],
    ])
    const lines = [
      makeBoard({ revision: 1 }),
      makeBook({ id: BOOK }),
      makeBook({ id: BOOK2, shelfPos: 'W' }),
      bad,
      foot(FA, 'L'),
      para(P2, 'M', 'Plain'),
      // A footnote of another book.
      foot(FB, 'K', 'Elsewhere', BOOK2),
    ]
    const body = lines.map((l) => JSON.stringify(l))
    const text = `${[...body, JSON.stringify(computeEof(body, 1))].join('\n')}\n`
    const r = parseBoard(text)
    expect(r.integrity).toBe('ok')
    expect(r.issues).toEqual([])
    expect(r.state?.blocks.get(P1)?.marks).toEqual([{ t: noteMarkT(FA), from: 0, to: 5 }])
    expect(r.state?.blocks.get(P1)?.text).toBe(bad.text)
  })
})
