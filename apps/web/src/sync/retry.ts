import { OpError } from '@papertie/core'
import { ApiError } from '../api/http'

/** What the sync engine does about a failed request (see {@link verdict}). */
export type Verdict = 'retry' | 'busy' | 'reject' | 'invalid' | 'reload' | 'stale' | 'halt'

/** Waits after consecutive failures to reach the server: 1, 2, 4 … 30 s. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000]
/** A failure that retrying soon will not fix (403, 404, an unreadable board): look again this late. */
const HALT_MS = 30_000

export const backoff = (n: number) => BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)] as number

/**
 * What a failed request means, by its code first and its status only where the status alone is
 * the protocol (429, a 5xx). `network` carries no status, and `bad-response` (a 2xx whose
 * body was not the promised JSON: a proxy's page, a cut-off body) is a server or proxy fault
 * despite its 2xx. Only the server's explicit verdicts on the batch drop it: 422 `rejected`, or
 * 400 `invalid` for a batch that fails the schema here too (`invalid`, checked by the sender; a
 * 400 for a batch valid here is a body mangled on the way, and is retried). Anything unknown is
 * retried, so no batch is ever dropped on a guess.
 */
export function verdict(e: unknown): Verdict {
  if (e instanceof OpError) return 'reject'
  if (!(e instanceof ApiError)) return 'halt'
  if (e.code === 'network' || e.code === 'bad-response' || e.status >= 500) return 'retry'
  switch (e.code) {
    // Busy: the server is still deciding an earlier request of this page (whose answer was lost).
    case 'client-busy':
    case 'stage-mismatch':
      return 'busy'
    // The store refused a block batch made against text that changed under it (ADR-0005): the
    // page reads the book again.
    case 'block-stale':
      return e.status === 409 ? 'stale' : 'halt'
    case 'revision-ahead':
    case 'board-unreadable':
      return 'reload'
    case 'rejected':
      return e.status === 422 ? 'reject' : 'halt'
    case 'invalid':
      return e.status === 400 ? 'invalid' : 'halt'
    default:
      // 403, 404, 413 `too-large` (a proxy's lower limit: parts are split to the server's), and
      // codes this client does not know: keep the batch, say `Couldn't save`, look again later.
      return 'halt'
  }
}

/** How long to wait before retrying after `e` (the `n`th failure in a row). */
export function delayFor(e: unknown, n: number): number {
  if (!(e instanceof ApiError)) return backoff(n) // a defect, not the server: try again soon
  const v = verdict(e)
  if (v === 'retry' || v === 'busy') return backoff(n)
  return HALT_MS
}
