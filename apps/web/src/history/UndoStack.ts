import {
  applyLenient,
  type BoardState,
  type ClientOp,
  invertBatch,
  type Op,
  OpError,
} from '@papertie/core'
import { bookOf, bookSync, held, isBlockOp } from '../sync/books/bookOps'

/** One undo or redo step: the result of `undo`/`redo`, for `store.commit`. */
export interface HistoryStep {
  /** The ops that still apply, in order; empty when none does. */
  ops: ClientOp[]
  /** How many ops no longer apply (their note or thread is gone, say). */
  skipped: number
  label: string
}

interface Entry {
  /** Applied in order to the board after the step, they put back the board before it. */
  ops: ClientOp[]
  label: string
  coalesceKey: string | null
  /** `op id key` of every field an update in `ops` puts back: a later update of it adds nothing. */
  covers: Set<string>
}

/** The stack's depth: 200 batches, in memory only. */
const DEFAULT_LIMIT = 200

/** Inverses never hold the server-only asset ops: assets are garbage-collected, not undone. */
const clientOps = (ops: readonly Op[]): ClientOp[] =>
  ops.filter((op): op is ClientOp => op.op !== 'asset.add' && op.op !== 'asset.remove')

/** The `covers` key of each field an update op sets; null for any other op. */
function fieldsOf(op: Op): string[] | null {
  switch (op.op) {
    case 'note.update':
    case 'yarn.update':
      return Object.keys(op.set).map((k) => `${op.op} ${op.id} ${k}`)
    case 'board.update':
      return Object.keys(op.set).map((k) => `${op.op} ${k}`)
    default:
      return null
  }
}

const covered = (covers: Set<string>, op: Op) => fieldsOf(op)?.every((f) => covers.has(f)) ?? false

function cover(covers: Set<string>, ops: readonly Op[]): Set<string> {
  for (const op of ops) for (const f of fieldsOf(op) ?? []) covers.add(f)
  return covers
}

/** `applyLenient` checks the stamp but its board is dropped: any valid instant will do. */
const PROBE = { now: '2000-01-01T00:00:00.000Z' }

/**
 * Replay `ops` against `current` op by op, skipping those that no longer apply: the ops that do,
 * how many did not, and the inverse of the ones that do (against `current`). Each call copies
 * the board's maps once (core's draft), twice when something is skipped; never per op.
 */
function replay(current: BoardState, ops: readonly ClientOp[]) {
  try {
    // The usual case: nothing changed underneath, and the whole entry applies.
    return { ops: [...ops], skipped: 0, inverse: clientOps(invertBatch(current, ops)) }
  } catch (e) {
    if (!(e instanceof OpError)) throw e
  }
  const { skipped } = applyLenient(current, ops, PROBE)
  const gone = new Set(skipped)
  const applied = ops.filter((op) => !gone.has(op))
  // The ones left apply in turn exactly as they did beside the skipped ones, which changed nothing.
  return {
    ops: applied,
    skipped: skipped.length,
    inverse: clientOps(invertBatch(current, applied)),
  }
}

/**
 * The page's undo history over op inverses. A recorded batch is kept as its inverse, never as a
 * board: nothing here walks or copies the notes (core's draft copies a map on its first write).
 * Undo applies that inverse to the board as it is now (the store may have refused a batch or
 * changed the board since): what no longer applies is skipped and counted, what does changes
 * only the fields the step changed. Redo mirrors it. The stacks hold ops only.
 */
export class UndoStack {
  private readonly limit: number
  private readonly done: Entry[] = []
  private readonly undone: Entry[] = []
  /** The entry the last `record` made or grew; an undo or redo ends it. */
  private open: Entry | null = null

  constructor(o: { limit?: number } = {}) {
    this.limit = o.limit ?? DEFAULT_LIMIT
  }

  get canUndo(): boolean {
    return this.done.length > 0
  }

  get canRedo(): boolean {
    return this.undone.length > 0
  }

  /**
   * Record the batch `ops` just applied to `before`; clears redo. Consecutive records with the
   * same `coalesceKey` (a typing session) are one step, which puts back the board before the
   * first: an update of fields the step already puts back adds nothing and is not even inverted.
   */
  record(before: BoardState, ops: readonly ClientOp[], label: string, coalesceKey?: string): void {
    const key = coalesceKey ?? null
    const top = this.open
    const merging = top !== null && key !== null && top.coalesceKey === key
    // Typing: after its first keystroke, a session's updates are all covered, at O(ops) each.
    if (merging && ops.every((op) => covered(top.covers, op))) {
      top.label = label
      return
    }
    const inverse = clientOps(invertBatch(before, ops))
    if (inverse.length === 0) return
    this.undone.length = 0
    if (merging) {
      // Undone first, the newer inverse puts back what the older one does not reach.
      const fresh = inverse.filter((op) => !covered(top.covers, op))
      // A paragraph's keystrokes put back as one edit (the book chunk composes them).
      top.ops = bookSync()?.compose(fresh, top.ops) ?? [...fresh, ...top.ops]
      cover(top.covers, fresh)
      top.label = label
      return
    }
    const entry: Entry = {
      ops: inverse,
      label,
      coalesceKey: key,
      covers: cover(new Set(), inverse),
    }
    this.push(this.done, entry)
    this.open = entry
  }

  /** Undo the newest step against `current`; null when there is none. Its inverse goes to redo. */
  undo(current: BoardState): HistoryStep | null {
    return this.step(this.done, this.undone, current)
  }

  /** Redo the newest undone step against `current`; null when there is none. */
  redo(current: BoardState): HistoryStep | null {
    return this.step(this.undone, this.done, current)
  }

  /** End the open step: the next record starts a new one, even under the same coalesce key. */
  seal(): void {
    this.open = null
  }

  /**
   * Drop the newest step if it is the open one, made under `coalesceKey`: what it did has been
   * taken back by a batch that was not recorded (a new note left empty is deleted, and its
   * creation leaves nothing to undo). Returns whether a step was dropped.
   */
  retract(coalesceKey: string): boolean {
    const top = this.open
    if (top === null || top.coalesceKey !== coalesceKey || this.done.at(-1) !== top) return false
    this.done.pop()
    this.open = null
    return true
  }

  clear(): void {
    this.done.length = 0
    this.undone.length = 0
    this.open = null
  }

  private step(from: Entry[], to: Entry[], current: BoardState): HistoryStep | null {
    const entry = from.pop()
    if (!entry) return null
    this.open = null
    const { label } = entry
    // A book this board does not hold (closed and let go, purged) is never undone blind: its ops
    // are skipped and counted, as an op that no longer applies is.
    const off = (op: ClientOp) => {
      const id = bookOf(op)
      return id !== null && (!current.books.has(id) || !held(current, id))
    }
    const unheld = entry.ops.filter(off).length
    const kept = unheld > 0 ? entry.ops.filter((op) => !off(op)) : entry.ops
    // Its keys fitted to the board as it is (the book chunk's `fitStep`). A step with block ops
    // was made with the book chunk loaded.
    const sync = kept.some(isBlockOp) ? bookSync() : null
    const r = replay(current, sync ? sync.fitStep(current, kept) : kept)
    r.skipped += unheld
    // A step taken back is never merged into: it needs no coalesce key and no covers.
    if (r.inverse.length > 0) {
      this.push(to, { ops: r.inverse, label, coalesceKey: null, covers: new Set() })
    }
    return { ops: r.ops, skipped: r.skipped, label }
  }

  private push(stack: Entry[], entry: Entry): void {
    stack.push(entry)
    if (stack.length > this.limit) stack.shift()
  }
}
