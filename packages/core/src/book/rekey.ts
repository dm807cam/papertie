/**
 * The keys of an undo or redo step fitted to the book it applies to. A step's ops carry keys made
 * against the book as it was when the step was recorded; where the book has other blocks there
 * now, such a key may land past one of them. Two kinds of op say which block theirs goes after:
 * a split (its new block follows its head) and a move that names a block (`block.set` of a key
 * with `after`; `null` is the book's start). `fitBatch` keys each such block right after the one
 * it follows, as the book has them by then. A split's new block may also follow the notes beside
 * its head (prompts and footnotes): a paragraph joined into the one before it past that one's
 * notes comes back, on undo, after them.
 */

import { LIMITS } from '../limits'
import type { Op } from '../ops/schema'
import type { Block } from '../schema/records'
import type { BoardState } from '../state'
import { type BookBlocks, blockIndex, type Owned, reindexBlock } from './blockIndex'
import { posBetween, posKeysBetween } from './position'

type Place = { pos: string; bookId: string }
type Next = { pos: string; id: string } | null
type Move = Extract<Op, { op: 'block.set' }> & { after: string | null }

/** A move of a block that says what it follows (`block.set` of a key with `after`). */
const isMove = (op: Op): op is Move =>
  op.op === 'block.set' && op.set.pos !== undefined && op.after !== undefined

/** A note beside the block before it: a prompt or a footnote. */
const aside = (kind: Block['kind'] | undefined) => kind === 'prompt' || kind === 'footnote'

/** `(pos, id)` order, by code units. */
const before = (p: string, id: string, q: string, qid: string) => p < q || (p === q && id < qid)

/**
 * Whether `pos` puts a block right after one at `hp` (null: the book's start) and before `next`
 * (null: the book's end): strictly between their keys, so that it ties with neither (the ids
 * would decide, and the next block put there would find no key between).
 */
const fits = (hp: string | null, pos: string, next: Next) =>
  (hp === null || hp < pos) && (next === null || pos < next.pos)

/**
 * A key between `hp` and `next`'s within `maxPosLength`; null where none is (`next` at or before
 * `hp`, or keys too close for one more digit).
 */
function between(hp: string | null, next: Next): string | null {
  if (next !== null && hp !== null && !(hp < next.pos)) return null
  const pos = posBetween(hp, next?.pos ?? null)
  return pos.length <= LIMITS.maxPosLength ? pos : null
}

/**
 * `ops` with the new block of each split keyed between its head and the block after the head,
 * and each move that names the block it follows keyed between that block and the one after it,
 * as the ops before it leave the book. `ops` itself where no key changes (and always for a batch
 * without a split or such a move).
 *
 * An op keeps its own key where that already lies strictly between the two; otherwise it takes a
 * new one between them. A split whose head is not a note itself also keeps a key that lies past
 * notes right after its head (prompts, footnotes: they stay beside the head), strictly between two
 * of them or between the last and the block after it. A run of moves, each after the block the one before it moved (a chapter
 * put elsewhere), takes its keys together, spread over the gap, when its first needs one. An op
 * also keeps its key when:
 * - no key within `maxPosLength` lies between the two (the order there may then be off; the op
 *   still applies);
 * - the block it follows is not in the book, or is in another book, or the moved block is gone;
 * - the batch itself sets the key of the block it follows later on (the editor re-spacing keys:
 *   the op's key is of that new spacing).
 *
 * The book is read as the batch leaves it: the state's index with each place the ops before
 * made, moved or removed written in when a lookup needs it. O(ops × log book).
 */
export function fitBatch<T extends Op>(state: BoardState, ops: readonly T[]): T[] {
  if (!ops.some((op) => op.op === 'block.split' || isMove(op))) return ops as T[]

  /** What the batch has done to blocks so far: a block's place, or null once it is gone. */
  const moved = new Map<string, Place | null>()
  const placeOf = (id: string): Place | null | undefined => {
    if (moved.has(id)) return moved.get(id)
    const b = state.blocks.get(id)
    return b ? { pos: b.pos, bookId: b.bookId } : undefined
  }
  const books = blockIndex(state.blocks).asTransient()
  const owned: Owned = new WeakSet()
  /** The block the index holds at `id`'s place once the batch has placed it. */
  const held = new Map<string, Block>()
  /** Places not yet written to the index: none is, for the ops after the last lookup. */
  const pending: [Block | undefined, Block | undefined][] = []
  const place = (id: string, to: Place | null) => {
    const was = moved.get(id) === null ? undefined : (held.get(id) ?? state.blocks.get(id))
    const now =
      to === null ? undefined : ({ id, pos: to.pos, bookId: to.bookId, text: '' } as Block)
    if (was !== undefined || now !== undefined) pending.push([was, now])
    if (now) held.set(id, now)
    moved.set(id, to)
  }
  /** The kinds the batch has given blocks so far (made, split off or set). */
  const kinds = new Map<string, Block['kind']>()
  const kindOf = (id: string) => kinds.get(id) ?? state.blocks.get(id)?.kind
  /** The block after `(pos, id)` in `bookId` as the batch leaves it so far, `own` aside. */
  const blockAfter = (bookId: string, pos: string, id: string, own: string) => {
    for (const [was, now] of pending) reindexBlock(books, was, now, owned)
    pending.length = 0
    return nextAfter(books.get(bookId), pos, id, own)
  }

  /** Where the batch last sets each block's key without saying what it follows (a re-spacing). */
  const lastSet = new Map<string, number>()
  /** The first move after each block, by that block. */
  const firstAfter = new Map<string, number>()
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Op
    if (op.op !== 'block.set' || op.set.pos === undefined) continue
    if (!isMove(op)) lastSet.set(op.id, i)
    else if (op.after !== null && !firstAfter.has(op.after)) firstAfter.set(op.after, i)
  }
  const setLater = (id: string, i: number) => (lastSet.get(id) ?? -1) > i
  /** How many moves the run headed by move `i` holds: itself, and the run after its block. */
  const runOf = new Map<number, number>()
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i] as Op
    if (!isMove(op)) continue
    const j = firstAfter.get(op.id)
    runOf.set(i, 1 + (j !== undefined && j > i ? (runOf.get(j) as number) : 0))
  }
  /** The keys a run's head gave the moves after it, by block. */
  const planned = new Map<string, string>()

  /**
   * The key of block `own`, which op `i` places with key `pos` after `head` (the block `hid`;
   * null: the book's start): `pos` where it fits, else the key its run planned, else a key
   * between (the run's keys together for a run's head), else `pos`. With `pastAsides` (a split),
   * `pos` also fits past the notes right after a head that is not a note.
   */
  const fit = (
    bookId: string,
    head: Place | null,
    hid: string,
    own: string,
    pos: string,
    i: number,
    pastAsides = false,
  ): string => {
    const hp = head?.pos ?? null
    const next = blockAfter(bookId, hp ?? '', hid, own)
    if (fits(hp, pos, next)) return pos
    if (pastAsides && !aside(kindOf(hid))) {
      // The last note before `pos` in the run of notes after the head, and the block after it.
      let last: Next = null
      let then = next
      while (then !== null && then.pos < pos && aside(kindOf(then.id))) {
        last = then
        then = blockAfter(bookId, then.pos, then.id, own)
      }
      if (last !== null && fits(last.pos, pos, then)) return pos
    }
    const mine = planned.get(own)
    if (mine !== undefined && fits(hp, mine, next)) return mine
    const n = runOf.get(i) ?? 1
    if (n > 1 && (next === null || hp === null || hp < next.pos)) {
      let keys: string[] | null = null
      try {
        keys = posKeysBetween(hp, next?.pos ?? null, n)
      } catch {
        keys = null
      }
      if (keys !== null) {
        let id = own
        for (let k = 1; k < n; k++) {
          id = (ops[firstAfter.get(id) as number] as Move).id
          planned.set(id, keys[k] as string)
        }
        return keys[0] as string
      }
    }
    return between(hp, next) ?? pos
  }

  let changed = false
  const out: Op[] = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Op
    let next: Op = op
    switch (op.op) {
      case 'block.create':
        kinds.set(op.block.id, op.block.kind)
        place(op.block.id, { pos: op.block.pos, bookId: op.block.bookId })
        break
      case 'block.delete':
        place(op.id, null)
        break
      case 'block.merge':
        place(op.from, null)
        break
      case 'block.set': {
        if (op.set.kind !== undefined) kinds.set(op.id, op.set.kind)
        if (op.set.pos === undefined) break
        let pos = op.set.pos
        const now = placeOf(op.id)
        if (isMove(op)) {
          const { after } = op
          const head = after === null ? null : placeOf(after)
          const anchored = after === null || head?.bookId === op.bookId
          if (now && anchored && !(after !== null && setLater(after, i))) {
            pos = fit(op.bookId, head ?? null, after ?? '', op.id, pos, i)
            if (pos !== op.set.pos) next = { ...op, set: { ...op.set, pos } }
          }
        }
        if (now) place(op.id, { pos, bookId: op.bookId })
        break
      }
      case 'block.split': {
        const head = placeOf(op.id)
        let pos = op.pos
        if (head && !setLater(op.id, i)) {
          pos = fit(op.bookId, head, op.id, op.newId, pos, i, true)
          if (pos !== op.pos) next = { ...op, pos }
        }
        kinds.set(op.newId, op.kind)
        place(op.newId, { pos, bookId: op.bookId })
        break
      }
    }
    if (next !== op) changed = true
    out.push(next)
  }
  return changed ? (out as T[]) : (ops as T[])
}

/**
 * The block of `book` right after `(pos, id)`, the block `own` aside: a binary search over the
 * chunks and then in one.
 */
function nextAfter(book: BookBlocks | undefined, pos: string, id: string, own: string): Next {
  const chunks = book?.chunks ?? []
  const after = (b: Block) => !(before(b.pos, b.id, pos, id) || (b.pos === pos && b.id === id))
  let lo = 0
  let hi = chunks.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const chunk = chunks[mid] as readonly Block[]
    if (!after(chunk[chunk.length - 1] as Block)) lo = mid + 1
    else hi = mid
  }
  for (let c = lo; c < chunks.length; c++) {
    const chunk = chunks[c] as readonly Block[]
    let i = 0
    if (c === lo) {
      let l = 0
      let h = chunk.length
      while (l < h) {
        const m = (l + h) >>> 1
        if (!after(chunk[m] as Block)) l = m + 1
        else h = m
      }
      i = l
    }
    for (; i < chunk.length; i++) {
      const b = chunk[i] as Block
      if (b.id !== own) return { pos: b.pos, id: b.id }
    }
  }
  return null
}
