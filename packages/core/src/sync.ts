import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { batchSteps, checkedNow, drain } from './ops/draft'
import { OpError } from './ops/errors'
import type { Touched } from './ops/invariants'
import type { Op } from './ops/schema'
import type { Board } from './schema/records'
import type { BoardState } from './state'

/** Client marks not seen for longer than this (by the supplied `now`) are pruned. */
export const CLIENT_MARK_TTL_MS = 90 * 86_400_000

/** Bytes reserved per chunk for the request envelope around the ops array. */
const ENVELOPE_BYTES = 512

/** The client batch a commit acknowledges: `seq` is the client's sequence number for it. */
export interface CommitMark {
  clientId: string
  seq: number
}

/** Code-unit comparison (not locale-aware) so ordering is identical on every platform. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Drop marks whose `seenAt` is more than {@link CLIENT_MARK_TTL_MS} before `now`. A mark exactly
 * at the limit is kept, and so is one dated in the future. Reads no clock: the result depends only
 * on the arguments. Returns a new object with keys in code-unit order; the input is untouched.
 */
export function pruneClients(clients: Board['clients'], now: string): Board['clients'] {
  const nowMs = Date.parse(now)
  const out: Board['clients'] = {}
  for (const id of Object.keys(clients).sort(cmp)) {
    const mark = clients[id]
    if (mark && !(nowMs - Date.parse(mark.seenAt) > CLIENT_MARK_TTL_MS)) out[id] = mark
  }
  return out
}

/** A commit's result: the new state and the ids each map had written (set or deleted). */
export interface Committed {
  state: BoardState
  written: Touched
  /**
   * The `book.cards` ops the commit appended after the batch, in the same revision (`stamp`:
   * the server's commit); empty when no book's set of cards changed, and always without
   * a stamper. The server journals and sends the batch with these after it, so a replay (and every
   * client) applies them as ops, without the flag.
   */
  stamps: Op[]
}

/**
 * How a commit runs: `stamp` (the server only, which passes `cardStamps`) gives the ops that stamp
 * the books whose cards changed. It is passed in, not imported here, so a client's bundle never
 * carries the stamper.
 */
export interface CommitOptions {
  stamp?: (before: BoardState, after: BoardState, touched: Touched) => Op[]
}

/**
 * The pure commit transition shared by server and client. Applies `ops` (all-or-nothing; throws
 * `OpError` with `state` untouched), then always advances the revision by one, even when the
 * batch changes nothing. Every record the batch writes (created or changed, including a thread
 * whose notes changed because a note was deleted) is stamped `rev` = the new revision. `mark`
 * (the acknowledging client, or `null` for server-originated commits such as `asset.add`) is
 * recorded at the new revision, stale marks are pruned, and `board.updatedAt` is stamped `now`.
 * Deterministic: the same inputs yield byte-identical `serializeBoard` output.
 */
export function commitBatch(
  state: BoardState,
  ops: readonly Op[],
  now: string,
  mark: CommitMark | null,
): BoardState {
  return commitChanges(state, ops, now, mark).state
}

/** {@link commitBatch}, also telling which ids the batch wrote (deleted ones included). */
export function commitChanges(
  state: BoardState,
  ops: readonly Op[],
  now: string,
  mark: CommitMark | null,
): Committed {
  return drain(commitSteps(state, ops, now, mark))
}

/**
 * {@link commitChanges} a step at a time (`batchSteps`): it pauses between two ops and before each
 * pass over what the batch wrote. Run to the end it commits exactly as `commitChanges` does.
 */
export function* commitSteps(
  state: BoardState,
  ops: readonly Op[],
  now: string,
  mark: CommitMark | null,
  o?: CommitOptions,
): Generator<void, Committed> {
  const revision = state.board.revision + 1
  const checked = checkedNow({ now })
  let { state: next, touched } = yield* batchSteps(state, ops, checked, revision)
  let stamps: Op[] = []
  if (o?.stamp && touched.blocks.size > 0) {
    yield
    stamps = o.stamp(state, next, touched)
    if (stamps.length > 0) {
      yield
      // The stamps on top, in the same revision: what a replay of the batch and them gives.
      const stamped = yield* batchSteps(next, stamps, checked, revision)
      next = stamped.state
      touched = joined(touched, stamped.touched)
    }
  }
  const base = next.board.clients
  const clients = pruneClients(
    mark
      ? { ...base, [mark.clientId]: { lastSeq: mark.seq, lastRevision: revision, seenAt: now } }
      : base,
    now,
  )
  return {
    state: { ...next, board: { ...next.board, revision, clients, updatedAt: now } },
    written: touched,
    stamps,
  }
}

/** The ids of `a` and `b`, per map. */
function joined(a: Touched, b: Touched): Touched {
  const both = (x: ReadonlySet<string>, y: ReadonlySet<string>) =>
    y.size === 0 ? x : new Set([...x, ...y])
  return {
    assets: both(a.assets, b.assets),
    notes: both(a.notes, b.notes),
    yarns: both(a.yarns, b.yarns),
    books: both(a.books, b.books),
    blocks: both(a.blocks, b.blocks),
  }
}

/**
 * Split `ops` into consecutive chunks for transport. Greedy and order-preserving: each chunk has
 * at most `maxOps` ops and its `JSON.stringify` UTF-8 size plus a 512-byte envelope is at most
 * `maxBytes`. Throws `OpError('limit')` (with the op's `index`) if one op alone cannot fit.
 */
export function splitOps(ops: readonly Op[], maxBytes: number, maxOps: number): Op[][] {
  if (!(maxOps >= 1)) throw new OpError('limit', 'maxOps must be at least 1')
  const encoder = new TextEncoder()
  const budget = maxBytes - ENVELOPE_BYTES
  const chunks: Op[][] = []
  let chunk: Op[] = []
  // Size of JSON.stringify(chunk): the two brackets, the ops, and one comma between each pair.
  let size = 2
  for (const [index, op] of ops.entries()) {
    const opBytes = encoder.encode(JSON.stringify(op)).length
    if (opBytes + 2 > budget) {
      throw new OpError('limit', `op ${index} is too large to send (${opBytes} bytes)`, { index })
    }
    const grown = size + opBytes + (chunk.length > 0 ? 1 : 0)
    if (chunk.length > 0 && (chunk.length >= maxOps || grown > budget)) {
      chunks.push(chunk)
      chunk = []
      size = 2
    }
    size += opBytes + (chunk.length > 0 ? 1 : 0)
    chunk.push(op)
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

/** Bytes of a part {@link hashPart} hashes between two of its pauses. */
export const PART_HASH_STEP = 128 * 1024

/**
 * The SHA-256 of one staged part's ops as JSON (`JSON.stringify`, UTF-8), in lowercase hex: the
 * encoding, then a {@link PART_HASH_STEP} of bytes at a time. It pauses (yields) after each step
 * but the last, so a caller on the
 * page can let other work run, and returns the hash. In plain JS: it needs no Web Crypto.
 */
export function* hashPart(ops: readonly Op[]): Generator<void, string> {
  const bytes = new TextEncoder().encode(JSON.stringify(ops))
  const h = sha256.create()
  // The JSON and its encoding are a step of their own.
  yield
  for (let at = 0; at < bytes.length; at += PART_HASH_STEP) {
    if (at > 0) yield
    h.update(bytes.subarray(at, at + PART_HASH_STEP))
  }
  return bytesToHex(h.digest())
}

/** {@link hashPart} in one go. */
export function partHash(ops: readonly Op[]): string {
  const steps = hashPart(ops)
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

/**
 * A staged batch's content digest (ADR-0005) from its parts' {@link partHash}es, in order: the
 * SHA-256 of the hashes joined, its first 16 bytes in lowercase hex (32 digits). Taken from the
 * parts' hashes so a client can hash one part at a time.
 */
export function digestOfHashes(hashes: readonly string[]): string {
  return bytesToHex(sha256(new TextEncoder().encode(hashes.join('')))).slice(0, 32)
}

/** {@link digestOfHashes} of `parts`, in one go. Plain JS: it needs no Web Crypto. */
export function batchDigest(parts: readonly (readonly Op[])[]): string {
  return digestOfHashes(parts.map(partHash))
}
