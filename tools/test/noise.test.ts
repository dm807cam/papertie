import fc from 'fast-check'
import { fbmPeriodic, periodicNoise2D, worleyPeriodic } from '../src/textures/noise'

const unit = fc.double({ min: 0, max: 8, noNaN: true })

describe('periodicNoise2D', () => {
  it('repeats with its period', () => {
    fc.assert(
      fc.property(
        unit,
        unit,
        (x, y) =>
          Math.abs(periodicNoise2D(x, y, 8, 7) - periodicNoise2D(x + 8, y, 8, 7)) < 1e-12 &&
          Math.abs(periodicNoise2D(x, y, 8, 7) - periodicNoise2D(x, y + 8, 8, 7)) < 1e-12,
      ),
    )
  })

  it('stays in [-1, 1] and is not constant', () => {
    let lo = 1
    let hi = -1
    for (let i = 0; i < 2000; i++) {
      const n = periodicNoise2D(i * 0.0371, i * 0.0173, 8, 3)
      expect(n).toBeGreaterThanOrEqual(-1)
      expect(n).toBeLessThanOrEqual(1)
      lo = Math.min(lo, n)
      hi = Math.max(hi, n)
    }
    expect(hi - lo).toBeGreaterThan(0.5)
  })
})

describe('fbmPeriodic', () => {
  it('tiles over the unit square and stays in [-1, 1]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (u, v) => {
          const n = fbmPeriodic(u, v, 8, 4, 5)
          return (
            Math.abs(n) <= 1 &&
            Math.abs(n - fbmPeriodic(u + 1, v, 8, 4, 5)) < 1e-9 &&
            Math.abs(n - fbmPeriodic(u, v + 1, 8, 4, 5)) < 1e-9
          )
        },
      ),
    )
  })
})

describe('worleyPeriodic', () => {
  it('wraps across the tile edge', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (u, v) => {
          const w = worleyPeriodic(u, v, 12, 3)
          const x = worleyPeriodic(u + 1, v, 12, 3)
          const y = worleyPeriodic(u, v + 1, 12, 3)
          return (
            Math.abs(w.f1 - x.f1) < 1e-12 &&
            Math.abs(w.f1 - y.f1) < 1e-12 &&
            w.cellId === x.cellId &&
            w.cellId === y.cellId
          )
        },
      ),
    )
  })

  it('returns ordered distances', () => {
    for (let i = 0; i < 500; i++) {
      const w = worleyPeriodic((i * 0.0137) % 1, (i * 0.0291) % 1, 12, 3)
      expect(w.f1).toBeLessThanOrEqual(w.f2)
      expect(w.f1).toBeGreaterThanOrEqual(0)
    }
  })
})
