/**
 * An in-memory board server for sync tests, built on core `commitSteps` exactly as
 * `apps/server` builds commits. It reproduces what the client can observe of
 * `POST /api/boards/:id/ops`, `GET /ops?since` and the event stream:
 *
 * - client marks: a `seq` at or below the tab's `lastSeq` answers the stored duplicate ack;
 * - one request in flight per `clientId` (`409 client-busy`), a mark-less tab id older than the
 *   mark TTL (`409 client-expired`), a `baseRevision` above the board's (`409 revision-ahead`);
 * - a rejected batch is `422 rejected {code, index}`; a body over 1 MiB is `413`, a schema failure `400`;
 * - staged parts (ADR-0005): the parts of one `(clientId, seq)` wait until all `count` arrived, then
 *   commit as one revision; a different `count` or `baseRevision` is `409 stage-mismatch`;
 * - a ring of the last 512 commits (the real ring is also capped at 16 MiB, which these tests never
 *   reach) answering `since`, or `{full: true}` when it cannot reach back;
 * - streams: `hello` for a new stream, a replay (or `reset`) for a resumed one, then live commits.
 *
 * Bodies and events cross a JSON "wire" so no object is shared between client and server.
 */
import {
  type Block,
  type BoardState,
  batchDigest,
  bookBlocks,
  CLIENT_MARK_TTL_MS,
  type ClientMark,
  type ClientOp,
  cardStamps,
  commitSteps,
  emptyBoardState,
  type Note,
  namesOf,
  type Op,
  type OpBatch,
  OpBatchSchema,
  OpError,
  PMap,
  threadsOf,
} from '@papertie/core'
import { vi } from 'vitest'

/** A step generator run to its end. */
function drainSteps<R>(steps: Generator<void, R>): R {
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

import type { FetchedBook, LoadedBoard, OpsSince } from '../../src/api/boards'
import { ApiError } from '../../src/api/http'
import type { DigestPace } from '../../src/sync/pace'
import { SyncClient, type ViewCause } from '../../src/sync/SyncClient'
import type { SyncEvent, SyncTransport } from '../../src/sync/transport'
import type {
  CommitAck,
  CommitEvent,
  SaveStatus,
  StagedAck,
  StagedPart,
  SyncNotice,
} from '../../src/sync/types'

export const BOARD_ID = `board_${'0'.repeat(25)}1`
export const T0 = '2026-10-30T09:00:00.000Z'

const RING_COMMITS = 512
const BODY_BYTES = 1_048_576
const MAX_PARTS = 64

/** A schema-valid id: `n` in the 26-char tail. */
export const idOf = (prefix: 'note' | 'yarn' | 'tab' | 'book' | 'block', n: number) =>
  `${prefix}_${String(n).padStart(26, '0')}`

export function note(id: string, over: Partial<Note> = {}): Note {
  return {
    type: 'note',
    id,
    x: 0,
    y: 0,
    w: 200,
    h: 120,
    z: 1,
    paper: 'cream',
    style: 'rustic',
    text: '',
    image: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

/** The error the HTTP layer makes of a server error answer. */
export const apiError = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  retryAfterMs: number | null = null,
) => new ApiError(status, code, retryAfterMs, { ...extra, error: code })

const networkError = () => new ApiError(0, 'network')

/** A deleted book is purged (and no longer put back) once deleted this long (`BOOK_TRASH_MS`). */
const TRASH_MS = 30 * 86_400_000

/**
 * `ops` with every deletion of a book dated `now` (the server's `stampTrashed`): the purge reads
 * the board's clock, never a client's. A book deleted already keeps its date (as the batch has
 * left it so far). A put back of a book past its window is refused (`checkTrash`).
 */
function stampTrashed(state: BoardState, ops: readonly ClientOp[], now: string): ClientOp[] {
  for (const op of ops) {
    if (op.op !== 'book.update' || op.set.trashedAt !== null) continue
    const at = state.books.get(op.id)?.trashedAt
    if (at != null && Date.parse(now) - Date.parse(at) > TRASH_MS) {
      throw new OpError('conflict', `book ${op.id} is past its trash window`)
    }
  }
  // As the batch has left each book so far: one put back earlier in it is deleted afresh.
  const set = new Map<string, string | null>()
  return ops.map((op) => {
    if (op.op !== 'book.update' || op.set.trashedAt === undefined) return op
    if (op.set.trashedAt === null) {
      set.set(op.id, null)
      return op
    }
    const at = (set.has(op.id) ? set.get(op.id) : state.books.get(op.id)?.trashedAt) ?? now
    set.set(op.id, at)
    return op.set.trashedAt === at ? op : { ...op, set: { ...op.set, trashedAt: at } }
  })
}

/** Through JSON and back, as a request or a frame is. */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Milliseconds in an id's ULID time part (as the server's `ulidTimeMs`). */
function ulidTimeMs(id: string): number {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const at = id.indexOf('_')
  let ms = 0
  for (const ch of id.slice(at + 1, at + 11)) ms = ms * 32 + alphabet.indexOf(ch)
  return ms
}

interface Stage {
  count: number
  baseRevision: number
  /** The batch's content digest. */
  digest: string
  parts: Map<number, ClientOp[]>
}

export class FakeServer {
  state: BoardState
  /** Every commit ever made, in order (the ring keeps only the last 512). */
  readonly log: CommitEvent[] = []
  private ring: CommitEvent[] = []
  private readonly inFlight = new Set<string>()
  private readonly stages = new Map<string, Stage>()
  private readonly listeners = new Set<(e: SyncEvent) => void>()
  /** The board was repaired or restored and the notice is not dismissed (`X-Papertie-Recovered`). */
  recovered = false
  /** Tab ids {@link expireClient} put past the mark TTL, whatever their ULID time says. */
  private readonly expired = new Set<string>()
  /** The revision the board was last replaced at (a restore): the store's `replacedAt`. */
  private replacedAt = 0
  /** Requests for a book (`GET /books/:bookId`), by id. */
  readonly bookAsked: string[] = []

  constructor(state: BoardState = emptyBoardState(BOARD_ID, 'Test board', T0)) {
    this.state = state
  }

  get revision(): number {
    return this.state.board.revision
  }

  now(): string {
    return new Date().toISOString()
  }

  /**
   * The board as a whole read serves it: without blocks (ADR-0001), so it holds no book; a board
   * without books holds them all (the client's `withoutBlocks`).
   */
  get served(): BoardState {
    const { state } = this
    return state.books.size === 0
      ? state
      : { ...state, blocks: PMap.from(), blocksHeld: new Set<string>() }
  }

  /** `GET /books/:bookId`: the book and its blocks in `(pos, id)` order, of one revision. */
  book(bookId: string): FetchedBook | null {
    this.bookAsked.push(bookId)
    const book = this.state.books.get(bookId)
    if (!book) return null
    const blocks: Block[] = bookBlocks(this.state.blocks, bookId).chunks.flat()
    return { revision: this.revision, book, blocks }
  }

  load(): LoadedBoard {
    return {
      state: this.served,
      revision: this.revision,
      serverNow: this.now(),
      serverNowKnown: true,
      recovered: this.recovered,
    }
  }

  since(rev: number): OpsSince {
    const revision = this.revision
    const commits = Number.isSafeInteger(rev) && rev >= 0 ? this.ringSince(rev, revision) : null
    return commits ? { revision, commits } : { revision, full: true }
  }

  /** The ring forgets every commit so far (a restart): `since` reaches back to none of them. */
  forgetRing(): void {
    this.ring = []
  }

  /** `POST /api/boards/:id/ops`. Failures throw the `ApiError` the client's HTTP layer would. */
  async post(body: OpBatch | StagedPart): Promise<CommitAck | StagedAck> {
    if (new TextEncoder().encode(JSON.stringify(body)).length > BODY_BYTES) {
      throw apiError(413, 'too-large')
    }
    const { part, ...batch } = body as OpBatch & { part?: StagedPart['part'] }
    const parsed = OpBatchSchema.safeParse(batch)
    if (!parsed.success) throw apiError(400, 'invalid')
    if (part === undefined) return this.submit(parsed.data)
    const { index, count, digest } = part
    if (
      typeof digest !== 'string' ||
      !/^[0-9a-f]{32}$/.test(digest) ||
      !Number.isInteger(index) ||
      !Number.isInteger(count) ||
      count < 2 ||
      count > MAX_PARTS ||
      index < 0 ||
      index >= count
    ) {
      throw apiError(400, 'invalid')
    }
    const { clientId, seq, baseRevision, ops } = parsed.data
    const mark = this.mark(clientId)
    if (mark && seq <= mark.lastSeq) {
      return { clientId, seq, revision: mark.lastRevision, now: null, duplicate: true }
    }
    const key = `${clientId}/${seq}`
    let stage = this.stages.get(key)
    if (
      stage &&
      (stage.count !== count || stage.baseRevision !== baseRevision || stage.digest !== digest)
    ) {
      this.stages.delete(key)
      throw apiError(409, 'stage-mismatch')
    }
    if (!stage) {
      stage = { count, baseRevision, digest, parts: new Map() }
      this.stages.set(key, stage)
    }
    stage.parts.set(index, ops)
    if (stage.parts.size < count) {
      return { staged: true, received: [...stage.parts.keys()].sort((a, b) => a - b), count }
    }
    const all: ClientOp[] = []
    for (let i = 0; i < count; i++) all.push(...(stage.parts.get(i) ?? []))
    try {
      const ack = await this.submit({ clientId, seq, baseRevision, ops: all })
      this.stages.delete(key)
      return ack
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) this.stages.delete(key)
      throw e
    }
  }

  /** Every staged transaction is lost (a restart, or a stage that expired). */
  dropStages(): void {
    this.stages.clear()
  }

  /** The note ids of each staged part, by `clientId/seq` and part index. */
  stagedParts(clientId: string, seq: number): number[] {
    return [...(this.stages.get(`${clientId}/${seq}`)?.parts.keys() ?? [])].sort((a, b) => a - b)
  }

  /**
   * Commit `ops` directly: a batch under a client's mark, or one of the store's own.
   * `sent`: the digest of the ops as posted, when the server rewrote them. As the server, the
   * books whose cards the batch changed are stamped after it in its revision (`book.cards`); `posted` (a client's batch as it came) gives the commit its `sent` then.
   */
  commit(
    ops: readonly Op[],
    mark: { clientId: string; seq: number } | null = null,
    sent?: string,
    posted?: readonly Op[],
  ): CommitEvent {
    const now = this.now()
    const c = drainSteps(commitSteps(this.state, ops, now, mark, { stamp: cardStamps }))
    const { state } = c
    if (c.stamps.length > 0) {
      ops = [...ops, ...c.stamps]
      if (sent === undefined && posted !== undefined) sent = batchDigest([posted])
    }
    this.state = state
    const event: CommitEvent = {
      revision: this.revision,
      ops: [...ops],
      originClientId: mark?.clientId ?? null,
      seq: mark?.seq ?? null,
      now,
      ...(sent === undefined ? {} : { sent }),
    }
    this.log.push(event)
    this.ring.push(event)
    if (this.ring.length > RING_COMMITS) this.ring.shift()
    for (const fn of [...this.listeners]) fn({ type: 'commit', event })
    return event
  }

  /**
   * A backup restore (or a hand edit the server picked up): the board takes `content` at a
   * revision above every one it had, keeps the current client marks, forgets the ring and stages,
   * and subscribers get `reset`.
   */
  restore(content: BoardState): void {
    const revision = Math.max(this.revision, content.board.revision) + 1
    this.state = {
      ...content,
      board: {
        ...content.board,
        revision,
        clients: this.state.board.clients,
        updatedAt: this.now(),
      },
    }
    this.replacedAt = revision
    this.ring = []
    this.stages.clear()
    for (const fn of [...this.listeners]) fn({ type: 'reset', revision })
  }

  /**
   * Subscribers get `reset` at the current revision, the ring kept (a client then loads the board
   * whole while `ops?since` still reaches back).
   */
  announceReset(): void {
    for (const fn of [...this.listeners]) fn({ type: 'reset', revision: this.revision })
  }

  /**
   * The tab went 90 days idle without the clock moving: its mark is pruned and its id counts as
   * past the TTL, so its next request is answered `409 client-expired`.
   */
  expireClient(clientId: string): void {
    this.forgetClient(clientId)
    this.expired.add(clientId)
  }

  /** The tab's mark is gone (pruned after 90 days idle). */
  forgetClient(clientId: string): void {
    const clients = { ...this.state.board.clients }
    delete clients[clientId]
    this.state = { ...this.state, board: { ...this.state.board, clients } }
  }

  /** A stream from `since` (null: new, starting with `hello`), then live events. */
  subscribe(since: number | null, fn: (e: SyncEvent) => void): () => void {
    if (since === null) fn({ type: 'hello', revision: this.revision })
    else {
      const snap = this.since(since)
      if ('commits' in snap) for (const event of snap.commits) fn({ type: 'commit', event })
      else fn({ type: 'reset', revision: snap.revision })
    }
    const listener = (e: SyncEvent) => fn(e)
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The commits made under `clientId` with `seq`. */
  commitsOf(clientId: string, seq: number): CommitEvent[] {
    return this.log.filter((e) => e.originClientId === clientId && e.seq === seq)
  }

  private mark(clientId: string): ClientMark | undefined {
    const { clients } = this.state.board
    return Object.hasOwn(clients, clientId) ? clients[clientId] : undefined
  }

  private async submit(input: OpBatch): Promise<CommitAck> {
    const { clientId, seq, baseRevision, ops } = input
    const mark = this.mark(clientId)
    if (mark && seq <= mark.lastSeq) {
      return { clientId, seq, revision: mark.lastRevision, now: null, duplicate: true }
    }
    if (this.inFlight.has(clientId)) throw apiError(409, 'client-busy')
    const old = ulidTimeMs(clientId) < Date.now() - CLIENT_MARK_TTL_MS
    if (!mark && (old || this.expired.has(clientId))) {
      throw apiError(409, 'client-expired')
    }
    if (baseRevision > this.revision) throw apiError(409, 'revision-ahead')
    this.inFlight.add(clientId)
    try {
      // The writer commits a turn later, so a second request of the same tab meets `client-busy`.
      await null
      const prior = this.mark(clientId)
      if (prior && seq <= prior.lastSeq) {
        return { clientId, seq, revision: prior.lastRevision, now: null, duplicate: true }
      }
      let event: CommitEvent
      let applied: ClientOp[]
      try {
        if (baseRevision < this.revision) {
          this.checkMove(baseRevision, ops)
          this.checkBlocks(baseRevision, ops)
        }
        applied = stampTrashed(this.state, ops, this.now())
        const rewritten = JSON.stringify(applied) !== JSON.stringify(ops)
        event = this.commit(
          applied,
          { clientId, seq },
          rewritten ? batchDigest([ops]) : undefined,
          ops,
        )
        applied = event.ops as ClientOp[]
      } catch (e) {
        if (e instanceof OpError) throw apiError(422, 'rejected', { code: e.code, index: e.index })
        throw e
      }
      const ack: CommitAck = {
        clientId,
        seq,
        revision: event.revision,
        now: event.now,
        duplicate: false,
      }
      return event.sent === undefined ? ack : { ...ack, ops: applied }
    } finally {
      this.inFlight.delete(clientId)
    }
  }

  /**
   * The store's `checkMove`: a move (block creates with a `note.delete`) made against `base` is
   * refused whole (`conflict`) when that card, or a thread on it, changed after `base`.
   */
  private checkMove(base: number, ops: readonly ClientOp[]): void {
    if (!ops.some((op) => op.op === 'block.create')) return
    const changed = (rev: number | undefined) => rev !== undefined && rev > base
    for (const op of ops) {
      if (op.op !== 'note.delete') continue
      if (changed(this.state.notes.get(op.id)?.rev)) {
        throw new OpError('conflict', `note ${op.id} was rewritten after the move was made`)
      }
      for (const yarn of threadsOf(this.state, op.id)) {
        if (changed(yarn.rev)) {
          throw new OpError('conflict', `a thread on note ${op.id} changed after the move was made`)
        }
      }
    }
  }

  /**
   * The store's `checkBlocks`: a batch made against `base` is `409 block-stale` when a block it
   * names changed after `base`, or the board was replaced since. A block that is gone is the
   * commit's to refuse (a `422`).
   */
  private checkBlocks(base: number, ops: readonly ClientOp[]): void {
    const own = new Set<string>()
    for (const op of ops) {
      if (op.op === 'block.create') own.add(op.block.id)
      else if (op.op === 'block.split') own.add(op.newId)
    }
    for (const op of ops) {
      if (!op.op.startsWith('block.')) continue
      for (const id of namesOf(op)) {
        if (own.has(id)) continue
        const block = this.state.blocks.get(id)
        if (block && (base < this.replacedAt || (block.rev ?? 0) > base)) {
          throw apiError(409, 'block-stale', { blockId: id })
        }
      }
    }
  }

  private ringSince(rev: number, current: number): CommitEvent[] | null {
    if (rev > current) return null
    if (rev === current) return []
    const first = this.ring[0]
    const last = this.ring.at(-1)
    if (!first || !last || first.revision > rev + 1 || last.revision !== current) return null
    return this.ring.filter((e) => e.revision > rev)
  }
}

/** One request the client made, and what became of it. */
export interface SendRecord {
  at: number
  body: OpBatch | StagedPart
  /** `lost`: the server handled it but the answer never arrived. */
  outcome: 'ok' | 'lost' | 'failed' | 'offline' | 'error'
  answer?: CommitAck | StagedAck
  error?: ApiError
}

interface Stream {
  lastId: number | null
  on: (e: SyncEvent) => void
  off: (() => void) | null
  closed: boolean
}

/**
 * One client's network to a {@link FakeServer}, with faults to inject. Its stream behaves like
 * the HTTP transport's: it reconnects after a drop, resuming from the last commit it delivered.
 */
export class FakeTransport implements SyncTransport {
  readonly boardId: string
  readonly sends: SendRecord[] = []
  readonly sinceCalls: number[] = []
  loads = 0
  /** Each whole load served: the revision it read, and how many sends this transport had made. */
  readonly loaded: Array<{ revision: number; sendsBefore: number }> = []
  private down = false
  private readonly failures: ApiError[] = []
  /** The server's per-user ops limit, as a fixed window (`rateLimit`). */
  private limit: { max: number; windowMs: number; start: number; count: number } | null = null
  private acksToLose = 0
  private duplicates = 0
  private eventsToDrop = 0
  private held: Array<() => void> | null = null
  private loadGate: Promise<void> | null = null
  private resumeGate: Promise<void> | null = null
  private sendGate: Promise<void> | null = null
  private readonly streams = new Set<Stream>()

  constructor(readonly server: FakeServer) {
    this.boardId = server.state.board.id
  }

  get offline(): boolean {
    return this.down
  }

  /** Out of reach: every request fails with `network` and the stream drops until it is back. */
  set offline(v: boolean) {
    if (v === this.down) return
    this.down = v
    for (const s of this.streams) {
      if (v) this.disconnect(s)
      else this.connect(s)
    }
  }

  /** The next `n` sends fail with `err` before they reach the server. */
  failNext(err: ApiError, n = 1): void {
    for (let i = 0; i < n; i++) this.failures.push(err)
  }

  /**
   * The server's per-user ops limit: a window opens at the first send and lasts `windowMs`, the
   * first `max` sends in it pass, and the rest are answered 429 with the rest of the window as
   * `Retry-After` (whole seconds, as the server sends it).
   */
  rateLimit(max: number, windowMs: number): void {
    this.limit = { max, windowMs, start: Number.NEGATIVE_INFINITY, count: 0 }
  }

  /** The next `n` sends reach the server, but their answers are lost. */
  loseNextAck(n = 1): void {
    this.acksToLose += n
  }

  /** The next `n` sends reach the server twice; the client hears the second answer. */
  duplicateNext(n = 1): void {
    this.duplicates += n
  }

  /** The next `n` stream frames are lost (the client sees a revision gap). */
  dropNextEvents(n = 1): void {
    this.eventsToDrop += n
  }

  /** The stream is slow: frames wait until {@link releaseEvents}. */
  holdEvents(): void {
    this.held ??= []
  }

  releaseEvents(): void {
    const held = this.held ?? []
    this.held = null
    for (const run of held) queueMicrotask(run)
  }

  /**
   * The faults end: back online, no more frames lost, held frames delivered, and the stream
   * reconnects once (so frames lost before now are replayed from the last one delivered).
   */
  heal(): void {
    this.eventsToDrop = 0
    this.offline = false
    this.releaseEvents()
    this.bounceStream()
  }

  /** The stream drops and reconnects at once, resuming from the last commit it delivered. */
  bounceStream(): void {
    if (this.down) return
    for (const s of this.streams) {
      this.disconnect(s)
      this.connect(s)
    }
  }

  /** Loads wait until the returned function is called (a slow board download). */
  gateLoads(): () => void {
    let open: () => void = () => {}
    this.loadGate = new Promise<void>((r) => {
      open = r
    })
    return () => {
      this.loadGate = null
      open()
    }
  }

  /** `since` and `changes` wait until the returned function is called (a slow resume). */
  gateResume(): () => void {
    let open: () => void = () => {}
    this.resumeGate = new Promise<void>((r) => {
      open = r
    })
    return () => {
      this.resumeGate = null
      open()
    }
  }

  async load(): Promise<LoadedBoard> {
    await null
    if (this.loadGate) await this.loadGate
    if (this.down) throw networkError()
    this.loads++
    this.loaded.push({ revision: this.server.revision, sendsBefore: this.sends.length })
    return this.server.load()
  }

  async since(rev: number): Promise<OpsSince> {
    await null
    if (this.resumeGate) await this.resumeGate
    if (this.down) throw networkError()
    this.sinceCalls.push(rev)
    const recovered = this.server.recovered ? { recovered: true } : {}
    return wire({ ...this.server.since(rev), serverNow: this.server.now(), ...recovered })
  }

  /** Books fetched (`GET /books/:bookId`), by id. */
  readonly bookCalls: string[] = []

  private readonly bookFailures: ApiError[] = []
  /** The next `n` book reads fail with `err` (a 429, a 5xx) once they reach the server. */
  failNextBook(err: ApiError, n = 1): void {
    for (let i = 0; i < n; i++) this.bookFailures.push(err)
  }
  /** Run as each book read is answered, after the server read it (a commit then makes it stale). */
  afterBookRead: (() => void) | null = null

  async book(bookId: string): Promise<FetchedBook | null> {
    await null
    if (this.down) throw networkError()
    this.bookCalls.push(bookId)
    const failure = this.bookFailures.shift()
    if (failure) throw failure
    const answer = wire(this.server.book(bookId))
    this.afterBookRead?.()
    return answer
  }

  /** Sends wait until the returned function is called (a batch held in flight). */
  gateSends(): () => void {
    let open: () => void = () => {}
    this.sendGate = new Promise<void>((r) => {
      open = r
    })
    return () => {
      this.sendGate = null
      open()
    }
  }

  async send(body: OpBatch | StagedPart): Promise<CommitAck | StagedAck> {
    if (this.sendGate) await this.sendGate
    const record: SendRecord = { at: Date.now(), body: wire(body), outcome: 'ok' }
    this.sends.push(record)
    await null
    const fail = (outcome: SendRecord['outcome'], e: ApiError) => {
      record.outcome = outcome
      record.error = e
      return e
    }
    if (this.down) throw fail('offline', networkError())
    const failure = this.failures.shift()
    if (failure) throw fail('failed', failure)
    const limit = this.limit
    if (limit) {
      const now = Date.now()
      if (now >= limit.start + limit.windowMs) {
        limit.start = now
        limit.count = 0
      }
      if (limit.count >= limit.max) {
        const s = Math.max(1, Math.ceil((limit.start + limit.windowMs - now) / 1000))
        throw fail('failed', apiError(429, 'rate-limited', {}, s * 1000))
      }
      limit.count++
    }
    let answer: CommitAck | StagedAck
    try {
      if (this.duplicates > 0) {
        this.duplicates--
        await this.server.post(wire(body)).catch(() => undefined)
      }
      answer = wire(await this.server.post(wire(body)))
    } catch (e) {
      if (!(e instanceof ApiError)) throw e
      if (this.acksToLose > 0) {
        this.acksToLose--
        throw fail('lost', networkError())
      }
      throw fail('error', e)
    }
    if (this.acksToLose > 0) {
      this.acksToLose--
      throw fail('lost', networkError())
    }
    record.answer = answer
    return answer
  }

  events(since: number | null, on: (e: SyncEvent) => void): () => void {
    const s: Stream = { lastId: since, on, off: null, closed: false }
    this.streams.add(s)
    if (this.down) this.emit(s, { type: 'down', status: null })
    else this.connect(s)
    return () => {
      s.closed = true
      s.off?.()
      s.off = null
      this.streams.delete(s)
    }
  }

  private connect(s: Stream): void {
    s.off = this.server.subscribe(s.lastId, (e) => {
      if (this.eventsToDrop > 0) {
        this.eventsToDrop--
        return
      }
      this.emit(s, wire(e))
    })
  }

  private disconnect(s: Stream): void {
    s.off?.()
    s.off = null
    this.emit(s, { type: 'down', status: null })
  }

  /** Frames arrive a turn later (or when released), in order. */
  private emit(s: Stream, e: SyncEvent): void {
    const run = () => {
      if (s.closed) return
      if (e.type === 'commit') s.lastId = e.event.revision
      else if (e.type === 'reset') s.lastId = e.revision
      s.on(e)
    }
    if (this.held && e.type !== 'down') this.held.push(run)
    else queueMicrotask(run)
  }
}

export interface Harness {
  client: SyncClient
  transport: FakeTransport
  views: ViewCause[]
  statuses: SaveStatus[]
  notices: SyncNotice[]
  /** Thrown once by the next `onView` with this cause (an app callback with a defect). */
  throwOnView: ViewCause | null
}

/** A SyncClient on its own transport to `server`, recording what it reports. */
export function connect(server: FakeServer, o: { pace?: DigestPace } = {}) {
  const transport = new FakeTransport(server)
  const h: Harness = {
    transport,
    views: [],
    statuses: [],
    notices: [],
    throwOnView: null,
    client: undefined as unknown as SyncClient,
  }
  h.client = new SyncClient({
    transport,
    ...(o.pace === undefined ? {} : { pace: o.pace }),
    onView: (_view, cause) => {
      h.views.push(cause)
      if (h.throwOnView === cause) {
        h.throwOnView = null
        throw new Error('onView failed')
      }
    },
    onStatus: (s) => h.statuses.push(s),
    onNotice: (n) => h.notices.push(n),
  })
  return h
}

/** Whether `h` has nothing left to send or confirm and sits at the server's revision. */
export const quiet = (server: FakeServer, h: Harness) =>
  h.client.pending === 0 &&
  h.client.view === h.client.confirmed &&
  h.client.confirmed.board.revision === server.revision

/** Advance fake time until every client is quiet (the clients' backoff tops out at 30 s). */
export async function settle(server: FakeServer, ...clients: Harness[]): Promise<void> {
  for (let i = 0; i < 300; i++) {
    await vi.advanceTimersByTimeAsync(i === 0 ? 0 : 1000)
    if (clients.every((h) => quiet(server, h))) return
  }
  const state = clients.map((h) => ({
    pending: h.client.pending,
    revision: h.client.confirmed.board.revision,
    synced: h.client.view === h.client.confirmed,
  }))
  throw new Error(`clients did not settle at ${server.revision}: ${JSON.stringify(state)}`)
}
