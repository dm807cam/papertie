import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  AssetRecordSchema,
  BlockImageSchema,
  BlockRecordSchema,
  type Board,
  BoardLineSchema,
  BoardRecordSchema,
  BookCoverSchema,
  BookRecordSchema,
  type Eof,
  MarkSchema,
  NoteImageSchema,
  NoteRecordSchema,
  YarnFieldsSchema,
} from '../schema/records'
import { CURRENT_SCHEMA_VERSION } from '../schema/version'
import { type BoardRecord, type BoardState, stateFromRecords } from '../state'
import { repairReferences } from './repair'

export type Integrity = 'ok' | 'missing-eof' | 'checksum-mismatch' | 'count-mismatch'

export type IssueKind =
  | 'invalid-json'
  | 'invalid-record'
  | 'unknown-type'
  | 'duplicate-id'
  | 'missing-board'
  | 'unsupported-version'
  | 'content-after-eof'
  | 'dangling-reference'

export interface LoadIssue {
  /** 1-based physical line number (blank lines counted); 0 for file-level issues and repairs. */
  line: number
  kind: IssueKind
  /** The original line text (or, for repairs, the original record JSON), kept for quarantine. */
  raw: string
  message: string
}

export interface ParseResult {
  /**
   * The loaded board, or `null` when no board could be loaded (no valid board line and no usable
   * `fallbackBoard`, or a board of another schema version).
   *
   * **When `state` is `null` the caller must not overwrite the file**: it must preserve the file
   * whole (e.g. move it aside), never save a replacement over it and never quarantine it line
   * by line. `issues` is then *not* an exhaustive quarantine list: lines that were valid are not
   * reported (they were simply not loaded), and for `unsupported-version` every other issue is
   * discarded because the lines were never judged against that version's schema.
   */
  state: BoardState | null
  /**
   * Problems found, each carrying its raw text. When `state` is non-null, every non-blank line
   * that was not loaded appears here, so the list is a complete quarantine list.
   */
  issues: LoadIssue[]
  integrity: Integrity
}

export interface ParseOptions {
  /**
   * The board record to load the file's records under when its board line is missing or
   * invalid, typically the last known good board (from a backup or the server's
   * index). The `missing-board` issue (and the board line's own issue) is still reported, and
   * integrity is computed from the file as usual. Not used when the file has a valid board line,
   * nor for `unsupported-version` (that stays `state: null`). A fallback that fails
   * `BoardRecordSchema` is ignored.
   */
  fallbackBoard?: Board
  /**
   * Whose blocks to load: `'all'` (the default: a whole file, the server's) or `'none'` (the
   * client's whole-board read, which holds a book's blocks only once it opens it,
   * `book/held.ts`). With `'none'` a block line is hashed and counted for the integrity, as every
   * line is, but neither checked nor loaded nor reported, and the state holds no book: such a
   * state must never be written over the file it came from.
   */
  blocksHeld?: 'all' | 'none'
}

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'board',
  'asset',
  'note',
  'yarn',
  'book',
  'block',
  'eof',
])

/** The record types a body line can be, past the board line. */
const RECORD_TYPES: ReadonlySet<string> = new Set(['asset', 'note', 'yarn', 'book', 'block'])

type Classified =
  | { readonly ok: true; readonly obj: Record<string, unknown> }
  | { readonly ok: false; readonly kind: IssueKind; readonly message: string }

/** JSON-parse a line and check it is an object with a known string `type`. Never throws. */
function classify(raw: string): Classified {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (e) {
    return { ok: false, kind: 'invalid-json', message: e instanceof Error ? e.message : 'bad JSON' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, kind: 'invalid-record', message: 'line is not a JSON object' }
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.type !== 'string') {
    return { ok: false, kind: 'invalid-record', message: 'record has no string "type"' }
  }
  if (!KNOWN_TYPES.has(obj.type)) {
    return {
      ok: false,
      kind: 'unknown-type',
      message: `unknown record type ${JSON.stringify(obj.type.slice(0, 40))}`,
    }
  }
  return { ok: true, obj }
}

function summarize(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  const parts = issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
  if (issues.length > 5) parts.push(`… ${issues.length - 5} more`)
  return parts.join('; ')
}

/**
 * The eof record's body hash, fed the body a piece at a time: each body line with its newline,
 * in order. `hex()` is the lowercase hex SHA-256 of everything fed.
 */
export interface BodyHash {
  update(text: string): void
  hex(): string
}

/** {@link BodyHash} on `@noble/hashes` (what `computeEof` uses), for any platform. */
export function nobleBodyHash(): BodyHash {
  const h = sha256.create()
  const encoder = new TextEncoder()
  return {
    update: (text) => {
      h.update(encoder.encode(text))
    },
    hex: () => bytesToHex(h.digest()),
  }
}

/**
 * Each record type's keys, and those of the closed objects inside a record (a note's image, a
 * book's cover, a block's marks): what a deferred record may carry.
 */
const RECORD_KEYS: Record<string, ReadonlySet<string>> = {
  asset: new Set(Object.keys(AssetRecordSchema.shape)),
  note: new Set(Object.keys(NoteRecordSchema.shape)),
  yarn: new Set(Object.keys(YarnFieldsSchema.shape)),
  book: new Set(Object.keys(BookRecordSchema.shape)),
  block: new Set(Object.keys(BlockRecordSchema.shape)),
}
const IMAGE_KEYS: ReadonlySet<string> = new Set(Object.keys(NoteImageSchema.shape))
const COVER_KEYS: ReadonlySet<string> = new Set(Object.keys(BookCoverSchema.shape))
const MARK_KEYS: ReadonlySet<string> = new Set(Object.keys(MarkSchema.shape))
const BLOCK_IMAGE_KEYS: ReadonlySet<string> = new Set(Object.keys(BlockImageSchema.shape))
const FROM_KEYS: ReadonlySet<string> = new Set(['book', 'block'])

/** Whether `value`, when an object, has only keys in `keys`. */
function closed(value: unknown, keys: ReadonlySet<string>): boolean {
  if (typeof value !== 'object' || value === null) return true
  for (const k in value) if (!keys.has(k)) return false
  return true
}

/**
 * Whether every key of a record line (and of the closed objects inside it) is one this schema
 * has: a key it does not know (a newer build's field, then a rollback) sends the line to the
 * schema check.
 */
function knownKeys(obj: Record<string, unknown>, type: string): boolean {
  const keys = RECORD_KEYS[type]
  if (!keys) return false
  for (const k in obj) if (!keys.has(k)) return false
  if (type === 'note') return closed(obj.image, IMAGE_KEYS) && closed(obj.from, FROM_KEYS)
  if (type === 'book') return closed(obj.cover, COVER_KEYS)
  if (type === 'block') {
    if (!closed(obj.image, BLOCK_IMAGE_KEYS)) return false
    const { marks } = obj
    if (!Array.isArray(marks)) return true
    for (const m of marks) if (!closed(m, MARK_KEYS)) return false
  }
  return true
}

/** Body text is hashed once this many UTF-16 units of whole lines have gathered. */
const HASH_CHUNK = 65_536

/** {@link BoardParser.finish}: the result, or the board and records the state is built from. */
export type ParsedLines =
  | { done: ParseResult }
  | {
      board: Board
      /** Every record loaded, in file order (first per id). */
      records: BoardRecord[]
      /** The per-line issues and `missing-board`, in parseBoard's order (repairs not yet). */
      issues: LoadIssue[]
      integrity: Integrity
      /** The eof record, when the file has a valid one. */
      eof: Eof | null
    }

/**
 * {@link parseBoard}'s pass over the lines, one line at a time, so a caller can stop between any
 * two (to give an event loop back). `line` takes the file's lines in order, as `parseBoard` splits
 * them (on `\r?\n`, the BOM gone), blank ones included; `finish` judges the file once all are in.
 * The eof checksum is hashed as the lines come, by `hash`; with `null` the caller hashes the body
 * lines `line` says are body lines (each with its newline) and gives `finish` the digest.
 */
export class BoardParser {
  private readonly issues: LoadIssue[] = []
  private readonly records: BoardRecord[] = []
  private readonly seen = new Map<string, number>()
  private board: Board | null = null
  private boardLine = 0
  private eof: Eof | null = null
  private afterEof = 0
  private unsupported: LoadIssue | null = null
  /** Non-blank lines before the eof record: the body its `records` counts. */
  private bodyLines = 0
  /** Body lines (each with its newline) not yet given to the hash. */
  private pending = ''

  /**
   * `deferRecords`: record lines (asset, note, thread, book, block) after a valid board line,
   * whose keys are all this schema's, are taken as they parse, without the schema check (a
   * quarter of a load's CPU). For a file a caller trusts only once
   * `finish` says its integrity is `ok` and there is no issue at all (the eof checksum names
   * exactly these lines: a file this program wrote). For any other outcome the result is not
   * `parseBoard`'s, and the caller parses the lines again without it. The board and eof lines
   * are always checked. Since clean files are not re-validated, a change to the values a
   * record may hold must raise `CURRENT_SCHEMA_VERSION` (see `schema/version.ts`).
   *
   * `skipBlocks`: block lines are hashed and counted but neither checked nor loaded (a client's
   * read that holds no book, {@link ParseOptions.blocksHeld}).
   */
  constructor(
    private readonly hash: BodyHash | null = nobleBodyHash(),
    private readonly options: { deferRecords?: boolean; skipBlocks?: boolean } = {},
  ) {}

  /**
   * Line `line` (1-based, blank lines counted) of the file, without its line break. True when it
   * is a line of the body the eof checksum covers (not blank, before the eof record, not it).
   */
  line(raw: string, line: number): boolean {
    if (raw.trim() === '') return false
    const { issues } = this

    if (this.eof) {
      this.afterEof++
      issues.push({ line, kind: 'content-after-eof', raw, message: 'line after the eof record' })
      return false
    }
    if (!this.lineBody(raw, line)) return false
    this.bodyLines++
    if (this.hash) {
      this.pending += `${raw}\n`
      if (this.pending.length >= HASH_CHUNK) {
        this.hash.update(this.pending)
        this.pending = ''
      }
    }
    return true
  }

  /** One body line's record; false when it was the eof record (not part of the hashed body). */
  private lineBody(raw: string, line: number): boolean {
    const { issues } = this
    const c = classify(raw)
    if (!c.ok) {
      issues.push({ line, kind: c.kind, raw, message: c.message })
      return true
    }

    const obj = c.obj
    if (this.options.skipBlocks && obj.type === 'block') return true
    if (
      this.options.deferRecords &&
      this.board !== null &&
      RECORD_TYPES.has(obj.type as string) &&
      typeof obj.id === 'string' &&
      knownKeys(obj, obj.type as string)
    ) {
      return this.record(obj as unknown as BoardRecord, line, raw)
    }
    if (obj.type === 'board') {
      if (this.board) {
        issues.push({
          line,
          kind: 'duplicate-id',
          raw,
          message: `board record already loaded from line ${this.boardLine}`,
        })
        return true
      }
      // The version gate, before the schema: a missing or malformed one is the schema's to refuse.
      const v = obj.schemaVersion
      if (typeof v === 'number' && v !== CURRENT_SCHEMA_VERSION) {
        const issue: LoadIssue = {
          line,
          kind: 'unsupported-version',
          raw,
          message: `schemaVersion ${v} is not the supported ${CURRENT_SCHEMA_VERSION}`,
        }
        this.unsupported ??= issue
        issues.push(issue)
        return true
      }
    }

    const parsed = BoardLineSchema.safeParse(obj)
    if (!parsed.success) {
      issues.push({ line, kind: 'invalid-record', raw, message: summarize(parsed.error.issues) })
      return true
    }

    const rec = parsed.data
    switch (rec.type) {
      case 'board':
        this.board = rec
        this.boardLine = line
        return true
      case 'eof':
        this.eof = rec
        return false
      default:
        return this.record(rec, line, raw)
    }
  }

  /** A record line: loaded unless its id was loaded already (first wins). */
  private record(rec: BoardRecord, line: number, raw: string): true {
    const first = this.seen.get(rec.id)
    if (first !== undefined) {
      this.issues.push({
        line,
        kind: 'duplicate-id',
        raw,
        message: `${rec.type} ${rec.id} already loaded from line ${first}`,
      })
      return true
    }
    this.seen.set(rec.id, line)
    this.records.push(rec)
    return true
  }

  /**
   * Once every line is in: the integrity, and either the board to build `records` under or the
   * whole result when there is no state (another schema version, or no board and no usable fallback).
   * `bodySha256` is the body's digest when the caller hashed it (a parser made with no hash).
   */
  finish(options: ParseOptions = {}, bodySha256?: string): ParsedLines {
    const { issues, eof } = this
    let sha256 = bodySha256 ?? ''
    if (this.hash) {
      if (this.pending !== '') this.hash.update(this.pending)
      this.pending = ''
      sha256 = this.hash.hex()
    }

    let integrity: Integrity
    if (!eof) integrity = 'missing-eof'
    else if (this.afterEof > 0 || eof.records !== this.bodyLines) integrity = 'count-mismatch'
    else integrity = sha256 === eof.sha256 ? 'ok' : 'checksum-mismatch'

    if (this.unsupported) return { done: { state: null, issues: [this.unsupported], integrity } }

    let board = this.board
    if (!board) {
      const fallback = BoardRecordSchema.safeParse(options?.fallbackBoard)
      issues.push({
        line: 0,
        kind: 'missing-board',
        raw: '',
        message: fallback.success
          ? 'no valid board record; records loaded under the fallback board'
          : 'no valid board record',
      })
      if (!fallback.success) return { done: { state: null, issues, integrity } }
      board = fallback.data
    }
    return { board, records: this.records, issues, integrity, eof }
  }
}

/**
 * Parse a board JSONL file. Never throws and, whenever a state is returned, never drops a line
 * silently: every non-blank line is either loaded (the first board, first record per id, the
 * first valid eof) or reported as an issue carrying its raw text. When `state` is `null` the
 * file must be preserved whole; see {@link ParseResult.state}.
 *
 * - A leading BOM is stripped, lines split on `\r?\n`, blank lines skipped (but counted).
 * - Per line: JSON.parse → known-type check → (board only) version gate → schema validation.
 * - First board wins; records are first-wins by id. The first valid `eof` ends collection and
 *   every later non-blank line is `content-after-eof`.
 * - Integrity: no eof → `missing-eof`; content after eof or `eof.records` ≠ the number of
 *   non-blank lines before it → `count-mismatch`; else the hash over those original line texts
 *   decides `checksum-mismatch` | `ok`.
 * - A board whose `schemaVersion` is a number other than {@link CURRENT_SCHEMA_VERSION} →
 *   `state: null` and only the `unsupported-version` issue (other lines are not judged against
 *   this version's schema).
 * - No valid board → a `missing-board` issue, and `state: null` unless
 *   `options.fallbackBoard` is given: then every valid record is loaded under it
 *   (see {@link ParseOptions.fallbackBoard}).
 * - Otherwise references are repaired via {@link repairReferences}.
 * - `options.blocksHeld: 'none'` loads no block (see {@link ParseOptions.blocksHeld}).
 *
 * Issue order: per-line issues in line order, then line-0 issues (`missing-board`, then
 * `dangling-reference` repairs in the order {@link repairReferences} reports them).
 */
export function parseBoard(text: string, options: ParseOptions = {}): ParseResult {
  const src = typeof text === 'string' ? text : ''
  const lines = (src.startsWith('\uFEFF') ? src.slice(1) : src).split(/\r?\n/)
  const none = options.blocksHeld === 'none'
  const parser = new BoardParser(undefined, { skipBlocks: none })
  for (let i = 0; i < lines.length; i++) parser.line(lines[i] as string, i + 1)
  const parsed = parser.finish(options)
  if ('done' in parsed) return parsed.done
  const state = stateFromRecords(parsed.board, parsed.records, none ? new Set() : 'all')
  const repaired = repairReferences(state)
  return {
    state: repaired.state,
    issues: [...parsed.issues, ...repaired.issues],
    integrity: parsed.integrity,
  }
}
