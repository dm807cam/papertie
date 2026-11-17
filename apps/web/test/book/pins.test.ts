/**
 * Provenance pins, pure: one pin per card per live block in the left
 * margin, stacked; faded when the card is gone; read from the window's blocks only; and the ops
 * that take a card off a block (its marks, or a figure's `image.card`).
 */
import {
  applyBatch,
  type Block,
  type BoardState,
  type ClientOp,
  cardMarkT,
  emptyBoardState,
  posKeysBetween,
} from '@papertie/core'
import type { LiveBlock } from '../../src/book/editor/pageWindow'
import { PIN_STACK_PX, pinLabel, pinsOf, unpinOps } from '../../src/book/pins/pins'
import { book, para } from '../helpers/books'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const ID = idOf('book', 9)
const A = idOf('note', 1)
const B = idOf('note', 2)
const ASSET = `asset_${'0'.repeat(25)}1`

const block = (n: number, text: string, over: Partial<Block> = {}): Block => ({
  type: 'block',
  id: para(n),
  bookId: ID,
  pos: `V${n}`,
  kind: 'p',
  text,
  marks: [],
  ...over,
})

describe('pinsOf', () => {
  it('pinsOf gives one pin per card per block, stacked, faded when the card is gone', () => {
    const blocks = new Map<string, Block>([
      [
        para(1),
        block(1, 'one two three', {
          marks: [
            { t: cardMarkT(A), from: 0, to: 3 },
            { t: 'b', from: 4, to: 7 },
            { t: cardMarkT(A), from: 8, to: 13 },
            { t: cardMarkT(B), from: 4, to: 7 },
          ],
        }),
      ],
      [para(2), block(2, 'plain')],
      [para(3), block(3, 'Milan', { kind: 'figure', image: { assetId: ASSET, card: B } })],
    ])
    const live: LiveBlock[] = [
      { id: para(1), kind: 'p', top: 10, height: 40 },
      { id: para(2), kind: 'p', top: 60, height: 40 },
      { id: para(3), kind: 'figure', top: 110, height: 300 },
    ]
    const pins = pinsOf(
      live,
      (id) => blocks.get(id),
      (id) => id === A,
    )
    expect(pins).toEqual([
      // One per card in a block, however many passages it marks; the second 18 px below.
      { blockId: para(1), noteId: A, top: 10, faded: false },
      { blockId: para(1), noteId: B, top: 10 + PIN_STACK_PX, faded: true },
      { blockId: para(3), noteId: B, top: 110, faded: true },
    ])
    expect(PIN_STACK_PX).toBe(18)
  })

  it('pinsOf reads only the window’s blocks', () => {
    const live: LiveBlock[] = Array.from({ length: 30 }, (_, i) => ({
      id: para(i + 1),
      kind: 'p' as const,
      top: i * 40,
      height: 40,
    }))
    let calls = 0
    const pins = pinsOf(
      live,
      (id) => {
        calls++
        return block(Number(id.slice(-3)), 'text', { marks: [{ t: cardMarkT(A), from: 0, to: 4 }] })
      },
      () => true,
    )
    expect(pins).toHaveLength(30)
    expect(calls).toBeLessThanOrEqual(live.length)
  })

  it('a pin is labelled by its card’s first line, or as from a deleted card', () => {
    expect(pinLabel({ ...note(A, { text: 'Lantern festival\n\nBy the river' }) })).toBe(
      'From a card: Lantern festival',
    )
    expect(pinLabel(undefined)).toBe('From a deleted card')
  })
})

describe('unpinOps', () => {
  function stateWith(blocks: Block[]): BoardState {
    const keys = posKeysBetween(null, null, blocks.length)
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
        { op: 'note.create', note: note(A, { text: 'A card' }) },
        ...blocks.map(
          (b, i): ClientOp => ({ op: 'block.create', block: { ...b, pos: keys[i] as string } }),
        ),
      ],
      { now: T0 },
    )
  }

  it('takes the card’s marks off the block, and nothing else', () => {
    const s = stateWith([
      block(1, 'one two', {
        marks: [
          { t: 'b', from: 0, to: 3 },
          { t: cardMarkT(A), from: 0, to: 7 },
        ],
      }),
    ])
    const ops = unpinOps(s, ID, para(1), A)
    const after = applyBatch(s, ops, { now: T0 })
    expect(after.blocks.get(para(1))?.marks).toEqual([{ t: 'b', from: 0, to: 3 }])
    expect(after.blocks.get(para(1))?.text).toBe('one two')
  })

  it('a figure’s pin removes image.card', () => {
    const s = stateWith([block(1, 'Milan', { kind: 'figure', image: { assetId: ASSET, card: A } })])
    const after = applyBatch(s, unpinOps(s, ID, para(1), A), { now: T0 })
    expect(after.blocks.get(para(1))?.image).toEqual({ assetId: ASSET })
  })

  it('a block the card is not on gives no ops', () => {
    const s = stateWith([block(1, 'plain')])
    expect(unpinOps(s, ID, para(1), A)).toEqual([])
    expect(unpinOps(s, ID, para(7), A)).toEqual([])
  })
})
