/**
 * Which shelf books use each card (`sync/books/cardUses.ts`): kept from the books'
 * server-stamped `cards`, waking only the notes whose uses changed.
 */
import {
  applyBatch,
  type BoardState,
  type Book,
  type ClientOp,
  type Op,
  stateFromRecords,
} from '@papertie/core'
import { describe, expect, it } from 'vitest'
import { createBoardStore } from '../../../src/store/boardStore'
import { cardUsesFor } from '../../../src/sync/books/cardUses'
import { BOOK, BOOK2, block, book } from '../../helpers/books'
import { BOARD_ID, idOf, T0 } from '../../helpers/fakeServer'

const N1 = idOf('note', 1)
const N2 = idOf('note', 2)
const N3 = idOf('note', 3)
const NOW = '2026-11-13T12:00:00.000Z'

function board(books: Book[]): BoardState {
  return stateFromRecords(
    {
      type: 'board',
      schemaVersion: 6,
      id: BOARD_ID,
      name: 'B',
      revision: 1,
      clients: {},
      createdAt: T0,
      updatedAt: T0,
    },
    [...books, block(1, 'pinned', BOOK)],
  )
}

/** The store, its uses, and each note's wake count. */
function setup(books: Book[]) {
  const store = createBoardStore(board(books))
  const uses = cardUsesFor(store)
  const woke = new Map<string, number>()
  for (const n of [N1, N2, N3]) {
    uses.watch(n, () => woke.set(n, (woke.get(n) ?? 0) + 1))
  }
  /** The server's ops applied as a commit would bring them. */
  const land = (ops: Op[]) => store.replace(applyBatch(store.getState(), ops, { now: NOW }))
  return { store, uses, woke, land }
}

describe('cardUses', () => {
  it('lists the shelf books whose cards name a note, in shelf order', () => {
    const { uses } = setup([
      book(BOOK, { shelfPos: 'W', cards: [N1, N2] }),
      book(BOOK2, { shelfPos: 'V', cards: [N1] }),
    ])
    expect(uses.usedIn(N1)).toEqual([BOOK2, BOOK])
    expect(uses.usedIn(N2)).toEqual([BOOK])
    expect(uses.usedIn(N3)).toEqual([])
    // The same list until it changes.
    expect(uses.usedIn(N1)).toBe(uses.usedIn(N1))
  })

  it('cardUses notifies only the notes whose uses changed', () => {
    const { uses, woke, land } = setup([
      book(BOOK, { cards: [N1, N2] }),
      book(BOOK2, { shelfPos: 'W', cards: [N2] }),
    ])
    land([{ op: 'book.cards', id: BOOK, add: [N3], remove: [N1] }])
    expect(Object.fromEntries(woke)).toEqual({ [N1]: 1, [N3]: 1 })
    expect(uses.usedIn(N1)).toEqual([])
    expect(uses.usedIn(N3)).toEqual([BOOK])
    // N2 is still used by both books: no wake.
    expect(uses.usedIn(N2)).toEqual([BOOK, BOOK2])
  })

  it('a keystroke commit wakes no note: the book record changes, its cards array does not', () => {
    const { store, woke } = setup([book(BOOK, { cards: [N1] })])
    const cards = store.getState().books.get(BOOK)?.cards
    const typed: ClientOp = {
      op: 'block.edit',
      bookId: BOOK,
      id: block(1, '').id,
      splices: [{ at: 0, del: 0, ins: 'x' }],
    }
    const before = store.getState().books.get(BOOK)
    store.replace(
      applyBatch(
        store.getState(),
        [typed, { op: 'book.update', id: BOOK, set: { title: 'New' } }],
        { now: NOW },
      ),
    )
    expect(store.getState().books.get(BOOK)).not.toBe(before)
    expect(store.getState().books.get(BOOK)?.cards).toBe(cards)
    expect(woke.size).toBe(0)
  })

  it('a trashed book’s cards are not listed; put back, they are', () => {
    const { uses, woke, land } = setup([book(BOOK, { cards: [N1] })])
    const bookWoke: number[] = []
    uses.watchBook(BOOK, () => bookWoke.push(1))
    expect(uses.shelved(BOOK)).toBe(true)
    land([{ op: 'book.update', id: BOOK, set: { trashedAt: NOW } }])
    expect(uses.usedIn(N1)).toEqual([])
    expect(uses.shelved(BOOK)).toBe(false)
    expect(woke.get(N1)).toBe(1)
    land([{ op: 'book.update', id: BOOK, set: { trashedAt: null } }])
    expect(uses.usedIn(N1)).toEqual([BOOK])
    expect(uses.shelved(BOOK)).toBe(true)
    expect(woke.get(N1)).toBe(2)
    expect(bookWoke).toHaveLength(2)
  })

  it('a board loaded again is read whole: the uses follow it', () => {
    const { store, uses, woke } = setup([book(BOOK, { cards: [N1] })])
    store.replace(board([book(BOOK, { cards: [N2] })]))
    expect(uses.usedIn(N1)).toEqual([])
    expect(uses.usedIn(N2)).toEqual([BOOK])
    expect(Object.fromEntries(woke)).toEqual({ [N1]: 1, [N2]: 1 })
  })
})
