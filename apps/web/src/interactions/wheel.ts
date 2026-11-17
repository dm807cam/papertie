import type { Point } from '../canvas/types'

/** Wheel tuning: zoom per pixel of delta, the per-event delta cap for zoom, px per line. */
export const WHEEL = { zoomPerPx: 0.01, maxStepPx: 50, linePx: 16 } as const

export interface WheelLike {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  metaKey: boolean
}

export type WheelIntent =
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom'; factor: number; at: Point }

const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2

/**
 * What a wheel event means. Ctrl/cmd (a trackpad pinch arrives as ctrl+wheel) or the "zoom" wheel
 * pref zoom around `pointer`; anything else pans content with the gesture. The zoom step is capped
 * at `maxStepPx` of delta, so one mouse notch never zooms by more than exp(0.5).
 */
export function interpretWheel(
  e: WheelLike,
  pointer: Point,
  viewportH: number,
  prefs: { wheel: 'pan' | 'zoom' },
): WheelIntent {
  const unit =
    e.deltaMode === DOM_DELTA_LINE ? WHEEL.linePx : e.deltaMode === DOM_DELTA_PAGE ? viewportH : 1
  const finite = (v: number) => {
    const d = v * unit
    return Number.isFinite(d) ? d : 0
  }
  const dx = finite(e.deltaX)
  const dy = finite(e.deltaY)
  if (e.ctrlKey || e.metaKey || prefs.wheel === 'zoom') {
    const step = Math.min(WHEEL.maxStepPx, Math.max(-WHEEL.maxStepPx, dy))
    return { kind: 'zoom', factor: Math.exp(-step * WHEEL.zoomPerPx), at: pointer }
  }
  return { kind: 'pan', dx: 0 - dx, dy: 0 - dy }
}
