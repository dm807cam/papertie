import type { OpError } from '@papertie/core'

export type StoreErrorCode =
  | 'not-found'
  | 'board-unreadable'
  | 'client-busy'
  | 'client-expired'
  | 'revision-ahead'
  | 'rejected'
  | 'storage'
  | 'board-limit'
  /** A block batch made on text that changed since, or on a board replaced since (`blockId`). */
  | 'block-stale'

/** A store failure the HTTP layer maps to a status; never carries content or paths in `message`. */
export class StoreError extends Error {
  readonly code: StoreErrorCode
  readonly opError?: OpError
  readonly reason?: string
  readonly blockId?: string

  constructor(
    code: StoreErrorCode,
    details: { opError?: OpError; reason?: string; blockId?: string } = {},
  ) {
    super(code)
    this.name = 'StoreError'
    this.code = code
    if (details.opError) this.opError = details.opError
    if (details.reason !== undefined) this.reason = details.reason
    if (details.blockId !== undefined) this.blockId = details.blockId
  }
}
