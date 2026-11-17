import fc from 'fast-check'
import { latticeHash, mulberry32 } from '../src/rng'

describe('mulberry32', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 1000; i++) {
      const x = a()
      expect(x).toBe(b())
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })

  it('different seeds give different streams', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)())
  })
})

describe('latticeHash', () => {
  it('is deterministic and in [0, 1)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), fc.integer(), (x, y, s) => {
        const h = latticeHash(x, y, s)
        return h >= 0 && h < 1 && h === latticeHash(x, y, s)
      }),
    )
  })

  it('varies with each argument', () => {
    expect(latticeHash(1, 2, 3)).not.toBe(latticeHash(2, 1, 3))
    expect(latticeHash(1, 2, 3)).not.toBe(latticeHash(1, 2, 4))
  })
})
