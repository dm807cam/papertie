/**
 * Runs that replay exactly: a property's run starts on a fresh fake clock at {@link T0},
 * and takes its ids' random bits and the persistent maps' split seed from a seed of its own, so
 * a reported seed and path make the same sends and commits in any process, on any day. The app
 * keeps its defaults (crypto's bits, a random seed per process): only tests call these.
 */
import { setIdRandomness, setSplitSeed } from '@papertie/core/testing'
import { vi } from 'vitest'
import { T0 } from './fakeServer'

/** FNV-1a of `text`: a run's seed from its own values. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** A stream of random bytes from `seed` (sfc32), the same on every machine. */
export function seededBytes(seed: number): (bytes: Uint8Array) => void {
  let a = 0x9e3779b9
  let b = 0x243f6a88
  let c = 0xb7e15162
  let d = seed >>> 0
  const next = () => {
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return t >>> 0
  }
  for (let i = 0; i < 15; i++) next()
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 0xff
  }
}

/**
 * Start a run that replays exactly: a new fake clock whose start is T0 (a `vi.clearAllTimers()`
 * resets the clock to its start; `vi.useFakeTimers()` alone would start it at the real time),
 * ids' bits and the split seed from `seed`.
 */
export function replayFrom(seed: number): void {
  vi.useRealTimers()
  vi.setSystemTime(new Date(T0)) // the date `useFakeTimers` starts the new clock at
  vi.useFakeTimers()
  setIdRandomness(seededBytes(seed))
  setSplitSeed(seed)
}

/** Back to the app's defaults. */
export function endReplay(): void {
  setIdRandomness(null)
  setSplitSeed(null)
}
