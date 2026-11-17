/**
 * Which card each passage of a book came from. A card mark is an ordinary block mark
 * whose type is `c:` + the note's id, so it is sorted, merged, split and sliced by the code bold
 * and italic use (`splice.ts`). A figure names its card on `image.card`
 * (a caption can be empty). Each book's count of blocks naming each card is kept with the block
 * index (`blockIndex.ts`), and the server stamps a book's `cards` (the note ids its blocks name)
 * in the commit that changes them (`book.cards`).
 */
import { LIMITS } from '../limits'
import type { Touched } from '../ops/invariants'
import type { Op } from '../ops/schema'
import type { Block, CardMarkT } from '../schema/records'
import type { BoardState } from '../state'
import { bookBlocks, namedCards } from './blockIndex'

/**
 * Calls of {@link cardsOfBlock}: what a test bounds (a stamp costs the touched blocks' cards),
 * never a clock. Internal; not exported from the package.
 */
export const CARD_WORK = { calls: 0 }

/** The mark type of card `noteId`'s passages. */
export const cardMarkT = (noteId: string): CardMarkT => `c:${noteId}` as CardMarkT

/** The cards a block names: its card marks' notes, and a figure's `image.card`. O(marks). */
export function cardsOfBlock(b: Block): ReadonlySet<string> {
  CARD_WORK.calls++
  return namedCards(b)
}

/**
 * Per book: note id → the number of the book's blocks naming it (the blocks held only), kept
 * incrementally with the block index: O(1).
 */
export function cardCounts(state: BoardState, bookId: string): ReadonlyMap<string, number> {
  return bookBlocks(state.blocks, bookId).cards
}

/** Whether sorted `list` has `id`: a binary search. */
function sortedHas(list: readonly string[], id: string): boolean {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const x = list[mid] as string
    if (x === id) return true
    if (x < id) lo = mid + 1
    else hi = mid
  }
  return false
}

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The `book.cards` ops that bring the `cards` of the books `touched` wrote blocks in (from
 * `before` to `after`) up to their counts in `after`: one op per book whose set changed, in book
 * id order, none when no set changed. Only the cards the touched blocks named before or after are
 * looked at: O(touched blocks × their cards), never a book. Adding stops at `maxBookCards` (the
 * book's list is then incomplete); it never throws.
 */
export function cardStamps(before: BoardState, after: BoardState, touched: Touched): Op[] {
  const named = new Map<string, Set<string>>()
  for (const id of touched.blocks) {
    const was = before.blocks.get(id)
    const now = after.blocks.get(id)
    const bookId = (now ?? was)?.bookId
    if (bookId === undefined) continue
    let set = named.get(bookId)
    for (const b of [was, now]) {
      if (b === undefined) continue
      for (const n of cardsOfBlock(b)) {
        set ??= new Set()
        set.add(n)
      }
    }
    if (set) named.set(bookId, set)
  }
  const out: Op[] = []
  for (const bookId of [...named.keys()].sort(byCode)) {
    const book = after.books.get(bookId)
    if (book === undefined) continue
    const counts = cardCounts(after, bookId)
    const has = book.cards ?? []
    const add: string[] = []
    const remove: string[] = []
    for (const n of named.get(bookId) as Set<string>) {
      const want = (counts.get(n) ?? 0) > 0
      const listed = sortedHas(has, n)
      if (want && !listed) add.push(n)
      else if (!want && listed) remove.push(n)
    }
    add.sort(byCode)
    remove.sort(byCode)
    // Past the limit the list is incomplete: the first ids are kept, the rest left out.
    const room = Math.max(0, LIMITS.maxBookCards - (has.length - remove.length))
    if (add.length > room) add.length = room
    if (add.length === 0 && remove.length === 0) continue
    out.push({
      op: 'book.cards',
      id: bookId,
      ...(add.length > 0 ? { add } : {}),
      ...(remove.length > 0 ? { remove } : {}),
    })
  }
  return out
}

/**
 * A book's cards from its blocks, sorted (code-unit order) and at most `maxBookCards`: what an
 * import stamps, and the tests' rebuild.
 */
export function cardsFromBlocks(blocks: Iterable<Block>): string[] {
  const all = new Set<string>()
  for (const b of blocks) for (const n of namedCards(b)) all.add(n)
  return [...all].sort(byCode).slice(0, LIMITS.maxBookCards)
}

/** `cards` (sorted) with `remove` taken out and `add` put in, sorted: O(cards + changes). */
export function withCardChanges(
  cards: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): string[] {
  const gone = new Set(remove)
  const out: string[] = []
  let j = 0
  for (const id of cards) {
    while (j < add.length && (add[j] as string) < id) {
      const a = add[j++] as string
      if (!gone.has(a)) out.push(a)
    }
    if (j < add.length && add[j] === id) j++
    if (!gone.has(id)) out.push(id)
  }
  for (; j < add.length; j++) {
    const a = add[j] as string
    if (!gone.has(a)) out.push(a)
  }
  return out
}
