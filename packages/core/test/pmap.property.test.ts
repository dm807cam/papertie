/**
 * Model test: random sets and deletes on a `PMap` (persistently, and through transients) read
 * exactly as the same edits on a `Map`, including iteration order, and every earlier version
 * still reads as it did.
 */
import fc from 'fast-check'
import { type MapChanges, mapChangesWithin, PMap } from '../src/pmap'

/** Every change, however many: no limit. */
const mapChanges = <K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>) =>
  mapChangesWithin(a, b, Number.POSITIVE_INFINITY) as MapChanges<K>

import { collidingKeys } from './fixtures'

const [c1, c2] = collidingKeys()
// A small key space, so commands hit existing keys often; plus the colliding pair.
const arbKey = fc.oneof(
  fc.integer({ min: 0, max: 40 }).map((i) => `k${i}`),
  fc.constantFrom(c1, c2),
)

type Cmd = { kind: 'set'; key: string; value: number } | { kind: 'delete'; key: string }

const arbCmd: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ kind: fc.constant('set' as const), key: arbKey, value: fc.integer() }),
  fc.record({ kind: fc.constant('delete' as const), key: arbKey }),
)

function expectSame(actual: ReadonlyMap<string, number>, model: ReadonlyMap<string, number>) {
  expect(actual.size).toBe(model.size)
  expect([...actual]).toEqual([...model])
  expect([...actual.keys()]).toEqual([...model.keys()])
  expect([...actual.values()]).toEqual([...model.values()])
  for (const key of [...model.keys(), 'k0', 'k40', c1, c2]) {
    expect(actual.has(key)).toBe(model.has(key))
    expect(actual.get(key)).toBe(model.get(key))
  }
}

describe('pmap behaves like Map', () => {
  it('persistent set and delete, with every old version intact', () => {
    fc.assert(
      fc.property(fc.array(arbCmd, { maxLength: 200 }), (cmds) => {
        const model = new Map<string, number>()
        let m = PMap.from<string, number>()
        const versions: Array<[PMap<string, number>, Map<string, number>]> = []
        for (const cmd of cmds) {
          if (cmd.kind === 'set') {
            model.set(cmd.key, cmd.value)
            m = m.set(cmd.key, cmd.value)
          } else {
            model.delete(cmd.key)
            m = m.delete(cmd.key)
          }
          versions.push([m, new Map(model)])
          expectSame(m, model)
        }
        for (const [version, snapshot] of versions) expectSame(version, snapshot)
      }),
      { numRuns: 300 },
    )
  })

  it('transients, persisted at random points', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbCmd, fc.boolean()), { maxLength: 300 }),
        fc.array(fc.tuple(arbKey, fc.integer())),
        (cmds, start) => {
          const model = new Map(start)
          let m = PMap.from(start)
          expectSame(m, model)
          let t = m.asTransient()
          for (const [cmd, persistNow] of cmds) {
            if (cmd.kind === 'set') {
              model.set(cmd.key, cmd.value)
              t.set(cmd.key, cmd.value)
            } else {
              expect(t.delete(cmd.key)).toBe(model.delete(cmd.key))
            }
            expectSame(t, model)
            if (persistNow) {
              const before = new Map(model)
              m = t.persist()
              t = m.asTransient()
              t.set('k0', -1)
              t = m.asTransient()
              expectSame(m, before)
            }
          }
          expectSame(t.persist(), model)
        },
      ),
      { numRuns: 300 },
    )
  })
})

/** What changed from `a` to `b`, the slow way: every key of both. */
function bruteChanges(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) {
  const set: string[] = []
  const deleted: string[] = []
  for (const [k, v] of b) if (!a.has(k) || !Object.is(a.get(k), v)) set.push(k)
  for (const k of a.keys()) if (!b.has(k)) deleted.push(k)
  return { set: set.sort(), deleted: deleted.sort() }
}

const sorted = (c: { set: string[]; deleted: string[] }) => ({
  set: [...c.set].sort(),
  deleted: [...c.deleted].sort(),
})

describe('mapChangesWithin, no limit', () => {
  it('names exactly the keys set (new or changed) and deleted between two versions', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbKey, fc.integer())),
        fc.array(arbCmd, { maxLength: 200 }),
        fc.array(arbCmd, { maxLength: 60 }),
        (start, before, after) => {
          let a = PMap.from(start)
          for (const c of before) a = c.kind === 'set' ? a.set(c.key, c.value) : a.delete(c.key)
          let b = a
          for (const c of after) b = c.kind === 'set' ? b.set(c.key, c.value) : b.delete(c.key)
          expect(sorted(mapChanges(a, b))).toEqual(bruteChanges(a, b))
          expect(sorted(mapChanges(b, a))).toEqual(bruteChanges(b, a))
        },
      ),
      { numRuns: 300 },
    )
  })

  it('agrees for unrelated maps and plain Maps too', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbKey, fc.integer())),
        fc.array(fc.tuple(arbKey, fc.integer())),
        (x, y) => {
          const want = bruteChanges(new Map(x), new Map(y))
          expect(sorted(mapChanges(PMap.from(x), PMap.from(y)))).toEqual(want)
          expect(sorted(mapChanges(new Map(x), PMap.from(y)))).toEqual(want)
          expect(sorted(mapChanges(new Map(x), new Map(y)))).toEqual(want)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('is empty for one map, and through a rebuild that dropped holes', () => {
    const keys = Array.from({ length: 300 }, (_, i) => `key${i}`)
    let m = PMap.from(keys.map((k, i) => [k, i] as const))
    expect(mapChanges(m, m)).toEqual({ set: [], deleted: [] })
    const t = m.asTransient()
    // More holes than entries: the vector is rebuilt, every slot moves.
    for (const k of keys.slice(0, 200)) t.delete(k)
    m = t.persist()
    const again = PMap.from([...m])
    expect(mapChanges(m, again)).toEqual({ set: [], deleted: [] })
  })
})

describe('mapChangesWithin', () => {
  it('answers null past `limit` changed keys, and otherwise only what mapChanges answers', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbKey, fc.integer())),
        fc.array(arbCmd, { maxLength: 200 }),
        fc.array(arbCmd, { maxLength: 60 }),
        fc.integer({ min: 0, max: 40 }),
        (start, before, after, limit) => {
          let a = PMap.from(start)
          for (const c of before) a = c.kind === 'set' ? a.set(c.key, c.value) : a.delete(c.key)
          let b = a
          for (const c of after) b = c.kind === 'set' ? b.set(c.key, c.value) : b.delete(c.key)
          const want = bruteChanges(a, b)
          const got = mapChangesWithin(a, b, limit)
          if (want.set.length + want.deleted.length > limit) expect(got).toBeNull()
          else if (got !== null) expect(sorted(got)).toEqual(want)
          const plain = mapChangesWithin(new Map(a), new Map(b), limit)
          if (want.set.length + want.deleted.length > limit) expect(plain).toBeNull()
          else expect(plain && sorted(plain)).toEqual(want)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('answers, never null, while at most `limit` keys changed and no slot moved', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbKey, fc.integer())),
        fc.array(fc.tuple(arbKey, fc.integer()), { maxLength: 60 }),
        fc.integer({ min: 0, max: 80 }),
        (start, sets, limit) => {
          // Only sets: a vector never rebuilds (no holes), so no leaf moves its slot.
          const a = PMap.from(start)
          let b = a
          for (const [k, v] of sets) b = b.set(k, v)
          const want = bruteChanges(a, b)
          const got = mapChangesWithin(a, b, limit)
          if (want.set.length + want.deleted.length > limit) expect(got).toBeNull()
          else expect(got && sorted(got)).toEqual(want)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('finds a few edits to a large map exactly', () => {
    let m = PMap.from<string, number>(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i]))
    const before = m
    m = m.set('k5', -1).set('new', 1).delete('k77000')
    expect(sorted(mapChangesWithin(before, m, 64) ?? { set: [], deleted: ['none'] })).toEqual({
      set: ['k5', 'new'],
      deleted: ['k77000'],
    })
    expect(mapChangesWithin(before, m, 2)).toBeNull()
  })

  it('gives up on two unrelated large maps after about `limit` keys, not a walk of either', () => {
    const n = 100_000
    const x = PMap.from(Array.from({ length: n }, (_, i) => [`k${i}`, i] as const))
    const y = PMap.from(Array.from({ length: n }, (_, i) => [`k${i}`, i] as const))
    expect(mapChangesWithin(x, y, 64)).toBeNull()
  })
})
