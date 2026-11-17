import { createHash } from 'node:crypto'
import { link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Block, BoardState, Book } from '@papertie/core'
import { type PreparedBackup, placeBackup } from './backups'
import { type FileStamp, renameDurable } from './durable'
import type { Faults } from './faults'
import { appendJournal, encodeBase, rotateJournal, type SnapshotRef } from './journal'
import { byId, byZ, cmp } from './order'
import type { Jsonl } from './servedText'

/**
 * The longest stretch (wall time) a sliced job holds the event loop before it yields. 4 ms: a major collection can land inside any slice and pause it for its own
 * length (up to 40.7 ms on a Raspberry Pi at a 100,000-note board), so a slice must leave room for one
 * within the 50 ms an iteration may take there. The shorter slices cost nothing measurable on the
 * Mac (a compaction 237–258 ms at 8, 233–241 at 4; a cold load 336 ms at 8, 343–373 at 4).
 */
export const SLICE_MS = 4

/**
 * A cold load's slices (its parse, build, replay and region index): 4 ms, as every job's. At 8 a
 * Raspberry Pi's load took 0.8 s less (3,280 ms against 4,060–4,246 at 4), but the
 * load's 8×-counted bound failed in a full suite run (57 and 67 ms: two scavenges in one 8 ms slice)
 * while it holds at 4, so the bound decides: 4.
 */
export const LOAD_SLICE_MS = SLICE_MS

/** Where a compaction writes its snapshot before the rename (removed on load if left over). */
export const NEXT_SNAPSHOT_FILE = 'board.jsonl.next'

/**
 * A second name for the snapshot a compaction replaces, made just before the rename and removed
 * after it (and on load, if a crash left it). The rename then only takes a name off the old file:
 * replacing the last name of a 43 MB `board.jsonl` freed its blocks inside the synchronous rename,
 * 1.9 ms of the event loop. The blocks are freed by the unlink, off the loop.
 */
export const PREV_SNAPSHOT_FILE = 'board.jsonl.prev'

export interface SlicedText {
  /**
   * The canonical JSONL's UTF-8 bytes, in order, each piece ending at a line's end: together they
   * are `serializeBoard(state)`. Buffers, so the 43 MB of a 100,000-note board live outside the V8
   * heap: held as strings across the slices, they went to the old generation and, garbage once
   * written, drove the major collections that held a Raspberry Pi's loop for 38–67 ms.
   */
  parts: Buffer[]
  bytes: number
  /**
   * What a whole-board read serves (`GET /:id`, ADR-0001): the lines before the first `block`
   * line and an eof over them. The file itself when the board has no blocks.
   */
  served: Jsonl
  /** The eof record's `sha256`: what a journal's base line names the snapshot by. */
  sha256: string
  /** The longest time serialization held the event loop, in ms. */
  maxSliceMs: number
  /** The most CPU time one slice took, in ms: the work's own, whatever else the machine runs. */
  maxSliceCpuMs: number
  /** CPU time of every slice together, in ms. */
  cpuMs: number
  /** How many slices it took. */
  slices: number
}

/**
 * Every sliced job's slices take turns, one in an event-loop iteration: a job that yields waits
 * its turn here, and each iteration's check phase wakes only the longest waiting. A second job
 * running beside the first (a compaction and a whole-board read, a load and a restore) so never
 * adds its slice to the same iteration, and the loop is held for one slice at a time, whatever
 * runs. An immediate queued while the check phase runs belongs to the next iteration.
 *
 * The guarantee covers `Slicer` jobs: every step of a cold load (the journal's decode and lines,
 * the board's pieces and lines, its build, the replay a commit's op at a time, the region index),
 * a compaction's serialization, a commit group of more than `INLINE_OPS` ops in all (its commits
 * an op at a time and its journal lines a few ops at a time), an import, a `changes`
 * answer, the asset sweep's scans. Work that is one step by design shares the iteration with the
 * slice: a request's own handling (its body's JSON parse and the ops' schema check among it: a
 * batch is at most `opsBodyBytes`), the first slice of the iteration's first small region answer
 * (`REGION_INLINE_NOTES`), a small commit group (a save; the drain loop yields with a bare
 * `setImmediate` to gather batches), the backups route's listing, and one journal line's checksum
 * and JSON parse in a load (a batch of up to the ops limit and `opsBodyBytes`).
 */
const waiting: Array<() => void> = []
let turnQueued = false

function nextSlice(): void {
  const next = waiting.shift()
  if (waiting.length > 0) setImmediate(nextSlice)
  else turnQueued = false
  next?.()
}

/** Resolves in a later event-loop iteration, in turn with every other job's slices. */
export function yieldTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    waiting.push(resolve)
    if (!turnQueued) {
      turnQueued = true
      setImmediate(nextSlice)
    }
  })
}

/**
 * This thread's CPU time, ms: `process.threadCpuUsage` where the Node has it (23.9 and later),
 * otherwise the process's (`engines` allows 22.12; the server's other threads, libuv's pool and
 * V8's helpers, then count too, which only makes a slice look longer than it was).
 */
const cpuNow = () => {
  const c =
    typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage()
  return (c.user + c.system) / 1000
}

/** Busy-waits until this thread has spent `ms` more CPU time. */
function spin(ms: number): void {
  const until = cpuNow() + ms
  while (cpuNow() < until) {
    // the slower CPU's extra time
  }
}

let stretch = 1

/**
 * For tests: every slice's work takes `factor` times as long (each stretch of work between two
 * clock reads is followed by `factor - 1` times its CPU time of busy-waiting), as on a CPU that
 * much slower. The budget is wall time, so the slices still end at it: only the work stretches.
 */
export function stretchSlices(factor: number): void {
  stretch = Math.max(1, factor)
}

let slicedCpu = 0

/**
 * The CPU time (ms) every slice of every job has taken in this process so far. A reading taken
 * each event-loop iteration splits the iteration's CPU time into the slices' (bounded by their
 * wall-time budget on any CPU) and the rest (which a CPU n× slower makes n× longer).
 */
export function slicedCpuMs(): number {
  return slicedCpu
}

let longestSlice = 0

/** One slice, as `recordSlices` keeps it. */
export interface SliceSpan {
  /** Its wall-time span, `performance.now()`. */
  from: number
  to: number
  /** Its CPU time, ms. */
  cpuMs: number
  /** Its job's budget, ms. */
  budgetMs: number
  /**
   * Its longest stretch between two clock reads (wall time, ms) and where that was: the step a
   * slice cannot end inside, which a CPU n× slower makes n× longer whatever the budget.
   */
  stepMs: number
  stepFrom: number
  stepTo: number
}

let sliceSpans: SliceSpan[] | null = null

/**
 * For tests: record each slice from now on (`true`), or stop and return them (`false`). A GC
 * pause whose start falls in a span landed inside a slice, and a CPU n× slower would make it n×
 * longer there too, whatever the slice's budget.
 */
export function recordSlices(on: boolean): SliceSpan[] {
  const spans = sliceSpans ?? []
  sliceSpans = on ? [] : null
  return spans
}

/**
 * The most CPU time (ms) one slice of any job has taken since `resetLongestSlice()`: what a test
 * of a whole path (a load) asserts slice by slice, load-proof (each slice ends at its wall budget).
 */
export function longestSliceCpuMs(): number {
  return longestSlice
}

export function resetLongestSlice(): void {
  longestSlice = 0
}

/**
 * Tracks one job's run of work between yields: `due()` once the run has taken `budgetMs` of wall
 * time (on any CPU, a slower one included: the clock is read, never a count of items), then
 * `pause()` to give the loop back until the job's next turn.
 */
export class Slicer {
  private start = performance.now()
  private cpuStart = cpuNow()
  /** CPU time at the last clock read, from which the stretch is measured. */
  private mark = this.cpuStart
  /** CPU time up to which this slice is counted in `cpuMs` and `slicedCpuMs()`. */
  private counted = this.cpuStart
  /** The last clock read, and this slice's longest stretch between two (`SliceSpan`). */
  private lastRead = this.start
  private step = { ms: 0, from: this.start, to: this.start }
  /** The longest slice, wall ms. */
  maxMs = 0
  /** The most CPU one slice took, ms. */
  maxCpuMs = 0
  /** CPU of every slice so far, ms. */
  cpuMs = 0
  slices = 0

  constructor(private readonly budgetMs: number) {}

  /**
   * A job's slicer, once the job has its turn: its first slice too runs in an iteration of its own
   * (a job started inside another's slice, or beside a request, waits one iteration).
   */
  static async start(budgetMs: number): Promise<Slicer> {
    await yieldTurn()
    return new Slicer(budgetMs)
  }

  due(): boolean {
    if (stretch !== 1) {
      this.stretched()
      // Counted as it goes, so a stretched job's last stretch (after its last yield, never noted)
      // is not taken for work outside the slices. Unstretched, `note()` counts it, without a
      // CPU-time read at every check.
      this.count()
    }
    const now = performance.now()
    this.read(now)
    return now - this.start >= this.budgetMs
  }

  private read(now: number): void {
    if (now - this.lastRead > this.step.ms)
      this.step = { ms: now - this.lastRead, from: this.lastRead, to: now }
    this.lastRead = now
  }

  async pause(): Promise<void> {
    this.note()
    await yieldTurn()
    this.begin()
  }

  /** Close the running slice's books (before a yield, or at the end of the job). */
  note(): void {
    this.stretched()
    this.count()
    const end = performance.now()
    this.read(end)
    this.maxMs = Math.max(this.maxMs, end - this.start)
    sliceSpans?.push({
      from: this.start,
      to: end,
      cpuMs: this.counted - this.cpuStart,
      budgetMs: this.budgetMs,
      stepMs: this.step.ms,
      stepFrom: this.step.from,
      stepTo: this.step.to,
    })
    this.maxCpuMs = Math.max(this.maxCpuMs, this.counted - this.cpuStart)
    longestSlice = Math.max(longestSlice, this.counted - this.cpuStart)
    this.slices++
    // A second note() before the next slice counts nothing again.
    this.begin()
  }

  /**
   * Start a new slice after an await that was not `pause()` (a write's I/O), once it is this
   * job's turn again: what ran meanwhile is not this job's, and the iteration the await ended in
   * may hold another job's slice already. Close the running slice with `note()` before the await.
   */
  async resume(): Promise<void> {
    await yieldTurn()
    this.begin()
  }

  private begin(): void {
    this.start = performance.now()
    this.lastRead = this.start
    this.step = { ms: 0, from: this.start, to: this.start }
    this.cpuStart = cpuNow()
    this.mark = this.cpuStart
    this.counted = this.cpuStart
  }

  private count(): void {
    const now = cpuNow()
    this.cpuMs += now - this.counted
    slicedCpu += now - this.counted
    this.counted = now
  }

  private stretched(): void {
    if (stretch === 1) return
    spin((stretch - 1) * (cpuNow() - this.mark))
    this.mark = cpuNow()
  }
}

/** Every `CHECK` items the clock is read. */
export const CHECK = 64
/** The bytes of one serialized piece: hashed, kept and written as one buffer. */
const CHUNK_BYTES = 131_072
const NEWLINE = 0x0a

async function valuesOf<V>(map: ReadonlyMap<string, V>, s: Slicer): Promise<V[]> {
  const out: V[] = []
  // The maps are persistent: iterating across yields sees one version throughout.
  for (const v of map.values()) {
    out.push(v)
    if (out.length % CHECK === 0 && s.due()) await s.pause()
  }
  return out
}

/** Runs this long are sorted natively in one go (well under a slice), then merged in slices. */
const RUN = 2048

/** `items` sorted by `order`, a total order, so the result is the one `Array.sort` gives. */
export async function sortSliced<T>(
  items: T[],
  order: (a: T, b: T) => number,
  s: Slicer,
): Promise<T[]> {
  const n = items.length
  let src = items
  for (let lo = 0; lo < n; lo += RUN) {
    const run = src.slice(lo, lo + RUN).sort(order)
    for (let i = 0; i < run.length; i++) src[lo + i] = run[i] as T
    if (s.due()) await s.pause()
  }
  let dst: T[] = new Array(n)
  for (let width = RUN; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n)
      const hi = Math.min(lo + 2 * width, n)
      let i = lo
      let j = mid
      for (let k = lo; k < hi; k++) {
        if (i < mid && (j >= hi || order(src[i] as T, src[j] as T) <= 0)) dst[k] = src[i++] as T
        else dst[k] = src[j++] as T
        if (k % (CHECK * 16) === 0 && s.due()) await s.pause()
      }
    }
    ;[src, dst] = [dst, src]
  }
  return src
}

/**
 * A state this serializer will not write, since the file would leave part of it out with a valid
 * eof checksum: one not holding every book's blocks (a client's). Its message names no text.
 */
export class SnapshotRefused extends Error {
  readonly code: 'blocks-not-held'
  constructor(code: SnapshotRefused['code'], message: string) {
    super(message)
    this.name = 'SnapshotRefused'
    this.code = code
  }
}

const byShelf = (a: Book, b: Book) => cmp(a.shelfPos, b.shelfPos) || cmp(a.id, b.id)
const byBookPos = (a: Block, b: Block) =>
  cmp(a.bookId, b.bookId) || cmp(a.pos, b.pos) || cmp(a.id, b.id)

/** A buffer of its own for `line`, like every piece: never a slice of Node's shared pool. */
function ownBuffer(line: string): Buffer {
  const out = Buffer.allocUnsafeSlow(Buffer.byteLength(line, 'utf8'))
  out.write(line, 0, 'utf8')
  return out
}

/**
 * `serializeBoard(state)`, byte for byte, without holding the event loop for more than about
 * `budgetMs` at a time: the records are gathered, sorted, stringified and hashed in slices.
 *
 * In the same pass, the whole-board read's text (`served`, ADR-0001): the file's lines up to its
 * first `block` line, then an eof over those lines, from the hash state at that cut. A piece ends
 * at the cut, so `served` shares the file's pieces before it (the same bytes, never a filter);
 * for a board without blocks it is the file itself.
 *
 * Refuses (`SnapshotRefused`) a state that does not hold every book's blocks.
 */
export async function serializeSliced(state: BoardState, budgetMs = SLICE_MS): Promise<SlicedText> {
  if (state.blocksHeld !== 'all') {
    throw new SnapshotRefused('blocks-not-held', 'the state does not hold every book’s blocks')
  }
  const s = await Slicer.start(budgetMs)
  const assets = await sortSliced(await valuesOf(state.assets, s), byId, s)
  const notes = await sortSliced(await valuesOf(state.notes, s), byZ, s)
  const yarns = await sortSliced(await valuesOf(state.yarns, s), byId, s)
  const books = await sortSliced(await valuesOf(state.books, s), byShelf, s)
  const blocks = await sortSliced(await valuesOf(state.blocks, s), byBookPos, s)

  const body = createHash('sha256')
  const parts: Buffer[] = []
  let bytes = 0
  let records = 0
  /** The piece being filled: allocated when a line first needs it, never left unused. */
  let buf: Buffer | null = null
  let at = 0
  // Each record's JSON is written into the piece at once and dies young: no string outlives the
  // record it was made for. Hashing is proportional to the piece, which stays well within a slice.
  const flush = () => {
    if (buf === null || at === 0) return
    const piece = buf.subarray(0, at)
    body.update(piece)
    bytes += at
    parts.push(piece)
    buf = null
    at = 0
  }
  /** Writes one line; true when it flushed a full piece first (a clock read is due then). */
  const put = (json: string): boolean => {
    // At most 3 bytes per UTF-16 unit (a surrogate pair is 4 bytes for 2 units), and the newline;
    // only when that worst case does not fit is the exact size worth its count.
    // No closure is made here: this runs once a record (a function made per call costs, and
    // under tsx's keepNames each one is named too: 11% of a compaction on a Raspberry Pi).
    let size = 3 * json.length + 1
    let exact = false
    if (buf !== null && at + size > buf.length) {
      size = Buffer.byteLength(json, 'utf8') + 1
      exact = true
    }
    let flushed = false
    if (buf !== null && at + size > buf.length) {
      flush()
      flushed = true
    }
    if (buf === null) {
      // A line longer than a piece gets a piece of exactly its size.
      if (size > CHUNK_BYTES && !exact) size = Buffer.byteLength(json, 'utf8') + 1
      buf = Buffer.allocUnsafe(Math.max(CHUNK_BYTES, size))
    }
    at += buf.write(json, at, 'utf8')
    buf[at++] = NEWLINE
    return flushed
  }
  const eofOf = (sha256: string, n: number) =>
    ownBuffer(
      `${JSON.stringify({ type: 'eof', revision: state.board.revision, records: n, sha256 })}\n`,
    )
  let served: Jsonl | null = null
  for (const list of [[state.board], assets, notes, yarns, books, blocks] as const) {
    if (list === blocks && blocks.length > 0) {
      // The cut: what a whole-board read serves ends here, with an eof of its own.
      flush()
      const eof = eofOf(body.copy().digest('hex'), records)
      served = { parts: [...parts, eof], bytes: bytes + eof.length }
    }
    for (const record of list) {
      // The clock is read every CHECK records and after every full piece: a board of long notes
      // (64 lines of 120 KB were 15 ms of work) yields by its bytes too.
      const flushed = put(JSON.stringify(record))
      records++
      if ((flushed || records % CHECK === 0) && s.due()) await s.pause()
    }
  }
  flush()
  const sha256 = body.digest('hex')
  const eof = eofOf(sha256, records)
  bytes += eof.length
  parts.push(eof)
  s.note()
  return {
    parts,
    bytes,
    served: served ?? { parts, bytes },
    sha256,
    maxSliceMs: s.maxMs,
    maxSliceCpuMs: s.maxCpuMs,
    cpuMs: s.cpuMs,
    slices: s.slices,
  }
}

export interface Installed {
  stamp: FileStamp
  journalBytes: number
  /** The backup taken of the new snapshot, if this hour had none. */
  backup: string | null
}

export interface InstallOptions {
  /** The new snapshot, written and fsynced. */
  tmp: string
  ref: SnapshotRef
  /** Encoded commit lines above `ref.revision`: they stay in the new journal. */
  tail: readonly string[]
  /** A journal exists, so the snapshot is announced in it before the rename. */
  journal: boolean
  /**
   * The new snapshot's bytes, written beforehand as this hour's backup (`prepareHourlyBackup`):
   * put in place unless the hour has a backup by now. A file of its own, never a link to
   * `board.jsonl`. Its tmp file is removed whenever it is not put in place.
   */
  backup: PreparedBackup | null
  /** Asked just before the rename; false abandons the install (the new snapshot stays unused). */
  beforeRename?: () => Promise<boolean>
  /**
   * Asked after `beforeRename`, synchronously, with the rename as the very next system call;
   * false abandons the install.
   */
  unchanged?: () => boolean
  faults: Faults
}

/**
 * Make `tmp` the board's snapshot and start the journal over at it. Every step is durable, and a
 * crash between any two leaves a board that loads to the same state:
 *
 * 1. A base line for the new snapshot is appended to the old journal, so the journal still
 *    belongs to `board.jsonl` once the new one is in place.
 * 2. The new snapshot's prepared copy is renamed into `backups/` (first time this hour), so each
 *    hour with edits has a backup at most one compaction old.
 * 3. `tmp` is renamed over `board.jsonl` and the directory fsynced. The old journal's lines at or
 *    below its revision are now skipped on replay; those above are replayed. Just before, the old
 *    snapshot is given a second name (`PREV_SNAPSHOT_FILE`, a hard link), taken off again after
 *    step 4, so the rename frees no blocks; a crash between leaves only that name, which the next
 *    load removes.
 * 4. The journal is rotated: the new one holds only the snapshot's base line and `tail`.
 */
export async function installSnapshot(
  dir: string,
  o: InstallOptions & { beforeRename?: undefined; unchanged?: undefined },
): Promise<Installed>
export async function installSnapshot(dir: string, o: InstallOptions): Promise<Installed | null>
export async function installSnapshot(dir: string, o: InstallOptions): Promise<Installed | null> {
  let placed = false
  try {
    if (o.journal) await appendJournal(dir, [encodeBase(o.ref)], o.faults)
    placed = o.backup !== null && (await placeBackup(dir, o.backup, o.faults, true))
  } finally {
    if (o.backup && !placed) await unlink(o.backup.tmp).catch(() => {})
  }
  const backup = placed && o.backup ? o.backup.name : null
  // An abandoned install leaves a base line no file matches and, at most, a backup of a state
  // the board did reach: both harmless.
  if (o.beforeRename && !(await o.beforeRename())) return null
  const board = join(dir, 'board.jsonl')
  const prev = join(dir, PREV_SNAPSHOT_FILE)
  // A link changes neither the file's inode, size nor mtime: `unchanged` still sees the snapshot
  // it looked at. Without one (no board.jsonl yet, a file system without hard links) the rename
  // frees the old file itself, as before.
  await unlink(prev).catch(() => {})
  const linked = await link(board, prev).then(
    () => true,
    () => false,
  )
  try {
    if (linked) o.faults.hit('snapshot:after-link')
    if (o.unchanged && !o.unchanged()) return null
    const stamp = await renameDurable(o.tmp, board, o.faults, 'snapshot', o.unchanged !== undefined)
    const journalBytes = await rotateJournal(dir, o.ref, o.tail, o.faults)
    return { stamp, journalBytes, backup }
  } finally {
    if (linked) await unlink(prev).catch(() => {})
  }
}
