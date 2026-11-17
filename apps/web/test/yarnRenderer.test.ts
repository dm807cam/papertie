import {
  type BoardState,
  commitBatch,
  emptyBoardState,
  type Note,
  stateFromRecords,
  type Yarn,
} from '@papertie/core'
import { benchBoard } from '@papertie/tools/gen-board'
import { mulberry32 } from '@papertie/tools/rng'
import {
  boardFrames,
  createAttach,
  type SegmentRef,
  topologyOf,
  withNeighbours,
} from '../src/canvas/attach'
import { type Camera, screenMapper } from '../src/canvas/Camera'
import { cullRect } from '../src/canvas/cull'
import { noteBounds, pinPosition } from '../src/canvas/geometry'
import { PIN_STUB_WORLD, paperBounds, segmentOccluders } from '../src/canvas/layering'
import { SpatialIndex } from '../src/canvas/spatialIndex'
import type { Point } from '../src/canvas/types'
import {
  STATIC_MARGIN,
  staticCacheAction,
  type YarnFrameInput,
  YarnRenderer,
} from '../src/canvas/YarnRenderer'
import {
  flattenBezier,
  polylineLength,
  restSagPoint,
  segmentBezier,
  truncatePolyline,
} from '../src/canvas/yarnGeometry'
import { DEMO_IDS, demoBoard } from '../src/dev/demoBoard'
import { type RecordedCall, type RecordedSet, recordingContext } from './helpers/recordingContext'

const viewport = { width: 800, height: 600 }
const c0: Camera = { x: 100, y: 50, zoom: 1 }

describe('staticCacheAction', () => {
  const at = (dx: number, dy: number, zoom = c0.zoom): Camera => ({
    x: c0.x + dx / zoom,
    y: c0.y + dy / zoom,
    zoom,
  })

  it('staticCacheAction: pan inside margin blits, beyond margin or zoom change redraws', () => {
    const prev = { camera: c0, invalid: false }
    expect(STATIC_MARGIN).toBe(0.25)
    expect(staticCacheAction(prev, c0, viewport)).toBe('blit')
    expect(staticCacheAction(prev, at(199, 0), viewport)).toBe('blit')
    expect(staticCacheAction(prev, at(-199, 149), viewport)).toBe('blit')
    expect(staticCacheAction(prev, at(201, 0), viewport)).toBe('redraw')
    expect(staticCacheAction(prev, at(0, -151), viewport)).toBe('redraw')
    expect(staticCacheAction(prev, { ...c0, zoom: 1.0001 }, viewport)).toBe('redraw')
  })

  it('redraws with no cache or an invalid one', () => {
    expect(staticCacheAction(null, c0, viewport)).toBe('redraw')
    expect(staticCacheAction({ camera: c0, invalid: true }, c0, viewport)).toBe('redraw')
  })

  it('measures the pan in screen px at the current zoom', () => {
    const prev = { camera: { ...c0, zoom: 2 }, invalid: false }
    expect(staticCacheAction(prev, { ...c0, x: c0.x + 90, zoom: 2 }, viewport)).toBe('blit')
    expect(staticCacheAction(prev, { ...c0, x: c0.x + 110, zoom: 2 }, viewport)).toBe('redraw')
  })
})

interface Fake {
  canvas: HTMLCanvasElement
  calls: RecordedCall[]
  sets: RecordedSet[]
}

function fakeCanvas(): Fake {
  const { ctx, calls, sets } = recordingContext()
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  return { canvas: canvas as unknown as HTMLCanvasElement, calls, sets }
}

const count = (calls: RecordedCall[], name: string) => calls.filter((c) => c.name === name).length

/** Edge-pin ends for a board at rest. */
const endsFor = (state: BoardState) => {
  const attach = createAttach(topologyOf(state), boardFrames(state.notes, { rotation: false }))
  return (ref: SegmentRef) => attach.ends(ref)
}

describe('YarnRenderer', () => {
  const state = benchBoard(100)
  const index = new SpatialIndex()
  index.rebuild(state, new Map())

  function setup() {
    const yarn = fakeCanvas()
    const pins = fakeCanvas()
    const made: Fake[] = []
    const r = new YarnRenderer(yarn.canvas, pins.canvas, () => {
      const f = fakeCanvas()
      made.push(f)
      return f.canvas
    })
    r.resize(viewport, 2)
    const cull = cullRect(c0, viewport)
    const input: YarnFrameInput = {
      state,
      camera: c0,
      viewport,
      dpr: 2,
      lod: 'lite',
      segments: index.segmentsIn(cull),
      visibleNotes: index.notesIn(cull),
      pinOf: (id) => {
        const n = state.notes.get(id)
        return n && pinPosition(n)
      },
      endsOf: endsFor(state),
      sagOf: (_ref, a, b) => restSagPoint(a, b),
      dynamicKeys: new Set(),
      dynamicNotes: new Set(),
    }
    const [staticYarn, staticPins] = made as [Fake, Fake]
    return { r, input, yarn, pins, staticYarn, staticPins }
  }

  it('sizes the static layers to the viewport plus 25% per side', () => {
    const { staticYarn, staticPins } = setup()
    for (const f of [staticYarn, staticPins]) {
      expect([f.canvas.width, f.canvas.height]).toEqual([2400, 1800])
    }
  })

  it('draws the static layer once, then blits it while the pan stays inside the margin', () => {
    const { r, input, yarn, pins, staticYarn, staticPins } = setup()
    expect(input.segments.length).toBeGreaterThan(3)
    const first = r.render(input)
    // Lite: the hanging pins only (edge pins would be specks).
    const pinCount = input.visibleNotes.length
    expect(first).toEqual({
      segmentsStatic: input.segments.length,
      segmentsDynamic: 0,
      pins: pinCount,
      staticRedrawn: true,
    })
    const strokes = count(staticYarn.calls, 'stroke')
    expect(strokes).toBeGreaterThanOrEqual(input.segments.length)
    expect(count(staticPins.calls, 'fill')).toBe(pinCount)

    const panned = { ...c0, x: c0.x + 100 }
    const second = r.render({ ...input, camera: panned })
    expect(second.staticRedrawn).toBe(false)
    expect(count(staticYarn.calls, 'stroke')).toBe(strokes)
    const blit = yarn.calls.filter((c) => c.name === 'drawImage').at(-1)
    expect(blit?.args.slice(0, 3)).toEqual([staticYarn.canvas, -400 - 200, -300])
    expect(pins.calls.filter((c) => c.name === 'drawImage').at(-1)?.args[0]).toBe(staticPins.canvas)
    expect(count(yarn.calls, 'stroke')).toBe(0)

    expect(r.render({ ...input, camera: { ...c0, x: c0.x + 300 } }).staticRedrawn).toBe(true)
    expect(r.render({ ...input, camera: { ...c0, zoom: 1.5 } }).staticRedrawn).toBe(true)
  })

  it('draws dynamic segments and pins on top every frame, outside the cache', () => {
    const { r, input, yarn, pins } = setup()
    r.render(input)
    const seg = input.segments[0]
    if (!seg) throw new Error('no segments')
    const dyn = { ...input, dynamicKeys: new Set([seg.key]) }
    const a = r.render(dyn)
    // Lite patches the cache where the segment was, rather than redraw it.
    expect(a.staticRedrawn).toBe(false)
    expect(a.segmentsDynamic).toBe(1)
    expect(a.segmentsStatic).toBe(input.segments.length - 1)
    const before = count(yarn.calls, 'stroke')
    expect(before).toBe(1)
    const b = r.render({ ...dyn, camera: { ...c0, x: c0.x + 20 } })
    expect(b.staticRedrawn).toBe(false)
    expect(count(yarn.calls, 'stroke')).toBe(2)

    // A note on one thread starts to move (a drag's start): its pin and segment leave the cache,
    // which in lite is patched where they were, not redrawn.
    const touchingOf = (id: string) =>
      input.segments.filter((s) => s.aNoteId === id || s.bNoteId === id)
    const note = input.visibleNotes.find((id) => touchingOf(id).length === 1) as string
    const moving = { ...input, dynamicNotes: new Set([note]) }
    const touching = touchingOf(note)
    const m = r.render(moving)
    expect(m.staticRedrawn).toBe(false)
    expect(m.segmentsDynamic).toBe(touching.length)
    const pinFills = count(pins.calls, 'fill')
    r.render({ ...moving, camera: { ...c0, y: c0.y + 10 } })
    expect(count(pins.calls, 'fill')).toBe(pinFills + 1)
    // The drag ends: the note's pin and segment go back into the cache by a patch.
    const back = r.render({ ...input, camera: { ...c0, y: c0.y + 10 } })
    expect(back.staticRedrawn).toBe(false)
    expect(back.segmentsStatic).toBe(input.segments.length)
    expect(back.segmentsDynamic).toBe(0)
  })

  it("in full detail draws each segment's two edge pins with it: cached, or live when dynamic", () => {
    const made: unknown[] = []
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number,
        ) {
          made.push(this)
        }
        getContext() {
          const gradient = () => ({ addColorStop() {} })
          return new Proxy(recordingContext().ctx, {
            get: (t, prop) =>
              prop === 'createRadialGradient' || prop === 'createLinearGradient'
                ? gradient
                : Reflect.get(t, prop),
          })
        }
      },
    )
    try {
      const { r, input, pins, staticPins } = setup()
      const full = { ...input, lod: 'full' as const }
      const first = r.render(full)
      expect(first.pins).toBe(input.visibleNotes.length + 2 * input.segments.length)
      expect(count(staticPins.calls, 'drawImage')).toBe(first.pins)
      const note = input.visibleNotes[0] as string
      const touching = input.segments.filter((s) => s.aNoteId === note || s.bNoteId === note)
      const live = pins.calls.length
      const moving = r.render({ ...full, dynamicNotes: new Set([note]) })
      expect(moving.pins).toBe(first.pins)
      // On the live pin canvas: the blit, the note's hanging pin and its segments' edge pins.
      expect(count(pins.calls.slice(live), 'drawImage')).toBe(1 + 1 + 2 * touching.length)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('redraws after invalidateStatic or a resize', () => {
    const { r, input } = setup()
    r.render(input)
    expect(r.render(input).staticRedrawn).toBe(false)
    r.invalidateStatic()
    expect(r.render(input).staticRedrawn).toBe(true)
    r.resize(viewport, 1)
    expect(r.render({ ...input, dpr: 1 }).staticRedrawn).toBe(true)
    expect(r.render({ ...input, dpr: 1 }).staticRedrawn).toBe(false)
  })

  it('draws relative to the anchor; a rebase redraws the cache, a pan under one anchor blits', () => {
    const plain = setup()
    plain.r.render(plain.input)
    const moves = (f: Fake) => f.calls.filter((c) => c.name === 'moveTo').map((c) => c.args)
    const anchored = setup()
    const anchor = { x: 437, y: -211 }
    const first = anchored.r.render({ ...anchored.input, anchor })
    expect(first.staticRedrawn).toBe(true)
    const a = moves(anchored.staticYarn)
    const b = moves(plain.staticYarn)
    expect(a.length).toBe(b.length)
    // The same picture, up to the device snap of each anchor's offset (dpr 2).
    for (const [k, args] of a.entries()) {
      expect(Math.abs((args[0] as number) - (b[k]?.[0] as number))).toBeLessThanOrEqual(0.5)
      expect(Math.abs((args[1] as number) - (b[k]?.[1] as number))).toBeLessThanOrEqual(0.5)
    }
    const panned = { ...anchored.input, anchor, camera: { ...c0, x: c0.x + 50.3 } }
    expect(anchored.r.render(panned).staticRedrawn).toBe(false)
    const blit = anchored.yarn.calls.filter((c) => c.name === 'drawImage').at(-1)
    expect(blit?.args.slice(1, 3)).toEqual([Math.round(-50.3 * 2) - 400, -300])
    expect(anchored.r.render({ ...panned, anchor: { x: 9000, y: 0 } }).staticRedrawn).toBe(true)
  })

  it('draws pin glow and the live thread on top without redrawing the static cache', () => {
    const { r, input, yarn, pins } = setup()
    r.render(input)
    const note = input.visibleNotes[0] as string
    const strokes = count(yarn.calls, 'stroke')
    const pinStrokes = count(pins.calls, 'stroke')
    const from = input.pinOf(note) as Point
    const to = { x: from.x + 200, y: from.y + 50 }
    const live = { from, to, sag: restSagPoint(from, to), color: 'apricot' as const }
    for (let k = 0; k < 3; k++) {
      const stats = r.render({ ...input, glowNotes: new Set([note]), live })
      expect(stats.staticRedrawn).toBe(false)
      expect(stats.segmentsDynamic).toBe(1)
    }
    expect(count(yarn.calls, 'stroke')).toBe(strokes + 3)
    expect(count(pins.calls, 'stroke')).toBe(pinStrokes + 3)
    const glowStroke = pins.sets.filter((s) => s.prop === 'strokeStyle').at(-1)
    expect(glowStroke?.value).toBe('rgba(231,200,115,0.6)')
    expect(r.render(input)).toMatchObject({ staticRedrawn: false, segmentsDynamic: 0 })
    expect(count(yarn.calls, 'stroke')).toBe(strokes + 3)
  })

  it('skips segments whose yarn or notes are gone', () => {
    const { r, input } = setup()
    const seg = input.segments[0]
    if (!seg) throw new Error('no segments')
    const stats = r.render({
      ...input,
      endsOf: (ref) =>
        ref.aNoteId === seg.aNoteId || ref.bNoteId === seg.aNoteId ? undefined : input.endsOf(ref),
    })
    const lost = input.segments.filter(
      (s) => s.aNoteId === seg.aNoteId || s.bNoteId === seg.aNoteId,
    )
    expect(stats.segmentsStatic).toBe(input.segments.length - lost.length)
  })
})

describe('YarnRenderer motion hooks', () => {
  const NOW = '2026-10-27T00:00:00.000Z'
  const state = demoBoard(NOW)
  const index = new SpatialIndex()
  index.rebuild(state, new Map())
  const camera: Camera = { x: 400, y: 0, zoom: 1 }
  const pinOf = (id: string) => {
    const n = state.notes.get(id)
    return n && pinPosition(n)
  }
  const endsOf = endsFor(state)
  const yarn = state.yarns.get(DEMO_IDS.threeNote) as Yarn
  const segs = (topologyOf(state).byYarn.get(yarn.id) ?? []).map(
    (ref) => endsOf(ref) as { a: Point; b: Point },
  )

  function setup() {
    const main = fakeCanvas()
    const r = new YarnRenderer(main.canvas, fakeCanvas().canvas, () => fakeCanvas().canvas)
    r.resize(viewport, 1)
    const segments = index.segmentsIn(cullRect(camera, viewport))
    const own = segments.filter((s) => s.yarnId === yarn.id)
    expect(own).toHaveLength(2)
    const input: YarnFrameInput = {
      state,
      camera,
      viewport,
      dpr: 1,
      lod: 'lite',
      segments,
      visibleNotes: index.notesIn(cullRect(camera, viewport)),
      pinOf,
      endsOf,
      sagOf: (_ref, a, b) => restSagPoint(a, b),
      dynamicKeys: new Set(own.map((s) => s.key)),
      dynamicNotes: new Set(),
    }
    return { r, input, main }
  }

  /** End point of each stroked path drawn on the main canvas since `from`. */
  const strokeEnds = (calls: RecordedCall[], from: number) => {
    const ends: Array<{ x: number; y: number }> = []
    let last: { x: number; y: number } | undefined
    for (const c of calls.slice(from)) {
      if (c.name === 'moveTo' || c.name === 'lineTo')
        last = { x: c.args[0] as number, y: c.args[1] as number }
      if (c.name === 'stroke' && last) ends.push(last)
    }
    return ends
  }

  it("draws a thread in over its segments' total flattened length, in order", () => {
    const { r, input, main } = setup()
    const map = screenMapper(camera, 1)
    const curves = segs.map(({ a, b }) =>
      flattenBezier(segmentBezier(a, b, restSagPoint(a, b)), 0.5),
    )
    const lens = curves.map((c) => polylineLength(c))
    const total = lens.reduce((x, y) => x + y, 0)
    for (const progress of [0.2, 0.7]) {
      const from = main.calls.length
      const stats = r.render({ ...input, progressOf: (id) => (id === yarn.id ? progress : 1) })
      const drawn = progress * total
      const k = drawn > (lens[0] as number) ? 1 : 0
      const before = k === 0 ? 0 : (lens[0] as number)
      const share = (drawn - before) / (lens[k] as number)
      const end = truncatePolyline(curves[k] as Point[], share).at(-1) as Point
      expect(stats.segmentsDynamic).toBe(k + 1)
      const ends = strokeEnds(main.calls, from)
      const tip = map(end)
      expect(ends.some((p) => Math.abs(p.x - tip.x) < 1e-6 && Math.abs(p.y - tip.y) < 1e-6)).toBe(
        true,
      )
    }
  })

  it('draws loosening ghosts on top with their sag scaled and their alpha', () => {
    const { r, input, main } = setup()
    const ghostYarn = state.yarns.get(DEMO_IDS.crossed) as Yarn
    const gs = (topologyOf(state).byYarn.get(ghostYarn.id) ?? []).map(
      (ref) => endsOf(ref) as { a: Point; b: Point },
    )
    const base = r.render(input).segmentsDynamic
    const from = main.calls.length
    const sets0 = main.sets.length
    const stats = r.render({
      ...input,
      ghosts: [{ yarn: ghostYarn, segments: gs, sagScale: 1.6, alpha: 0.4 }],
    })
    expect(stats.segmentsDynamic).toBe(base + 1)
    expect(main.sets.slice(sets0).some((s) => s.prop === 'globalAlpha' && s.value === 0.4)).toBe(
      true,
    )
    // The ghost's midpoint is 1.6 x the rest sag below the chord.
    const { a, b } = gs[0] as { a: Point; b: Point }
    const rest = restSagPoint(a, b)
    const my = (a.y + b.y) / 2
    const deepest = Math.max(
      ...main.calls
        .slice(from)
        .filter((c) => c.name === 'lineTo')
        .map((c) => c.args[1] as number),
    )
    const expected = screenMapper(camera, 1)({ x: 0, y: my + 1.6 * (rest.y - my) }).y
    expect(deepest).toBeCloseTo(expected, 0)
    expect(r.render(input).segmentsDynamic).toBe(base)
  })
})

describe('YarnRenderer layers', () => {
  const NOW = '2026-10-27T00:00:00.000Z'
  const state = demoBoard(NOW)
  const index = new SpatialIndex()
  index.rebuild(state, new Map())
  // The bottom row: `crossed` from X1 under `overlap` to X2.
  const camera: Camera = { x: 0, y: 800, zoom: 1 }
  const pinOf = (id: string) => {
    const n = state.notes.get(id)
    return n && pinPosition(n)
  }
  const paperOf = (id: string) => {
    const n = state.notes.get(id)
    return n && { rect: noteBounds(n), pivot: pinPosition(n), deg: 0.5, z: n.z }
  }
  const occludersOf = (ref: { aNoteId: string; bNoteId: string }, pts: readonly Point[]) => {
    const a = state.notes.get(ref.aNoteId)
    const b = state.notes.get(ref.bNoteId)
    if (!a || !b) return []
    return segmentOccluders({ aNote: a, bNote: b, pts }, [...state.notes.values()], (n) => {
      const p = paperOf(n.id)
      return p ? paperBounds(p) : noteBounds(n)
    })
  }

  function setup() {
    const yarn = fakeCanvas()
    const pins = fakeCanvas()
    const made: Fake[] = []
    const r = new YarnRenderer(yarn.canvas, pins.canvas, () => {
      const f = fakeCanvas()
      made.push(f)
      return f.canvas
    })
    r.resize(viewport, 1)
    const cull = cullRect(camera, viewport)
    const input: YarnFrameInput = {
      state,
      camera,
      viewport,
      dpr: 1,
      lod: 'lite',
      segments: index.segmentsIn(cull),
      visibleNotes: index.notesIn(cull),
      pinOf,
      endsOf: endsFor(state),
      sagOf: (_ref, a, b) => restSagPoint(a, b),
      dynamicKeys: new Set(),
      dynamicNotes: new Set(),
      paperOf,
      occludersOf,
    }
    const [staticYarn, staticPins] = made as [Fake, Fake]
    return { r, input, yarn, pins, made, staticYarn, staticPins }
  }

  const erasesIn = (f: Fake) =>
    f.sets.filter((s) => s.prop === 'globalCompositeOperation' && s.value === 'destination-out')
      .length

  it('over draws plainly; over-fix erases the occluding paper once in the static redraw', () => {
    const { r, input, staticYarn } = setup()
    expect(input.segments.some((s) => s.yarnId === DEMO_IDS.crossed)).toBe(true)
    r.render({ ...input, layer: 'over' })
    expect(erasesIn(staticYarn)).toBe(0)
    expect(r.render({ ...input, layer: 'over-fix' }).staticRedrawn).toBe(true)
    expect(erasesIn(staticYarn)).toBe(1)
    // The erase is the paper turned about its pin: a closed quad, filled after the thread.
    const calls = staticYarn.calls.map((c) => c.name)
    const fill = calls.lastIndexOf('fill')
    expect(calls.slice(fill - 6, fill)).toEqual([
      'beginPath',
      'moveTo',
      'lineTo',
      'lineTo',
      'lineTo',
      'closePath',
    ])
    expect(calls.slice(0, fill).includes('stroke')).toBe(true)
    // Panning inside the margin blits: no more erases.
    r.render({ ...input, layer: 'over-fix', camera: { ...camera, x: 20 } })
    expect(erasesIn(staticYarn)).toBe(1)
  })

  it('a layer change redraws the cache', () => {
    const { r, input } = setup()
    r.render({ ...input, layer: 'over' })
    expect(r.render({ ...input, layer: 'over' }).staticRedrawn).toBe(false)
    expect(r.render({ ...input, layer: 'under' }).staticRedrawn).toBe(true)
    expect(r.render({ ...input, layer: 'under' }).staticRedrawn).toBe(false)
  })

  it('over-fix runs dynamic segments that need an erase in their own buffer, then composites', () => {
    const { r, input, yarn, made } = setup()
    const crossed = input.segments.find((s) => s.yarnId === DEMO_IDS.crossed)
    if (!crossed) throw new Error('no crossed segment')
    const dyn = { ...input, layer: 'over-fix' as const, dynamicKeys: new Set([crossed.key]) }
    expect(r.render(dyn).segmentsDynamic).toBe(1)
    const buffer = made[2]
    if (!buffer) throw new Error('no dynamic buffer')
    expect(erasesIn(buffer)).toBe(1)
    expect([buffer.canvas.width, buffer.canvas.height]).toEqual([800, 600])
    expect(erasesIn(yarn)).toBe(0)
    // Blit of the cache, then the dynamic buffer.
    expect(count(yarn.calls, 'drawImage')).toBe(2)
    // Without an erase the dynamic segment is drawn straight onto the canvas.
    const other = input.segments.find((s) => s.yarnId !== DEMO_IDS.crossed)
    if (!other) throw new Error('no other segment')
    const before = count(yarn.calls, 'drawImage')
    r.render({ ...dyn, dynamicKeys: new Set([other.key]) })
    expect(count(yarn.calls, 'drawImage')).toBe(before + 1)
  })

  it('under paints pin stubs beneath the heads: before them in the cache, destination-over live', () => {
    const { r, input, pins, staticPins } = setup()
    r.render({ ...input, layer: 'over' })
    expect(count(staticPins.calls, 'stroke')).toBe(0)
    const from = staticPins.calls.length
    r.render({ ...input, layer: 'under' })
    const names = staticPins.calls.slice(from).map((c) => c.name)
    const firstHead = names.indexOf('arc')
    const lastStroke = names.lastIndexOf('stroke')
    // Two stubs per segment, one stroke each in lite mode.
    expect(names.filter((n) => n === 'stroke')).toHaveLength(input.segments.length * 2)
    expect(lastStroke).toBeLessThan(firstHead)

    const note = input.visibleNotes[0]
    if (note === undefined) throw new Error('no visible note')
    const sets0 = pins.sets.length
    r.render({ ...input, layer: 'under', dynamicNotes: new Set([note]) })
    expect(
      pins.sets
        .slice(sets0)
        .some((s) => s.prop === 'globalCompositeOperation' && s.value === 'destination-over'),
    ).toBe(true)
  })
})

describe('YarnRenderer shared pins', () => {
  const NOW = '2026-11-02T00:00:00.000Z'
  const nid = (n: number) => `note_01JBSP00${String(n).padStart(18, '0')}`
  const yid = (n: number) => `yarn_01JBSP00${String(n).padStart(18, '0')}`
  const note = (n: number, x: number, y: number) => ({
    type: 'note' as const,
    id: nid(n),
    x,
    y,
    w: 200,
    h: 140,
    z: n,
    paper: 'cream' as const,
    style: 'rustic' as const,
    text: '',
    image: null,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const thread = (n: number, ids: string[], pins: Record<string, string>): Yarn => ({
    type: 'yarn',
    id: yid(n),
    noteIds: ids,
    color: 'apricot',
    label: '',
    pins,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const notes = [note(1, 150, 100), note(2, 450, 100), note(3, 450, 400)]
  // A–B and B–C share one pin on B; B–C is tied at C's hanging pin.
  const yAB = thread(1, [nid(1), nid(2)], { [nid(2)]: 'p1' })
  const yBC = thread(2, [nid(2), nid(3)], { [nid(2)]: 'p1', [nid(3)]: 'hanging' })
  const state: BoardState = {
    board: demoBoard(NOW).board,
    assets: new Map(),
    notes: new Map(notes.map((n) => [n.id, n])),
    yarns: new Map([yAB, yBC].map((y) => [y.id, y])),
    books: new Map(),
    blocks: new Map(),
    blocksHeld: 'all',
  }
  const topo = topologyOf(state)
  const attach = createAttach(topo, boardFrames(state.notes, { rotation: false }))
  const refAB = topo.byYarn.get(yAB.id)?.[0] as SegmentRef
  const refBC = topo.byYarn.get(yBC.id)?.[0] as SegmentRef

  beforeEach(() => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          const gradient = () => ({ addColorStop() {} })
          return new Proxy(recordingContext().ctx, {
            get: (t, prop) =>
              prop === 'createRadialGradient' || prop === 'createLinearGradient'
                ? gradient
                : Reflect.get(t, prop),
          })
        }
      },
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  function setup() {
    const yarn = fakeCanvas()
    const pins = fakeCanvas()
    /** The static yarn and pin layers, then (focus fading) the fade layer's. */
    const made: Fake[] = []
    const r = new YarnRenderer(yarn.canvas, pins.canvas, () => {
      const f = fakeCanvas()
      made.push(f)
      return f.canvas
    })
    r.resize(viewport, 1)
    const input: YarnFrameInput = {
      state,
      camera: c0,
      viewport,
      dpr: 1,
      lod: 'full',
      segments: [refAB, refBC],
      visibleNotes: notes.map((n) => n.id),
      pinOf: (id) => {
        const n = state.notes.get(id)
        return n && pinPosition(n)
      },
      endsOf: (ref) => attach.ends(ref),
      sharedPinOf: (ref, end) => attach.sharedPin(ref, end),
      sagOf: (_ref, a, b) => restSagPoint(a, b),
      dynamicKeys: new Set(),
      dynamicNotes: new Set(),
    }
    return { r, input, pins, yarn, made }
  }

  it('draws a shared pin once and no edge pin at a hanging pin', () => {
    const { r, input } = setup()
    // Three hanging pins, A's own edge pin and the one pin B's two ends share.
    expect(r.render(input).pins).toBe(3 + 2)
  })

  it('a moving thread does not draw again the shared pin the cache holds', () => {
    for (const ref of [refAB, refBC]) {
      const { r, input, pins } = setup()
      const first = r.render(input)
      const live = pins.calls.length
      const moving = r.render({ ...input, dynamicKeys: new Set([ref.key]) })
      expect(moving.pins).toBe(first.pins)
      // The blit, plus A's own edge pin when A–B is the one drawn live.
      expect(count(pins.calls.slice(live), 'drawImage')).toBe(ref === refAB ? 2 : 1)
    }
  })

  it('both threads moving draw their shared pin once', () => {
    const { r, input, pins } = setup()
    r.render(input)
    const live = pins.calls.length
    const moving = r.render({ ...input, dynamicKeys: new Set([refAB.key, refBC.key]) })
    expect(moving.pins).toBe(5)
    expect(count(pins.calls.slice(live), 'drawImage')).toBe(1 + 2)
  })

  it('in focus, a shared pin is drawn once: by the shown layer, not again by the fading one', () => {
    const { r, input, made } = setup()
    const shown = new Set([nid(2), nid(3)])
    const fading = new Set([nid(1)])
    const focus = {
      shown: (id: string) => shown.has(id),
      key: shown,
      fade: { has: (id: string) => fading.has(id), alpha: 0.5, key: fading },
    }
    r.render({ ...input, focus })
    const fadePins = made[3] as Fake
    // A's hanging pin and A's own edge pin; B's shared pin is the shown layer's.
    expect(count(fadePins.calls, 'drawImage')).toBe(2)
  })

  it('a loosening ghost draws no head at a pin a thread still holds, nor at a hanging pin', () => {
    const { r, input, pins } = setup()
    r.render(input)
    const segments = [{ a: pinPosition(notes[0] as Note), b: attach.point(refAB, 'b') as Point }]
    const held = thread(9, [nid(1), nid(2)], { [nid(1)]: 'hanging', [nid(2)]: 'p1' })
    let live = pins.calls.length
    r.render({ ...input, ghosts: [{ yarn: held, segments, sagScale: 1, alpha: 0.5 }] })
    // The blit only.
    expect(count(pins.calls.slice(live), 'drawImage')).toBe(1)
    // A pin only the ghost held fades with it.
    const alone = thread(9, [nid(1), nid(2)], { [nid(2)]: 'p7' })
    live = pins.calls.length
    r.render({ ...input, ghosts: [{ yarn: alone, segments, sagScale: 1, alpha: 0.5 }] })
    expect(count(pins.calls.slice(live), 'drawImage')).toBe(3)
  })

  it.each(['over', 'over-fix'] as const)(
    'in %s, a strand from a hanging pin lies beneath its own paper past the stub at the pin',
    (layer) => {
      const below = note(4, 150, 450)
      const down = thread(5, [nid(1), below.id], { [nid(1)]: 'hanging' })
      const s: BoardState = {
        ...state,
        notes: new Map([...state.notes, [below.id, below]]),
        yarns: new Map([[down.id, down]]),
      }
      const t = topologyOf(s)
      const at = createAttach(t, boardFrames(s.notes, { rotation: false }))
      const ref = t.byYarn.get(down.id)?.[0] as SegmentRef
      const { r, input, made } = setup()
      r.render({
        ...input,
        state: s,
        layer,
        segments: [ref],
        visibleNotes: [nid(1), below.id],
        endsOf: (x) => at.ends(x),
        sharedPinOf: (x, end) => at.sharedPin(x, end),
        paperOf: (id) => {
          const n = s.notes.get(id) as Note
          return { rect: noteBounds(n), pivot: pinPosition(n), deg: 0, z: n.z }
        },
        occludersOf: () => [],
      })
      const map = screenMapper(c0, 1, { x: 0, y: 0 })
      const own = notes[0] as Note
      const pin = map(pinPosition(own))
      const tl = map({ x: own.x + 10, y: own.y + 10 })
      const br = map({ x: own.x + own.w - 10, y: own.y + own.h - 10 })
      const pts = (made[0] as Fake).calls
        .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
        .map((c) => ({ x: c.args[0] as number, y: c.args[1] as number }))
      expect(pts.length).toBeGreaterThan(10)
      const beneath = pts.filter(
        (p) =>
          p.x > tl.x &&
          p.x < br.x &&
          p.y > tl.y &&
          p.y < br.y &&
          Math.hypot(p.x - pin.x, p.y - pin.y) > PIN_STUB_WORLD + 10,
      )
      expect(beneath).toEqual([])
      // Past the paper, the strand is drawn on to the note below.
      expect(pts.some((p) => p.y > map({ x: 0, y: own.y + own.h + 20 }).y)).toBe(true)
    },
  )

  it('the live thread from a hanging pin lies beneath its own paper too, as it will once tied', () => {
    const { r, input, yarn } = setup()
    const own = notes[0] as Note
    const from = pinPosition(own)
    const to = { x: from.x + 20, y: 700 }
    r.render(input)
    const before = yarn.calls.length
    r.render({
      ...input,
      live: { from, to, sag: restSagPoint(from, to), color: 'apricot', under: own.id },
    })
    const map = screenMapper(c0, 1, { x: 0, y: 0 })
    const pin = map(from)
    const tl = map({ x: own.x + 10, y: own.y + 10 })
    const br = map({ x: own.x + own.w - 10, y: own.y + own.h - 10 })
    const pts = yarn.calls
      .slice(before)
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .map((c) => ({ x: c.args[0] as number, y: c.args[1] as number }))
    expect(pts.length).toBeGreaterThan(10)
    const beneath = pts.filter(
      (p) =>
        p.x > tl.x &&
        p.x < br.x &&
        p.y > tl.y &&
        p.y < br.y &&
        Math.hypot(p.x - pin.x, p.y - pin.y) > PIN_STUB_WORLD + 10,
    )
    expect(beneath).toEqual([])
  })
})

describe('YarnRenderer in lite: a change redraws only where it was and is', () => {
  // A dense lite view: every commit and every spring's start and end redrew
  // the whole static layer, 20–30 ms at 3,600 notes mounted. Now only the changed segments'
  // and pins' areas are cleared (clipped) and what meets them redrawn, in the same order.
  const state = benchBoard(100)
  const index = new SpatialIndex()
  index.rebuild(state, new Map())
  const camera: Camera = { x: -200, y: -200, zoom: 0.3 }

  function setup(lod: 'lite' | 'full' = 'lite') {
    const yarn = fakeCanvas()
    const pins = fakeCanvas()
    const made: Fake[] = []
    const r = new YarnRenderer(yarn.canvas, pins.canvas, () => {
      const f = fakeCanvas()
      made.push(f)
      return f.canvas
    })
    r.resize(viewport, 2)
    const cull = cullRect(camera, viewport)
    const input: YarnFrameInput = {
      state,
      camera,
      viewport,
      dpr: 2,
      lod,
      segments: index.segmentsIn(cull),
      visibleNotes: index.notesIn(cull),
      pinOf: (id) => {
        const n = state.notes.get(id)
        return n && pinPosition(n)
      },
      endsOf: endsFor(state),
      sagOf: (_ref, a, b) => restSagPoint(a, b),
      dynamicKeys: new Set(),
      dynamicNotes: new Set(),
    }
    const [staticYarn, staticPins] = made as [Fake, Fake]
    return { r, input, staticYarn, staticPins }
  }

  it('one segment changed: its area is cleared under a clip and only what meets it is redrawn', () => {
    const { r, input, staticYarn, staticPins } = setup()
    const all = input.segments.length
    expect(all).toBeGreaterThan(40)
    expect(r.render(input).staticRedrawn).toBe(true)
    const strokes = count(staticYarn.calls, 'stroke')
    const pinFills = count(staticPins.calls, 'fill')
    const ref = input.segments[Math.floor(all / 2)] as SegmentRef
    r.invalidateStatic({ segments: [ref.key], notes: [] })
    expect(r.staticInvalid).toBe(true)
    const stats = r.render(input)
    expect(stats.staticRedrawn).toBe(false)
    expect(stats.segmentsStatic).toBe(all)
    expect(stats.pins).toBe(input.visibleNotes.length)
    const redrawn = count(staticYarn.calls, 'stroke') - strokes
    expect(redrawn).toBeGreaterThanOrEqual(1)
    expect(redrawn).toBeLessThan(all / 4)
    // Each area patched under a clip of its own: the segment's, where it was and where it is.
    expect(count(staticYarn.calls, 'clip')).toBeGreaterThanOrEqual(1)
    expect(count(staticYarn.calls, 'clip')).toBeLessThanOrEqual(2)
    expect(count(staticPins.calls, 'clip')).toBe(count(staticYarn.calls, 'clip'))
    expect(count(staticPins.calls, 'fill') - pinFills).toBeLessThan(input.visibleNotes.length / 4)
    expect(r.staticInvalid).toBe(false)
  })

  it('a spring starting and ending patches the cache, never redraws it whole', () => {
    const { r, input, staticYarn } = setup()
    r.render(input)
    const strokes = count(staticYarn.calls, 'stroke')
    const ref = input.segments[3] as SegmentRef
    const moving = r.render({ ...input, dynamicKeys: new Set([ref.key]) })
    expect(moving.staticRedrawn).toBe(false)
    expect(moving.segmentsStatic).toBe(input.segments.length - 1)
    const settled = r.render(input)
    expect(settled.staticRedrawn).toBe(false)
    expect(settled.segmentsStatic).toBe(input.segments.length)
    expect(count(staticYarn.calls, 'stroke') - strokes).toBeLessThan(input.segments.length / 2)
  })

  it('a note changed: its pin and the segments at it', () => {
    const { r, input, staticYarn, staticPins } = setup()
    r.render(input)
    const strokes = count(staticYarn.calls, 'stroke')
    const pinFills = count(staticPins.calls, 'fill')
    const ref = input.segments[5] as SegmentRef
    r.invalidateStatic({ segments: [], notes: [ref.aNoteId] })
    expect(r.render(input).staticRedrawn).toBe(false)
    expect(count(staticYarn.calls, 'stroke') - strokes).toBeGreaterThanOrEqual(1)
    expect(count(staticPins.calls, 'fill') - pinFills).toBeGreaterThanOrEqual(1)
  })

  it('a whole invalidation, full detail, or a change too large still redraws it all', () => {
    const lite = setup()
    lite.r.render(lite.input)
    lite.r.invalidateStatic()
    expect(lite.r.render(lite.input).staticRedrawn).toBe(true)
    lite.r.invalidateStatic({ segments: lite.input.segments.map((s) => s.key), notes: [] })
    expect(lite.r.render(lite.input).staticRedrawn).toBe(true)
    // Full detail draws pin sprites, made on an OffscreenCanvas.
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          const gradient = () => ({ addColorStop() {} })
          return new Proxy(recordingContext().ctx, {
            get: (t, prop) =>
              prop === 'createRadialGradient' || prop === 'createLinearGradient'
                ? gradient
                : Reflect.get(t, prop),
          })
        }
      },
    )
    const full = setup('full')
    full.r.render(full.input)
    full.r.invalidateStatic({ segments: [(full.input.segments[0] as SegmentRef).key], notes: [] })
    expect(full.r.render(full.input).staticRedrawn).toBe(true)
    vi.unstubAllGlobals()
  })
})

describe('YarnRenderer in lite: a patch looks only near the change', () => {
  // A patch asked the whole view for what meets each area it cleared: O(view × areas). Asked of
  // the spatial index, it looks at the change and what lies around it. Counted, not timed. The dense lite board of tied-scale.spec: 60 × 60 notes, a
  // thread along each row and down each column.
  const T = '2026-11-01T00:00:00.000Z'
  const nid = (r: number, c: number) => `note_${String(r * 60 + c).padStart(26, '0')}`
  const notes: Note[] = []
  for (let r = 0; r < 60; r++) {
    for (let c = 0; c < 60; c++) {
      notes.push({
        type: 'note',
        id: nid(r, c),
        x: c * 135,
        y: r * 95,
        w: 120,
        h: 80,
        z: r * 60 + c,
        paper: 'cream',
        style: 'rustic',
        text: `Note ${r}-${c}`,
        image: null,
        createdAt: T,
        updatedAt: T,
      } as Note)
    }
  }
  const yarns: Yarn[] = []
  for (let k = 0; k < 60; k++) {
    for (const [noteIds, color] of [
      [Array.from({ length: 60 }, (_, c) => nid(k, c)), 'indigo'],
      [Array.from({ length: 60 }, (_, r) => nid(r, k)), 'apricot'],
    ] as const) {
      yarns.push({
        type: 'yarn',
        id: `yarn_${String(yarns.length).padStart(26, '0')}`,
        noteIds: [...noteIds],
        color,
        label: '',
        createdAt: T,
        updatedAt: T,
      } as Yarn)
    }
  }
  const state = stateFromRecords(emptyBoardState('board_dense', 'Dense', T).board, [
    ...notes,
    ...yarns,
  ])
  const index = new SpatialIndex()
  index.rebuild(state, new Map())
  const camera: Camera = { x: -20, y: -20, zoom: 0.16 }
  const viewport = { width: 1280, height: 800 }

  it('a scattered change of 256 things examines a bounded number of segments and pins', () => {
    const yarn = fakeCanvas()
    const pins = fakeCanvas()
    const r = new YarnRenderer(yarn.canvas, pins.canvas, () => fakeCanvas().canvas)
    r.resize(viewport, 1)
    const cull = cullRect(camera, viewport)
    const input: YarnFrameInput = {
      state,
      camera,
      viewport,
      dpr: 1,
      lod: 'lite',
      segments: index.segmentsIn(cull),
      visibleNotes: index.notesIn(cull),
      pinOf: (id) => {
        const n = state.notes.get(id)
        return n && pinPosition(n)
      },
      endsOf: endsFor(state),
      sagOf: (_ref, a, b) => restSagPoint(a, b),
      dynamicKeys: new Set(),
      dynamicNotes: new Set(),
      near: { segments: (q) => index.segmentsIn(q), notes: (q) => index.notesIn(q) },
    }
    const view = input.segments.length + input.visibleNotes.length
    expect(view).toBeGreaterThan(10_000)
    r.render(input)
    // Every 31st segment and every 89th note in view: scattered over all of it, 256 in all.
    const segments = input.segments.filter((_, k) => k % 31 === 0).slice(0, 220)
    const changed = input.visibleNotes.filter((_, k) => k % 89 === 0).slice(0, 36)
    expect(segments.length + changed.length).toBe(256)
    r.invalidateStatic({ segments: segments.map((s) => s.key), notes: changed })
    const stats = r.render(input)
    expect(stats.staticRedrawn).toBe(false)
    const patched = stats.patched as { areas: number; examined: number }
    expect(patched.areas).toBeGreaterThan(100)
    // Walking the view once per area examined areas × view (millions); asked of the index, a few
    // dozen things around each of the 256.
    expect(patched.examined).toBeLessThan(64 * 256)
    expect(patched.examined).toBeLessThan((patched.areas * view) / 100)
  })

  it('a patch of scattered moves draws again, in each area, exactly what a full scan finds there, in paint order', () => {
    // The e2e's patched layer differs from a whole redraw only by
    // stroke raster; this pins down that the patch's candidates (asked of the index) are the
    // strands and pins a whole redraw draws in that area, in its order, for random batches.
    const meetsBox = (a: readonly number[], b: readonly number[]) =>
      (a[0] as number) < (b[2] as number) &&
      (b[0] as number) < (a[2] as number) &&
      (a[1] as number) < (b[3] as number) &&
      (b[1] as number) < (a[3] as number)
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = mulberry32(seed)
      const idx = new SpatialIndex()
      idx.rebuild(state, new Map())
      const r = new YarnRenderer(
        fakeCanvas().canvas,
        fakeCanvas().canvas,
        () => fakeCanvas().canvas,
      )
      r.resize(viewport, 1)
      const cull = cullRect(camera, viewport)
      const frame = (s: BoardState): YarnFrameInput => ({
        state: s,
        camera,
        viewport,
        dpr: 1,
        lod: 'lite',
        segments: idx.segmentsIn(cull),
        visibleNotes: idx.notesIn(cull),
        pinOf: (id) => {
          const n = s.notes.get(id)
          return n && pinPosition(n)
        },
        endsOf: endsFor(s),
        sagOf: (_ref, a, b) => restSagPoint(a, b),
        dynamicKeys: new Set(),
        dynamicNotes: new Set(),
        near: { segments: (q) => idx.segmentsIn(q), notes: (q) => idx.notesIn(q) },
      })
      const first = frame(state)
      r.render(first)
      let s = state
      for (let batch = 0; batch < 3; batch++) {
        // Nine notes in view, anywhere, each moved a little: one batch from the store.
        const ids = new Set<string>()
        while (ids.size < 9)
          ids.add(first.visibleNotes[Math.floor(rng() * first.visibleNotes.length)] as string)
        s = commitBatch(
          s,
          [...ids].map((id) => {
            const n = s.notes.get(id) as Note
            return {
              op: 'note.update' as const,
              id,
              set: { x: n.x + Math.round(rng() * 40 - 20), y: n.y + Math.round(rng() * 30 - 15) },
            }
          }),
          T,
          null,
        )
        idx.updateNotes(s, ids, new Map())
        const topo = topologyOf(s)
        const segs = new Set<string>()
        for (const id of withNeighbours(topo, ids))
          for (const e of topo.byNote.get(id) ?? []) segs.add(e.ref.key)
        r.invalidateStatic({ segments: [...segs], notes: ids })
        const input = frame(s)
        const seen: Array<{ area: readonly number[]; segs: string[]; pins: string[] }> = []
        r.onPatchArea = (area, segs, pins) => seen.push({ area, segs, pins })
        const stats = r.render(input)
        r.onPatchArea = null
        expect(stats.staticRedrawn, `seed ${seed} batch ${batch}: patched`).toBe(false)
        expect(seen.length).toBeGreaterThan(0)
        const drawn = (
          r as unknown as {
            cache: { drawn: { segs: Map<string, number[]>; pins: Map<string, number[]> } }
          }
        ).cache.drawn
        for (const { area, segs, pins } of seen) {
          const full = input.segments
            .filter((ref) => {
              const b = drawn.segs.get(ref.key)
              return b !== undefined && meetsBox(b, area)
            })
            .map((ref) => ref.key)
          expect(segs, `seed ${seed} batch ${batch}: segments in [${area.join(',')}]`).toEqual(full)
          const fullPins = input.visibleNotes.filter((id) => {
            const b = drawn.pins.get(id)
            return b !== undefined && meetsBox(b, area)
          })
          expect(pins, `seed ${seed} batch ${batch}: pins in [${area.join(',')}]`).toEqual(fullPins)
        }
        // And every strand a whole redraw would draw has its drawn box: none is left out.
        for (const ref of input.segments) expect(drawn.segs.has(ref.key)).toBe(true)
      }
    }
  })
})
