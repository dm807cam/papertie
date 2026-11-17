import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type BoardState,
  type CommitMark,
  commitBatch,
  commitSteps,
  isId,
  type Op,
  OpError,
} from '@papertie/core'
import type { Slicer } from './compact'

import { fsyncDir, isEnoent, writeAll } from './durable'
import type { Faults } from './faults'

/**
 * The append-only journal beside `board.jsonl` (ADR-0001, Snapshot + journal). Each commit adds
 * one line; the snapshot plus the journal lines above its revision is the board.
 *
 * Two kinds of line, each ending in a `crc` field (the hex of the first 8 bytes of the SHA-256 of
 * the line without it):
 * - a commit: `{rev, ops, now, origin, crc}`, replayed with `commitBatch(state, ops, now, origin)`;
 *   `ops` are the ops as applied, and a commit the store rewrote (a deletion's time, `book.cards`)
 *   carries `sent` before `crc`: the digest of the ops as posted (`batchDigest`);
 * - a base: `{snapshot, sha256, crc}`, naming a `board.jsonl` (its revision and the `sha256` of
 *   its eof record, which a clean load has checked against its lines) the journal belongs to. A rotated journal starts with one; a compaction appends
 *   one before it renames the new snapshot into place. A `board.jsonl` no base names was put
 *   there by someone else, and the journal is not replayed over it.
 */

export const JOURNAL_FILE = 'journal.jsonl'
/** A rotated journal before its rename; a leftover is removed on load. */
export const JOURNAL_NEXT_FILE = 'journal.next'
const FILE_MODE = 0o600

export interface JournalLine {
  rev: number
  ops: readonly Op[]
  now: string
  origin: CommitMark | null
  /** `batchDigest([ops as posted])`, only on a commit the server rewrote. */
  sent?: string
  crc: string
}

/** A clean `board.jsonl`: its revision and its eof record's `sha256` (of every line before it). */
export interface SnapshotRef {
  revision: number
  sha256: string
}

export type JournalEntry =
  | {
      kind: 'commit'
      line: number
      rev: number
      ops: readonly Op[]
      now: string
      origin: CommitMark | null
      sent?: string
    }
  | { kind: 'base'; line: number; ref: SnapshotRef }
  | { kind: 'bad'; line: number; raw: string; message: string }

export interface JournalIssue {
  /** 1-based line number in `journal.jsonl`. */
  line: number
  kind: 'invalid-line' | 'duplicate' | 'rejected'
  raw: string
  message: string
}

export interface JournalFile {
  entries: JournalEntry[]
  /** Raw text of each line, by line number (1-based), for quarantine. */
  raws: string[]
  /** Bytes up to and including the last newline: the complete lines. */
  goodBytes: number
  /**
   * Bytes after the last newline: an append the process died in. Never acked (an ack follows the
   * fsync of complete lines), so it may be cut. A complete line that does not check out is never
   * torn, wherever it sits: it may have been acked, so it is quarantined with a notice.
   */
  tornBytes: number
  /** Highest commit revision on any readable line; 0 when there is none. */
  maxRev: number
  /**
   * Revisions an unreadable line may have held: `maxRev` plus one per unreadable line after the
   * last readable commit (lines are appended in revision order, one commit each). A recovery
   * goes above it, so no replica can have seen the revision it lands on.
   */
  maxRevBound: number
  /** Highest revision a base line names (the snapshots the journal belonged to); 0 when none. */
  maxBaseRev: number
  commits: number
}

// `,"crc":"` + 16 hex digits + `"}`
const CRC_TAIL = 26

const crcOf = (body: string): string =>
  createHash('sha256').update(body, 'utf8').digest().subarray(0, 8).toString('hex')

/** `body`, the text of a JSON object, with `crc` added as its last field. */
const withCrc = (body: string): string => `${body.slice(0, -1)},"crc":"${crcOf(body)}"}`

export function encodeCommit(line: Omit<JournalLine, 'crc'>): string {
  const steps = encodeCommitSteps(line)
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value.line
  }
}

/** Ops stringified between two pauses of `encodeCommitSteps`. */
const ENCODE_OPS = 32

/**
 * `encodeCommit`, a step at a time: the ops are stringified a few at a time and the checksum fed
 * as they come, pausing (yielding) between. A 400-op batch of long notes was one 1.9 ms step on the
 * Mac (some 15 ms on a Raspberry Pi). The text is exactly `encodeCommit`'s:
 * `JSON.stringify({rev, ops, now, origin})` (with `sent` after `origin` when there is one) with
 * the crc as its last field.
 */
export function* encodeCommitSteps(
  line: Omit<JournalLine, 'crc'>,
): Generator<void, { line: string; opsBytes: number }> {
  const { rev, ops, now, origin, sent } = line
  const parts: string[] = [`{"rev":${JSON.stringify(rev)},"ops":[`]
  /** The UTF-8 size of the ops' JSON between its brackets (the commit ring counts it). */
  let opsBytes = 0
  const hash = createHash('sha256').update(parts[0] as string, 'utf8')
  for (let i = 0; i < ops.length; i++) {
    // As in an array's JSON: an element with no JSON (none in a valid batch) is `null`.
    const op = `${i > 0 ? ',' : ''}${JSON.stringify(ops[i]) ?? 'null'}`
    parts.push(op)
    hash.update(op, 'utf8')
    opsBytes += Buffer.byteLength(op, 'utf8')
    if ((i + 1) % ENCODE_OPS === 0) yield
  }
  // The crc is over the whole object's text (`crcOf`); the line then reopens it to add `crc`.
  const tail = sent === undefined ? '' : `,"sent":${JSON.stringify(sent)}`
  const end = `],"now":${JSON.stringify(now)},"origin":${JSON.stringify(origin)}${tail}}`
  hash.update(end, 'utf8')
  const crc = hash.digest().subarray(0, 8).toString('hex')
  parts.push(`${end.slice(0, -1)},"crc":"${crc}"}`)
  return { line: parts.join(''), opsBytes }
}

export function encodeBase(ref: SnapshotRef): string {
  return withCrc(JSON.stringify({ snapshot: ref.revision, sha256: ref.sha256 }))
}

const isMark = (v: unknown): v is CommitMark => {
  const m = v as { clientId?: unknown; seq?: unknown } | null
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof m.clientId === 'string' &&
    isId(m.clientId, 'tab') &&
    Number.isSafeInteger(m.seq) &&
    (m.seq as number) >= 1
  )
}

/** A batch digest: 32 lowercase hex digits. */
const DIGEST = /^[0-9a-f]{32}$/

function decode(raw: string, line: number): JournalEntry {
  const bad = (message: string): JournalEntry => ({ kind: 'bad', line, raw, message })
  const tail = raw.slice(-CRC_TAIL)
  if (!tail.startsWith(',"crc":"') || !tail.endsWith('"}')) return bad('no checksum')
  if (crcOf(`${raw.slice(0, -CRC_TAIL)}}`) !== tail.slice(8, 24)) return bad('checksum mismatch')
  let v: Record<string, unknown>
  try {
    v = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return bad('invalid JSON')
  }
  if (typeof v !== 'object' || v === null) return bad('not a journal line')
  if (Number.isSafeInteger(v.snapshot) && typeof v.sha256 === 'string') {
    return { kind: 'base', line, ref: { revision: v.snapshot as number, sha256: v.sha256 } }
  }
  if (
    Number.isSafeInteger(v.rev) &&
    (v.rev as number) >= 1 &&
    Array.isArray(v.ops) &&
    typeof v.now === 'string' &&
    (v.origin === null || isMark(v.origin)) &&
    (v.sent === undefined || (typeof v.sent === 'string' && DIGEST.test(v.sent)))
  ) {
    return {
      kind: 'commit',
      line,
      rev: v.rev as number,
      ops: v.ops as Op[],
      now: v.now,
      origin: v.origin as CommitMark | null,
      ...(v.sent !== undefined ? { sent: v.sent as string } : {}),
    }
  }
  return bad('not a journal line')
}

/** The journal's bytes; null when it has none. */
export async function readJournalBytes(dir: string): Promise<Buffer | null> {
  try {
    return await readFile(join(dir, JOURNAL_FILE))
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
}

/** Read and check every line of the board's journal; null when it has none. Writes nothing. */
export async function readJournal(dir: string): Promise<JournalFile | null> {
  const buf = await readJournalBytes(dir)
  return buf === null ? null : parseJournal(buf)
}

/** Journal bytes decoded at a time by the sliced read. */
const DECODE_PIECE = 65_536

/** `parseJournal`'s pass over the lines, one line at a time. */
class JournalLines {
  readonly entries: JournalEntry[] = []
  readonly raws: string[]
  readonly goodBytes: number
  private maxRev = 0
  private maxBaseRev = 0
  private commits = 0
  private badAfterCommit = 0

  /** `raws`: the complete lines' text (up to `goodBytes`), as one decode and split gives them. */
  private constructor(
    private readonly buf: Buffer,
    goodBytes: number,
    raws: string[],
  ) {
    this.goodBytes = goodBytes
    this.raws = raws
  }

  static whole(buf: Buffer): JournalLines {
    const goodBytes = buf.lastIndexOf(0x0a) + 1
    const raws = buf.subarray(0, goodBytes).toString('utf8').split('\n')
    raws.pop() // the empty string after the last newline
    return new JournalLines(buf, goodBytes, raws)
  }

  /**
   * `whole(buf)`, decoded a piece of about `pieceBytes` at a time in slices of `s`: each piece is
   * cut just after a newline byte (which no UTF-8 character contains), so it decodes and splits
   * as it would in the whole.
   */
  static async sliced(buf: Buffer, s: Slicer, pieceBytes = DECODE_PIECE): Promise<JournalLines> {
    const goodBytes = buf.lastIndexOf(0x0a) + 1
    const raws: string[] = []
    for (let pos = 0; pos < goodBytes; ) {
      const cut = pos + pieceBytes >= goodBytes ? -1 : buf.indexOf(0x0a, pos + pieceBytes)
      const end = cut === -1 ? goodBytes : cut + 1
      const lines = buf.toString('utf8', pos, end).split('\n')
      lines.pop() // the piece ends in its newline
      for (const line of lines) raws.push(line)
      pos = end
      if (s.due()) await s.pause()
    }
    return new JournalLines(buf, goodBytes, raws)
  }

  get length(): number {
    return this.raws.length
  }

  /** Check line `i` (0-based). */
  check(i: number): void {
    const raw = this.raws[i] as string
    if (raw === '') return
    const e = decode(raw, i + 1)
    if (e.kind === 'commit') {
      this.commits++
      this.badAfterCommit = 0
      if (e.rev > this.maxRev) this.maxRev = e.rev
    } else if (e.kind === 'bad') {
      this.badAfterCommit++
    } else if (e.ref.revision > this.maxBaseRev) {
      this.maxBaseRev = e.ref.revision
    }
    this.entries.push(e)
  }

  done(): JournalFile {
    return {
      entries: this.entries,
      raws: this.raws,
      goodBytes: this.goodBytes,
      tornBytes: this.buf.length - this.goodBytes,
      maxRev: this.maxRev,
      maxRevBound: this.maxRev + this.badAfterCommit,
      maxBaseRev: this.maxBaseRev,
      commits: this.commits,
    }
  }
}

/** Check every line of a journal's bytes. */
export function parseJournal(buf: Buffer): JournalFile {
  const lines = JournalLines.whole(buf)
  for (let i = 0; i < lines.length; i++) lines.check(i)
  return lines.done()
}

/**
 * `parseJournal(buf)` in slices of `s`: the bytes decoded a piece at a time, then each line's
 * checksum and parse a step. `pieceBytes` is for tests.
 */
export async function parseJournalSliced(
  buf: Buffer,
  s: Slicer,
  pieceBytes?: number,
): Promise<JournalFile> {
  const lines = await JournalLines.sliced(buf, s, pieceBytes)
  for (let i = 0; i < lines.length; i++) {
    lines.check(i)
    if (s.due()) await s.pause()
  }
  return lines.done()
}

/** True when a base line of `journal` names this snapshot. */
export function isBasedOn(journal: JournalFile, ref: SnapshotRef): boolean {
  return journal.entries.some(
    (e) => e.kind === 'base' && e.ref.revision === ref.revision && e.ref.sha256 === ref.sha256,
  )
}

export interface Replay {
  state: BoardState
  applied: number
  /** Lines not applied (unreadable, a revision seen already, or rejected by `commitBatch`). */
  issues: JournalIssue[]
  /** A commit line whose revision does not follow the one before it. */
  gap: boolean
}

/** `replay`'s pass over the entries, one at a time. */
class Replaying {
  private readonly base: number
  private state: BoardState
  private applied = 0
  private gap = false
  private readonly issues: JournalIssue[] = []

  constructor(
    private readonly journal: JournalFile,
    snapshot: BoardState,
  ) {
    this.base = snapshot.board.revision
    this.state = snapshot
  }

  private issue(line: number, kind: JournalIssue['kind'], message: string): void {
    this.issues.push({ line, kind, raw: this.journal.raws[line - 1] ?? '', message })
  }

  /** The commit `e` names, when it is one to apply (an issue is noted for one that is not). */
  private commit(e: JournalEntry): (JournalEntry & { kind: 'commit' }) | null {
    if (e.kind === 'base') return null
    if (e.kind === 'bad') {
      this.issue(e.line, 'invalid-line', e.message)
      return null
    }
    if (e.rev <= this.base) return null
    if (e.rev <= this.state.board.revision) {
      this.issue(e.line, 'duplicate', `revision ${e.rev} again`)
      return null
    }
    if (e.rev !== this.state.board.revision + 1) this.gap = true
    return e
  }

  private rejected(line: number, err: unknown): void {
    this.issue(line, 'rejected', err instanceof OpError ? err.message : 'could not be applied')
  }

  apply(e: JournalEntry): void {
    const c = this.commit(e)
    if (!c) return
    try {
      this.state = commitBatch(this.state, c.ops, c.now, c.origin)
      this.applied++
    } catch (err) {
      this.rejected(c.line, err)
    }
  }

  /**
   * `apply`, a step at a time (`commitSteps`): the event loop is given back between two ops of
   * the commit whenever the slice is due. A commit at the ops limit (500 ops) was one step: 17 ms
   * on a Mac, 145 ms on a Raspberry Pi. Nothing else sees `state` until the replay is done.
   */
  async applySliced(e: JournalEntry, s: Slicer): Promise<void> {
    const c = this.commit(e)
    if (!c) return
    try {
      const steps = commitSteps(this.state, c.ops, c.now, c.origin)
      for (let r = steps.next(); ; r = steps.next()) {
        if (r.done) {
          this.state = r.value.state
          break
        }
        if (s.due()) await s.pause()
      }
      this.applied++
    } catch (err) {
      this.rejected(c.line, err)
    }
  }

  done(): Replay {
    return { state: this.state, applied: this.applied, issues: this.issues, gap: this.gap }
  }
}

/**
 * `snapshot` with every commit line above its revision applied in file order. Lines at or below
 * the snapshot's revision are in the snapshot already and are skipped. Never throws.
 */
export function replay(journal: JournalFile, snapshot: BoardState): Replay {
  const r = new Replaying(journal, snapshot)
  for (const e of journal.entries) r.apply(e)
  return r.done()
}

/**
 * `replay(journal, snapshot)` in slices of `s` (each commit is a step).
 */
export async function replaySliced(
  journal: JournalFile,
  snapshot: BoardState,
  s: Slicer,
): Promise<Replay> {
  const r = new Replaying(journal, snapshot)
  for (const e of journal.entries) {
    await r.applySliced(e, s)
    if (s.due()) await s.pause()
  }
  return r.done()
}

/**
 * The replay's entry point: `snapshot` plus the board's journal, without checking that the
 * journal belongs to it (the load does that, see `loadBoardDir`).
 */
export async function replayJournal(
  dir: string,
  snapshot: BoardState,
): Promise<{ state: BoardState; applied: number; tornTail: boolean; quarantined: number }> {
  const journal = await readJournal(dir)
  if (!journal) return { state: snapshot, applied: 0, tornTail: false, quarantined: 0 }
  const r = replay(journal, snapshot)
  return {
    state: r.state,
    applied: r.applied,
    tornTail: journal.tornBytes > 0,
    quarantined: r.issues.length,
  }
}

/**
 * Append encoded lines to the journal in one write and fsync it; returns the bytes written. The
 * journal must exist (`rotateJournal` creates it): a file that vanished is a failure, never a new
 * journal without its base line.
 */
export async function appendJournal(
  dir: string,
  lines: readonly string[],
  faults: Faults,
): Promise<number> {
  const texts = lines.map((l) => `${l}\n`)
  let total = 0
  for (const t of texts) total += Buffer.byteLength(t, 'utf8')
  const half = Math.floor(total / 2)
  const fh = await open(join(dir, JOURNAL_FILE), constants.O_WRONLY | constants.O_APPEND)
  try {
    // Encoded and written a piece at a time, each write awaited: a 400-op batch of long notes is
    // a 750 KB line, encoded in one go 0.8 ms of one iteration on a Mac. The bytes, and
    // the fault point at exactly half of them, are as before.
    let written = 0
    let halfway = false
    for (const piece of encodedPieces(texts)) {
      let from = 0
      if (!halfway && written + piece.length >= half) {
        from = half - written
        await writeAll(fh, piece, 0, from)
        halfway = true
        faults.hit('journal:partial-append')
      }
      await writeAll(fh, piece, from, piece.length)
      written += piece.length
    }
    if (!halfway) faults.hit('journal:partial-append')
    faults.hit('journal:after-append')
    await fh.sync()
  } finally {
    await fh.close()
  }
  return total
}

/** UTF-16 units encoded at a time when a journal line is written. */
const ENCODE_CHARS = 32_768

/** `texts`' UTF-8 bytes in pieces, each cut off between two characters (never in a pair). */
function* encodedPieces(texts: readonly string[]): Generator<Buffer> {
  for (const t of texts) {
    for (let at = 0; at < t.length; ) {
      let end = Math.min(t.length, at + ENCODE_CHARS)
      // A high surrogate at the cut belongs with the low one after it.
      const c = t.charCodeAt(end - 1)
      if (end < t.length && c >= 0xd800 && c <= 0xdbff) end--
      yield Buffer.from(t.slice(at, end), 'utf8')
      at = end
    }
  }
}

/**
 * Atomically replace the journal with one that starts at snapshot `ref` and holds `tail` (the
 * commit lines above it): write `journal.next`, fsync, rename it over `journal.jsonl`, fsync the
 * directory. Returns the new journal's size.
 */
export async function rotateJournal(
  dir: string,
  ref: SnapshotRef,
  tail: readonly string[],
  faults: Faults,
): Promise<number> {
  const next = join(dir, JOURNAL_NEXT_FILE)
  const fh = await open(next, 'w', FILE_MODE)
  let total = 0
  try {
    // Written a few lines at a time, each write awaited: the tail of a compaction that ran beside
    // large batches is megabytes (8 batches of 400 long notes: 5.8 MB), joined and encoded in one
    // go 7.9 ms of one iteration on a Mac, some 60 ms on a Raspberry Pi.
    let group: string[] = []
    let chars = 0
    const write = async () => {
      if (group.length === 0) return
      const bytes = Buffer.from(group.join(''), 'utf8')
      group = []
      chars = 0
      await writeAll(fh, bytes, 0, bytes.length)
      total += bytes.length
    }
    for (const line of [encodeBase(ref), ...tail]) {
      if (line.length < ROTATE_WRITE_CHARS) {
        group.push(`${line}\n`)
        chars += line.length + 1
        if (chars >= ROTATE_WRITE_CHARS) await write()
        continue
      }
      // A long line (a large batch's: 750 KB) is encoded a piece at a time too.
      await write()
      for (const piece of encodedPieces([line])) {
        await writeAll(fh, piece, 0, piece.length)
        total += piece.length
      }
      group.push('\n')
      chars = 1
    }
    await write()
    await fh.sync()
  } finally {
    await fh.close()
  }
  faults.hit('journal:after-next')
  await rename(next, join(dir, JOURNAL_FILE))
  faults.hit('journal:after-rotate')
  await fsyncDir(dir)
  return total
}

/** About this many UTF-16 units of journal lines go in one write of a rotation. */
const ROTATE_WRITE_CHARS = 65_536

/** Cut a torn append off the journal, so the next line starts on a line of its own. */
export async function truncateJournal(dir: string, goodBytes: number): Promise<void> {
  const fh = await open(join(dir, JOURNAL_FILE), 'r+')
  try {
    await fh.truncate(goodBytes)
    await fh.sync()
  } finally {
    await fh.close()
  }
}
