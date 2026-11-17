import { readFileSync } from 'node:fs'
import { EASE, MOTION } from '../src/styles/motion'

describe('motion', () => {
  it('EASE fixes the endpoints', () => {
    expect(EASE(0)).toBeCloseTo(0, 6)
    expect(EASE(1)).toBeCloseTo(1, 6)
  })

  it('EASE is monotonic and never overshoots 4%', () => {
    let prev = 0
    let max = 0
    for (let i = 0; i <= 1000; i++) {
      const v = EASE(i / 1000)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = v
      max = Math.max(max, v)
    }
    expect(max).toBeLessThanOrEqual(1.04)
  })

  it('EASE is total: non-finite input gives a finite value', () => {
    expect(EASE(Number.NaN)).toBe(0)
    expect(EASE(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(EASE(Number.POSITIVE_INFINITY)).toBe(1)
    expect(EASE(-0.5)).toBe(0)
    expect(EASE(2)).toBe(1)
  })

  it('tokens.css matches MOTION', () => {
    const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')
    expect(MOTION).toEqual({ fast: 120, base: 200, slow: 320 })
    for (const s of [
      '--motion-fast: 120ms',
      '--motion-base: 200ms',
      '--motion-slow: 320ms',
      '--ease: cubic-bezier(.2, .8, .2, 1)',
      '--text-size: 16px',
      '--text-leading: 1.6',
    ]) {
      expect(css).toContain(s)
    }
  })
})
