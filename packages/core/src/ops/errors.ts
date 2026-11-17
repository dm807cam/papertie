export type OpErrorCode = 'not-found' | 'conflict' | 'invalid' | 'limit'

export interface OpErrorOptions {
  /** The op's position in the batch (set by `applyBatch`). */
  index?: number
  /** The underlying error, e.g. the per-op `OpError` that `applyBatch` rethrows with an index. */
  cause?: unknown
}

/**
 * Why an op could not be applied.
 * - `not-found`: the op targets or references a note/yarn that does not exist.
 * - `conflict`: a create collides with an existing, different record of the same id.
 * - `invalid`: the op, its `ctx.now`, or the record it would produce fails the schema or the
 *   invariants.
 * - `limit`: a size limit from `LIMITS` would be exceeded.
 * `index` is the op's position in the batch when thrown from `applyBatch`; `cause` is then the
 * original per-op error.
 */
export class OpError extends Error {
  readonly code: OpErrorCode
  readonly index: number | undefined

  constructor(code: OpErrorCode, message: string, options: OpErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined)
    this.name = 'OpError'
    this.code = code
    this.index = options.index
  }
}
