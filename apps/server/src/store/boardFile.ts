import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type BoardState,
  type Integrity,
  type LoadIssue,
  parseBoard,
  serializeBoard,
} from '@papertie/core'
import { z } from 'zod'
import type { Clock } from '../clock'
import type { Logger } from '../log'
import { latestReadableBackup, listBackups } from './backups'
import { parseBoardSliced } from './boardLoad'
import {
  installSnapshot,
  LOAD_SLICE_MS,
  NEXT_SNAPSHOT_FILE,
  PREV_SNAPSHOT_FILE,
  Slicer,
} from './compact'
import {
  appendLineDurable,
  copyDurable,
  type FileStamp,
  fsyncDir,
  isEnoent,
  stampOf,
  writeFileDurable,
  writeTmpDurable,
} from './durable'
import type { Faults } from './faults'
import {
  isBasedOn,
  JOURNAL_FILE,
  JOURNAL_NEXT_FILE,
  type JournalFile,
  type JournalIssue,
  parseJournalSliced,
  type Replay,
  readJournalBytes,
  replaySliced,
  type SnapshotRef,
  truncateJournal,
} from './journal'
import { SUMMARY_TMP_FILE } from './summaryFile'

const RecoveryNoticeSchema = z.object({
  integrity: z.enum([
    'missing-eof',
    'checksum-mismatch',
    'count-mismatch',
    'missing-file',
    'repaired',
    // A clean file whose revision is below one the board is known to have reached: put back by
    // hand (from backups/, Time Machine, ...), or a backup restored through the API
    // (`BoardStore.restoreBackup`, which names its safety backup in `latestBackup`).
    'restored',
    // Any other clean change to board.jsonl made while the board was cached, or one that does
    // not match its journal.
    'external-edit',
    // A restore through the API that did not finish (`writeRestoreIntent`): the board is as it
    // was, at a revision above every one seen.
    'restore-interrupted',
    // A board file imported through the API (`BoardStore.replaceBoard`), which names its safety
    // backup in `latestBackup`; and one that did not finish, as `restore-interrupted` says.
    'imported',
    'import-interrupted',
  ]),
  detectedAt: z.string(),
  preservedAs: z.string().nullable(),
  quarantinedLines: z.number().int().nonnegative(),
  repairs: z.number().int().nonnegative(),
  /**
   * Journal commits not in the board, kept in `quarantine/`: the commits of a journal that
   * belonged to another `board.jsonl`, or complete lines that did not check out or apply.
   */
  journalCommits: z.number().int().nonnegative().optional(),
  latestBackup: z
    .object({
      file: z.string(),
      revision: z.number().int().nonnegative(),
      notes: z.number().int().nonnegative(),
      yarns: z.number().int().nonnegative(),
    })
    .nullable(),
})

export type RecoveryNotice = z.infer<typeof RecoveryNoticeSchema>

/**
 * `recovery.json` on disk: the notice, plus `inProgress` while the recovery that wrote it has not
 * finished. That flag is written atomically with the notice and never leaves the store.
 */
const StoredNoticeSchema = RecoveryNoticeSchema.extend({ inProgress: z.literal(true).optional() })

/** How much a notice says, weakest first: a merge keeps the stronger. */
const STRENGTH: readonly RecoveryNotice['integrity'][] = [
  'restore-interrupted',
  'import-interrupted',
  'external-edit',
  'repaired',
  'restored',
  'imported',
  'count-mismatch',
  'checksum-mismatch',
  'missing-eof',
  'missing-file',
]

/**
 * A re-run of the recovery that wrote `prior` (it died before finishing): one recovery, so one
 * notice, with the larger of each count (the re-run sees the same damage again, or less of it
 * when the first run had already moved some aside). The kind, time and preserved copy are
 * `fresh`'s, unless `prior` is at least as strong: then they stay.
 */
function mergeRerun(prior: RecoveryNotice, fresh: RecoveryNotice): RecoveryNotice {
  const journalCommits = Math.max(prior.journalCommits ?? 0, fresh.journalCommits ?? 0)
  const counts = {
    quarantinedLines: Math.max(prior.quarantinedLines, fresh.quarantinedLines),
    repairs: Math.max(prior.repairs, fresh.repairs),
    ...(journalCommits > 0 ? { journalCommits } : {}),
  }
  if (STRENGTH.indexOf(prior.integrity) < STRENGTH.indexOf(fresh.integrity)) {
    return { ...fresh, ...counts }
  }
  return {
    ...fresh,
    integrity: prior.integrity,
    detectedAt: prior.detectedAt,
    preservedAs: prior.preservedAs ?? fresh.preservedAs,
    ...counts,
  }
}

/**
 * A new recovery while an earlier one's notice is still up: the new notice (kind, time, preserved
 * copy, latest backup) wins, and the earlier counts are added to its own, so nothing the earlier
 * recovery set aside drops out of the notice. Its preserved copy stays in `quarantine/`.
 */
function addNotice(prior: RecoveryNotice, fresh: RecoveryNotice): RecoveryNotice {
  const journalCommits = (prior.journalCommits ?? 0) + (fresh.journalCommits ?? 0)
  return {
    ...fresh,
    quarantinedLines: prior.quarantinedLines + fresh.quarantinedLines,
    repairs: prior.repairs + fresh.repairs,
    ...(journalCommits > 0 ? { journalCommits } : {}),
  }
}

/** `board.jsonl` as last written or loaded. */
export interface Snapshot {
  revision: number
  /** SHA-256 (hex) of the file's bytes. */
  sha256: string
  stamp: FileStamp
}

/** `journal.jsonl`: its size and the commit lines in it. */
export interface JournalStat {
  bytes: number
  commits: number
}

export type LoadOutcome =
  | {
      kind: 'ok'
      /** The snapshot with the journal replayed over it. */
      state: BoardState
      snapshot: Snapshot
      /** Null when the board has no journal. */
      journal: JournalStat | null
      recovery: RecoveryNotice | null
      recoveredNow: boolean
    }
  | { kind: 'unreadable'; reason: 'unsupported-version' | 'missing-board' }
  | { kind: 'absent' }

export interface LoadDeps {
  clock: Clock
  log: Logger
  faults: Faults
}

export interface LoadOptions {
  /**
   * The board is cached at this revision and `board.jsonl` changed behind the server's back. Any
   * loadable file then goes through recovery, so the new revision is above this one.
   */
  cachedRevision?: number
}

const BOARD_FILE = 'board.jsonl'
const RECOVERY_FILE = 'recovery.json'
const RESTORE_FILE = 'restore.json'
const REPAIRS_FILE = 'repairs.jsonl'
const QUARANTINE_DIR = 'quarantine'

/** Start and end of the last non-blank line of `text`. */
function lastLine(text: string): { start: number; end: number } {
  let end = text.length
  while (end > 0 && /\s/.test(text[end - 1] as string)) end--
  return { start: text.lastIndexOf('\n', end - 1) + 1, end }
}

/**
 * The `SnapshotRef` of JSONL ending in an eof record: its revision and `sha256`. Not checked
 * against the lines; a clean `parseBoard` has done that, and `isSnapshotText` does it here.
 */
export function snapshotRefOf(text: string): SnapshotRef | null {
  const { start, end } = lastLine(text)
  try {
    const e = JSON.parse(text.slice(start, end)) as {
      type?: unknown
      revision?: unknown
      sha256?: unknown
    }
    if (e?.type === 'eof' && Number.isSafeInteger(e.revision) && typeof e.sha256 === 'string') {
      return { revision: e.revision as number, sha256: e.sha256 }
    }
  } catch {
    // not an eof line
  }
  return null
}

/**
 * True when `text` is the canonical file `ref` names: its eof matches and its lines (each with
 * its newline) hash to the eof's `sha256`. One native hash, no parse.
 */
export function isSnapshotText(text: string, ref: SnapshotRef): boolean {
  const got = snapshotRefOf(text)
  if (!got || got.revision !== ref.revision || got.sha256 !== ref.sha256) return false
  const { start, end } = lastLine(text)
  if (end !== text.length - 1 || !text.endsWith('\n')) return false
  return createHash('sha256').update(text.slice(0, start), 'utf8').digest('hex') === ref.sha256
}

export async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
}

/** The file's bytes, undecoded (read off the event loop); null when it is not there. */
export async function readBytesIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
}

async function unlinkIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path)
    return true
  } catch (e) {
    if (isEnoent(e)) return false
    throw e
  }
}

/**
 * Remove `board.jsonl.tmp`, a compaction's `board.jsonl.next`, `board.jsonl.prev` (the old
 * snapshot's second name, a hard link: only a name goes) and `journal.next`, every `.tmp` in
 * `backups/` and `quarantine/` (copies being made) and inside an asset directory: leftovers of
 * writes that never reached their rename.
 */
async function removeStrayTmp(dir: string): Promise<number> {
  let count = 0
  for (const name of [
    `${BOARD_FILE}.tmp`,
    NEXT_SNAPSHOT_FILE,
    PREV_SNAPSHOT_FILE,
    JOURNAL_NEXT_FILE,
    SUMMARY_TMP_FILE,
    `${RECOVERY_FILE}.tmp`,
    `${RESTORE_FILE}.tmp`,
  ]) {
    if (await unlinkIfPresent(join(dir, name))) count++
  }
  for (const sub of ['backups', QUARANTINE_DIR]) {
    try {
      for (const name of await readdir(join(dir, sub))) {
        if (name.endsWith('.tmp') && (await unlinkIfPresent(join(dir, sub, name)))) count++
      }
    } catch (e) {
      if (!isEnoent(e)) throw e
    }
  }
  let assetIds: string[]
  try {
    assetIds = (await readdir(join(dir, 'assets'), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch (e) {
    if (isEnoent(e)) return count
    throw e
  }
  for (const id of assetIds) {
    const adir = join(dir, 'assets', id)
    for (const name of await readdir(adir)) {
      if (name.endsWith('.tmp') && (await unlinkIfPresent(join(adir, name)))) count++
    }
  }
  return count
}

const errCode = (e: unknown): string => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown'
}

/**
 * Count asset dirs the loaded board has no record for (an upload that died between its files and
 * its commit leaves one, and so does an asset sweep that died between its commit and the delete)
 * and log the count. Nothing is deleted here: the asset sweep (`assetSweep.ts`) collects them
 * once past the grace period. Housekeeping only: a failed scan is logged and never fails the load.
 */
async function logOrphanAssets(dir: string, state: BoardState, log: Logger): Promise<void> {
  let count = 0
  try {
    for (const e of await readdir(join(dir, 'assets'), { withFileTypes: true })) {
      if (e.isDirectory() && !state.assets.has(e.name)) count++
    }
  } catch (e) {
    if (!isEnoent(e)) log.warn('asset scan failed', { code: errCode(e) })
    return
  }
  if (count > 0) log.warn('orphan assets', { kind: 'orphan-asset', count })
}

/** Highest `revision` of any line that parses to an `eof` object; 0 when there is none. */
function maxEofRevision(text: string): number {
  let max = 0
  for (const line of text.split('\n')) {
    if (!line.includes('eof')) continue
    try {
      const v: unknown = JSON.parse(line)
      if (typeof v !== 'object' || v === null || (v as { type?: unknown }).type !== 'eof') continue
      const r = (v as { revision?: unknown }).revision
      if (typeof r === 'number' && Number.isSafeInteger(r) && r > max) max = r
    } catch {
      // not JSON: it is quarantined by the parser's own issue list
    }
  }
  return max
}

/** `YYYYMMDDTHHmmssSSSZ`, UTC. */
function tsOf(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, '')
}

export async function writeSnapshot(dir: string, text: string, faults: Faults): Promise<FileStamp> {
  return writeFileDurable(join(dir, BOARD_FILE), text, faults, 'snapshot')
}

/** The notice on disk, and whether the recovery that wrote it is unfinished. */
async function readStoredRecovery(
  dir: string,
): Promise<{ notice: RecoveryNotice; inProgress: boolean } | null> {
  const text = await readTextIfPresent(join(dir, RECOVERY_FILE))
  if (text === null) return null
  try {
    const parsed = StoredNoticeSchema.safeParse(JSON.parse(text))
    if (!parsed.success) return null
    const { inProgress, ...notice } = parsed.data
    return { notice, inProgress: inProgress === true }
  } catch {
    return null
  }
}

export async function readRecovery(dir: string): Promise<RecoveryNotice | null> {
  return (await readStoredRecovery(dir))?.notice ?? null
}

/**
 * Durably replaces the board's recovery notice (the web app shows it until dismissed).
 * `inProgress` marks it as written by a recovery that has not finished yet.
 */
export async function writeRecovery(
  dir: string,
  notice: RecoveryNotice,
  faults: Faults,
  inProgress = false,
): Promise<void> {
  const stored = inProgress ? { ...notice, inProgress: true } : notice
  await writeFileDurable(join(dir, RECOVERY_FILE), `${JSON.stringify(stored)}\n`, faults, 'asset')
}

/** Dismissing the notice drops a finished restore's marker too, so a reload never repeats it. */
export async function clearRecovery(dir: string): Promise<void> {
  const removed = [
    await unlinkIfPresent(join(dir, RECOVERY_FILE)),
    await unlinkIfPresent(join(dir, RESTORE_FILE)),
  ]
  if (removed.some(Boolean)) await fsyncDir(dir)
}

/** A restore or an import through the API that did not finish: the board is as it was. */
const cutShort = (integrity: RecoveryNotice['integrity']) =>
  integrity === 'restore-interrupted' || integrity === 'import-interrupted'

const RestoreIntentSchema = z.object({
  /** The snapshot the restore installs: its revision and its eof record's `sha256`. */
  revision: z.number().int().nonnegative(),
  sha256: z.string(),
  /** The notice the restore leaves once its snapshot is in. */
  notice: RecoveryNoticeSchema,
})

/**
 * `restore.json`: a restore through the API under way (`BoardStore.restoreBackup`), or an import
 * (`BoardStore.replaceBoard`, its notice `imported`). Written before the board changes and
 * removed once its snapshot and notice are in, so a load that finds it with another
 * `board.jsonl` knows the restore was cut short (by a crash or a failed write): the board is as it
 * was, and its notice says so (`restore-interrupted`, `import-interrupted`), never `restored`.
 */
export type RestoreIntent = z.infer<typeof RestoreIntentSchema>

export async function writeRestoreIntent(
  dir: string,
  intent: RestoreIntent,
  faults: Faults,
): Promise<void> {
  await writeFileDurable(join(dir, RESTORE_FILE), `${JSON.stringify(intent)}\n`, faults, 'asset')
}

export async function clearRestoreIntent(dir: string): Promise<void> {
  if (await unlinkIfPresent(join(dir, RESTORE_FILE))) await fsyncDir(dir)
}

/** The marker on disk; null when there is none or it cannot be read (it is then dropped). */
async function readRestoreIntent(dir: string): Promise<RestoreIntent | null> {
  const text = await readTextIfPresent(join(dir, RESTORE_FILE))
  if (text === null) return null
  try {
    const parsed = RestoreIntentSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Drop the restore marker of a load that has dealt with it. Housekeeping: a failure is logged. */
async function dropRestoreIntent(dir: string, log: Logger): Promise<void> {
  try {
    await clearRestoreIntent(dir)
  } catch (e) {
    log.warn('restore marker removal failed', { code: errCode(e) })
  }
}

async function ensureQuarantineDir(dir: string): Promise<string> {
  const q = join(dir, QUARANTINE_DIR)
  try {
    await mkdir(q, { mode: 0o700 })
    await fsyncDir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  return q
}

export interface PreservedDamage {
  /** The damaged file's copy in `quarantine/`, or null when there was none to copy. */
  preservedAs: string | null
  /** Rejected file lines (the file-level `missing-board` issue has no line and is not counted). */
  quarantinedLines: number
  repairs: number
}

/**
 * Keeps everything a damaged load would otherwise lose: `source` copied into `quarantine/` byte
 * for byte, as a file of its own (`<ts>-<label>.jsonl`), the rejected lines with their raw text
 * next to it (`<ts>-lines.jsonl`), and each repaired dangling reference appended to
 * `repairs.jsonl`. Every write is durable. Used by the load's recovery and by a restore of a
 * damaged backup.
 */
export async function preserveDamage(
  dir: string,
  opts: {
    source: { path: string; label: string } | null
    issues: readonly LoadIssue[]
    detected: Date
    faults: Faults
  },
): Promise<PreservedDamage> {
  const { source, issues, detected, faults } = opts
  const ts = tsOf(detected)
  const repairIssues = issues.filter((i) => i.kind === 'dangling-reference')
  const lineIssues = issues.filter((i) => i.kind !== 'dangling-reference')
  const quarantine = await ensureQuarantineDir(dir)

  let preservedAs: string | null = null
  if (source) {
    preservedAs = `${ts}-${source.label}.jsonl`
    await copyDurable(source.path, join(quarantine, preservedAs))
  }
  if (lineIssues.length > 0) {
    const body = lineIssues
      .map((i) => JSON.stringify({ line: i.line, kind: i.kind, message: i.message, raw: i.raw }))
      .join('\n')
    await writeFileDurable(join(quarantine, `${ts}-lines.jsonl`), `${body}\n`, faults, 'asset')
  }
  for (const i of repairIssues) {
    await appendLineDurable(
      join(dir, REPAIRS_FILE),
      JSON.stringify({ at: detected.toISOString(), message: i.message, raw: i.raw }),
    )
  }
  return {
    preservedAs,
    quarantinedLines: lineIssues.filter((i) => i.line > 0).length,
    repairs: repairIssues.length,
  }
}

/**
 * Keep the journal a recovery is about to leave behind in `quarantine/` as `<ts>-journal.jsonl`
 * (moved, or copied byte for byte when it stays in use, since the recovery then cuts its torn
 * tail and rotates it), with its lines that were not applied, raw text and all, in
 * `<ts>-journal-lines.jsonl`.
 */
async function preserveJournal(
  dir: string,
  opts: { detected: Date; issues: readonly JournalIssue[]; move: boolean; faults: Faults },
): Promise<void> {
  const ts = tsOf(opts.detected)
  const quarantine = await ensureQuarantineDir(dir)
  const from = join(dir, JOURNAL_FILE)
  const to = join(quarantine, `${ts}-journal.jsonl`)
  if (opts.move) {
    await rename(from, to)
    await fsyncDir(quarantine)
    await fsyncDir(dir)
  } else {
    await copyDurable(from, to)
  }
  if (opts.issues.length > 0) {
    const body = opts.issues
      .map((i) => JSON.stringify({ line: i.line, kind: i.kind, message: i.message, raw: i.raw }))
      .join('\n')
    await writeFileDurable(
      join(quarantine, `${ts}-journal-lines.jsonl`),
      `${body}\n`,
      opts.faults,
      'asset',
    )
  }
}

/**
 * Load the board in `dir`, recovering whatever can be recovered. Damaged content is never dropped
 * silently: the damaged file is copied into `quarantine/`, rejected lines are written next to
 * it with their raw text, and reference repairs are logged in `repairs.jsonl`. A board that cannot
 * be loaded at all (newer schema, no board record and no backup to borrow one from) is reported
 * as `unreadable` and nothing is written, moved or quarantined.
 *
 * The journal is replayed over `board.jsonl` when one of its base lines names that exact file. A
 * torn last line is cut off. A journal line that cannot be applied makes the load a recovery
 * (`repaired`): the journal and its bad lines are kept in `quarantine/`, and the replayed board
 * becomes the snapshot. A journal that names another file (`board.jsonl` edited, replaced or
 * missing) is not replayed: it is moved into `quarantine/` and the file loads through recovery
 * (`restored` when the journal had reached a later revision).
 *
 * A clean file is recovered too when its revision is below one the board reached (`restored`):
 * a backup's, or a revision a journal that belongs to another file names. With `cachedRevision`, so is any change
 * while cached (`restored` below that revision, otherwise `external-edit`). Its bytes are
 * preserved and the board gets a revision above every one seen. A clean file below the revision
 * of a restore marker (`restore.json`) is a restore through the API cut short: the same bump,
 * no copy kept, and a `restore-interrupted` (or `import-interrupted`) notice. Not caught: a
 * clean file put back while the server was stopped at or above all of those.
 */
export async function loadBoardDir(
  dir: string,
  deps: LoadDeps,
  opts: LoadOptions = {},
): Promise<LoadOutcome> {
  const { clock, log, faults } = deps
  const { cachedRevision } = opts

  // 1. Leftovers of interrupted writes.
  let removed = 0
  try {
    removed = await removeStrayTmp(dir)
  } catch (e) {
    if (!isEnoent(e)) throw e
  }
  if (removed > 0) log.info('removed stray tmp files', { count: removed })

  let backup: Awaited<ReturnType<typeof latestReadableBackup>> | undefined
  const newestBackup = async () => {
    if (backup === undefined) backup = await latestReadableBackup(dir)
    return backup
  }

  let state: BoardState
  let integrity: RecoveryNotice['integrity']
  let issues: LoadIssue[] = []
  let damagedBackup: { file: string; integrity: Integrity } | null = null
  // Stamped before the read: a file edited while it loads (the load takes seconds on a Raspberry Pi) then
  // differs from the stamp the handle keeps, and the next look reloads it, never the other way
  // round (the edit's stamp on the old bytes' state, renamed over by the next compaction).
  const readStamp = await stampOf(join(dir, BOARD_FILE))
  const bytes = await readBytesIfPresent(join(dir, BOARD_FILE))
  const journalBytes = await readJournalBytes(dir)
  const intent = await readRestoreIntent(dir)
  const hadIntentFile = intent !== null || (await stampOf(join(dir, RESTORE_FILE))) !== null
  /** The journal replayed over `board.jsonl`, when it belongs to that file. */
  let based: Replay | null = null
  // From here the board and its journal are parsed and replayed in slices, each in an event-loop
  // iteration of its own: a 100,000-note board is far too much for one.
  const s = await Slicer.start(LOAD_SLICE_MS)
  const journal: JournalFile | null =
    journalBytes === null ? null : await parseJournalSliced(journalBytes, s)
  /** The file's text, decoded whole: only a recovery needs it. */
  let decoded: string | undefined
  const textOf = (b: Buffer) => {
    decoded ??= b.toString('utf8')
    return decoded
  }

  if (bytes === null) {
    // 2. No board file: the newest readable backup stands in, otherwise there is no board here.
    const b = await newestBackup()
    if (!b) return { kind: 'absent' }
    // The backup may itself be damaged: its rejected lines and repairs must not vanish.
    const parsed = parseBoard(await readFile(join(dir, 'backups', b.info.file), 'utf8'))
    state = b.state
    integrity = 'missing-file'
    issues = parsed.issues
    if (parsed.integrity !== 'ok' || parsed.issues.length > 0) {
      damagedBackup = { file: b.info.file, integrity: parsed.integrity }
    }
  } else {
    // 3. Parse; borrow the newest backup's board record when the file has none.
    let r = await parseBoardSliced(bytes, s)
    if (r.state === null && r.issues.some((i) => i.kind === 'missing-board')) {
      const fallbackBoard = (await newestBackup())?.state.board
      if (fallbackBoard) {
        await s.pause()
        r = await parseBoardSliced(bytes, s, { fallbackBoard })
      }
    }
    const loaded = r.state

    // 4. Nothing loadable: leave every byte where it is (the journal too).
    if (loaded === null) {
      const reason = r.issues.some((i) => i.kind === 'unsupported-version')
        ? 'unsupported-version'
        : 'missing-board'
      log.warn('board unreadable', { reason })
      return { kind: 'unreadable', reason }
    }

    // 5. Clean, and the journal (if any) belongs to it: replay. Still a recovery when the board
    // is older than a revision it reached (a restore would otherwise move the revision backwards
    // and replicas would silently diverge), when it changed while cached, when a journal line
    // could not be applied, or when the journal belongs to another file.
    const clean = r.integrity === 'ok' && r.issues.length === 0
    // A clean file ends in its eof record: `snapshotRefOf(text)` without decoding it again.
    const ref = clean && r.eof ? { revision: r.eof.revision, sha256: r.eof.sha256 } : null
    if (journal && ref && isBasedOn(journal, ref)) {
      based = await replaySliced(journal, loaded, s)
    }
    s.note()
    const foreign = journal !== null && based === null
    const current = based?.state ?? loaded
    const journalDamaged = based !== null && (based.issues.length > 0 || based.gap)
    const reached = clean
      ? Math.max(
          cachedRevision ?? 0,
          foreign && journal ? Math.max(journal.maxRev, journal.maxBaseRev) : 0,
          ...(await listBackups(dir)).map((x) => x.revision),
        )
      : 0
    // A restore through the API that put its snapshot in finished (only its marker is left);
    // one whose board is still below the revision it was taking it to was cut short.
    const restoreDone =
      intent !== null &&
      ref !== null &&
      ref.revision === intent.revision &&
      ref.sha256 === intent.sha256
    const interrupted =
      clean && intent !== null && !restoreDone && current.board.revision < intent.revision
    const restored = clean && current.board.revision < reached
    if (
      ref &&
      !interrupted &&
      !restored &&
      !foreign &&
      !journalDamaged &&
      cachedRevision === undefined
    ) {
      if (journal && journal.tornBytes > 0) {
        await truncateJournal(dir, journal.goodBytes)
        log.info('journal torn tail', { bytes: journal.tornBytes })
      }
      const stamp = readStamp ?? (await stampOf(join(dir, BOARD_FILE)))
      if (!stamp) throw new Error('board file vanished while loading')
      const stored = await readStoredRecovery(dir)
      let notice = stored?.notice ?? null
      try {
        if (stored?.inProgress) {
          // A recovery died after its last step, so this clean load is its re-run: it is over,
          // and a later recovery must not be taken for it.
          await writeRecovery(dir, stored.notice, faults)
        }
        if (restoreDone && notice?.detectedAt !== intent.notice.detectedAt) {
          // The restore died after its snapshot, before its notice.
          await writeRecovery(dir, intent.notice, faults)
          notice = intent.notice
        }
      } catch (e) {
        log.warn('recovery notice write failed', { code: errCode(e) })
      }
      // Finished, or of a board that has moved on since (an unreadable one is no guide).
      if (hadIntentFile) await dropRestoreIntent(dir, log)
      await logOrphanAssets(dir, current, log)
      return {
        kind: 'ok',
        state: current,
        snapshot: { ...ref, stamp },
        journal: journal ? { bytes: journal.goodBytes, commits: journal.commits } : null,
        recovery: notice,
        recoveredNow: false,
      }
    }
    state = current
    integrity = interrupted
      ? intent?.notice.integrity === 'imported'
        ? 'import-interrupted'
        : 'restore-interrupted'
      : restored
        ? 'restored'
        : clean && (foreign || cachedRevision !== undefined)
          ? 'external-edit'
          : r.integrity === 'ok'
            ? 'repaired'
            : r.integrity
    issues = r.issues
  }

  // 6. Recovery. Every write is durable; a crash anywhere in here re-runs it on restart and can
  // only add duplicate quarantine copies (the notice marks it unfinished until step g).
  const detected = clock.now()
  // a–c. The damaged file, the lines that were not loaded and the repairs; the journal's bad
  // lines, with a copy of it (it stays, and is rotated below).
  // A restore cut short changes nothing but the revision: there is no copy to keep.
  const source = cutShort(integrity)
    ? null
    : bytes !== null
      ? { path: join(dir, BOARD_FILE), label: `board-${integrity}` }
      : damagedBackup
        ? {
            path: join(dir, 'backups', damagedBackup.file),
            label: `backup-${damagedBackup.integrity}`,
          }
        : null
  const kept = await preserveDamage(dir, { source, issues, detected, faults })
  const journalIssues = based?.issues ?? []
  if (based && (journalIssues.length > 0 || based.gap)) {
    await preserveJournal(dir, { detected, issues: journalIssues, move: false, faults })
    log.warn('journal lines quarantined', { count: journalIssues.length })
  }
  // The notice says how many commits are not in the board: a journal that belongs to another
  // file is set aside whole (its commits above the board's revision), and a replayed one keeps
  // out the complete lines that did not check out or apply.
  const setAside =
    journal && !based
      ? journal.entries.filter((e) => e.kind === 'commit' && e.rev > state.board.revision).length
      : journalIssues.length

  // d. New revision, above every revision this board is known to have reached (the loaded
  // record, the cached revision, the file's eof, the backups' names, the journal's lines and the
  // snapshots it names), so the page and the ring buffer cannot mistake it for one they have
  // seen. `clients` stay, so duplicate detection keeps working.
  const known = [state.board.revision, ...(await listBackups(dir)).map((x) => x.revision)]
  if (cachedRevision !== undefined) known.push(cachedRevision)
  if (bytes !== null) known.push(maxEofRevision(textOf(bytes)))
  if (journal) known.push(journal.maxRevBound, journal.maxBaseRev)
  const next: BoardState = {
    ...state,
    board: { ...state.board, revision: Math.max(...known) + 1 },
  }
  // e. The notice the web app shows until the user acknowledges it, marked unfinished. One not
  // dismissed yet and still marked is this recovery's own (a crash in here re-runs it, perhaps on
  // a file it already repaired): it is kept when it says more. Any other is an earlier recovery's:
  // the new notice wins and the counts add up.
  const b = await newestBackup()
  const fresh: RecoveryNotice = {
    integrity,
    detectedAt: detected.toISOString(),
    ...kept,
    quarantinedLines: kept.quarantinedLines + journalIssues.length,
    ...(setAside > 0 ? { journalCommits: setAside } : {}),
    // A restore cut short offers no backup: the newest is the copy it made of this very board.
    latestBackup:
      b && !cutShort(integrity)
        ? {
            file: b.info.file,
            revision: b.info.revision,
            notes: b.state.notes.size,
            yarns: b.state.yarns.size,
          }
        : null,
  }
  const stored = await readStoredRecovery(dir)
  const notice = !stored
    ? fresh
    : stored.inProgress
      ? mergeRerun(stored.notice, fresh)
      : addNotice(stored.notice, fresh)
  await writeRecovery(dir, notice, faults, true)
  faults.hit('recovery:after-notice')

  // f. The repaired board becomes the board file. A journal it was replayed from starts over at
  // it; a journal that belongs to another file goes to quarantine, after the new snapshot is in
  // place (a crash before that re-runs this recovery).
  const out = serializeBoard(next)
  const ref = snapshotRefOf(out)
  if (!ref) throw new Error('serialized board has no eof')
  let stamp: FileStamp
  let journalStat: JournalStat | null = null
  if (journal && based) {
    // The base line must start a line of its own.
    if (journal.tornBytes > 0) await truncateJournal(dir, journal.goodBytes)
    const tmp = join(dir, `${BOARD_FILE}.tmp`)
    await writeTmpDurable(tmp, [out], faults, 'snapshot')
    const r = await installSnapshot(dir, {
      tmp,
      ref,
      tail: [],
      journal: true,
      backup: null,
      faults,
    })
    stamp = r.stamp
    journalStat = { bytes: r.journalBytes, commits: 0 }
  } else {
    stamp = await writeSnapshot(dir, out, faults)
    if (journal) {
      await preserveJournal(dir, { detected, issues: [], move: true, faults })
      log.warn('journal quarantined', { count: setAside })
    }
  }
  // g. Finished: a later recovery is one of its own. A restore it found cut short is over too.
  faults.hit('recovery:after-snapshot')
  await writeRecovery(dir, notice, faults)
  if (hadIntentFile) await dropRestoreIntent(dir, log)
  log.warn('board recovered', {
    kind: integrity,
    count: issues.length + journalIssues.length,
    revision: next.board.revision,
  })
  await logOrphanAssets(dir, next, log)
  return {
    kind: 'ok',
    state: next,
    snapshot: { ...ref, stamp },
    journal: journalStat,
    recovery: notice,
    recoveredNow: true,
  }
}
