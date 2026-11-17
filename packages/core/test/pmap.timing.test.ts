/**
 * The timed row of pmap.property.test.ts (a give-up timed against a walk), in the timing project
 * (`vitest.config.ts`); the file keeps the row without it.
 */
import { type MapChanges, mapChangesWithin, PMap } from '../src/pmap'

/** Every change, however many: no limit. */
const mapChanges = <K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>) =>
  mapChangesWithin(a, b, Number.POSITIVE_INFINITY) as MapChanges<K>

describe('mapChangesWithin', () => {
  it('gives up on two unrelated large maps after about `limit` keys, not a walk of either', () => {
    const n = 100_000
    const x = PMap.from(Array.from({ length: n }, (_, i) => [`k${i}`, i] as const))
    const y = PMap.from(Array.from({ length: n }, (_, i) => [`k${i}`, i] as const))
    const time = (f: () => unknown) => {
      let best = Number.POSITIVE_INFINITY
      for (let i = 0; i < 5; i++) {
        const t = performance.now()
        f()
        best = Math.min(best, performance.now() - t)
      }
      return best
    }
    expect(mapChangesWithin(x, y, 64)).toBeNull()
    const within = time(() => mapChangesWithin(x, y, 64))
    const whole = time(() => mapChanges(x, y))
    expect(within).toBeLessThan(whole / 20)
  })
})
