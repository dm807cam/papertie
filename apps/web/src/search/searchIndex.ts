import {
  type BoardState,
  type MapChanges,
  mapChangesWithin,
  type Note,
  type SearchHit,
  searchText,
} from '@papertie/core'
import type { BoardStore } from '../store/boardStore'
import type { IndexPort, IndexReply, IndexRequest } from './index.worker'

export type { SearchHit }

/** What the index reads of a note (a `Note` is one): its ref too. */
export interface SearchDoc {
  readonly id: string
  readonly text: string
  readonly ref?: string
  readonly updatedAt: string
}

/** Notes added or changed (text or edit time), and notes gone. */
export interface SearchChanges {
  readonly put: readonly SearchDoc[]
  readonly removed: readonly string[]
}

/**
 * The board's search: a trigram index of every note's folded text, kept in a
 * worker, so ⌘K, Connect to… and Bring in… answer as fast at 100,000 notes as at ten and typing
 * never waits on the board. Questions are answered in the order they were asked, each on the
 * board as it stood then: `apply` goes out before any later `query`.
 */
export interface SearchIndex {
  /** Index these notes instead of any before. Sent in slices when the page is idle. */
  load(notes: Iterable<SearchDoc>): void
  /** One commit's changes, sent at once. */
  apply(changes: SearchChanges): void
  /**
   * What core's `searchNotes` answers for the board, without the notes in `exclude`; with
   * `only`, among those notes alone (ranked among themselves, so the list fills however many
   * other notes match: the ref picker's).
   */
  query(
    q: string,
    limit: number,
    exclude?: ReadonlySet<string>,
    only?: ReadonlySet<string>,
  ): Promise<SearchHit[]>
  /** The ids of the `limit` notes edited last, newest first, without those in `exclude`; `only` as for `query`. */
  recent(
    limit: number,
    exclude?: ReadonlySet<string>,
    only?: ReadonlySet<string>,
  ): Promise<string[]>
  /**
   * Call `fn` when the index starts again from nothing (its worker failed and the same index now
   * runs on this thread), so the board is loaded into it again. Returns the unsubscribe.
   */
  onRestart?(fn: () => void): () => void
  /** Stop the worker; anything still asked answers empty. */
  dispose(): void
}

/** An index that keeps how long the worker took over its recent questions (test hooks). */
export interface TimedSearchIndex extends SearchIndex {
  /** In ms, oldest first. */
  readonly times: readonly number[]
}

/** The page's end of the channel to the worker. */
export type SearchPort = IndexPort<IndexReply, IndexRequest> & {
  onerror?: ((e: ErrorEvent) => void) | null
  onmessageerror?: ((e: MessageEvent) => void) | null
  terminate?(): void
  close?(): void
}

/** Notes per message while loading: well under a millisecond of the page's time each. */
const SLICE = 1000
/** A commit changing more notes than this is sent as a fresh load, in slices (a reset). */
const RELOAD_ABOVE = 5000
/** Worker query times kept for the test hooks. */
const KEEP_TIMES = 512
const NONE: ReadonlySet<string> = new Set()

type Idle = { timeRemaining(): number }
const idleApi = globalThis as {
  requestIdleCallback?: (fn: (d: Idle) => void, o?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}

/**
 * The index on this thread, over microtasks: where there is no worker, or it failed. The index's
 * code is the worker's module, loaded as this port is made (out of the board's first JS:
 * only a page with no worker needs it here); what is posted before it is in waits, in
 * order. Where it cannot load (a failed fetch), the port fails as a worker would (its
 * `onerror`), so every question waiting is answered empty, never left hanging.
 */
export function localPortFrom(
  load: () => Promise<{ serve(port: IndexPort<IndexRequest, IndexReply>): unknown }>,
): SearchPort {
  let waiting: unknown[] | null = []
  const deliver = (m: unknown) => worker.onmessage?.({ data: m } as MessageEvent)
  const page: SearchPort = {
    onmessage: null,
    onerror: null,
    postMessage: (m) => {
      if (waiting !== null) waiting.push(m)
      else queueMicrotask(() => deliver(m))
    },
  }
  const worker: IndexPort<IndexRequest, IndexReply> = {
    onmessage: null,
    postMessage: (r) => queueMicrotask(() => page.onmessage?.({ data: r } as MessageEvent)),
  }
  load().then(
    ({ serve }) => {
      serve(worker)
      const held = waiting ?? []
      waiting = null
      for (const m of held) deliver(m)
    },
    () => {
      waiting = null
      page.onerror?.(new ErrorEvent('error'))
    },
  )
  return page
}

const localPort = (): SearchPort => localPortFrom(() => import('./index.worker'))

function spawn(): SearchPort {
  if (typeof Worker !== 'function') return localPort()
  try {
    return new Worker(new URL('./index.worker.ts', import.meta.url), {
      type: 'module',
      name: 'search',
    }) as unknown as SearchPort
  } catch {
    return localPort()
  }
}

const docsOf = (docs: readonly SearchDoc[]): IndexRequest => ({
  t: 'put',
  ids: docs.map((d) => d.id),
  texts: docs.map(searchText),
  stamps: docs.map((d) => d.updatedAt),
})

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/** A question on its way: what was asked, and of which excluded notes. */
interface Asked {
  m: IndexRequest
  exclude: ReadonlySet<string>
  done(r: IndexReply | null): void
}

/**
 * A search index in a worker of its own (or on `port`). A load goes out in slices while the page
 * is idle; whatever is asked or applied meanwhile waits behind it, so it lands in order, and a
 * question hurries the rest of the load along. A worker that fails (an error, a message it
 * cannot read, a message that cannot be sent) is put down and the index starts again on
 * `fallback` (this thread): the board is loaded again (`onRestart`) and every question still
 * waiting is asked again, so search never hangs.
 */
export function createSearchIndex(
  first: SearchPort = spawn(),
  fallback: () => SearchPort = localPort,
): TimedSearchIndex {
  let port = first
  let seq = 0
  const waiting = new Map<number, Asked>()
  const times: number[] = []
  const restarts = new Set<() => void>()
  let disposed = false
  let failedOver = false
  /** The notes still to send, while a load is going out. */
  let loading: Iterator<SearchDoc> | null = null
  let hurry = false
  /** Messages held behind the load. */
  let held: IndexRequest[] = []
  /** What the worker excludes now. */
  let excluded: ReadonlySet<string> = NONE
  // One chain of slices at a time: an idle callback, or (hurried) a task.
  let idleId: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const unschedule = () => {
    if (idleId !== null) idleApi.cancelIdleCallback?.(idleId)
    if (timer !== null) clearTimeout(timer)
    idleId = null
    timer = null
  }

  const schedule = () => {
    if (timer !== null) return
    if (idleId !== null) {
      if (!hurry) return
      idleApi.cancelIdleCallback?.(idleId)
      idleId = null
    }
    if (!hurry && idleApi.requestIdleCallback && idleApi.cancelIdleCallback) {
      idleId = idleApi.requestIdleCallback(
        (d) => {
          idleId = null
          sendSlices(d)
        },
        { timeout: 500 },
      )
      return
    }
    timer = setTimeout(() => {
      timer = null
      const end = performance.now() + 4
      sendSlices({ timeRemaining: () => end - performance.now() })
    }, 0)
  }

  /** Post now; false when the port could not take it (and the index has failed over). */
  const post = (m: IndexRequest): boolean => {
    const p = port
    try {
      p.postMessage(m)
      return true
    } catch {
      fail()
      return false
    }
  }

  const send = (m: IndexRequest) => {
    if (disposed) return
    if (loading) held.push(m)
    else post(m)
  }

  const exclude = (ex: ReadonlySet<string>) => {
    if (ex === excluded) return
    const same = sameSet(ex, excluded)
    excluded = ex
    if (!same) send({ t: 'exclude', ids: [...ex] })
  }

  const wire = (p: SearchPort) => {
    p.onmessage = ({ data }) => {
      times.push(data.ms)
      if (times.length > KEEP_TIMES) times.shift()
      waiting.get(data.seq)?.done(data)
      waiting.delete(data.seq)
    }
    p.onerror = () => fail()
    p.onmessageerror = () => fail()
  }

  function fail(): void {
    if (disposed) return
    const old = port
    old.onmessage = null
    old.onerror = null
    old.onmessageerror = null
    old.terminate?.()
    old.close?.()
    unschedule()
    loading = null
    held = []
    hurry = false
    excluded = NONE
    if (failedOver) {
      // The index on this thread failed too: answer everything empty rather than wait forever.
      disposed = true
      for (const a of waiting.values()) a.done(null)
      waiting.clear()
      return
    }
    failedOver = true
    port = fallback()
    wire(port)
    for (const fn of restarts) fn()
    for (const a of waiting.values()) {
      exclude(a.exclude)
      send(a.m)
    }
    // Those questions were asked already: the fresh load goes out a slice per task, as for any
    // question asked while a load is out.
    if (loading && waiting.size > 0) {
      hurry = true
      schedule()
    }
  }

  function sendSlices(d: Idle): void {
    if (disposed || loading === null) return
    const from = loading
    for (;;) {
      const docs: SearchDoc[] = []
      let done = false
      while (docs.length < SLICE) {
        const r = from.next()
        if (r.done) {
          done = true
          break
        }
        docs.push(r.value)
      }
      if (docs.length > 0 && !post(docsOf(docs))) return
      if (done) {
        loading = null
        hurry = false
        const rest = held
        held = []
        for (const m of rest) if (!post(m)) return
        return
      }
      if (d.timeRemaining() <= 2) break
    }
    schedule()
  }

  const ask = <T>(
    build: (seq: number) => IndexRequest,
    ex: ReadonlySet<string>,
    pick: (r: IndexReply) => T,
    none: T,
  ) => {
    if (disposed) return Promise.resolve(none)
    if (loading && !hurry) {
      // A question waits behind the load: the rest goes out now, a slice per task.
      hurry = true
      schedule()
    }
    const n = ++seq
    const m = build(n)
    return new Promise<T>((resolve) => {
      waiting.set(n, { m, exclude: ex, done: (r) => resolve(r === null ? none : pick(r)) })
      exclude(ex)
      send(m)
    })
  }

  wire(port)
  return {
    times,
    load(notes) {
      if (disposed) return
      // A new load supersedes the changes held for the old one; questions still go out after it.
      held = held.filter((m) => m.t === 'query' || m.t === 'recent' || m.t === 'exclude')
      if (!post({ t: 'clear' })) return
      loading = notes[Symbol.iterator]()
      hurry = held.length > 0
      schedule()
    },
    apply({ put, removed }) {
      if (removed.length > 0) send({ t: 'remove', ids: [...removed] })
      if (put.length > 0) send(docsOf(put))
    },
    query(q, limit, ex = NONE, only) {
      const none: SearchHit[] = []
      return ask(
        (seq) => ({ t: 'query', seq, q, limit, ...(only ? { only: [...only] } : {}) }),
        ex,
        (r) => ('hits' in r ? r.hits : none),
        none,
      )
    },
    recent(limit, ex = NONE, only) {
      const none: string[] = []
      return ask(
        (seq) => ({ t: 'recent', seq, limit, ...(only ? { only: [...only] } : {}) }),
        ex,
        (r) => ('ids' in r ? r.ids : none),
        none,
      )
    },
    onRestart(fn) {
      restarts.add(fn)
      return () => {
        restarts.delete(fn)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      unschedule()
      loading = null
      held = []
      port.onmessage = null
      port.onerror = null
      port.onmessageerror = null
      port.terminate?.()
      port.close?.()
      for (const a of waiting.values()) a.done(null)
      waiting.clear()
    },
  }
}

/**
 * The notes that took `prev` to `next`: those the store says a `replace` touched (an opening's
 * slice, the hand-over: read by key, O(touched)), else found by `mapChangesWithin`, which costs
 * what changed between two versions of one board. Null when there is no telling cheaply (the store
 * said `all`, or more changed than a reload costs, or two boards that share nothing): the board
 * is loaded again.
 */
function changesOf(
  store: BoardStore,
  s: BoardState,
  before: BoardState,
  prev: ReadonlyMap<string, Note>,
): MapChanges<string> | null {
  const told = before.notes === prev ? store.touched(s, before) : undefined
  if (told === 'all') return null
  if (told === undefined) return mapChangesWithin(prev, s.notes, RELOAD_ABOVE)
  const set: string[] = []
  const deleted: string[] = []
  for (const id of told.notes) {
    if (s.notes.has(id)) set.push(id)
    else if (prev.has(id)) deleted.push(id)
  }
  return { set, deleted }
}

/**
 * Keep `index` on `store`'s board: the whole board now (in slices, when idle), then each change
 * of the board as it happens ({@link changesOf}), so a commit or an opening's slice costs what it
 * changed, never a pass over the board. Returns the detach.
 */
export function attachSearchIndex(store: BoardStore, index: SearchIndex): () => void {
  let seen = store.getState().notes
  // The index lost its worker and starts again: the board as it is now goes in again.
  const offRestart =
    index.onRestart?.(() => {
      seen = store.getState().notes
      index.load(seen.values())
    }) ?? (() => {})
  index.load(seen.values())
  const offStore = store.subscribe((s, before) => {
    const next = s.notes
    if (next === seen) return
    const prev = seen
    seen = next
    const changes = changesOf(store, s, before, prev)
    if (changes === null || changes.set.length + changes.deleted.length > RELOAD_ABOVE) {
      index.load(next.values())
      return
    }
    const { set, deleted } = changes
    const put: SearchDoc[] = []
    for (const id of set) {
      const n = next.get(id)
      const o = prev.get(id)
      if (n === undefined) continue
      if (o === undefined || o.text !== n.text || o.ref !== n.ref || o.updatedAt !== n.updatedAt)
        put.push(n)
    }
    if (put.length > 0 || deleted.length > 0) index.apply({ put, removed: deleted })
  })
  return () => {
    offRestart()
    offStore()
  }
}

const held = new WeakMap<BoardStore, { index: TimedSearchIndex; detach(): void }>()

/**
 * The search index of `store`'s board, made and attached on first use. The canvas makes it as
 * the board opens (so it is warm before ⌘K) and releases it as the board closes.
 */
export function searchIndexFor(store: BoardStore): TimedSearchIndex {
  let h = held.get(store)
  if (h === undefined) {
    const index = createSearchIndex()
    h = { index, detach: attachSearchIndex(store, index) }
    held.set(store, h)
  }
  return h.index
}

/** Stop `store`'s search index and its worker. */
export function releaseSearchIndex(store: BoardStore): void {
  const h = held.get(store)
  if (h === undefined) return
  held.delete(store)
  h.detach()
  h.index.dispose()
}
