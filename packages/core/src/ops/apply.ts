import type { BoardState } from '../state'
import { applyToDraft, checkedNow, Draft, parseOp, runBatch } from './draft'
import { OpError } from './errors'
import type { Op } from './schema'

export interface ApplyCtx {
  /**
   * ISO-8601 UTC timestamp (ending in `Z`) stamped on updated records and on `board.updatedAt`.
   * Checked on every call: anything else throws `OpError('invalid')`, since a record stamped
   * with it would not load again.
   */
  now: string
}

/**
 * Apply one op, returning a new state; the input is never mutated. An op that changes nothing
 * returns the same `state` object. The op and `ctx.now` are schema-checked first, so untrusted
 * input is safe. Deletes (and `yarn.removeNote`) on missing entities are no-ops; updates and
 * inserts on missing entities throw `not-found`. Numeric note fields are stored with `-0` as `0`.
 * Throws `OpError`. The op adds no invariant violation: the result satisfies
 * `validateInvariants` whenever the input does.
 */
export function applyOp(state: BoardState, input: Op, ctx: ApplyCtx): BoardState {
  const now = checkedNow(ctx)
  const d = new Draft(state)
  applyToDraft(d, parseOp(input), now)
  return d.toState(now)
}

/**
 * All-or-nothing: apply every op in order, or throw (the input state is untouched either way).
 * An `OpError` from op `i` is rethrown with `index: i` and the original as `cause`. A batch that
 * changes nothing returns the same `state` object. An op costs O(log n) in the board's size.
 *
 * Safety net: the result is checked with `introducedViolationsAmong` (the
 * same check as `introducedViolations`, on the records the batch wrote); a violation
 * the input did not already have throws `OpError('invalid')`. Violations already present in the
 * input (e.g. a loaded board over the note limit) are tolerated, so such a board stays editable.
 */
export function applyBatch(state: BoardState, ops: readonly Op[], ctx: ApplyCtx): BoardState {
  return runBatch(state, ops, checkedNow(ctx)).state
}

/**
 * Apply each op on its own, skipping those that throw `OpError` (used by undo against a state
 * that has changed since the step was made). A skipped op changes nothing. An invalid `ctx.now` throws
 * `OpError('invalid')` before any op runs; other non-`OpError` errors propagate.
 */
export function applyLenient(
  state: BoardState,
  ops: readonly Op[],
  ctx: ApplyCtx,
): { state: BoardState; skipped: Op[] } {
  const now = checkedNow(ctx)
  const d = new Draft(state)
  const skipped: Op[] = []
  for (const op of ops) {
    try {
      applyToDraft(d, parseOp(op), now)
    } catch (err) {
      if (!(err instanceof OpError)) throw err
      skipped.push(op)
    }
  }
  return { state: d.toState(now), skipped }
}
