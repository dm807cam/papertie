import { type BoardState, bookBlocks, LIMITS, type Op } from '@papertie/core'
import type { Clock } from '../clock'
import { pastTrash } from '../limits'
import type { Logger } from '../log'
import type { BoardStore } from './boardStore'
import { SLICE_MS, Slicer, yieldTurn } from './compact'
import { StoreError } from './errors'

/**
 * The purge of deleted books: a book whose `trashedAt` (the server's own time of the
 * deletion, `stampTrashed`) is more than `BOOK_TRASH_MS` ago leaves the board for good, its blocks
 * first, `maxPurgeBlocks` (500) at a time in `block.purge` commits with a `Slicer` pause between,
 * then the book in a `book.purge`. Each commit checks,
 * right before it applies, that the book is still deleted and due. A book past its window is never
 * put back (`checkTrash` in `boardStore.ts` refuses it), so the purge, once due, takes it whole. Runs only on a board that is loaded (never loads one), like the asset
 * sweep, beside which it is scheduled.
 */

/** A board's purge runs at most once in this long (the trash keeps a book for 30 days). */
export const BOOK_PURGE_SPACING_MS = 6 * 3_600_000

export type PurgeResult = { deferred: true } | { deferred: false; books: number; blocks: number }

/** Whether `state`'s book `id` is deleted and due by `nowMs`. */
function due(state: BoardState, id: string, nowMs: number): boolean {
  return pastTrash(state.books.get(id)?.trashedAt, nowMs)
}

/** The ids of `bookId`'s blocks in `state`, gathered in slices. */
async function blockIds(state: BoardState, bookId: string): Promise<string[]> {
  const s = await Slicer.start(SLICE_MS)
  const out: string[] = []
  // The book's index, a chunk at a time (never flattened in one step).
  for (const chunk of bookBlocks(state.blocks, bookId).chunks) {
    for (const b of chunk) out.push(b.id)
    if (s.due()) await s.pause()
  }
  s.note()
  return out
}

/** Purge every due book of the board, if it is loaded (`deferred` when it is not). */
export async function purgeBooks(
  store: BoardStore,
  userId: string,
  boardId: string,
  clock: Clock,
): Promise<PurgeResult> {
  const first = await store.peekIfCached(userId, boardId)
  if (first === null) return { deferred: true }
  const nowMs = () => clock.now().getTime()
  const dueIds = [...first.books.keys()].filter((id) => due(first, id, nowMs()))
  let books = 0
  let blocks = 0
  /** Commits `op` if the book is still due when it applies: false when it was not. */
  const commit = async (op: Op, bookId: string): Promise<boolean | 'deferred'> => {
    try {
      const ack = await store.submitServerIfCached(userId, boardId, [op], (s) =>
        due(s, bookId, nowMs()),
      )
      return ack === null ? 'deferred' : true
    } catch (e) {
      // Put back (or purged by a run before) meanwhile: its blocks stay.
      if (e instanceof StoreError && e.opError?.code === 'conflict') return false
      throw e
    }
  }
  for (const bookId of dueIds) {
    // A few rounds at most: blocks written into the book while it goes are taken next round.
    for (let round = 0; round < 8; round++) {
      const state = await store.peekIfCached(userId, boardId)
      if (state === null) return { deferred: true }
      if (!due(state, bookId, nowMs())) break
      const ids = await blockIds(state, bookId)
      let stopped = false
      for (let at = 0; at + LIMITS.maxPurgeBlocks < ids.length; at += LIMITS.maxPurgeBlocks) {
        const chunk = ids.slice(at, at + LIMITS.maxPurgeBlocks)
        const r = await commit({ op: 'block.purge', bookId, ids: chunk }, bookId)
        if (r === 'deferred') return { deferred: true }
        if (!r) {
          stopped = true
          break
        }
        blocks += chunk.length
        // A pause between two commits: other work (and other jobs' slices) runs in between.
        await yieldTurn()
      }
      if (stopped) break
      // The last `maxPurgeBlocks` or fewer go with the book, which takes what is left.
      const left = Math.min(ids.length, ids.length % LIMITS.maxPurgeBlocks || LIMITS.maxPurgeBlocks)
      let r: boolean | 'deferred'
      try {
        r = await commit({ op: 'book.purge', id: bookId }, bookId)
      } catch (e) {
        // Blocks were added meanwhile, more than one op may take: another round.
        if (e instanceof StoreError && e.opError?.code === 'limit') continue
        throw e
      }
      if (r === 'deferred') return { deferred: true }
      if (r) {
        books++
        blocks += left
      }
      break
    }
  }
  return { deferred: false, books, blocks }
}

export interface BookPurgerDeps {
  store: BoardStore
  log: Logger
  clock: Clock
}

/**
 * When each board's purge runs: on the daily pass if the board is loaded, and when it is loaded
 * or compacted (`onBoardReady`), at most once per `BOOK_PURGE_SPACING_MS`, one run per board at
 * a time (as `AssetSweeper`).
 */
export class BookPurger {
  private readonly lastRun = new Map<string, number>()
  private readonly running = new Map<string, Promise<PurgeResult | null>>()
  private closed = false

  constructor(private readonly deps: BookPurgerDeps) {}

  /** Purge the board's due books now, unless it ran within the spacing. Never rejects. */
  purge(userId: string, boardId: string): Promise<PurgeResult | null> {
    const key = `${userId}/${boardId}`
    const running = this.running.get(key)
    if (running) return running
    const now = this.deps.clock.now().getTime()
    const last = this.lastRun.get(key)
    if (this.closed || (last !== undefined && now - last < BOOK_PURGE_SPACING_MS)) {
      return Promise.resolve(null)
    }
    const { store, log, clock } = this.deps
    const p = purgeBooks(store, userId, boardId, clock)
      .then((r) => {
        if (!r.deferred) this.lastRun.set(key, now)
        if (!r.deferred && r.books > 0) log.info('books purged', { count: r.books })
        return r
      })
      .catch((e: unknown) => {
        this.lastRun.set(key, now)
        if (!(e instanceof StoreError && e.code === 'not-found')) {
          log.warn('book purge failed', { kind: e instanceof Error ? e.name : 'unknown' })
        }
        return null
      })
      .finally(() => this.running.delete(key))
    this.running.set(key, p)
    return p
  }

  /** `BoardStore`'s `onBoardReady`: a board was just loaded or compacted. */
  readonly boardReady = (userId: string, boardId: string): void => {
    void this.purge(userId, boardId)
  }

  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values())
  }

  /** Start no more runs, and wait for the ones running. */
  async close(): Promise<void> {
    this.closed = true
    await this.settled()
  }
}
