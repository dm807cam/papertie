/**
 * The books whose blocks a state holds. The server holds every book; a client reads the board
 * without blocks and holds a book's once it has them (it opened the book), so the 100,000-note
 * board never carries a library's text it is not showing.
 */

import { PMap } from '../pmap'
import type { Block } from '../schema/records'
import { asPMap, type BoardState } from '../state'
import {
  type BookBlocks,
  blockIndex,
  bookBlocks,
  bookBlocksOf,
  chunkSize,
  cmp,
  countCards,
  keepBlockIndex,
  NO_BOOK,
} from './blockIndex'

/** Whether `state` holds `bookId`'s blocks (every book, for a state that holds them all). */
export function isHeld(state: BoardState, bookId: string): boolean {
  return state.blocksHeld === 'all' || state.blocksHeld.has(bookId)
}

/** Blocks a step of {@link bookBlocksSteps} (and of `holdBookSteps`) reads or writes at most. */
export const HOLD_STEP = 1024

/**
 * {@link bookBlocksOf} a step at a time, each step yielding how many blocks it handled (at most
 * {@link HOLD_STEP}): a book in `(pos, id)` order already (as the book route
 * gives it) is checked and cut into chunks; any other is sorted first by a bottom-up merge, its
 * passes cut into steps too. Never one O(book) stretch.
 */
export function* bookBlocksSteps(blocks: readonly Block[]): Generator<number, BookBlocks> {
  const n = blocks.length
  if (n === 0) return NO_BOOK
  let sorted = true
  for (let i = 1; i < n && sorted; i++) {
    if (cmp(blocks[i - 1] as Block, blocks[i] as Block) > 0) sorted = false
    if (i % HOLD_STEP === 0) yield HOLD_STEP
  }
  let list: readonly Block[] = blocks
  if (!sorted) {
    let a: Block[] = [...blocks]
    let b: Block[] = new Array(n)
    let done = 0
    for (let width = 1; width < n; width *= 2) {
      for (let lo = 0; lo < n; lo += 2 * width) {
        const mid = Math.min(lo + width, n)
        const hi = Math.min(lo + 2 * width, n)
        let i = lo
        let j = mid
        for (let k = lo; k < hi; k++) {
          if (i < mid && (j >= hi || cmp(a[i] as Block, a[j] as Block) <= 0)) b[k] = a[i++] as Block
          else b[k] = a[j++] as Block
          if (++done === HOLD_STEP) {
            done = 0
            yield HOLD_STEP
          }
        }
      }
      ;[a, b] = [b, a]
    }
    list = a
  }
  const size = chunkSize()
  const chunks: Block[][] = []
  let chars = 0
  let cards = NO_BOOK.cards
  let since = 0
  for (let i = 0; i < n; i += size) {
    const chunk = list.slice(i, i + size)
    for (const b of chunk) chars += b.text.length
    cards = countCards(chunk, cards)
    chunks.push(chunk)
    since += chunk.length
    if (since >= HOLD_STEP) {
      yield since
      since = 0
    }
  }
  return { chunks, count: n, chars, cards }
}

/**
 * `state` holding `bookId` with exactly `blocks` (the book as the server sent it), replacing any
 * of its blocks the state held. O(book) in all, a step at a time: each step yields the blocks it
 * read or wrote (at most `HOLD_STEP`), so a client can hold a book of `maxBlocksPerBook` between
 * frames (`book/bookSync.ts`). Throws `RangeError` for a block of another book. Nothing else may
 * change `state` while it runs: its result is `state` with the book held.
 */
export function* holdBookSteps(
  state: BoardState,
  bookId: string,
  blocks: readonly Block[],
): Generator<number, BoardState> {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] as Block
    if (b.bookId !== bookId)
      throw new RangeError(`holdBook: block ${b.id} is not in book ${bookId}`)
    if ((i + 1) % HOLD_STEP === 0) yield HOLD_STEP
  }
  // A fresh map sized for what it will hold, the other books' blocks copied in a step at a time:
  // filled from the board's own, it would widen its root as it grew (an O(n) rebuild in one go at
  // ~1k, 4k, 16k and 65k entries), which is the one stretch a step must not hold.
  const ix = blockIndex(state.blocks).asTransient()
  const mine = bookBlocks(state.blocks, bookId).count
  const map = PMap.sized<string, Block>(state.blocks.size - mine + blocks.length).asTransient()
  let n = 0
  for (const [id, b] of state.blocks) {
    if (b.bookId !== bookId) map.set(id, b)
    if (++n % HOLD_STEP === 0) yield HOLD_STEP
  }
  n = 0
  for (const b of blocks) {
    map.set(b.id, b)
    if (++n % HOLD_STEP === 0) yield HOLD_STEP
  }
  const book = yield* bookBlocksSteps(blocks)
  if (book.count > 0) ix.set(bookId, book)
  else ix.delete(bookId)
  const out = map.persist()
  keepBlockIndex(out, ix.persist())
  const held = state.blocksHeld
  return {
    ...state,
    blocks: out,
    blocksHeld: held === 'all' || held.has(bookId) ? held : new Set([...held, bookId]),
  }
}

/** `state.blocks` with `bookId`'s blocks taken out and `put` (that book's, or none) put in. */
function withBook(state: BoardState, bookId: string, put: readonly Block[]): BoardState['blocks'] {
  const blocks = asPMap(state.blocks).asTransient()
  const ix = blockIndex(state.blocks).asTransient()
  for (const chunk of bookBlocks(state.blocks, bookId).chunks) {
    for (const b of chunk) blocks.delete(b.id)
  }
  for (const b of put) blocks.set(b.id, b)
  const book = bookBlocksOf(put)
  if (book.count > 0) ix.set(bookId, book)
  else ix.delete(bookId)
  const out = blocks.persist()
  keepBlockIndex(out, ix.persist())
  return out
}

/**
 * `state` holding `bookId` with exactly `blocks` (the book as the server sent it), replacing any
 * of its blocks the state held. O(book), in one go: {@link holdBookSteps} is the same a step at
 * a time. Throws `RangeError` for a block of another book.
 */
export function holdBook(state: BoardState, bookId: string, blocks: readonly Block[]): BoardState {
  const steps = holdBookSteps(state, bookId, blocks)
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

/**
 * `state` without `bookId`'s blocks, no longer holding it (its block ops change nothing until it
 * is held again). A state holding every book then holds every other book it has. O(book).
 */
export function releaseBook(state: BoardState, bookId: string): BoardState {
  const held = state.blocksHeld
  const rest = new Set(held === 'all' ? state.books.keys() : held)
  rest.delete(bookId)
  return { ...state, blocks: withBook(state, bookId, []), blocksHeld: rest }
}
