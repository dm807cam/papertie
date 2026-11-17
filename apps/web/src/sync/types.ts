import type { Op, OpBatch } from '@papertie/core'

/** `POST /ops` 200 body. */
export interface CommitAck {
  clientId: string
  seq: number
  revision: number
  now: string | null
  duplicate: boolean
  /**
   * The ops as the server applied them, present only when it rewrote the batch (a deletion's
   * `trashedAt` dated by the commit, or a book's `cards` stamped after it; ADR-0005). It may hold
   * more than `maxOpsPerBatch` ops.
   */
  ops?: Op[]
}

/** SSE `commit` data. */
export interface CommitEvent {
  revision: number
  ops: Op[]
  originClientId: string | null
  seq: number | null
  now: string
  /** `batchDigest([ops as posted])`, present only when the server rewrote the batch. */
  sent?: string
}

/**
 * One part of a staged batch (ADR-0005): `count` is 2..64. `digest` names the batch's content (32 hex digits), so
 * the server never combines parts of two batches staged under one `seq`.
 */
export type StagedPart = OpBatch & { part: { index: number; count: number; digest: string } }

/** `POST /ops` 202 body: the parts held so far. */
export interface StagedAck {
  staged: true
  received: number[]
  count: number
}

/** What the save dot shows: `Saved` / `Saving…` / `Not saved yet — trying again` / `Couldn't save`. */
export type SaveStatus = 'saved' | 'saving' | 'offline' | 'error'

/**
 * A quiet message for the user. `dropped`: pending batches that do not apply to the board as the
 * store has it; `rejected`: batches the store refused;
 * `reset`: the board was read whole again; `limit`: a change not made, and why (a book's
 * limit, a full shelf, too late to put a book back), in a slip of its own so it never takes a
 * reset's place nor gives it up to one. `count` is the number of batches concerned.
 */
export interface SyncNotice {
  /** `updated`: a part of the app cannot be fetched; the page must be reloaded. */
  kind: 'dropped' | 'rejected' | 'reset' | 'limit' | 'book-gone' | 'updated'
  count: number
  message: string
  /** A `reset` the server sent (not a photo's slip, which shares the kind). */
  server?: true
  /** A server `reset`'s board revision. */
  revision?: number
  /** `book-gone`: the open book gone under the writer (the book's screen says so). */
  bookId?: string
}
