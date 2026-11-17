import { appendSplice, type ClientOp, LIMITS, statedSplices, takenSplices } from '@papertie/core'

/**
 * Append `more` to a coalescing batch: a `note.update` right after one of the same note merges
 * into it, later fields winning; a `block.edit` right after one of the same block (that marks
 * nothing) appends its splices to it (`appendSplice`: keystrokes in one place stay one splice),
 * and starts a new edit past `maxSplicesPerEdit`.
 */
export function mergeOps(ops: readonly ClientOp[], more: readonly ClientOp[]): ClientOp[] {
  const out = [...ops]
  for (const op of more) {
    const last = out.at(-1)
    if (last?.op === 'note.update' && op.op === 'note.update' && last.id === op.id) {
      out[out.length - 1] = { op: 'note.update', id: op.id, set: { ...last.set, ...op.set } }
    } else if (
      last?.op === 'block.edit' &&
      op.op === 'block.edit' &&
      last.id === op.id &&
      last.bookId === op.bookId &&
      !last.addMarks &&
      !last.removeMarks
    ) {
      // Each splice with what it takes, so that only keystrokes saying the same join.
      let splices = takenSplices(last.splices, last.takes)
      for (const sp of takenSplices(op.splices, op.takes)) splices = appendSplice(splices, sp)
      if (splices.length > LIMITS.maxSplicesPerEdit) {
        out.push(op)
        continue
      }
      // The new edit's marks are stated against the text after all its splices: after both.
      const { op: _o, bookId, id, splices: _s, takes: _t, ...marks } = op
      out[out.length - 1] = { op: 'block.edit', bookId, id, ...statedSplices(splices), ...marks }
    } else {
      out.push(op)
    }
  }
  return out
}
