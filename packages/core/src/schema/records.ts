import { POS_PATTERN } from '../book/position'
import { ID_PATTERN, type IdPrefix } from '../ids'
import { LIMITS } from '../limits'
import {
  COVER_INKS,
  COVER_MOTIFS,
  IMAGE_FRAMES,
  MOTIFS,
  PALETTE_TOKENS,
  PAPER_STYLES,
} from '../palette'
import { CURRENT_SCHEMA_VERSION } from './version'
import { z } from './zod'

/*
 * Changing these schemas: a change to the values a record may hold must raise
 * `CURRENT_SCHEMA_VERSION` (`version.ts`), whether it makes a value valid today invalid (a
 * tightened limit, an enum value removed) or adds a value to an enum or a union (a mark's `t`, a
 * block kind, a cover motif): the store loads a `board.jsonl` its eof checksum vouches for
 * without checking each record against these schemas, only its keys (`BoardParser`'s
 * `deferRecords`), so such a value would be taken unchecked. A key added or removed needs no
 * raise: a record with a key these schemas do not have goes to the schema check and is refused.
 */

/** An id string whose prefix is exactly `prefix`. */
export function idOf(prefix: IdPrefix) {
  return z
    .string()
    .regex(ID_PATTERN)
    .refine((s) => s.startsWith(`${prefix}_`), { message: `expected a ${prefix}_ id` })
}

/** ISO-8601 UTC timestamp ending in Z (offsets are rejected). */
const iso = z.iso.datetime()
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const nonNegInt = z.number().int().min(0)
const posInt = z.number().int().min(1)
/** Finite and within the world bounds; Infinity/NaN (e.g. JSON `1e400`) never pass. */
const coord = z.number().finite().min(-LIMITS.maxCoord).max(LIMITS.maxCoord)
/**
 * The board revision a record last changed at, stamped by the commit (`commitBatch`); absent on
 * a record no commit has written (a create op's, an imported board's). Always the record's last key, so a stamped record
 * serializes the same as a parsed one.
 */
const rev = nonNegInt.optional()

export const ClientMarkSchema = z
  .object({
    lastSeq: nonNegInt,
    lastRevision: nonNegInt,
    seenAt: iso,
  })
  .strict()
export type ClientMark = z.infer<typeof ClientMarkSchema>

export const BoardRecordSchema = z
  .object({
    type: z.literal('board'),
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: idOf('board'),
    name: z.string().min(1).max(120),
    revision: nonNegInt,
    clients: z.record(idOf('tab'), ClientMarkSchema),
    createdAt: iso,
    updatedAt: iso,
  })
  .strict()
export type Board = z.infer<typeof BoardRecordSchema>

export const AssetRecordSchema = z
  .object({
    type: z.literal('asset'),
    id: idOf('asset'),
    mime: z.literal('image/webp'),
    width: posInt,
    height: posInt,
    bytes: posInt,
    sha256,
    createdAt: iso,
    rev,
  })
  .strict()
export type Asset = z.infer<typeof AssetRecordSchema>

export const NoteImageSchema = z
  .object({
    assetId: idOf('asset'),
    frame: z.enum(IMAGE_FRAMES),
  })
  .strict()
export type NoteImage = z.infer<typeof NoteImageSchema>

/**
 * Trimmed text: no whitespace at either end (the set `String.prototype.trim` removes), at least
 * one character. A regex, so the JSON Schema says it too.
 */
const TRIMMED = /^\S(?:[\s\S]*\S)?$/
const trimmed = (max: number) => z.string().max(max).regex(TRIMMED)

export const NoteRecordSchema = z
  .object({
    type: z.literal('note'),
    id: idOf('note'),
    x: coord,
    y: coord,
    w: z.number().finite().min(LIMITS.noteMinW).max(LIMITS.noteMaxW),
    h: z.number().finite().min(LIMITS.noteMinH).max(LIMITS.noteMaxH),
    z: z.number().int(),
    paper: z.enum(PALETTE_TOKENS),
    style: z.enum(PAPER_STYLES),
    text: z.string().max(LIMITS.maxTextLength),
    image: NoteImageSchema.nullable(),
    // Decorations: absent means none.
    motif: z.enum(MOTIFS).optional(),
    /** The stamp, a string tie in crimson; `true` or absent, never `false`. */
    stamp: z.literal(true).optional(),
    /** A second sheet of this palette paper layered behind the note. */
    layered: z.enum(PALETTE_TOKENS).optional(),
    /**
     * The book (and block) the card was made from; absent: made on the board.
     * Nothing checks that they are still there (a book can be purged later): the UI hides a stale
     * origin.
     */
    from: z
      .object({ book: idOf('book'), block: idOf('block') })
      .strict()
      .optional(),
    /**
     * The note's reference: free text, shown at the note's
     * bottom and, as the card drops into a book, its footnote's text. Trimmed, line breaks
     * allowed; absent: none.
     */
    ref: trimmed(LIMITS.maxNoteRef).optional(),
    createdAt: iso,
    updatedAt: iso,
    rev,
  })
  .strict()
export type Note = z.infer<typeof NoteRecordSchema>

/**
 * A pin a thread end is tied at: `'hanging'` is the note's own hanging pin; any other key names
 * a pin several ends share (every end on that note with the same key is tied at one pin).
 */
export const PIN_KEY_PATTERN = /^[0-9A-Za-z_-]{1,32}$/
export const PinKeySchema = z.string().regex(PIN_KEY_PATTERN)
export type PinKey = z.infer<typeof PinKeySchema>

/** A thread's shared pins by note id; never empty (absent means every end has its own pin). */
const PinsSchema = z
  .record(idOf('note'), PinKeySchema)
  .refine((pins) => Object.keys(pins).length > 0, { message: 'pins must not be empty' })

/** The yarn's fields without the cross-field rules, for `pick` (refined objects cannot). */
export const YarnFieldsSchema = z
  .object({
    type: z.literal('yarn'),
    id: idOf('yarn'),
    noteIds: z
      .array(idOf('note'))
      .min(2)
      .max(LIMITS.maxThreadNotes)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'noteIds must be unique' }),
    color: z.enum(PALETTE_TOKENS),
    label: z.string().max(LIMITS.maxLabelLength),
    /** Absent means every end of this thread has its own edge pin. */
    pins: PinsSchema.optional(),
    createdAt: iso,
    updatedAt: iso,
    rev,
  })
  .strict()

export const YarnRecordSchema = YarnFieldsSchema.refine(
  (y) => y.pins === undefined || Object.keys(y.pins).every((id) => y.noteIds.includes(id)),
  { message: 'pins must name notes on the thread', path: ['pins'] },
)
export type Yarn = z.infer<typeof YarnRecordSchema>

/** A position key (`book/position.ts`): where a block sits in its book, a book on the shelf. */
export const PosSchema = z.string().max(LIMITS.maxPosLength).regex(POS_PATTERN)

/** A book's cover, drawn from `seed` (random at creation, fixed after) in `ink`. */
export const BookCoverSchema = z
  .object({
    seed: z.number().int().min(0).max(0xffff_ffff),
    ink: z.enum(COVER_INKS),
    motif: z.enum(COVER_MOTIFS),
  })
  .strict()

export const BOOK_LANGS = ['de', 'en'] as const
export type BookLang = (typeof BOOK_LANGS)[number]

/**
 * A book on the shelf. Its text is its blocks (`block` records naming it). `title` may be empty
 * (shown as "Untitled"); `trashedAt` is when it was deleted (put back by setting it `null`), and
 * the server purges it 30 days on. Its `rev` is the last revision anything in it changed: every
 * block op stamps its book.
 */
export const BookRecordSchema = z
  .object({
    type: z.literal('book'),
    id: idOf('book'),
    title: z.string().max(LIMITS.maxBookTitle),
    lang: z.enum(BOOK_LANGS),
    shelfPos: PosSchema,
    cover: BookCoverSchema,
    trashedAt: iso.nullable(),
    createdAt: iso,
    updatedAt: iso,
    /**
     * The cards the book's blocks name (card marks, figures' `image.card`): sorted, unique note
     * ids; absent means none. Derived, stamped by the server in the commit that changes
     * it (`book.cards`, `book/cards.ts`) and recomputed on import; at most `maxBookCards`, past
     * which it is incomplete.
     */
    cards: z
      .array(idOf('note'))
      .max(LIMITS.maxBookCards)
      .refine(sortedUnique, { message: 'cards must be sorted and unique' })
      .optional(),
    rev,
  })
  .strict()
export type Book = z.infer<typeof BookRecordSchema>

/** Whether `ids` are in code-unit order, each once. */
export function sortedUnique(ids: readonly string[]): boolean {
  for (let k = 1; k < ids.length; k++)
    if (!((ids[k - 1] as string) < (ids[k] as string))) return false
  return true
}

/**
 * The mark types of formatting: bold and italic. A card mark's type is `c:` + its note's id, a
 * footnote's anchor `n:` + its footnote block's id.
 */
export const MARK_TYPES = ['b', 'i'] as const

/**
 * A card mark's type: `c:` and the id of the card (note) the marked text came from.
 * Matched whole: `c:` and an id with the `note_` prefix, nothing else.
 */
export type CardMarkT = `c:${string}`
export const CardMarkTSchema = z
  .string()
  .regex(/^c:note_[0-9A-HJKMNP-TV-Z]{26}$/) as unknown as z.ZodType<CardMarkT, CardMarkT>

/**
 * A footnote's anchor's type: `n:` and the id of its `footnote` block, of the same book.
 * Matched whole, as a card mark's. One that names no footnote of its book is dropped on load
 * (`repairReferences`).
 */
export type NoteMarkT = `n:${string}`
export const NoteMarkTSchema = z
  .string()
  .regex(/^n:block_[0-9A-HJKMNP-TV-Z]{26}$/) as unknown as z.ZodType<NoteMarkT, NoteMarkT>

/**
 * Bold, italic, a card's passage or a footnote's anchor over a block's text `[from, to)`. A block's marks are
 * normalized (sorted by `(t, from)` in code-unit order, so `'b' < 'c:…' < 'i' < 'n:…'`, same-`t` ranges
 * merged, `0 ≤ from < to ≤ text.length`): an invariant, not the schema. Two cards' marks on one
 * text both stay. Version 3 added the card types, version 4 the anchors; a type that is none of
 * these is refused.
 */
export const MarkSchema = z
  .object({
    t: z.union([z.enum(MARK_TYPES), CardMarkTSchema, NoteMarkTSchema]),
    from: nonNegInt,
    to: posInt,
  })
  .strict()
export type Mark = z.infer<typeof MarkSchema>

/**
 * `prompt`: a note to the writer after the block it annotates,
 * drawn in the margin; an ordinary text block to core. `figure`: an image asset, its text the
 * caption. `footnote`: a note after the paragraph that anchors it (an `n:` mark), an
 * ordinary text block with bold and italic only; never made from or into another kind, never
 * split or merged.
 */
export const BLOCK_KINDS = ['p', 'h1', 'h2', 'quote', 'li', 'prompt', 'figure', 'footnote'] as const
export type BlockKind = (typeof BLOCK_KINDS)[number]

/** A figure's image: the asset it shows, and the card it was made from, if any. */
export const BlockImageSchema = z
  .object({
    assetId: idOf('asset'),
    card: idOf('note').optional(),
  })
  .strict()

/** A paragraph (or heading, quote, list item, prompt, figure) of a book, at `pos` in its book. */
export const BlockRecordSchema = z
  .object({
    type: z.literal('block'),
    id: idOf('block'),
    bookId: idOf('book'),
    pos: PosSchema,
    kind: z.enum(BLOCK_KINDS),
    text: z.string().max(LIMITS.maxBlockText),
    marks: z.array(MarkSchema).max(LIMITS.maxMarksPerBlock),
    /** Present exactly when `kind` is `figure` (the invariant `figure-image`). */
    image: BlockImageSchema.optional(),
    rev,
  })
  .strict()
export type Block = z.infer<typeof BlockRecordSchema>

export const EofRecordSchema = z
  .object({
    type: z.literal('eof'),
    revision: nonNegInt,
    records: nonNegInt,
    sha256,
  })
  .strict()
export type Eof = z.infer<typeof EofRecordSchema>

export const BoardLineSchema = z.discriminatedUnion('type', [
  BoardRecordSchema,
  AssetRecordSchema,
  NoteRecordSchema,
  YarnRecordSchema,
  BookRecordSchema,
  BlockRecordSchema,
  EofRecordSchema,
])
