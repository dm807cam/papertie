/**
 * The book store's work (`bookStore.ts`), in the book chunk (`book/bookSync.ts`): holding an
 * open book's paragraphs, read from the book route, and letting them go once it is closed.
 */
import type { BoardState } from '@papertie/core'
import { backoff, delayFor } from '../retry'
import { held } from './bookOps'
import type { BookStoreOptions } from './bookStore'

/** Reads of a book that come back stale (it changed meanwhile) before giving up. */
const READS = 3

export interface BookHolder {
  /** False: the book could not be read just now, and is read again by itself while it is open. */
  open(bookId: string): Promise<boolean>
  close(bookId: string): void
  changed(state: BoardState): void
  /** The books open now. */
  opened(): string[]
  dispose(): void
}

/** A book that could not be read: its failures in a row, and its next read. */
type Unread = { failures: number; timer: ReturnType<typeof setTimeout> | null }

export function createBookHolder(o: BookStoreOptions): BookHolder {
  const { client } = o
  const open = new Set<string>()
  const opening = new Map<string, Promise<boolean>>()
  const unread = new Map<string, Unread>()
  /** Books closed while edits on them wait: let go once those are committed. */
  const closing = new Set<string>()
  let disposed = false

  /** Hold `bookId`: null once it is held (or gone), else the wait before the next read. */
  const hold = async (bookId: string, n: number): Promise<number | null> => {
    if (o.started) await o.started
    const book = client.confirmed.books.get(bookId)
    if (!book || held(client.confirmed, bookId)) return null
    for (let k = 0; k < READS && !disposed; k++) {
      let f: Awaited<ReturnType<typeof client.fetchBook>>
      try {
        f = await client.fetchBook(bookId)
      } catch (e) {
        return delayFor(e, n)
      }
      if (f === null) return null
      if ((await client.holdBook(bookId, f.blocks, f.revision)) !== 'stale') return null
    }
    // Read stale each time (it keeps changing as it is read): read again after a while.
    return backoff(n)
  }

  /** One hold of `bookId` for every ask that meets it; false: it could not be read. */
  const attempt = (bookId: string): Promise<boolean> => {
    let p = opening.get(bookId)
    if (p) return p
    const u = unread.get(bookId)
    if (u?.timer) clearTimeout(u.timer)
    if (u) u.timer = null
    p = hold(bookId, u?.failures ?? 0)
      .catch((e: unknown) => delayFor(e, u?.failures ?? 0))
      .then((wait) => {
        opening.delete(bookId)
        if (wait === null || disposed) {
          unread.delete(bookId)
          return true
        }
        const v = unread.get(bookId) ?? { failures: 0, timer: null }
        unread.set(bookId, v)
        v.failures++
        if (open.has(bookId)) {
          v.timer = setTimeout(() => {
            v.timer = null
            again(bookId)
          }, wait)
        }
        return false
      })
    opening.set(bookId, p)
    return p
  }
  const again = (bookId: string) => {
    if (!disposed && open.has(bookId)) void attempt(bookId)
  }
  /** The stream open again: each book that could not be read, read now. */
  const offUp = client.onStreamUp?.(() => {
    for (const id of unread.keys()) again(id)
  })

  return {
    open(bookId) {
      open.add(bookId)
      closing.delete(bookId)
      // Waiting to be read again (a backoff): the ask meets that wait.
      const u = unread.get(bookId)
      if (u !== undefined && u.timer !== null && !opening.has(bookId)) return Promise.resolve(false)
      return attempt(bookId)
    },
    close(bookId) {
      open.delete(bookId)
      // Let go a turn later: a screen opened again at once (React's remount, the same book again)
      // keeps it held, and a read it waits for.
      queueMicrotask(() => {
        if (disposed || open.has(bookId)) return
        const u = unread.get(bookId)
        if (u?.timer) clearTimeout(u.timer)
        if (u) u.timer = null
        if (client.hasPendingOn(bookId)) closing.add(bookId)
        else client.releaseBook(bookId)
      })
    },
    changed(state) {
      if (disposed) return
      // A closed book whose edits are all committed now is let go.
      for (const id of closing) {
        if (open.has(id) || !held(state, id)) closing.delete(id)
        else if (!client.hasPendingOn(id)) {
          closing.delete(id)
          client.releaseBook(id)
        }
      }
    },
    opened: () => [...open],
    dispose() {
      disposed = true
      for (const u of unread.values()) if (u.timer) clearTimeout(u.timer)
      offUp?.()
    },
  }
}
