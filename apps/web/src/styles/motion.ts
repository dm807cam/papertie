/** Motion durations in ms; mirrored by the CSS custom properties in tokens.css. */
export const MOTION = { fast: 120, base: 200, slow: 320 } as const

/** Control points of the shared easing curve, `cubic-bezier(.2, .8, .2, 1)`. */
export const EASE_BEZIER = [0.2, 0.8, 0.2, 1] as const

/** The same curve as CSS writes it (`--ease` in tokens.css), for `Element.animate()`. */
export const EASE_CSS = 'cubic-bezier(.2, .8, .2, 1)'

/** CSS-style cubic Bézier easing: maps time t in [0, 1] to progress; NaN and t ≤ 0 give 0. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx

  return (t) => {
    if (!(t > 0)) return 0
    if (t >= 1) return 1
    let s = t
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - t
      if (Math.abs(err) < 1e-7) return sampleY(s)
      const d = slopeX(s)
      if (Math.abs(d) < 1e-6) break
      s -= err / d
    }
    let lo = 0
    let hi = 1
    s = t
    for (let i = 0; i < 40; i++) {
      const x = sampleX(s)
      if (Math.abs(x - t) < 1e-7) break
      if (x < t) lo = s
      else hi = s
      s = (lo + hi) / 2
    }
    return sampleY(s)
  }
}

export const EASE = cubicBezier(...EASE_BEZIER)
