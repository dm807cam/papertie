import {
  type Asset,
  AssetRecordSchema,
  type Block,
  type Board,
  BoardRecordSchema,
  type BoardState,
  type Book,
  type Note,
  NoteRecordSchema,
  type OpBatch,
  type Yarn,
  YarnRecordSchema,
} from '@papertie/core'
import { loadBookSync } from '../sync/books/bookOps'
import type { CommitAck, CommitEvent, StagedAck, StagedPart } from '../sync/types'
import { parseOffThread, withoutBlocks } from './boardParse'
import { ApiError, apiJson, apiRaw, readBody, readBytes } from './http'

export interface BoardSummary {
  id: string
  name: string
  revision: number
  createdAt: string
  updatedAt: string
  recovered: boolean
}

/** What the server says of a repaired or restored board (`recovery.json`), until it is dismissed. */
export interface RecoveryInfo {
  /**
   * What happened (the server's `RecoveryNotice['integrity']`): `restored` (a backup was put
   * back), `imported`, `restore-interrupted` and `import-interrupted` (cut short, the board as it
   * was); anything else (`repaired`, `external-edit`, a count or checksum mismatch, a missing
   * end or file) means the file was repaired. `RecoveryNotice.tsx` says which.
   */
  integrity: string
  detectedAt: string
  /** The newest backup (after a restore: the board as it was just before). */
  latestBackup: { file: string; revision: number; notes: number; yarns: number } | null
}

export interface BoardMeta {
  id: string
  name: string
  revision: number
  /** Set when the server rebuilt or restored the board; see `dismissRecovery`. */
  recovery: RecoveryInfo | null
  /** How many notes the board has. */
  notes: number
  /** The rect that holds every note's stored rect, null without notes. */
  extent: RegionRect | null
}

export interface LoadedBoard {
  state: BoardState
  revision: number
  /** The server's clock when it answered (`X-Papertie-Now`); local time when the header was missing. */
  serverNow: string
  /** `serverNow` came from the server: only then is it a clock observation. */
  serverNowKnown: boolean
  /** The server repaired the file on this load. */
  recovered: boolean
}

export interface BackupRow {
  /** The backup's file name: what `restoreBackup` takes. */
  id: string
  revision: number
  takenAt: string
  /** -1 when the backup cannot be loaded. */
  notes: number
  yarns: number
  /** The books on its shelf and their words: a version is the board and its books. */
  books: number
  words: number
  bytes: number
  /** Torn or failing its checksum: a restore keeps what the parser recovers. */
  damaged: boolean
}

/**
 * What a resume's answer says besides its body: `serverNow` is its `X-Papertie-Now` (when it came),
 * `recovered` its `X-Papertie-Recovered` (the board was repaired or restored, notice not dismissed).
 */
export interface AnswerHeaders {
  serverNow?: string
  recovered?: boolean
}

/** `GET /ops?since`, with {@link AnswerHeaders}. */
export type OpsSince = (
  | { revision: number; commits: CommitEvent[] }
  | { revision: number; full: true }
) &
  AnswerHeaders

export type ExportFormat = 'jsonl' | 'papertie'

const base = (id: string) => `/api/boards/${id}`

/** The boards in the data folder. */
export async function listBoards(): Promise<BoardSummary[]> {
  const res = await apiRaw('/api/boards')
  const text = await readBody(res)
  try {
    return JSON.parse(text) as BoardSummary[]
  } catch {
    // a 2xx that is not JSON: a proxy's or the SPA fallback's HTML page, or a cut-off body
    throw new ApiError(res.status, 'bad-response')
  }
}

/**
 * A new board named `name`. With `first`, the board to open on a first run: made only if the user
 * has none, else the one they have (`created: false`), so two boots at once share one board.
 */
export const createBoard = (name: string, first = false) =>
  apiJson<BoardSummary & { created?: boolean }>('/api/boards', {
    method: 'POST',
    json: first ? { name, first } : { name },
  })

/** A non-negative integer header, or null when it is missing or anything else. */
function intHeader(res: Response, name: string): number | null {
  const v = res.headers.get(name)
  if (v === null || !/^\d+$/.test(v)) return null
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * Fetch and parse a board. A body `parseBoard` cannot make a state of is `board-unreadable`. The
 * parse runs in a worker, and the board is built here a batch of records at a time
 * ({@link parseOffThread}), so no long task freezes a board already painted.
 */
export async function loadBoard(id: string, signal?: AbortSignal): Promise<LoadedBoard> {
  const res = await apiRaw(base(id), { signal })
  // Should the worker fail, the board is fetched again and parsed here: no copy of the bytes is
  // kept on this thread meanwhile.
  const again = async () => {
    const text = await readBody(await apiRaw(base(id), { signal }), signal)
    const { parseBoard } = await import('@papertie/core/parse')
    const parsed = parseBoard(text, { blocksHeld: 'none' }).state
    return parsed && withoutBlocks(parsed)
  }
  const state = await parseOffThread(await readBytes(res, signal), undefined, again)
  if (state === null) throw new ApiError(res.status, 'board-unreadable')
  const now = res.headers.get('X-Papertie-Now')
  const known = now !== null && Number.isFinite(Date.parse(now))
  return {
    state,
    revision: intHeader(res, 'X-Papertie-Revision') ?? state.board.revision,
    serverNow: known ? now : new Date().toISOString(),
    serverNowKnown: known,
    recovered: res.headers.get('X-Papertie-Recovered') === '1',
  }
}

export const boardMeta = (id: string) => apiJson<BoardMeta>(`${base(id)}/meta`)

export async function dismissRecovery(id: string): Promise<void> {
  await apiJson(`${base(id)}/recovery`, { method: 'DELETE' })
}

export async function listBackups(id: string): Promise<BackupRow[]> {
  return (await apiJson<{ backups: BackupRow[] }>(`${base(id)}/backups`)).backups
}

/** The server backs up the current board first; `safetyBackup` restores it again. */
export const restoreBackup = (id: string, backupId: string) =>
  apiJson<{ revision: number; safetyBackup: string }>(
    `${base(id)}/backups/${encodeURIComponent(backupId)}/restore`,
    // answered after the board is backed up and replaced
    { method: 'POST', json: {}, timeoutMs: Number.POSITIVE_INFINITY },
  )

/** What a staged import holds (`POST /import`): nothing of it is on the board yet. */
export interface ImportPreview {
  /** The file's board name, which the board takes. */
  name: string
  notes: number
  yarns: number
  /** Photos re-encoded and staged. */
  assets: number
  /** What the staged photos take of the photo quota. */
  bytes: number
  /** Records of a kind this version does not know, left out. */
  skippedRecords: number
  /** The file's books and their paragraphs (absent from a server before it). */
  books?: number
  blocks?: number
}

/**
 * Upload a `.papertie` or `.jsonl` file to stage it as the board's replacement. Errors: 422
 * `import-invalid` (`body.line` when one line is damaged), 507 `quota` (`body.needMb`,
 * `body.freeMb`), 413 `too-large` (`body.freeMb`).
 */
export async function previewImport(
  id: string,
  file: Blob,
  signal?: AbortSignal,
): Promise<{ preview: ImportPreview; importId: string }> {
  const body = new FormData()
  body.append('file', file)
  const res = await apiRaw(`${base(id)}/import`, {
    method: 'POST',
    body,
    signal,
    // answered only after the whole file is uploaded and read
    timeoutMs: Number.POSITIVE_INFINITY,
  })
  try {
    return JSON.parse(await readBody(res, signal)) as { preview: ImportPreview; importId: string }
  } catch (e) {
    if (e instanceof ApiError || signal?.aborted) throw e
    throw new ApiError(res.status, 'bad-response')
  }
}

/** Replace the board with the staged import; the board as it was is `safetyBackup`. */
export const commitImport = (id: string, importId: string) =>
  apiJson<{ revision: number; safetyBackup: string }>(
    `${base(id)}/import/${encodeURIComponent(importId)}/commit`,
    // answered after the whole board is replaced
    { method: 'POST', json: {}, timeoutMs: Number.POSITIVE_INFINITY },
  )

/** Discard the staged import. */
export async function cancelImport(id: string, importId: string): Promise<void> {
  await apiJson(`${base(id)}/import/${encodeURIComponent(importId)}`, { method: 'DELETE' })
}

/** A download link (the server answers with an attachment). */
export const exportHref = (id: string, format: ExportFormat): string =>
  `${base(id)}/export?format=${format}`

export const postBatch = (
  id: string,
  body: OpBatch | StagedPart,
  opts: { signal?: AbortSignal; keepalive?: boolean } = {},
) => apiJson<CommitAck | StagedAck>(`${base(id)}/ops`, { method: 'POST', json: body, ...opts })

/** {@link AnswerHeaders} of `res`: only what it carries. */
function answerHeaders(res: Response): AnswerHeaders {
  const now = res.headers.get('X-Papertie-Now')
  const out: AnswerHeaders = {}
  if (now !== null && Number.isFinite(Date.parse(now))) out.serverNow = now
  if (res.headers.get('X-Papertie-Recovered') === '1') out.recovered = true
  return out
}

export async function opsSince(id: string, rev: number): Promise<OpsSince> {
  const res = await apiRaw(`${base(id)}/ops?since=${rev}`)
  const text = await readBody(res)
  let body: OpsSince
  try {
    body = JSON.parse(text) as OpsSince
  } catch {
    throw new ApiError(res.status, 'bad-response')
  }
  return { ...body, ...answerHeaders(res) }
}

/** One book as the book route answers it: its record and blocks, all of revision `revision`. */
export interface FetchedBook {
  revision: number
  book: Book
  /** In `(pos, id)` order. */
  blocks: Block[]
}

/**
 * `GET /books/:bookId` (rate limited to 30 a minute a user). Null when the board has no such
 * book (404); an answer that cannot be read is `board-unreadable`.
 */
export async function fetchBook(id: string, bookId: string): Promise<FetchedBook | null> {
  let res: Response
  try {
    res = await apiRaw(`${base(id)}/books/${bookId}`)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && e.code === 'not-found') return null
    throw e
  }
  const { parseBook } = await loadBookSync()
  const book = await parseBook(await readBody(res))
  if (book === null) throw new ApiError(res.status, 'board-unreadable')
  return book
}

/** A world rect by its corners, `x0 <= x1` and `y0 <= y1` (`GET /region`, at most 64 tiles). */
export interface RegionRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * `GET /region`: one viewport of the board, for a board's first paint. The board record,
 * the notes in the rect, the photos they show and the threads naming them. The server also sends
 * the frames of those threads' notes outside the rect; they are read and left out here.
 */
export interface BoardRegion {
  board: Board
  notes: Note[]
  others: Array<Asset | Yarn>
}

/**
 * Read a `region` answer: the board record first, then assets, notes and threads, then
 * `{"type":"eof", revision}` at the board's revision. Null for anything else.
 */
export function parseRegion(text: string): BoardRegion | null {
  let board: Board | null = null
  let ended = false
  const notes: Note[] = []
  const others: BoardRegion['others'] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    if (ended) return null
    let line: { type?: unknown; id?: unknown; revision?: unknown } & Record<string, unknown>
    try {
      line = JSON.parse(raw) as typeof line
    } catch {
      return null
    }
    if (typeof line !== 'object' || line === null) return null
    const { type } = line
    if (board === null) {
      const b = type === 'board' ? BoardRecordSchema.safeParse(line) : null
      if (!b?.success) return null
      board = b.data
    } else if (type === 'note') {
      const r = NoteRecordSchema.safeParse(line)
      if (!r.success) return null
      notes.push(r.data)
    } else if (type === 'asset' || type === 'yarn') {
      const r = (type === 'asset' ? AssetRecordSchema : YarnRecordSchema).safeParse(line)
      if (!r.success) return null
      others.push(r.data)
    } else if (type === 'eof') {
      if (line.revision !== board.revision) return null
      ended = true
    } else return null
  }
  return board !== null && ended ? { board, notes, others } : null
}

/** `GET /region` of `rect`. An answer that cannot be read is `board-unreadable`. */
export async function loadRegion(
  id: string,
  rect: RegionRect,
  signal?: AbortSignal,
): Promise<BoardRegion> {
  const q = `x0=${rect.x0}&y0=${rect.y0}&x1=${rect.x1}&y1=${rect.y1}`
  const res = await apiRaw(`${base(id)}/region?${q}`, { signal })
  const region = parseRegion(await readBody(res, signal))
  if (region === null) throw new ApiError(res.status, 'board-unreadable')
  return region
}
