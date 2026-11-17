import { statSync } from 'node:fs'
import { mkdir, readdir, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  BoardRecordSchema,
  type BoardState,
  CLIENT_MARK_TTL_MS,
  type ClientMark,
  type CommitMark,
  type Committed,
  cardStamps,
  commitSteps,
  digestOfHashes,
  emptyBoardState,
  hashPart,
  isId,
  type LoadIssue,
  namesOf,
  newId,
  type Op,
  OpError,
  parseBoard,
  serializeBoard,
  threadsOf,
} from '@papertie/core'
import type { Clock } from '../clock'
import { ulidTimeMs } from '../ids'
import { COMPACT_IDLE_MS, JOURNAL_MAX_BYTES, JOURNAL_MAX_COMMITS, pastTrash } from '../limits'
import type { Logger } from '../log'
import { assetDirIds, dropDanglingAssets, moveAssetDirs } from './assetFiles'
import {
  forceBackup,
  hourOf,
  listBackups,
  type PreparedBackup,
  parseBackupName,
  prepareHourlyBackup,
  pruneBackups,
} from './backups'
import {
  clearRecovery,
  clearRestoreIntent,
  isSnapshotText,
  type JournalStat,
  type LoadOptions,
  type LoadOutcome,
  loadBoardDir,
  type PreservedDamage,
  preserveDamage,
  type RecoveryNotice,
  readRecovery,
  readTextIfPresent,
  type Snapshot,
  writeRecovery,
  writeRestoreIntent,
  writeSnapshot,
} from './boardFile'
import { bookStream } from './bookStream'
import {
  installSnapshot,
  LOAD_SLICE_MS,
  NEXT_SNAPSHOT_FILE,
  SLICE_MS,
  Slicer,
  serializeSliced,
} from './compact'
import { type FileStamp, fsyncDir, isEnoent, stampOf, writeTmpDurable } from './durable'
import { StoreError } from './errors'
import type { Faults } from './faults'
import { type BoardEvent, EventHub } from './hub'
import {
  boardEofSha,
  clearMovedList,
  type RollBack,
  removeImportDirs,
  rollBackImport,
  writeMovedList,
} from './importBoard'
import { appendJournal, encodeCommitSteps, rotateJournal } from './journal'
import { KeyedMutex } from './mutex'
import { cmp } from './order'
import { boardDir, userDir } from './paths'
import { RegionIndex, type RegionRect, regionText } from './region'
import { type CommitEvent, CommitRing } from './ring'
import { type BoardText, type Jsonl, jsonlText, ServedText } from './servedText'
import { keepSummary, readKeptSummary } from './summaryFile'

export type { BoardEvent } from './hub'
export type { CommitEvent } from './ring'

export interface CommitAck {
  clientId: string | null
  seq: number | null
  revision: number
  /** The server time the commit was applied with; null on a duplicate. */
  now: string | null
  duplicate: boolean
  /**
   * The ops as applied, present only when the store rewrote the batch (a deletion's time stamped
   * with the store's own, the books whose cards it changed stamped after it: `book.cards`): the
   * page takes these for its batch.
   */
  ops?: Op[]
}

/** One client batch. The op count is not bounded here: staged transactions pass more than 500. */
export interface SubmitInput {
  clientId: string
  seq: number
  baseRevision: number
  ops: readonly Op[]
}

export interface BoardSummary {
  id: string
  name: string
  revision: number
  createdAt: string
  updatedAt: string
  recovered: boolean
}

/** A commit group of more ops than this, in all, commits as a `Slicer` job, taking turns. */
export const INLINE_OPS = 64

/**
 * A step generator run to its end, giving the loop back whenever `s`'s slice is due (`s` null:
 * in one go). The caller holds the board's mutex, so nothing else writes the board meanwhile.
 */
async function stepped<R>(steps: Generator<void, R>, s: Slicer | null): Promise<R> {
  for (let r = steps.next(); ; r = steps.next()) {
    if (r.done) return r.value
    if (s?.due()) await s.pause()
  }
}

export interface BoardView {
  state: BoardState
  /** The board's `board.jsonl` bytes: what an export and a backup carry, blocks and all. */
  jsonl: Jsonl
  /**
   * What a whole-board read (`GET /:id`) answers with: `jsonl` up to its first `block` line, with
   * an eof over those lines (ADR-0001). `jsonl` itself for a board without blocks.
   */
  served: Jsonl
  /** `jsonl`, decoded whole (for tests; a route streams `jsonl` instead). */
  readonly text: string
  /** `served`, decoded whole (for tests). */
  readonly servedText: string
  revision: number
  recovery: RecoveryNotice | null
}

export interface RestoreResult {
  /** The board's revision after the restore: above every revision it had reached. */
  revision: number
  /** The backup holding the board as it was just before the restore (restoring it undoes this). */
  safetyBackup: string
}

/**
 * What a compaction did: the snapshot's revision, its duration and its longest slice (ms), in wall
 * time and in the CPU time the slice itself took (which machine load cannot inflate).
 */
export interface CompactResult {
  rev: number
  ms: number
  maxSliceMs: number
  maxSliceCpuMs: number
}

/**
 * `since`: the ring's commits, or `full`. `recovered` (present only when true): the board was
 * repaired or restored and the notice is not dismissed yet, as `X-Papertie-Recovered` says on a load.
 */
export type SinceResult = (
  | { revision: number; commits: CommitEvent[] }
  | { revision: number; full: true }
) & { recovered?: true }

/** `{recovered: true}` while the board's recovery notice stands, else nothing. */
const recoveredOf = (h: { recovery: RecoveryNotice | null }) =>
  h.recovery !== null ? { recovered: true as const } : {}

/** `book`: one book's NDJSON and the revision it was read at. */
export interface BookText {
  revision: number
  jsonl: Jsonl
}

/** `region`: the NDJSON of one viewport. */
export interface RegionResult {
  revision: number
  text: string
}

export interface BoardStoreOptions {
  dataDir: string
  clock: Clock
  log: Logger
  faults: Faults
  cacheSize: number
  idleEvictMs: number
  ringCommits: number
  ringBytes: number
  maxBoardsPerUser: number
  /** Compaction thresholds; default to `JOURNAL_MAX_BYTES`, `JOURNAL_MAX_COMMITS`, `COMPACT_IDLE_MS`. */
  journalMaxBytes?: number
  journalMaxCommits?: number
  compactIdleMs?: number
  /**
   * Compact at once when a commit lands in a UTC hour with no backup yet, so every hour with
   * edits gets one (default true; tests that count files turn it off).
   */
  compactEveryHour?: boolean
  /**
   * Told (in a later turn, never on the request path) the ids of a board just loaded or just
   * compacted: the server runs that board's asset sweep from here, at most once a day.
   */
  onBoardReady?: (userId: string, boardId: string) => void
}

type Loaded = Extract<LoadOutcome, { kind: 'ok' }>

/** A queued batch. `flightKey` is the tab id, or `'server'` for server-originated commits. */
interface Pending {
  ops: readonly Op[]
  mark: CommitMark | null
  flightKey: string
  /** The revision the page made the batch on (`checkBlocks`, `checkMove`). */
  baseRevision?: number
  /**
   * Checked against the board right before the batch applies, in its place among the group's
   * commits: false refuses it (`conflict`) and changes nothing (the purge's "still due").
   */
  guard?: (state: BoardState) => boolean
  resolve(ack: CommitAck): void
  reject(e: StoreError): void
}

/**
 * The cached, writable copy of one board. Every field changes only under the board's mutex,
 * except `compaction` (set and cleared by the compaction itself) and the timers.
 */
interface Handle {
  readonly key: string
  readonly dir: string
  /** The board: `snapshot` plus the journal. */
  state: BoardState
  /** Whole-board reads' text: the newest serialized, and the ones running or queued. */
  readonly served: ServedText
  /** `board.jsonl` as this handle last wrote or loaded it. */
  snapshot: Snapshot
  /** `journal.jsonl`, or null while the board has none. */
  journal: JournalStat | null
  /**
   * The revision the board was last replaced at while loaded (a restore, an import, a recovery),
   * 0 when it has not been: a batch based below it was made on another board.
   */
  replacedAt: number
  /**
   * The note rects of `state`: built whenever a whole state is taken on (load, reload, restore),
   * then kept up to date commit by commit.
   */
  region: RegionIndex
  /** Bumped whenever `state` is replaced other than by a commit (reload, restore). */
  epoch: number
  /** The running compaction: the lines committed since it took its copy of `state`. */
  compaction: { tail: string[]; epoch: number } | null
  compactTimer: NodeJS.Timeout | null
  /** The UTC hour (`hourOf`) of the newest backup, or null when there is none. */
  backupHour: number | null
  recovery: RecoveryNotice | null
  readonly ring: CommitRing
  readonly queue: Pending[]
  /** Batches queued or being written, per flight key. */
  readonly inFlight: Map<string, number>
  /** The running drain loop, if any: this board's single writer. */
  drain: Promise<void> | null
  evicted: boolean
  idleTimer: NodeJS.Timeout | null
}

const BOARD_FILE = 'board.jsonl'
const SERVER_FLIGHT = 'server'

const userOf = (key: string) => key.slice(0, key.indexOf('/'))

const errCode = (e: unknown): string => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown'
}

const sameStamp = (a: FileStamp, b: FileStamp) =>
  a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs

const invalid = (message: string, cause?: unknown) =>
  new StoreError('rejected', {
    opError: new OpError('invalid', message, cause === undefined ? {} : { cause }),
  })

const summaryOf = (state: BoardState, recovery: RecoveryNotice | null): BoardSummary => ({
  id: state.board.id,
  name: state.board.name,
  revision: state.board.revision,
  createdAt: state.board.createdAt,
  updatedAt: state.board.updatedAt,
  recovered: recovery !== null,
})

/**
 * `ops` with every deletion of a book (`book.update` setting `trashedAt` to a time) dated `now`,
 * the commit's own time: the purge reads the board's clock, never a client's. A book deleted
 * already keeps its date (a deletion sent again never extends its window): as the batch has left
 * it so far, so one put back earlier in the batch is deleted afresh. The
 * array itself when there is none to date. O(ops).
 */
function stampTrashed(state: BoardState, ops: readonly Op[], now: string): readonly Op[] {
  let out: Op[] | null = null
  /** The books' `trashedAt` as the batch has set them so far. */
  let set: Map<string, string | null> | null = null
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Op
    if (op.op !== 'book.update' || op.set.trashedAt === undefined) continue
    if (op.set.trashedAt === null) {
      set ??= new Map()
      set.set(op.id, null)
      continue
    }
    const was = set?.has(op.id) ? set.get(op.id) : state.books.get(op.id)?.trashedAt
    const at = was ?? now
    set ??= new Map()
    set.set(op.id, at)
    if (op.set.trashedAt === at) continue
    out ??= [...ops]
    out[i] = { ...op, set: { ...op.set, trashedAt: at } }
  }
  return out ?? ops
}

/**
 * Refuses (`OpError('conflict')`) a client's batch putting back a book deleted in `state` that is
 * past its window at `nowMs`: due for the purge, or being purged, so some of its paragraphs may be
 * gone already. Never a book put back missing some of them; the client says it is
 * too late. O(ops).
 */
function checkTrash(state: BoardState, ops: readonly Op[], nowMs: number): void {
  for (const op of ops) {
    if (op.op !== 'book.update' || op.set.trashedAt !== null) continue
    if (pastTrash(state.books.get(op.id)?.trashedAt, nowMs)) {
      throw new OpError('conflict', `book ${op.id} is past its trash window`)
    }
  }
}

/** A block batch made against a board that is not this one any more (`block-stale`). */
class BlockStale extends Error {
  constructor(readonly blockId: string) {
    super(`block ${blockId} changed after the batch was made`)
  }
}

/**
 * Refuses (`BlockStale`) the page's batch made against `base` when a block it names changed after
 * `base`, or the board was replaced since (`replacedAt`: a restore, an import, a recovery): its
 * splices count from the text it saw. The page sends one batch at a time, each made on the one
 * before, so this is met only when the board changed under it; the page reads the book again.
 * A block that is gone is the commit's to refuse.
 */
function checkBlocks(
  state: BoardState,
  ops: readonly Op[],
  base: number,
  replacedAt: number,
): void {
  const own = new Set<string>()
  for (const op of ops) {
    if (op.op === 'block.create') own.add(op.block.id)
    else if (op.op === 'block.split') own.add(op.newId)
  }
  for (const op of ops) {
    if (!op.op.startsWith('block.')) continue
    for (const id of namesOf(op)) {
      if (own.has(id)) continue
      const block = state.blocks.get(id)
      if (block && (base < replacedAt || (block.rev ?? 0) > base)) throw new BlockStale(id)
    }
  }
}

/**
 * Refuses (`OpError('conflict')`) a move made against `base` (a batch that both creates blocks and
 * deletes a note) when that note, or a thread on it, changed after `base`: the move took the
 * card's text as it was, so its `note.delete` would drop the change (ADR-0005, nothing is lost).
 * The card stays; the page offers the move in its unsaved-changes download. A plain delete is as
 * before: History keeps the card. O(ops × the card's threads).
 */
function checkMove(state: BoardState, ops: readonly Op[], base: number): void {
  if (!ops.some((op) => op.op === 'block.create')) return
  const changed = (rev: number | undefined) => rev !== undefined && rev > base
  for (const op of ops) {
    if (op.op !== 'note.delete') continue
    if (changed(state.notes.get(op.id)?.rev)) {
      throw new OpError('conflict', `note ${op.id} was rewritten after the move was made`)
    }
    for (const yarn of threadsOf(state, op.id)) {
      if (changed(yarn.rev)) {
        throw new OpError('conflict', `a thread on note ${op.id} changed after the move was made`)
      }
    }
  }
}

/** `batchDigest([ops])` (core `sync.ts`), hashed a piece at a time in `s`'s slices. */
async function digestSteps(ops: readonly Op[], s: Slicer | null): Promise<string> {
  return digestOfHashes([await stepped(hashPart(ops), s)])
}

/**
 * Owns every board on disk. One handle per board is cached (LRU plus an idle timer); all writes to
 * a board go through that handle's drain loop, which appends queued batches to the board's journal
 * in one fsynced write (group commit) and settles each batch only once it is durable. Compaction
 * folds the journal into a fresh `board.jsonl` in the background (ADR-0001, Snapshot + journal).
 */
export class BoardStore {
  readonly hub: EventHub
  private readonly mutex = new KeyedMutex()
  /** Insertion order is recency: the first entry is the least recently used. */
  private readonly cache = new Map<string, Handle>()
  private snapshots = 0
  private appends = 0
  private loads = 0
  /** The running compaction per board key: at most one, and it outlives an evicted handle. */
  private readonly compactions = new Map<string, Promise<CompactResult>>()
  /**
   * Per board key, the time (clock ms) before which no commit starts a compaction: set by a
   * failed one. Kept here, not on the handle, because a failed install evicts the handle and a
   * reloaded one must not retry at once (a failure that persists would cost a reload and a
   * compaction on every commit).
   */
  private readonly compactRetryAt = new Map<string, number>()
  /**
   * Per board key, the time (clock ms) before which the hour rule asks for no compaction and no
   * second warning is logged: set when an hourly backup could not be written. Kept on the store,
   * like `compactRetryAt`, so it survives eviction.
   */
  private readonly backupRetryAt = new Map<string, number>()
  private closed = false
  /**
   * Users whose account deletion has begun (threat model §8): nothing of theirs is created, loaded
   * or written any more, so no data can reappear under `users/<id>/` after the hook moved it away.
   * Lifted only when the deletion fails; a deleted user's id is never reused.
   */
  private readonly deleting = new Set<string>()
  /** Running operations per user that may write under `users/<id>/`; a deletion waits for them. */
  private readonly userOps = new Map<string, Set<Promise<unknown>>>()
  /** `summary.json` writes of handles dropped while idle; `close` waits for them. */
  private readonly keeping = new Set<Promise<void>>()
  /** Told when a user's deletion begins, before it waits for their running operations. */
  private readonly deletionHooks = new Map<string, Set<() => void>>()
  /** Told when the store starts closing. */
  private readonly closeHooks = new Set<() => void>()

  constructor(private readonly opts: BoardStoreOptions) {
    this.hub = new EventHub((e) => opts.log.error('subscriber failed', { kind: errCode(e) }))
  }

  /**
   * Snapshots written (compactions, restores), journal appends (commit groups) and board loads
   * (each a whole-board parse).
   */
  get stats(): { snapshots: number; appends: number; loads: number; cached: number } {
    return {
      snapshots: this.snapshots,
      appends: this.appends,
      loads: this.loads,
      cached: this.cache.size,
    }
  }

  // ---- boards -------------------------------------------------------------------------------

  async createBoard(userId: string, name: string): Promise<BoardSummary> {
    this.assertOpen()
    const udir = this.userDirOf(userId)
    return this.whileLive(userId, () => this.createIn(userId, udir, name))
  }

  /**
   * The user's first board: the board they have (the oldest, as listed), or `name` made now if
   * they have none. Decided under the same lock as every create, so two boots on a fresh data
   * folder (a reload during the first one's create) share one board: one makes it, the other is
   * given it (`created: false`).
   */
  async firstBoard(
    userId: string,
    name: string,
  ): Promise<{ board: BoardSummary; created: boolean }> {
    this.assertOpen()
    const udir = this.userDirOf(userId)
    return this.whileLive(userId, () =>
      this.mutex.run(`create:${userId}`, async () => {
        const have = (await this.listBoards(userId))[0]
        if (have) return { board: have, created: false }
        return { board: await this.makeBoard(userId, udir, name), created: true }
      }),
    )
  }

  private createIn(userId: string, udir: string, name: string): Promise<BoardSummary> {
    return this.mutex.run(`create:${userId}`, () => this.makeBoard(userId, udir, name))
  }

  /** A new board, under the caller's `create:` lock. */
  private async makeBoard(userId: string, udir: string, name: string): Promise<BoardSummary> {
    if ((await this.boardIds(udir)).length >= this.opts.maxBoardsPerUser) {
      throw new StoreError('board-limit')
    }
    // Validate before any directory exists (an unrepresentable clock time or a bad name).
    let state: BoardState
    try {
      state = emptyBoardState(newId('board'), name, this.opts.clock.now().toISOString())
    } catch (e) {
      throw invalid('invalid clock time', e)
    }
    if (!BoardRecordSchema.safeParse(state.board).success) throw invalid('invalid board')

    const dir = this.dirOf(userId, state.board.id)
    const boards = dirname(dir)
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      for (const sub of ['assets', 'backups', 'quarantine']) {
        await mkdir(join(dir, sub), { mode: 0o700 })
      }
      await writeSnapshot(dir, serializeBoard(state), this.opts.faults)
      await fsyncDir(boards)
      await fsyncDir(udir)
      await fsyncDir(dirname(udir))
    } catch (e) {
      this.opts.log.error('board create failed', { code: errCode(e) })
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw new StoreError('storage')
    }
    return summaryOf(state, null)
  }

  /** Every loadable board of the user, oldest first. Unreadable boards are left out. */
  async listBoards(userId: string): Promise<BoardSummary[]> {
    this.assertOpen()
    const out: BoardSummary[] = []
    for (const boardId of await this.boardIds(this.userDirOf(userId))) {
      try {
        out.push(await this.summary(userId, boardId))
      } catch (e) {
        if (!(e instanceof StoreError) || e.code === 'storage') throw e
        // not-found (vanished meanwhile) or board-unreadable: nothing to list.
      }
    }
    return out.sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id))
  }

  /** Authorization check for routes: never throws. */
  async owns(userId: string, boardId: string): Promise<boolean> {
    try {
      return (await stat(boardDir(this.opts.dataDir, userId, boardId))).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * The board and its JSONL. The text is serialized outside the mutex, in slices, and reads
   * coalesce (`ServedText`): at most one serialization runs and one waits per board, the waiting
   * one of the newest state, shared by every read meanwhile. The view is of the board as it was
   * when asked, or newer.
   */
  async read(userId: string, boardId: string): Promise<BoardView> {
    const { served, recovery } = await this.withHandle(userId, boardId, (h) => ({
      served: h.served.get(h.state, () => h.state),
      recovery: h.recovery,
    }))
    const { state, jsonl } = await served
    return {
      state,
      jsonl,
      served: jsonl.served,
      get text() {
        return jsonlText(jsonl)
      },
      get servedText() {
        return jsonlText(jsonl.served)
      },
      revision: state.board.revision,
      recovery,
    }
  }

  /** The board as it stands, without its text (no serialization): for `meta`. */
  async peek(
    userId: string,
    boardId: string,
  ): Promise<{ state: BoardState; recovery: RecoveryNotice | null; extent: RegionRect | null }> {
    return this.withHandle(userId, boardId, (h) => ({
      state: h.state,
      recovery: h.recovery,
      extent: h.region.extent(),
    }))
  }

  /**
   * Fold everything committed so far into a fresh `board.jsonl`. A compaction already running is
   * waited for first (it may have taken its copy before the last commits). Commits go on
   * meanwhile: those after this compaction's copy of the state stay in the new journal.
   */
  async compact(userId: string, boardId: string): Promise<CompactResult> {
    for (;;) {
      // Wrapped in an object: returning the promise itself would hold the mutex until it settles.
      const step = await this.withHandle(userId, boardId, (h) => {
        const running = this.compactions.get(h.key)
        return running ? { ours: false, p: running } : { ours: true, p: this.startCompaction(h) }
      })
      if (step.ours) return step.p
      await step.p.catch(() => {})
    }
  }

  async clientMark(
    userId: string,
    boardId: string,
    clientId: string,
  ): Promise<ClientMark | undefined> {
    return this.withHandle(userId, boardId, (h) =>
      Object.hasOwn(h.state.board.clients, clientId) ? h.state.board.clients[clientId] : undefined,
    )
  }

  async since(userId: string, boardId: string, rev: number): Promise<SinceResult> {
    return this.withHandle(userId, boardId, (h) => {
      const revision = h.state.board.revision
      const commits = Number.isSafeInteger(rev) && rev >= 0 ? h.ring.since(rev, revision) : null
      const answer: SinceResult = commits ? { revision, commits } : { revision, full: true }
      return { ...answer, ...recoveredOf(h) }
    })
  }

  /**
   * One book's NDJSON (`bookStream`): its record, its blocks in `(pos, id)` order and an eof over
   * them, read from the board as it stood when asked (one immutable state, one revision), built in
   * slices outside the board's lock. Not found when the board has no such book.
   */
  async book(userId: string, boardId: string, bookId: string): Promise<BookText> {
    const state = await this.withHandle(userId, boardId, (h) => h.state)
    const jsonl = await bookStream(state, bookId)
    if (jsonl === null) throw new StoreError('not-found')
    return { revision: state.board.revision, jsonl }
  }

  /**
   * The board record, the notes whose rect intersects `rect`, the threads touching them and the
   * assets the notes show (`regionText`). The caller bounds `rect` (`regionFits`).
   */
  async region(userId: string, boardId: string, rect: RegionRect): Promise<RegionResult> {
    // Under the lock only the index search (O(answer · log n), 2–3 ms with all 100,000 notes in
    // the region); the text is built in slices outside it, from the persistent state taken there.
    const taken = await this.withHandle(userId, boardId, (h) => ({
      revision: h.state.board.revision,
      state: h.state,
      ids: h.region.search(rect),
    }))
    return { revision: taken.revision, text: await regionText(taken.state, taken.ids) }
  }

  /** Subscribe to the board's events. A board with subscribers is never evicted. */
  async subscribe(
    userId: string,
    boardId: string,
    fn: (e: BoardEvent) => void,
  ): Promise<() => void> {
    return this.withHandle(userId, boardId, (h) => {
      const off = this.hub.subscribe(h.key, fn)
      return () => {
        off()
        const cur = this.cache.get(h.key)
        if (cur && this.hub.count(h.key) === 0) {
          this.armIdle(cur)
          this.trimCache()
        }
      }
    })
  }

  async dismissRecovery(userId: string, boardId: string): Promise<void> {
    await this.withHandle(userId, boardId, async (h) => {
      try {
        await clearRecovery(h.dir)
      } catch (e) {
        this.opts.log.error('recovery dismiss failed', { code: errCode(e) })
        throw new StoreError('storage')
      }
      h.recovery = null
    })
  }

  // ---- commits ------------------------------------------------------------------------------

  async submit(userId: string, boardId: string, input: SubmitInput): Promise<CommitAck> {
    const { clientId, seq, baseRevision, ops } = input
    // commitBatch records the mark as given, so a malformed one must never reach it.
    if (
      !isId(clientId, 'tab') ||
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      !Number.isSafeInteger(baseRevision) ||
      baseRevision < 0 ||
      !Array.isArray(ops)
    ) {
      throw invalid('malformed batch')
    }
    return this.enqueue(userId, boardId, (h) => {
      const mark = Object.hasOwn(h.state.board.clients, clientId)
        ? h.state.board.clients[clientId]
        : undefined
      if (mark && seq <= mark.lastSeq) {
        return { clientId, seq, revision: mark.lastRevision, now: null, duplicate: true }
      }
      if (h.inFlight.has(clientId)) throw new StoreError('client-busy')
      if (!mark && ulidTimeMs(clientId) < this.opts.clock.now().getTime() - CLIENT_MARK_TTL_MS) {
        throw new StoreError('client-expired')
      }
      if (baseRevision > h.state.board.revision) throw new StoreError('revision-ahead')
      return { ops, mark: { clientId, seq }, flightKey: clientId, baseRevision }
    })
  }

  /** A server-originated commit (e.g. `asset.add`): no client mark, no busy check. */
  async submitServer(userId: string, boardId: string, ops: Op[]): Promise<CommitAck> {
    return this.enqueue(userId, boardId, () => ({ ops, mark: null, flightKey: SERVER_FLIGHT }))
  }

  /**
   * `submitServer` on a board that is loaded already, or null (nothing done) when it is not: the
   * board is never loaded for it. The asset sweep and the book purge commit this way, so they
   * never pay a load. `guard`, when given, is asked right before the batch applies (in its place
   * among the commits queued with it): false refuses it as `rejected` (`conflict`).
   */
  async submitServerIfCached(
    userId: string,
    boardId: string,
    ops: Op[],
    guard?: (state: BoardState) => boolean,
  ): Promise<CommitAck | null> {
    this.assertOpen()
    const key = `${userId}/${boardId}`
    const r = await this.whileLive(userId, () =>
      this.mutex.run(key, async () => {
        const h = this.cache.get(key)
        if (!h) return null
        await this.checkExternalEdit(h)
        this.touch(h)
        return this.queueJob(h, () => ({
          ops,
          mark: null,
          flightKey: SERVER_FLIGHT,
          ...(guard ? { guard } : {}),
        }))
      }),
    )
    return r === null ? null : 'ack' in r ? r.ack : r.wait
  }

  /** The board's state when it is loaded already, or null: never loads it (the book purge). */
  async peekIfCached(userId: string, boardId: string): Promise<BoardState | null> {
    this.assertOpen()
    const key = `${userId}/${boardId}`
    return this.whileLive(userId, () =>
      this.mutex.run(key, async () => this.cache.get(key)?.state ?? null),
    )
  }

  /** Whether the board is loaded (in the cache): a peek that never loads, reads or waits. */
  isCached(userId: string, boardId: string): boolean {
    return this.cache.has(`${userId}/${boardId}`)
  }

  // ---- history ------------------------------------------------------------------------------

  /**
   * Make backup `file` the board's state. Runs under the board's mutex, which every commit group
   * holds while it writes, so it lands between two groups:
   *
   * 1. The backup is read and parsed first: a missing or unloadable one changes nothing. A damaged
   *    one (torn, checksum mismatch, rejected lines, dangling references) is restored as the parser
   *    repaired it, and what the repair dropped is kept the way a damaged load keeps it
   *    (`preserveDamage`: the backup's bytes and rejected lines in `quarantine/`, repairs in
   *    `repairs.jsonl`); the notice counts them. An asset record whose files are gone (collected
   *    or lost) is dropped, and the notes showing it lose their image (`dropDanglingAssets`):
   *    repairs too, logged in `repairs.jsonl` the same way.
   * 2. The current board is backed up whatever the hour (the safety backup: a copy of
   *    `board.jsonl`, or the board serialized when the journal holds commits), so nothing is lost
   *    and restoring that backup undoes this one.
   * 3. The backup's records become the board at a revision above every one it reached (the
   *    current one, the backup's, every backup's name), so replicas and the ring can never mistake
   *    it for one they have seen. The current client marks are kept: a batch committed before the
   *    restore is still answered as a duplicate.
   * 4. The handle takes the new state, the ring is forgotten, the recovery notice says `restored`
   *    (naming the safety backup) and subscribers are told to `reset`.
   *
   * From before the board changes until that notice is in, `restore.json` marks the restore
   * as under way (`writeRestoreIntent`): a load that finds the old board beside it says the
   * restore was cut short (`restore-interrupted`), never that it happened.
   */
  async restoreBackup(userId: string, boardId: string, file: string): Promise<RestoreResult> {
    if (parseBackupName(file) === null) throw new StoreError('not-found')
    return this.withHandle(userId, boardId, async (h) => {
      let text: string | null
      try {
        text = await readTextIfPresent(join(h.dir, 'backups', file))
      } catch (e) {
        this.opts.log.error('backup read failed', { code: errCode(e) })
        throw new StoreError('storage')
      }
      if (text === null) throw new StoreError('not-found')
      const parsed = parseBoard(text)
      if (parsed.state === null || parsed.state.board.id !== h.state.board.id) {
        const reason = parsed.issues.some((i) => i.kind === 'unsupported-version')
          ? 'unsupported-version'
          : 'missing-board'
        throw new StoreError('board-unreadable', { reason })
      }
      let dropped: Awaited<ReturnType<typeof dropDanglingAssets>>
      try {
        dropped = await dropDanglingAssets(h.dir, parsed.state)
      } catch (e) {
        this.opts.log.error('asset scan failed', { code: errCode(e) })
        throw new StoreError('storage')
      }
      const backup = dropped.state
      const damaged = parsed.integrity !== 'ok' || parsed.issues.length > 0
      const result = await this.install(h, {
        integrity: 'restored',
        reached: [backup.board.revision],
        prepare: async () => ({
          state: backup,
          issues: [...parsed.issues, ...dropped.issues],
          // A clean backup short of asset files only: its bytes need no copy.
          source: damaged
            ? { path: join(h.dir, 'backups', file), label: `backup-${parsed.integrity}` }
            : null,
        }),
      })
      const lost = backup === parsed.state ? 0 : parsed.state.assets.size - backup.assets.size
      if (lost > 0) this.opts.log.warn('restore dropped assets', { count: lost })
      this.opts.log.info('board restored', { revision: result.revision })
      return { revision: result.revision, safetyBackup: result.safetyBackup }
    })
  }

  /**
   * Make `state`, an imported file's records under this board's record (`importBoard`), the
   * board, through the install a restore takes (`install`): a safety backup of the board as it
   * stands, then the photos staged in `stagedAssets` (`assets/<id>/` directories under fresh
   * ids) moved into the board's `assets/`, then the records at the next revision, `imported`.
   * Asset records whose files are not there after the move are dropped, and the notes showing
   * them lose their image; those and `issues` (what staging dropped) go to `repairs.jsonl`.
   *
   * The photos move in only under the board's writer, once the new snapshot is serialized and
   * right before it is written: first `moved.json` in the import's directory names them and that
   * snapshot (`writeMovedList`), so a crash before the snapshot is in leaves directories that the
   * next start removes (`removeImportDirs`: the board's eof is not the one named), and a failure
   * leaves them for `rollBackImport`, which the commit route runs at once. Nothing is
   * credited back to the quota here: the replaced board's photos stay until the asset sweep finds
   * no retained backup showing them.
   */
  async replaceBoard(
    userId: string,
    boardId: string,
    state: BoardState,
    stagedAssets: string,
    issues: readonly LoadIssue[] = [],
  ): Promise<RestoreResult> {
    return this.withHandle(userId, boardId, async (h) => {
      // The import's own directory: `assets/` in it is laid out as a board's is.
      const importDir = dirname(stagedAssets)
      const result = await this.install(h, {
        integrity: 'imported',
        reached: [],
        prepare: async () => {
          const imported: BoardState = {
            ...state,
            board: { ...h.state.board, name: state.board.name },
          }
          const dropped = await dropDanglingAssets(importDir, imported)
          return { state: dropped.state, issues: [...issues, ...dropped.issues], source: null }
        },
        place: async (sha256) => {
          await writeMovedList(importDir, {
            ids: await assetDirIds(importDir),
            sha256,
            before: await boardEofSha(h.dir),
          })
          await moveAssetDirs(stagedAssets, h.dir)
          this.opts.faults.hit('import:after-asset-move')
        },
        // The photos are the board's now: no later start may take them for leftovers.
        installed: async () => {
          if (!(await clearMovedList(importDir))) {
            this.opts.log.error('import moved list left', { reason: 'unlink-and-truncate-failed' })
          }
        },
      })
      this.opts.log.info('board imported', {
        revision: result.revision,
        count: result.state.notes.size,
      })
      return { revision: result.revision, safetyBackup: result.safetyBackup }
    })
  }

  /**
   * Install a whole new state for the board `h` (a restore, an import). Caller holds the board's
   * mutex, which every commit group holds while it writes, so it lands between two groups:
   *
   * 1. The current board is backed up whatever the hour (the safety backup: a copy of
   *    `board.jsonl`, or the board serialized when the journal holds commits), so nothing is lost
   *    and restoring that backup undoes this.
   * 2. `prepare` gives the state to install, what its repair dropped and the damaged file it came
   *    from; those are kept the way a damaged load keeps them (`preserveDamage`: the file's bytes
   *    and rejected lines in `quarantine/`, repairs in `repairs.jsonl`); the notice counts them.
   * 3. The state's records become the board at a revision above every one it reached (the
   *    current one, every backup's name, `reached`), so replicas and the ring can never mistake
   *    it for one they have seen. The current client marks are kept: a batch committed before
   *    is still answered as a duplicate. Once that snapshot is serialized, `place` puts what it
   *    needs in place (an import's photos), then the snapshot is written.
   * 4. The handle takes the new state, the ring is forgotten, the recovery notice says
   *    `integrity` (naming the safety backup) and subscribers are told to `reset`.
   *
   * From before the board changes until that notice is in, `restore.json` marks the install
   * as under way (`writeRestoreIntent`): a load that finds the old board beside it says it was
   * cut short (`restore-interrupted`, `import-interrupted`), never that it happened.
   */
  private async install(
    h: Handle,
    o: {
      integrity: 'restored' | 'imported'
      reached: number[]
      prepare(): Promise<{
        state: BoardState
        issues: LoadIssue[]
        source: { path: string; label: string } | null
      }>
      /**
       * Runs once the new snapshot is serialized (its eof `sha256` known), right before it is
       * written: what must be in place for it (an import's photos).
       */
      place?(sha256: string): Promise<void>
      /** Runs first once the new snapshot is installed; it must not throw. */
      installed?(): Promise<void>
    },
  ): Promise<RestoreResult & { state: BoardState }> {
    const nowDate = this.opts.clock.now()
    let now: string
    try {
      now = nowDate.toISOString()
    } catch (e) {
      throw invalid('invalid clock time', e)
    }

    const current = h.state
    let safetyBackup: string
    let next: BoardState
    let out: BoardText
    let region: RegionIndex
    let notice: RecoveryNotice
    try {
      // board.jsonl holds the current board only while the journal has no commits.
      const parts =
        h.journal && h.journal.commits > 0 ? (await serializeSliced(current)).parts : undefined
      safetyBackup = await forceBackup(
        h.dir,
        nowDate,
        current.board.revision,
        this.opts.faults,
        parts,
      )
      const { state, issues, source } = await o.prepare()
      let kept: PreservedDamage = { preservedAs: null, quarantinedLines: 0, repairs: 0 }
      if (source || issues.length > 0) {
        kept = await preserveDamage(h.dir, {
          source,
          issues,
          detected: nowDate,
          faults: this.opts.faults,
        })
      }
      const known = [
        current.board.revision,
        ...o.reached,
        ...(await listBackups(h.dir)).map((b) => b.revision),
      ]
      next = {
        ...state,
        board: {
          ...state.board,
          revision: Math.max(...known) + 1,
          clients: { ...state.board.clients, ...current.board.clients },
          updatedAt: now,
        },
      }
      const sliced = await serializeSliced(next)
      out = { parts: sliced.parts, bytes: sliced.bytes, served: sliced.served }
      region = await RegionIndex.build(next.notes)
      notice = {
        integrity: o.integrity,
        detectedAt: now,
        ...kept,
        latestBackup: {
          file: safetyBackup,
          revision: current.board.revision,
          notes: current.notes.size,
          yarns: current.yarns.size,
        },
      }
      await o.place?.(sliced.sha256)
      const tmp = join(h.dir, `${BOARD_FILE}.tmp`)
      await writeTmpDurable(tmp, sliced.parts, this.opts.faults, 'snapshot', sliced.bytes)
      // From here until the notice is in, a load that finds the old board says the install
      // was cut short (never that it happened).
      await writeRestoreIntent(
        h.dir,
        { revision: next.board.revision, sha256: sliced.sha256, notice },
        this.opts.faults,
      )
      this.opts.faults.hit('restore:after-intent')
      const ref = { revision: next.board.revision, sha256: sliced.sha256 }
      const installed = await installSnapshot(h.dir, {
        tmp,
        ref,
        tail: [],
        journal: h.journal !== null,
        backup: null,
        faults: this.opts.faults,
      })
      h.snapshot = { ...ref, stamp: installed.stamp }
      h.journal = { bytes: installed.journalBytes, commits: 0 }
    } catch (e) {
      this.opts.log.error(o.integrity === 'imported' ? 'import failed' : 'restore failed', {
        code: errCode(e),
      })
      // The file may hold either board now; the next access reloads whatever is on disk.
      this.evict(h)
      throw new StoreError('storage')
    }
    await o.installed?.()
    const revision = next.board.revision
    h.state = next
    h.served.set(next, out)
    h.replacedAt = revision
    h.region = region
    h.backupHour = hourOf(nowDate)
    h.epoch++
    h.ring.clear()
    this.snapshots++
    h.recovery = notice
    let noticeIn = false
    try {
      await writeRecovery(h.dir, notice, this.opts.faults)
      noticeIn = true
    } catch (e) {
      // The install itself is durable; the next load finishes the notice from the marker.
      this.opts.log.warn('recovery notice write failed', { code: errCode(e) })
    }
    // The marker goes only once the notice is in: a load that still finds it beside this
    // snapshot writes the notice from it (or drops it, the notice being there already).
    if (noticeIn) {
      try {
        await clearRestoreIntent(h.dir)
      } catch (e) {
        this.opts.log.warn('restore marker clear failed', { code: errCode(e) })
      }
    }
    this.hub.publish(h.key, { type: 'reset', revision })
    return { revision, safetyBackup, state: next }
  }

  /**
   * Remove what imports left behind when the server stopped: every `import-*` directory beside a
   * board (`importBoard`'s staging; staged imports live in memory only). Run once at startup,
   * before any request, and before any board loads. Resolves to the import directories removed,
   * and the photo directories of imports cut short after their move (`removeImportDirs`).
   */
  async removeImportLeftovers(): Promise<{ dirs: number; photos: number }> {
    return removeImportDirs(this.opts.dataDir, this.opts.log)
  }

  /**
   * After `replaceBoard` threw for the import staged in `importDir`: the photos it moved into the
   * board go back out and its directory goes (`rollBackImport`), under the board's writer, so no
   * load or commit reads the board meanwhile. Resolves to the photo bytes removed, or why it is
   * left, `moved.json` and all, for the next start.
   */
  rollBackImport(userId: string, boardId: string, importDir: string): Promise<RollBack> {
    this.assertOpen()
    const key = `${userId}/${boardId}`
    const dir = this.dirOf(userId, boardId)
    return this.whileLive(userId, () => this.mutex.run(key, () => rollBackImport(dir, importDir)))
  }

  // ---- account deletion ---------------------------------------------------------------------

  /**
   * Run `fn`, which may write under `users/<userId>/`, unless the user's deletion has begun (then
   * `not-found`). `beginDeletion` waits for every such run that started before it.
   */
  whileLive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    if (this.deleting.has(userId)) return Promise.reject(new StoreError('not-found'))
    // Checked and registered in the same tick: no run can start unseen by a deletion.
    const p = (async () => fn())()
    let ops = this.userOps.get(userId)
    if (!ops) {
      ops = new Set()
      this.userOps.set(userId, ops)
    }
    const running = ops
    running.add(p)
    const done = () => {
      running.delete(p)
      if (running.size === 0 && this.userOps.get(userId) === running) this.userOps.delete(userId)
    }
    p.then(done, done)
    return p
  }

  /**
   * The account deletion's first step: refuse anything new for the user, wait for what is running,
   * then close their streams and boards (`closeUser`). Afterwards nothing writes to their directory.
   */
  async beginDeletion(userId: string): Promise<void> {
    this.deleting.add(userId)
    // Long work of theirs (an import's upload) stops now rather than holding the deletion.
    for (const hook of [...(this.deletionHooks.get(userId) ?? [])]) hook()
    await Promise.allSettled([...(this.userOps.get(userId) ?? [])])
    await this.closeUser(userId)
    for (const retry of [this.compactRetryAt, this.backupRetryAt]) {
      for (const key of retry.keys()) if (key.startsWith(`${userId}/`)) retry.delete(key)
    }
  }

  /**
   * Call `hook` when `userId`'s deletion begins (before it waits for their running operations),
   * so long work of theirs can stop. Returns the function that unregisters it.
   */
  onDeletion(userId: string, hook: () => void): () => void {
    let hooks = this.deletionHooks.get(userId)
    if (!hooks) {
      hooks = new Set()
      this.deletionHooks.set(userId, hooks)
    }
    const set = hooks
    set.add(hook)
    return () => {
      set.delete(hook)
      if (set.size === 0 && this.deletionHooks.get(userId) === set)
        this.deletionHooks.delete(userId)
    }
  }

  /** Call `hook` once when the store starts closing (timers and uploads of routes stop). */
  onClose(hook: () => void): void {
    this.closeHooks.add(hook)
  }

  /** The deletion failed and the user's directory is back: their boards work again. */
  cancelDeletion(userId: string): void {
    this.deleting.delete(userId)
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  /** Let pending writes finish, tell subscribers `closed`, drop them and evict the user's boards. */
  async closeUser(userId: string): Promise<void> {
    const prefix = `${userId}/`
    const keys = new Set([
      ...[...this.cache.keys()].filter((k) => k.startsWith(prefix)),
      ...this.hub.keys(userId),
    ])
    await Promise.all([...keys].map((key) => this.closeKey(key)))
  }

  /**
   * Finish every pending write and running compaction, close every subscription and stop all
   * timers. A journal not compacted yet stays: the next start replays it.
   */
  async close(): Promise<void> {
    this.closed = true
    for (const hook of [...this.closeHooks]) hook()
    this.closeHooks.clear()
    const keys = new Set([...this.cache.keys(), ...this.hub.keys()])
    for (const h of this.cache.values()) {
      this.clearIdle(h)
      this.clearCompactTimer(h)
    }
    await Promise.all([...keys].map((key) => this.closeKey(key)))
    await Promise.all([...this.keeping])
  }

  private async closeKey(key: string): Promise<void> {
    for (;;) {
      const cached = this.cache.get(key)
      if (cached) this.clearCompactTimer(cached)
      if (cached?.drain) await cached.drain
      await this.compactions.get(key)?.catch(() => {})
      const done = await this.mutex.run(key, async () => {
        const h = this.cache.get(key)
        // A batch slipped in after the drain finished, or started a compaction: wait for it too.
        if (h && (h.drain || h.queue.length > 0)) return false
        if (this.compactions.has(key)) return false
        this.hub.publish(key, { type: 'closed' })
        this.hub.drop(key)
        if (h) {
          await this.keepSummaryOf(h)
          this.evict(h)
        }
        return true
      })
      if (done) return
    }
  }

  // ---- internals: access --------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new StoreError('storage', { reason: 'closed' })
  }

  private userDirOf(userId: string): string {
    try {
      return userDir(this.opts.dataDir, userId)
    } catch {
      throw new StoreError('not-found')
    }
  }

  private dirOf(userId: string, boardId: string): string {
    try {
      return boardDir(this.opts.dataDir, userId, boardId)
    } catch {
      throw new StoreError('not-found')
    }
  }

  private async boardIds(udir: string): Promise<string[]> {
    try {
      const entries = await readdir(join(udir, 'boards'), { withFileTypes: true })
      return entries.filter((e) => e.isDirectory() && isId(e.name, 'board')).map((e) => e.name)
    } catch (e) {
      if (isEnoent(e)) return []
      this.opts.log.error('board list failed', { code: errCode(e) })
      throw new StoreError('storage')
    }
  }

  /**
   * Run `fn` under the board's mutex on its up-to-date handle: loaded if not cached, reloaded if
   * the file changed behind our back. `fn` must not return a promise that waits on this mutex.
   */
  private async withHandle<T>(
    userId: string,
    boardId: string,
    fn: (h: Handle) => T | Promise<T>,
  ): Promise<T> {
    this.assertOpen()
    const dir = this.dirOf(userId, boardId)
    const key = `${userId}/${boardId}`
    return this.whileLive(userId, () =>
      this.mutex.run(key, async () => {
        const h = this.cache.get(key) ?? (await this.load(key, dir))
        await this.checkExternalEdit(h)
        this.touch(h)
        return fn(h)
      }),
    )
  }

  /**
   * The board's summary. A board that is not cached is not parsed when its kept summary still
   * matches its files (`summary.json`); otherwise it is loaded, and kept in the cache for the read
   * that follows when there is room (a listing never evicts another board: it must not churn the
   * LRU).
   */
  private async summary(userId: string, boardId: string): Promise<BoardSummary> {
    const dir = this.dirOf(userId, boardId)
    const key = `${userId}/${boardId}`
    return this.whileLive(userId, () =>
      this.mutex.run(key, async () => {
        const cached = this.cache.get(key)
        if (cached) {
          await this.checkExternalEdit(cached)
          return summaryOf(cached.state, cached.recovery)
        }
        let kept: Awaited<ReturnType<typeof readKeptSummary>> = null
        try {
          kept = await readKeptSummary(dir)
        } catch (e) {
          this.opts.log.warn('summary read failed', { code: errCode(e) })
        }
        if (kept) {
          let recovery: RecoveryNotice | null
          try {
            recovery = await readRecovery(dir)
          } catch (e) {
            this.opts.log.error('recovery read failed', { code: errCode(e) })
            throw new StoreError('storage')
          }
          return { ...kept, recovered: recovery !== null }
        }
        if (this.cache.size < this.opts.cacheSize) {
          const h = await this.load(key, dir)
          this.touch(h)
          return summaryOf(h.state, h.recovery)
        }
        const loaded = await this.loadDir(dir)
        return summaryOf(loaded.state, loaded.recovery)
      }),
    )
  }

  /**
   * Keep the summary of `h`, a handle being dropped in good order, so the next listing does not
   * parse the board. Housekeeping only: a failure is logged.
   */
  private async keepSummaryOf(h: Handle): Promise<void> {
    if (this.deleting.has(userOf(h.key))) return
    const { id, name, revision, createdAt, updatedAt } = h.state.board
    try {
      await keepSummary(
        h.dir,
        { id, name, revision, createdAt, updatedAt },
        h.snapshot.stamp,
        h.journal?.bytes ?? null,
      )
    } catch (e) {
      this.opts.log.warn('summary write failed', { code: errCode(e) })
    }
  }

  /**
   * Drop an idle handle (`evictable`) and keep its summary. The write runs under the board's
   * mutex, so a reload cannot start under it; `close` waits for it.
   */
  private retire(h: Handle): void {
    this.evict(h)
    const userId = userOf(h.key)
    if (this.closed || this.deleting.has(userId)) return
    const p = this.whileLive(userId, () =>
      this.mutex.run(h.key, () =>
        this.cache.has(h.key) ? Promise.resolve() : this.keepSummaryOf(h),
      ),
    ).catch(() => {})
    this.keeping.add(p)
    void p.then(() => this.keeping.delete(p))
  }

  /** `loadBoardDir` then `pruneBackups`, with every outcome other than `ok` as a StoreError. */
  private async loadDir(dir: string, loadOpts: LoadOptions = {}): Promise<Loaded> {
    let outcome: LoadOutcome
    this.loads++
    try {
      outcome = await loadBoardDir(dir, this.opts, loadOpts)
    } catch (e) {
      this.opts.log.error('board load failed', { code: errCode(e) })
      throw new StoreError('storage')
    }
    if (outcome.kind === 'absent') throw new StoreError('not-found')
    if (outcome.kind === 'unreadable') {
      throw new StoreError('board-unreadable', { reason: outcome.reason })
    }
    try {
      await pruneBackups(dir, this.opts.clock.now())
    } catch (e) {
      // Housekeeping only: the board itself loaded fine.
      this.opts.log.warn('backup prune failed', { code: errCode(e) })
    }
    return outcome
  }

  /** Caller holds the board's mutex. */
  private async load(key: string, dir: string): Promise<Handle> {
    return this.loadHandle(key, dir)
  }

  private async loadHandle(key: string, dir: string): Promise<Handle> {
    const loaded = await this.loadDir(dir)
    // In slices too: `RegionIndex.of` held the loop for 42–53 ms at 100,000 notes on a Mac.
    const region = await RegionIndex.build(loaded.state.notes, LOAD_SLICE_MS)
    let backupHour: number | null = null
    try {
      const newest = (await listBackups(dir))[0]
      if (newest) backupHour = hourOf(newest.time)
    } catch (e) {
      // Only means an extra compaction this hour.
      this.opts.log.warn('backup list failed', { code: errCode(e) })
    }
    const h: Handle = {
      key,
      dir,
      state: loaded.state,
      served: new ServedText(async (s) => {
        const { parts, bytes, served } = await serializeSliced(s)
        return { parts, bytes, served }
      }),
      snapshot: loaded.snapshot,
      journal: loaded.journal,
      replacedAt: loaded.recovery ? loaded.state.board.revision : 0,
      region,
      epoch: 0,
      compaction: null,
      compactTimer: null,
      backupHour,
      recovery: loaded.recovery,
      ring: new CommitRing(this.opts.ringCommits, this.opts.ringBytes),
      queue: [],
      inFlight: new Map(),
      drain: null,
      evicted: false,
      idleTimer: null,
    }
    this.cache.set(key, h)
    // Subscribers can outlive a handle (one evicted after a failed write); a recovery is news.
    if (loaded.recoveredNow) {
      this.hub.publish(key, { type: 'reset', revision: loaded.state.board.revision })
    }
    this.trimCache()
    // A journal left from before a restart is compacted once the board has been idle a while.
    this.scheduleCompaction(h, false)
    this.boardReady(key)
    return h
  }

  /**
   * Review Focus 4. Caller holds the board's mutex. If `board.jsonl` is not the file this handle
   * last wrote or loaded, reload it through recovery (the edited bytes are quarantined, the edit is
   * kept, the journal goes to quarantine, and the revision lands above every one this board
   * reached, so a restored older copy can never reuse revisions replicas have seen), forget the
   * ring and tell subscribers to reset. Identical bytes (a touch, a copy of the same file) are no
   * change. A board that is now gone or unreadable is evicted and its subscribers are closed.
   */
  private async checkExternalEdit(h: Handle): Promise<void> {
    const file = join(h.dir, BOARD_FILE)
    let stamp: FileStamp | null
    try {
      stamp = await stampOf(file)
      if (stamp && sameStamp(stamp, h.snapshot.stamp)) return
      // Read after the stat: if the file changes again in between, the stamp is stale and the
      // next check looks again.
      const text = stamp ? await readTextIfPresent(file) : null
      if (stamp && text !== null && isSnapshotText(text, h.snapshot)) {
        h.snapshot = { ...h.snapshot, stamp }
        return
      }
    } catch (e) {
      this.opts.log.error('board stat failed', { code: errCode(e) })
      throw new StoreError('storage')
    }

    let loaded: Loaded
    try {
      loaded = await this.loadDir(h.dir, { cachedRevision: h.state.board.revision })
    } catch (e) {
      if (e instanceof StoreError && e.code !== 'storage') {
        this.evict(h)
        this.hub.publish(h.key, { type: 'closed' })
        this.hub.drop(h.key)
      }
      throw e
    }
    const region = await RegionIndex.build(loaded.state.notes, LOAD_SLICE_MS)
    h.state = loaded.state
    h.served.clear()
    h.snapshot = loaded.snapshot
    h.journal = loaded.journal
    if (loaded.recovery) h.replacedAt = loaded.state.board.revision
    h.region = region
    h.epoch++
    h.recovery = loaded.recovery
    h.ring.clear()
    this.opts.log.warn('board changed on disk', { revision: loaded.state.board.revision })
    this.hub.publish(h.key, { type: 'reset', revision: loaded.state.board.revision })
  }

  // ---- internals: the writer ----------------------------------------------------------------

  /**
   * Run `check` on the board's handle under its mutex. It answers a duplicate itself, throws a
   * StoreError, or returns a job, which is queued for the drain loop; the returned promise settles
   * once the job's snapshot is durable (or it failed).
   */
  private async enqueue(
    userId: string,
    boardId: string,
    check: (h: Handle) => CommitAck | Omit<Pending, 'resolve' | 'reject'>,
  ): Promise<CommitAck> {
    const r = await this.withHandle(userId, boardId, (h) => this.queueJob(h, check))
    return 'ack' in r ? r.ack : r.wait
  }

  /**
   * Caller holds the board's mutex: `check`'s job queued for the drain loop, or its duplicate ack.
   * Wrapped in an object: returning the ack promise itself would hold the mutex until it settles.
   */
  private queueJob(
    h: Handle,
    check: (h: Handle) => CommitAck | Omit<Pending, 'resolve' | 'reject'>,
  ): { ack: CommitAck } | { wait: Promise<CommitAck> } {
    const job = check(h)
    if ('duplicate' in job) return { ack: job }
    const wait = new Promise<CommitAck>((resolve, reject) => {
      h.queue.push({ ...job, resolve, reject })
    })
    h.inFlight.set(job.flightKey, (h.inFlight.get(job.flightKey) ?? 0) + 1)
    if (!h.drain) h.drain = this.drain(h)
    return { wait }
  }

  /** Tell `onBoardReady` about the board of `key`, in a later turn, unless the store closed. */
  private boardReady(key: string): void {
    const hook = this.opts.onBoardReady
    if (!hook || this.closed) return
    setImmediate(() => {
      if (!this.closed) hook(userOf(key), key.slice(key.indexOf('/') + 1))
    })
  }

  /**
   * The board's single writer. Before each group it yields one macrotask outside the mutex, so
   * batches arriving in the same I/O turn can pass their checks and join the group;
   * the group itself is committed under the mutex.
   */
  private async drain(h: Handle): Promise<void> {
    try {
      while (h.queue.length > 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        await this.mutex.run(h.key, () => this.commitGroup(h))
      }
    } finally {
      h.drain = null
      if (!h.evicted) {
        this.armIdle(h)
        this.trimCache()
      }
    }
  }

  /** Caller holds the board's mutex. Settles every batch it takes off the queue; never throws. */
  private async commitGroup(h: Handle): Promise<void> {
    const group = h.queue.splice(0)
    const results = new Map<Pending, CommitAck | StoreError>()
    try {
      await this.writeGroup(h, group, results)
    } catch (e) {
      const err = e instanceof StoreError ? e : new StoreError('storage')
      for (const p of group) if (!results.has(p)) results.set(p, err)
    }
    for (const p of group) {
      const n = (h.inFlight.get(p.flightKey) ?? 1) - 1
      if (n > 0) h.inFlight.set(p.flightKey, n)
      else h.inFlight.delete(p.flightKey)
      const r = results.get(p) ?? new StoreError('storage')
      if (r instanceof StoreError) p.reject(r)
      else p.resolve(r)
    }
  }

  private async writeGroup(
    h: Handle,
    group: Pending[],
    results: Map<Pending, CommitAck | StoreError>,
  ): Promise<void> {
    // Dropped after a failed write: a fresh handle (reloaded from disk) takes the retries.
    if (h.evicted) throw new StoreError('storage')
    // The checks ran under the mutex, but the file may have changed since: never write past it.
    await this.checkExternalEdit(h)

    const nowDate = this.opts.clock.now()
    let now: string
    try {
      now = nowDate.toISOString()
    } catch (e) {
      throw invalid('invalid clock time', e)
    }
    let s = h.state
    const done: Array<{ p: Pending; applied: readonly Op[]; ack: CommitAck; event: CommitEvent }> =
      []
    // A large group (one batch over the threshold, or many small ones) is a
    // `Slicer` job: its commits and their journal lines yield between steps. A 400-op batch of
    // long notes beside a compaction's slice was one 8.6 ms step on a Mac, 145–160 ms on a
    // Raspberry Pi. A small group (a save) commits in the request's own turn, as before.
    let slicer: Slicer | null = null
    let opsSeen = 0
    try {
      const notesWritten = new Set<string>()
      for (const p of group) {
        const { mark } = p
        const prior =
          mark && Object.hasOwn(s.board.clients, mark.clientId)
            ? s.board.clients[mark.clientId]
            : undefined
        if (mark && prior && mark.seq <= prior.lastSeq) {
          const { clientId, seq } = mark
          results.set(p, {
            clientId,
            seq,
            revision: prior.lastRevision,
            now: null,
            duplicate: true,
          })
          continue
        }
        opsSeen += p.ops.length
        if (slicer === null && opsSeen > INLINE_OPS) slicer = await Slicer.start(SLICE_MS)
        if (p.guard && !p.guard(s)) {
          results.set(p, new StoreError('rejected', { opError: new OpError('conflict', 'stale') }))
          continue
        }
        let applied: readonly Op[]
        let committed: Committed
        try {
          if (mark && p.baseRevision !== undefined && p.baseRevision < s.board.revision) {
            checkMove(s, p.ops, p.baseRevision)
            checkBlocks(s, p.ops, p.baseRevision, h.replacedAt)
          }
          applied = p.ops
          checkTrash(s, applied, Date.parse(now))
          applied = stampTrashed(s, applied, now)
          if (slicer?.due()) await slicer.pause()
          // The books whose cards the batch changed are stamped in its revision (`book.cards`): the batch then counts as rewritten, so the ack carries the ops and the
          // commit `sent`, as for `trashedAt`. A batch that changes no card set is as before.
          committed = await stepped(
            commitSteps(s, applied, now, mark, { stamp: cardStamps }),
            slicer,
          )
          if (committed.stamps.length > 0) applied = [...applied, ...committed.stamps]
        } catch (e) {
          results.set(
            p,
            e instanceof BlockStale
              ? new StoreError('block-stale', { blockId: e.blockId })
              : e instanceof OpError
                ? new StoreError('rejected', { opError: e })
                : invalid('batch could not be applied', e),
          )
          continue
        }
        for (const id of committed.written.notes) notesWritten.add(id)
        s = committed.state
        const revision = s.board.revision
        const clientId = mark?.clientId ?? null
        const seq = mark?.seq ?? null
        const rewritten = applied !== p.ops
        // What the page posted, by digest: it knows its own batch by it.
        const sent = rewritten ? await digestSteps(p.ops, slicer) : undefined
        done.push({
          p,
          applied,
          ack: {
            clientId,
            seq,
            revision,
            now,
            duplicate: false,
            ...(rewritten ? { ops: [...applied] } : {}),
          },
          event: {
            revision,
            ops: [...applied],
            originClientId: clientId,
            seq,
            now,
            ...(sent !== undefined ? { sent } : {}),
          },
        })
      }
      const lines: string[] = []
      const opsBytes: number[] = []
      for (const d of done) {
        const line = {
          rev: d.ack.revision,
          ops: d.applied,
          now,
          origin: d.p.mark,
          ...(d.event.sent !== undefined ? { sent: d.event.sent } : {}),
        }
        const encoded = await stepped(encodeCommitSteps(line), slicer)
        lines.push(encoded.line)
        opsBytes.push(encoded.opsBytes)
      }
      if (done.length === 0) return
      // The journal write is I/O, not this job's slice.
      slicer?.note()

      let bytes: number
      try {
        if (!h.journal) {
          const ref = { revision: h.snapshot.revision, sha256: h.snapshot.sha256 }
          h.journal = { bytes: await rotateJournal(h.dir, ref, [], this.opts.faults), commits: 0 }
        }
        bytes = await appendJournal(h.dir, lines, this.opts.faults)
      } catch (e) {
        this.opts.log.error('journal append failed', {
          code: errCode(e),
          revision: s.board.revision,
        })
        for (const d of done) results.set(d.p, new StoreError('storage'))
        // The journal may end in some of these lines, or half of one; the next access reloads it.
        this.evict(h)
        // The slice the write began is I/O, not the job's: the `finally` records none.
        slicer = null
        return
      }
      // The new state, its journal counts and a running compaction's tail, in one synchronous
      // step: a compaction a timer starts (outside the mutex) takes `h.state` and from then on
      // this commit's lines must already be in its snapshot, never in its tail too.
      h.state = s
      h.served.clear()
      h.journal.bytes += bytes
      h.journal.commits += lines.length
      h.compaction?.tail.push(...lines)
      this.appends++
      // Then, the job's turn again: the region index (readers see it under the mutex only).
      await slicer?.resume()
      await h.region.updateSliced(s.notes, notesWritten, slicer)
      for (const [i, d] of done.entries()) {
        h.ring.push(d.event, opsBytes[i])
        this.hub.publish(h.key, { type: 'commit', commit: d.event })
        results.set(d.p, d.ack)
      }
      this.scheduleCompaction(h, true)
    } finally {
      slicer?.note()
    }
  }

  // ---- internals: compaction ----------------------------------------------------------------

  /**
   * With `now`, compact at once when the journal has passed a size threshold or this UTC hour has
   * no backup yet, unless a failure asked to wait; otherwise once the board has gone
   * `compactIdleMs` without a commit. Nothing to do for an empty journal.
   */
  private scheduleCompaction(h: Handle, now: boolean): void {
    this.clearCompactTimer(h)
    if (this.closed || h.evicted || !h.journal || h.journal.commits === 0) return
    const t = this.opts.clock.now()
    const due =
      h.journal.commits >= (this.opts.journalMaxCommits ?? JOURNAL_MAX_COMMITS) ||
      h.journal.bytes >= (this.opts.journalMaxBytes ?? JOURNAL_MAX_BYTES) ||
      ((this.opts.compactEveryHour ?? true) &&
        h.backupHour !== hourOf(t) &&
        t.getTime() >= (this.backupRetryAt.get(h.key) ?? 0))
    if (now && due && t.getTime() >= (this.compactRetryAt.get(h.key) ?? 0)) {
      this.compactInBackground(h)
      return
    }
    h.compactTimer = setTimeout(() => {
      h.compactTimer = null
      this.compactInBackground(h)
    }, this.opts.compactIdleMs ?? COMPACT_IDLE_MS)
    h.compactTimer.unref()
  }

  private compactInBackground(h: Handle): void {
    // A running compaction schedules the next one when it ends.
    if (this.compactions.has(h.key) || h.evicted || this.closed) return
    this.startCompaction(h).catch((e) => {
      // A deletion in progress refuses it; the account's data is going away.
      if (e instanceof StoreError && e.code === 'not-found') return
      this.opts.log.error('compaction failed', { code: errCode(e) })
    })
  }

  /** The board's compaction: the running one, or a new one. Counted as the user's operation. */
  private startCompaction(h: Handle): Promise<CompactResult> {
    const running = this.compactions.get(h.key)
    if (running) return running
    const p = this.whileLive(userOf(h.key), () => this.runCompaction(h))
    this.compactions.set(h.key, p)
    const settle = (ok: boolean) => {
      if (this.compactions.get(h.key) === p) this.compactions.delete(h.key)
      // After a failure, commits start no compaction for the idle time (a full disk would
      // otherwise retry on every commit), even on a handle reloaded after this one was evicted;
      // the idle timer tries again.
      if (ok) this.compactRetryAt.delete(h.key)
      else {
        const wait = this.opts.compactIdleMs ?? COMPACT_IDLE_MS
        this.compactRetryAt.set(h.key, this.opts.clock.now().getTime() + wait)
      }
      if (this.cache.get(h.key) !== h) return
      this.scheduleCompaction(h, ok)
      this.trimCache()
      if (ok) this.boardReady(h.key)
    }
    p.then(
      () => settle(true),
      () => settle(false),
    )
    return p
  }

  /**
   * Fold the journal into a fresh snapshot, holding the event loop for at most one slice at a
   * time and the mutex only for the final steps:
   *
   * 1. Take the current state (its maps are persistent, so later commits leave this copy alone).
   *    From here on, each commit's lines are also kept in `compaction.tail`.
   * 2. Outside the mutex: serialize it in slices into `board.jsonl.next` and fsync; if this hour
   *    has no backup, write the same bytes as its backup-to-be (`backups/<name>.compact.tmp`) and
   *    fsync. A backup that cannot be written never stops the compaction (`hourlyBackup`).
   * 3. Under the mutex: `installSnapshot` (announce, put the backup in place, look
   *    for an external edit of `board.jsonl` just before the rename, rename, rotate the journal
   *    to the tail). Skipped when the handle was dropped or its state replaced meanwhile (a
   *    reload, including that last look, or a restore), since this copy is then stale.
   */
  private async runCompaction(h: Handle): Promise<CompactResult> {
    const t0 = performance.now()
    if (h.evicted || !h.journal || h.journal.commits === 0) {
      return { rev: h.snapshot.revision, ms: 0, maxSliceMs: 0, maxSliceCpuMs: 0 }
    }
    return this.compactHandle(h, t0)
  }

  private async compactHandle(h: Handle, t0: number): Promise<CompactResult> {
    const base = h.state
    const rev = base.board.revision
    const job = { tail: [] as string[], epoch: h.epoch }
    h.compaction = job
    const tmp = join(h.dir, NEXT_SNAPSHOT_FILE)
    let backup: PreparedBackup | null = null
    try {
      const out = await serializeSliced(base)
      await writeTmpDurable(tmp, out.parts, this.opts.faults, 'snapshot', out.bytes)
      // This hour's backup, if it has none: the snapshot's bytes again, written outside the mutex
      // so that putting it in place there is a rename.
      const now = this.opts.clock.now()
      const prepared = await this.hourlyBackup(h, now, rev, { parts: out.parts, bytes: out.bytes })
      backup = prepared === 'failed' ? null : prepared
      const installed = await this.mutex.run(h.key, async () => {
        if (h.evicted || this.cache.get(h.key) !== h || h.epoch !== job.epoch) return false
        const ref = { revision: rev, sha256: out.sha256 }
        try {
          const r = await installSnapshot(h.dir, {
            tmp,
            ref,
            tail: job.tail,
            journal: h.journal !== null,
            backup,
            // Never rename over a board.jsonl edited by hand since the handle last looked: the
            // look reloads it through recovery, which voids this copy.
            beforeRename: async () => {
              await this.checkExternalEdit(h)
              return !h.evicted && h.epoch === job.epoch
            },
            // ...and one synchronous stat right before the rename, closing the gap that check's
            // own awaits leave (a mismatch here is reloaded by the next access).
            unchanged: () => {
              const st = statSync(join(h.dir, BOARD_FILE), { throwIfNoEntry: false })
              return st !== undefined && sameStamp(st, h.snapshot.stamp)
            },
            faults: this.opts.faults,
          })
          if (!r) return false
          h.snapshot = { ...ref, stamp: r.stamp }
          h.journal = { bytes: r.journalBytes, commits: job.tail.length }
          // This hour has a backup now (this one, or one taken earlier in it), unless it could
          // not be written: then a later compaction tries again.
          if (prepared !== 'failed') h.backupHour = hourOf(now)
        } catch (e) {
          // board.jsonl and the journal may be either side of any step: reload them from disk.
          this.evict(h)
          throw e
        }
        this.snapshots++
        return true
      })
      if (!installed) {
        await unlink(tmp).catch(() => {})
        if (backup) await unlink(backup.tmp).catch(() => {})
      }
      return {
        rev,
        ms: performance.now() - t0,
        maxSliceMs: out.maxSliceMs,
        maxSliceCpuMs: out.maxSliceCpuMs,
      }
    } catch (e) {
      await unlink(tmp).catch(() => {})
      if (backup) await unlink(backup.tmp).catch(() => {})
      throw e
    } finally {
      if (h.compaction === job) h.compaction = null
    }
  }

  /**
   * `prepareHourlyBackup`, or `'failed'` when it cannot be written (`backups/` unwritable, a full
   * disk): the compaction goes on without it, a warning is logged once per backoff window, and
   * the hour rule waits for that window before it asks for another compaction, which tries the
   * backup again.
   */
  private async hourlyBackup(
    h: Handle,
    now: Date,
    rev: number,
    source: { parts: readonly Buffer[]; bytes: number },
  ): Promise<PreparedBackup | null | 'failed'> {
    try {
      const b = await prepareHourlyBackup(h.dir, now, rev, source, this.opts.faults)
      this.backupRetryAt.delete(h.key)
      return b
    } catch (e) {
      const t = this.opts.clock.now().getTime()
      if (t >= (this.backupRetryAt.get(h.key) ?? 0)) {
        this.opts.log.warn('backup failed', { code: errCode(e) })
        this.backupRetryAt.set(h.key, t + (this.opts.compactIdleMs ?? COMPACT_IDLE_MS))
      }
      return 'failed'
    }
  }

  private clearCompactTimer(h: Handle): void {
    if (h.compactTimer) clearTimeout(h.compactTimer)
    h.compactTimer = null
  }

  // ---- internals: eviction ------------------------------------------------------------------

  private evictable(h: Handle): boolean {
    return (
      !this.mutex.isHeld(h.key) &&
      !h.drain &&
      h.queue.length === 0 &&
      h.inFlight.size === 0 &&
      !this.compactions.has(h.key) &&
      this.hub.count(h.key) === 0
    )
  }

  /**
   * Drop the handle from the cache. Callers either hold its mutex or have checked `evictable`
   * (nobody holds or waits for the mutex, and this runs synchronously).
   */
  private evict(h: Handle): void {
    h.evicted = true
    this.clearIdle(h)
    this.clearCompactTimer(h)
    if (this.cache.get(h.key) === h) this.cache.delete(h.key)
  }

  /** Evict least recently used idle handles until the cache fits; busy handles are skipped. */
  private trimCache(): void {
    for (const h of this.cache.values()) {
      if (this.cache.size <= this.opts.cacheSize) return
      if (this.evictable(h)) this.retire(h)
    }
  }

  private touch(h: Handle): void {
    this.cache.delete(h.key)
    this.cache.set(h.key, h)
    this.armIdle(h)
  }

  private armIdle(h: Handle): void {
    this.clearIdle(h)
    if (this.closed || h.evicted) return
    h.idleTimer = setTimeout(() => {
      h.idleTimer = null
      if (h.evicted) return
      if (this.evictable(h)) this.retire(h)
      // Busy for now: look again later. A subscribed board is re-armed when its last one leaves.
      else if (this.hub.count(h.key) === 0) this.armIdle(h)
    }, this.opts.idleEvictMs)
    h.idleTimer.unref()
  }

  private clearIdle(h: Handle): void {
    if (h.idleTimer) clearTimeout(h.idleTimer)
    h.idleTimer = null
  }
}
