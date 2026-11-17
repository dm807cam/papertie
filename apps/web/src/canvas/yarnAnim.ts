import { EASE } from '../styles/motion'

/** Draw-in duration in ms; the strand grows along its length, eased. */
export const DRAW_IN_MS = 350
/** Loosen-out duration in ms after a delete. */
export const DELETE_MS = 200
/** Under reduced motion, draw-in and delete are fades of this length. */
export const REDUCED_FADE_MS = 100
/** The loosening thread's sag offset grows to this multiple of its rest depth. */
export const LOOSEN_SAG_SCALE = 1.6

/** 0-1, with NaN as 0. */
const unit = (n: number) => (n > 0 ? Math.min(1, n) : 0)

/** A new thread `elapsedMs` after creation: the drawn share of its length and its opacity. */
export function drawInProgress(
  elapsedMs: number,
  reduced: boolean,
): { progress: number; alpha: number } {
  if (reduced) return { progress: 1, alpha: unit(elapsedMs / REDUCED_FADE_MS) }
  return { progress: EASE(unit(elapsedMs / DRAW_IN_MS)), alpha: 1 }
}

/** A deleted thread `elapsedMs` after the delete: sag growth, opacity, and whether it is gone. */
export function loosenState(
  elapsedMs: number,
  reduced: boolean,
): { sagScale: number; alpha: number; done: boolean } {
  if (reduced) {
    return {
      sagScale: 1,
      alpha: 1 - unit(elapsedMs / REDUCED_FADE_MS),
      done: elapsedMs >= REDUCED_FADE_MS,
    }
  }
  const t = elapsedMs / DELETE_MS
  const k = EASE(t)
  return { sagScale: 1 + (LOOSEN_SAG_SCALE - 1) * k, alpha: 1 - k, done: t >= 1 }
}

/** A pulse's length in ms: one swell and settle of a thread. */
export const PULSE_MS = 800

/** A pulse `elapsedMs` in: 0 at both ends, 1 at the crest (a half sine), 0 once it is over. */
export function pulseState(elapsedMs: number): number {
  const t = elapsedMs / PULSE_MS
  return t > 0 && t < 1 ? Math.sin(Math.PI * t) : 0
}
