import { LIMITS } from '../limits'
import {
  AssetRecordSchema,
  BLOCK_KINDS,
  BlockRecordSchema,
  BoardRecordSchema,
  BookRecordSchema,
  idOf,
  MarkSchema,
  NoteRecordSchema,
  PosSchema,
  sortedUnique,
  YarnFieldsSchema,
  YarnRecordSchema,
} from '../schema/records'
import { z } from '../schema/zod'

const atLeastOneKey = (patch: object) => Object.keys(patch).length > 0
const NON_EMPTY = { message: 'patch must set at least one field' }

/** Optional decoration fields: a patch value of `null` removes the key from the record. */
const removable = <S extends z.ZodOptional<z.ZodType>>(field: S) => field.unwrap().nullable()

/**
 * Fields a `note.update` may set. Field rules come from `NoteRecordSchema`. `null` on a
 * decoration field (`motif`, `stamp`, `layered`), on `from` (the book a card came from) or on
 * `ref` (the note's reference) removes it; `image: null` is a value, not a removal.
 */
export const NotePatchSchema = NoteRecordSchema.pick({
  x: true,
  y: true,
  w: true,
  h: true,
  z: true,
  paper: true,
  style: true,
  text: true,
  image: true,
})
  .extend({
    motif: removable(NoteRecordSchema.shape.motif),
    stamp: removable(NoteRecordSchema.shape.stamp),
    layered: removable(NoteRecordSchema.shape.layered),
    from: removable(NoteRecordSchema.shape.from),
    ref: removable(NoteRecordSchema.shape.ref),
  })
  .partial()
  .strict()
  .refine(atLeastOneKey, NON_EMPTY)
export type NotePatch = z.infer<typeof NotePatchSchema>

/**
 * Fields a `yarn.update` may set. `noteIds` changes only through insertNote/removeNote. `pins`
 * replaces the whole map, and `pins: null` removes it.
 */
export const YarnPatchSchema = YarnFieldsSchema.pick({ color: true, label: true })
  .extend({
    pins: removable(YarnFieldsSchema.shape.pins),
  })
  .partial()
  .strict()
  .refine(atLeastOneKey, NON_EMPTY)
export type YarnPatch = z.infer<typeof YarnPatchSchema>

export const BoardPatchSchema = BoardRecordSchema.pick({ name: true }).strict()

/** Fields a `book.update` may set: `trashedAt` deletes the book (a time) and puts it back (`null`). */
export const BookPatchSchema = BookRecordSchema.pick({
  title: true,
  lang: true,
  shelfPos: true,
  cover: true,
  trashedAt: true,
})
  .partial()
  .strict()
  .refine(atLeastOneKey, NON_EMPTY)

/**
 * Fields a `block.set` may set; text and marks change through `block.edit`. `image` only on a
 * figure (which keeps one always), and `kind` never to or from `figure`.
 */
export const BlockPatchSchema = BlockRecordSchema.pick({ kind: true, pos: true, image: true })
  .partial()
  .strict()
  .refine(atLeastOneKey, NON_EMPTY)

/** One splice of a block's text (`book/splice.ts`), against the text the one before it left. */
export const SpliceSchema = z
  .object({
    at: z.number().int().min(0).max(LIMITS.maxBlockText),
    del: z.number().int().min(0).max(LIMITS.maxBlockText),
    ins: z.string().max(LIMITS.maxBlockText),
  })
  .strict()

const noteId = idOf('note')
const yarnId = idOf('yarn')
const assetId = idOf('asset')
const bookId = idOf('book')
const blockId = idOf('block')
const offset = z.number().int().min(0).max(LIMITS.maxBlockText)

const clientOps = [
  z.object({ op: z.literal('note.create'), note: NoteRecordSchema }).strict(),
  z.object({ op: z.literal('note.update'), id: noteId, set: NotePatchSchema }).strict(),
  z.object({ op: z.literal('note.delete'), id: noteId }).strict(),
  z.object({ op: z.literal('yarn.create'), yarn: YarnRecordSchema }).strict(),
  z.object({ op: z.literal('yarn.update'), id: yarnId, set: YarnPatchSchema }).strict(),
  z
    .object({
      op: z.literal('yarn.insertNote'),
      id: yarnId,
      noteId,
      afterNoteId: noteId.nullable(),
    })
    .strict(),
  z.object({ op: z.literal('yarn.removeNote'), id: yarnId, noteId }).strict(),
  z.object({ op: z.literal('yarn.delete'), id: yarnId }).strict(),
  z.object({ op: z.literal('board.update'), set: BoardPatchSchema }).strict(),
  z
    .object({
      op: z.literal('book.create'),
      // A book is made live: deleting it is a `book.update`, so undoing that is O(1). Its `cards`
      // are the server's (stamped by `book.cards`, recomputed on import): never a client's, so a
      // held record's stale or forged list can never be planted.
      book: BookRecordSchema.omit({ cards: true }).extend({ trashedAt: z.null() }).strict(),
    })
    .strict(),
  z.object({ op: z.literal('book.update'), id: bookId, set: BookPatchSchema }).strict(),
  z
    .object({
      op: z.literal('block.create'),
      block: BlockRecordSchema,
      /**
       * The block it follows where it was made (`null`: first in the book): a block the batch
       * names (`namesOf`); not stored.
       */
      after: blockId.nullable().optional(),
    })
    .strict(),
  z.object({ op: z.literal('block.delete'), bookId, id: blockId }).strict(),
  z
    .object({
      op: z.literal('block.set'),
      bookId,
      id: blockId,
      set: BlockPatchSchema,
      /**
       * A move (`set.pos`): the block it follows where it was made (`null`: first in the book),
       * which an undo or redo of the move keys it after (`fitBatch`); not stored. Absent on a
       * re-spacing of keys.
       */
      after: blockId.nullable().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('block.edit'),
      bookId,
      id: blockId,
      splices: z.array(SpliceSchema).max(LIMITS.maxSplicesPerEdit),
      /**
       * The mark types each splice's text takes, as the page saw them, one per splice
       * (null: it says nothing, and its text takes the place's). Beside the splices, not in
       * them, so a splice is parsed as before (a key of its own costs every splice a parse).
       */
      takes: z
        .array(
          z
            .array(MarkSchema.shape.t)
            .max(8)
            .refine((ts) => new Set(ts).size === ts.length, { message: 'takes: each type once' })
            .nullable(),
        )
        .max(LIMITS.maxSplicesPerEdit)
        .optional(),
      /** Stated against the text after this op's own splices, as `removeMarks`. */
      addMarks: z.array(MarkSchema).max(LIMITS.maxMarksPerBlock).optional(),
      removeMarks: z.array(MarkSchema).max(LIMITS.maxMarksPerBlock).optional(),
    })
    .strict()
    // One `takes` per splice, checked as the op is parsed (apply checks it too).
    .refine((e) => e.takes === undefined || e.takes.length === e.splices.length, {
      message: 'takes: one per splice',
      path: ['takes'],
    }),
  z
    .object({
      op: z.literal('block.split'),
      bookId,
      id: blockId,
      /** Text `[at, end)` and its marks move to the new block `newId`; the head keeps `id`. */
      at: offset,
      newId: blockId,
      pos: PosSchema,
      kind: z.enum(BLOCK_KINDS),
    })
    .strict(),
  z
    .object({
      op: z.literal('block.merge'),
      bookId,
      /** Appended to `into` (whose text is `at` long), then removed. */
      from: blockId,
      into: blockId,
      at: offset,
    })
    .strict(),
] as const

/** Server-only: the server appends asset records after an upload; clients never send this. */
const AssetAddOpSchema = z.object({ op: z.literal('asset.add'), asset: AssetRecordSchema }).strict()

/**
 * Server-only: the asset sweep takes a record off the board once nothing needs it (ADR-0001,
 * Assets). A note still showing the asset breaks the invariant; clients never send this.
 */
const AssetRemoveOpSchema = z.object({ op: z.literal('asset.remove'), id: assetId }).strict()

/**
 * Server-only: the purge takes a deleted book's blocks off the board, a batch of ids at a time
 * (so no op of the purge is O(book)); clients never send this.
 */
const BlockPurgeOpSchema = z
  .object({
    op: z.literal('block.purge'),
    bookId,
    ids: z.array(blockId).min(1).max(LIMITS.maxPurgeBlocks),
  })
  .strict()

/**
 * Server-only: the purge takes a deleted book (`trashedAt` set) off the board, with any of its
 * blocks the state still holds (none, once `block.purge` has taken them); clients never send this.
 */
const BookPurgeOpSchema = z.object({ op: z.literal('book.purge'), id: bookId }).strict()

/** A sorted list of unique note ids, at most `maxBookCards`: a `book.cards` change. */
const CardIds = z
  .array(noteId)
  .max(LIMITS.maxBookCards)
  .refine(sortedUnique, { message: 'card ids must be sorted and unique' })

/**
 * Server-only: the cards a book's blocks name changed in this commit (`book/cards.ts`): `add` and
 * `remove` applied to its `cards`, in the same revision as the batch that changed them (as `trashedAt` is the server's). Applied whether or not the book's blocks are held; never in an
 * undo. Clients never send this.
 */
const BookCardsOpSchema = z
  .object({
    op: z.literal('book.cards'),
    id: bookId,
    add: CardIds.optional(),
    remove: CardIds.optional(),
  })
  .strict()

/** The ops only the server makes. */
export const SERVER_OPS = [
  'asset.add',
  'asset.remove',
  'block.purge',
  'book.purge',
  'book.cards',
] as const

/** Every op, including the server-only {@link SERVER_OPS}. */
export const OpSchema = z.discriminatedUnion('op', [
  ...clientOps,
  AssetAddOpSchema,
  AssetRemoveOpSchema,
  BlockPurgeOpSchema,
  BookPurgeOpSchema,
  BookCardsOpSchema,
])
export type Op = z.infer<typeof OpSchema>

/** Ops a client may send: everything except the server-only {@link SERVER_OPS}. */
export const ClientOpSchema = z.discriminatedUnion('op', [...clientOps])
export type ClientOp = z.infer<typeof ClientOpSchema>

/** One gesture's ops as posted to the server. */
export const OpBatchSchema = z
  .object({
    clientId: idOf('tab'),
    seq: z.number().int().min(1),
    baseRevision: z.number().int().min(0),
    ops: z.array(ClientOpSchema).min(1).max(LIMITS.maxOpsPerBatch),
  })
  .strict()
export type OpBatch = z.infer<typeof OpBatchSchema>
