import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { type FileStamp, isEnoent, stampOf } from './durable'
import { JOURNAL_FILE } from './journal'

/**
 * `summary.json` beside `board.jsonl`: what the board list shows (name, revision, times) as of the
 * exact `board.jsonl` and `journal.jsonl` this server last held, so listing a board that is not
 * cached never parses it. It is a cache, not a record: written without fsync when a handle is
 * dropped cleanly, and used only while both files still carry the stamps it names. Any write to
 * either file (a commit, a compaction, a recovery, an edit by hand) leaves it unused, and the
 * listing loads the board instead.
 */
export const SUMMARY_FILE = 'summary.json'
export const SUMMARY_TMP_FILE = `${SUMMARY_FILE}.tmp`
const BOARD_FILE = 'board.jsonl'

const StampSchema = z.object({ ino: z.number(), size: z.number(), mtimeMs: z.number() })

const KeptSummarySchema = z.object({
  v: z.literal(1),
  board: StampSchema,
  journal: StampSchema.nullable(),
  id: z.string(),
  name: z.string(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export interface KeptSummary {
  id: string
  name: string
  revision: number
  createdAt: string
  updatedAt: string
}

const same = (a: FileStamp | null, b: FileStamp | null) =>
  a === null || b === null
    ? a === b
    : a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs

/** The kept summary, if both files are still the ones it was kept for; otherwise null. */
export async function readKeptSummary(dir: string): Promise<KeptSummary | null> {
  let text: string
  try {
    text = await readFile(join(dir, SUMMARY_FILE), 'utf8')
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
  let kept: z.infer<typeof KeptSummarySchema>
  try {
    const parsed = KeptSummarySchema.safeParse(JSON.parse(text))
    if (!parsed.success) return null
    kept = parsed.data
  } catch {
    return null
  }
  const [board, journal] = await Promise.all([
    stampOf(join(dir, BOARD_FILE)),
    stampOf(join(dir, JOURNAL_FILE)),
  ])
  if (board === null || !same(board, kept.board) || !same(journal, kept.journal)) return null
  const { id, name, revision, createdAt, updatedAt } = kept
  return { id, name, revision, createdAt, updatedAt }
}

/**
 * Keep `summary` for a board whose files are `board` (the stamp its holder wrote or loaded) and a
 * journal of `journalBytes` bytes (null: none). Kept only when the files on disk are those; a file
 * written after the check leaves the summary unused, since its stamp then differs.
 */
export async function keepSummary(
  dir: string,
  summary: KeptSummary,
  board: FileStamp,
  journalBytes: number | null,
): Promise<boolean> {
  const [onDisk, journal] = await Promise.all([
    stampOf(join(dir, BOARD_FILE)),
    stampOf(join(dir, JOURNAL_FILE)),
  ])
  const journalMatches = journalBytes === null ? journal === null : journal?.size === journalBytes
  if (!same(onDisk, board) || !journalMatches) {
    await unlinkSummary(dir)
    return false
  }
  const { id, name, revision, createdAt, updatedAt } = summary
  const text = JSON.stringify({ v: 1, board, journal, id, name, revision, createdAt, updatedAt })
  const tmp = join(dir, SUMMARY_TMP_FILE)
  await writeFile(tmp, `${text}\n`, { mode: 0o600 })
  await rename(tmp, join(dir, SUMMARY_FILE))
  return true
}

async function unlinkSummary(dir: string): Promise<void> {
  try {
    await unlink(join(dir, SUMMARY_FILE))
  } catch (e) {
    if (!isEnoent(e)) throw e
  }
}
