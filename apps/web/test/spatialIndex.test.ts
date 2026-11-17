import { applyBatch, type BoardState, type Note, PMap } from '@papertie/core'
import { benchBoard } from '@papertie/tools/gen-board'
import { mulberry32 } from '@papertie/tools/rng'
import { boardFrames, createAttach, topologyOf } from '../src/canvas/attach'
import { noteBounds } from '../src/canvas/geometry'
import { SpatialIndex } from '../src/canvas/spatialIndex'
import { expandRect, type Rect, rectsIntersect } from '../src/canvas/types'
import { bezierBounds, restSagPoint, segmentBezier } from '../src/canvas/yarnGeometry'

const board = benchBoard(1000)
const T = '2026-11-06T00:00:00.000Z'
const measuredH = new Map<string, number>()
let k = 0
for (const id of board.notes.keys()) if (k++ % 3 === 0) measuredH.set(id, 400)

function randomRects(n: number, seed: number): Rect[] {
  const rng = mulberry32(seed)
  const out: Rect[] = []
  for (let i = 0; i < n; i++) {
    out.push({ x: rng() * 12000 - 1000, y: rng() * 10000 - 1000, w: rng() * 3000, h: rng() * 2500 })
  }
  return out
}

/** Every segment's rest bounds between its edge pins, at the displayed heights and tilt. */
function bruteSegments(s: BoardState, rotation = false): Array<{ key: string; bounds: Rect }> {
  const out: Array<{ key: string; bounds: Rect }> = []
  const topo = topologyOf(s)
  const attach = createAttach(
    topo,
    boardFrames(s.notes, { rotation, heightOf: (n) => Math.max(n.h, measuredH.get(n.id) ?? 0) }),
  )
  for (const refs of topo.byYarn.values()) {
    for (const ref of refs) {
      const e = attach.ends(ref)
      if (e === undefined) continue
      const sag = restSagPoint(e.a, e.b)
      const depth = sag.y - (e.a.y + e.b.y) / 2
      const bounds = expandRect(
        bezierBounds(segmentBezier(e.a, e.b, sag)),
        Math.max(8, 0.25 * depth),
      )
      out.push({ key: ref.key, bounds })
    }
  }
  return out
}

describe('SpatialIndex', () => {
  const index = new SpatialIndex()
  index.rebuild(board, measuredH)

  it('indexes every note and segment', () => {
    expect(index.size.notes).toBe(1000)
    expect(index.size.segments).toBe(bruteSegments(board).length)
  })

  it('notesIn matches brute force on the 1000 board for 50 random rects', () => {
    for (const r of randomRects(50, 7)) {
      const expected = [...board.notes.values()]
        .filter((n) => rectsIntersect(noteBounds(n, measuredH.get(n.id)), r))
        .map((n) => n.id)
        .sort()
      expect(index.notesIn(r).sort()).toEqual(expected)
    }
  })

  it('segmentsIn matches brute force over segment bounds', () => {
    const all = bruteSegments(board)
    for (const r of randomRects(50, 11)) {
      const expected = all
        .filter((s) => rectsIntersect(s.bounds, r))
        .map((s) => s.key)
        .sort()
      expect(
        index
          .segmentsIn(r)
          .map((s) => s.key)
          .sort(),
      ).toEqual(expected)
    }
  })

  it('segment refs carry their yarn, index and end notes', () => {
    const yarn = [...board.yarns.values()].find((y) => y.noteIds.length >= 3)
    expect(yarn).toBeDefined()
    if (!yarn) return
    const refs = index
      .segmentsIn({ x: -1e6, y: -1e6, w: 2e6, h: 2e6 })
      .filter((s) => s.yarnId === yarn.id)
      .sort((a, b) => a.index - b.index)
    expect(refs.map((r) => [r.index, r.aNoteId, r.bNoteId])).toEqual(
      yarn.noteIds.slice(1).map((b, i) => [i, yarn.noteIds[i], b]),
    )
  })

  it('updateNotes after a move drops the old area and finds the new one', () => {
    const idx = new SpatialIndex()
    idx.rebuild(board, measuredH)
    const yarn = [...board.yarns.values()][0]
    const id = yarn?.noteIds[0] as string
    const note = board.notes.get(id) as Note
    const oldRect = noteBounds(note, measuredH.get(id))
    const moved: Note = { ...note, x: note.x + 50_000, y: note.y + 40_000 }
    const next: BoardState = { ...board, notes: new Map(board.notes).set(id, moved) }
    idx.updateNotes(next, [id], measuredH)

    expect(idx.notesIn(oldRect)).not.toContain(id)
    expect(idx.notesIn(noteBounds(moved, measuredH.get(id)))).toContain(id)
    const near = idx.segmentsIn(noteBounds(moved, measuredH.get(id)))
    const touching = near.filter((s) => s.aNoteId === id || s.bNoteId === id)
    expect(touching.length).toBeGreaterThan(0)
    expect(touching.map((s) => s.yarnId)).toContain(yarn?.id)
    expect(idx.size).toEqual(index.size)

    // The old area holds exactly what the moved board has there (no stale segment bounds).
    const all = bruteSegments(next)
    for (const r of [oldRect, ...randomRects(20, 3)]) {
      const expected = all
        .filter((s) => rectsIntersect(s.bounds, r))
        .map((s) => s.key)
        .sort()
      expect(
        idx
          .segmentsIn(r)
          .map((s) => s.key)
          .sort(),
      ).toEqual(expected)
    }
  })

  it("re-tracks the moved note's neighbours' other threads, whose edge pins shift", () => {
    const idx = new SpatialIndex()
    idx.rebuild(board, measuredH)
    // A note on two or more yarns: moving one neighbour reorders the pins on its edges.
    const topo = topologyOf(board)
    const [hubId] = [...topo.byNote].find(([, ends]) => ends.length >= 3) ?? []
    if (hubId === undefined) throw new Error('no hub')
    const neighbour = topo.byNote.get(hubId)?.[0]?.other as string
    const n = board.notes.get(neighbour) as Note
    const moved: Note = { ...n, x: n.x - 3000, y: n.y + 2500 }
    const next: BoardState = { ...board, notes: new Map(board.notes).set(neighbour, moved) }
    idx.updateNotes(next, [neighbour], measuredH)
    const all = bruteSegments(next)
    const everything = { x: -1e7, y: -1e7, w: 2e7, h: 2e7 }
    const box = (r: Rect) => [r.x, r.y, r.w, r.h].map((v) => Math.round(v * 1e6) / 1e6)
    const got = new Map<string, number[]>()
    for (const r of all) got.set(r.key, box(r.bounds))
    for (const r of randomRects(30, 5).concat([everything])) {
      const expected = all
        .filter((s) => rectsIntersect(s.bounds, r))
        .map((s) => s.key)
        .sort()
      expect(
        idx
          .segmentsIn(r)
          .map((s) => s.key)
          .sort(),
      ).toEqual(expected)
    }
    expect(got.size).toBe(idx.size.segments)
  })

  it('indexes the tilted edge pins when rotation is on', () => {
    const idx = new SpatialIndex()
    idx.rebuild(board, measuredH, true)
    const all = bruteSegments(board, true)
    for (const r of randomRects(30, 13)) {
      const expected = all
        .filter((s) => rectsIntersect(s.bounds, r))
        .map((s) => s.key)
        .sort()
      expect(
        idx
          .segmentsIn(r)
          .map((s) => s.key)
          .sort(),
      ).toEqual(expected)
    }
  })

  it('updateNotes drops deleted notes and the yarns that are gone', () => {
    const idx = new SpatialIndex()
    idx.rebuild(board, measuredH)
    const yarn = [...board.yarns.values()][5]
    if (!yarn) throw new Error('board has yarns')
    const id = yarn.noteIds[0] as string
    const notes = new Map(board.notes)
    notes.delete(id)
    const yarns = new Map(board.yarns)
    yarns.delete(yarn.id)
    const next: BoardState = { ...board, notes, yarns }
    idx.updateNotes(next, [id, ...yarn.noteIds], measuredH)
    expect(idx.size.notes).toBe(999)
    expect(idx.size.segments).toBe(bruteSegments(next).length)
    const everything = { x: -1e6, y: -1e6, w: 2e6, h: 2e6 }
    expect(idx.notesIn(everything)).not.toContain(id)
    expect(idx.segmentsIn(everything).some((s) => s.yarnId === yarn.id)).toBe(false)
  })

  it('updateNotes reaches a note’s threads through the topology and walks no map of the board', () => {
    const idx = new SpatialIndex()
    idx.rebuild(board, measuredH)
    const topo = topologyOf(board)
    // A note on threads, and a long thread through it and its neighbours.
    const id = [...topo.byNote.keys()][10] as string
    const n = board.notes.get(id) as Note
    const next = applyBatch(board, [{ op: 'note.update', id, set: { x: n.x + 400 } }], { now: T })
    expect(topologyOf(next).yarnsOf.get(id)).toEqual(topo.yarnsOf.get(id))
    const proto = Object.getPrototypeOf(PMap.prototype) as Record<string | symbol, unknown>
    const names = ['entries', 'keys', 'values', 'forEach', Symbol.iterator] as const
    const was = names.map((k) => proto[k])
    const walked: number[] = []
    for (const [i, k] of names.entries()) {
      proto[k] = function (this: ReadonlyMap<unknown, unknown>, ...a: unknown[]) {
        walked.push(this.size)
        return (was[i] as (...a: unknown[]) => unknown).apply(this, a)
      }
    }
    try {
      idx.updateNotes(next, [id], measuredH)
    } finally {
      for (const [i, k] of names.entries()) proto[k] = was[i]
    }
    expect(walked.filter((size) => size > 64)).toEqual([])
    const fresh = new SpatialIndex()
    fresh.rebuild(next, measuredH)
    const all = { x: -1e6, y: -1e6, w: 2e6, h: 2e6 }
    const keys = (i: SpatialIndex) =>
      i
        .segmentsIn(all)
        .map((r) => r.key)
        .sort()
    expect(keys(idx)).toEqual(keys(fresh))
    expect(idx.size).toEqual(fresh.size)
  })
})
