/**
 * Internal: applying ops to a mutable working copy of a `BoardState`. Not exported from the
 * package; `apply.ts` and `invert.ts` build their public functions on it.
 */

import {
  type BookBlocks,
  blockIndex,
  bookBlocks,
  cmp,
  keepBlockIndex,
  type Owned,
  reindexBlock,
} from '../book/blockIndex'
import { withCardChanges } from '../book/cards'
import {
  applySplices,
  mapMarks,
  normalizeMarks,
  sliceMarks,
  subtractMarks,
  takenSplices,
} from '../book/splice'
import { LIMITS } from '../limits'
import type { TransientMap } from '../pmap'
import {
  type Asset,
  type Block,
  type Board,
  type Book,
  BookRecordSchema,
  type Mark,
  type Note,
  NoteRecordSchema,
  type Yarn,
  YarnRecordSchema,
} from '../schema/records'
import { z } from '../schema/zod'
import { asPMap, type BlocksHeld, type BoardState } from '../state'
import { OpError } from './errors'
import { introducedViolationsSteps, type Touched } from './invariants'
import { type Op, OpSchema, type YarnPatch } from './schema'
import { hasThreadIndex, keepThreadIndex, reindex, threadIndex } from './threadIndex'

/**
 * A mutable working copy of `base`. Each map becomes a transient of `base`'s
 * persistent map on its first write, so a batch costs O(ops × log n) and shares every record
 * it does not write. Records are never mutated, only replaced, so `base` is never changed and
 * records read from the draft stay valid after later writes. The ids written are kept in
 * {@link Draft.touched}. After {@link Draft.toState} the draft must not be written again.
 */
export class Draft {
  board: Board
  /** True once an op has changed something. */
  changed = false
  readonly touched = {
    assets: new Set<string>(),
    notes: new Set<string>(),
    yarns: new Set<string>(),
    books: new Set<string>(),
    blocks: new Set<string>(),
  } satisfies Touched
  private readonly base: BoardState
  private assetsW: TransientMap<string, Asset> | null = null
  private notesW: TransientMap<string, Note> | null = null
  private yarnsW: TransientMap<string, Yarn> | null = null
  private threadsW: TransientMap<string, readonly string[]> | null = null
  private booksW: TransientMap<string, Book> | null = null
  private blocksW: TransientMap<string, Block> | null = null
  /** The block index of the draft's blocks, kept with every block written. */
  private bookBlocksW: TransientMap<string, BookBlocks> | null = null
  /** The index's arrays this draft made, which it changes in place (no state has them yet). */
  private readonly ownedBlocks: Owned = new WeakSet()
  /** The books held, once a book op changed them (a state that holds books by name). */
  private heldW: Set<string> | null = null

  constructor(base: BoardState) {
    this.base = base
    this.board = base.board
  }

  get assets(): ReadonlyMap<string, Asset> {
    return this.assetsW ?? this.base.assets
  }
  get notes(): ReadonlyMap<string, Note> {
    return this.notesW ?? this.base.notes
  }
  get yarns(): ReadonlyMap<string, Yarn> {
    return this.yarnsW ?? this.base.yarns
  }
  get books(): ReadonlyMap<string, Book> {
    return this.booksW ?? this.base.books
  }
  get blocks(): ReadonlyMap<string, Block> {
    return this.blocksW ?? this.base.blocks
  }
  get blocksHeld(): BlocksHeld {
    return this.heldW ?? this.base.blocksHeld
  }

  /** Whether the draft holds `bookId`'s blocks. */
  isHeld(bookId: string): boolean {
    const held = this.blocksHeld
    return held === 'all' || held.has(bookId)
  }
  /** Hold `bookId` (a book just made: all its blocks are the ones made here). */
  hold(bookId: string): void {
    const held = this.blocksHeld
    if (held === 'all' || held.has(bookId)) return
    this.heldW ??= new Set(held)
    this.heldW.add(bookId)
  }
  /** No longer hold `bookId` (a book purged). */
  release(bookId: string): void {
    const held = this.blocksHeld
    if (held === 'all' || !held.has(bookId)) return
    this.heldW ??= new Set(held)
    this.heldW.delete(bookId)
  }

  setAsset(id: string, asset: Asset): void {
    this.assetsW ??= asPMap(this.base.assets).asTransient()
    this.assetsW.set(id, asset)
    this.touched.assets.add(id)
  }
  deleteAsset(id: string): void {
    this.assetsW ??= asPMap(this.base.assets).asTransient()
    this.assetsW.delete(id)
    this.touched.assets.add(id)
  }
  setNote(id: string, note: Note): void {
    this.notesW ??= asPMap(this.base.notes).asTransient()
    this.notesW.set(id, note)
    this.touched.notes.add(id)
  }
  deleteNote(id: string): void {
    this.notesW ??= asPMap(this.base.notes).asTransient()
    this.notesW.delete(id)
    this.touched.notes.add(id)
  }
  setYarn(id: string, yarn: Yarn): void {
    this.yarnsW ??= asPMap(this.base.yarns).asTransient()
    if (this.threadsW) reindex(this.threadsW, id, this.yarnsW.get(id), yarn)
    this.yarnsW.set(id, yarn)
    this.touched.yarns.add(id)
  }
  deleteYarn(id: string): void {
    this.yarnsW ??= asPMap(this.base.yarns).asTransient()
    if (this.threadsW) reindex(this.threadsW, id, this.yarnsW.get(id), undefined)
    this.yarnsW.delete(id)
    this.touched.yarns.add(id)
  }

  setBook(id: string, book: Book): void {
    this.booksW ??= asPMap(this.base.books).asTransient()
    this.booksW.set(id, book)
    this.touched.books.add(id)
  }
  deleteBook(id: string): void {
    this.booksW ??= asPMap(this.base.books).asTransient()
    this.booksW.delete(id)
    this.touched.books.add(id)
  }
  /**
   * Name `bookId` as written without writing it: something in it changed (or may have, in a book
   * not held), so a commit stamps its `rev`.
   */
  touchBook(bookId: string): void {
    this.touched.books.add(bookId)
  }
  setBlock(block: Block): void {
    const [blocks, ix] = this.blockMaps()
    reindexBlock(ix, blocks.get(block.id), block, this.ownedBlocks)
    blocks.set(block.id, block)
    this.touched.blocks.add(block.id)
  }
  deleteBlock(id: string): void {
    const [blocks, ix] = this.blockMaps()
    reindexBlock(ix, blocks.get(id), undefined, this.ownedBlocks)
    blocks.delete(id)
    this.touched.blocks.add(id)
  }
  /** The blocks of `bookId` the draft holds, in `(pos, id)` order. */
  blocksOfBook(bookId: string): readonly Block[] {
    const book = this.bookBlocksW ? this.bookBlocksW.get(bookId) : bookBlocks(this.blocks, bookId)
    return book?.chunks.flat() ?? []
  }
  /**
   * The block right before `b` in its book, as the draft holds it (`null`: first), by two binary
   * searches of the book's index: O(log book).
   */
  blockBefore(b: Block): Block | null {
    const book = this.bookBlocksW
      ? this.bookBlocksW.get(b.bookId)
      : bookBlocks(this.blocks, b.bookId)
    const chunks = book?.chunks ?? []
    let lo = 0
    let hi = chunks.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const chunk = chunks[mid] as readonly Block[]
      if (cmp(chunk[chunk.length - 1] as Block, b) < 0) lo = mid + 1
      else hi = mid
    }
    const chunk = chunks[lo] ?? []
    let a = 0
    let z = chunk.length
    while (a < z) {
      const mid = (a + z) >> 1
      if (cmp(chunk[mid] as Block, b) < 0) a = mid + 1
      else z = mid
    }
    if (a > 0) return chunk[a - 1] as Block
    const prev = chunks[lo - 1]
    return prev === undefined ? null : (prev[prev.length - 1] as Block)
  }
  /** How many blocks `bookId` has in the draft, and their text's length. */
  bookSize(bookId: string): { count: number; chars: number } {
    const book = this.bookBlocksW ? this.bookBlocksW.get(bookId) : bookBlocks(this.blocks, bookId)
    return { count: book?.count ?? 0, chars: book?.chars ?? 0 }
  }

  private blockMaps(): [TransientMap<string, Block>, TransientMap<string, BookBlocks>] {
    // The index of `base`, built once if it has none (a hand-built state).
    this.bookBlocksW ??= blockIndex(this.base.blocks).asTransient()
    this.blocksW ??= asPMap(this.base.blocks).asTransient()
    return [this.blocksW, this.bookBlocksW]
  }

  /** The threads naming `noteId`, from the thread index: no scan of every thread. */
  threadsThrough(noteId: string): Yarn[] {
    const keys = this.threads().get(noteId) ?? []
    return keys.map((key) => this.yarns.get(key) as Yarn)
  }

  /** The thread index of the draft's yarns: `base`'s, with the threads written so far re-indexed. */
  private threads(): TransientMap<string, readonly string[]> {
    if (this.threadsW === null) {
      const t = threadIndex(this.base.yarns).asTransient()
      for (const key of this.touched.yarns) {
        reindex(t, key, this.base.yarns.get(key), this.yarns.get(key))
      }
      this.threadsW = t
    }
    return this.threadsW
  }

  /**
   * The resulting state, with `board.updatedAt` stamped `now`; `base` itself (same object) when
   * no op changed anything. Maps never written are shared with `base` (plain `Map`s in a
   * hand-built `base` become `PMap`s, once). With `rev`, every record written that is still
   * there is stamped with it (a commit's new revision).
   */
  toState(now: string, rev?: number): BoardState {
    if (rev !== undefined) this.stamp(rev)
    if (!this.changed) return this.base
    const yarns = this.yarnsW?.persist() ?? asPMap(this.base.yarns)
    // A thread index, once built, is carried over to every later yarn map.
    if (yarns !== this.base.yarns && (this.threadsW || hasThreadIndex(this.base.yarns))) {
      keepThreadIndex(yarns, this.threads().persist())
    }
    let blocks: BoardState['blocks'] = this.base.blocks
    if (this.blocksW && this.bookBlocksW) {
      blocks = this.blocksW.persist()
      keepBlockIndex(blocks, this.bookBlocksW.persist())
    } else blocks = asPMap(blocks)
    return {
      board: { ...this.board, updatedAt: now },
      assets: this.assetsW?.persist() ?? asPMap(this.base.assets),
      notes: this.notesW?.persist() ?? asPMap(this.base.notes),
      yarns,
      books: this.booksW?.persist() ?? asPMap(this.base.books),
      blocks,
      blocksHeld: this.heldW ?? this.base.blocksHeld,
    }
  }

  /**
   * Set `rev` on every record written that is still there, and on every book named (a block op
   * names its book). Costs O(written × log n).
   */
  private stamp(rev: number): void {
    const steps = this.stampSteps(rev)
    while (!steps.next().done) {
      // in one go
    }
  }

  /**
   * {@link stamp}, pausing (yielding) every 64 records: a batch at the ops limit stamps 500
   * (a step of its own in a sliced commit). Then `toState` without `rev`.
   */
  *stampSteps(rev: number): Generator<void, void> {
    let n = 0
    // A book named by a block op in a book not held is stamped without having been written.
    if (this.touched.books.size > 0) this.booksW ??= asPMap(this.base.books).asTransient()
    const maps = [
      [this.assetsW, this.touched.assets],
      [this.notesW, this.touched.notes],
      // A thread's `noteIds` are unchanged by the stamp, so the thread index needs no update.
      [this.yarnsW, this.touched.yarns],
      [this.booksW, this.touched.books],
    ] as const
    for (const [map, ids] of maps) {
      if (map === null) continue
      const m = map as TransientMap<string, { rev?: number }>
      for (const id of ids) {
        const record = m.get(id)
        if (record !== undefined && record.rev !== rev) {
          m.set(id, { ...record, rev })
          this.changed = true
        }
        if (++n % 64 === 0) yield
      }
    }
    // A block's place is unchanged by the stamp: the index slot is replaced, not moved.
    if (this.blocksW === null || this.bookBlocksW === null) return
    for (const id of this.touched.blocks) {
      const block = this.blocksW.get(id)
      if (block !== undefined && block.rev !== rev) {
        const stamped = { ...block, rev }
        reindexBlock(this.bookBlocksW, block, stamped, this.ownedBlocks)
        this.blocksW.set(id, stamped)
        this.changed = true
      }
      if (++n % 64 === 0) yield
    }
  }
}

const IsoNow = z.iso.datetime()

/**
 * The validated `ctx.now`: an ISO-8601 UTC timestamp ending in `Z`. Throws `OpError('invalid')`,
 * since a record stamped with anything else would not load again.
 */
export function checkedNow(ctx: { now: string } | undefined): string {
  const now = (ctx as Partial<{ now: string }> | undefined)?.now
  if (!IsoNow.safeParse(now).success) {
    throw new OpError('invalid', 'ctx.now must be an ISO-8601 UTC timestamp ending in Z')
  }
  return now as string
}

/**
 * Apply every op in order to a draft of `state`, all or nothing (see `applyBatch`), stamping
 * `rev` on the records written when it is given. Returns the state and the ids written.
 */
export function runBatch(
  state: BoardState,
  ops: readonly Op[],
  now: string,
  rev?: number,
): { state: BoardState; touched: Touched } {
  return drain(batchSteps(state, ops, now, rev))
}

/**
 * {@link runBatch} a step at a time: it pauses (yields) between two ops and before each pass over
 * what the batch wrote (the stamp, the invariants), so a caller can give the event loop back
 * between steps (the server's journal replay: a commit at the ops limit was one 145 ms step on
 * a Raspberry Pi). Run to the end, the result and the errors are `runBatch`'s, whatever ran between the
 * steps: the draft is the generator's own until it returns.
 */
export function* batchSteps(
  state: BoardState,
  ops: readonly Op[],
  now: string,
  rev?: number,
): Generator<void, { state: BoardState; touched: Touched }> {
  const d = new Draft(state)
  for (let i = 0; i < ops.length; i++) {
    if (i > 0) yield
    try {
      applyToDraft(d, parseOp(ops[i]), now)
    } catch (err) {
      if (err instanceof OpError) {
        throw new OpError(err.code, `op ${i}: ${err.message}`, { index: i, cause: err })
      }
      throw err
    }
  }
  yield
  // The stamp a few records a step, then the state without it (`toState` stamps nothing then).
  if (rev !== undefined) yield* d.stampSteps(rev)
  const next = d.toState(now)
  if (next !== state) {
    yield
    const first = (yield* introducedViolationsSteps(state, next, d.touched))[0]
    if (first) {
      throw new OpError('invalid', `batch breaks invariants: ${first.kind} on ${first.id}`)
    }
  }
  return { state: next, touched: d.touched }
}

/** A step generator run to its end in one go. */
export function drain<R>(steps: Generator<void, R>): R {
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

/** Schema-check untrusted op input. Throws `OpError('invalid')`. */
export function parseOp(input: unknown): Op {
  const parsed = OpSchema.safeParse(input)
  if (!parsed.success) {
    throw new OpError('invalid', `malformed op: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  }
  return parsed.data
}

/**
 * Structural equality for JSON-shaped values (records, patches), as their JSON reads: key order is
 * ignored, and so is a key holding `undefined` (JSON has no such key).
 */
export function jsonEqual(x: unknown, y: unknown): boolean {
  if (x === y) return true
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false
  if (Array.isArray(x) !== Array.isArray(y)) return false
  const xr = x as Record<string, unknown>
  const yr = y as Record<string, unknown>
  const defined = (r: Record<string, unknown>) => Object.keys(r).filter((k) => r[k] !== undefined)
  const xk = defined(xr)
  if (xk.length !== defined(yr).length) return false
  return xk.every((k) => jsonEqual(xr[k], yr[k]))
}

/**
 * Keys whose patch value `null` removes the key (absent means none). Elsewhere `null` is a
 * value, e.g. `note.image`.
 */
export const REMOVABLE = {
  note: ['motif', 'stamp', 'layered', 'from', 'ref'],
  yarn: ['pins'],
} as const satisfies Record<string, readonly string[]>

type Removable = readonly string[]

const isRemoval = (removable: Removable, k: string, v: unknown) =>
  v === null && removable.includes(k)

/** True when every key of `patch` already has that value on `record` (removing an absent key too). */
function patchIsNoop(record: object, patch: object, removable: Removable): boolean {
  const r = record as Record<string, unknown>
  return Object.entries(patch).every(([k, v]) =>
    isRemoval(removable, k, v) ? r[k] === undefined : jsonEqual(r[k], v),
  )
}

/** `record` with `patch` laid over it; a removal drops the key instead of setting it. */
function withPatch(record: object, patch: object, removable: Removable): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record }
  for (const [k, v] of Object.entries(patch)) {
    if (isRemoval(removable, k, v)) delete out[k]
    else out[k] = v
  }
  return out
}

/**
 * Whether two records are the same apart from `rev`, which only says when the stored one was last
 * committed: a client repeating a create from its own copy (with no rev, or an older one) repeats
 * the same record.
 */
function sameRecord<R extends { rev?: number }>(stored: R, incoming: R): boolean {
  if (stored.rev === incoming.rev) return jsonEqual(stored, incoming)
  const { rev: _a, ...a } = stored
  const { rev: _b, ...b } = incoming
  return jsonEqual(a, b)
}

/** `0` for `-0`, otherwise `v`. */
const plusZero = (v: number) => (v === 0 ? 0 : v)

/**
 * `note` with `-0` replaced by `0` in its numeric fields: JSON has no `-0`, so a
 * stored `-0` would not survive a save and reload. The same object when there is none.
 */
function withoutNegativeZero(note: Note): Note {
  const { x, y, w, h, z } = note
  if (![x, y, w, h, z].some((v) => Object.is(v, -0))) return note
  return { ...note, x: plusZero(x), y: plusZero(y), w: plusZero(w), h: plusZero(h), z: plusZero(z) }
}

function assertImageAsset(d: Draft, note: Note): void {
  if (note.image && !d.assets.has(note.image.assetId)) {
    throw new OpError('invalid', `note ${note.id}: image asset ${note.image.assetId} not found`)
  }
}

/** `yarn` without `noteId`'s pin; `pins` goes when that was its last entry. */
export function withoutPin(yarn: Yarn, noteId: string): Yarn {
  if (yarn.pins === undefined || !Object.hasOwn(yarn.pins, noteId)) return yarn
  const { [noteId]: _gone, ...pins } = yarn.pins
  const { pins: _all, ...rest } = yarn
  return Object.keys(pins).length === 0 ? rest : { ...yarn, pins }
}

/**
 * `set` with its `pins` cut to the notes on `yarn` (none left removes them): a map built before
 * one of its notes was taken off the thread still applies, and so does an undo.
 */
function onThread(yarn: Yarn, set: YarnPatch): YarnPatch {
  if (set.pins === undefined || set.pins === null) return set
  const kept = Object.entries(set.pins).filter(([id]) => yarn.noteIds.includes(id))
  if (kept.length === Object.keys(set.pins).length) return set
  return { ...set, pins: kept.length === 0 ? null : Object.fromEntries(kept) }
}

/**
 * `yarn` with `noteId` taken off: kept (stamped, without that note's pin) if ≥2 notes remain,
 * otherwise deleted.
 */
function takeOff(d: Draft, yarn: Yarn, noteId: string, now: string): void {
  const noteIds = yarn.noteIds.filter((id) => id !== noteId)
  if (noteIds.length < 2) d.deleteYarn(yarn.id)
  else d.setYarn(yarn.id, { ...withoutPin(yarn, noteId), noteIds, updatedAt: now })
}

/**
 * Apply one schema-checked op to `d` in place. Returns whether it changed anything (false for a
 * no-op). Every check runs before the first write, so an op that throws `OpError` leaves `d`
 * exactly as it was. Records written get `updatedAt: now`; the board is stamped by `toState`.
 */
export function applyToDraft(d: Draft, op: Op, now: string): boolean {
  if (isBlockOp(op)) {
    const bookId = op.op === 'block.create' ? op.block.bookId : op.bookId
    // A book not held changes nothing here; the server, which holds it, judges the op.
    const changed = d.isHeld(bookId) ? applyBlockOp(d, op) : false
    // Held or not, changed or not: a commit stamps the book, in the page as in the store.
    d.touchBook(bookId)
    if (changed) d.changed = true
    return changed
  }
  switch (op.op) {
    case 'note.create': {
      const note = withoutNegativeZero(op.note)
      const existing = d.notes.get(note.id)
      if (existing) {
        if (sameRecord(existing, note)) return false
        throw new OpError('conflict', `note ${note.id} already exists with different content`)
      }
      if (d.notes.size >= LIMITS.maxNotes) {
        throw new OpError('limit', `board already has ${LIMITS.maxNotes} notes`)
      }
      assertImageAsset(d, note)
      d.setNote(note.id, note)
      break
    }

    case 'note.update': {
      const existing = d.notes.get(op.id)
      if (!existing) throw new OpError('not-found', `note ${op.id} not found`)
      if (patchIsNoop(existing, op.set, REMOVABLE.note)) return false
      const merged = NoteRecordSchema.safeParse({
        ...withPatch(existing, op.set, REMOVABLE.note),
        updatedAt: now,
      })
      if (!merged.success)
        throw new OpError('invalid', `note ${op.id}: update gives an invalid note`)
      assertImageAsset(d, merged.data)
      d.setNote(op.id, withoutNegativeZero(merged.data))
      break
    }

    case 'note.delete': {
      if (!d.notes.has(op.id)) return false
      d.deleteNote(op.id)
      for (const yarn of d.threadsThrough(op.id)) takeOff(d, yarn, op.id, now)
      break
    }

    case 'yarn.create': {
      const { yarn } = op
      const existing = d.yarns.get(yarn.id)
      if (existing) {
        if (sameRecord(existing, yarn)) return false
        throw new OpError('conflict', `yarn ${yarn.id} already exists with different content`)
      }
      const missing = yarn.noteIds.find((id) => !d.notes.has(id))
      if (missing) throw new OpError('not-found', `yarn ${yarn.id}: note ${missing} not found`)
      d.setYarn(yarn.id, yarn)
      break
    }

    case 'yarn.update': {
      const existing = d.yarns.get(op.id)
      if (!existing) throw new OpError('not-found', `yarn ${op.id} not found`)
      const set = onThread(existing, op.set)
      if (patchIsNoop(existing, set, REMOVABLE.yarn)) return false
      const merged = YarnRecordSchema.safeParse({
        ...withPatch(existing, set, REMOVABLE.yarn),
        updatedAt: now,
      })
      if (!merged.success)
        throw new OpError('invalid', `yarn ${op.id}: update gives an invalid yarn`)
      d.setYarn(op.id, merged.data)
      break
    }

    case 'yarn.insertNote': {
      const yarn = d.yarns.get(op.id)
      if (!yarn) throw new OpError('not-found', `yarn ${op.id} not found`)
      if (yarn.noteIds.includes(op.noteId)) return false
      if (!d.notes.has(op.noteId)) throw new OpError('not-found', `note ${op.noteId} not found`)
      if (yarn.noteIds.length >= LIMITS.maxThreadNotes) {
        throw new OpError('limit', `yarn ${op.id} already has ${LIMITS.maxThreadNotes} notes`)
      }
      // null prepends; a known neighbour inserts after it; a neighbour that is gone appends.
      const after = op.afterNoteId === null ? -1 : yarn.noteIds.indexOf(op.afterNoteId)
      const at = op.afterNoteId === null ? 0 : after === -1 ? yarn.noteIds.length : after + 1
      const noteIds = [...yarn.noteIds.slice(0, at), op.noteId, ...yarn.noteIds.slice(at)]
      d.setYarn(op.id, { ...yarn, noteIds, updatedAt: now })
      break
    }

    case 'yarn.removeNote': {
      const yarn = d.yarns.get(op.id)
      if (!yarn?.noteIds.includes(op.noteId)) return false
      takeOff(d, yarn, op.noteId, now)
      break
    }

    case 'yarn.delete': {
      if (!d.yarns.has(op.id)) return false
      d.deleteYarn(op.id)
      break
    }

    case 'board.update': {
      if (patchIsNoop(d.board, op.set, [])) return false
      d.board = { ...d.board, ...op.set }
      break
    }

    case 'asset.add': {
      const { asset } = op
      const existing = d.assets.get(asset.id)
      if (existing) {
        if (sameRecord(existing, asset)) return false
        throw new OpError('conflict', `asset ${asset.id} already exists with different content`)
      }
      d.setAsset(asset.id, asset)
      break
    }

    case 'asset.remove': {
      // A note still showing it is left to the batch's invariant check (`missing-asset`).
      if (!d.assets.has(op.id)) return false
      d.deleteAsset(op.id)
      break
    }

    case 'book.create': {
      const { book } = op
      const existing = d.books.get(book.id)
      if (existing) {
        if (sameRecord(existing, book)) return false
        throw new OpError('conflict', `book ${book.id} already exists with different content`)
      }
      if (d.books.size >= LIMITS.maxBooks) {
        throw new OpError('limit', `board already has ${LIMITS.maxBooks} books`)
      }
      d.setBook(book.id, book)
      d.hold(book.id)
      break
    }

    case 'book.update': {
      const existing = d.books.get(op.id)
      if (!existing) throw new OpError('not-found', `book ${op.id} not found`)
      if (patchIsNoop(existing, op.set, [])) return false
      const merged = BookRecordSchema.safeParse({ ...existing, ...op.set, updatedAt: now })
      if (!merged.success) {
        throw new OpError('invalid', `book ${op.id}: update gives an invalid book`)
      }
      // The very same `cards` array (a patch never sets it): `cardUses` reads an unchanged array
      // as unchanged cards, never diffing the book.
      d.setBook(
        op.id,
        existing.cards === undefined ? merged.data : { ...merged.data, cards: existing.cards },
      )
      break
    }

    case 'book.cards': {
      const book = d.books.get(op.id)
      // A book purged meanwhile: nothing to stamp.
      if (!book) return false
      const cards = withCardChanges(book.cards ?? [], op.add ?? [], op.remove ?? [])
      const was = book.cards ?? []
      if (cards.length === was.length && cards.every((id, k) => id === was[k])) return false
      // In the schema's key order: `cards` after `updatedAt`, `rev` last. A derived field: the
      // book's `updatedAt` (its owner's last change) stays.
      const { cards: _old, rev, ...rest } = book
      d.setBook(op.id, {
        ...rest,
        ...(cards.length > 0 ? { cards } : {}),
        ...(rev !== undefined ? { rev } : {}),
      })
      break
    }

    case 'book.purge': {
      const book = d.books.get(op.id)
      if (!book) return false
      if (book.trashedAt === null) throw new OpError('invalid', `book ${op.id} is not deleted`)
      // The sweep takes the blocks first, `block.purge` a batch at a time: this op takes at most
      // one batch's worth, so no op of the purge is O(book).
      const { count } = d.bookSize(op.id)
      if (count > LIMITS.maxPurgeBlocks) {
        throw new OpError('limit', `book ${op.id} still has ${count} blocks: purge them first`)
      }
      for (const block of d.blocksOfBook(op.id)) d.deleteBlock(block.id)
      d.deleteBook(op.id)
      d.release(op.id)
      break
    }
  }
  d.changed = true
  return true
}

type BlockOp = Extract<Op, { op: `block.${string}` }>

function isBlockOp(op: Op): op is BlockOp {
  return op.op.startsWith('block.')
}

/** The block `id` of `bookId`, or `OpError('not-found')`: an edit to a block that is gone. */
function blockIn(d: Draft, bookId: string, id: string): Block {
  const block = d.blocks.get(id)
  if (!block) throw new OpError('not-found', `block ${id} not found`)
  if (block.bookId !== bookId) throw new OpError('invalid', `block ${id} is not in book ${bookId}`)
  return block
}

/** `OpError('invalid')` unless every mark of `marks` is within a text of `length`. */
function assertMarksWithin(marks: readonly Mark[], length: number, id: string): void {
  for (const m of marks) {
    if (!(m.from < m.to && m.to <= length)) {
      throw new OpError('invalid', `block ${id}: mark [${m.from}, ${m.to}) is outside its text`)
    }
  }
}

function assertMarksFit(marks: readonly Mark[], id: string): void {
  if (marks.length > LIMITS.maxMarksPerBlock) {
    throw new OpError('limit', `block ${id}: over ${LIMITS.maxMarksPerBlock} marks`)
  }
}

function assertTextFits(length: number, id: string): void {
  if (length > LIMITS.maxBlockText) {
    throw new OpError('limit', `block ${id}: text over ${LIMITS.maxBlockText} characters`)
  }
}

/**
 * A block op on a book the draft holds. Returns whether it changed anything. Every check runs
 * before the first write, as for every op. The per-book limits (`maxBlocksPerBook`,
 * `maxBookChars`) are the batch's invariants: one check per book, after every op.
 */
function applyBlockOp(d: Draft, op: BlockOp): boolean {
  switch (op.op) {
    case 'block.create': {
      const { block } = op
      const existing = d.blocks.get(block.id)
      if (existing) {
        if (sameRecord(existing, block)) return false
        throw new OpError('conflict', `block ${block.id} already exists with different content`)
      }
      if (!d.books.has(block.bookId)) {
        throw new OpError('not-found', `block ${block.id}: book ${block.bookId} not found`)
      }
      d.setBlock(block)
      return true
    }

    case 'block.delete': {
      if (!d.blocks.has(op.id)) return false
      blockIn(d, op.bookId, op.id)
      d.deleteBlock(op.id)
      return true
    }

    case 'block.set': {
      const block = blockIn(d, op.bookId, op.id)
      // A figure stays a figure, and only a figure has an image (`figure-image`); a footnote
      // stays a footnote.
      const { kind, image } = op.set
      if (kind !== undefined && (kind === 'figure') !== (block.kind === 'figure')) {
        throw new OpError('invalid', `block ${op.id}: a kind never changes to or from figure`)
      }
      if (kind !== undefined && (kind === 'footnote') !== (block.kind === 'footnote')) {
        throw new OpError('invalid', `block ${op.id}: a kind never changes to or from footnote`)
      }
      if (image !== undefined && block.kind !== 'figure') {
        throw new OpError('invalid', `block ${op.id}: only a figure has an image`)
      }
      if (patchIsNoop(block, op.set, [])) return false
      d.setBlock({ ...block, ...op.set })
      return true
    }

    case 'block.edit': {
      const block = blockIn(d, op.bookId, op.id)
      let text: string
      try {
        text = applySplices(block.text, op.splices)
      } catch (e) {
        if (!(e instanceof RangeError)) throw e
        throw new OpError('invalid', `block ${op.id}: ${e.message}`)
      }
      assertTextFits(text.length, op.id)
      if (op.takes && op.takes.length !== op.splices.length) {
        throw new OpError('invalid', `block ${op.id}: takes says ${op.takes.length} splices`)
      }
      let marks = mapMarks(block.marks, takenSplices(op.splices, op.takes))
      if (op.removeMarks) {
        assertMarksWithin(op.removeMarks, text.length, op.id)
        marks = subtractMarks(marks, normalizeMarks(op.removeMarks))
      }
      if (op.addMarks) {
        assertMarksWithin(op.addMarks, text.length, op.id)
        marks = normalizeMarks([...marks, ...op.addMarks])
      }
      if (text === block.text && jsonEqual(marks, block.marks)) return false
      assertMarksFit(marks, op.id)
      d.setBlock({ ...block, text, marks })
      return true
    }

    case 'block.split': {
      const block = blockIn(d, op.bookId, op.id)
      const { at } = op
      if (block.kind === 'figure' || op.kind === 'figure') {
        throw new OpError('invalid', `block ${op.id}: a figure is never split`)
      }
      if (block.kind === 'footnote' || op.kind === 'footnote') {
        throw new OpError('invalid', `block ${op.id}: a footnote is never split`)
      }
      if (at > block.text.length) {
        throw new OpError('invalid', `block ${op.id}: split at ${at} is past its text`)
      }
      if (d.blocks.has(op.newId)) throw new OpError('conflict', `block ${op.newId} already exists`)
      const end = block.text.length
      d.setBlock({
        ...block,
        text: block.text.slice(0, at),
        marks: sliceMarks(block.marks, 0, at, 0),
      })
      d.setBlock({
        type: 'block',
        id: op.newId,
        bookId: op.bookId,
        pos: op.pos,
        kind: op.kind,
        text: block.text.slice(at),
        marks: sliceMarks(block.marks, at, end, -at),
      })
      return true
    }

    case 'block.merge': {
      if (op.from === op.into) throw new OpError('invalid', `block ${op.from}: merged into itself`)
      const from = blockIn(d, op.bookId, op.from)
      const into = blockIn(d, op.bookId, op.into)
      if (from.kind === 'figure' || into.kind === 'figure') {
        throw new OpError('invalid', `block ${op.from}: a figure is never merged`)
      }
      if (from.kind === 'footnote' || into.kind === 'footnote') {
        throw new OpError('invalid', `block ${op.from}: a footnote is never merged`)
      }
      if (into.text.length !== op.at) {
        throw new OpError('invalid', `block ${op.into} is ${into.text.length} long, not ${op.at}`)
      }
      assertTextFits(op.at + from.text.length, op.into)
      const moved = sliceMarks(from.marks, 0, from.text.length, op.at)
      const marks = normalizeMarks([...into.marks, ...moved])
      assertMarksFit(marks, op.into)
      d.setBlock({ ...into, text: into.text + from.text, marks })
      d.deleteBlock(op.from)
      return true
    }

    case 'block.purge': {
      const ids = op.ids.filter((id) => d.blocks.has(id))
      for (const id of ids) blockIn(d, op.bookId, id)
      for (const id of ids) d.deleteBlock(id)
      return ids.length > 0
    }
  }
}
