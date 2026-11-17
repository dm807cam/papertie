import {
  applyOp,
  blocksOf,
  bookBlocks,
  holdBook,
  isHeld,
  parseBoard,
  releaseBook,
  serializeBoard,
  stateFromRecords,
} from '../../src/index'
import { fixtureId, makeBlock, makeBoard, makeBook } from '../fixtures'

const NOW = '2026-10-27T12:00:00.000Z'
const BOOK = fixtureId('book', 1)
const BOOK2 = fixtureId('book', 2)
const blocks = [
  makeBlock({ id: fixtureId('block', 1), bookId: BOOK, pos: 'W', text: 'two' }),
  makeBlock({ id: fixtureId('block', 2), bookId: BOOK, pos: 'V', text: 'one' }),
]
const other = makeBlock({ id: fixtureId('block', 3), bookId: BOOK2, text: 'elsewhere' })

function whole() {
  return stateFromRecords(makeBoard(), [
    makeBook({ id: BOOK }),
    makeBook({ id: BOOK2 }),
    ...blocks,
    other,
  ])
}

describe('held books', () => {
  it('a server state and a whole-file parse hold every book', () => {
    expect(whole().blocksHeld).toBe('all')
    expect(isHeld(whole(), BOOK)).toBe(true)
    expect(isHeld(whole(), fixtureId('book', 9))).toBe(true)
  })

  it('a client read holds none, then the books it opens, and lets them go again', () => {
    const read = parseBoard(serializeBoard(whole()), { blocksHeld: 'none' }).state
    if (!read) throw new Error('no state')
    expect(isHeld(read, BOOK)).toBe(false)
    expect(blocksOf(read, BOOK)).toEqual([])

    const held = holdBook(read, BOOK, blocks)
    expect(isHeld(held, BOOK)).toBe(true)
    expect(isHeld(held, BOOK2)).toBe(false)
    expect(blocksOf(held, BOOK).map((b) => b.text)).toEqual(['one', 'two'])
    expect(bookBlocks(held.blocks, BOOK).chars).toBe(6)
    // Held, its block ops apply.
    const edited = applyOp(
      held,
      {
        op: 'block.edit',
        bookId: BOOK,
        id: fixtureId('block', 2),
        splices: [{ at: 3, del: 0, ins: '!' }],
      },
      { now: NOW },
    )
    expect(blocksOf(edited, BOOK).map((b) => b.text)).toEqual(['one!', 'two'])

    const released = releaseBook(edited, BOOK)
    expect(isHeld(released, BOOK)).toBe(false)
    expect(released.blocks.size).toBe(0)
    expect(blocksOf(released, BOOK)).toEqual([])
    expect(bookBlocks(released.blocks, BOOK).chars).toBe(0)
    expect(released.books.size).toBe(2)
  })

  it('holding a book again replaces the blocks it held', () => {
    const s = holdBook(whole(), BOOK, [blocks[0] as (typeof blocks)[number]])
    expect(s.blocksHeld).toBe('all')
    expect(blocksOf(s, BOOK).map((b) => b.text)).toEqual(['two'])
    expect(blocksOf(s, BOOK2)).toEqual([other])
  })

  it('releasing a book of a state that holds every book holds every other book', () => {
    const s = releaseBook(whole(), BOOK)
    expect(s.blocksHeld).toEqual(new Set([BOOK2]))
    expect([...s.blocks.keys()]).toEqual([other.id])
  })

  it('refuses blocks of another book', () => {
    expect(() => holdBook(whole(), BOOK, [other])).toThrow(RangeError)
  })
})
