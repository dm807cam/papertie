import {
  buildMembership,
  computeFocus,
  type FocusDepth,
  type FocusQuery,
  type Membership,
  stateFromRecords,
} from '../src/index'
import { fixtureId, makeBoard, makeNote, makeYarn, neighbours } from './fixtures'

const [a, b, c, d, e, f, g] = [1, 2, 3, 4, 5, 6, 7].map((n) => fixtureId('note', n)) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
]
const [Y1, Y2, Y3, Y4] = [1, 2, 3, 4].map((n) => fixtureId('yarn', n)) as [
  string,
  string,
  string,
  string,
]
const ghost = fixtureId('note', 99)

// Y1 [a,b,c], Y2 [c,d], Y3 [d,e], Y4 [f,g]
function fixtureMembership(): Membership {
  const notes = [a, b, c, d, e, f, g].map((id) => makeNote({ id }))
  const yarns = [
    makeYarn([a, b, c], { id: Y1 }),
    makeYarn([c, d], { id: Y2 }),
    makeYarn([d, e], { id: Y3 }),
    makeYarn([f, g], { id: Y4 }),
  ]
  return buildMembership(stateFromRecords(makeBoard(), [...notes, ...yarns]))
}

const focus = (m: Membership, seeds: string[], depth: FocusDepth, include: string[] = []) =>
  computeFocus(m, { seeds, depth, include })

const sorted = (s: Iterable<string>) => [...s].sort()

describe('buildMembership / neighbours', () => {
  it('indexes yarns by note and notes by yarn, including unconnected notes', () => {
    const m = fixtureMembership()
    expect(sorted(m.yarnsByNote.get(c) ?? [])).toEqual(sorted([Y1, Y2]))
    expect(m.notesByYarn.get(Y1)).toEqual([a, b, c])
    const lonely = buildMembership(stateFromRecords(makeBoard(), [makeNote({ id: a })]))
    expect(lonely.yarnsByNote.has(a)).toBe(true)
    expect(lonely.yarnsByNote.get(a)?.size).toBe(0)
  })

  it('every note on a thread is one step from every other, excluding itself', () => {
    const m = fixtureMembership()
    expect(sorted(neighbours(m, a))).toEqual(sorted([b, c]))
    expect(sorted(neighbours(m, c))).toEqual(sorted([a, b, d]))
    expect(neighbours(m, ghost).size).toBe(0)
  })

  it('thread order does not affect distance', () => {
    const notes = [a, b, c].map((id) => makeNote({ id }))
    const m = buildMembership(
      stateFromRecords(makeBoard(), [...notes, makeYarn([a, b, c], { id: Y1 })]),
    )
    expect(focus(m, [a], 1).notes).toEqual(new Set([a, b, c]))
  })
})

describe('computeFocus', () => {
  it('depth 1 shows the immediate thread neighbourhood and a loose end', () => {
    const r = focus(fixtureMembership(), [a], 1)
    expect(r.notes).toEqual(new Set([a, b, c]))
    expect(r.yarns).toEqual(new Set([Y1]))
    expect(r.looseEnds).toEqual([{ yarnId: Y2, noteId: c }])
    expect(r.canExpand).toBe(true)
  })

  it('depth 2 reaches one more thread', () => {
    const r = focus(fixtureMembership(), [a], 2)
    expect(r.notes).toEqual(new Set([a, b, c, d]))
    expect(r.yarns).toEqual(new Set([Y1, Y2]))
    expect(r.looseEnds).toEqual([{ yarnId: Y3, noteId: d }])
  })

  it("'all' takes the whole connected component", () => {
    const r = focus(fixtureMembership(), [a], 'all')
    expect(r.notes).toEqual(new Set([a, b, c, d, e]))
    expect(r.yarns).toEqual(new Set([Y1, Y2, Y3]))
    expect(r.looseEnds).toEqual([])
    expect(r.canExpand).toBe(false)
  })

  it('manual include adds a note with no depth; its hidden thread partner is a loose end', () => {
    const r = focus(fixtureMembership(), [a], 1, [f])
    expect(r.notes.has(f)).toBe(true)
    expect(r.yarns.has(Y4)).toBe(false)
    expect(r.looseEnds).toEqual([
      { yarnId: Y2, noteId: c },
      { yarnId: Y4, noteId: f },
    ])
    expect(r.depthOf.has(f)).toBe(false)
  })

  it('include notes are not expanded from', () => {
    const r = focus(fixtureMembership(), [a], 1, [d])
    expect(r.notes).toEqual(new Set([a, b, c, d]))
    expect(r.notes.has(e)).toBe(false)
    // Y2 [c,d] is now fully visible
    expect(r.yarns).toEqual(new Set([Y1, Y2]))
    expect(r.looseEnds).toEqual([{ yarnId: Y3, noteId: d }])
  })

  it('several seeds give the union of their neighbourhoods', () => {
    const r = focus(fixtureMembership(), [a, f], 1)
    expect(r.notes).toEqual(new Set([a, b, c, f, g]))
    expect(r.yarns).toEqual(new Set([Y1, Y4]))
    expect(r.looseEnds).toEqual([{ yarnId: Y2, noteId: c }])
    expect(r.depthOf.get(a)).toBe(0)
    expect(r.depthOf.get(f)).toBe(0)
    expect(r.depthOf.get(g)).toBe(1)
  })

  it('a deleted seed is ignored without throwing', () => {
    const r = focus(fixtureMembership(), [ghost], 2)
    expect(r.notes.size).toBe(0)
    expect(r.yarns.size).toBe(0)
    expect(r.looseEnds).toEqual([])
    expect(r.depthOf.size).toBe(0)
    expect(r.canExpand).toBe(false)
  })

  it('a deleted seed alongside a live one keeps the live one', () => {
    const r = focus(fixtureMembership(), [ghost, a], 1)
    expect(r.notes).toEqual(new Set([a, b, c]))
    expect(r.depthOf.has(ghost)).toBe(false)
  })

  it('a present but unconnected seed shows alone', () => {
    const m = buildMembership(stateFromRecords(makeBoard(), [makeNote({ id: a })]))
    const r = focus(m, [a], 1)
    expect(r.notes).toEqual(new Set([a]))
    expect(r.depthOf.get(a)).toBe(0)
    expect(r.canExpand).toBe(false)
  })

  it('ignores include ids that do not exist', () => {
    const r = focus(fixtureMembership(), [a], 1, [ghost])
    expect(r.notes).toEqual(new Set([a, b, c]))
  })

  it('reports BFS distances in depthOf', () => {
    const r = focus(fixtureMembership(), [a], 'all')
    expect([...r.depthOf.entries()].sort()).toEqual(
      [
        [a, 0],
        [b, 1],
        [c, 1],
        [d, 2],
        [e, 3],
      ].sort(),
    )
  })

  it('never shrinks as depth grows, and depthOf is stable', () => {
    const m = fixtureMembership()
    const depths: FocusDepth[] = [1, 2, 3, 'all']
    let prev = focus(m, [a], 1)
    for (const depth of depths.slice(1)) {
      const next = focus(m, [a], depth)
      for (const id of prev.notes) expect(next.notes.has(id)).toBe(true)
      for (const id of prev.yarns) expect(next.yarns.has(id)).toBe(true)
      for (const [id, dist] of prev.depthOf) expect(next.depthOf.get(id)).toBe(dist)
      prev = next
    }
  })

  it('depthOf is monotonic: every depth-n note has a depth-(n-1) neighbour', () => {
    const m = fixtureMembership()
    const r = focus(m, [a], 'all')
    for (const [id, dist] of r.depthOf) {
      if (dist === 0) continue
      const hasParent = [...neighbours(m, id)].some((nb) => r.depthOf.get(nb) === dist - 1)
      expect(hasParent).toBe(true)
    }
  })

  it('sorts loose ends by (yarnId, noteId) regardless of input order', () => {
    const r = focus(fixtureMembership(), [f, a], 1, [e, d])
    const keys = r.looseEnds.map((l) => `${l.yarnId}|${l.noteId}`)
    expect(keys).toEqual([...keys].sort())
    expect(r).toEqual(focus(fixtureMembership(), [a, f], 1, [d, e]))
  })

  it('canExpand is false at depth all even with loose ends', () => {
    const r = focus(fixtureMembership(), [a], 'all', [f])
    expect(r.looseEnds.length).toBeGreaterThan(0)
    expect(r.canExpand).toBe(false)
  })

  it('does not mutate the query or membership', () => {
    const m = fixtureMembership()
    const q: FocusQuery = { seeds: [a], depth: 1, include: [f] }
    const snapshot = JSON.stringify(q)
    computeFocus(m, q)
    expect(JSON.stringify(q)).toBe(snapshot)
    expect(sorted(m.yarnsByNote.get(c) ?? [])).toEqual(sorted([Y1, Y2]))
  })

  it('handles a long single thread and a long chain of yarns with correct distances', () => {
    const ids = Array.from({ length: 200 }, (_, i) => fixtureId('note', 1000 + i))
    const notes = ids.map((id) => makeNote({ id }))
    const thread = makeYarn(ids, { id: fixtureId('yarn', 500) })
    const m = buildMembership(stateFromRecords(makeBoard(), [...notes, thread]))
    const r = focus(m, [ids[0] as string], 1)
    expect(r.notes.size).toBe(200)
    expect([...r.depthOf.values()].filter((v) => v === 1)).toHaveLength(199)
    expect(r.canExpand).toBe(false)

    const chain = ids
      .slice(0, 100)
      .slice(1)
      .map((id, i) => makeYarn([ids[i] as string, id], { id: fixtureId('yarn', 600 + i) }))
    const m2 = buildMembership(stateFromRecords(makeBoard(), [...notes, ...chain]))
    const r2 = focus(m2, [ids[0] as string], 'all')
    expect(r2.notes.size).toBe(100)
    expect(r2.depthOf.get(ids[99] as string)).toBe(99)
    expect(r2.yarns.size).toBe(99)
    const r3 = focus(m2, [ids[0] as string], 3)
    expect(r3.notes.size).toBe(4)
    expect(r3.looseEnds).toEqual([{ yarnId: fixtureId('yarn', 603), noteId: ids[3] as string }])
  })
})
