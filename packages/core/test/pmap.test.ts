import {
  type ApplyCtx,
  applyBatch,
  applyLenient,
  type BoardState,
  emptyBoardState,
  newId,
  parseBoard,
  repairReferences,
  serializeBoard,
  stateFromRecords,
} from '../src/index'
import { hashKey, largestBucket, PMap, SPLIT_AT } from '../src/pmap'
import { collidingKeys, fixtureId, makeBoard, makeNote, makeYarn, T0 } from './fixtures'

describe('PMap', () => {
  it('reads like a ReadonlyMap', () => {
    const m = PMap.from([
      ['a', 1],
      ['b', 2],
    ])
    expect(m.size).toBe(2)
    expect(m.get('a')).toBe(1)
    expect(m.get('z')).toBeUndefined()
    expect(m.has('b')).toBe(true)
    expect(m.has('z')).toBe(false)
    expect([...m]).toEqual([
      ['a', 1],
      ['b', 2],
    ])
    expect([...m.keys()]).toEqual(['a', 'b'])
    expect([...m.values()]).toEqual([1, 2])
    expect([...m.entries()]).toEqual([...new Map(m)])
    const seen: unknown[] = []
    m.forEach(function (this: unknown, v, k, map) {
      seen.push([k, v, map === m, this])
    }, 'ctx')
    expect(seen).toEqual([
      ['a', 1, true, 'ctx'],
      ['b', 2, true, 'ctx'],
    ])
  })

  it('old versions are untouched after set', () => {
    const v0 = PMap.from<string, number>([['a', 1]])
    const v1 = v0.set('b', 2)
    const v2 = v1.set('a', 10)
    const v3 = v2.delete('b')
    expect([...v0]).toEqual([['a', 1]])
    expect([...v1]).toEqual([
      ['a', 1],
      ['b', 2],
    ])
    expect([...v2]).toEqual([
      ['a', 10],
      ['b', 2],
    ])
    expect([...v3]).toEqual([['a', 10]])
    expect(v1.get('a')).toBe(1)
    expect(v0.has('b')).toBe(false)
  })

  it('keeps insertion order as Map does: a changed value stays in place, a re-added key goes last', () => {
    const m = PMap.from([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ])
      .set('a', 9)
      .delete('b')
      .set('b', 4)
    expect([...m.keys()]).toEqual(['a', 'c', 'b'])
    expect(m.get('a')).toBe(9)
  })

  it('returns the same map for a set to the same value or a delete of a missing key', () => {
    const value = { x: 1 }
    const m = PMap.from([['a', value]])
    expect(m.set('a', value)).toBe(m)
    expect(m.delete('zzz')).toBe(m)
    expect(m.set('a', { x: 1 })).not.toBe(m)
  })

  it('from keeps the first place and the last value of a repeated key', () => {
    const m = PMap.from([
      ['a', 1],
      ['b', 2],
      ['a', 3],
    ])
    expect([...m]).toEqual([
      ['a', 3],
      ['b', 2],
    ])
  })

  it('compares keys with SameValueZero', () => {
    const m = PMap.from<number, string>([
      [Number.NaN, 'nan'],
      [-0, 'zero'],
    ])
    expect(m.get(Number.NaN)).toBe('nan')
    expect(m.get(0)).toBe('zero')
    expect(Object.is([...m.keys()][1], 0)).toBe(true)
    const o = {}
    const byObject = PMap.from([[o, 1]])
    expect(byObject.get(o)).toBe(1)
    expect(byObject.has({})).toBe(false)
  })

  it('keeps keys whose hashes collide apart', () => {
    const [k1, k2] = collidingKeys()
    expect(hashKey(k1)).toBe(hashKey(k2))
    const m = PMap.from([
      [k1, 1],
      [k2, 2],
      ['other', 3],
    ])
    expect(m.get(k1)).toBe(1)
    expect(m.get(k2)).toBe(2)
    const without1 = m.delete(k1)
    expect(without1.has(k1)).toBe(false)
    expect(without1.get(k2)).toBe(2)
    expect(without1.set(k1, 5).get(k1)).toBe(5)
    expect(m.get(k1)).toBe(1)
    expect([...without1.delete(k2).keys()]).toEqual(['other'])
  })

  it('stays correct at 100,000 keys through deletes and the rebuild that drops holes', () => {
    const n = 100_000
    let m = PMap.from(Array.from({ length: n }, (_, i): [string, number] => [`k${i}`, i]))
    expect(m.size).toBe(n)
    const t = m.asTransient()
    for (let i = 0; i < n; i += 4) t.delete(`k${i}`)
    for (let i = 1; i < n; i += 4) t.delete(`k${i}`)
    // More than half of the vector is now holes once the next delete lands.
    for (let i = 2; i < n; i += 4) t.delete(`k${i}`)
    m = t.persist()
    expect(m.size).toBe(n / 4)
    const keys = [...m.keys()]
    expect(keys.length).toBe(n / 4)
    expect(keys[0]).toBe('k3')
    expect(keys.at(-1)).toBe(`k${n - 1}`)
    const wrong = Array.from({ length: n }, (_, i) => i).filter(
      (i) => m.get(`k${i}`) !== (i % 4 === 3 ? i : undefined),
    )
    expect(wrong).toEqual([])
  })
})

describe('PMap buckets', () => {
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const tail = (n: number, width: number) =>
    Array.from({ length: width }, (_, i) => CROCKFORD[(n >>> (5 * (width - 1 - i))) & 31]).join('')
  /** A map of `keys` built at once and one grown by writes, with the keys' values checked. */
  const both = (keys: string[]) => {
    const built = PMap.from(keys.map((k, i): [string, number] => [k, i]))
    const t = PMap.from<string, number>().asTransient()
    for (const [i, k] of keys.entries()) t.set(k, i)
    const grown = t.persist()
    for (const m of [built, grown]) {
      expect(m.size).toBe(keys.length)
      expect(keys.filter((k, i) => m.get(k) !== i)).toEqual([])
    }
    return [built, grown]
  }

  it('ids sharing their tail still spread: a write copies at most SPLIT_AT keys', () => {
    // 30,000 ids differing only in their first characters (a client chooses its ids).
    const crafted = Array.from({ length: 30_000 }, (_, i) => `note_${tail(i, 4)}${'Z'.repeat(22)}`)
    for (const m of both(crafted)) expect(largestBucket(m)).toBeLessThanOrEqual(SPLIT_AT)
  })

  it('regularly spaced fixture ids spread too', () => {
    const spaced = Array.from({ length: 30_000 }, (_, i) => fixtureId('note', i * 4096))
    for (const m of both(spaced)) expect(largestBucket(m)).toBeLessThanOrEqual(SPLIT_AT)
  })

  it('random ids never split: about 25 keys a bucket at 100,000', () => {
    const ids = Array.from({ length: 100_000 }, (_, i) => newId('note', 1_700_000_000_000 + i))
    expect(largestBucket(PMap.from(ids.map((id): [string, number] => [id, 0])))).toBeLessThan(80)
  })
})

describe('PMap growth', () => {
  it('a map grown by writes keeps order and values as its root widens', () => {
    const t = PMap.from<string, number>().asTransient()
    const model = new Map<string, number>()
    for (let i = 0; i < 20_000; i++) {
      t.set(`g${i}`, i)
      model.set(`g${i}`, i)
      if (i % 7 === 0) {
        t.delete(`g${i - 3}`)
        model.delete(`g${i - 3}`)
      }
    }
    const m = t.persist()
    expect(m.size).toBe(model.size)
    expect([...m.keys()]).toEqual([...model.keys()])
    expect([...model.keys()].filter((k) => m.get(k) !== model.get(k))).toEqual([])
  })
})

describe('PMap iterators', () => {
  it('inherit from Iterator.prototype like a Map iterator, so iterator helpers work', () => {
    const m = PMap.from([
      ['a', 1],
      ['b', 2],
    ])
    const Iterator = (globalThis as { Iterator?: { prototype: object } }).Iterator
    if (Iterator === undefined) return
    for (const it of [m.keys(), m.values(), m.entries(), m[Symbol.iterator]()]) {
      expect(Object.prototype.isPrototypeOf.call(Iterator.prototype, it)).toBe(true)
    }
    const helpers = m.values() as unknown as {
      map(f: (v: number) => number): { toArray(): number[] }
    }
    expect(helpers.map((v) => v * 10).toArray()).toEqual([10, 20])
  })
})

describe('TransientMap', () => {
  it('collects writes, persists them, and leaves its source alone', () => {
    const base = PMap.from([['a', 1]])
    const t = base.asTransient()
    t.set('b', 2).set('a', 3)
    expect(t.delete('b')).toBe(true)
    expect(t.delete('b')).toBe(false)
    expect(t.get('a')).toBe(3)
    expect(t.size).toBe(1)
    const done = t.persist()
    expect([...done]).toEqual([['a', 3]])
    expect([...base]).toEqual([['a', 1]])
  })

  it('cannot be written after persist, so the persisted map never changes', () => {
    const t = PMap.from<string, number>().asTransient()
    t.set('a', 1)
    const done = t.persist()
    expect(() => t.set('b', 2)).toThrow(/after persist/)
    expect(() => t.delete('a')).toThrow(/after persist/)
    expect(() => t.persist()).toThrow(/after persist/)
    expect([...done]).toEqual([['a', 1]])
  })

  it('two transients from one map do not see each other', () => {
    const base = PMap.from([['a', 1]])
    const t1 = base.asTransient().set('a', 2)
    const t2 = base.asTransient().set('a', 3)
    expect(t1.persist().get('a')).toBe(2)
    expect(t2.persist().get('a')).toBe(3)
    expect(base.get('a')).toBe(1)
  })
})

describe('core builds PMaps', () => {
  const ctx: ApplyCtx = { now: '2026-11-02T10:00:00.000Z' }
  const a = fixtureId('note', 1)
  const b = fixtureId('note', 2)
  const isPMapState = (s: BoardState | null) =>
    s !== null && [s.assets, s.notes, s.yarns, s.books, s.blocks].every((m) => m instanceof PMap)

  it('from records, on load, after repair and after ops, even from a hand-built state', () => {
    const built = stateFromRecords(makeBoard(), [
      makeNote({ id: a }),
      makeNote({ id: b }),
      makeYarn([a, b], { id: fixtureId('yarn', 1) }),
    ])
    expect(isPMapState(built)).toBe(true)
    expect(isPMapState(emptyBoardState(fixtureId('board', 1), 'B', T0))).toBe(true)
    expect(isPMapState(parseBoard(serializeBoard(built)).state)).toBe(true)
    const dangling: BoardState = {
      ...built,
      assets: new Map(),
      notes: new Map([[a, makeNote({ id: a })]]),
    }
    expect(isPMapState(repairReferences(dangling).state)).toBe(true)
    const handBuilt: BoardState = {
      board: makeBoard(),
      assets: new Map(),
      notes: new Map([[a, makeNote({ id: a })]]),
      yarns: new Map(),
      books: new Map(),
      blocks: new Map(),
      blocksHeld: 'all',
    }
    const op = { op: 'note.update', id: a, set: { x: 3 } } as const
    expect(isPMapState(applyBatch(handBuilt, [op], ctx))).toBe(true)
    expect(isPMapState(applyLenient(handBuilt, [op], ctx).state)).toBe(true)
  })
})

describe('PMap.sized', () => {
  it('starts empty, and a transient filled from it is the map PMap.from makes', () => {
    expect(PMap.sized(0).size).toBe(0)
    expect(PMap.sized(100_000).size).toBe(0)
    const t = PMap.sized<string, number>(5000).asTransient()
    const entries: Array<[string, number]> = []
    for (let i = 0; i < 5000; i++) {
      t.set(`k${i}`, i)
      entries.push([`k${i}`, i])
    }
    t.set('k7', -7)
    entries[7] = ['k7', -7]
    expect([...t.persist()]).toEqual([...PMap.from(entries)])
  })
})
