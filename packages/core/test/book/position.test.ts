import fc from 'fast-check'
import { LIMITS, POS_PATTERN, posBetween, posKeysBetween } from '../../src/index'

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('')

/** A valid key: base-62 digits, never ending in `0`. */
const arbKey = fc
  .tuple(
    fc.string({ unit: fc.constantFrom(...DIGITS), maxLength: 12 }),
    fc.constantFrom(...DIGITS.slice(1)),
  )
  .map(([head, last]) => head + last)

function expectValid(key: string): void {
  expect(key).toMatch(POS_PATTERN)
  expect(key.length).toBeLessThanOrEqual(LIMITS.maxPosLength)
}

describe('posBetween', () => {
  it('posBetween is strictly between its bounds for 10,000 random pairs', () => {
    fc.assert(
      fc.property(arbKey, arbKey, (x, y) => {
        fc.pre(x !== y)
        const [a, b] = x < y ? [x, y] : [y, x]
        const k = posBetween(a, b)
        expectValid(k)
        expect(a < k && k < b).toBe(true)
        const before = posBetween(null, a)
        expectValid(before)
        expect(before < a).toBe(true)
        const after = posBetween(b, null)
        expectValid(after)
        expect(after > b).toBe(true)
      }),
      { numRuns: 10_000 },
    )
  })

  it('10,000 appends stay under maxPosLength', () => {
    let last = posBetween(null, null)
    expectValid(last)
    const start = last.length
    for (let i = 1; i <= 10_000; i++) {
      const next = posBetween(last, null)
      expectValid(next)
      expect(next > last).toBe(true)
      // At most one character more per 62 appends.
      expect(next.length).toBeLessThanOrEqual(start + 1 + Math.floor(i / 62))
      last = next
    }
    expect(last.length).toBeLessThan(LIMITS.maxPosLength)
  })

  it('10,000 prepends stay under maxPosLength', () => {
    let first = posBetween(null, null)
    for (let i = 0; i < 10_000; i++) {
      const next = posBetween(null, first)
      expectValid(next)
      expect(next < first).toBe(true)
      first = next
    }
    expect(first.length).toBeLessThan(LIMITS.maxPosLength)
  })

  it('refuses bounds out of order and keys that are not keys', () => {
    expect(() => posBetween('b', 'a')).toThrow(RangeError)
    expect(() => posBetween('a', 'a')).toThrow(RangeError)
    expect(() => posBetween('a0', null)).toThrow(RangeError)
    expect(() => posBetween('', null)).toThrow(RangeError)
    expect(() => posBetween('a-', null)).toThrow(RangeError)
  })
})

describe('posKeysBetween', () => {
  const increasingWithin = (keys: string[], a: string | null, b: string | null, n: number) => {
    expect(keys).toHaveLength(n)
    for (const k of keys) expectValid(k)
    for (let i = 1; i < keys.length; i++) {
      expect((keys[i - 1] as string) < (keys[i] as string)).toBe(true)
    }
    if (a !== null) expect((keys[0] as string) > a).toBe(true)
    if (b !== null) expect((keys[n - 1] as string) < b).toBe(true)
  }

  it('posKeysBetween gives 30,000 increasing keys between its bounds, each within maxPosLength', () => {
    increasingWithin(posKeysBetween('1', 'y', 30_000), '1', 'y', 30_000)
    // Between two adjacent keys.
    const a = posBetween(null, null)
    const b = posBetween(a, null)
    const tight = posBetween(a, posBetween(a, b))
    increasingWithin(posKeysBetween(a, tight, 30_000), a, tight, 30_000)
    // With null bounds.
    increasingWithin(posKeysBetween(null, null, 30_000), null, null, 30_000)
    increasingWithin(posKeysBetween(null, a, 30_000), null, a, 30_000)
    increasingWithin(posKeysBetween(b, null, 30_000), b, null, 30_000)
  })

  it('spreads the keys evenly: they stay short, never one bisection after another', () => {
    const keys = posKeysBetween(null, null, 30_000)
    // 62³ > 30,000: three digits are enough.
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(3)
  })

  it('holds for random bounds', () => {
    fc.assert(
      fc.property(arbKey, arbKey, fc.integer({ min: 1, max: 300 }), (x, y, n) => {
        fc.pre(x !== y)
        const [a, b] = x < y ? [x, y] : [y, x]
        increasingWithin(posKeysBetween(a, b, n), a, b, n)
      }),
      { numRuns: 500 },
    )
  })

  it('gives none for n = 0 and refuses a negative n', () => {
    expect(posKeysBetween(null, null, 0)).toEqual([])
    expect(() => posKeysBetween(null, null, -1)).toThrow(RangeError)
  })
})
