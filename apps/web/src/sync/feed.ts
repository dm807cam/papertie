import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { droppedMessage, rejectedMessage } from './notices'
import type { SaveStatus, SyncNotice } from './types'

/** A notice as the board shows it: a slip, and (dropped and rejected) a line in the save dot. */
export interface FeedNotice {
  /** New for every change of the notice, so its slip is read out (and drawn) afresh. */
  id: number
  kind: 'dropped' | 'rejected' | 'reset' | 'limit' | 'book-gone'
  count: number
  message: string
  /** Its slip is up. A dropped or rejected notice stays listed in the popover after it goes. */
  slip: boolean
  /**
   * A server reset whose slip waits for the recovery check (`watchResets`): the recovery slip
   * may say it instead (`releaseReset`).
   */
  held?: true
  /** `book-gone`: the open book gone under the writer (one notice a book). */
  bookId?: string
}

export interface FeedState {
  status: SaveStatus
  /** Batches only this page holds (`SyncClient.pending`). */
  pending: number
  /** The page waits to be reloaded (`reloadMessage`). */
  updated: boolean
  /** What the reload slip says: why this page waits for a reload. */
  updatedCopy: string
  notices: readonly FeedNotice[]
}

/**
 * What a board session tells the save dot and the notice slips, apart from the board: their
 * components subscribe to it alone, so a status change never re-renders the board tree.
 */
export interface SyncFeed extends Pick<StoreApi<FeedState>, 'getState' | 'subscribe'> {
  status(s: SaveStatus): void
  pending(n: number): void
  notice(n: SyncNotice): void
  /** A slip goes: faded, or dismissed. A reset's or a limit's notice goes with it. */
  hideSlip(id: number): void
  /** The popover's list was read and cleared. */
  clearNotices(): void
  /**
   * This page asks the store to replace the board (an import, a restore). The reset the server
   * sends for it is its own, said where it was asked, so it brings no slip. Which reset that is
   * the answer tells (`done` with the board's new revision): a server reset that comes while the
   * request is out waits for it, then is dropped if it has that revision and said if not. A
   * reset of any other revision is always said, whenever it comes. `failed`: none is coming.
   */
  ownReset(): { done(revision: number): void; failed(): void }
  /**
   * Hold each server reset's slip until `releaseReset` (the recovery slip checks whether it
   * says the reset itself). Returns the undo.
   */
  watchResets(): () => void
  /** A held reset: dropped when the recovery slip says it (`folded`), else its slip shows. */
  releaseReset(id: number, folded: boolean): void
  /**
   * Told when this page asks the store to replace the board ({@link ownReset}: a restore, an
   * import, the recovery notice's): the books this page holds go, and the open
   * book's screen starts over (`bookStore`). Returns the undo.
   */
  onOwnReset(fn: () => void): () => void
}

/** Revisions of own resets that have not come yet, at most this many (the oldest go first). */
const OWN_KEPT = 8

const MESSAGE = { dropped: droppedMessage, rejected: rejectedMessage } as const

const apis = new WeakMap<SyncFeed, StoreApi<FeedState>>()

/**
 * The feed of one board session. Dropped and rejected notices of a kind merge into one, counting
 * every change not saved, so the board never stacks slips; a newer reset replaces an older one,
 * and a newer limit slip an older one (each kind its own slot: neither takes the other's place).
 */
export function createSyncFeed(): SyncFeed {
  const api = createStore<FeedState>()(() => ({
    status: 'saved',
    pending: 0,
    updated: false,
    updatedCopy: '',
    notices: [],
  }))
  let nextId = 1
  /** Own requests still out, the server resets held for them, own revisions yet to come. */
  let asking = 0
  let waiting: SyncNotice[] = []
  const ownRevisions: number[] = []
  let watchers = 0
  const resets = new Set<() => void>()
  const set = (patch: Partial<FeedState>) => api.setState(patch)
  const release = () => {
    if (asking > 0) return
    const was = waiting
    waiting = []
    for (const n of was) feed.notice(n)
  }
  const feed: SyncFeed = {
    getState: () => api.getState(),
    subscribe: (fn) => api.subscribe(fn),
    status: (status) => {
      if (api.getState().status !== status) set({ status })
    },
    pending: (pending) => {
      if (api.getState().pending !== pending) set({ pending })
    },
    notice: (n) => {
      if (n.kind === 'updated') {
        // The first reason given stays (a page waits for one reload whatever came next).
        if (!api.getState().updated) set({ updated: true, updatedCopy: n.message })
        return
      }
      if (n.kind === 'reset' && n.server) {
        const at = n.revision === undefined ? -1 : ownRevisions.indexOf(n.revision)
        if (at >= 0) {
          ownRevisions.splice(at, 1)
          return
        }
        if (asking > 0) {
          waiting.push(n)
          return
        }
      }
      const { notices } = api.getState()
      const { kind } = n
      const same = notices.find((x) => x.kind === kind && x.bookId === n.bookId)
      const said = kind === 'reset' || kind === 'limit' || kind === 'book-gone'
      const count = said ? 1 : n.count + (same?.count ?? 0)
      const message = said ? n.message : MESSAGE[kind](count)
      const next: FeedNotice = {
        id: nextId++,
        kind,
        count: kind === 'reset' || kind === 'limit' ? 0 : count,
        message,
        slip: true,
        ...(kind === 'reset' && n.server && watchers > 0 ? { held: true as const } : {}),
        ...(n.bookId === undefined ? {} : { bookId: n.bookId }),
      }
      set({ notices: [...notices.filter((x) => x !== same), next] })
    },
    hideSlip: (id) => {
      const { notices } = api.getState()
      const n = notices.find((x) => x.id === id)
      if (!n?.slip) return
      set({
        notices:
          n.kind === 'reset' || n.kind === 'limit'
            ? notices.filter((x) => x !== n)
            : notices.map((x) => (x === n ? { ...x, slip: false } : x)),
      })
    },
    clearNotices: () => {
      if (api.getState().notices.length > 0) set({ notices: [] })
    },
    ownReset: () => {
      for (const fn of [...resets]) fn()
      asking++
      let settled = false
      const settle = () => {
        if (settled) return false
        settled = true
        asking--
        return true
      }
      return {
        done: (revision) => {
          if (!settle()) return
          const at = waiting.findIndex((n) => n.revision === revision)
          if (at >= 0) waiting.splice(at, 1)
          else {
            ownRevisions.push(revision)
            if (ownRevisions.length > OWN_KEPT) ownRevisions.shift()
          }
          release()
        },
        failed: () => {
          if (settle()) release()
        },
      }
    },
    watchResets: () => {
      watchers++
      let on = true
      return () => {
        if (on) watchers--
        on = false
      }
    },
    onOwnReset: (fn) => {
      resets.add(fn)
      return () => {
        resets.delete(fn)
      }
    },
    releaseReset: (id, folded) => {
      const { notices } = api.getState()
      const n = notices.find((x) => x.id === id)
      if (n?.held === undefined) return
      set({
        notices: folded
          ? notices.filter((x) => x !== n)
          : notices.map((x) => (x === n ? { ...x, held: undefined } : x)),
      })
    },
  }
  apis.set(feed, api)
  return feed
}

/** Subscribe a component to a slice of the feed (a stable value, as for `useBoard`). */
export function useFeed<T>(feed: SyncFeed, selector: (s: FeedState) => T): T {
  const api = apis.get(feed)
  if (!api) throw new Error('useFeed: feed was not made by createSyncFeed')
  return useStore(api, selector)
}
