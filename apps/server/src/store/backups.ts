import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type BoardState,
  CURRENT_SCHEMA_VERSION,
  countedKind,
  countWords,
  ID_PATTERN,
  parseBoard,
} from '@papertie/core'
import type { Logger } from '../log'
import {
  copyTmpDurable,
  fsyncDir,
  isEnoent,
  stampOf,
  writeFileDurable,
  writeTmpDurable,
} from './durable'
import type { Faults } from './faults'
import { boardDir } from './paths'

export interface BackupInfo {
  file: string
  time: Date
  revision: number
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const KEEP_ALL_MS = 48 * HOUR_MS
const KEEP_DAILY_MS = 30 * DAY_MS
const KEEP_WEEKLY_MS = 183 * DAY_MS

const BACKUP_RE = /^board\.(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.r(0|[1-9]\d*)\.jsonl$/

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** The UTC hour `t` falls in, as hours since the epoch: backups are taken once per hour. */
export const hourOf = (t: Date): number => Math.floor(t.getTime() / HOUR_MS)

/** `board.<YYYYMMDDTHHmmss>Z.r<revision>.jsonl`, in UTC. */
export function backupName(time: Date, revision: number): string {
  const t =
    `${pad(time.getUTCFullYear(), 4)}${pad(time.getUTCMonth() + 1)}${pad(time.getUTCDate())}` +
    `T${pad(time.getUTCHours())}${pad(time.getUTCMinutes())}${pad(time.getUTCSeconds())}Z`
  return `board.${t}.r${revision}.jsonl`
}

export function parseBackupName(name: string): BackupInfo | null {
  const m = BACKUP_RE.exec(name)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const time = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  const revision = Number(m[7])
  // Date.UTC rolls impossible fields over (month 13, Feb 30); only a canonical name round-trips.
  if (!Number.isSafeInteger(revision) || backupName(time, revision) !== name) return null
  return { file: name, time, revision }
}

const backupsDir = (dir: string) => join(dir, 'backups')

export interface BackupScan {
  /** -1 when the file has no loadable board (no board record, or another schema version). */
  notes: number
  yarns: number
  /**
   * The books on its shelf (not in the trash) and their words (prompts and footnotes not
   * counted, as the writer counts): a version is the board and its books.
   */
  books: number
  words: number
  /** The file does not end in a valid `eof` (missing, wrong count, wrong checksum, lines after it). */
  damaged: boolean
}

const typeOf = (line: string): string | null => {
  // Records are written type first; anything else is looked at properly.
  const m = /^\{"type":"([a-z]+)"/.exec(line)
  if (m) return m[1] ?? null
  try {
    const v: unknown = JSON.parse(line)
    const t = typeof v === 'object' && v !== null ? (v as { type?: unknown }).type : undefined
    return typeof t === 'string' ? t : null
  } catch {
    return null
  }
}

const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(line)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const UNREADABLE: BackupScan = { notes: -1, yarns: -1, books: -1, words: -1, damaged: true }

/** The books on the shelf of `state` (not trashed) and their words. */
function shelfOf(state: BoardState): { books: number; words: number } {
  let books = 0
  let words = 0
  for (const b of state.books.values()) if (b.trashedAt === null) books++
  for (const b of state.blocks.values()) {
    if (countedKind(b.kind) && state.books.get(b.bookId)?.trashedAt === null) {
      words += countWords(b.text)
    }
  }
  return { books, words }
}

/**
 * What the history list shows of a backup. The common case is cheap: note and yarn lines are
 * counted by their `type` and the `eof` is checked the way the parser checks integrity (same
 * lines, count and SHA-256, hashed natively), with no record validated. Books are counted the
 * same way; a block line is read (`JSON.parse`) only for its words. Canonical files hold books
 * before blocks, so a block's book is known when it comes (one of another order counts no words
 * for it until it is parsed in full below). A file whose `eof` holds was written by the server
 * from a valid state, so it loads with exactly these counts. Only a damaged file (rare) is parsed
 * in full, so its counts are what a restore would keep.
 */
export function scanBackup(text: string): BackupScan {
  const lines = (text.startsWith('\uFEFF') ? text.slice(1) : text).split(/\r?\n/)
  const hash = createHash('sha256')
  let body = 0
  let notes = 0
  let yarns = 0
  let words = 0
  /** The shelf's books (not trashed) met so far. */
  const shelf = new Set<string>()
  let board: Record<string, unknown> | null = null
  let eof: Record<string, unknown> | null = null
  let afterEof = false
  for (const line of lines) {
    if (line.trim() === '') continue
    if (eof) {
      afterEof = true
      break
    }
    const type = typeOf(line)
    if (type === 'eof') {
      const e = parseLine(line)
      if (e && typeof e.records === 'number' && typeof e.sha256 === 'string') {
        eof = e
        continue
      }
    }
    body++
    hash.update(line)
    hash.update('\n')
    if (type === 'note') notes++
    else if (type === 'yarn') yarns++
    else if (type === 'block') {
      const b = parseLine(line)
      if (b && typeof b.text === 'string' && typeof b.bookId === 'string' && shelf.has(b.bookId)) {
        if (typeof b.kind === 'string' && countedKind(b.kind)) words += countWords(b.text)
      }
    } else if (type === 'book') {
      const b = parseLine(line)
      if (b && typeof b.id === 'string' && b.trashedAt === null) shelf.add(b.id)
    } else if (type === 'board' && board === null) board = parseLine(line)
  }
  const version = board?.schemaVersion
  if (board === null || version !== CURRENT_SCHEMA_VERSION) {
    return UNREADABLE
  }
  const damaged =
    eof === null || afterEof || eof.records !== body || eof.sha256 !== hash.digest('hex')
  if (!damaged) return { notes, yarns, books: shelf.size, words, damaged }
  const { state } = parseBoard(text)
  return state
    ? { notes: state.notes.size, yarns: state.yarns.size, ...shelfOf(state), damaged }
    : UNREADABLE
}

/** Backups of the board in `dir`, newest first. A missing `backups/` is an empty list. */
export async function listBackups(dir: string): Promise<BackupInfo[]> {
  let names: string[]
  try {
    names = await readdir(backupsDir(dir))
  } catch (e) {
    if (isEnoent(e)) return []
    throw e
  }
  const out: BackupInfo[] = []
  for (const n of names) {
    const info = parseBackupName(n)
    if (info) out.push(info)
  }
  return out.sort((a, b) => b.time.getTime() - a.time.getTime() || b.revision - a.revision)
}

/** Creates `backups/` (0700) if missing and makes the new entry durable. */
async function ensureBackupsDir(dir: string): Promise<void> {
  try {
    await mkdir(backupsDir(dir), { mode: 0o700 })
    await fsyncDir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
}

/**
 * What a backup holds: a copy of the file at `path`, or `parts` written out (the serialized board
 * the caller already has; `bytes` is their UTF-8 size, if known).
 */
export type BackupSource =
  | { path: string }
  | { parts: ReadonlyArray<string | Uint8Array>; bytes?: number }

/** A backup written and fsynced as `backups/<name><suffix>`, not in place yet. */
export interface PreparedBackup {
  name: string
  tmp: string
}

/**
 * The tmp suffix of the hourly backup a compaction writes outside the board's mutex: its own, so
 * it never shares a path with a backup written under the mutex (a restore's safety backup of the
 * same second and revision). Still a `.tmp`, so the load's sweep removes a leftover one.
 */
export const COMPACT_BACKUP_TMP = '.compact.tmp'

/**
 * Write `source` to `backups/<name><suffix>` and fsync it: a file of its own, never a hard link,
 * which an in-place write to its source (an editor, damage on disk) would change too.
 */
async function prepareBackup(
  dir: string,
  name: string,
  source: BackupSource,
  faults: Faults,
  suffix = '.tmp',
): Promise<PreparedBackup> {
  const tmp = join(backupsDir(dir), `${name}${suffix}`)
  try {
    if ('parts' in source) await writeTmpDurable(tmp, source.parts, faults, 'backup', source.bytes)
    else await copyTmpDurable(source.path, tmp)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
  return { name, tmp }
}

/**
 * Put a prepared backup in place: rename it, then fsync `backups/`. False, removing the tmp
 * file, when the name exists or, with `hourly`, when its hour has a backup by now.
 */
export async function placeBackup(
  dir: string,
  b: PreparedBackup,
  faults: Faults,
  hourly: boolean,
): Promise<boolean> {
  const bdir = backupsDir(dir)
  const path = join(bdir, b.name)
  const info = parseBackupName(b.name)
  const taken =
    (await stampOf(path)) !== null ||
    (hourly &&
      info !== null &&
      (await listBackups(dir)).some((x) => hourOf(x.time) === hourOf(info.time)))
  if (taken) {
    await unlink(b.tmp).catch(() => {})
    return false
  }
  await rename(b.tmp, path)
  faults.hit('backup:after-write')
  await fsyncDir(bdir)
  return true
}

const boardSource = (dir: string): BackupSource => ({ path: join(dir, 'board.jsonl') })

/**
 * The first half of `backupIfNewHour`: when no backup shares `now`'s UTC hour, `source` written
 * as that hour's backup-to-be, `backups/<name>.compact.tmp` (`placeBackup` puts it in place).
 * Compaction prepares its new snapshot's serialized parts outside the board's mutex, so placing
 * it there costs one rename. Null when this hour already has a backup.
 */
export async function prepareHourlyBackup(
  dir: string,
  now: Date,
  revision: number,
  source: BackupSource,
  faults: Faults,
): Promise<PreparedBackup | null> {
  await ensureBackupsDir(dir)
  const hour = hourOf(now)
  if ((await listBackups(dir)).some((b) => hourOf(b.time) === hour)) return null
  return prepareBackup(dir, backupName(now, revision), source, faults, COMPACT_BACKUP_TMP)
}

/**
 * Back up `source` (default: a copy of `board.jsonl`, at `revision`) when no backup shares
 * `now`'s UTC hour. Returns the backup's name, or null when nothing was written (no board file to
 * copy, or this hour already has a backup).
 */
export async function backupIfNewHour(
  dir: string,
  now: Date,
  revision: number,
  faults: Faults,
  source: BackupSource = boardSource(dir),
): Promise<string | null> {
  if ('path' in source && (await stampOf(source.path)) === null) return null
  const b = await prepareHourlyBackup(dir, now, revision, source, faults)
  return b && (await placeBackup(dir, b, faults, true)) ? b.name : null
}

/**
 * The marker beside a safety backup, `backups/<name>.safety` (empty): retention keeps that backup
 * at least 30 days, and the newest one for as long as it is the newest (`selectBackupsToDelete`).
 */
const SAFETY_SUFFIX = '.safety'

/** A marker's mtime in ms; +Infinity when it cannot be read (so it is never taken for old). */
async function markerTime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** The names of the backups in `dir` marked as safety backups (markers whose name parses). */
async function safetyBackups(dir: string): Promise<Set<string>> {
  let names: string[]
  try {
    names = await readdir(backupsDir(dir))
  } catch (e) {
    if (isEnoent(e)) return new Set()
    throw e
  }
  return new Set(
    names
      .filter((n) => n.endsWith(SAFETY_SUFFIX))
      .map((n) => n.slice(0, -SAFETY_SUFFIX.length))
      .filter((n) => parseBackupName(n) !== null),
  )
}

/**
 * Back up the board at `revision` whatever the hour: the safety copy a restore or an import takes
 * first, marked so (`.safety`) for retention: "You can undo this from History" holds for at least
 * 30 days. `board.jsonl` is copied when it holds that revision; when the journal has moved past
 * it, the board's serialized `parts` are written instead. An existing backup of the same second
 * and revision already holds these bytes (a revision's content never changes), so its name is
 * returned as is, marked too. The marker goes in after the backup, so a backup is never marked
 * unless it is there; a failed marker write throws, before anything is installed.
 */
export async function forceBackup(
  dir: string,
  now: Date,
  revision: number,
  faults: Faults,
  parts?: ReadonlyArray<string | Uint8Array>,
): Promise<string> {
  await ensureBackupsDir(dir)
  const name = backupName(now, revision)
  if ((await stampOf(join(backupsDir(dir), name))) === null) {
    const b = await prepareBackup(dir, name, parts ? { parts } : boardSource(dir), faults)
    await placeBackup(dir, b, faults, false)
  }
  const marker = join(backupsDir(dir), `${name}${SAFETY_SUFFIX}`)
  if ((await stampOf(marker)) === null) await writeFileDurable(marker, '', faults, 'backup')
  return name
}

function isoWeekKey(d: Date): string {
  // ISO 8601: a week belongs to the year of its Thursday.
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7))
  const year = thursday.getUTCFullYear()
  const dayOfYear = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS)
  return `${year}-W${pad(Math.floor(dayOfYear / 7) + 1)}`
}

const utcDayKey = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Names to delete: everything within 48 h is kept, then the newest per UTC day up to 30 d, then
 * the newest per ISO week up to 183 d. The newest backup is always kept. A safety backup (one
 * named in `safety`: taken before a restore or an import) is kept for 30 d whatever the table
 * says, and the newest of them for as long as it is the newest, however old.
 */
export function selectBackupsToDelete(
  backups: BackupInfo[],
  now: Date,
  safety: ReadonlySet<string> = new Set(),
): string[] {
  const sorted = [...backups].sort(
    (a, b) => b.time.getTime() - a.time.getTime() || b.revision - a.revision,
  )
  const keep = new Set<string>()
  const days = new Set<string>()
  const weeks = new Set<string>()
  const newest = sorted[0]
  if (newest) keep.add(newest.file)
  const newestSafety = sorted.find((b) => safety.has(b.file))
  if (newestSafety) keep.add(newestSafety.file)
  for (const b of sorted) {
    const age = now.getTime() - b.time.getTime()
    if (safety.has(b.file) && age <= KEEP_DAILY_MS) keep.add(b.file)
    if (age <= KEEP_ALL_MS) {
      keep.add(b.file)
    } else if (age <= KEEP_DAILY_MS) {
      const k = utcDayKey(b.time)
      if (!days.has(k)) {
        keep.add(b.file)
        days.add(k)
      }
    } else if (age <= KEEP_WEEKLY_MS) {
      const k = isoWeekKey(b.time)
      if (!weeks.has(k)) {
        keep.add(b.file)
        weeks.add(k)
      }
    }
  }
  return sorted.filter((b) => !keep.has(b.file)).map((b) => b.file)
}

/**
 * Delete the backups retention no longer keeps, each one's safety marker after it, and markers
 * whose backup is gone; returns the deleted backups' names.
 */
export async function pruneBackups(dir: string, now: Date): Promise<string[]> {
  // The daily sweep runs outside the board's mutex, beside a restore's or an import's
  // `forceBackup`. The markers are read first: a marker is written after its backup, so the
  // backup of every marker read here is in the listing that follows, unless it is truly gone.
  const listedAt = Date.now()
  const safety = await safetyBackups(dir)
  const backups = await listBackups(dir)
  const doomed = selectBackupsToDelete(backups, now, safety)
  const present = new Set(backups.map((b) => b.file))
  const gone = new Set(doomed)
  const bdir = backupsDir(dir)
  const markers: string[] = []
  for (const n of safety) {
    if (gone.has(n)) markers.push(n)
    // An orphan's marker goes only when it is older than this listing: never a fresh one.
    else if (!present.has(n) && (await markerTime(join(bdir, `${n}${SAFETY_SUFFIX}`))) < listedAt) {
      markers.push(n)
    }
  }
  if (doomed.length === 0 && markers.length === 0) return []
  const remove = async (name: string) => {
    try {
      await unlink(join(bdir, name))
    } catch (e) {
      if (!isEnoent(e)) throw e
    }
  }
  for (const name of doomed) await remove(name)
  for (const name of markers) await remove(`${name}${SAFETY_SUFFIX}`)
  await fsyncDir(bdir)
  return doomed
}

const isIdOf = (name: string, prefix: string) =>
  name.startsWith(`${prefix}_`) && ID_PATTERN.test(name)

async function childDirs(path: string, prefix: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && isIdOf(e.name, prefix)).map((e) => e.name)
  } catch (e) {
    if (isEnoent(e)) return []
    throw e
  }
}

/**
 * Prune every board's backups under users/<id>/boards/<id>, then run `eachBoard` on it (the
 * server's asset sweep, which must see only the backups retention keeps). One board failing
 * never stops the rest.
 */
export async function sweepBackups(
  dataDir: string,
  now: Date,
  log: Logger,
  eachBoard?: (userId: string, boardId: string) => Promise<unknown>,
): Promise<void> {
  let count = 0
  const failed = (e: unknown) =>
    log.warn('backup sweep failed', { kind: e instanceof Error ? e.name : 'unknown' })
  let users: string[] = []
  try {
    users = await childDirs(join(dataDir, 'users'), 'user')
  } catch (e) {
    failed(e)
  }
  for (const user of users) {
    let boards: string[] = []
    try {
      boards = await childDirs(join(dataDir, 'users', user, 'boards'), 'board')
    } catch (e) {
      failed(e)
    }
    for (const board of boards) {
      try {
        count += (await pruneBackups(boardDir(dataDir, user, board), now)).length
      } catch (e) {
        failed(e)
      }
      if (eachBoard) {
        try {
          await eachBoard(user, board)
        } catch (e) {
          log.warn('asset sweep failed', { kind: e instanceof Error ? e.name : 'unknown' })
        }
      }
    }
  }
  if (count > 0) log.info('backup sweep', { count })
}

/** The newest backup that loads to a board state, skipping unreadable or unloadable ones. */
export async function latestReadableBackup(
  dir: string,
): Promise<{ info: BackupInfo; state: BoardState } | null> {
  for (const info of await listBackups(dir)) {
    let text: string
    try {
      text = await readFile(join(backupsDir(dir), info.file), 'utf8')
    } catch {
      continue
    }
    const { state } = parseBoard(text)
    if (state) return { info, state }
  }
  return null
}
