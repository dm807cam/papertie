import { createHash } from 'node:crypto'
import {
  type Asset,
  type Block,
  type Board,
  BoardLineSchema,
  type Book,
  CURRENT_SCHEMA_VERSION,
  cardsOfBlock,
  type Eof,
  LIMITS,
  marksSound,
  type Note,
  type Yarn,
} from '@papertie/core'
import { CHECK, SLICE_MS, Slicer } from './compact'
import { IMPORT_LIMITS, ImportAborted, ImportInvalid } from './importErrors'

export interface ReadBoard {
  board: Board
  /** The file's asset records by their (old) id, with the line each came from. */
  assets: Map<string, { record: Asset; line: number }>
  notes: Note[]
  yarns: Yarn[]
  /** Notes showing a photo: index into `notes`, the asset id they name, their line. */
  imageNotes: Array<{ index: number; assetId: string; line: number }>
  noteLines: Map<string, number>
  yarnLines: Map<string, number>
  /** The file's books and blocks, which come with the board: one unit. */
  books: Book[]
  blocks: Block[]
  /** Figures: index into `blocks`, the asset they show, their line. */
  imageBlocks: Array<{ index: number; assetId: string; line: number }>
  bookLines: Map<string, number>
  blockLines: Map<string, number>
  skipped: number
}

/**
 * What an import may hold beyond the notes: threads, photo records (at most one per note), books
 * and the blocks of one book (as many as a board may hold).
 */
export const IMPORT_CAPS = {
  yarns: 4 * LIMITS.maxNotes,
  assets: LIMITS.maxNotes,
  books: LIMITS.maxBooks,
  blocksPerBook: LIMITS.maxBlocksPerBook,
} as const

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'board',
  'asset',
  'note',
  'yarn',
  'book',
  'block',
  'eof',
])

/** A record as this board will hold it: without the revision it last changed at elsewhere. */
function withoutRev<R extends { rev?: number }>(r: R): R {
  const { rev: _rev, ...rest } = r
  return rest as R
}

/**
 * `book` with `cards` the sorted ids of `named` (at most `maxBookCards`), or without the key when
 * none: what its blocks name, whatever the file said. In the record's key order (`rev` is gone).
 */
function withCards(book: Book, named: ReadonlySet<string> | undefined): Book {
  const { cards: _file, ...rest } = book
  if (named === undefined || named.size === 0) return rest
  const ids = [...named].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { ...rest, cards: ids.slice(0, LIMITS.maxBookCards) }
}

/**
 * The lines of a board file, read as they stream in and judged as `parseBoard` judges them, but
 * strictly: the first problem rejects the file (`ImportInvalid` with its line; `not-papertie` when
 * no line before it was a record, so a file that is something else entirely is called that).
 * A board line whose `schemaVersion` is another number is `unsupported-version` wherever it is.
 * The `eof` record's count and checksum must match the lines before it. Reading yields to the
 * event loop at least every `SLICE_MS`.
 */
export async function readBoardLines(
  chunks: AsyncIterable<Buffer>,
  signal?: AbortSignal,
): Promise<ReadBoard> {
  const s = await Slicer.start(SLICE_MS)
  /** A slice ends: let the loop run, then stop here if the import was called off. */
  const pause = async () => {
    await s.pause()
    if (signal?.aborted) throw new ImportAborted()
  }
  const hash = createHash('sha256')
  const out: ReadBoard = {
    board: null as unknown as Board,
    assets: new Map(),
    notes: [],
    yarns: [],
    imageNotes: [],
    noteLines: new Map(),
    yarnLines: new Map(),
    books: [],
    blocks: [],
    imageBlocks: [],
    bookLines: new Map(),
    blockLines: new Map(),
    skipped: 0,
  }
  /** Blocks per book id, as they come, and their text's length (UTF-16 units). */
  const perBook = new Map<string, number>()
  const charsPer = new Map<string, number>()
  let board: Board | null = null
  let eof: { record: Eof; line: number } | null = null
  let body = 0
  let accepted = 0
  let lineNo = 0
  const reject = (reason: string, line: number): never => {
    throw accepted === 0 ? new ImportInvalid('not-papertie') : new ImportInvalid(reason, line)
  }

  const take = (raw: string, line: number) => {
    if (raw.trim() === '') return
    if (eof) reject('content-after-eof', line)
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      reject('invalid-json', line)
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      reject('invalid-record', line)
    }
    const obj = value as Record<string, unknown>
    const type = obj.type
    if (typeof type !== 'string') reject('invalid-record', line)
    if (type !== 'eof') hash.update(`${raw}\n`)
    if (!KNOWN_TYPES.has(type as string)) {
      body++
      out.skipped++
      return
    }
    if (type === 'board') {
      if (board) reject('duplicate-id', line)
      // A board line of another version is a Papertie file all the same: said as that, on any line.
      const v = obj.schemaVersion
      if (typeof v === 'number' && v !== CURRENT_SCHEMA_VERSION) {
        throw new ImportInvalid('unsupported-version', line)
      }
    }
    const parsed = BoardLineSchema.safeParse(obj)
    if (!parsed.success) {
      if (type === 'eof') reject('invalid-eof', line)
      return reject('invalid-record', line)
    }
    const rec = parsed.data
    accepted++
    if (rec.type === 'eof') {
      eof = { record: rec, line }
      return
    }
    body++
    switch (rec.type) {
      case 'board':
        board = rec
        return
      case 'asset':
        if (out.assets.has(rec.id)) reject('duplicate-id', line)
        if (out.assets.size >= IMPORT_CAPS.assets) throw new ImportInvalid('too-many-assets')
        out.assets.set(rec.id, { record: withoutRev(rec), line })
        return
      case 'note': {
        if (out.noteLines.has(rec.id)) reject('duplicate-id', line)
        if (out.notes.length >= LIMITS.maxNotes) throw new ImportInvalid('too-many-notes')
        out.noteLines.set(rec.id, line)
        if (rec.image) {
          out.imageNotes.push({ index: out.notes.length, assetId: rec.image.assetId, line })
        }
        out.notes.push(withoutRev(rec))
        return
      }
      case 'yarn':
        if (out.yarnLines.has(rec.id)) reject('duplicate-id', line)
        if (out.yarns.length >= IMPORT_CAPS.yarns) throw new ImportInvalid('too-many-threads')
        out.yarnLines.set(rec.id, line)
        out.yarns.push(withoutRev(rec))
        return
      case 'book':
        if (out.bookLines.has(rec.id)) reject('duplicate-id', line)
        if (out.books.length >= IMPORT_CAPS.books) throw new ImportInvalid('too-many-books')
        out.bookLines.set(rec.id, line)
        out.books.push(withoutRev(rec))
        return
      case 'block': {
        if (out.blockLines.has(rec.id)) reject('duplicate-id', line)
        // Marks normalized and within the text: the invariant every board keeps.
        if (!marksSound(rec.marks, rec.text.length)) reject('invalid-record', line)
        // An image exactly on a figure (`figure-image`).
        if ((rec.kind === 'figure') !== (rec.image !== undefined)) reject('invalid-record', line)
        if (rec.image) {
          out.imageBlocks.push({ index: out.blocks.length, assetId: rec.image.assetId, line })
        }
        const n = (perBook.get(rec.bookId) ?? 0) + 1
        if (n > IMPORT_CAPS.blocksPerBook) throw new ImportInvalid('too-many-blocks')
        perBook.set(rec.bookId, n)
        // A book's text as the board bounds it: a book past it would stay past it (a batch never
        // fails on a violation it did not make), and its route would build it whole.
        const chars = (charsPer.get(rec.bookId) ?? 0) + rec.text.length
        if (chars > LIMITS.maxBookChars) throw new ImportInvalid('book-too-long', line)
        charsPer.set(rec.bookId, chars)
        out.blockLines.set(rec.id, line)
        out.blocks.push(withoutRev(rec))
        return
      }
    }
  }

  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let first = true
  const decode = (bytes?: Buffer) => {
    try {
      return bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode()
    } catch {
      return reject('not-utf8', lineNo + 1)
    }
  }
  const lines = function* (text: string, final: boolean) {
    pending += text
    if (first && pending.length > 0) {
      if (pending.startsWith('﻿')) pending = pending.slice(1)
      first = false
    }
    let at = 0
    for (let nl = pending.indexOf('\n', at); nl >= 0; nl = pending.indexOf('\n', at)) {
      const end = nl > at && pending.charCodeAt(nl - 1) === 13 ? nl - 1 : nl
      yield pending.slice(at, end)
      at = nl + 1
    }
    pending = pending.slice(at)
    if (pending.length > IMPORT_LIMITS.maxLineChars) reject('invalid-record', lineNo + 1)
    if (final && pending !== '') {
      const raw = pending
      pending = ''
      yield raw.endsWith('\r') ? raw.slice(0, -1) : raw
    }
  }

  for await (const chunk of chunks) {
    for (const raw of lines(decode(chunk), false)) {
      take(raw, ++lineNo)
      if (lineNo % CHECK === 0 && s.due()) await pause()
    }
    if (s.due()) await pause()
  }
  for (const raw of lines(decode(), true)) take(raw, ++lineNo)

  if (!board) {
    if (accepted === 0) throw new ImportInvalid('not-papertie')
    throw new ImportInvalid('missing-board')
  }
  const end = eof as { record: Eof; line: number } | null
  // Cut off before its end: damaged just past the last line there is.
  if (!end) throw new ImportInvalid('missing-eof', lineNo + 1)
  if (end.record.records !== body) throw new ImportInvalid('count-mismatch', end.line)
  if (hash.digest('hex') !== end.record.sha256) {
    throw new ImportInvalid('checksum-mismatch', end.line)
  }
  out.board = board

  // The references every board keeps: a shown photo has its record, a thread's notes exist.
  for (const n of out.imageNotes) {
    if (!out.assets.has(n.assetId)) throw new ImportInvalid('missing-asset', n.line)
  }
  // A figure whose photo has no record is kept as its caption by `build`, as one whose files are
  // missing is (a restored board's export imports).
  let i = 0
  for (const yarn of out.yarns) {
    for (const id of yarn.noteIds) {
      if (!out.noteLines.has(id)) {
        throw new ImportInvalid('missing-note', out.yarnLines.get(yarn.id))
      }
    }
    if (++i % CHECK === 0 && s.due()) await pause()
  }
  // A block's book is in the file. And the cards each book's blocks name, gathered in the same
  // sliced pass: a book's `cards` is derived, recomputed here and never taken from the file.
  const cards = new Map<string, Set<string>>()
  for (const block of out.blocks) {
    if (!out.bookLines.has(block.bookId)) {
      throw new ImportInvalid('missing-book', out.blockLines.get(block.id))
    }
    for (const n of cardsOfBlock(block)) {
      let set = cards.get(block.bookId)
      if (set === undefined) {
        set = new Set()
        cards.set(block.bookId, set)
      }
      set.add(n)
    }
    if (++i % CHECK === 0 && s.due()) await pause()
  }
  for (let k = 0; k < out.books.length; k++) {
    out.books[k] = withCards(out.books[k] as Book, cards.get((out.books[k] as Book).id))
    if (s.due()) await pause()
  }
  s.note()
  return out
}
