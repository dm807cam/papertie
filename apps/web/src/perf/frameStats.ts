import type { FrameTask } from '../canvas/FrameLoop'

/** A summary of recorded frame intervals. */
export interface PerfSnapshot {
  /** 1000 / mean interval; 0 with no frames. */
  fps: number
  /** Nearest-rank 95th percentile interval, ms. */
  p95FrameMs: number
  /** The longest interval, ms. */
  maxFrameMs: number
  /** Intervals over `LONG_FRAME_MS`. */
  longFrames: number
  frames: number
}

/** A frame interval over this many ms counts as long. */
export const LONG_FRAME_MS = 20

/**
 * The last `capacity` frame intervals in a ring buffer. Non-finite or non-positive ones are
 * dropped.
 */
export class FrameStats {
  private readonly buf: Float64Array
  private next = 0
  private count = 0

  constructor(readonly capacity = 240) {
    this.buf = new Float64Array(Math.max(1, Math.floor(capacity)))
  }

  push(intervalMs: number): void {
    if (!(Number.isFinite(intervalMs) && intervalMs > 0)) return
    this.buf[this.next] = intervalMs
    this.next = (this.next + 1) % this.buf.length
    if (this.count < this.buf.length) this.count++
  }

  snapshot(): PerfSnapshot {
    const n = this.count
    if (n === 0) return { fps: 0, p95FrameMs: 0, maxFrameMs: 0, longFrames: 0, frames: 0 }
    const sorted = this.buf.slice(0, n).sort()
    let sum = 0
    let longFrames = 0
    for (const ms of sorted) {
      sum += ms
      if (ms > LONG_FRAME_MS) longFrames++
    }
    const p95FrameMs = sorted[Math.ceil(0.95 * n) - 1] ?? 0
    const maxFrameMs = sorted[n - 1] ?? 0
    return { fps: 1000 / (sum / n), p95FrameMs, maxFrameMs, longFrames, frames: n }
  }

  reset(): void {
    this.next = 0
    this.count = 0
  }
}

/**
 * A frame task feeding `stats` the interval between back-to-back loop frames. The first frame
 * after the loop was idle carries a made-up dt, so it only starts a new run.
 */
export function loopSampler(stats: FrameStats): FrameTask {
  let prev: number | null = null
  return (dtSec, nowMs) => {
    if (prev !== null && Math.abs(dtSec * 1000 - (nowMs - prev)) < 0.01) stats.push(nowMs - prev)
    prev = nowMs
    return false
  }
}
