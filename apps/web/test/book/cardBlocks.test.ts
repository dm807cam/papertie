import {
  applyBatch,
  type BoardState,
  blocksOf,
  type ClientOp,
  cardMarkT,
  emptyBoardState,
  type Note,
} from '@papertie/core'
import { cardDropOps, type DropForm } from '../../src/book/drop/cardBlocks'
import { BOOK, makeBook, para } from '../helpers/books'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const ASSET = `asset_${'0'.repeat(25)}1`
const CARD = idOf('note', 1)
const CARD2 = idOf('note', 2)
const CARD3 = idOf('note', 3)
const Y = idOf('yarn', 1)

/** A board with the book of `texts` and the cards `notes` (a thread through them when 3+). */
function boardWith(texts: string[], notes: Note[]): BoardState {
  const ops: ClientOp[] = [
    ...makeBook(texts),
    {
      op: 'asset.add',
      asset: {
        type: 'asset',
        id: ASSET,
        mime: 'image/webp',
        width: 300,
        height: 200,
        bytes: 1000,
        sha256: 'a'.repeat(64),
        createdAt: T0,
      },
    } as unknown as ClientOp,
    ...notes.map((n): ClientOp => ({ op: 'note.create', note: n })),
  ]
  if (notes.length >= 3) {
    ops.push({
      op: 'yarn.create',
      yarn: {
        type: 'yarn',
        id: Y,
        noteIds: notes.map((n) => n.id),
        color: 'apricot',
        label: '',
        createdAt: T0,
        updatedAt: T0,
      },
    })
  }
  return applyBatch(emptyBoardState(BOARD_ID, 'Test board', T0), ops, { now: T0 })
}

let made = 100
const newBlockId = () => idOf('block', ++made)

function drop(
  s: BoardState,
  notes: Note[],
  form: DropForm,
  move = false,
  after: string | null = para(1),
) {
  const r = cardDropOps({ state: s, bookId: BOOK, after, notes, form, move, newBlockId })
  return { ...r, state: applyBatch(s, r.ops, { now: T0 }) }
}

const TEXT = 'The title\n\nA body line\nthat goes on\n- first\n- second'

describe('cardDropOps', () => {
  it('a text card of a title, a body and two bullets makes p, p, li, li with the card’s mark over each', () => {
    const card = note(CARD, { text: TEXT })
    const s = boardWith(['before', 'after'], [card])
    const r = drop(s, [card], 'p')
    const blocks = blocksOf(r.state, BOOK)
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ['p', 'before'],
      ['p', 'The title'],
      ['p', 'A body line that goes on'],
      ['li', 'first'],
      ['li', 'second'],
      ['p', 'after'],
    ])
    for (const b of blocks.slice(1, 5)) {
      expect(b.marks).toEqual([{ t: cardMarkT(CARD), from: 0, to: b.text.length }])
    }
    expect(r.blockIds).toEqual(blocks.slice(1, 5).map((b) => b.id))
    // A copy: the card stays on the board.
    expect(r.state.notes.has(CARD)).toBe(true)
  })

  it('… as quote makes four quotes', () => {
    const card = note(CARD, { text: TEXT })
    const r = drop(boardWith(['before'], [card]), [card], 'quote')
    const blocks = blocksOf(r.state, BOOK).slice(1)
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ['quote', 'The title'],
      ['quote', 'A body line that goes on'],
      ['quote', 'first'],
      ['quote', 'second'],
    ])
    const prompts = drop(boardWith(['before'], [card]), [card], 'prompt')
    expect(
      blocksOf(prompts.state, BOOK)
        .slice(1)
        .map((b) => b.kind),
    ).toEqual(['prompt', 'prompt', 'prompt', 'prompt'])
  })

  it('an image card makes a figure with its asset and card, captioned with its text', () => {
    const card = note(CARD, {
      text: 'Milan, at dusk\nthe second line',
      image: { assetId: ASSET, frame: 'print' },
    })
    const s = boardWith(['before'], [card])
    // Whatever form: a photo is a figure.
    const r = drop(s, [card], 'quote')
    const fig = blocksOf(r.state, BOOK)[1]
    expect(fig).toMatchObject({
      kind: 'figure',
      text: 'Milan, at dusk the second line',
      image: { assetId: ASSET, card: CARD },
      marks: [],
    })
    const moved = drop(s, [card], 'p', true)
    expect(blocksOf(moved.state, BOOK)[1]?.image).toEqual({ assetId: ASSET })
  })

  it('a move makes no mark and deletes the card in the same batch', () => {
    const cards = [
      note(CARD, { text: 'one', x: 0 }),
      note(CARD2, { text: 'two', x: 300 }),
      note(CARD3, { text: 'three', x: 600 }),
    ]
    const s = boardWith(['before'], cards)
    const r = drop(s, [cards[1] as Note], 'p', true)
    expect(r.ops.filter((op) => op.op === 'note.delete')).toEqual([
      { op: 'note.delete', id: CARD2 },
    ])
    expect(r.ops.at(-1)).toEqual({ op: 'note.delete', id: CARD2 })
    const b = blocksOf(r.state, BOOK)[1]
    expect(b).toMatchObject({ kind: 'p', text: 'two', marks: [] })
    expect(r.state.notes.has(CARD2)).toBe(false)
    // The thread closes up, as a delete's does.
    expect(r.state.yarns.get(Y)?.noteIds).toEqual([CARD, CARD3])
  })

  it('several cards go in reading order, one batch', () => {
    const lower = note(CARD, { text: 'lower', x: 0, y: 400 })
    const right = note(CARD2, { text: 'right', x: 500, y: 0 })
    const left = note(CARD3, { text: 'left', x: 0, y: 0 })
    const s = boardWith(['before', 'after'], [lower, right, left])
    const r = drop(s, [lower, right, left], 'p')
    expect(blocksOf(r.state, BOOK).map((b) => b.text)).toEqual([
      'before',
      'left',
      'right',
      'lower',
      'after',
    ])
    expect(r.ops.every((op) => op.op === 'block.create')).toBe(true)
    // First in the book.
    const first = drop(s, [left], 'p', false, null)
    expect(blocksOf(first.state, BOOK)[0]?.text).toBe('left')
  })

  it('an empty card adds nothing', () => {
    const empty = note(CARD, { text: '  \n ' })
    const r = drop(boardWith(['before'], [empty]), [empty], 'p', true)
    expect(r.ops).toEqual([])
    expect(r.blockIds).toEqual([])
  })
})

describe('a card with a ref', () => {
  const REF = 'Thoreau, Walden, 1854, p. 92'

  it('a card with a ref drops as a quote with the ref as its footnote', () => {
    const card = note(CARD, { text: 'Simplify, simplify.', ref: REF })
    const s = boardWith(['before', 'after'], [card])
    // Whatever the likely form is.
    const r = drop(s, [card], 'prompt')
    const blocks = blocksOf(r.state, BOOK)
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ['p', 'before'],
      ['quote', 'Simplify, simplify.'],
      ['footnote', REF],
      ['p', 'after'],
    ])
    const [quote, fn] = [blocks[1], blocks[2]]
    // The card's pin and the footnote's anchor, both over the whole quote.
    expect(quote?.marks).toEqual([
      { t: cardMarkT(CARD), from: 0, to: 19 },
      { t: `n:${fn?.id}`, from: 0, to: 19 },
    ])
    // The chooser's blocks are the quote's alone; the footnote belongs to the text.
    expect(r.blockIds).toEqual([quote?.id])
    expect(r.form).toBe('quote')
    expect(r.reffed).toBe(true)
  })

  it('a ref with line breaks is its footnote whole; a move keeps the footnote too', () => {
    const ref = 'Smith, J. (2020).\nNature 12, 45–67.'
    const card = note(CARD, { text: 'Light bends.', ref })
    const r = drop(boardWith(['before'], [card]), [card], 'p', true)
    const blocks = blocksOf(r.state, BOOK)
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ['p', 'before'],
      ['quote', 'Light bends.'],
      ['footnote', ref],
    ])
    // Moved: no card mark, the anchor stays; the card leaves the board in the same batch.
    expect(blocks[1]?.marks).toEqual([{ t: `n:${blocks[2]?.id}`, from: 0, to: 12 }])
    expect(r.state.notes.has(CARD)).toBe(false)
  })

  it('a plain card is not reffed and keeps the likely form', () => {
    const card = note(CARD, { text: 'Plain' })
    const r = drop(boardWith(['before'], [card]), [card], 'prompt')
    expect(r.reffed).toBe(false)
    expect(r.form).toBe('prompt')
    expect(blocksOf(r.state, BOOK).map((b) => b.kind)).toEqual(['p', 'prompt'])
  })
})
