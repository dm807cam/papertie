import { invertSplices, mapMarks, type Splice, subtractMarks } from '../book/splice'
import type { Block, Yarn } from '../schema/records'
import type { BoardState } from '../state'
import { applyToDraft, Draft, parseOp, REMOVABLE } from './draft'
import type { Op } from './schema'

/**
 * The prior values of exactly the keys `patch` sets. A key that was absent before inverts to
 * `null`, which removes it again (only {@link REMOVABLE} keys can be absent).
 */
function priorValues<P extends object>(record: object, patch: P): P {
  const r = record as Record<string, unknown>
  return Object.fromEntries(Object.keys(patch).map((k) => [k, r[k] ?? null])) as P
}

/** The note before `noteId` on `noteIds`, or `null` when it is first. */
function previousNeighbour(noteIds: readonly string[], noteId: string): string | null {
  return noteIds[noteIds.indexOf(noteId) - 1] ?? null
}

/**
 * The ops that put `noteId` back on the thread `prior` (as it was before it came off), which
 * still exists: back in its place, and its pin with it.
 */
function putBack(prior: Yarn, noteId: string): Op[] {
  const out: Op[] = [
    {
      op: 'yarn.insertNote',
      id: prior.id,
      noteId,
      afterNoteId: previousNeighbour(prior.noteIds, noteId),
    },
  ]
  if (prior.pins !== undefined && Object.hasOwn(prior.pins, noteId)) {
    out.push({ op: 'yarn.update', id: prior.id, set: { pins: prior.pins } })
  }
  return out
}

/**
 * Read what the inverse of `op` needs from `d` *before* the op is applied, and return a function
 * that builds the inverse from that and from `d` *after* it. The draft changes in place, so the
 * "before" values must be captured first; records are immutable, so the captured references
 * stay valid.
 */
function inverseOf(d: Draft, op: Op): () => Op[] {
  switch (op.op) {
    case 'note.create':
      return () => [{ op: 'note.delete', id: op.note.id }]

    case 'note.update': {
      // `from` too: its prior value, or `null` (it was absent) to take it off again.
      const prior = d.notes.get(op.id)
      return () =>
        prior ? [{ op: 'note.update', id: op.id, set: priorValues(prior, op.set) }] : []
    }

    case 'note.delete': {
      const prior = d.notes.get(op.id)
      const threads = prior ? d.threadsThrough(op.id) : []
      return () => {
        if (!prior) return []
        const out: Op[] = [{ op: 'note.create', note: prior }]
        for (const yarn of threads) {
          if (d.yarns.has(yarn.id)) out.push(...putBack(yarn, op.id))
          else out.push({ op: 'yarn.create', yarn })
        }
        return out
      }
    }

    case 'yarn.create':
      return () => [{ op: 'yarn.delete', id: op.yarn.id }]

    case 'yarn.update': {
      const prior = d.yarns.get(op.id)
      return () =>
        prior ? [{ op: 'yarn.update', id: op.id, set: priorValues(prior, op.set) }] : []
    }

    case 'yarn.insertNote':
      return () => [{ op: 'yarn.removeNote', id: op.id, noteId: op.noteId }]

    case 'yarn.removeNote': {
      const prior = d.yarns.get(op.id)
      return () => {
        if (!prior) return []
        if (!d.yarns.has(op.id)) return [{ op: 'yarn.create', yarn: prior }]
        return putBack(prior, op.noteId)
      }
    }

    case 'yarn.delete': {
      const prior = d.yarns.get(op.id)
      return () => (prior ? [{ op: 'yarn.create', yarn: prior }] : [])
    }

    case 'board.update': {
      const name = d.board.name
      return () => [{ op: 'board.update', set: { name } }]
    }

    case 'asset.add':
      // Assets are garbage-collected, not undone.
      return () => []

    case 'asset.remove': {
      const prior = d.assets.get(op.id)
      return () => (prior ? [{ op: 'asset.add', asset: prior }] : [])
    }

    case 'book.create':
      // Undone, a new book goes to "Recently deleted" (dated when it was made), never purged.
      return () => [{ op: 'book.update', id: op.book.id, set: { trashedAt: op.book.createdAt } }]

    case 'book.update': {
      // `trashedAt` too: undoing a delete (or a put back) is this one O(1) op.
      const prior = d.books.get(op.id)
      return () =>
        prior ? [{ op: 'book.update', id: op.id, set: priorValues(prior, op.set) }] : []
    }

    case 'block.create':
      return () => [{ op: 'block.delete', bookId: op.block.bookId, id: op.block.id }]

    case 'block.delete': {
      const prior = d.blocks.get(op.id)
      return () => (prior ? [{ op: 'block.create', block: prior }] : [])
    }

    case 'block.set': {
      // `image` too (a figure's): its prior value, which a figure always has.
      const prior = d.blocks.get(op.id)
      // A move that says what it follows is undone by one that says so too: the block
      // before the moved one just before the move (a chapter's run, each after the same block,
      // undone in reverse, each right after it). O(log book).
      const moved = prior !== undefined && op.set.pos !== undefined && op.after !== undefined
      const after = moved ? (d.blockBefore(prior)?.id ?? null) : undefined
      return () => {
        if (!prior) return []
        const set = priorValues(prior, op.set)
        return [
          after === undefined
            ? { op: 'block.set', bookId: op.bookId, id: op.id, set }
            : { op: 'block.set', bookId: op.bookId, id: op.id, set, after },
        ]
      }
    }

    case 'block.edit': {
      const prior = d.blocks.get(op.id)
      return () => {
        const after = d.blocks.get(op.id)
        return prior && after ? [uneditOf(prior, after, op.splices)] : []
      }
    }

    case 'block.split': {
      const prior = d.blocks.get(op.id)
      return () =>
        prior
          ? [{ op: 'block.merge', bookId: op.bookId, from: op.newId, into: op.id, at: op.at }]
          : []
    }

    case 'block.merge': {
      const from = d.blocks.get(op.from)
      return () =>
        from
          ? [
              {
                op: 'block.split',
                bookId: op.bookId,
                id: op.into,
                at: op.at,
                newId: op.from,
                pos: from.pos,
                kind: from.kind,
              },
            ]
          : []
    }

    case 'block.purge':
    case 'book.purge':
      // Server-only, and what it takes is gone for good: never undone.
      return () => []

    case 'book.cards':
      // Server-only and derived: the next commit that changes the blocks stamps them again.
      // Never in an undo.
      return () => []
  }
}

/**
 * The `block.edit` that turns `after` (the block once `splices` applied to `before`) back into
 * `before` exactly: the splices turned around, then the marks they do not carry back removed and
 * the ones they lose added again.
 */
function uneditOf(before: Block, after: Block, splices: readonly Splice[]): Op {
  const back = invertSplices(before.text, splices)
  const carried = mapMarks(after.marks, back)
  const removeMarks = subtractMarks(carried, before.marks)
  const addMarks = subtractMarks(before.marks, carried)
  return {
    op: 'block.edit',
    bookId: before.bookId,
    id: before.id,
    splices: back,
    ...(removeMarks.length > 0 ? { removeMarks } : {}),
    ...(addMarks.length > 0 ? { addMarks } : {}),
  }
}

/**
 * Apply `input` to the draft (as applyOp would) and return its inverse: `[]` when the op was a
 * no-op. Throws the op's `OpError`, leaving the draft unchanged.
 */
function applyAndInvert(d: Draft, input: Op): Op[] {
  const op = parseOp(input)
  const inverse = inverseOf(d, op)
  // The timestamp is irrelevant: inverses carry prior values, never stamps from the draft.
  return applyToDraft(d, op, d.board.updatedAt) ? inverse() : []
}

/**
 * The ops that undo `op`: applied in order to `applyOp(before, op)`, they restore `before`
 * apart from `updatedAt` stamps, with these exceptions:
 * - `asset.add` inverts to `[]` because assets are garbage-collected; `asset.remove` inverts to
 *   `asset.add` of the whole record.
 * - `book.create` inverts to `book.update { trashedAt: book.createdAt }`: the book is deleted
 *   (to "Recently deleted", whence it can be put back), never removed, so an undo cannot lose
 *   writing; redoing it is `trashedAt: null`.
 * - `block.purge` and `book.purge` (server-only) invert to `[]`: what they take is gone for good.
 * - A block op on a book the state does not hold inverts to `[]` (it changes nothing there).
 *
 * An op that would be a no-op inverts to `[]`. The op is applied internally to decide this, so an
 * op that `applyOp` rejects throws the same `OpError`. `before` is never mutated.
 */
export function invertOp(before: BoardState, op: Op): Op[] {
  return applyAndInvert(new Draft(before), op)
}

/**
 * The ops that undo the batch `ops` applied to `before`: each op is inverted against the
 * intermediate state it applies to, and the per-op inverses are concatenated in reverse order.
 * Throws the `OpError` of the first op that cannot apply. `before` is never mutated.
 */
export function invertBatch(before: BoardState, ops: readonly Op[]): Op[] {
  const d = new Draft(before)
  const perOp = ops.map((op) => applyAndInvert(d, op))
  return perOp.reverse().flat()
}

function withoutUpdatedAt<R extends object>(record: R): Omit<R, 'updatedAt'> {
  const { updatedAt: _ignored, ...rest } = record as R & { updatedAt?: unknown }
  return rest
}

/** `record` without `updatedAt` and `rev`: when it last changed, not what it holds. */
function withoutStamps<R extends object>(record: R) {
  const { rev: _rev, ...rest } = withoutUpdatedAt(record) as Omit<R, 'updatedAt'> & {
    rev?: unknown
  }
  return rest
}

function sortedRecords<R extends { id: string }>(map: ReadonlyMap<string, R>) {
  return [...map.values()]
    .map(withoutStamps)
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
}

/**
 * A plain, comparable snapshot of `state` with `updatedAt` removed from the board and from every
 * record, and each record's `rev` too (`createdAt` is kept). Records are listed sorted by id, so
 * map insertion order does not matter. For tests: `expect(stripTimestamps(x)).toEqual(stripTimestamps(y))`.
 */
export function stripTimestamps(state: BoardState): unknown {
  return {
    board: withoutUpdatedAt(state.board),
    assets: sortedRecords(state.assets),
    notes: sortedRecords(state.notes),
    yarns: sortedRecords(state.yarns),
    books: sortedRecords(state.books),
    blocks: sortedRecords(state.blocks),
    blocksHeld: state.blocksHeld === 'all' ? 'all' : [...state.blocksHeld].sort(),
  }
}
