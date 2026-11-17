import type { Note } from '@papertie/core'
import { EDGE_PIN } from '../src/canvas/attach'
import {
  buildDrawList,
  coveredTest,
  PIN_STUB_WORLD,
  paperBounds,
  paperContains,
  pinStubs,
  polylineIntersectsRect,
  segmentOccluders,
  strandOverPaper,
  tiltReach,
  topPaperAt,
  underOwnPaper,
} from '../src/canvas/layering'
import type { SegmentRef } from '../src/canvas/spatialIndex'
import type { Point, Rect } from '../src/canvas/types'
import { polylineLength } from '../src/canvas/yarnGeometry'

const note = (id: string, x: number, y: number, w: number, h: number, z: number): Note => ({
  type: 'note',
  id,
  x,
  y,
  w,
  h,
  z,
  paper: 'cream',
  style: 'rustic',
  text: '',
  image: null,
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z',
})

const rectOf = (n: Note): Rect => ({ x: n.x, y: n.y, w: n.w, h: n.h })

describe('polylineIntersectsRect', () => {
  const r: Rect = { x: 0, y: 0, w: 10, h: 10 }

  it('polylineIntersectsRect: crossing, fully inside, outside, touching a corner', () => {
    expect(
      polylineIntersectsRect(
        [
          { x: -5, y: 5 },
          { x: 15, y: 5 },
        ],
        r,
      ),
    ).toBe(true)
    expect(
      polylineIntersectsRect(
        [
          { x: 2, y: 2 },
          { x: 8, y: 7 },
        ],
        r,
      ),
    ).toBe(true)
    expect(
      polylineIntersectsRect(
        [
          { x: -5, y: -5 },
          { x: -5, y: 15 },
          { x: 15, y: 15 },
        ],
        r,
      ),
    ).toBe(false)
    // A diagonal that only grazes the corner (10, 0).
    expect(
      polylineIntersectsRect(
        [
          { x: 5, y: -5 },
          { x: 15, y: 5 },
        ],
        r,
      ),
    ).toBe(true)
    expect(
      polylineIntersectsRect(
        [
          { x: 5.01, y: -5 },
          { x: 15.01, y: 5 },
        ],
        r,
      ),
    ).toBe(false)
  })

  it('handles a single point, no points and non-finite input', () => {
    expect(polylineIntersectsRect([{ x: 3, y: 3 }], r)).toBe(true)
    expect(polylineIntersectsRect([{ x: 30, y: 3 }], r)).toBe(false)
    expect(polylineIntersectsRect([], r)).toBe(false)
    expect(
      polylineIntersectsRect(
        [
          { x: Number.NaN, y: 5 },
          { x: 15, y: Number.POSITIVE_INFINITY },
        ],
        r,
      ),
    ).toBe(false)
  })
})

describe('segmentOccluders', () => {
  const a = note('a', 0, 0, 100, 100, 3)
  const b = note('b', 500, 0, 100, 100, 5)
  const pts: Point[] = [
    { x: 50, y: 50 },
    { x: 300, y: 120 },
    { x: 550, y: 50 },
  ]

  it('segmentOccluders: higher crossing note yes; z equal to the higher pin no; endpoint notes never', () => {
    const higher = note('higher', 250, 60, 100, 100, 6)
    const equal = note('equal', 250, 60, 100, 100, 5)
    const lower = note('lower', 250, 60, 100, 100, 1)
    const away = note('away', 250, 400, 100, 100, 9)
    const candidates = [a, b, higher, equal, lower, away]
    expect(segmentOccluders({ aNote: a, bNote: b, pts }, candidates, rectOf)).toEqual(['higher'])
  })

  it('never lists an endpoint note, even when it is higher and crossed', () => {
    const top = note('b', 500, 0, 100, 100, 99)
    expect(segmentOccluders({ aNote: a, bNote: top, pts }, [a, top], rectOf)).toEqual([])
  })
})

describe('buildDrawList', () => {
  it('buildDrawList orders erases between levels', () => {
    expect(
      buildDrawList(
        [
          { key: 'a', level: 1, occluders: [] },
          { key: 'b', level: 5, occluders: ['n6'] },
          { key: 'c', level: 9, occluders: [] },
        ],
        () => 6,
      ),
    ).toEqual([
      { kind: 'segment', key: 'a' },
      { kind: 'segment', key: 'b' },
      { kind: 'erase', noteId: 'n6' },
      { kind: 'segment', key: 'c' },
    ])
  })

  it('an erase precedes segments at the same level', () => {
    expect(
      buildDrawList(
        [
          { key: 'low', level: 2, occluders: ['n6'] },
          { key: 'same', level: 6, occluders: [] },
        ],
        () => 6,
      ),
    ).toEqual([
      { kind: 'segment', key: 'low' },
      { kind: 'erase', noteId: 'n6' },
      { kind: 'segment', key: 'same' },
    ])
  })

  it('sorts by level, lists each occluder once, ends with erases above every level', () => {
    const z: Record<string, number> = { n4: 4, n8: 8, n20: 20 }
    expect(
      buildDrawList(
        [
          { key: 'c', level: 7, occluders: ['n8', 'n20'] },
          { key: 'a', level: 3, occluders: ['n4', 'n8'] },
          { key: 'b', level: 3, occluders: ['n20'] },
        ],
        (id) => z[id] ?? 0,
      ),
    ).toEqual([
      { kind: 'segment', key: 'a' },
      { kind: 'segment', key: 'b' },
      { kind: 'erase', noteId: 'n4' },
      { kind: 'segment', key: 'c' },
      { kind: 'erase', noteId: 'n8' },
      { kind: 'erase', noteId: 'n20' },
    ])
  })

  it('keeps input order for equal levels and equal occluder z (deterministic)', () => {
    const segs = [
      { key: 'y', level: 1, occluders: ['q'] },
      { key: 'x', level: 1, occluders: ['p'] },
    ]
    const list = buildDrawList(segs, () => 2)
    expect(list).toEqual([
      { kind: 'segment', key: 'y' },
      { kind: 'segment', key: 'x' },
      { kind: 'erase', noteId: 'q' },
      { kind: 'erase', noteId: 'p' },
    ])
    expect(buildDrawList(segs, () => 2)).toEqual(list)
  })
})

describe('pinStubs', () => {
  it('pinStubs are 24 world px each end, past the edge pin inset; short segments split in half', () => {
    expect(PIN_STUB_WORLD).toBe(24)
    expect(PIN_STUB_WORLD).toBeGreaterThan(EDGE_PIN.inset + 6)
    const long: Point[] = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 40 },
    ]
    const s = pinStubs(long)
    expect(polylineLength(s.start)).toBeCloseTo(24, 9)
    expect(polylineLength(s.end)).toBeCloseTo(24, 9)
    expect(s.start[0]).toEqual({ x: 0, y: 0 })
    expect(s.end[s.end.length - 1]).toEqual({ x: 60, y: 40 })
    expect(s.end[0]).toEqual({ x: 60, y: 16 })

    const short = pinStubs([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ])
    expect(short.start).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])
    expect(short.end).toEqual([
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ])
  })

  it('gives empty stubs for no points', () => {
    expect(pinStubs([])).toEqual({ start: [], end: [] })
  })
})

describe('paper shape', () => {
  const shape = { rect: { x: 0, y: 0, w: 100, h: 200 }, pivot: { x: 50, y: 14 }, deg: 1 }

  it('contains points of the rect turned about the pin', () => {
    expect(paperContains(shape, { x: 50, y: 100 })).toBe(true)
    // +1 deg (clockwise on screen) about the pin moves the bottom corners about 3.2 px left.
    expect(paperContains({ ...shape, deg: 0 }, { x: 99, y: 199 })).toBe(true)
    expect(paperContains(shape, { x: 99, y: 199 })).toBe(false)
    expect(paperContains(shape, { x: -2, y: 199 })).toBe(true)
    expect(paperContains(shape, { x: 120, y: 100 })).toBe(false)
  })

  it('bounds the turned rect', () => {
    const b = paperBounds(shape)
    expect(b.x).toBeLessThan(0)
    expect(b.w).toBeGreaterThan(100)
    expect(paperBounds({ ...shape, deg: 0 })).toEqual(shape.rect)
  })
})

describe('coveredTest', () => {
  const a = note('a', 0, 0, 100, 100, 1)
  const b = note('b', 500, 0, 100, 100, 2)
  const high = note('high', 250, 0, 100, 100, 7)
  const other = note('other', 250, 300, 100, 100, 3)
  const notes = new Map([a, b, high, other].map((n) => [n.id, n]))
  const ref: SegmentRef = { key: 'k', yarnId: 'y', index: 0, aNoteId: 'a', bNoteId: 'b' }
  const pins: Record<string, Point> = { a: { x: 50, y: 14 }, b: { x: 550, y: 14 } }
  // The segment runs between edge pins: a's right edge and b's left edge.
  const ends = { a: { x: 86, y: 50 }, b: { x: 514, y: 50 } }
  const ctx = {
    notes,
    rectOf,
    occludersOf: () => ['high'],
    pinOf: (id: string) => pins[id],
    endsOf: () => ends,
  }

  it('coveredTest: over never; over-fix only inside that segment’s occluders; under inside any note except near its edge pins', () => {
    const inHigh = { x: 300, y: 50 }
    const inOther = { x: 300, y: 350 }
    const inA = { x: 30, y: 80 }
    const nearPinA = { x: 86 - PIN_STUB_WORLD + 1, y: 50 }
    const open = { x: 200, y: 50 }

    const over = coveredTest('over', ctx)
    for (const p of [inHigh, inOther, inA, nearPinA, open]) expect(over(ref, p)).toBe(false)

    const fix = coveredTest('over-fix', ctx)
    expect(fix(ref, inHigh)).toBe(true)
    expect(fix(ref, inOther)).toBe(false)
    expect(fix(ref, inA)).toBe(false)
    expect(fix(ref, open)).toBe(false)

    const under = coveredTest('under', ctx)
    expect(under(ref, inHigh)).toBe(true)
    expect(under(ref, inOther)).toBe(true)
    expect(under(ref, inA)).toBe(true)
    expect(under(ref, nearPinA)).toBe(false)
    expect(under(ref, { x: 514, y: 50 + PIN_STUB_WORLD - 1 })).toBe(false)
    // The hanging pin no longer holds the thread: paper there covers it.
    expect(under(ref, { x: 50 + PIN_STUB_WORLD - 1, y: 14 })).toBe(true)
    expect(under(ref, open)).toBe(false)
  })

  it('under reads candidate notes from notesAt when given', () => {
    const under = coveredTest('under', { ...ctx, notesAt: () => [] })
    expect(under(ref, { x: 300, y: 50 })).toBe(false)
  })

  it('follows the paper rotation when angleOf is given', () => {
    // Inside high's unrotated rect near its bottom-right corner, outside it turned 1 deg about (300, 14).
    const corner = { x: 349, y: 99 }
    const flat = coveredTest('over-fix', ctx)
    const turned = coveredTest('over-fix', {
      ...ctx,
      pinOf: (id: string) => pins[id] ?? { x: 300, y: 14 },
      angleOf: () => 1,
    })
    expect(flat(ref, corner)).toBe(true)
    expect(turned(ref, corner)).toBe(false)
  })
})

describe('topPaperAt (noteAt on turned paper)', () => {
  // A 5° print, 300 × 200 at the origin, turned about its pin.
  const print = note('print', 0, 0, 300, 200, 1)
  const shape = { rect: { x: 0, y: 0, w: 300, h: 200 }, pivot: { x: 150, y: 14 }, deg: 5 }
  const turn = (p: Point): Point => {
    const a = (5 * Math.PI) / 180
    const dx = p.x - 150
    const dy = p.y - 14
    return {
      x: 150 + dx * Math.cos(a) - dy * Math.sin(a),
      y: 14 + dx * Math.sin(a) + dy * Math.cos(a),
    }
  }
  const inAxisRect = (p: Point) => p.x >= 0 && p.x <= 300 && p.y >= 0 && p.y <= 200

  it('hits a corner of the turned paper outside the unturned rect', () => {
    const corner = turn({ x: 4, y: 196 })
    expect(inAxisRect(corner)).toBe(false)
    expect(topPaperAt(corner, [print], () => shape)?.id).toBe('print')
  })

  it('misses a point inside the unturned rect that the turned paper left', () => {
    const p = { x: 298, y: 190 }
    expect(inAxisRect(p)).toBe(true)
    expect(topPaperAt(p, [print], () => shape)).toBeUndefined()
  })

  it('picks the topmost by z, then id, and ignores non-finite points', () => {
    const under = note('a', 0, 0, 300, 200, 0)
    const twin = note('b', 0, 0, 300, 200, 1)
    const flat = () => ({ ...shape, deg: 0 })
    expect(topPaperAt({ x: 100, y: 100 }, [under, print], flat)?.id).toBe('print')
    expect(topPaperAt({ x: 100, y: 100 }, [print, twin], flat)?.id).toBe('print')
    expect(topPaperAt({ x: Number.NaN, y: 1 }, [print], flat)).toBeUndefined()
  })

  it('tiltReach bounds how far a turned paper leaves its rect', () => {
    expect(tiltReach(0)).toBe(0)
    const r = tiltReach(5, 300, 200)
    for (const c of [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 200 },
      { x: 0, y: 200 },
    ]) {
      const t = turn(c)
      expect(Math.hypot(t.x - c.x, t.y - c.y)).toBeLessThanOrEqual(r)
    }
    expect(Number.isFinite(tiltReach(5))).toBe(true)
    expect(tiltReach(Number.NaN)).toBe(0)
  })
})

describe('a strand over its own paper, from the hanging pin', () => {
  const paper = { rect: { x: 0, y: 0, w: 200, h: 170 }, pivot: { x: 100, y: 14 }, deg: 0 }
  const line = (a: Point, b: Point, n = 40): Point[] =>
    Array.from({ length: n + 1 }, (_, k) => ({
      x: a.x + ((b.x - a.x) * k) / n,
      y: a.y + ((b.y - a.y) * k) / n,
    }))
  const close = (p: Point | undefined, q: Point) => {
    expect(p?.x).toBeCloseTo(q.x, 6)
    expect(p?.y).toBeCloseTo(q.y, 6)
  }

  it('shows the stub at the pin and the strand past the paper; the rest lies beneath it', () => {
    const runs = strandOverPaper(line({ x: 100, y: 14 }, { x: 100, y: 600 }), { start: paper })
    expect(runs).toHaveLength(2)
    close(runs[0]?.[0], { x: 100, y: 14 })
    close(runs[0]?.at(-1), { x: 100, y: 14 + PIN_STUB_WORLD })
    close(runs[1]?.[0], { x: 100, y: 170 })
    close(runs[1]?.at(-1), { x: 100, y: 600 })
  })

  it('a strand leaving the paper within the stub shows whole', () => {
    const pts = line({ x: 100, y: 14 }, { x: 100, y: -500 })
    expect(strandOverPaper(pts, { start: paper })).toEqual([pts])
  })

  it('works from the far end and on a turned paper, and with no own paper changes nothing', () => {
    const pts = line({ x: 100, y: 600 }, { x: 100, y: 14 })
    const runs = strandOverPaper(pts, { end: paper })
    close(runs[0]?.at(-1), { x: 100, y: 170 })
    close(runs[1]?.[0], { x: 100, y: 14 + PIN_STUB_WORLD })
    const turned = { ...paper, deg: 90 }
    // Turned 90° about the pin, the paper reaches left from it: a strand going left is beneath.
    const left = strandOverPaper(line({ x: 100, y: 14 }, { x: -400, y: 14 }), { start: turned })
    expect(left).toHaveLength(2)
    close(left[1]?.[0], { x: 100 - 156, y: 14 })
    expect(strandOverPaper(pts, {})).toEqual([pts])
  })

  it('a point under the paper past the stub is covered, at the pin it is not', () => {
    expect(underOwnPaper({ x: 100, y: 120 }, { x: 100, y: 14 }, paper)).toBe(true)
    expect(underOwnPaper({ x: 100, y: 30 }, { x: 100, y: 14 }, paper)).toBe(false)
    expect(underOwnPaper({ x: 100, y: 300 }, { x: 100, y: 14 }, paper)).toBe(false)
  })
})
