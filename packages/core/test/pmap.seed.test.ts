/**
 * The split hash's seed: random per process, unless a test that must replay exactly
 * sets it, and only before any bucket of this process was split (a split map is read with the
 * seed it was split by). Its own file: a split anywhere in the process ends the choice.
 */
import { largestBucket, PMap, SPLIT_AT, setSplitSeed } from '../src/pmap'

/** `n` keys sharing their tail, so they share a root slot: enough of them split it. */
const crafted = (n: number) =>
  Array.from({ length: n }, (_, i) => `note_${i.toString(32).padStart(4, '0')}${'Z'.repeat(22)}`)

describe('the split seed', () => {
  it('a test sets it before any split; the split spreads keys by it; then it is fixed', () => {
    setSplitSeed(7)
    setSplitSeed(7)
    const maps = [2, 4, 8, 16].map((k) => {
      const keys = crafted(SPLIT_AT * k)
      return { keys, map: PMap.from(keys.map((key, i): [string, number] => [key, i])) }
    })
    for (const { keys, map } of maps)
      for (const [i, k] of keys.entries()) expect(map.get(k)).toBe(i)
    // Seed 7 spreads these keys so, in every process, on every day.
    expect(maps.map(({ map }) => largestBucket(map))).toEqual([14, 22, 46, 77])
    expect(() => setSplitSeed(8)).toThrow(/split/)
    expect(() => setSplitSeed(null)).toThrow(/split/)
    setSplitSeed(7) // no change
    for (const { keys, map } of maps)
      for (const [i, k] of keys.entries()) expect(map.get(k)).toBe(i)
  })
})
