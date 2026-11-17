import type { Note } from '@papertie/core'
import { LIMITS } from '@papertie/core'
import fc from 'fast-check'
import { isTag, noteBounds, pinOffsetX, pinPosition, TAG_MAX_W } from '../src/canvas/geometry'
import type { Point } from '../src/canvas/types'
import {
  bezierBounds,
  bezierTangent,
  distanceToPolyline,
  evalBezier,
  flattenBezier,
  polylineLength,
  restSagPoint,
  SAG,
  segmentBezier,
  segmentKey,
  sliceByLength,
  truncatePolyline,
} from '../src/canvas/yarnGeometry'
import { noteVisual } from '../src/lib/seed'

const M = LIMITS.maxCoord
const coord = (limit: number) => fc.double({ min: -limit, max: limit, noNaN: true })
const pt = (limit: number) => fc.record({ x: coord(limit), y: coord(limit) })
const finitePt = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y)

describe('sag and Bezier', () => {
  it('the curve passes through the sag point at t=0.5', () => {
    fc.assert(
      fc.property(pt(1e4), pt(1e4), pt(1e4), (a, b, s) => {
        const p = evalBezier(segmentBezier(a, b, s), 0.5)
        expect(Math.abs(p.x - s.x)).toBeLessThan(1e-9)
        expect(Math.abs(p.y - s.y)).toBeLessThan(1e-9)
      }),
    )
  })

  it('the curve starts and ends at the pins', () => {
    const c = segmentBezier({ x: 1, y: 2 }, { x: 30, y: -4 }, { x: 10, y: 50 })
    expect(evalBezier(c, 0)).toEqual({ x: 1, y: 2 })
    expect(evalBezier(c, 1)).toEqual({ x: 30, y: -4 })
  })

  it('bezierTangent matches a central difference of evalBezier', () => {
    const c = segmentBezier({ x: 1, y: 2 }, { x: 300, y: -40 }, { x: 140, y: 90 })
    const h = 1e-6
    for (const t of [0.1, 0.37, 0.5, 0.9]) {
      const p = evalBezier(c, t + h)
      const q = evalBezier(c, t - h)
      const d = bezierTangent(c, t)
      expect(d.x).toBeCloseTo((p.x - q.x) / (2 * h), 3)
      expect(d.y).toBeCloseTo((p.y - q.y) / (2 * h), 3)
    }
    const flat = segmentBezier({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 })
    expect(bezierTangent(flat, 0.5)).toEqual({ x: 0, y: 0 })
  })

  it('rest sag is 8% of length, capped at 140', () => {
    expect(restSagPoint({ x: 0, y: 0 }, { x: 1000, y: 0 })).toEqual({ x: 500, y: 80 })
    expect(restSagPoint({ x: 0, y: 0 }, { x: 5000, y: 0 }).y).toBe(140)
    expect(SAG).toEqual({ ratio: 0.08, max: 140 })
  })

  it('rest sag of coincident pins is the pin itself', () => {
    expect(restSagPoint({ x: 7, y: 9 }, { x: 7, y: 9 })).toEqual({ x: 7, y: 9 })
  })

  it('rest sag stays finite across the whole coordinate range', () => {
    const s = restSagPoint({ x: -M, y: -M }, { x: M, y: M })
    expect(finitePt(s)).toBe(true)
    expect(s.y).toBe(140)
  })
})

describe('flattenBezier', () => {
  it('zero-length segments stay finite', () => {
    const a = { x: 100, y: 200 }
    const pts = flattenBezier(segmentBezier(a, a, restSagPoint(a, a)), 0.25)
    expect(pts.length).toBeGreaterThanOrEqual(2)
    expect(pts.every(finitePt)).toBe(true)
    const q = { x: 103, y: 204 }
    expect(distanceToPolyline(q, [a, a])).toBe(5)
  })

  it('coincident pins with a dangling sag point still flatten to finite points', () => {
    const a = { x: 0, y: 0 }
    const pts = flattenBezier(segmentBezier(a, a, { x: 0, y: 140 }), 0.25)
    expect(pts.length).toBeGreaterThan(2)
    expect(pts.every(finitePt)).toBe(true)
    expect(pts[0]).toEqual(a)
    expect(pts[pts.length - 1]).toEqual(a)
  })

  it('always keeps the endpoints and at least two points', () => {
    fc.assert(
      fc.property(pt(M), pt(M), fc.double({ min: -1, max: 10, noNaN: true }), (a, b, tol) => {
        const pts = flattenBezier(segmentBezier(a, b, restSagPoint(a, b)), tol)
        expect(pts.length).toBeGreaterThanOrEqual(2)
        expect(pts.length).toBeLessThanOrEqual(4097)
        expect(pts.every(finitePt)).toBe(true)
        expect(pts[0]).toEqual(a)
        expect(pts[pts.length - 1]).toEqual(b)
      }),
    )
  })

  it('terminates with a bounded point count at +-maxCoord with tiny tolerance', () => {
    for (const tol of [0, -1, Number.NaN, 1e-12, 0.25]) {
      const a = { x: -M, y: -M }
      const b = { x: M, y: M }
      const pts = flattenBezier(segmentBezier(a, b, { x: 0, y: M }), tol)
      expect(pts.length).toBeGreaterThanOrEqual(2)
      expect(pts.length).toBeLessThanOrEqual(4097)
      expect(pts.every(finitePt)).toBe(true)
    }
  })

  it('flattening stays within tolerance', () => {
    fc.assert(
      fc.property(
        pt(2000),
        pt(2000),
        pt(2000),
        fc.double({ min: 0.1, max: 2, noNaN: true }),
        (a, b, s, tol) => {
          const c = segmentBezier(a, b, s)
          const poly = flattenBezier(c, tol)
          for (let i = 0; i <= 200; i++) {
            const d = distanceToPolyline(evalBezier(c, i / 200), poly)
            expect(d).toBeLessThanOrEqual(tol + 1e-9)
          }
        },
      ),
      { numRuns: 60 },
    )
  })
})

describe('polyline helpers', () => {
  it('distance to a horizontal polyline is exact', () => {
    const poly = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ]
    expect(distanceToPolyline({ x: 5, y: 3 }, poly)).toBe(3)
    expect(distanceToPolyline({ x: 15, y: -4 }, poly)).toBe(4)
    expect(distanceToPolyline({ x: -3, y: 4 }, poly)).toBe(5)
    expect(distanceToPolyline({ x: 23, y: 4 }, poly)).toBe(5)
  })

  it('distance edge cases are well defined', () => {
    expect(distanceToPolyline({ x: 1, y: 1 }, [{ x: 4, y: 5 }])).toBe(5)
    expect(distanceToPolyline({ x: 1, y: 1 }, [])).toBe(Number.POSITIVE_INFINITY)
    const far = [
      { x: -M, y: -M },
      { x: M, y: M },
    ]
    expect(distanceToPolyline({ x: 0, y: 0 }, far)).toBeCloseTo(0, 5)
    expect(Number.isFinite(distanceToPolyline({ x: M, y: -M }, far))).toBe(true)
  })

  it('length sums segments and is finite at the extremes', () => {
    expect(polylineLength([])).toBe(0)
    expect(polylineLength([{ x: 1, y: 1 }])).toBe(0)
    expect(
      polylineLength([
        { x: 0, y: 0 },
        { x: 3, y: 4 },
        { x: 3, y: 10 },
      ]),
    ).toBe(11)
    const pts = flattenBezier(
      segmentBezier({ x: -M, y: -M }, { x: M, y: M }, { x: -M, y: M }),
      0.25,
    )
    expect(Number.isFinite(polylineLength(pts))).toBe(true)
  })

  it('truncatePolyline keeps the requested fraction of length', () => {
    const poly = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]
    expect(truncatePolyline(poly, 0)).toEqual([{ x: 0, y: 0 }])
    expect(polylineLength(truncatePolyline(poly, 1))).toBe(20)
    expect(truncatePolyline(poly, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])
    const t = truncatePolyline(poly, 0.75)
    expect(polylineLength(t)).toBeCloseTo(15, 9)
    expect(t[t.length - 1]).toEqual({ x: 10, y: 5 })
  })

  it('truncatePolyline is total on degenerate input', () => {
    expect(truncatePolyline([], 0.5)).toEqual([])
    const p = { x: 2, y: 3 }
    expect(truncatePolyline([p, p], 0.5)).toEqual([p])
    expect(truncatePolyline([p, p], 1)).toEqual([p, p])
    const poly = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]
    expect(truncatePolyline(poly, Number.NaN)).toEqual([{ x: 0, y: 0 }])
    expect(polylineLength(truncatePolyline(poly, 7))).toBe(10)
    expect(truncatePolyline(poly, -3)).toEqual([{ x: 0, y: 0 }])
  })

  it('truncatePolyline length matches the fraction for random curves', () => {
    fc.assert(
      fc.property(pt(M), pt(M), fc.double({ min: 0, max: 1, noNaN: true }), (a, b, f) => {
        const poly = flattenBezier(segmentBezier(a, b, restSagPoint(a, b)), 0.25)
        const total = polylineLength(poly)
        const got = polylineLength(truncatePolyline(poly, f))
        expect(Math.abs(got - total * f)).toBeLessThanOrEqual(1e-6 * Math.max(1, total))
      }),
    )
  })

  it('sliceByLength returns the sub-polyline between two arc lengths', () => {
    const poly = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]
    expect(sliceByLength(poly, 5, 15)).toEqual([
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
    ])
    expect(sliceByLength(poly, 0, 20)).toEqual(poly)
    expect(sliceByLength(poly, 4, 4)).toEqual([{ x: 4, y: 0 }])
    expect(sliceByLength(poly, 15, 5)).toEqual(sliceByLength(poly, 5, 15))
    expect(sliceByLength(poly, -5, 100)).toEqual(poly)
  })

  it('sliceByLength is total on degenerate input', () => {
    expect(sliceByLength([], 0, 5)).toEqual([])
    const p = { x: 1, y: 1 }
    expect(sliceByLength([p], 0, 5)).toEqual([p])
    expect(sliceByLength([p, p], 0, 5)).toEqual([p])
    const poly = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]
    expect(sliceByLength(poly, Number.NaN, Number.NaN).every(finitePt)).toBe(true)
    expect(sliceByLength(poly, 2, Number.POSITIVE_INFINITY)).toEqual([
      { x: 2, y: 0 },
      { x: 10, y: 0 },
    ])
  })

  it('sliceByLength length equals to - from', () => {
    fc.assert(
      fc.property(
        pt(M),
        pt(M),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b, u, v) => {
          const poly = flattenBezier(segmentBezier(a, b, restSagPoint(a, b)), 0.25)
          const total = polylineLength(poly)
          const lo = Math.min(u, v) * total
          const hi = Math.max(u, v) * total
          const s = sliceByLength(poly, lo, hi)
          expect(s.length).toBeGreaterThanOrEqual(1)
          expect(s.every(finitePt)).toBe(true)
          expect(Math.abs(polylineLength(s) - (hi - lo))).toBeLessThanOrEqual(
            1e-6 * Math.max(1, total),
          )
        },
      ),
    )
  })
})

describe('bezierBounds', () => {
  it('is the bbox of the control hull', () => {
    const c = segmentBezier({ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 15, y: 30 })
    const b = bezierBounds(c)
    for (const p of [c.p0, c.p1, c.p2, c.p3]) {
      expect(p.x).toBeGreaterThanOrEqual(b.x)
      expect(p.x).toBeLessThanOrEqual(b.x + b.w)
      expect(p.y).toBeGreaterThanOrEqual(b.y)
      expect(p.y).toBeLessThanOrEqual(b.y + b.h)
    }
    for (let i = 0; i <= 50; i++) {
      const p = evalBezier(c, i / 50)
      expect(p.y).toBeLessThanOrEqual(b.y + b.h + 1e-9)
    }
  })

  it('is a zero-size rect for coincident control points', () => {
    const a = { x: 5, y: 6 }
    expect(bezierBounds(segmentBezier(a, a, a))).toEqual({ x: 5, y: 6, w: 0, h: 0 })
  })

  it('stays finite at +-maxCoord', () => {
    const b = bezierBounds(
      segmentBezier(
        { x: -M, y: -M },
        { x: M, y: M },
        restSagPoint({ x: -M, y: -M }, { x: M, y: M }),
      ),
    )
    expect(Object.values(b).every(Number.isFinite)).toBe(true)
    expect(b.w).toBeGreaterThanOrEqual(2 * M)
  })
})

describe('threads', () => {
  it('segmentKey joins yarn and both note ids', () => {
    expect(segmentKey('yarn_1', 'note_a', 'note_b')).toBe('yarn_1|note_a|note_b')
  })
})

describe('pins and bounds', () => {
  const note = { id: 'note_abc', x: 100, y: 200, w: 240, h: 120 }

  it('pinPosition is top-centre plus the seeded offset', () => {
    const v = noteVisual(note.id)
    expect(pinPosition(note)).toEqual({ x: 100 + 120 + v.pinOffsetX, y: 214 })
  })

  it('a tag (w <= 120) hangs from its exact top centre', () => {
    expect(isTag({ w: 120 })).toBe(true)
    expect(isTag({ w: 121 })).toBe(false)
    expect(TAG_MAX_W).toBe(120)
    const tag = { ...note, w: 96 }
    expect(pinOffsetX(tag)).toBe(0)
    expect(pinPosition(tag)).toEqual({ x: 100 + 48, y: 214 })
    expect(pinOffsetX(note)).toBe(noteVisual(note.id).pinOffsetX)
  })

  it('pinPosition ignores note height', () => {
    expect(pinPosition({ ...note, h: 900 } as Pick<Note, 'id' | 'x' | 'y' | 'w'>)).toEqual(
      pinPosition(note),
    )
  })

  it('noteBounds uses the larger of h and the measured height', () => {
    expect(noteBounds(note)).toEqual({ x: 100, y: 200, w: 240, h: 120 })
    expect(noteBounds(note, 300)).toEqual({ x: 100, y: 200, w: 240, h: 300 })
    expect(noteBounds(note, 50)).toEqual({ x: 100, y: 200, w: 240, h: 120 })
    expect(noteBounds(note, Number.NaN).h).toBe(120)
  })

  it('stacked notes get identical pins and finite geometry', () => {
    const a = pinPosition(note)
    const pts = flattenBezier(segmentBezier(a, a, restSagPoint(a, a)), 0.25)
    expect(pts.every(finitePt)).toBe(true)
  })

  it('pins at the coordinate limits stay finite', () => {
    const p = pinPosition({ id: 'note_edge', x: M, y: -M, w: 640 })
    expect(finitePt(p)).toBe(true)
  })
})
