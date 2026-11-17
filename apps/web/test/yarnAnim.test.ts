import {
  DELETE_MS,
  DRAW_IN_MS,
  drawInProgress,
  LOOSEN_SAG_SCALE,
  loosenState,
  REDUCED_FADE_MS,
} from '../src/canvas/yarnAnim'
import { EASE } from '../src/styles/motion'

describe('yarn animations', () => {
  it('uses the planned durations', () => {
    expect([DRAW_IN_MS, DELETE_MS, REDUCED_FADE_MS, LOOSEN_SAG_SCALE]).toEqual([350, 200, 100, 1.6])
  })

  it('drawInProgress: 0 → 0, 350 → 1, monotonic; reduced: progress 1, alpha 0.5 at 50 ms, 1 at 100 ms', () => {
    expect(drawInProgress(0, false)).toEqual({ progress: 0, alpha: 1 })
    expect(drawInProgress(350, false)).toEqual({ progress: 1, alpha: 1 })
    expect(drawInProgress(1000, false)).toEqual({ progress: 1, alpha: 1 })
    expect(drawInProgress(175, false).progress).toBeCloseTo(EASE(0.5), 9)
    let prev = 0
    for (let e = 0; e <= 400; e += 5) {
      const { progress } = drawInProgress(e, false)
      expect(progress).toBeGreaterThanOrEqual(prev)
      prev = progress
    }
    expect(drawInProgress(0, true)).toEqual({ progress: 1, alpha: 0 })
    expect(drawInProgress(50, true)).toEqual({ progress: 1, alpha: 0.5 })
    expect(drawInProgress(100, true)).toEqual({ progress: 1, alpha: 1 })
    expect(drawInProgress(500, true)).toEqual({ progress: 1, alpha: 1 })
  })

  it('drawInProgress stays in 0-1 for negative and NaN elapsed times', () => {
    for (const reduced of [false, true]) {
      for (const e of [-50, Number.NaN]) {
        const p = drawInProgress(e, reduced)
        expect(p.progress).toBeGreaterThanOrEqual(0)
        expect(p.alpha).toBeGreaterThanOrEqual(0)
        expect(p.progress).toBeLessThanOrEqual(1)
        expect(p.alpha).toBeLessThanOrEqual(1)
      }
    }
  })

  it('loosenState: 0 → (1,1,false); 200 → (1.6,0,true); reduced done at 100 with sagScale 1', () => {
    expect(loosenState(0, false)).toEqual({ sagScale: 1, alpha: 1, done: false })
    expect(loosenState(200, false)).toEqual({ sagScale: 1.6, alpha: 0, done: true })
    const mid = loosenState(100, false)
    expect(mid.sagScale).toBeCloseTo(1 + 0.6 * EASE(0.5), 9)
    expect(mid.alpha).toBeCloseTo(1 - EASE(0.5), 9)
    expect(mid.done).toBe(false)
    expect(loosenState(50, true)).toEqual({ sagScale: 1, alpha: 0.5, done: false })
    expect(loosenState(100, true)).toEqual({ sagScale: 1, alpha: 0, done: true })
    expect(loosenState(99, true).done).toBe(false)
    expect(loosenState(Number.NaN, false)).toEqual({ sagScale: 1, alpha: 1, done: false })
  })
})
