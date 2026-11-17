import {
  applyBatch,
  asPMap,
  type BoardState,
  jsonEqual,
  mapChangesWithin,
  patchYarns,
  type Touched,
  touchedNone,
  type Yarn,
} from '@papertie/core'
import { type BoardRegion, boardMeta, loadRegion, type RegionRect } from '../api/boards'
import { type Camera, FIT_PADDING_PX, fitRect } from '../canvas/Camera'
import type { Size } from '../canvas/types'
import { UndoStack } from '../history/UndoStack'
import type { HistoryCommand } from '../interactions/keys'
import {
  type Applier,
  type BoardStore,
  type BoardTouched,
  createBoardStore,
} from '../store/boardStore'
import { attachBooks, type BookStore, createBookStore } from '../sync/books/bookStore'
import { createSyncFeed, type SyncFeed } from '../sync/feed'
import { pagePace } from '../sync/pace'
import { SyncClient } from '../sync/SyncClient'
import { createHttpTransport, type SyncTransport } from '../sync/transport'
import { installUnload, type UnloadEnv } from '../sync/unload'
import type { BoardSource } from './boardSource'
import { recallCamera } from './cameraMemory'
import { announce } from './liveRegion'
import { OPENED, type OpeningStage, type OpeningView, openBoard, openingView } from './opening'

/**
 * One open board: the store the canvas renders, its undo history, and for a server board the
 * sync client behind it.
 */
export interface BoardSession {
  store: BoardStore
  /**
   * The undo history of the board: every commit but undo and redo themselves. In memory only,
   * so a reload clears it.
   */
  undo: UndoStack
  /** Null for a local board (bench, study, e2e `proto`), which nothing saves. */
  sync: SyncClient | null
  /** The board's books held and kept; null for a local board. */
  books: BookStore | null
  /** The server board's id; null for a local board. */
  boardId: string | null
  /** The save status and notices, for the save dot and the notice slips. */
  feed: SyncFeed
  /**
   * The server repaired or restored this board when it was opened (the recovery notice). Known
   * once the opening is over ({@link opening}).
   */
  readonly recovered: boolean
  /**
   * The board is still opening: shown from its first paint while the rest comes in. Edits made
   * meanwhile are kept in order and handed to the sync client once the whole board is in.
   */
  opening: OpeningView
  /** The camera the board opened at (the one remembered); null fits its notes. */
  camera: Camera | null
  /** Stop the client and the listeners. */
  dispose(): void
}

/** What an undo announces a change without a label as. */
const UNLABELLED = 'a change'

/** An undo stack that records `store`'s commits, all but those marked `undo: 'skip'`. */
function undoFor(store: BoardStore): UndoStack {
  const undo = new UndoStack()
  store.onCommit((before, ops, o) => {
    if (o.undo !== 'skip') undo.record(before, ops, o.label || UNLABELLED, o.coalesceKey)
  })
  return undo
}

const parts = (n: number) => `${n} ${n === 1 ? 'part' : 'parts'}`

/**
 * Undo or redo one step of `session`'s board (⌘Z, ⇧⌘Z). The step is committed like any edit,
 * so a server board sends it, and is not recorded itself. It is said politely by its label
 * ("Undid tie"); when parts of it no longer apply (a note a restore took off the board), it says so
 * too. With nothing to undo or redo, nothing is said.
 */
export function stepHistory(session: BoardSession, command: HistoryCommand): void {
  const { store, undo } = session
  const step = command === 'undo' ? undo.undo(store.getState()) : undo.redo(store.getState())
  if (!step) return
  // Only ops that apply to this very board are left, and each keeps the invariants: no throw.
  store.commit(step.ops, { undo: 'skip', label: step.label })
  const verb = command === 'undo' ? 'Undid' : 'Redid'
  announce(
    step.skipped > 0
      ? `${verb} ${step.label} — ${parts(step.skipped)} no longer applied.`
      : `${verb} ${step.label}`,
  )
}

/**
 * What the canvas asks of a session's history: undo and redo steps (⌘Z, ⇧⌘Z), and the edges of
 * a writing session, which the undo stack cannot see in the commits alone.
 */
export interface CanvasHistory {
  step(command: HistoryCommand): void
  /** A writing session ended: the next commit is a step of its own, even on the same note. */
  seal(): void
  /** A new note left empty was deleted unrecorded: drop its step (`UndoStack.retract`). */
  retract(coalesceKey: string): void
}

/** `session`'s history as the canvas uses it. */
export function canvasHistory(session: BoardSession): CanvasHistory {
  return {
    step: (command) => stepHistory(session, command),
    seal: () => session.undo.seal(),
    retract: (key) => {
      session.undo.retract(key)
    },
  }
}

/** A local board: commits apply with core's `applyBatch`, and nothing is saved. */
export function openLocalSession(src: BoardSource & { kind: 'local' }): BoardSession {
  const feed = createSyncFeed()
  const store = createBoardStore(src.state)
  const undo = undoFor(store)
  return {
    store,
    undo,
    sync: null,
    books: null,
    boardId: null,
    feed,
    recovered: false,
    opening: OPENED,
    camera: null,
    dispose: () => undo.clear(),
  }
}

export interface ServerSessionOptions {
  /** The feed to report to; a new one by default. Passed in, it reports while the board loads. */
  feed?: SyncFeed
  /** Aborting gives up the open: the client stops and the promise rejects at once. */
  signal?: AbortSignal
  /** Where to open (default: the camera remembered); null fits the whole board. */
  camera?: Camera | null
  // Seams for tests; the defaults are the app's.
  transport?: SyncTransport
  /** Where blur and unload are listened for; null listens nowhere. */
  env?: UnloadEnv | null
  /** The viewport the camera is for (default: the window's). */
  viewport?: Size
  /** `GET /region` (default: the store's). */
  region?: (boardId: string, rect: RegionRect) => Promise<BoardRegion>
  /**
   * The board's note count and the rect holding its notes (default: the store's meta), asked
   * when no view of it is remembered ({@link FIT_FROM_VIEW_ABOVE}).
   */
  extent?: (boardId: string) => Promise<BoardExtent | null>
}

/** How many notes a board has, and the rect that holds them (null without notes). */
export interface BoardExtent {
  notes: number
  extent: RegionRect | null
}

/**
 * A board of more notes than this, opened with no camera remembered for it, opens at the view
 * that fits it, its first paint read from that view as any first paint is: loaded
 * whole first, the 100,000-note board showed nothing for 2.7–3.8 s. A smaller one loads whole in
 * well under a second and is fitted once in (with the app's chrome minded), as ever.
 */
export const FIT_FROM_VIEW_ABOVE = 5000

/**
 * The longest an open with no camera remembered waits for the board's meta, ms: without
 * its answer by then the board loads whole, as it did before the fitted opening. The meta is one
 * round trip in sequence before such an open (a small board's too), so a slow one costs no more
 * than this.
 */
export const META_WAIT_MS = 300

const serverExtent = (boardId: string): Promise<BoardExtent> =>
  boardMeta(boardId).then((m) => ({ notes: m.notes, extent: m.extent }))

/** The camera a board told by `told` opens at with no camera remembered for it, or null. */
export function fittedOpening(told: BoardExtent | null, viewport: Size): Camera | null {
  const e = told?.extent
  if (told === null || e == null || told.notes <= FIT_FROM_VIEW_ABOVE) return null
  // As the board fits once in: at no more than 100 %, the fit's padding to spare.
  return fitRect({ x: e.x0, y: e.y0, w: e.x1 - e.x0, h: e.y1 - e.y0 }, viewport, FIT_PADDING_PX, 1)
}

const abortError = () => new DOMException('The board session was closed.', 'AbortError')

const windowViewport = (): Size =>
  typeof window === 'undefined'
    ? { width: 1280, height: 800 }
    : { width: window.innerWidth, height: window.innerHeight }

const isoNow = () => new Date().toISOString()

type Kind = 'assets' | 'notes' | 'yarns'
/** The order the board shown is caught up in: photos before the notes that show them, notes
 * before the threads that join them. */
const KINDS: readonly Kind[] = ['assets', 'notes', 'yarns']
/** How long one slice of catching the board shown up may run, ms. */
const CONVERGE_SLICE_MS = 8
/** Records looked at, and taken, between looks at the clock. */
const CONVERGE_LOOK = 2048
const CONVERGE_TAKE = 128

/** `s` with the books and the held blocks of `v`; `s` itself when they are its already. */
function withBooksOf(s: BoardState, v: BoardState): BoardState {
  if (s.books === v.books && s.blocks === v.blocks && s.blocksHeld === v.blocksHeld) return s
  return { ...s, books: v.books, blocks: v.blocks, blocksHeld: v.blocksHeld }
}

/** One kind of record of a board, as a map of anything. */
const mapOf = (b: BoardState, k: Kind) => b[k] as ReadonlyMap<string, unknown>

/**
 * Map `k` of `b` with `writes` applied (a record set, or deleted where it is `undefined`). The
 * thread map keeps its thread index (`patchYarns`), so no catch-up indexes every thread again.
 */
function patched(b: BoardState, k: Kind, writes: ReadonlyArray<readonly [string, unknown]>) {
  if (k === 'yarns') return patchYarns(b.yarns, writes as ReadonlyArray<[string, Yarn | undefined]>)
  const t = asPMap(mapOf(b, k)).asTransient()
  for (const [id, v] of writes) {
    if (v === undefined) t.delete(id)
    else t.set(id, v)
  }
  return t.persist()
}

/**
 * Open the board `boardId`: start the client (its load of the whole board) and make the store on
 * its view. The store's commits are the client's `submit`; every change of the view that is not
 * the page's own replaces the store's board. The client flushes on window blur, and sends as the
 * page goes (`installUnload`).
 *
 * With a camera to open at (the one remembered), the board opens where it was left
 * ({@link openBoard}): the promise resolves at the first paint, with the store on the part of the
 * board that view shows, read from the store's region route. Until the whole board is in
 * (`opening`), commits apply to the store's board and the client holds them, in order
 * (`SyncClient.hold`); once the client has the board it submits them, the board shown is caught
 * up with it a slice at a time, and the store takes its view.
 *
 * Rejects with the client's start failure (a 404, say), or with an `AbortError`. A failure after
 * the first paint rejects `opening.done` instead.
 */
export async function openServerSession(
  boardId: string,
  o: ServerSessionOptions = {},
): Promise<BoardSession> {
  const { signal } = o
  if (signal?.aborted) throw abortError()
  const feed = o.feed ?? createSyncFeed()

  let store: BoardStore | null = null
  let started = false
  /** The opening is over: commits go to the client, and its view to the store. */
  let ready = false
  let disposed = false
  let books: BookStore | null = null
  /** Settles the book store's waits once the client has started (`BookStoreOptions.started`). */
  let startedBooks: () => void = () => {}
  const whenStarted = new Promise<void>((r) => {
    startedBooks = r
  })
  const client = new SyncClient({
    transport: o.transport ?? createHttpTransport(boardId),
    now: isoNow,
    // A local view is the one `submit` answers, which `store.commit` sets itself.
    onView: (view: BoardState, cause) => {
      if (ready && cause !== 'local') store?.replace(view)
      else if (cause !== 'local') syncBooks()
      feed.pending(client.pending)
      if (cause !== 'local') books?.changed(client.confirmed)
    },
    // Read whole again (an import, a restore): the open book's screen starts over.
    onBooksReset: (ids) => books?.reset(ids),
    onStatus: (s) => {
      feed.status(s)
      feed.pending(client.pending)
    },
    onNotice: (n) => feed.notice(n),
  })

  const close = () => client.stop()
  const aborted = new Promise<never>((_, reject) => {
    signal?.addEventListener('abort', () => reject(abortError()), { once: true })
  })
  aborted.catch(() => undefined)

  const viewport = o.viewport ?? windowViewport()
  let camera = o.camera !== undefined ? o.camera : recallCamera(boardId, viewport)
  if (o.camera === undefined && camera === null) {
    // No view remembered: a large board opens fitted, from that view (asked of the store's meta;
    // without an answer, or none within `META_WAIT_MS`, it loads whole).
    let timer: ReturnType<typeof setTimeout> | undefined
    const told = await Promise.race([
      (o.extent ?? serverExtent)(boardId).catch(() => null),
      aborted.catch(() => null),
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), META_WAIT_MS)
      }),
    ])
    clearTimeout(timer)
    if (signal?.aborted) {
      close()
      throw abortError()
    }
    camera = fittedOpening(told, viewport)
  }
  const region = o.region ?? ((id: string, rect: RegionRect) => loadRegion(id, rect))
  const stages = openBoard(boardId, camera, {
    viewport,
    region: (rect) => region(boardId, rect),
    start: async () => {
      await client.start()
      if (signal?.aborted) throw abortError()
      started = true
      syncBooks()
      startedBooks()
      return client.view
    },
  })
  const next = async (): Promise<OpeningStage> => {
    const r = await Promise.race([stages.next(), aborted])
    if (r.done) throw new Error('openBoard ended before the board was ready')
    return r.value
  }

  let first: OpeningStage
  try {
    first = await next()
  } catch (e) {
    close()
    void stages.return()
    throw e
  }

  const applier: Applier = (ops, c) => {
    const key = c.coalesceKey === undefined ? {} : { coalesceKey: c.coalesceKey }
    if (ready) return client.submit(ops, key)
    // Before the whole board is in: shown on the board painted, and held by the client, in order.
    const before = (store as BoardStore).getState()
    const after = applyBatch(before, ops, { now: isoNow() })
    if (after === before) return before
    client.hold(ops, key)
    feed.pending(client.pending)
    // Once the client has started, the books are its view's (they took the edit there).
    return booksSynced() ? withBooksOf(after, client.view) : after
  }

  /** Whether the board shown takes the client's books now: started, the opening not over. */
  function booksSynced(): boolean {
    return started && !ready && !disposed
  }
  /**
   * While the board opens, once the client has started: the books and the held blocks of the
   * board shown are the client's view's, so a book is written in, and shown, as the client has
   * it (the writer's page needs nothing drawn again at the hand-over).
   */
  function syncBooks(): void {
    const st = store
    if (st === null || !booksSynced()) return
    const cur = st.getState()
    const next = withBooksOf(cur, client.view)
    if (next !== cur) st.replace(next, touchedNone())
    // The board shown has the client's books now: every one.
    opening?.booksIn()
  }

  /**
   * The opening is over: the client has submitted what it held, and the store takes its view,
   * told what differs from the board shown (`touched`: {@link converge}), so nothing compares the
   * two boards. Bracketed by User Timing marks (`papertie:hand-over`).
   */
  const handOver = (touched: BoardTouched = 'all') => {
    performance.mark?.('papertie:hand-over-start')
    ready = true
    store?.replace(client.view, touched)
    feed.pending(client.pending)
    performance.mark?.('papertie:hand-over-end')
  }

  let opening: ReturnType<typeof openingView> | null = null
  let s: BoardStore
  if (first.kind === 'firstPaint') {
    s = createBoardStore(first.state, applier, isoNow)
    client.paintedAt(first.state.board.revision)
    opening = openingView(true, false)
  } else {
    // Nothing to paint before the whole board was in (no camera, or no region).
    try {
      for (let stage: OpeningStage = first; stage.kind !== 'ready'; ) stage = await next()
    } catch (e) {
      close()
      void stages.return()
      throw e
    }
    handOver()
    s = createBoardStore(client.view, applier, isoNow)
  }
  store = s
  // The board before a commit is the store's, which is the client's view (never the confirmed
  // board): an undo of an edit not yet sent works from what the user saw.
  const undo = undoFor(s)
  books = createBookStore({ client, started: whenStarted })
  const offOwnReset = feed.onOwnReset(() => books?.reset())
  attachBooks(s)
  feed.pending(client.pending)

  const env = o.env === undefined ? { window, document } : o.env
  const offUnload = env ? installUnload(client, env) : () => {}
  // Typing waits up to 3 s to send; a window losing focus may be the last chance for a while.
  const onBlur = () => void client.flush()
  env?.window.addEventListener('blur', onBlur)

  /**
   * The board shown, caught up with the client's whole board a slice at a time (each at most
   * {@link CONVERGE_SLICE_MS}, yielding between them while the page is visible), before the store
   * takes the client's view: what it lacks or has otherwise joins it (photos, then notes, then
   * threads), and what the client's lacks goes. Records equal to the
   * client's are left as they are, and so are the ones edited meanwhile (they are the client's
   * too, as edits). Answers what may still differ from the client's view now: what changed in it
   * meanwhile, and those edits; `all` if that cannot be told cheaply (the client loaded again).
   */
  const converge = async (): Promise<BoardTouched> => {
    const view = client.view
    const edited = touchedNone()
    const offCommit = s.onCommit((before) => {
      const after = s.getState()
      for (const k of KINDS) {
        const c = mapChangesWithin(mapOf(before, k), mapOf(after, k), Number.POSITIVE_INFINITY)
        for (const id of c?.set ?? []) edited[k].add(id)
        for (const id of c?.deleted ?? []) edited[k].add(id)
      }
    })
    const hidden = pagePace.hidden()
    let end = performance.now() + CONVERGE_SLICE_MS
    /** Time for a task boundary: the slice has run its course (never while the tab is hidden). */
    const pause = async () => {
      if (hidden || performance.now() < end) return
      await pagePace.yield()
      end = performance.now() + CONVERGE_SLICE_MS
    }
    try {
      for (const k of KINDS) {
        const want = mapOf(view, k)
        const take = (ids: Iterable<string>, deleting: boolean) => {
          const cur = s.getState()
          const had = mapOf(cur, k)
          const writes: Array<[string, unknown]> = []
          const touched = new Set<string>()
          for (const id of ids) {
            if (edited[k].has(id) || touched.has(id)) continue
            const v = want.get(id)
            if (deleting) {
              if (v !== undefined || !had.has(id)) continue
            } else {
              const was = had.get(id)
              if (v === undefined || was === v || (was !== undefined && jsonEqual(was, v))) continue
            }
            writes.push([id, deleting ? undefined : v])
            touched.add(id)
          }
          if (touched.size === 0) return
          const hint = { ...touchedNone(), [k]: touched } as Touched
          s.replace({ ...cur, [k]: patched(cur, k, writes) }, hint)
        }
        // The very map (the copy's read, shown as it was built): nothing to catch up.
        if (mapOf(s.getState(), k) === want) continue
        for (const deleting of [false, true]) {
          // Walked as it was when this phase began (a snapshot): the store's moves meanwhile are
          // looked at by key.
          const keys = (deleting ? mapOf(s.getState(), k) : want).keys()
          for (;;) {
            if (disposed) return 'all'
            const cur = mapOf(s.getState(), k)
            const batch: string[] = []
            let looked = 0
            let over = false
            while (batch.length < CONVERGE_TAKE && looked < CONVERGE_LOOK) {
              const r = keys.next()
              if (r.done) {
                over = true
                break
              }
              looked++
              const id = r.value
              const v = want.get(id)
              if (deleting ? v === undefined && cur.has(id) : cur.get(id) !== v) batch.push(id)
            }
            if (batch.length > 0) take(batch, deleting)
            if (over) break
            await pause()
          }
        }
      }
    } finally {
      offCommit()
    }
    // What changed in the client's view meanwhile (a remote change, the edits it was handed).
    const now = client.view
    const out = touchedNone()
    for (const k of KINDS) {
      const c = mapChangesWithin(mapOf(view, k), mapOf(now, k), 4096)
      if (c === null) return 'all'
      for (const id of [...c.set, ...c.deleted, ...edited[k]]) out[k].add(id)
    }
    return out
  }

  if (opening) {
    const view = opening
    void (async () => {
      try {
        let touched: BoardTouched = 'all'
        for (let stage = await next(); stage.kind !== 'ready'; stage = await next()) {
          if (disposed) return
          if (stage.kind === 'synced') touched = await converge()
        }
        if (disposed) return
        handOver(touched)
        performance.mark?.('papertie:ready')
        view.end()
      } catch (e) {
        if (!disposed) view.end({ e })
      }
    })()
  }

  return {
    store: s,
    undo,
    sync: client,
    books,
    boardId,
    feed,
    get recovered() {
      return client.recovered
    },
    opening: opening ?? OPENED,
    camera,
    dispose: () => {
      if (disposed) return
      disposed = true
      void stages.return()
      undo.clear()
      offOwnReset()
      books?.dispose()
      attachBooks(null)
      env?.window.removeEventListener('blur', onBlur)
      offUnload()
      close()
    },
  }
}
