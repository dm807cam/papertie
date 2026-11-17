/** `Oct 30, 2026, 9:41 AM`: a moment in the reader's own locale; the ISO string itself when it is no date. */
export function formatTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return typeof iso === 'string' ? iso : ''
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d)
}

/**
 * The moment a backup file was taken, read from its name
 * (`board.20261030T094100Z.r12.jsonl`, UTC); null for any other name.
 */
export function backupTime(file: string): Date | null {
  const m = /^board\.(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.r\d+\.jsonl$/.exec(file)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s))
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * `12 notes · 3 threads · 2 books · 4,210 words` (`no books` when it holds none, so a version
 * never reads as notes alone); the counts of a backup that cannot be read are not shown.
 */
export function countsLine(notes: number, yarns: number, books: number, words: number): string {
  if (notes < 0) return 'Can’t be read'
  const board = `${plural(notes, 'note', 'notes')} · ${plural(yarns, 'thread', 'threads')}`
  if (!(books > 0)) return `${board} · no books`
  return `${board} · ${plural(books, 'book', 'books')} · ${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`
}

/** The question asked before a backup replaces the board. */
export const restoreQuestion = (time: string): string =>
  `Replace the board with this version from ${time}? Your current board is saved first, so you can come back to it.`

/** Said once a file has replaced the board: in Settings, and on the recovery slip. */
export const IMPORTED = 'Board replaced. You can undo this from History.'

/** On a slip, once a backup asked for is back and the sheet that asked is not there. */
export const RESTORED_SLIP = 'Board restored. You can undo this from History.'

/** On a slip, once an undone restore is back and the sheet that asked is not there. */
export const UNDONE_SLIP = 'Undone. The board is back as it was before the restore.'

/** On a slip, when a restore failed and the sheet that asked is not there. */
export const RESTORE_FAILED_SLIP = 'Couldn’t restore that version. Your board is as it was.'

/** On a slip, when undoing a restore failed and the sheet that asked is not there. */
export const UNDO_FAILED_SLIP = 'Couldn’t undo the restore. Your board is as it was.'
