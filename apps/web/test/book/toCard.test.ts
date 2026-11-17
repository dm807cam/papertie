// @vitest-environment jsdom
/**
 * Book → card: the selection as one new card's ops (`toCardOps`, pure), and
 * its commit (`pinSelection`): its text, an image card from a figure, its origin, a move's one
 * undo step, and a selection too long for a card.
 */
import {
  applyBatch,
  type BoardState,
  blocksOf,
  type ClientOp,
  emptyBoardState,
  LIMITS,
  type Note,
  posKeysBetween,
} from '@papertie/core'
import { cleanup } from '@testing-library/react'
import { openLocalSession } from '../../src/app/session'
import { pinSelection, toCardOps } from '../../src/book/out/toCard'
import { NEW_NOTE } from '../../src/notes/noteDesign'
import { book, para } from '../helpers/books'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const ID = idOf('book', 9)
const ASSET = `asset_${'0'.repeat(25)}1`
const NOW = '2026-11-13T10:00:00.000Z'

type Spec = readonly [string, string] | readonly [string, string, { assetId: string }]

/** A board with the book of `blocks` (kind, text, a figure's image), and one card at z 4. */
function stateWith(blocks: readonly Spec[]): BoardState {
  const keys = posKeysBetween(null, null, Math.max(1, blocks.length))
  return applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [
      { op: 'book.create', book: { ...book(ID, { title: 'On paper' }), trashedAt: null } },
      {
        op: 'asset.add',
        asset: {
          type: 'asset',
          id: ASSET,
          mime: 'image/webp',
          width: 300,
          height: 200,
          bytes: 10,
          sha256: 'a'.repeat(64),
          createdAt: T0,
        },
      } as unknown as ClientOp,
      ...blocks.map(
        ([kind, text, image], i): ClientOp => ({
          op: 'block.create',
          block: {
            type: 'block',
            id: para(i + 1),
            bookId: ID,
            pos: keys[i] as string,
            kind: kind as 'p',
            text,
            marks: [],
            ...(image ? { image } : {}),
          },
        }),
      ),
      { op: 'note.create', note: { ...note(idOf('note', 1), { text: 'old' }), z: 4 } },
    ],
    { now: T0 },
  )
}

let made = 500
const newBlockId = () => idOf('block', ++made)
const said = () => document.querySelector('[data-live-region]')?.textContent?.trim()

/** The new card of `ops` (its `note.create`). */
const cardOf = (ops: readonly ClientOp[]): Note => {
  const c = ops.find((o) => o.op === 'note.create')
  if (c?.op !== 'note.create') throw new Error('no card made')
  return c.note
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('toCardOps', () => {
  it('toCardOps: two paragraphs, a list item and a prompt make one card of four lines, the item as "- …"', () => {
    const state = stateWith([
      ['p', 'one'],
      ['p', 'two'],
      ['li', 'three'],
      ['prompt', 'four'],
    ])
    const r = toCardOps({
      state,
      bookId: ID,
      a: { blockId: para(1), offset: 0 },
      b: { blockId: para(4), offset: 4 },
      at: { x: 1000, y: 500 },
      move: false,
      now: NOW,
      newBlockId,
    })
    if ('refused' in r) throw new Error(r.refused)
    expect(r.ops).toHaveLength(1)
    const card = cardOf(r.ops)
    expect(card.text).toBe('one\ntwo\n- three\nfour')
    expect(card.id).toBe(r.noteId)
    // NEW_NOTE's size, centred on the point, on top of the board.
    expect([card.w, card.h]).toEqual([NEW_NOTE.w, NEW_NOTE.h])
    expect([card.x + card.w / 2, card.y + card.h / 2]).toEqual([1000, 500])
    expect(card.z).toBe(5)
    expect(card.image).toBeNull()
    // The book is as it was: a copy changes nothing there.
    expect(blocksOf(state, ID).map((b) => b.text)).toEqual(['one', 'two', 'three', 'four'])
  })

  it('a partial selection takes only the selected text, headings and quotes as plain lines', () => {
    const state = stateWith([
      ['h1', 'A chapter'],
      ['quote', 'said once'],
      ['p', 'and then some'],
    ])
    const r = toCardOps({
      state,
      bookId: ID,
      a: { blockId: para(1), offset: 2 },
      b: { blockId: para(3), offset: 8 },
      at: { x: 0, y: 0 },
      move: false,
      now: NOW,
      newBlockId,
    })
    if ('refused' in r) throw new Error(r.refused)
    expect(cardOf(r.ops).text).toBe('chapter\nsaid once\nand then')
  })

  it('a selection of one figure makes an image card with its caption', () => {
    const state = stateWith([
      ['p', 'one'],
      ['figure', 'Milan at dusk', { assetId: ASSET }],
    ])
    const r = toCardOps({
      state,
      bookId: ID,
      a: { blockId: para(2), offset: 0 },
      b: { blockId: para(2), offset: 5 },
      at: { x: 0, y: 0 },
      move: false,
      now: NOW,
      newBlockId,
    })
    if ('refused' in r) throw new Error(r.refused)
    const card = cardOf(r.ops)
    expect(card.image).toEqual({ assetId: ASSET, frame: 'print' })
    expect(card.text).toBe('Milan at dusk')
  })

  it('a figure among text gives its caption as a line', () => {
    const state = stateWith([
      ['p', 'one'],
      ['figure', 'Milan at dusk', { assetId: ASSET }],
      ['p', 'two'],
    ])
    const r = toCardOps({
      state,
      bookId: ID,
      a: { blockId: para(1), offset: 0 },
      b: { blockId: para(3), offset: 3 },
      at: { x: 0, y: 0 },
      move: false,
      now: NOW,
      newBlockId,
    })
    if ('refused' in r) throw new Error(r.refused)
    expect(cardOf(r.ops).text).toBe('one\nMilan at dusk\ntwo')
    expect(cardOf(r.ops).image).toBeNull()
  })

  it('a move of words inside one caption moves the whole figure: the card and the book agree', () => {
    const state = stateWith([
      ['p', 'one'],
      ['figure', 'Milan at dusk', { assetId: ASSET }],
    ])
    const r = toCardOps({
      state,
      bookId: ID,
      a: { blockId: para(2), offset: 6 },
      b: { blockId: para(2), offset: 8 },
      at: { x: 0, y: 0 },
      move: true,
      now: NOW,
      newBlockId,
    })
    if ('refused' in r) throw new Error(r.refused)
    const card = cardOf(r.ops)
    expect(card.image).toEqual({ assetId: ASSET, frame: 'print' })
    expect(card.text).toBe('Milan at dusk')
    const after = applyBatch(state, r.ops, { now: NOW })
    expect(after.blocks.has(para(2))).toBe(false)
    expect(blocksOf(after, ID).map((b) => b.text)).toEqual(['one'])
  })

  it('a move of a book’s only block, a figure, leaves an empty paragraph', () => {
    const state = stateWith([['figure', 'Milan at dusk', { assetId: ASSET }]])
    const r = toCardOps({
      state,
      bookId: ID,
      a: { blockId: para(1), offset: 0 },
      b: { blockId: para(1), offset: 5 },
      at: { x: 0, y: 0 },
      move: true,
      now: NOW,
      newBlockId,
    })
    if ('refused' in r) throw new Error(r.refused)
    const after = applyBatch(state, r.ops, { now: NOW })
    expect(blocksOf(after, ID).map((b) => [b.kind, b.text])).toEqual([['p', '']])
  })

  it('a figure at the edge of a longer selection gives the selected part of its caption, as a move takes out', () => {
    const state = stateWith([
      ['p', 'one'],
      ['figure', 'Milan at dusk', { assetId: ASSET }],
    ])
    const r = toCardOps({
      state,
      bookId: ID,
      a: { blockId: para(1), offset: 0 },
      b: { blockId: para(2), offset: 5 },
      at: { x: 0, y: 0 },
      move: true,
      now: NOW,
      newBlockId,
    })
    if ('refused' in r) throw new Error(r.refused)
    expect(cardOf(r.ops).text).toBe('one\nMilan')
    const after = applyBatch(state, r.ops, { now: NOW })
    expect(after.blocks.get(para(2))?.text).toBe(' at dusk')
  })

  it('the card remembers its book and first block', () => {
    const state = stateWith([
      ['p', 'one'],
      ['p', 'two'],
    ])
    const r = toCardOps({
      state,
      bookId: ID,
      a: { blockId: para(1), offset: 1 },
      b: { blockId: para(2), offset: 2 },
      at: { x: 0, y: 0 },
      move: false,
      now: NOW,
      newBlockId,
    })
    if ('refused' in r) throw new Error(r.refused)
    expect(cardOf(r.ops).from).toEqual({ book: ID, block: para(1) })
  })

  it('a selection with nothing in it is refused as empty', () => {
    const state = stateWith([
      ['p', 'one'],
      ['p', ''],
    ])
    const r = toCardOps({
      state,
      bookId: ID,
      a: { blockId: para(1), offset: 3 },
      b: { blockId: para(2), offset: 0 },
      at: { x: 0, y: 0 },
      move: false,
      now: NOW,
      newBlockId,
    })
    expect(r).toEqual({ refused: 'empty' })
  })
})

describe('pinSelection', () => {
  it('a move removes the text from the book and makes the card in one undo step', () => {
    const state = stateWith([
      ['p', 'one'],
      ['p', 'two'],
      ['p', 'three'],
    ])
    const session = openLocalSession({ kind: 'local', state, label: 'test' })
    const selected: Array<string | null> = []
    const id = pinSelection({
      session,
      bookId: ID,
      range: { a: { blockId: para(1), offset: 1 }, b: { blockId: para(3), offset: 2 } },
      at: { x: 300, y: 200 },
      move: true,
      board: { selectNote: (n) => selected.push(n) },
      newBlockId,
    })
    expect(id).not.toBeNull()
    const after = session.store.getState()
    // As the engine's own delete across blocks: the ends trimmed and joined, the middle gone.
    expect(blocksOf(after, ID).map((b) => b.text)).toEqual(['oree'])
    expect(after.notes.get(id as string)?.text).toBe('ne\ntwo\nth')
    expect(selected).toEqual([id])
    expect(said()).toBe('Moved to the board.')
    // One undo step, labelled as the move: the text back, the card gone.
    const r = session.undo.undo(session.store.getState())
    expect(r?.label).toBe('move to the board')
    if (r) session.store.commit(r.ops, { undo: 'skip' })
    const back = session.store.getState()
    expect(blocksOf(back, ID).map((b) => b.text)).toEqual(['one', 'two', 'three'])
    expect(back.notes.has(id as string)).toBe(false)
  })

  it('Pin to board leaves the text where it was and says so', () => {
    const state = stateWith([['p', 'one']])
    const session = openLocalSession({ kind: 'local', state, label: 'test' })
    const id = pinSelection({
      session,
      bookId: ID,
      range: { a: { blockId: para(1), offset: 0 }, b: { blockId: para(1), offset: 3 } },
      at: { x: 0, y: 0 },
      move: false,
      newBlockId,
    })
    expect(session.store.getState().notes.get(id as string)?.text).toBe('one')
    expect(blocksOf(session.store.getState(), ID).map((b) => b.text)).toEqual(['one'])
    expect(said()).toBe('Pinned to the board.')
    // Its undo step is named as what it was, not as a new note.
    expect(session.undo.undo(session.store.getState())?.label).toBe('pin to the board')
  })

  it('a selection longer than a card holds changes nothing and says so', () => {
    const half = 'x'.repeat(LIMITS.maxTextLength / 2)
    const state = stateWith([
      ['p', half],
      ['p', half],
    ])
    const session = openLocalSession({ kind: 'local', state, label: 'test' })
    const before = session.store.getState()
    const id = pinSelection({
      session,
      bookId: ID,
      range: {
        a: { blockId: para(1), offset: 0 },
        b: { blockId: para(2), offset: half.length },
      },
      at: { x: 0, y: 0 },
      move: true,
      newBlockId,
    })
    expect(id).toBeNull()
    expect(session.store.getState()).toBe(before)
    expect(said()).toBe('That’s more than a card holds.')
  })
})
