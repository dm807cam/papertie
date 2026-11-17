import {
  applyBatch,
  type Block,
  type BoardState,
  type ClientOp,
  ClientOpSchema,
  commitChanges,
  digestOfHashes,
  hashPart,
  holdBook,
  holdBookSteps,
  isHeld,
  LIMITS,
  newId,
  type OpBatch,
  OpError,
  releaseBook,
  splitOps,
} from '@papertie/core'
import type { FetchedBook, LoadedBoard } from '../api/boards'
import { ApiError } from '../api/http'
import { bookOf, booksOf } from './books/bookOps'
import { mergeOps } from './mergeOps'
import { droppedMessage, rejectedMessage, resetMessage, tooLateMessage } from './notices'
import type { UnsavedParts } from './offerUnsaved'
import { type DigestPace, pagePace, slicer } from './pace'
import { backoff, verdict } from './retry'
import type { SyncEvent, SyncTransport } from './transport'
import type { CommitAck, CommitEvent, SaveStatus, StagedAck, SyncNotice } from './types'

/** Why the view changed: this page's own edit, a commit of the store's, or the board read whole. */
export type ViewCause = 'local' | 'remote' | 'reset'

export interface SyncClientOptions {
  transport: SyncTransport
  /** Now, as edits are stamped (ISO-8601 UTC); the system clock by default. */
  now?: () => string
  onView(view: BoardState, cause: ViewCause): void
  onStatus(s: SaveStatus): void
  onNotice(n: SyncNotice): void
  /**
   * The board was read whole again (an import or a restore replaced it): the books held before
   * are read again and held anew, and their screens start over (`bookStore.reset`).
   */
  onBooksReset?(bookIds: readonly string[]): void
  /** How the stage digest paces itself on the page ({@link pagePace}; tests pass their own). */
  pace?: DigestPace
}

/** What {@link SyncClient.holdBook} made of a book read: held, read too early, or gone. */
export type HoldResult = 'held' | 'stale' | 'gone'

/** A coalescing batch (text typing) sends this long after its last merge… */
export const COALESCE_IDLE_MS = 600
/** …and never later than this after it opened. */
export const COALESCE_MAX_MS = 3000
/** Staged parts (ADR-0005): each request at most 1 MiB and 500 ops, at most 64 parts. */
const PART_BYTES = 1_048_576
const MAX_PARTS = 64
/** An acked commit whose stream event has not come by then is fetched with `since`. */
const ACK_WATCH_MS = 2000
/** A failure that trying again soon will not fix: looked at again this late. */
const HALT_MS = 30_000
/** A book read this long or longer is held a slice at a time (20–40 ms in one go on a Mac). */
export const SLICED_HOLD = 2048

type Timer = ReturnType<typeof setTimeout>

/** One edit waiting to be saved: in the view from the moment it is made. */
interface Pending {
  ops: ClientOp[]
  /** Its number under this page's id, given as it is first sent; 0 until then. */
  seq: number
  /** Batches with the same key merge while unsent (text typing); null sends at once. */
  coalesceKey: string | null
  /** While it may still take merges: when it opened and last grew (local ms). */
  open: { first: number; last: number } | null
  /** A request for it is out: only the store can decide it now. */
  inFlight: boolean
  /** The store answered that it is committed; it leaves once the confirmed board holds it. */
  acked: boolean
}

/** Whether `op` only puts a deleted book back. */
const putsBack = (op: ClientOp) =>
  op.op === 'book.update' && op.set.trashedAt === null && Object.keys(op.set).length === 1

const systemNow = () => new Date().toISOString()

/**
 * The page's side of the store (ADR-0005). `confirmed` is the store's board, built from its
 * commits exactly as the store builds it (`commitChanges`); `view` is `confirmed` with this
 * page's edits not yet committed on top, and is what the page shows.
 *
 * There is one page and one store, on the same machine. The page is the only one to send edits;
 * the store also commits on its own (a photo taken in or swept, a deleted book purged), and
 * replaces the board whole on an import or a restore. So:
 *
 * - `submit` is synchronous: it applies the ops to `view` and queues them. Typing merges into the
 *   newest unsent edit.
 * - Edits are sent one at a time, oldest first, each against the confirmed board, and the next
 *   goes once the one before is in it. Nothing is ever rebased.
 * - The store's commits arrive on its event stream, in order; every change of `confirmed` runs on
 *   one serial chain.
 * - Edits not yet sent live in this page's memory only.
 */
export class SyncClient {
  private readonly o: SyncClientOptions
  private readonly now: () => string
  /** This page's id with the store: its commits are told from the store's own by it. */
  readonly clientId = newId('tab')
  private seq = 0
  private _confirmed: BoardState | null = null
  private _view: BoardState | null = null
  private queue: Pending[] = []
  /** Edits made before `start` has the board ({@link hold}), in order. */
  private held: Array<{ ops: ClientOp[]; coalesceKey: string | null }> = []
  /** The revision of the board the held edits were made on (the first paint's), once told. */
  private heldAt: number | null = null
  /** Held edits sent as the page went, before the board was in ({@link keepaliveBatch}). */
  private parting: { seq: number; ops: ClientOp[] } | null = null
  /** Edits the board would not take: kept for the unsaved-changes download. */
  private dropped: ClientOp[][] = []

  private chain: Promise<void> = Promise.resolve()
  private pumping: Promise<void> | null = null
  private sendTimer: Timer | null = null
  private ackTimer: Timer | null = null
  private failures = 0
  private retryAt = 0
  private unreachable = false
  private halted = false
  private _recovered = false
  private closeEvents: (() => void) | null = null
  private status: SaveStatus = 'saved'
  private started = false
  private stopped = false
  private streamDown = false
  private readonly ups = new Set<() => void>()
  /** Told each time the queue may have emptied or stalled ({@link flush}). */
  private settled: Array<() => void> = []

  constructor(o: SyncClientOptions) {
    this.o = o
    this.now = o.now ?? systemNow
  }

  get view(): BoardState {
    if (!this._view) throw new Error('SyncClient: start() has not finished')
    return this._view
  }

  get confirmed(): BoardState {
    if (!this._confirmed) throw new Error('SyncClient: start() has not finished')
    return this._confirmed
  }

  /** The store repaired or restored the board the last time it was read (`X-Papertie-Recovered`). */
  get recovered(): boolean {
    return this._recovered
  }

  /** Edits the store has not committed yet: what only this page holds. */
  get pending(): number {
    return this.held.length + this.queue.length
  }

  get boardId(): string {
    return this.o.transport.boardId
  }

  /**
   * Read the board (trying again while the store is not there yet), apply the edits made
   * meanwhile, open the event stream and send. Rejects only on a failure trying again cannot fix
   * (a 404, say).
   */
  async start(): Promise<void> {
    if (this.started || this.stopped) return
    const loaded = await this.load()
    if (!loaded || this.stopped) return
    this._confirmed = loaded.state
    this._view = loaded.state
    this._recovered = loaded.recovered
    this.started = true
    const held = this.held
    this.held = []
    // Sent as the page went, and the page stayed after all: if the board read does not hold them
    // (its mark of this page), they are submitted as any held edit is.
    const parting = this.parting
    this.parting = null
    if (parting) {
      const landed = loaded.state.board.clients?.[this.clientId]?.lastSeq ?? 0
      if (landed < parting.seq) held.unshift({ ops: parting.ops, coalesceKey: null })
    }
    const lost: ClientOp[][] = []
    for (const h of held) {
      try {
        this.queueOps(h.ops, h.coalesceKey)
      } catch (e) {
        if (!(e instanceof OpError)) throw e
        lost.push(h.ops)
      }
    }
    this.drop(lost, 'dropped')
    this.o.onView(this.view, 'reset')
    this.updateStatus()
    this.closeEvents = this.o.transport.events(loaded.revision, (e) => this.onEvent(e))
    this.kick()
  }

  /** The whole board, tried again while the store cannot be reached; null once stopped. */
  private async load(): Promise<LoadedBoard | null> {
    for (;;) {
      try {
        const loaded = await this.o.transport.load()
        this.reachable()
        return loaded
      } catch (e) {
        if (this.stopped) return null
        const v = verdict(e)
        if (v !== 'retry' && v !== 'busy') throw e
        this.setUnreachable(true)
        await new Promise<void>((r) => setTimeout(r, backoff(this.failures++)))
        if (this.stopped) return null
      }
    }
  }

  /**
   * The board the page shows while this client starts was read at `revision` (its first paint):
   * edits held meanwhile were made on it, and can go against it should the page leave first.
   */
  paintedAt(revision: number): void {
    this.heldAt = revision
  }

  /**
   * Keep an edit made while the board opens (the page shows it on what it has painted): held in
   * order, counted as unsaved, and submitted once `start` has the board.
   */
  hold(ops: readonly ClientOp[], o: { coalesceKey?: string } = {}): void {
    if (this.started) {
      this.submit(ops, o)
      return
    }
    if (ops.length === 0) return
    const key = o.coalesceKey ?? null
    const last = this.held.at(-1)
    if (last && key !== null && last.coalesceKey === key) last.ops = mergeOps(last.ops, ops)
    else this.held.push({ ops: [...ops], coalesceKey: key })
    this.updateStatus()
  }

  /**
   * Apply `ops` to the view and queue them to be saved; answers the view. Throws as `applyBatch`
   * does (an `OpError`), and then nothing is queued.
   */
  submit(ops: readonly ClientOp[], o: { coalesceKey?: string } = {}): BoardState {
    const view = this.view
    if (ops.length === 0) return view
    const next = this.queueOps(ops, o.coalesceKey ?? null)
    if (next === view) return view
    this.o.onView(next, 'local')
    this.updateStatus()
    this.kick()
    return next
  }

  /** `ops` applied to the view and queued (merged into the newest edit, while that takes them). */
  private queueOps(ops: readonly ClientOp[], key: string | null): BoardState {
    const view = this.view
    const next = applyBatch(view, ops, { now: this.now() })
    if (next === view) return view
    const last = this.queue.at(-1)
    const now = Date.now()
    if (last?.open && key !== null && last.coalesceKey === key) {
      last.ops = mergeOps(last.ops, ops)
      last.open.last = now
    } else {
      // An edit takes merges only while it is the newest: the one before is sealed.
      if (last) last.open = null
      this.queue.push({
        ops: [...ops],
        seq: 0,
        coalesceKey: key,
        open: key === null ? null : { first: now, last: now },
        inFlight: false,
        acked: false,
      })
    }
    this._view = next
    return next
  }

  /**
   * Send everything now, typing included (blur, the page going, an export or an import about to
   * read the board). Resolves once every edit is committed, or the store cannot take them now.
   */
  async flush(): Promise<void> {
    if (!this.started || this.stopped) return
    const last = this.queue.at(-1)
    if (last) last.open = null
    this.retryAt = 0
    this.kick()
    while (this.queue.length > 0 && !this.stopped && !this.unreachable && !this.halted) {
      await new Promise<void>((r) => this.settled.push(r))
    }
  }

  /**
   * What the `.md` of the unsaved-changes download is made of (`offerUnsaved`): the view, the
   * edits it shows (pending, held), and those it does not (dropped).
   */
  unsavedParts(): UnsavedParts {
    return {
      view: this._view,
      pending: [...this.queue.map((b) => b.ops), ...this.held.map((h) => h.ops)],
      dropped: this.dropped,
    }
  }

  /** Pending and dropped ops, one JSON line `{"op":…}` each: the unsaved-changes download. */
  unsavedJsonl(): string {
    const lists = [...this.dropped, ...this.queue.map((b) => b.ops), ...this.held.map((h) => h.ops)]
    return lists
      .flat()
      .map((op) => `${JSON.stringify(op)}\n`)
      .join('')
  }

  /**
   * Every edit not yet sent, as one request body under `maxBytes` (as UTF-8 JSON), for a last
   * send as the page goes away (`installUnload`): one commit, so the edits land together or not
   * at all. Null when there is none, when the oldest is with the store already, or when they are
   * more than one request carries.
   */
  keepaliveBatch(maxBytes = Number.POSITIVE_INFINITY): OpBatch | null {
    if (this.stopped || this.halted) return null
    if (!this.started) return this.partingBatch(maxBytes)
    const first = this.queue[0]
    if (!first || first.inFlight || first.acked) return null
    // One the store was sent before goes again as it was (the store may hold it under its
    // number); else every edit goes together.
    const ops = first.seq !== 0 ? first.ops : this.queue.flatMap((b) => b.ops)
    if (ops.length > LIMITS.maxOpsPerBatch) return null
    const seq = first.seq || this.seq + 1
    const body = { clientId: this.clientId, seq, baseRevision: this.confirmed.board.revision, ops }
    if (new TextEncoder().encode(JSON.stringify(body)).length >= maxBytes) return null
    // They may reach the store now: one edit from here on, which never grows again.
    this.seq = Math.max(this.seq, seq)
    if (first.seq === 0) this.queue = [first]
    first.seq = seq
    first.ops = ops
    first.open = null
    first.inFlight = true
    return body
  }

  /**
   * The edits held while the board opens, as one request against the board they were made on
   * (they are on notes and threads: no book is held before the start, so none is on a book).
   */
  private partingBatch(maxBytes: number): OpBatch | null {
    if (this.heldAt === null || this.held.length === 0 || this.parting !== null) return null
    const ops = this.held.flatMap((h) => h.ops)
    if (ops.length > LIMITS.maxOpsPerBatch) return null
    const seq = ++this.seq
    const body = { clientId: this.clientId, seq, baseRevision: this.heldAt, ops }
    if (new TextEncoder().encode(JSON.stringify(body)).length >= maxBytes) {
      this.seq--
      return null
    }
    this.parting = { seq, ops }
    this.held = []
    return body
  }

  /** Close the stream and stop sending. */
  stop(): void {
    this.stopped = true
    this.closeEvents?.()
    this.closeEvents = null
    if (this.sendTimer) clearTimeout(this.sendTimer)
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.sendTimer = null
    this.ackTimer = null
    this.wakeSettled()
  }

  // ---- the confirmed board ------------------------------------------------------------------

  /** Run `task` after every earlier change of the confirmed board; a failure reads it whole. */
  private enqueue<T>(task: () => Promise<T> | T): Promise<T | undefined> {
    const run = this.chain.then(async () => {
      if (this.stopped) return undefined
      return task()
    })
    this.chain = run.then(
      () => undefined,
      () => (this.stopped ? undefined : this.reload('remote').catch(() => undefined)),
    )
    return run.catch(() => undefined)
  }

  private onEvent(e: SyncEvent): void {
    if (this.stopped) return
    if (e.type === 'down') {
      this.streamDown = true
      return
    }
    if (this.streamDown) {
      this.streamDown = false
      for (const fn of this.ups) fn()
    }
    if (e.type === 'commit') void this.enqueue(() => this.take([e.event]))
    else if (e.type === 'reset') void this.enqueue(() => this.reload('reset', e.revision))
    else if (e.type === 'hello') {
      void this.enqueue(() => (e.revision > this.confirmed.board.revision ? this.catchUp() : null))
    }
  }

  /**
   * The store's `commits`, in order, on the confirmed board: each as the store applied it. This
   * page's own leave the queue as they come. A gap is caught up; one that cannot be applied means
   * the two boards differ, and the board is read whole.
   */
  private async take(commits: readonly CommitEvent[]): Promise<void> {
    let state = this.confirmed
    for (const e of commits) {
      const have = state.board.revision
      if (e.revision <= have) continue
      if (e.revision !== have + 1) {
        this.adopt(state, 'remote')
        return this.catchUp()
      }
      const mark =
        e.originClientId !== null && e.seq !== null
          ? { clientId: e.originClientId, seq: e.seq }
          : null
      state = commitChanges(state, e.ops, e.now, mark).state
      if (e.originClientId === this.clientId) {
        const first = this.queue[0]
        if (first && first.seq !== 0 && first.seq <= (e.seq ?? 0)) this.queue.shift()
      }
    }
    if (state !== this.confirmed) this.adopt(state, 'remote')
  }

  /** What the stream has not told since the confirmed board's revision, asked for and taken. */
  private async catchUp(): Promise<void> {
    const r = await this.o.transport.since(this.confirmed.board.revision)
    if (this.stopped) return
    this.reachable()
    if ('full' in r) return this.reload('remote')
    await this.take(r.commits)
  }

  /**
   * Read the board whole again (an import or a restore replaced it, or the two boards differ). It
   * holds no book: those held before are read again (`onBooksReset`). An edit with the store
   * leaves the queue if the board read holds it (its mark); the rest are applied on top.
   */
  private async reload(cause: 'remote' | 'reset', revision?: number): Promise<void> {
    const loaded = await this.load()
    if (!loaded || this.stopped) return
    const was = this.confirmed.blocksHeld
    const held = was === 'all' ? [] : [...was]
    const landed = loaded.state.board.clients?.[this.clientId]?.lastSeq ?? 0
    this.queue = this.queue.filter((b) => b.seq === 0 || b.seq > landed)
    for (const b of this.queue) {
      b.inFlight = false
      b.acked = false
    }
    this._recovered = loaded.recovered
    this.adopt(loaded.state, 'reset')
    if (held.length > 0) this.o.onBooksReset?.(held)
    if (cause === 'reset') {
      // Said with its revision: the feed drops the one this page asked for itself (an import, a
      // restore: `ownReset`).
      this.o.onNotice({
        kind: 'reset',
        count: 0,
        message: resetMessage(),
        server: true,
        ...(revision === undefined ? {} : { revision }),
      })
    }
  }

  /**
   * `state` is the confirmed board: the view is it with the queue on top. An edit that no longer
   * applies (the store swept the photo it shows, say) is dropped, kept for the download, and said.
   */
  private adopt(state: BoardState, cause: 'remote' | 'reset'): void {
    this._confirmed = state
    let view = state
    const lost: Pending[] = []
    for (const b of this.queue) {
      try {
        view = applyBatch(view, b.ops, { now: this.now() })
      } catch (e) {
        if (!(e instanceof OpError)) throw e
        lost.push(b)
      }
    }
    if (lost.length > 0) {
      // One with the store stays until the store has decided it.
      const gone = lost.filter((b) => !b.inFlight && !b.acked)
      this.queue = this.queue.filter((b) => !gone.includes(b))
      this.drop(
        gone.map((b) => b.ops),
        'dropped',
      )
    }
    this._view = view
    this.o.onView(view, cause)
    this.updateStatus()
    this.kick()
  }

  // ---- sending ------------------------------------------------------------------------------

  private kick(): void {
    if (this.pumping || !this.started || this.stopped) return
    this.pumping = this.pump()
  }

  /** Send the oldest edit, once it is due and the one before is in the confirmed board. */
  private async pump(): Promise<void> {
    await null // let `kick` store this run before it looks at anything
    try {
      for (;;) {
        if (this.stopped) return
        const b = this.queue[0]
        if (!b) {
          this.failures = 0
          this.retryAt = 0
          return
        }
        // With the store, or committed and its commit on its way: what settles it kicks again.
        if (b.inFlight || b.acked) return
        const wait = Math.max(this.retryAt, this.dueAt(b)) - Date.now()
        if (wait > 0) {
          this.wake(wait)
          return
        }
        await this.send(b)
      }
    } finally {
      this.pumping = null
      this.wakeSettled()
    }
  }

  /** When an open coalescing edit is due: it waits only while it is the newest. */
  private dueAt(b: Pending): number {
    if (!b.open || b !== this.queue.at(-1)) return 0
    return Math.min(b.open.last + COALESCE_IDLE_MS, b.open.first + COALESCE_MAX_MS)
  }

  private wake(ms: number): void {
    if (this.stopped) return
    if (this.sendTimer) clearTimeout(this.sendTimer)
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null
      this.kick()
    }, ms)
  }

  /** One attempt at `b`; the pump tries again until the store has decided it. */
  private async send(b: Pending): Promise<void> {
    b.open = null // an edit that may have reached the store never grows again
    let parts: ClientOp[][]
    if (b.seq === 0) {
      parts = splitOps(b.ops, PART_BYTES, LIMITS.maxOpsPerBatch) as ClientOp[][]
      // More than one stage carries (⌘A and Delete in a very long book): consecutive edits.
      if (parts.length > MAX_PARTS) {
        const rest: Pending = { ...b, ops: parts.slice(MAX_PARTS).flat() }
        parts = parts.slice(0, MAX_PARTS)
        b.ops = parts.flat()
        this.queue.splice(this.queue.indexOf(b) + 1, 0, rest)
      }
      b.seq = ++this.seq
    } else parts = splitOps(b.ops, PART_BYTES, LIMITS.maxOpsPerBatch) as ClientOp[][]
    b.inFlight = true
    let ack: CommitAck | null = null
    let error: unknown = null
    try {
      ack = await this.post(b, parts)
    } catch (e) {
      error = e
    } finally {
      b.inFlight = false
    }
    if (this.stopped) return
    if (ack) this.onAck(b, ack)
    else await this.onSendError(b, error)
  }

  /** POST `b`: as it is, or as staged parts when it is over 1 MiB or 500 ops. */
  private async post(b: Pending, parts: ClientOp[][]): Promise<CommitAck> {
    const head = {
      clientId: this.clientId,
      seq: b.seq,
      baseRevision: this.confirmed.board.revision,
    }
    const count = parts.length
    if (count === 1) {
      const answer: CommitAck | StagedAck = await this.o.transport.send({ ...head, ops: b.ops })
      if ('staged' in answer) throw new ApiError(202, 'bad-response')
      return answer
    }
    // Every part names the edit's content, so the store never completes a stage with other parts.
    const digest = await this.digestOf(parts)
    for (let index = 0; index < count; index++) {
      const answer: CommitAck | StagedAck = await this.o.transport.send({
        ...head,
        ops: parts[index] as ClientOp[],
        part: { index, count, digest },
      })
      // The last part's answer is the commit; a seq the store already has is answered at once.
      if (!('staged' in answer)) return answer
    }
    throw new ApiError(202, 'bad-response')
  }

  /**
   * A staged edit's content digest (core's `digestOfHashes`), hashed a step at a time; while the
   * page is visible each step waits for a task from the pace, and once it is hidden the rest goes
   * at once (there are no frames to keep).
   */
  private async digestOf(parts: readonly (readonly ClientOp[])[]): Promise<string> {
    const pace = this.o.pace ?? pagePace
    const hashes: string[] = []
    for (const part of parts) {
      const steps = hashPart(part)
      for (;;) {
        if (!pace.hidden()) await pace.yield()
        const r = steps.next()
        if (r.done) {
          hashes.push(r.value)
          break
        }
      }
    }
    return digestOfHashes(hashes)
  }

  private onAck(b: Pending, ack: CommitAck): void {
    this.reachable()
    this.failures = 0
    if (!this.queue.includes(b)) return
    if (ack.revision <= this.confirmed.board.revision) {
      // Its commit came before its answer: it left the queue with it, unless the answer is of a
      // commit the stream told before this page knew the edit's number (a last send as a page
      // went). Either way the confirmed board holds it.
      this.queue = this.queue.filter((x) => x !== b)
      this.adopt(this.confirmed, 'remote')
      return
    }
    b.acked = true
    // Its commit is on the stream; should it not come, it is asked for.
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null
      if (this.queue.some((x) => x.acked)) void this.enqueue(() => this.catchUp())
    }, ACK_WATCH_MS)
    this.updateStatus()
  }

  private async onSendError(b: Pending, e: unknown): Promise<void> {
    switch (verdict(e)) {
      case 'retry':
        this.setUnreachable(true)
        this.backOff()
        return
      case 'busy':
        this.backOff()
        return
      case 'reject':
        this.reject(b)
        return
      case 'invalid':
        // The store's schema refused it. If it fails here too it can never be accepted;
        // otherwise the body was mangled on the way, so it is sent again.
        if (b.ops.some((op) => !ClientOpSchema.safeParse(op).success)) this.reject(b)
        else this.halt()
        return
      case 'reload':
        await this.enqueue(() => this.reload('remote'))
        this.backOff()
        return
      case 'stale':
        // Sent against a board behind the store's: caught up, and sent again.
        await this.enqueue(() => this.catchUp())
        this.backOff()
        return
      default:
        this.halt()
    }
  }

  /** `Couldn't save`: keep the edit and look again later. */
  private halt(): void {
    this.halted = true
    this.retryAt = Date.now() + HALT_MS
    this.updateStatus()
  }

  private backOff(): void {
    this.retryAt = Date.now() + backoff(this.failures++)
  }

  /** The store refused `b` for good: drop it, keep its ops for the download, say so. */
  private reject(b: Pending): void {
    if (!this.queue.includes(b)) return
    this.queue = this.queue.filter((x) => x !== b)
    // A book put back past its 30 days (the store purges it then): too late, said so; a put
    // back holds no words to keep.
    if (b.ops.every(putsBack)) {
      // What was written in those books behind it was written in a book that stays deleted, and
      // the purge takes: refused with it, offered as other refused writing is.
      const ids = new Set(b.ops.map((op) => (op as { id: string }).id))
      const onThem = (op: ClientOp) =>
        op.op === 'book.update' ? ids.has(op.id) : ids.has(bookOf(op) ?? '')
      const behind = this.queue.filter((x) => !x.inFlight && !x.acked && x.ops.some(onThem))
      this.queue = this.queue.filter((x) => !behind.includes(x))
      this.o.onNotice({ kind: 'limit', count: 0, message: tooLateMessage() })
      this.drop(
        behind.map((x) => x.ops),
        'rejected',
      )
    } else this.drop([b.ops], 'rejected')
    this.adopt(this.confirmed, 'remote')
  }

  /**
   * Ops the board would not take (a paragraph that is gone, `OpError` `not-found`): kept as
   * unsaved text and said, as an edit the store refused is.
   */
  refuse(ops: readonly ClientOp[]): void {
    this.drop([[...ops]], 'rejected')
  }

  private drop(lists: readonly ClientOp[][], kind: 'dropped' | 'rejected'): void {
    if (lists.length === 0) return
    this.dropped.push(...lists)
    const message = (kind === 'dropped' ? droppedMessage : rejectedMessage)(lists.length)
    this.o.onNotice({ kind, count: lists.length, message })
  }

  // ---- books: their paragraphs are held while they are open -------------------------------

  /**
   * Hold `bookId` with `blocks`, its paragraphs as the book route read them at revision `at`,
   * once the confirmed board is there. `stale`: the book changed after `at` (read it again);
   * `gone`: there is no such book.
   */
  async holdBook(bookId: string, blocks: readonly Block[], at: number): Promise<HoldResult> {
    const held = await this.enqueue(async (): Promise<HoldResult> => {
      if (!this.started) return 'stale'
      if (at > this.confirmed.board.revision) await this.catchUp()
      const state = this.confirmed
      const book = state.books.get(bookId)
      if (!book) return 'gone'
      if (isHeld(state, bookId)) return 'held'
      if (at > state.board.revision || (book.rev ?? 0) > at) return 'stale'
      this.adopt(await this.holding(state, bookId, blocks), 'remote')
      return 'held'
    })
    return held ?? 'gone'
  }

  /** `state` holding `bookId` with `blocks`: a long book in 4 ms slices. */
  private async holding(
    state: BoardState,
    bookId: string,
    blocks: readonly Block[],
  ): Promise<BoardState> {
    if (blocks.length < SLICED_HOLD) return holdBook(state, bookId, blocks)
    const pause = slicer()
    const steps = holdBookSteps(state, bookId, blocks)
    for (;;) {
      const r = steps.next()
      if (r.done) return r.value
      await pause()
    }
  }

  /** Let go of `bookId`'s paragraphs (its screen closed): not while edits on it wait. */
  releaseBook(bookId: string): void {
    void this.enqueue(() => {
      const state = this.confirmed
      if (state.blocksHeld === 'all' || !state.blocksHeld.has(bookId)) return
      if (this.hasPendingOn(bookId)) return
      this.adopt(releaseBook(state, bookId), 'remote')
    })
  }

  /** Whether `bookId` has edits of this page the store has not committed yet. */
  hasPendingOn(bookId: string): boolean {
    return this.queue.some((b) => booksOf(b.ops).has(bookId))
  }

  /** Read a book from the store (`GET /books/:bookId`); null when it is gone. */
  fetchBook(bookId: string): Promise<FetchedBook | null> {
    return this.o.transport.book(bookId)
  }

  /** Tell `fn` each time the event stream opens again. Returns the undo. */
  onStreamUp(fn: () => void): () => void {
    this.ups.add(fn)
    return () => {
      this.ups.delete(fn)
    }
  }

  // ---- status -------------------------------------------------------------------------------

  private reachable(): void {
    const was = this.unreachable || this.halted
    this.unreachable = false
    this.halted = false
    if (!was) return
    this.failures = 0
    this.retryAt = 0
    this.updateStatus()
    this.kick()
  }

  private setUnreachable(v: boolean): void {
    if (this.unreachable === v) return
    this.unreachable = v
    this.updateStatus()
  }

  private updateStatus(): void {
    this.wakeSettled()
    const s: SaveStatus =
      this.pending === 0 ? 'saved' : this.halted ? 'error' : this.unreachable ? 'offline' : 'saving'
    if (s === this.status || this.stopped) return
    this.status = s
    this.o.onStatus(s)
  }

  private wakeSettled(): void {
    const waiting = this.settled
    this.settled = []
    for (const r of waiting) r()
  }
}
