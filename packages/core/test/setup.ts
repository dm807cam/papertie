import { PMap } from '../src/pmap'

/**
 * `toEqual` compares a `PMap` as it compares a `Map`: the same entries in any order, against
 * another `PMap` or a `Map`, so states built by core and by hand compare by content.
 */
expect.addEqualityTesters([
  function mapsAlike(a, b, testers) {
    const mapLike = (x: unknown) => x instanceof PMap || x instanceof Map
    if (!(a instanceof PMap || b instanceof PMap) || !mapLike(a) || !mapLike(b)) return undefined
    const x = a as ReadonlyMap<unknown, unknown>
    const y = b as ReadonlyMap<unknown, unknown>
    if (x.size !== y.size) return false
    for (const [k, v] of x) if (!y.has(k) || !this.equals(v, y.get(k), testers)) return false
    return true
  },
])

/**
 * Failed comparisons print a `PMap`'s entries rather than `PMap {}`: the diff printer prints
 * immutable-js ordered maps by their entries, so test runs mark `PMap` as one (tests only).
 */
for (const sentinel of ['ITERABLE', 'KEYED', 'MAP', 'ORDERED']) {
  Object.defineProperty(PMap.prototype, `@@__IMMUTABLE_${sentinel}__@@`, { value: true })
}
