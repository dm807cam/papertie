import { isAtRest, SPRING, type SpringState, stepSpring } from '../src/canvas/yarnPhysics'

const ORIGIN = { x: 0, y: 0 }

/** Step from x = d0 (at rest velocity) toward 0 at `hz`; overshoot in % and the 2% settle time. */
const settle = (d0: number, hz: number) => {
  let s: SpringState = { x: d0, y: 0, vx: 0, vy: 0 }
  const dt = 1 / hz
  let overshoot = 0
  let settle2pct = 0
  for (let k = 1; k <= 2 * hz; k++) {
    s = stepSpring(s, ORIGIN, dt)
    overshoot = Math.max(overshoot, (-s.x / d0) * 100)
    if (Math.abs(s.x) > 0.02 * d0) settle2pct = k * dt
  }
  return { overshoot, settle2pct }
}

const run = (s: SpringState, steps: number, dt: number) => {
  let out = s
  for (let k = 0; k < steps; k++) out = stepSpring(out, ORIGIN, dt)
  return out
}

describe('stepSpring', () => {
  it('uses the planned constants', () => {
    expect(SPRING).toEqual({ zeta: 0.75, omega: 17.8, restEpsilon: 0.1, restVelocity: 2 })
    expect(SPRING.omega).toBeCloseTo(4 / (SPRING.zeta * 0.3), 1)
  })

  it('overshoot stays under 4% (≈2.84% for ζ=0.75)', () => {
    const { overshoot } = settle(100, 1000)
    expect(overshoot).toBeLessThanOrEqual(4)
    expect(overshoot).toBeCloseTo(2.84, 1)
  })

  it('settles to 2% in about 300 ms', () => {
    const t = settle(100, 1000).settle2pct
    expect(t).toBeGreaterThanOrEqual(0.25)
    expect(t).toBeLessThanOrEqual(0.36)
  })

  it('is frame-rate independent', () => {
    const s0: SpringState = { x: 100, y: -40, vx: 30, vy: 500 }
    const a = run(s0, 18, 1 / 60)
    const b = run(s0, 36, 1 / 120)
    const c = stepSpring(s0, ORIGIN, 0.3)
    expect(Math.abs(c.x)).toBeGreaterThan(SPRING.restEpsilon)
    for (const s of [a, b]) {
      expect(s.x).toBeCloseTo(c.x, 9)
      expect(s.y).toBeCloseTo(c.y, 9)
      expect(s.vx).toBeCloseTo(c.vx, 9)
      expect(s.vy).toBeCloseTo(c.vy, 9)
    }
  })

  it('a 5 s gap lands at rest; dt 0, negative and NaN change nothing', () => {
    const s0: SpringState = { x: 300, y: -200, vx: -4000, vy: 9000 }
    const target = { x: 12, y: 34 }
    expect(stepSpring(s0, target, 5)).toEqual({ x: 12, y: 34, vx: 0, vy: 0 })
    expect(stepSpring(s0, target, 1e9)).toEqual({ x: 12, y: 34, vx: 0, vy: 0 })
    for (const dt of [0, -0.016, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(stepSpring(s0, target, dt)).toBe(s0)
    }
  })

  it('stays finite for huge displacements and lands on a non-finite state target', () => {
    const big = stepSpring({ x: 1e7, y: -1e7, vx: 1e8, vy: 0 }, ORIGIN, 1 / 60)
    for (const v of Object.values(big)) expect(Number.isFinite(v)).toBe(true)
    const broken = stepSpring({ x: Number.NaN, y: 0, vx: 0, vy: 0 }, { x: 5, y: 6 }, 1 / 60)
    expect(broken).toEqual({ x: 5, y: 6, vx: 0, vy: 0 })
  })

  it('isAtRest snaps exactly when within 0.1 px and 2 px/s', () => {
    const t = { x: 10, y: 20 }
    expect(isAtRest({ x: 10.09, y: 19.91, vx: 1.9, vy: -1.9 }, t)).toBe(true)
    expect(isAtRest({ x: 10.11, y: 20, vx: 0, vy: 0 }, t)).toBe(false)
    expect(isAtRest({ x: 10, y: 19.89, vx: 0, vy: 0 }, t)).toBe(false)
    expect(isAtRest({ x: 10, y: 20, vx: 2.1, vy: 0 }, t)).toBe(false)
    expect(isAtRest({ x: 10, y: 20, vx: 0, vy: -2.1 }, t)).toBe(false)
    // A step that ends inside both thresholds lands exactly on the target.
    let s: SpringState = { x: 15, y: 20, vx: 0, vy: 0 }
    let snapped = false
    for (let k = 0; k < 120 && !snapped; k++) {
      s = stepSpring(s, t, 1 / 60)
      snapped = s.x === t.x && s.vx === 0
    }
    expect(snapped).toBe(true)
    expect(s).toEqual({ x: 10, y: 20, vx: 0, vy: 0 })
  })
})
