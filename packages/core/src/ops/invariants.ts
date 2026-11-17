import { bookBlocks } from '../book/blockIndex'
import { marksSound } from '../book/splice'
import { isId } from '../ids'
import { LIMITS } from '../limits'
import type { BoardState } from '../state'
import { threadIndex } from './threadIndex'

export interface InvariantViolation {
  kind:
    | 'thread-too-short'
    | 'thread-duplicate'
    | 'missing-note'
    | 'missing-asset'
    | 'too-many-notes'
    | 'id-prefix'
    | 'missing-book'
    | 'mark-range'
    | 'too-many-books'
    | 'too-many-blocks'
    | 'book-too-long'
    | 'figure-image'
    | 'footnote-marks'
  /**
   * The offending record: the yarn for thread kinds, the note or block (a figure) for
   * missing-asset, the board for too-many-notes and too-many-books, the block for missing-book,
   * mark-range, figure-image (an image exactly on a figure) and footnote-marks (a
   * footnote's marks are bold and italic only), the book for
   * too-many-blocks and book-too-long, the map key (or board id) for id-prefix.
   */
  id: string
}

/**
 * The hard invariants every state built by ops from a sound state satisfies. Returns `[]` when
 * the state is sound. At most one violation per (kind, record). Does not re-check per-record
 * schemas. A *loaded* state can still violate `too-many-notes` (the parser does not enforce
 * board-wide limits) or anything else a hand-built state carries; see
 * {@link introducedViolations}.
 */
export function validateInvariants(state: BoardState): InvariantViolation[] {
  return violationsOf(state, null)
}

/**
 * Ids per map: the records a batch wrote (set or deleted). `books` also names every book a block
 * op named, held or not (its `rev` is stamped: the last revision anything in it changed).
 */
export interface Touched {
  readonly assets: ReadonlySet<string>
  readonly notes: ReadonlySet<string>
  readonly yarns: ReadonlySet<string>
  readonly books: ReadonlySet<string>
  readonly blocks: ReadonlySet<string>
}

/** A {@link Touched} with nothing in it yet, to gather ids into. */
export function touchedNone(): {
  assets: Set<string>
  notes: Set<string>
  yarns: Set<string>
  books: Set<string>
  blocks: Set<string>
} {
  return {
    assets: new Set(),
    notes: new Set(),
    yarns: new Set(),
    books: new Set(),
    blocks: new Set(),
  }
}

/** The ids to check per map; `null` checks every record. */
type Scope = Touched | null

/** The `[key, record]` pairs of `map` whose keys are in `ids` (all of them when `ids` is null). */
function* within<R>(map: ReadonlyMap<string, R>, ids: ReadonlySet<string> | undefined) {
  if (ids === undefined) {
    yield* map
    return
  }
  for (const id of ids) {
    const record = map.get(id)
    if (record !== undefined) yield [id, record] as const
  }
}

/** {@link validateInvariants} restricted to the records in `scope`; the board-wide checks always run. */
function violationsOf(state: BoardState, scope: Scope): InvariantViolation[] {
  return drainSteps(violationSteps(state, scope))
}

/** Records checked between two pauses of the step generators here. */
const STEP = 64

/** A step generator run to its end in one go. */
function drainSteps<R>(steps: Generator<void, R>): R {
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

/** {@link violationsOf}, pausing (yielding) every {@link STEP} records: the same violations, in order. */
function* violationSteps(state: BoardState, scope: Scope): Generator<void, InvariantViolation[]> {
  const out: InvariantViolation[] = []
  let n = 0

  if (!isId(state.board.id, 'board')) out.push({ kind: 'id-prefix', id: state.board.id })
  const maps = [
    [state.assets, 'asset', scope?.assets],
    [state.notes, 'note', scope?.notes],
    [state.yarns, 'yarn', scope?.yarns],
    [state.books, 'book', scope?.books],
    [state.blocks, 'block', scope?.blocks],
  ] as const
  for (const [map, prefix, ids] of maps) {
    for (const [key, record] of within<{ id: string }>(map, ids)) {
      if (!isId(key, prefix) || record.id !== key) out.push({ kind: 'id-prefix', id: key })
      if (++n % STEP === 0) yield
    }
  }

  if (state.notes.size > LIMITS.maxNotes) out.push({ kind: 'too-many-notes', id: state.board.id })

  for (const [id, note] of within(state.notes, scope?.notes)) {
    if (note.image && !state.assets.has(note.image.assetId)) out.push({ kind: 'missing-asset', id })
    if (++n % STEP === 0) yield
  }

  for (const [id, yarn] of within(state.yarns, scope?.yarns)) {
    if (yarn.noteIds.length < 2) out.push({ kind: 'thread-too-short', id })
    if (new Set(yarn.noteIds).size !== yarn.noteIds.length) {
      out.push({ kind: 'thread-duplicate', id })
    }
    if (yarn.noteIds.some((noteId) => !state.notes.has(noteId))) {
      out.push({ kind: 'missing-note', id })
    }
    if (++n % STEP === 0) yield
  }

  if (state.books.size > LIMITS.maxBooks) out.push({ kind: 'too-many-books', id: state.board.id })

  for (const [id, block] of within(state.blocks, scope?.blocks)) {
    if (!state.books.has(block.bookId)) out.push({ kind: 'missing-book', id })
    if (!marksSound(block.marks, block.text.length)) out.push({ kind: 'mark-range', id })
    if ((block.kind === 'figure') !== (block.image !== undefined)) {
      out.push({ kind: 'figure-image', id })
    }
    if (block.image && !state.assets.has(block.image.assetId)) {
      out.push({ kind: 'missing-asset', id })
    }
    if (block.kind === 'footnote' && block.marks.some((m) => m.t !== 'b' && m.t !== 'i')) {
      out.push({ kind: 'footnote-marks', id })
    }
    if (++n % STEP === 0) yield
  }

  // Per book, from the block index: O(1) a book, never a scan of its blocks.
  const bookIds = scope === null ? bookIdsOf(state) : scope.books
  for (const bookId of bookIds) {
    const book = bookBlocks(state.blocks, bookId)
    if (!state.books.has(bookId)) {
      // A book gone with blocks still naming it (none is, after `book.purge`).
      for (const chunk of book.chunks) {
        for (const block of chunk) {
          if (scope !== null && !scope.blocks.has(block.id)) {
            out.push({ kind: 'missing-book', id: block.id })
          }
          if (++n % STEP === 0) yield
        }
      }
      continue
    }
    if (book.count > LIMITS.maxBlocksPerBook) out.push({ kind: 'too-many-blocks', id: bookId })
    if (book.chars > LIMITS.maxBookChars) out.push({ kind: 'book-too-long', id: bookId })
    if (++n % STEP === 0) yield
  }

  return out
}

/** Every book with blocks or a record: the books a whole-state check looks at. */
function bookIdsOf(state: BoardState): Set<string> {
  const ids = new Set(state.books.keys())
  for (const block of state.blocks.values()) ids.add(block.bookId)
  return ids
}

const violationKey = (v: InvariantViolation) => `${v.kind} ${v.id}`

/**
 * The violations of `after` that `before` did not already have (same kind and id), in
 * `validateInvariants` order. This is the batch safety net: a batch is judged only
 * on what it breaks, so a loaded board that is already over a limit can still be edited.
 */
export function introducedViolations(before: BoardState, after: BoardState): InvariantViolation[] {
  const found = validateInvariants(after)
  if (found.length === 0) return found
  const had = new Set(validateInvariants(before).map(violationKey))
  return found.filter((v) => !had.has(violationKey(v)))
}

/**
 * {@link introducedViolations} for `after`, made from `before` by writing only the ids in
 * `touched` (a draft's): the same violations, at a cost that follows the batch rather than the
 * board. A record that was not written can gain a violation only when a record it names is
 * deleted, so beyond the written records only the threads naming a deleted note (found through
 * the thread index) and the notes showing a removed asset are checked. Finding those notes is one
 * pass over the notes, paid only by a batch that removes an asset (`asset.remove`: server-only,
 * the asset sweep's). Within a kind, records come in `touched` order.
 */
export function introducedViolationsAmong(
  before: BoardState,
  after: BoardState,
  touched: Touched,
): InvariantViolation[] {
  return drainSteps(introducedViolationsSteps(before, after, touched))
}

/**
 * {@link introducedViolationsAmong}, pausing (yielding) every {@link STEP} records: the same
 * violations, in the same order. The pass over every note that removing an asset takes (2 ms at
 * 100,000 notes on a Mac) is one of the steps it splits.
 */
export function* introducedViolationsSteps(
  before: BoardState,
  after: BoardState,
  touched: Touched,
): Generator<void, InvariantViolation[]> {
  const deleted = [...touched.notes].filter((id) => !after.notes.has(id))
  let scope: Touched = touched
  if (deleted.length > 0) {
    // A thread naming a deleted note was either written or named it before too.
    const index = threadIndex(before.yarns)
    const yarns = new Set(touched.yarns)
    for (const id of deleted) for (const key of index.get(id) ?? []) yarns.add(key)
    scope = { ...scope, yarns }
  }
  const removed = new Set([...touched.assets].filter((id) => !after.assets.has(id)))
  if (removed.size > 0) {
    const notes = new Set(scope.notes)
    let n = 0
    for (const [id, note] of after.notes) {
      if (note.image && removed.has(note.image.assetId)) notes.add(id)
      if (++n % STEP === 0) yield
    }
    // And the figures showing it: a pass over the held blocks, paid only by `asset.remove`.
    const blocks = new Set(scope.blocks)
    for (const [id, block] of after.blocks) {
      if (block.image && removed.has(block.image.assetId)) blocks.add(id)
      if (++n % STEP === 0) yield
    }
    scope = { ...scope, notes, blocks }
  }
  const found = yield* violationSteps(after, scope)
  if (found.length === 0) return found
  const had = new Set((yield* violationSteps(before, scope)).map(violationKey))
  return found.filter((v) => !had.has(violationKey(v)))
}
