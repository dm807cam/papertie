import type { Point, Rect } from './types'

export const SAG = { ratio: 0.08, max: 140 } as const

export interface CubicBezier {
  p0: Point
  p1: Point
  p2: Point
  p3: Point
}

const MAX_DEPTH = 12

/** Resting sag point: the midpoint pushed down by 8% of the span, capped at 140. */
export function restSagPoint(a: Point, b: Point): Point {
  const sag = Math.min(SAG.ratio * Math.hypot(b.x - a.x, b.y - a.y), SAG.max)
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + sag }
}

/** Cubic from `a` to `b` whose midpoint B(0.5) is exactly `sag`. */
export function segmentBezier(a: Point, b: Point, sag: Point): CubicBezier {
  const dx = (4 / 3) * (sag.x - (a.x + b.x) / 2)
  const dy = (4 / 3) * (sag.y - (a.y + b.y) / 2)
  return {
    p0: a,
    p1: { x: a.x + (b.x - a.x) / 3 + dx, y: a.y + (b.y - a.y) / 3 + dy },
    p2: { x: a.x + (2 * (b.x - a.x)) / 3 + dx, y: a.y + (2 * (b.y - a.y)) / 3 + dy },
    p3: b,
  }
}

export function evalBezier(c: CubicBezier, t: number): Point {
  const u = 1 - t
  const w0 = u * u * u
  const w1 = 3 * u * u * t
  const w2 = 3 * u * t * t
  const w3 = t * t * t
  return {
    x: w0 * c.p0.x + w1 * c.p1.x + w2 * c.p2.x + w3 * c.p3.x,
    y: w0 * c.p0.y + w1 * c.p1.y + w2 * c.p2.y + w3 * c.p3.y,
  }
}

/** The derivative dB/dt at `t`; zero where the curve is degenerate. */
export function bezierTangent(c: CubicBezier, t: number): Point {
  const u = 1 - t
  const a = 3 * u * u
  const b = 6 * u * t
  const d = 3 * t * t
  return {
    x: a * (c.p1.x - c.p0.x) + b * (c.p2.x - c.p1.x) + d * (c.p3.x - c.p2.x),
    y: a * (c.p1.y - c.p0.y) + b * (c.p2.y - c.p1.y) + d * (c.p3.y - c.p2.y),
  }
}

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** Distance from `p` to the segment `a`-`b`; total even when `a` equals `b`. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (!(len2 > 0)) return Math.hypot(p.x - a.x, p.y - a.y)
  if (!Number.isFinite(len2)) {
    return Math.min(Math.hypot(p.x - a.x, p.y - a.y), Math.hypot(p.x - b.x, p.y - b.y))
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/**
 * Polyline within `tolerance` of the curve: recursive de Casteljau splitting until both inner
 * control points lie within `tolerance` of the chord, to depth 12. Always includes both
 * endpoints; a non-positive or non-finite tolerance just splits to the depth limit.
 */
export function flattenBezier(c: CubicBezier, tolerance: number): Point[] {
  const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0
  const out: Point[] = [c.p0]
  const walk = (b: CubicBezier, depth: number) => {
    const flat =
      distanceToSegment(b.p1, b.p0, b.p3) <= tol && distanceToSegment(b.p2, b.p0, b.p3) <= tol
    if (flat || depth >= MAX_DEPTH) {
      out.push(b.p3)
      return
    }
    const p01 = mid(b.p0, b.p1)
    const p12 = mid(b.p1, b.p2)
    const p23 = mid(b.p2, b.p3)
    const p012 = mid(p01, p12)
    const p123 = mid(p12, p23)
    const m = mid(p012, p123)
    walk({ p0: b.p0, p1: p01, p2: p012, p3: m }, depth + 1)
    walk({ p0: m, p1: p123, p2: p23, p3: b.p3 }, depth + 1)
  }
  walk(c, 0)
  return out
}

export function polylineLength(pts: readonly Point[]): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Point
    const b = pts[i] as Point
    total += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return total
}

const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})

/** The leading `fraction` (clamped to 0-1, NaN as 0) of the polyline's length. */
export function truncatePolyline(pts: readonly Point[], fraction: number): Point[] {
  const first = pts[0]
  if (first === undefined) return []
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : fraction > 0 ? 1 : 0
  if (f >= 1) return pts.slice()
  if (f <= 0) return [first]
  return sliceByLength(pts, 0, polylineLength(pts) * f)
}

/**
 * The part of the polyline between arc lengths `from` and `to`. Bounds are clamped to the total
 * length (NaN counts as 0) and swapped when reversed; equal bounds give a single point.
 */
export function sliceByLength(pts: readonly Point[], from: number, to: number): Point[] {
  const first = pts[0]
  if (first === undefined) return []
  const total = polylineLength(pts)
  const clamp = (n: number) => (Number.isNaN(n) ? 0 : Math.max(0, Math.min(total, n)))
  let lo = clamp(from)
  let hi = clamp(to)
  if (lo > hi) [lo, hi] = [hi, lo]
  const out: Point[] = []
  const push = (p: Point) => {
    const last = out[out.length - 1]
    if (last === undefined || last.x !== p.x || last.y !== p.y) out.push(p)
  }
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Point
    const b = pts[i] as Point
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len === 0) continue
    const end = acc + len
    if (end >= lo && acc <= hi) {
      if (out.length === 0) push(lerp(a, b, Math.max(0, (lo - acc) / len)))
      if (hi <= end) {
        push(lerp(a, b, (hi - acc) / len))
        break
      }
      push(b)
    }
    acc = end
  }
  if (out.length === 0) return [first]
  if (lo === hi) return [out[0] as Point]
  return out
}

/** Shortest distance from `p` to the polyline; `Infinity` for an empty polyline. */
export function distanceToPolyline(p: Point, pts: readonly Point[]): number {
  const first = pts[0]
  if (first === undefined) return Number.POSITIVE_INFINITY
  let best = Math.hypot(p.x - first.x, p.y - first.y)
  for (let i = 1; i < pts.length; i++) {
    best = Math.min(best, distanceToSegment(p, pts[i - 1] as Point, pts[i] as Point))
  }
  return best
}

/** Bounding box of the control hull (always contains the curve). */
export function bezierBounds(c: CubicBezier): Rect {
  const xs = [c.p0.x, c.p1.x, c.p2.x, c.p3.x]
  const ys = [c.p0.y, c.p1.y, c.p2.y, c.p3.y]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** Stable identity of one yarn segment between two consecutive notes. */
export function segmentKey(yarnId: string, aNoteId: string, bNoteId: string): string {
  return `${yarnId}|${aNoteId}|${bNoteId}`
}
