import { emptyBoardState, LIMITS, type Note, stateFromRecords, type Yarn } from '@papertie/core'
import { boardFrames, createAttach, topologyOf } from '../src/canvas/attach'
import { type Camera, worldToScreen } from '../src/canvas/Camera'
import { SELECTED_SCALE, strandWidthPx } from '../src/canvas/drawYarn'
import { pinPosition } from '../src/canvas/geometry'
import {
  type HitContext,
  hitTest,
  YARN_HIT_TOLERANCE_PX,
  yarnHitTolerancePx,
} from '../src/canvas/hitTest'
import { type SegmentRef, SpatialIndex } from '../src/canvas/spatialIndex'
import type { Point } from '../src/canvas/types'
import { flattenBezier, restSagPoint, segmentBezier } from '../src/canvas/yarnGeometry'
import { noteVisual } from '../src/lib/seed'

const NOW = '2026-10-27T00:00:00.000Z'
const id = (prefix: string, n: number) => `${prefix}_01JBHT00${String(n).padStart(18, '0')}`

function note(n: number, x: number, y: number, z = n): Note {
  return {
    type: 'note',
    id: id('note', n),
    x,
    y,
    w: 240,
    h: 170,
    z,
    paper: 'cream',
    style: 'rustic',
    text: '',
    image: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function yarn(n: number, notes: readonly Note[]): Yarn {
  return {
    type: 'yarn',
    id: id('yarn', n),
    noteIds: notes.map((x) => x.id),
    color: 'apricot',
    label: '',
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/** Note `n` placed so its pin lands exactly at x = `pinX` (y follows from `y`). */
function noteWithPinAt(n: number, pinX: number, y: number, z = n): Note {
  const off = noteVisual(id('note', n)).pinOffsetX
  return note(n, pinX - 120 - off, y, z)
}

function setup(records: Array<Note | Yarn>, zoom: number, extra: Partial<HitContext> = {}) {
  const s = stateFromRecords(emptyBoardState(id('board', 1), 'hit', NOW).board, records)
  const index = new SpatialIndex()
  index.rebuild(s, new Map())
  const camera: Camera = { x: -200, y: -200, zoom }
  const pinOf = (noteId: string) => {
    const n = s.notes.get(noteId)
    return n && pinPosition(n)
  }
  const attach = createAttach(topologyOf(s), boardFrames(s.notes, { rotation: false }))
  const endsOf = (ref: SegmentRef) => attach.ends(ref)
  const curveOf = (ref: SegmentRef): Point[] => {
    const e = endsOf(ref)
    if (e === undefined) return []
    return flattenBezier(segmentBezier(e.a, e.b, restSagPoint(e.a, e.b)), 0.25 / zoom)
  }
  const ctx: HitContext = { camera, index, notes: s.notes, pinOf, endsOf, curveOf, ...extra }
  /** Hit-test a world point, through the screen. */
  const at = (w: Point) => hitTest(worldToScreen(camera, w), ctx)
  return { s, ctx, at, pinOf, endsOf, curveOf }
}

const A = note(1, 0, 0)
const B = note(2, 1000, 0)
const AB = yarn(1, [A, B])

/** World point `px` screen px off the polyline's lowest segment, along its outward normal. */
function offCurve(pts: readonly Point[], px: number, zoom: number): Point {
  let k = 1
  for (let i = 1; i < pts.length; i++) {
    const mid = ((pts[i - 1] as Point).y + (pts[i] as Point).y) / 2
    const best = ((pts[k - 1] as Point).y + (pts[k] as Point).y) / 2
    if (mid > best) k = i
  }
  const p = pts[k - 1] as Point
  const q = pts[k] as Point
  const len = Math.hypot(q.x - p.x, q.y - p.y)
  const n = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len }
  const d = px / zoom
  return { x: (p.x + q.x) / 2 + n.x * d, y: (p.y + q.y) / 2 + n.y * d }
}

describe.each([0.5, 1, 2])('at zoom %s', (zoom) => {
  it('a point 9.5 px from a pin hits the pin; 10.5 px does not', () => {
    const { at, pinOf } = setup([A, B, AB], zoom)
    const pin = pinOf(A.id) as Point
    expect(at({ x: pin.x, y: pin.y - 9.5 / zoom })).toEqual({ kind: 'pin', noteId: A.id })
    expect(at({ x: pin.x, y: pin.y - 10.5 / zoom })).toEqual({ kind: 'none' })
  })

  it('just inside the tolerance from the yarn along its normal hits it; just outside does not', () => {
    const { at, curveOf, s } = setup([A, B, AB], zoom)
    const ref = { key: '', yarnId: AB.id, index: 0, aNoteId: A.id, bNoteId: B.id }
    const pts = curveOf(ref)
    const tol = yarnHitTolerancePx(zoom)
    expect(s.yarns.size).toBe(1)
    for (const side of [1, -1]) {
      expect(at(offCurve(pts, side * (tol - 0.1), zoom))).toEqual({
        kind: 'yarn',
        yarnId: AB.id,
        segIndex: 0,
      })
    }
    expect(at(offCurve(pts, tol + 0.1, zoom))).toEqual({ kind: 'none' })
  })
})

describe('yarnHitTolerancePx', () => {
  it('covers the drawn cord plus a 3 px margin, and never falls below 6 px', () => {
    for (const zoom of [0.02, 0.1, 0.35, 0.5, 1, 1.37, 2, 3, 4]) {
      const t = yarnHitTolerancePx(zoom)
      expect(t).toBeGreaterThanOrEqual(YARN_HIT_TOLERANCE_PX)
      expect(t).toBeGreaterThanOrEqual(strandWidthPx(zoom) / 2 + 3)
    }
    expect(yarnHitTolerancePx(0.5)).toBe(YARN_HIT_TOLERANCE_PX)
    // The finer cord keeps a comfortable target: 6.6 px at zoom 1 (the 10 px cord had 7).
    expect(yarnHitTolerancePx(1)).toBeCloseTo(6.6)
    expect(yarnHitTolerancePx(4)).toBeCloseTo(11.5)
  })

  it('covers a selected strand, drawn 1.35x wider, the same way', () => {
    for (const zoom of [0.02, 0.35, 1, 2, 4]) {
      const t = yarnHitTolerancePx(zoom, true)
      expect(t).toBeGreaterThanOrEqual(YARN_HIT_TOLERANCE_PX)
      expect(t).toBeGreaterThanOrEqual((strandWidthPx(zoom) * SELECTED_SCALE) / 2 + 3)
      expect(t).toBeGreaterThanOrEqual(yarnHitTolerancePx(zoom))
    }
    expect(yarnHitTolerancePx(2, true)).toBeCloseTo(12.72)
  })

  it('is finite for bad zoom values', () => {
    for (const z of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Number.isFinite(yarnHitTolerancePx(z))).toBe(true)
      expect(Number.isFinite(yarnHitTolerancePx(z, true))).toBe(true)
    }
  })
})

describe.each([1, 2, 4])('a selected yarn at zoom %s', (zoom) => {
  it('takes a press over its wider drawn edge; an unselected one does not', () => {
    const tol = yarnHitTolerancePx(zoom)
    const wide = yarnHitTolerancePx(zoom, true)
    const off = (tol + wide) / 2
    const plain = setup([A, B, AB], zoom)
    const ref = { key: '', yarnId: AB.id, index: 0, aNoteId: A.id, bNoteId: B.id }
    const p = offCurve(plain.curveOf(ref), off, zoom)
    expect(plain.at(p)).toEqual({ kind: 'none' })
    const selected = setup([A, B, AB], zoom, { selectedYarnId: AB.id })
    expect(selected.at(p)).toEqual({ kind: 'yarn', yarnId: AB.id, segIndex: 0 })
    expect(selected.at(offCurve(plain.curveOf(ref), wide + 0.1, zoom))).toEqual({ kind: 'none' })
  })
})

describe.each([0.5, 1, 2])('edge pins at zoom %s', (zoom) => {
  it('a point 9.5 px from an edge pin hits it, naming its yarn end; 10.5 px is no pin', () => {
    const { at, endsOf } = setup([A, B, AB], zoom)
    const ref = { key: '', yarnId: AB.id, index: 0, aNoteId: A.id, bNoteId: B.id }
    const e = endsOf(ref) as { a: Point; b: Point }
    expect(at({ x: e.b.x, y: e.b.y - 9.5 / zoom })).toEqual({
      kind: 'pin',
      noteId: B.id,
      edge: { yarnId: AB.id, segIndex: 0, end: 'b' },
    })
    // Nor is it the cord, which leaves the pin elsewhere: its tolerance (6, 6.6 and 10.2 px at
    // zoom 0.5, 1 and 2) does not reach the point.
    expect(at({ x: e.b.x, y: e.b.y - 10.5 / zoom })).toEqual({ kind: 'none' })
  })
})

it('in lite LOD edge pins are not drawn, so they take no hit; hanging pins still do', () => {
  const zoom = 0.3
  const { at, ctx, endsOf, pinOf } = setup([A, B, AB], zoom)
  const ref = { key: '', yarnId: AB.id, index: 0, aNoteId: A.id, bNoteId: B.id }
  const e = endsOf(ref) as { a: Point; b: Point }
  // Off the thread (it leaves along the edge normal), inside the pin radius.
  const near = { x: e.b.x, y: e.b.y - 8 / zoom }
  expect(at(near)).toMatchObject({ kind: 'pin', noteId: B.id, edge: { end: 'b' } })
  const lite = { ...ctx, lite: true }
  expect(hitTest(worldToScreen(ctx.camera, near), lite)).toEqual({ kind: 'none' })
  const top = pinOf(A.id) as Point
  expect(hitTest(worldToScreen(ctx.camera, top), lite)).toEqual({ kind: 'pin', noteId: A.id })
})

it('an edge pin beats the yarn it holds; the hanging pin holds no yarn', () => {
  const { at, pinOf, endsOf, curveOf } = setup([A, B, AB], 1)
  const ref = { key: '', yarnId: AB.id, index: 0, aNoteId: A.id, bNoteId: B.id }
  const e = endsOf(ref) as { a: Point; b: Point }
  const p = { x: e.a.x + 4, y: e.a.y + 1 }
  const d = Math.min(...curveOf(ref).map((q) => Math.hypot(q.x - p.x, q.y - p.y)))
  expect(d).toBeLessThan(6)
  expect(at(p)).toEqual({
    kind: 'pin',
    noteId: A.id,
    edge: { yarnId: AB.id, segIndex: 0, end: 'a' },
  })
  const top = pinOf(A.id) as Point
  expect(at(top)).toEqual({ kind: 'pin', noteId: A.id })
  const d0 = Math.min(...curveOf(ref).map((q) => Math.hypot(q.x - top.x, q.y - top.y)))
  expect(d0).toBeGreaterThan(50)
})

it('an edge pin is found while its spring swings outside the index (liveSegments)', () => {
  const { ctx, endsOf } = setup([A, B, AB], 1)
  const ref = { key: 'k', yarnId: AB.id, index: 0, aNoteId: A.id, bNoteId: B.id }
  const moved = { a: { x: 5000, y: 5000 }, b: { x: 6000, y: 5000 } }
  const live = { ...ctx, endsOf: () => moved, liveSegments: () => [ref] }
  expect(endsOf(ref)).not.toEqual(moved)
  expect(hitTest(worldToScreen(ctx.camera, { x: 6000, y: 5003 }), live)).toMatchObject({
    kind: 'pin',
    noteId: B.id,
  })
})

it('overlapping pins resolve to the higher note, then the nearer', () => {
  const low = noteWithPinAt(3, 500, 400, 7)
  const high = noteWithPinAt(4, 506, 400, 9)
  const { at } = setup([low, high], 1)
  const pinY = 400 + 14
  // Nearer the lower note's pin, but both are in range: the higher note wins.
  expect(at({ x: 501, y: pinY })).toEqual({ kind: 'pin', noteId: high.id })
  const same = { ...high, z: 7 }
  const tie = setup([low, same], 1)
  expect(tie.at({ x: 501, y: pinY })).toEqual({ kind: 'pin', noteId: low.id })
  expect(tie.at({ x: 505, y: pinY })).toEqual({ kind: 'pin', noteId: same.id })
})

it('isCovered hides the yarn at that point', () => {
  const covered: Point[] = []
  const { at, curveOf } = setup([A, B, AB], 1, {
    isCovered: (_ref, w) => {
      covered.push(w)
      return true
    },
  })
  const ref = { key: '', yarnId: AB.id, index: 0, aNoteId: A.id, bNoteId: B.id }
  const p = offCurve(curveOf(ref), 2, 1)
  expect(at(p)).toEqual({ kind: 'none' })
  expect(covered.length).toBeGreaterThan(0)
  expect(covered[0]?.x).toBeCloseTo(p.x, 6)
})

it('on equal distance, the yarn drawn later wins: higher level, then later id', () => {
  // C and D sit above A and B. Threads on one edge get their own pins, so the coinciding curves
  // are given: every segment is drawn along the same one.
  const C = note(5, A.x, A.y, 30)
  const D = note(6, B.x, B.y, 31)
  const first = yarn(2, [A, B])
  const second = yarn(3, [A, B])
  const high = yarn(1, [C, D])
  const a = pinPosition(A)
  const b = pinPosition(B)
  const curve = flattenBezier(segmentBezier(a, b, restSagPoint(a, b)), 0.25)
  const shared = { curveOf: () => curve, liveSegments: undefined }
  const p = offCurve(curve, 3, 1)
  const refsAt = (records: Array<Note | Yarn>) => {
    const t = setup(records, 1)
    const refs = [...topologyOf(t.s).byYarn.values()].flat()
    return setup(records, 1, { ...shared, liveSegments: () => refs })
  }
  expect(refsAt([A, B, first, second]).at(p)).toEqual({
    kind: 'yarn',
    yarnId: second.id,
    segIndex: 0,
  })
  expect(refsAt([A, B, C, D, first, second, high]).at(p)).toEqual({
    kind: 'yarn',
    yarnId: high.id,
    segIndex: 0,
  })
})

it('tests live segments that sag outside their rest bounds', () => {
  const { ctx, endsOf } = setup([A, B, AB], 1)
  const ref0 = { key: 'k', yarnId: AB.id, index: 0, aNoteId: A.id, bNoteId: B.id }
  const { a, b } = endsOf(ref0) as { a: Point; b: Point }
  const deep = { x: (a.x + b.x) / 2, y: a.y + 400 }
  const ref = { key: 'k', yarnId: AB.id, index: 0, aNoteId: A.id, bNoteId: B.id }
  const swung = { ...ctx, curveOf: () => flattenBezier(segmentBezier(a, b, deep), 0.25) }
  const screen = worldToScreen(ctx.camera, { x: deep.x, y: deep.y + 3 })
  expect(hitTest(screen, swung)).toEqual({ kind: 'none' })
  expect(hitTest(screen, { ...swung, liveSegments: () => [ref] })).toEqual({
    kind: 'yarn',
    yarnId: AB.id,
    segIndex: 0,
  })
})

it('zero-length segments and NaN points never throw', () => {
  const E = noteWithPinAt(7, 3000, 0)
  const F = noteWithPinAt(8, 3000, 0)
  const EF = yarn(4, [E, F])
  const far1 = note(9, -LIMITS.maxCoord, -LIMITS.maxCoord)
  const far2 = note(10, LIMITS.maxCoord - 240, LIMITS.maxCoord - 170)
  const long = yarn(5, [far1, far2])
  const { at, pinOf, ctx } = setup([E, F, EF, far1, far2, long], 1)
  const pin = pinOf(E.id) as Point
  expect(Math.abs((pinOf(F.id) as Point).x - pin.x)).toBeLessThan(1e-9)
  expect(at({ x: pin.x, y: pin.y + 3 }).kind).toBe('pin')
  expect(at({ x: pin.x + 12, y: pin.y })).toEqual({ kind: 'none' })
  expect(at({ x: pin.x, y: pin.y + 15 })).toEqual({ kind: 'none' })
  for (const p of [
    { x: Number.NaN, y: 0 },
    { x: 0, y: Number.NaN },
    { x: Number.POSITIVE_INFINITY, y: 0 },
    { x: 0, y: Number.NEGATIVE_INFINITY },
  ]) {
    expect(hitTest(p, ctx)).toEqual({ kind: 'none' })
  }
  for (const zoom of [0, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    expect(hitTest({ x: 10, y: 10 }, { ...ctx, camera: { x: 0, y: 0, zoom } })).toEqual({
      kind: 'none',
    })
  }
  const broken = {
    ...ctx,
    pinOf: () => ({ x: Number.NaN, y: Number.NaN }),
    curveOf: () => [
      { x: Number.NaN, y: 1 },
      { x: 2, y: Number.NaN },
    ],
  }
  expect(hitTest(worldToScreen(ctx.camera, pin), broken)).toEqual({ kind: 'none' })
  expect(hitTest(worldToScreen(ctx.camera, pin), { ...ctx, curveOf: () => [] }).kind).toBe('pin')
  // Along the very long thread, far from both pins.
  const mid = { x: 0, y: 0 }
  expect(() => at(mid)).not.toThrow()
})

describe('shared pins', () => {
  const C = note(3, 2000, 0)
  const pinned = (y: Yarn, pins: Record<string, string>): Yarn => ({ ...y, pins })
  const AB2 = pinned(yarn(1, [A, B]), { [B.id]: 'p1' })
  const BC = pinned(yarn(2, [B, C]), { [B.id]: 'p1', [C.id]: 'hanging' })

  it('a pin two threads share hits once; the selected thread names it when it is one of them', () => {
    const plain = setup([A, B, C, AB2, BC], 1)
    const ref = { key: '', yarnId: AB2.id, index: 0, aNoteId: A.id, bNoteId: B.id }
    const p = (plain.endsOf(ref) as { a: Point; b: Point }).b
    expect(plain.at(p)).toMatchObject({
      kind: 'pin',
      noteId: B.id,
      edge: { end: expect.any(String) },
    })
    for (const selected of [AB2, BC]) {
      const s = setup([A, B, C, AB2, BC], 1, { selectedYarnId: selected.id })
      expect(s.at(p)).toEqual({
        kind: 'pin',
        noteId: B.id,
        edge:
          selected === AB2
            ? { yarnId: AB2.id, segIndex: 0, end: 'b' }
            : { yarnId: BC.id, segIndex: 0, end: 'a' },
      })
    }
  })

  it('an end tied at the hanging pin hits as the hanging pin, unless its thread is selected', () => {
    const top = pinPosition(C)
    expect(setup([A, B, C, AB2, BC], 1).at(top)).toEqual({ kind: 'pin', noteId: C.id })
    expect(setup([A, B, C, AB2, BC], 1, { selectedYarnId: BC.id }).at(top)).toEqual({
      kind: 'pin',
      noteId: C.id,
      edge: { yarnId: BC.id, segIndex: 0, end: 'b' },
    })
  })
})
