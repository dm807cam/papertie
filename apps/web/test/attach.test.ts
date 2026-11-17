import { emptyBoardState, LIMITS, type Note, stateFromRecords, type Yarn } from '@papertie/core'
import fc from 'fast-check'
import {
  type AttachFrame,
  anchorKey,
  attachPoints,
  boardFrames,
  createAttach,
  EDGE_PIN,
  facingEdge,
  segmentRefs,
  topologyOf,
  withNeighbours,
} from '../src/canvas/attach'
import { pinPosition } from '../src/canvas/geometry'
import type { Point } from '../src/canvas/types'

const NOW = '2026-10-27T00:00:00.000Z'
const id = (prefix: string, n: number) => `${prefix}_01JBAT00${String(n).padStart(18, '0')}`

function note(n: number, x: number, y: number, o: Partial<Note> = {}): Note {
  return {
    type: 'note',
    id: id('note', n),
    x,
    y,
    w: 240,
    h: 170,
    z: n,
    paper: 'cream',
    style: 'rustic',
    text: '',
    image: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
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

const board = (records: Array<Note | Yarn>) =>
  stateFromRecords(emptyBoardState(id('board', 1), 'attach', NOW).board, records)

const frame = (x: number, y: number, w: number, h: number, deg = 0): AttachFrame => ({
  rect: { x, y, w, h },
  pivot: { x: x + w / 2, y: y + 14 },
  deg,
})

const finite = (p: Point | undefined) =>
  p !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y)

describe('facingEdge', () => {
  const f = frame(0, 0, 240, 170)
  const c = { x: 120, y: 85 }

  it('picks the edge the ray toward the neighbour leaves through, in 8 directions', () => {
    const at = (dx: number, dy: number) => facingEdge(f, { x: c.x + dx, y: c.y + dy })
    expect(at(1000, 0)).toBe('right')
    expect(at(-1000, 0)).toBe('left')
    expect(at(0, 1000)).toBe('bottom')
    expect(at(0, -1000)).toBe('top')
    // The diagonals compare against the note's aspect (240 x 170): a 45° ray leaves the side
    // that is nearer, here the top or bottom edge.
    expect(at(1000, 1000)).toBe('bottom')
    expect(at(-1000, -1000)).toBe('top')
    expect(at(1000, -600)).toBe('right')
    expect(at(-1000, 600)).toBe('left')
  })

  it('compares in the note frame: a tilt turns the direction', () => {
    // Just below the corner diagonal (slope 170/240 = 0.708): right when flat, bottom when the
    // note is turned 5° anticlockwise, which lifts its frame's x axis.
    const toward = { x: c.x + 1000, y: c.y + 690 }
    expect(facingEdge(f, toward)).toBe('right')
    expect(facingEdge({ ...f, deg: -5 }, toward)).toBe('bottom')
  })

  it('is total for degenerate input', () => {
    expect(facingEdge(f, c)).toBe('right')
    expect(facingEdge(f, { x: Number.NaN, y: 0 })).toBe('right')
    expect(facingEdge(frame(0, 0, 0, 0), { x: 5, y: 5 })).toMatch(/right|bottom/)
  })
})

describe('attachPoints', () => {
  const f = frame(0, 0, 240, 170)

  it('puts a single end where the ray meets the edge, inset into the paper', () => {
    const m = attachPoints(f, [{ id: 'e', toward: { x: 1120, y: 85 + 250 } }])
    const p = m.get('e') as Point
    expect(p.x).toBeCloseTo(240 - EDGE_PIN.inset)
    // The ray from (120, 85) with slope 0.25 meets x = 240 at y = 115.
    expect(p.y).toBeCloseTo(115)
  })

  it('keeps ends off the corners', () => {
    const m = attachPoints(f, [{ id: 'e', toward: { x: 1120, y: 85 + 690 } }])
    const p = m.get('e') as Point
    expect(p.y).toBeCloseTo(170 - EDGE_PIN.corner)
  })

  it('spreads ends on one edge in the order of their neighbours, at least a gap apart', () => {
    const ends = [
      { id: 'low', toward: { x: 2000, y: 100 } },
      { id: 'high', toward: { x: 2000, y: 70 } },
      { id: 'mid', toward: { x: 2000, y: 85 } },
    ]
    const m = attachPoints(f, ends)
    const ys = ['high', 'mid', 'low'].map((k) => (m.get(k) as Point).y) as [number, number, number]
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(EDGE_PIN.gap - 1e-9)
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(EDGE_PIN.gap - 1e-9)
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(EDGE_PIN.corner - 1e-9)
      expect(y).toBeLessThanOrEqual(170 - EDGE_PIN.corner + 1e-9)
    }
    for (const k of ['high', 'mid', 'low']) expect((m.get(k) as Point).x).toBeCloseTo(240 - 14)
  })

  it('evenly fills an edge too short for the gap, and never stacks two ends', () => {
    const ends = Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, toward: { x: 9000, y: i } }))
    const m = attachPoints(f, ends)
    const ys = ends.map((e) => (m.get(e.id) as Point).y)
    for (let i = 1; i < ys.length; i++) expect(ys[i] as number).toBeGreaterThan(ys[i - 1] as number)
    expect(ys[0]).toBeCloseTo(EDGE_PIN.corner)
    expect(ys.at(-1)).toBeCloseTo(170 - EDGE_PIN.corner)
  })

  it('keeps top-edge ends clear of the hanging pin', () => {
    const m = attachPoints(f, [
      { id: 'up', toward: { x: 120, y: -900 } },
      { id: 'up2', toward: { x: 125, y: -900 } },
    ])
    for (const k of ['up', 'up2']) {
      const p = m.get(k) as Point
      expect(p.y).toBeCloseTo(EDGE_PIN.inset)
      expect(Math.abs(p.x - f.pivot.x)).toBeGreaterThanOrEqual(EDGE_PIN.topGap - 1e-9)
    }
    // Ordered left to right: the one further left keeps the left side.
    expect((m.get('up') as Point).x).toBeLessThan((m.get('up2') as Point).x)
  })

  it('turns with the note about its pin', () => {
    const toward = { x: 1120, y: 85 }
    const flat = attachPoints(f, [{ id: 'e', toward }]).get('e') as Point
    const deg = 4
    const turned = attachPoints({ ...f, deg }, [{ id: 'e', toward }]).get('e') as Point
    const a = (deg * Math.PI) / 180
    const dx = flat.x - f.pivot.x
    const dy = flat.y - f.pivot.y
    // Turning moves the ray's exit a little along the edge; the end stays on the turned edge.
    const local = {
      x: (turned.x - f.pivot.x) * Math.cos(a) + (turned.y - f.pivot.y) * Math.sin(a),
      y: -(turned.x - f.pivot.x) * Math.sin(a) + (turned.y - f.pivot.y) * Math.cos(a),
    }
    expect(local.x + f.pivot.x).toBeCloseTo(240 - EDGE_PIN.inset)
    expect(Math.hypot(turned.x - flat.x, turned.y - flat.y)).toBeGreaterThan(0)
    expect(Math.hypot(dx, dy)).toBeGreaterThan(0)
  })

  it('stays finite for stacked notes, huge distances and ±maxCoord', () => {
    const m = LIMITS.maxCoord
    const big = frame(m - 240, m - 170, 240, 170)
    for (const [fr, toward] of [
      [f, { x: 120, y: 85 }],
      [f, { x: 1e9, y: -1e9 }],
      [big, { x: -m, y: -m }],
      [frame(-m, -m, 240, 170), { x: m, y: m }],
      [frame(0, 0, 120, 4000), { x: 60, y: 2000 }],
    ] as const) {
      const p = attachPoints(fr, [
        { id: 'x', toward },
        { id: 'y', toward },
      ])
      expect(finite(p.get('x'))).toBe(true)
      expect(finite(p.get('y'))).toBe(true)
    }
  })
})

describe('topology and createAttach', () => {
  // A hub with neighbours to its right (two threads), left and below.
  const hub = note(1, 1000, 1000)
  const right1 = note(2, 1600, 900)
  const right2 = note(3, 1600, 1150)
  const left = note(4, 300, 1000)
  const below = note(5, 1000, 1600)
  const tag = note(6, 1700, 1600, { w: 120, h: 290, style: 'smooth' })
  const y1 = yarn(1, [left, hub, right1])
  const y2 = yarn(2, [hub, right2])
  const y3 = yarn(3, [hub, below, tag])
  const s = board([hub, right1, right2, left, below, tag, y1, y2, y3])
  const topo = topologyOf(s)
  const frames = boardFrames(s.notes, { rotation: false })
  const attach = createAttach(topo, frames)

  it('lists each yarn segment and each note end once', () => {
    expect(topo.byYarn.get(y1.id)?.map((r) => [r.aNoteId, r.bNoteId])).toEqual([
      [left.id, hub.id],
      [hub.id, right1.id],
    ])
    expect(topo.byNote.get(hub.id)).toHaveLength(4)
    expect(topo.segments).toBe(5)
    expect(topologyOf(s)).toBe(topo)
  })

  it('skips missing notes like the drawn thread does', () => {
    const refs = segmentRefs(yarn(9, [left, note(99, 0, 0), hub]), (nid) => s.notes.has(nid))
    expect(refs.map((r) => [r.aNoteId, r.bNoteId, r.index])).toEqual([[left.id, hub.id, 0]])
  })

  it('attaches each end on the facing edge, never at the top pin', () => {
    const pin = pinPosition(hub)
    const [toLeft, toRight] = topo.byYarn.get(y1.id) ?? []
    if (!toLeft || !toRight) throw new Error('no segments')
    const l = attach.ends(toLeft)
    const r = attach.ends(toRight)
    expect(l?.a.x).toBeCloseTo(left.x + left.w - EDGE_PIN.inset)
    expect(l?.b.x).toBeCloseTo(hub.x + EDGE_PIN.inset)
    expect(r?.a.x).toBeCloseTo(hub.x + hub.w - EDGE_PIN.inset)
    expect(r?.b.x).toBeCloseTo(right1.x + EDGE_PIN.inset)
    const down = topo.byYarn.get(y3.id)?.[0]
    if (!down) throw new Error('no segment')
    const d = attach.ends(down)
    expect(d?.a.y).toBeCloseTo(hub.y + hub.h - EDGE_PIN.inset)
    expect(d?.b.y).toBeCloseTo(below.y + EDGE_PIN.inset)
    for (const p of [l?.b, r?.a, d?.a]) {
      expect(Math.hypot((p as Point).x - pin.x, (p as Point).y - pin.y)).toBeGreaterThan(20)
    }
  })

  it('gives two threads on one edge distinct pins, in their neighbours order', () => {
    const toR1 = topo.byYarn.get(y1.id)?.[1]
    const toR2 = topo.byYarn.get(y2.id)?.[0]
    if (!toR1 || !toR2) throw new Error('no segments')
    const a1 = attach.point(toR1, 'a') as Point
    const a2 = attach.point(toR2, 'a') as Point
    expect(a1.x).toBeCloseTo(a2.x)
    expect(a2.y - a1.y).toBeGreaterThanOrEqual(EDGE_PIN.gap - 1e-9)
  })

  it('gives a tag edge pins too', () => {
    const toTag = topo.byYarn.get(y3.id)?.[1]
    if (!toTag) throw new Error('no segment')
    const b = attach.point(toTag, 'b') as Point
    expect(b.x).toBeCloseTo(tag.x + EDGE_PIN.inset)
    expect(b.y).toBeGreaterThan(tag.y + EDGE_PIN.corner - 1e-9)
    expect(b.y).toBeLessThan(tag.y + tag.h - EDGE_PIN.corner + 1e-9)
  })

  it('follows a drag: frames through an override move the dragged note and its neighbours ends', () => {
    const moved = boardFrames(s.notes, {
      rotation: false,
      effective: (n) => (n.id === right1.id ? { ...n, y: n.y + 400 } : n),
    })
    const live = createAttach(topo, moved)
    const toR1 = topo.byYarn.get(y1.id)?.[1]
    const toR2 = topo.byYarn.get(y2.id)?.[0]
    if (!toR1 || !toR2) throw new Error('no segments')
    expect((live.point(toR1, 'b') as Point).y).toBeGreaterThan(
      (attach.point(toR1, 'b') as Point).y + 250,
    )
    // right1 now sits below right2, so the hub's two right-edge pins swap order.
    expect((live.point(toR1, 'a') as Point).y).toBeGreaterThan((live.point(toR2, 'a') as Point).y)
  })

  it('uses the displayed height for the bottom edge and the rotation pref for the tilt', () => {
    const tall = boardFrames(s.notes, { rotation: false, heightOf: (n) => n.h + 100 })
    const down = topo.byYarn.get(y3.id)?.[0]
    if (!down) throw new Error('no segment')
    expect(createAttach(topo, tall).point(down, 'a')?.y).toBeCloseTo(
      hub.y + hub.h + 100 - EDGE_PIN.inset,
    )
    const tilted = createAttach(topo, boardFrames(s.notes, { rotation: true }))
    expect(tilted.point(down, 'a')).not.toEqual(attach.point(down, 'a'))
  })

  it('previews where a new thread would attach on a note', () => {
    const p = attach.preview(right2.id, left.id) as Point
    expect(p.x).toBeCloseTo(right2.x + EDGE_PIN.inset)
    expect(attach.preview('note_missing', left.id)).toBeUndefined()
  })

  it('finds the notes sharing a thread', () => {
    expect([...withNeighbours(topo, [right1.id])].sort()).toEqual([hub.id, right1.id].sort())
    expect(withNeighbours(topo, [hub.id]).size).toBe(5)
  })

  it('returns undefined for gone notes', () => {
    const ref = topo.byYarn.get(y2.id)?.[0]
    if (!ref) throw new Error('no segment')
    const gone = createAttach(topo, (nid) => (nid === right2.id ? undefined : frames(nid)))
    expect(gone.ends(ref)).toBeUndefined()
  })
})

describe('shared pins', () => {
  // B in the middle; A to its left, C and D to its right.
  const A = note(1, 300, 1000)
  const B = note(2, 1000, 1000)
  const C = note(3, 1600, 900)
  const D = note(4, 1600, 1150)
  const withPins = (y: Yarn, pins: Record<string, string>): Yarn => ({ ...y, pins })
  const refOf = (s: ReturnType<typeof board>, yarnId: string, seg = 0) => {
    const ref = topologyOf(s).byYarn.get(yarnId)?.[seg]
    if (ref === undefined) throw new Error('no segment')
    return ref
  }
  const attachOf = (s: ReturnType<typeof board>, rotation = false) =>
    createAttach(topologyOf(s), boardFrames(s.notes, { rotation }))

  it('ties every end with one key on a note at one pin, where the first thread put it', () => {
    const yAB = yarn(1, [A, B])
    const yBC = yarn(2, [B, C])
    const alone = attachOf(board([A, B, C, yAB]))
    const before = alone.point(refOf(board([A, B, C, yAB]), yAB.id), 'b') as Point
    const s = board([A, B, C, withPins(yAB, { [B.id]: 'p1' }), withPins(yBC, { [B.id]: 'p1' })])
    const at = attachOf(s)
    const ab = at.point(refOf(s, yAB.id), 'b') as Point
    const bc = at.point(refOf(s, yBC.id), 'a') as Point
    expect(bc).toEqual(ab)
    // The pin stays on B's left edge, facing A (the older thread), not moved to face C.
    expect(ab.x).toBeCloseTo(before.x)
    expect(ab.y).toBeCloseTo(before.y)
    expect(at.sharedPin(refOf(s, yAB.id), 'b')).toBe(at.sharedPin(refOf(s, yBC.id), 'a'))
    expect(typeof at.sharedPin(refOf(s, yAB.id), 'b')).toBe('string')
    // A's end has its own edge pin.
    expect(at.sharedPin(refOf(s, yAB.id), 'a')).toBeUndefined()
  })

  it('keeps one key on different notes apart', () => {
    const y = withPins(yarn(1, [A, B]), { [A.id]: 'p1', [B.id]: 'p1' })
    const s = board([A, B, y])
    const at = attachOf(s)
    const ref = refOf(s, y.id)
    expect(at.sharedPin(ref, 'a')).not.toBe(at.sharedPin(ref, 'b'))
    expect(at.point(ref, 'a')).not.toEqual(at.point(ref, 'b'))
  })

  it("ties a 'hanging' end at the note's own pin, turned or not", () => {
    const y = withPins(yarn(1, [A, B]), { [B.id]: 'hanging' })
    const s = board([A, B, y])
    for (const rotation of [false, true]) {
      const at = attachOf(s, rotation)
      expect(at.point(refOf(s, y.id), 'b')).toEqual(pinPosition(B))
      expect(at.sharedPin(refOf(s, y.id), 'b')).toBeNull()
    }
  })

  it('a middle note with a key ties both of its segment ends at that pin', () => {
    const y = withPins(yarn(1, [A, B, C]), { [B.id]: 'p1' })
    const s = board([A, B, C, y])
    const at = attachOf(s)
    expect(at.point(refOf(s, y.id, 0), 'b')).toEqual(at.point(refOf(s, y.id, 1), 'a'))
  })

  it('a shared pin takes one place on its edge: other ends spread around it as around one', () => {
    const yBC = yarn(1, [B, C])
    const yBD = yarn(2, [B, D])
    const yBC2 = { ...yarn(3, [B, C]), color: 'indigo' as const }
    const shared = board([
      B,
      C,
      D,
      withPins(yBC, { [B.id]: 'p1' }),
      withPins(yBC2, { [B.id]: 'p1' }),
      yBD,
    ])
    const two = board([B, C, D, yBC, yBD])
    const s1 = attachOf(shared)
    const s2 = attachOf(two)
    expect(s1.point(refOf(shared, yBD.id), 'a')).toEqual(s2.point(refOf(two, yBD.id), 'a'))
    expect(s1.point(refOf(shared, yBC2.id), 'a')).toEqual(s2.point(refOf(two, yBC.id), 'a'))
  })

  it('previews a new thread where it lands: an edge pin of its own beside the shared one', () => {
    const shared = [
      A,
      B,
      C,
      withPins(yarn(1, [A, B]), { [B.id]: 'p1' }),
      withPins(yarn(2, [B, C]), { [B.id]: 'p1' }),
    ]
    const p = attachOf(board(shared)).preview(B.id, A.id) as Point
    const yNew = yarn(3, [A, B])
    const after = board([...shared, yNew])
    const at = attachOf(after)
    expect(p).toEqual(at.point(refOf(after, yNew.id), 'b'))
    expect(p).not.toEqual(at.point(refOf(after, id('yarn', 1)), 'b'))
  })
})

describe('a pin keeps its place when threads join it', () => {
  const A = note(1, 300, 1000)
  const B = note(2, 1000, 1000)
  const C = note(3, 1600, 1000)
  const D = note(4, 1600, 1500)
  const E = note(5, 300, 1500)
  const at = (records: Array<Note | Yarn>) => {
    const s = board(records)
    const attach = createAttach(topologyOf(s), boardFrames(s.notes, { rotation: false }))
    const point = (y: Yarn, seg: number, end: 'a' | 'b') => {
      const ref = topologyOf(s).byYarn.get(y.id)?.[seg]
      if (ref === undefined) throw new Error('no segment')
      return attach.point(ref, end) as Point
    }
    return { attach, point }
  }
  const pinned = (y: Yarn, pins: Record<string, string>): Yarn => ({ ...y, pins })

  it('names the end it is placed by', () => {
    expect(anchorKey(id('yarn', 7), 'a')).toBe(`y${id('yarn', 7).slice(5)}n`)
    expect(anchorKey(id('yarn', 7), 'b')).toMatch(/^y[0-9A-Z]{26}p$/)
  })

  it("sharing a pin of a thread through the note keeps the pressed pin; the thread's other end there joins it", () => {
    const through = yarn(1, [A, B, C])
    const before = at([A, B, C, D, through])
    const pressed = before.point(through, 1, 'a')
    const key = anchorKey(through.id, 'a')
    const joined = yarn(2, [D, B])
    const after = at([
      A,
      B,
      C,
      D,
      pinned(through, { [B.id]: key }),
      pinned(joined, { [B.id]: key }),
    ])
    expect(after.point(through, 1, 'a')).toEqual(pressed)
    expect(after.point(joined, 0, 'b')).toEqual(pressed)
    expect(after.point(through, 0, 'b')).toEqual(pressed)
  })

  it('a thread through the note with both neighbours on one side: the pressed pin stays put', () => {
    // A and E both left of B: the through-thread's two pins share B's left edge.
    const through = yarn(1, [A, B, E])
    const before = at([A, B, E, C, through])
    for (const [seg, end] of [
      [0, 'b'],
      [1, 'a'],
    ] as const) {
      const pressed = before.point(through, seg, end)
      const key = anchorKey(through.id, end)
      const joined = yarn(2, [C, B])
      const after = at([
        A,
        B,
        E,
        C,
        pinned(through, { [B.id]: key }),
        pinned(joined, { [B.id]: key }),
      ])
      expect(after.point(through, seg, end)).toEqual(pressed)
      expect(after.point(joined, 0, 'b')).toEqual(pressed)
    }
  })

  it('sharing the second of two threads tied exactly alike swaps nothing', () => {
    const y1 = yarn(1, [A, B])
    const y2 = { ...yarn(2, [A, B]), color: 'indigo' as const }
    const before = at([A, B, C, y1, y2])
    const p1 = before.point(y1, 0, 'b')
    const p2 = before.point(y2, 0, 'b')
    expect(p1).not.toEqual(p2)
    const key = anchorKey(y2.id, 'b')
    const joined = yarn(3, [C, B])
    const after = at([A, B, C, y1, pinned(y2, { [B.id]: key }), pinned(joined, { [B.id]: key })])
    expect(after.point(y1, 0, 'b')).toEqual(p1)
    expect(after.point(y2, 0, 'b')).toEqual(p2)
    expect(after.point(joined, 0, 'b')).toEqual(p2)
  })

  it('an older thread wound onto a newer thread’s pin does not move it', () => {
    const older = yarn(1, [A, E])
    const newer = yarn(2, [D, B])
    const before = at([A, B, D, E, older, newer])
    const pin = before.point(newer, 0, 'b')
    const key = anchorKey(newer.id, 'b')
    const wound = pinned({ ...older, noteIds: [A.id, E.id, B.id] }, { [B.id]: key })
    const after = at([A, B, D, E, wound, pinned(newer, { [B.id]: key })])
    expect(after.point(newer, 0, 'b')).toEqual(pin)
    expect(after.point(wound, 1, 'b')).toEqual(pin)
  })

  it('property: an end that others join stays where it was, as do the other ends on its edge', () => {
    const arbBoard = fc.record({
      spots: fc.uniqueArray(
        fc.tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: 0, max: 7 })),
        {
          minLength: 4,
          maxLength: 7,
          selector: ([x, y]) => `${x},${y}`,
        },
      ),
      threads: fc.array(fc.array(fc.nat(), { minLength: 2, maxLength: 4 }), {
        minLength: 1,
        maxLength: 4,
      }),
      pick: fc.nat(),
      from: fc.array(fc.nat(), { minLength: 1, maxLength: 3 }),
    })
    fc.assert(
      fc.property(arbBoard, ({ spots, threads, pick, from }) => {
        const notes = spots.map(([x, y], k) => note(k + 1, x * 400, y * 300))
        const yarns: Yarn[] = []
        for (const [k, picks] of threads.entries()) {
          const ids = [...new Set(picks.map((p) => (notes[p % notes.length] as Note).id))]
          if (ids.length >= 2) yarns.push({ ...yarn(k + 1, []), noteIds: ids })
        }
        fc.pre(yarns.length > 0)
        const s0 = board([...notes, ...yarns])
        const topo0 = topologyOf(s0)
        const ends = [...topo0.byNote.values()].flat()
        const pressed = ends[pick % ends.length] as (typeof ends)[number]
        const noteId = pressed.end === 'a' ? pressed.ref.aNoteId : pressed.ref.bNoteId
        const attach0 = createAttach(topo0, boardFrames(s0.notes, { rotation: false }))
        const p0 = attach0.point(pressed.ref, pressed.end) as Point
        const onNote = (topo0.byNote.get(noteId) ?? []).filter(
          (e) => e.ref.yarnId !== pressed.ref.yarnId,
        )
        const others0 = onNote.map((e) => attach0.point(e.ref, e.end))
        // One to three new threads, each from another note, join the pressed pin in turn.
        const key = anchorKey(pressed.ref.yarnId, pressed.end)
        let records: Array<Note | Yarn> = [
          ...notes,
          ...yarns.map((y) =>
            y.id === pressed.ref.yarnId ? { ...y, pins: { [noteId]: key } } : y,
          ),
        ]
        for (const [k, f] of from.entries()) {
          const other = notes.filter((n) => n.id !== noteId)[f % (notes.length - 1)] as Note
          records = [
            ...records,
            { ...yarn(20 + k, []), noteIds: [other.id, noteId], pins: { [noteId]: key } },
          ]
          const s = board(records)
          const topo = topologyOf(s)
          const attach = createAttach(topo, boardFrames(s.notes, { rotation: false }))
          expect(attach.point(pressed.ref, pressed.end)).toEqual(p0)
          // Ends of other threads on the note keep their places too.
          expect(onNote.map((e) => attach.point(e.ref, e.end))).toEqual(others0)
        }
      }),
      { numRuns: 300 },
    )
  })
})
