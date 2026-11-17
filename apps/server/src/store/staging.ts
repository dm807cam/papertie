import { type ClientOp, OpBatchSchema } from '@papertie/core'
import { z } from 'zod'
import type { Clock } from '../clock'
import { ApiError } from '../http/errors'

/**
 * One part of an oversized batch: the batch envelope plus `part` (0-based index of `count`, and
 * the batch's content `digest`: 32 lowercase hex digits the page derives from all of its ops).
 */
export const StagedPartSchema = z
  .object({
    ...OpBatchSchema.shape,
    part: z
      .object({
        index: z.number().int().min(0),
        count: z.number().int().min(2).max(64),
        digest: z.string().regex(/^[0-9a-f]{32}$/),
      })
      .strict(),
  })
  .strict()
  .refine((b) => b.part.index < b.part.count)
export type StagedPart = z.infer<typeof StagedPartSchema>

/** What `POST /api/boards/:id/ops` accepts: a whole batch or one part of a staged transaction. */
export const PostOpsBodySchema = z.union([OpBatchSchema, StagedPartSchema])

export type StageResult =
  | { kind: 'partial'; received: number[]; count: number }
  | { kind: 'complete'; ops: ClientOp[]; baseRevision: number }

export interface StagingOptions {
  clock: Clock
  maxParts: number
  boardBytes: number
  globalBytes: number
  ttlMs: number
}

const SWEEP_INTERVAL_MS = 60_000

interface Stage {
  boardKey: string
  count: number
  baseRevision: number
  /** The batch's content digest. */
  digest: string
  parts: Map<number, { ops: ClientOp[]; bytes: number }>
  bytes: number
  touchedAt: number
}

const keyOf = (boardKey: string, clientId: string, seq: number) =>
  `${boardKey}\u0000${clientId}\u0000${seq}`

/**
 * In-memory staging for oversized batches (ADR-0005). Parts of one `(board, clientId, seq)` wait
 * here until all `count` have arrived; nothing is committed, acked or persisted before that, so a
 * restart only loses parts the page sends again. Bytes are the request body sizes, capped
 * per board and server-wide; an idle stage expires after `ttlMs`.
 */
export class StagingArea {
  private readonly stages = new Map<string, Stage>()
  private readonly boardTotals = new Map<string, number>()
  private total = 0
  private readonly timer: ReturnType<typeof setInterval>

  constructor(private readonly opts: StagingOptions) {
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.timer.unref()
  }

  /**
   * Add `p` (a resent index replaces the earlier part). A `count`, `baseRevision` or `digest`
   * that differs from the stage's discards it: 409 `stage-mismatch`. So parts of two different
   * batches under one `seq` never commit as one: the digest names the batch's content. Over a byte cap: 503 `stage-full`.
   */
  stage(boardKey: string, p: StagedPart, bytes: number): StageResult {
    this.sweep()
    const { clientId, seq, baseRevision, ops } = p
    const { index, count, digest } = p.part
    if (count > this.opts.maxParts) throw new ApiError(400, 'invalid')
    const key = keyOf(boardKey, clientId, seq)
    let stage = this.stages.get(key)
    if (
      stage &&
      (stage.count !== count || stage.baseRevision !== baseRevision || stage.digest !== digest)
    ) {
      this.discard(key, stage)
      throw new ApiError(409, 'stage-mismatch')
    }
    const replaced = stage?.parts.get(index)?.bytes ?? 0
    const delta = bytes - replaced
    if (
      (this.boardTotals.get(boardKey) ?? 0) + delta > this.opts.boardBytes ||
      this.total + delta > this.opts.globalBytes
    ) {
      throw new ApiError(503, 'stage-full')
    }
    if (!stage) {
      stage = {
        boardKey,
        count,
        baseRevision,
        digest,
        parts: new Map(),
        bytes: 0,
        touchedAt: 0,
      }
      this.stages.set(key, stage)
    }
    stage.parts.set(index, { ops, bytes })
    stage.bytes += delta
    stage.touchedAt = this.opts.clock.now().getTime()
    this.boardTotals.set(boardKey, (this.boardTotals.get(boardKey) ?? 0) + delta)
    this.total += delta

    if (stage.parts.size < stage.count) {
      return { kind: 'partial', received: [...stage.parts.keys()].sort((a, b) => a - b), count }
    }
    const all: ClientOp[] = []
    for (let i = 0; i < stage.count; i++) all.push(...(stage.parts.get(i)?.ops ?? []))
    return { kind: 'complete', ops: all, baseRevision }
  }

  drop(boardKey: string, clientId: string, seq: number): void {
    const key = keyOf(boardKey, clientId, seq)
    const stage = this.stages.get(key)
    if (stage) this.discard(key, stage)
  }

  /** Discard every stage of the board (its parts were staged against a state that is gone). */
  dropBoard(boardKey: string): void {
    for (const [key, stage] of this.stages) {
      if (stage.boardKey === boardKey) this.discard(key, stage)
    }
  }

  /** Discard stages idle for more than `ttlMs`; returns how many. */
  sweep(): number {
    const cutoff = this.opts.clock.now().getTime() - this.opts.ttlMs
    let n = 0
    for (const [key, stage] of this.stages) {
      if (stage.touchedAt < cutoff) {
        this.discard(key, stage)
        n++
      }
    }
    return n
  }

  /** Stop the sweep timer and forget every stage. */
  close(): void {
    clearInterval(this.timer)
    this.stages.clear()
    this.boardTotals.clear()
    this.total = 0
  }

  private discard(key: string, stage: Stage): void {
    this.stages.delete(key)
    this.total -= stage.bytes
    const left = (this.boardTotals.get(stage.boardKey) ?? 0) - stage.bytes
    if (left > 0) this.boardTotals.set(stage.boardKey, left)
    else this.boardTotals.delete(stage.boardKey)
  }
}
