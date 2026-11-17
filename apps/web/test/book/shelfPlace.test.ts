/**
 * Where a moved book goes on the shelf: between its new neighbours, and when there is no room
 * between them (two books with the same key, as an imported file may hold, or a gap halved until
 * its keys would pass `maxPosLength`), the shelf is spaced out again in the same batch. Never a
 * throw, never a key the server refuses.
 */
import { type Book, type ClientOp, LIMITS } from '@papertie/core'
import { placeOps } from '../../src/book/shelfActions'
import { book } from '../helpers/books'
import { idOf } from '../helpers/fakeServer'

const byShelf = (a: Book, b: Book) =>
  a.shelfPos < b.shelfPos ? -1 : a.shelfPos > b.shelfPos ? 1 : a.id < b.id ? -1 : 1

/** `shelf` with `ops` (book.update shelfPos) applied, in shelf order. */
function apply(shelf: readonly Book[], ops: readonly ClientOp[]): Book[] {
  const by = new Map(shelf.map((b) => [b.id, b]))
  for (const op of ops) {
    if (op.op !== 'book.update' || op.set.shelfPos === undefined)
      throw new Error(`unexpected ${op.op}`)
    const b = by.get(op.id)
    if (!b) throw new Error('no such book')
    by.set(op.id, { ...b, shelfPos: op.set.shelfPos })
  }
  return [...by.values()].sort(byShelf)
}

describe('placing a book on the shelf', () => {
  it('moves between two books with the same key (as an imported file may hold) without a throw', () => {
    const shelf = [
      book(idOf('book', 1), { title: 'A', shelfPos: 'V' }),
      book(idOf('book', 2), { title: 'B', shelfPos: 'V' }),
      book(idOf('book', 3), { title: 'C', shelfPos: 'X' }),
    ].sort(byShelf)
    const ops = placeOps(shelf, idOf('book', 3), 1)
    const after = apply(shelf, ops)
    expect(after.map((b) => b.title)).toEqual(['A', 'C', 'B'])
    expect(new Set(after.map((b) => b.shelfPos)).size).toBe(3)
    // Already in place: nothing to do.
    expect(placeOps(after, after[1]?.id as string, 1)).toEqual([])
  })

  it('1,000 inserts into one gap (200 and well past) keep every key within maxPosLength, in order', () => {
    let shelf: Book[] = [
      book(idOf('book', 1), { title: 'first', shelfPos: 'V' }),
      book(idOf('book', 2), { title: 'last', shelfPos: 'W' }),
    ]
    for (let i = 0; i < 1000; i++) {
      // A book at the end, moved to the second place: always into the gap after "first".
      const n = book(idOf('book', 10 + i), { title: `n${i}`, shelfPos: 'z' })
      shelf = [...shelf, n].sort(byShelf)
      shelf = apply(shelf, placeOps(shelf, n.id, 1))
      for (const b of shelf) expect(b.shelfPos.length).toBeLessThanOrEqual(LIMITS.maxPosLength)
      expect(shelf[0]?.title).toBe('first')
      expect(shelf[1]?.title).toBe(`n${i}`)
      expect(shelf.at(-1)?.title).toBe('last')
      expect(new Set(shelf.map((b) => b.shelfPos)).size).toBe(shelf.length)
    }
  })
})
