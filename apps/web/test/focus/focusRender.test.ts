import type { BoardState } from '@papertie/core'
import { benchBoard } from '@papertie/tools/gen-board'
import { boardFrames, createAttach, type SegmentRef, topologyOf } from '../../src/canvas/attach'
import type { Camera } from '../../src/canvas/Camera'
import { cullRect } from '../../src/canvas/cull'
import { pinPosition } from '../../src/canvas/geometry'
import { SpatialIndex } from '../../src/canvas/spatialIndex'
import { type YarnFrameInput, YarnRenderer } from '../../src/canvas/YarnRenderer'
import { polylineLength, restSagPoint } from '../../src/canvas/yarnGeometry'
import { type FocusPaint, LOOSE_END_WORLD, looseStub, partOf } from '../../src/focus/focusMode'
import { type RecordedCall, type RecordedSet, recordingContext } from '../helpers/recordingContext'

const viewport = { width: 800, height: 600 }
const c0: Camera = { x: 100, y: 50, zoom: 1 }

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

const paintOf = (shown: Set<string>, fade?: { has: Set<string>; alpha: number }): FocusPaint => ({
  shown: (id) => shown.has(id),
  key: shown,
  fade: fade ? { has: (id) => fade.has.has(id), alpha: fade.alpha, key: fade.has } : null,
})

describe('partOf', () => {
  const p = paintOf(new Set(['s1', 's2']), { has: new Set(['f1', 'f2']), alpha: 0.5 })
  it('the shown layer draws threads between shown notes whole, and loose ends out of them', () => {
    expect(partOf(p, 'shown', 's1', 's2')).toBe('whole')
    expect(partOf(p, 'shown', 's1', 'f1')).toBe('a')
    expect(partOf(p, 'shown', 'h', 's2')).toBe('b')
    expect(partOf(p, 'shown', 'f1', 'f2')).toBeNull()
    expect(partOf(p, 'shown', 'h', 'h2')).toBeNull()
  })
  it('the fade layer draws what touches a fading note: whole to a drawn note, loose to a hidden one', () => {
    expect(partOf(p, 'fade', 'f1', 'f2')).toBe('whole')
    expect(partOf(p, 'fade', 's1', 'f1')).toBe('whole')
    expect(partOf(p, 'fade', 'f1', 'h')).toBe('a')
    expect(partOf(p, 'fade', 'h', 'f2')).toBe('b')
    expect(partOf(p, 'fade', 's1', 's2')).toBeNull()
    expect(partOf(p, 'fade', 's1', 'h')).toBeNull()
  })
  it('a loose end is the first 36 world px of the strand from its visible end', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(LOOSE_END_WORLD).toBe(36)
    expect(looseStub(pts, 'a')).toEqual([
      { x: 0, y: 0 },
      { x: 36, y: 0 },
    ])
    expect(polylineLength(looseStub(pts, 'b'))).toBeCloseTo(36)
    expect(looseStub(pts, 'b')[1]).toEqual({ x: 100, y: 0 })
  })
})

describe('YarnRenderer in focus mode', () => {
  const state: BoardState = benchBoard(100)
  const index = new SpatialIndex()
  index.rebuild(state, new Map())
  const attach = createAttach(topologyOf(state), boardFrames(state.notes, { rotation: false }))

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
    const cull = cullRect(c0, viewport)
    const input: YarnFrameInput = {
      state,
      camera: c0,
      viewport,
      dpr: 1,
      lod: 'lite',
      segments: index.segmentsIn(cull),
      visibleNotes: index.notesIn(cull),
      pinOf: (id) => {
        const n = state.notes.get(id)
        return n && pinPosition(n)
      },
      endsOf: (ref: SegmentRef) => attach.ends(ref),
      sagOf: (_ref, a, b) => restSagPoint(a, b),
      dynamicKeys: new Set(),
      dynamicNotes: new Set(),
    }
    return { r, input, yarn, made }
  }

  it('caches only what focus shows, with loose ends, and fades the rest from one cached layer', () => {
    const { r, input, yarn, made } = setup()
    const ref = input.segments.find((r) => input.visibleNotes.includes(r.aNoteId))
    if (ref === undefined) throw new Error('no segment in view')
    // One note shown: its threads are loose ends, nothing else of the board is drawn.
    const shown = new Set([ref.aNoteId])
    const steady = r.render({ ...input, focus: paintOf(shown) })
    const [staticYarn, staticPins] = made as [Fake, Fake]
    expect(steady.staticRedrawn).toBe(true)
    expect(count(staticYarn.calls, 'stroke')).toBe(0)
    // Lite: hanging pins are dots (one, the shown note's); the loose end is on the pin layer.
    expect(count(staticPins.calls, 'fill')).toBe(1)
    expect(count(staticPins.calls, 'stroke')).toBeGreaterThan(0)
    expect(steady.segmentsStatic).toBeGreaterThan(0)

    // Fading out the rest: a second pair of layers holds it, drawn once.
    const rest = new Set(input.visibleNotes.filter((id) => !shown.has(id)))
    const fade = { has: rest, alpha: 0.6 }
    const paint = paintOf(shown, fade)
    yarn.calls.length = 0
    yarn.sets.length = 0
    const first = r.render({ ...input, focus: paint })
    expect(first.staticRedrawn).toBe(false)
    const [fadeYarn] = made.slice(2) as [Fake]
    expect(count(fadeYarn.calls, 'stroke')).toBeGreaterThan(0)
    // Blitted under the cache at the fade's opacity.
    expect(count(yarn.calls, 'drawImage')).toBe(2)
    expect(yarn.sets.some((s) => s.prop === 'globalAlpha' && s.value === 0.6)).toBe(true)

    // Later fade frames only blit: neither layer is drawn again.
    const drawn = staticYarn.calls.length + fadeYarn.calls.length
    if (paint.fade) paint.fade.alpha = 0.2
    const next = r.render({ ...input, focus: paint })
    expect(next.staticRedrawn).toBe(false)
    expect(staticYarn.calls.length + fadeYarn.calls.length).toBe(drawn)
    expect(yarn.sets.some((s) => s.prop === 'globalAlpha' && s.value === 0.2)).toBe(true)

    // The fade over, the same shown notes: the cache stays and nothing fades.
    yarn.calls.length = 0
    const after = r.render({ ...input, focus: { ...paint, fade: null } })
    expect(after.staticRedrawn).toBe(false)
    expect(count(yarn.calls, 'drawImage')).toBe(1)
  })
})
