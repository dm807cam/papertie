/**
 * The blocks an op names: what the store reads to tell whether a batch was made against a block
 * that changed since.
 */

import type { Op } from '../ops/schema'

/**
 * The block ids an op names: its own block or blocks, and the block a create or a move says it
 * follows (`after`). A create of a block that follows none names none.
 */
export function namesOf(op: Op): readonly string[] {
  switch (op.op) {
    case 'block.create':
      return typeof op.after === 'string' ? [op.after] : []
    case 'block.set':
      return typeof op.after === 'string' ? [op.id, op.after] : [op.id]
    case 'block.edit':
    case 'block.delete':
      return [op.id]
    case 'block.split':
      return [op.id, op.newId]
    case 'block.merge':
      return [op.from, op.into]
    default:
      return []
  }
}
