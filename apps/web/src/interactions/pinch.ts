import { type Camera, panBy, zoomAt } from '../canvas/Camera'
import type { Point } from '../canvas/types'

/** Per-event zoom ratio bound, so one jittery sample never zooms by more than ×2. */
const MAX_RATIO = 2

const finitePt = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y)

/**
 * Two-finger update: zoom by the ratio of finger distances about the old midpoint, then pan by
 * the midpoint's move, so the world point between the fingers stays between them.
 */
export function pinchCamera(c: Camera, prev: [Point, Point], next: [Point, Point]): Camera {
  if (![...prev, ...next].every(finitePt)) return c
  const d0 = Math.hypot(prev[1].x - prev[0].x, prev[1].y - prev[0].y)
  const d1 = Math.hypot(next[1].x - next[0].x, next[1].y - next[0].y)
  const raw = d0 > 1e-6 ? d1 / d0 : 1
  const ratio = Number.isFinite(raw) ? Math.min(MAX_RATIO, Math.max(1 / MAX_RATIO, raw)) : 1
  const m0 = { x: (prev[0].x + prev[1].x) / 2, y: (prev[0].y + prev[1].y) / 2 }
  const m1 = { x: (next[0].x + next[1].x) / 2, y: (next[0].y + next[1].y) / 2 }
  const zoomed = ratio === 1 ? c : zoomAt(c, m0, c.zoom * ratio)
  return panBy(zoomed, m1.x - m0.x, m1.y - m0.y)
}
