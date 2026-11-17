import type { Point } from './types'

/**
 * The sag point's spring: ζ = 0.75 (2.84% overshoot) and ω = 4 / (ζ · 0.3 s) rad/s, so it settles
 * in about 300 ms. Within 0.1 world px and 2 world px/s on both axes it snaps to rest.
 */
export const SPRING = { zeta: 0.75, omega: 17.8, restEpsilon: 0.1, restVelocity: 2 } as const

export type SpringParams = typeof SPRING

export interface SpringState {
  x: number
  y: number
  vx: number
  vy: number
}

/** Whether `s` is within the rest thresholds of `target` on both axes. */
export function isAtRest(s: SpringState, target: Point, p: SpringParams = SPRING): boolean {
  return (
    Math.abs(s.x - target.x) < p.restEpsilon &&
    Math.abs(s.y - target.y) < p.restEpsilon &&
    Math.abs(s.vx) < p.restVelocity &&
    Math.abs(s.vy) < p.restVelocity
  )
}

/**
 * Advance the underdamped spring by `dtSec` toward a target held constant over the step, using
 * the closed-form solution, so any dt is exact (a 5 s gap simply lands at rest). A dt that is
 * ≤ 0 or not finite returns `s` itself; a state that would leave the finite range lands on target.
 */
export function stepSpring(
  s: SpringState,
  target: Point,
  dtSec: number,
  p: SpringParams = SPRING,
): SpringState {
  if (!(dtSec > 0) || !Number.isFinite(dtSec)) return s
  const { zeta, omega } = p
  const wd = omega * Math.sqrt(1 - zeta * zeta)
  const e = Math.exp(-zeta * omega * dtSec)
  const c = Math.cos(wd * dtSec)
  const sn = Math.sin(wd * dtSec)
  const axis = (x: number, v: number, t: number): [number, number] => {
    const d = x - t
    return [
      t + e * (d * c + ((v + zeta * omega * d) / wd) * sn),
      e * (v * c - ((zeta * omega * v + omega * omega * d) / wd) * sn),
    ]
  }
  const [x, vx] = axis(s.x, s.vx, target.x)
  const [y, vy] = axis(s.y, s.vy, target.y)
  const next = { x, y, vx, vy }
  const finite = Number.isFinite(x + y + vx + vy)
  return !finite || isAtRest(next, target, p) ? { x: target.x, y: target.y, vx: 0, vy: 0 } : next
}
