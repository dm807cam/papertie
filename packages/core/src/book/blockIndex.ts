/**
 * Each book's blocks in `(pos, id)` order and its length, kept with the block map (as the thread
 * index is with the yarn map, `ops/threadIndex.ts`): built once when a board loads, then carried
 * through every edit by re-indexing only the blocks written, so neither `blocksOf` nor a batch's
 * limits check scans a book.
 *
 * A book's blocks are held in sorted chunks of about {@link CHUNK}: a write copies one chunk and
 * the list of chunks (some 470 slots in a book at `maxBlocksPerBook`), never the book.
 */
import { PMap, type TransientMap } from '../pmap'
import type { Block } from '../schema/records'
import type { BoardState } from '../state'

/** One book in the index. Immutable: an edit makes a new one. */
export interface BookBlocks {
  /** The blocks, in `(pos, id)` order, in chunks of 1 to 2 × {@link CHUNK}. */
  readonly chunks: readonly (readonly Block[])[]
  readonly count: number
  /** The sum of the blocks' text lengths (UTF-16 units). */
  readonly chars: number
  /**
   * Note id → how many of the blocks name it (card marks, a figure's `image.card`),
   * kept with every block written (`reindexBlock`), so no stamp counts a book. No zero entries.
   */
  readonly cards: PMap<string, number>
}

const NO_CARDS: PMap<string, number> = PMap.from()
const NO_NAMES: ReadonlySet<string> = new Set()
const NO_MARKS: Block['marks'] = []

/**
 * The cards block `b` names: its card marks' notes (`c:` + a note id) and a figure's
 * `image.card`. O(marks). `book/cards.ts`'s `cardsOfBlock` is this, counted.
 */
export function namedCards(b: Block): ReadonlySet<string> {
  let out: Set<string> | null = null
  // The re-key's scratch index holds stand-ins with a place and no marks (`rekey.ts`).
  for (const m of b.marks ?? NO_MARKS) {
    // `c` at 0 and `:` at 1: a card mark (the schema allows no other `c…` type).
    if (m.t.charCodeAt(0) === 99 && m.t.charCodeAt(1) === 58) {
      out ??= new Set()
      out.add(m.t.slice(2))
    }
  }
  const card = b.image?.card
  if (card !== undefined) {
    out ??= new Set()
    out.add(card)
  }
  return out ?? NO_NAMES
}

/** `cards` with `before`'s names counted out and `after`'s in (either absent: none). */
function recount(
  cards: PMap<string, number>,
  before: Block | undefined,
  after: Block | undefined,
): PMap<string, number> {
  if (before && after && before.marks === after.marks && before.image === after.image) return cards
  const was = before ? namedCards(before) : NO_NAMES
  const now = after ? namedCards(after) : NO_NAMES
  let out = cards
  for (const n of was) {
    if (now.has(n)) continue
    const c = (out.get(n) ?? 0) - 1
    out = c > 0 ? out.set(n, c) : out.delete(n)
  }
  for (const n of now) if (!was.has(n)) out = out.set(n, (out.get(n) ?? 0) + 1)
  return out
}

/**
 * The card counts of `blocks` (one book's) added to `cards`: a book of the index's `cards`.
 * O(their marks).
 */
export function countCards(
  blocks: Iterable<Block>,
  from: PMap<string, number> = NO_CARDS,
): PMap<string, number> {
  let cards = from
  for (const b of blocks) {
    if (b.marks?.length > 0 || b.image !== undefined) cards = recount(cards, undefined, b)
  }
  return cards
}

/** `book` with `cards` (itself when they are its own). */
function withCards(book: BookBlocks, cards: PMap<string, number>): BookBlocks {
  return book.cards === cards ? book : { ...book, cards }
}

/** Book id → its blocks. */
export type BlockIndex = PMap<string, BookBlocks>

let CHUNK = 128

/** Tests only: chunks of `n` (to cross splits and joins in small books); returns the undo. */
export function chunkSizeForTests(n: number): () => void {
  const was = CHUNK
  CHUNK = n
  return () => {
    CHUNK = was
  }
}
export const NO_BOOK: BookBlocks = { chunks: [], count: 0, chars: 0, cards: NO_CARDS }

/** The chunk size books are cut into now (`chunkSizeForTests` changes it). */
export const chunkSize = (): number => CHUNK

const cache = new WeakMap<ReadonlyMap<string, Block>, BlockIndex>()

/** `(pos, id)` order, by code units. */
export function cmp(x: Block, y: Block): number {
  if (x.pos !== y.pos) return x.pos < y.pos ? -1 : 1
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0
}

/** `blocks` (one book's, in any order) as a book of the index. */
export function bookBlocksOf(blocks: readonly Block[]): BookBlocks {
  if (blocks.length === 0) return NO_BOOK
  const sorted = [...blocks].sort(cmp)
  const chunks: Block[][] = []
  let chars = 0
  for (let i = 0; i < sorted.length; i += CHUNK) chunks.push(sorted.slice(i, i + CHUNK))
  for (const b of sorted) chars += b.text.length
  return { chunks, count: sorted.length, chars, cards: countCards(sorted) }
}

/** The index of `blocks`: cached, and built in one pass over the blocks the first time. */
export function blockIndex(blocks: ReadonlyMap<string, Block>): BlockIndex {
  let ix = cache.get(blocks)
  if (ix === undefined) {
    const byBook = new Map<string, Block[]>()
    for (const b of blocks.values()) {
      const list = byBook.get(b.bookId)
      if (list) list.push(b)
      else byBook.set(b.bookId, [b])
    }
    ix = PMap.from<string, BookBlocks>([...byBook].map(([id, list]) => [id, bookBlocksOf(list)]))
    cache.set(blocks, ix)
  }
  return ix
}

export function keepBlockIndex(blocks: ReadonlyMap<string, Block>, ix: BlockIndex): void {
  cache.set(blocks, ix)
}

/** The chunk `b` belongs in (the first whose last block is not before it; else the last). */
function chunkOf(chunks: readonly (readonly Block[])[], b: Block): number {
  let lo = 0
  let hi = chunks.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const chunk = chunks[mid] as readonly Block[]
    if (cmp(chunk[chunk.length - 1] as Block, b) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The first slot of `chunk` whose block is not before `b`. */
function slotOf(chunk: readonly Block[], b: Block): number {
  let lo = 0
  let hi = chunk.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cmp(chunk[mid] as Block, b) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The arrays (lists of chunks, chunks) one writer made and no state shares yet, which it may
 * change in place: a draft's, or a builder's. Without one, every write copies what it changes.
 */
export type Owned = WeakSet<readonly unknown[]>

/** `a` to change in place: itself when `owned` has it, else a copy that `owned` then has. */
function mine<T>(a: readonly T[], owned: Owned | undefined): T[] {
  if (owned?.has(a)) return a as T[]
  const copy = [...a]
  owned?.add(copy)
  return copy
}

/** A new array `owned` has. */
function made<T>(a: T[], owned: Owned | undefined): T[] {
  owned?.add(a)
  return a
}

/**
 * `book` with the chunk at `ci` now `next` (`mine`d), split, dropped or joined to a neighbour as
 * its size asks, so a book thinned by deletes keeps few chunks.
 */
function withChunk(
  book: BookBlocks,
  ci: number,
  next: Block[],
  count: number,
  chars: number,
  owned: Owned | undefined,
): BookBlocks {
  if (count === 0) return NO_BOOK
  const chunks = mine(book.chunks, owned)
  if (next.length > 2 * CHUNK) {
    chunks.splice(ci, 1, made(next.slice(0, CHUNK), owned), made(next.slice(CHUNK), owned))
  } else if (next.length === 0) {
    chunks.splice(ci, 1)
  } else if (next.length < CHUNK / 2 && chunks.length > 1) {
    const ni = ci + 1 < chunks.length ? ci + 1 : ci - 1
    const lo = Math.min(ci, ni)
    const other = chunks[ni] as Block[]
    const joined = made(ni > ci ? [...next, ...other] : [...other, ...next], owned)
    if (joined.length > 2 * CHUNK) {
      const half = joined.length >> 1
      chunks.splice(lo, 2, made(joined.slice(0, half), owned), made(joined.slice(half), owned))
    } else chunks.splice(lo, 2, joined)
  } else chunks[ci] = next
  return { chunks, count, chars, cards: book.cards }
}

/** `book` with `b` in its place. */
function inserted(book: BookBlocks, b: Block, owned: Owned | undefined): BookBlocks {
  if (book.count === 0) {
    return {
      chunks: made([made([b], owned)], owned),
      count: 1,
      chars: b.text.length,
      cards: book.cards,
    }
  }
  const ci = chunkOf(book.chunks, b)
  const next = mine(book.chunks[ci] as readonly Block[], owned)
  next.splice(slotOf(next, b), 0, b)
  return withChunk(book, ci, next, book.count + 1, book.chars + b.text.length, owned)
}

/** `book` without `b` (found by its `pos` and `id`); `book` itself when it is not there. */
function removed(book: BookBlocks, b: Block, owned: Owned | undefined): BookBlocks {
  if (book.count === 0) return book
  const ci = chunkOf(book.chunks, b)
  const chunk = book.chunks[ci] as readonly Block[]
  const at = slotOf(chunk, b)
  const held = chunk[at]
  if (held?.id !== b.id) return book
  const next = mine(chunk, owned)
  next.splice(at, 1)
  return withChunk(book, ci, next, book.count - 1, book.chars - held.text.length, owned)
}

/** `book` with the block at `before`'s place replaced by `after` (same id, book and pos). */
function replaced(
  book: BookBlocks,
  before: Block,
  after: Block,
  owned: Owned | undefined,
): BookBlocks {
  if (book.count === 0) return inserted(book, after, owned)
  const ci = chunkOf(book.chunks, before)
  const chunk = book.chunks[ci] as readonly Block[]
  const at = slotOf(chunk, before)
  const held = chunk[at]
  if (held?.id !== before.id) return inserted(book, after, owned)
  const next = mine(chunk, owned)
  next[at] = after
  const chars = book.chars - held.text.length + after.text.length
  return withChunk(book, ci, next, book.count, chars, owned)
}

/**
 * Update `t` for a block changing from `before` to `after` (absent: none). With `owned`, the
 * arrays it made before (and so no state shares) are changed in place: a run of writes to one
 * book costs O(1) each, not a copy of its list of chunks each.
 */
export function reindexBlock(
  t: TransientMap<string, BookBlocks>,
  before: Block | undefined,
  after: Block | undefined,
  owned?: Owned,
): void {
  if (before === after) return
  if (before && after && before.bookId === after.bookId && before.pos === after.pos) {
    const was = t.get(after.bookId) ?? NO_BOOK
    const book = replaced(was, before, after, owned)
    t.set(after.bookId, withCards(book, recount(was.cards, before, after)))
    return
  }
  if (before) {
    const was = t.get(before.bookId) ?? NO_BOOK
    const book = removed(was, before, owned)
    if (book.count === 0) t.delete(before.bookId)
    else if (book !== was)
      t.set(before.bookId, withCards(book, recount(was.cards, before, undefined)))
  }
  if (after) {
    const was = t.get(after.bookId) ?? NO_BOOK
    t.set(
      after.bookId,
      withCards(inserted(was, after, owned), recount(was.cards, undefined, after)),
    )
  }
}

const flat = new WeakMap<BookBlocks, readonly Block[]>()

/** One book of the index; an empty one for a book with no blocks held. */
export function bookBlocks(blocks: ReadonlyMap<string, Block>, bookId: string): BookBlocks {
  return blockIndex(blocks).get(bookId) ?? NO_BOOK
}

/**
 * The blocks of `bookId` the state holds, in `(pos, id)` order: none for a book not held. The
 * list is made once per version of the book (O(book) then) and shared until the book changes.
 */
export function blocksOf(state: BoardState, bookId: string): readonly Block[] {
  const book = bookBlocks(state.blocks, bookId)
  let out = flat.get(book)
  if (out === undefined) {
    out = book.chunks.flat()
    flat.set(book, out)
  }
  return out
}
