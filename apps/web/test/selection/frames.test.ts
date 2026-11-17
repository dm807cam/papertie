import { benchBoard } from '@papertie/tools/gen-board'
import { boardFrames, createAttach, type SegmentRef, topologyOf } from '../../src/canvas/attach'
import type { Camera } from '../../src/canvas/Camera'
import { cullRect } from '../../src/canvas/cull'
import { noteBounds, pinPosition } from '../../src/canvas/geometry'
import { SELECTION_FRAME } from '../../src/canvas/selectionFrame'
import { SpatialIndex } from '../../src/canvas/spatialIndex'
import { type YarnFrameInput, YarnRenderer } from '../../src/canvas/YarnRenderer'
import { restSagPoint } from '../../src/canvas/yarnGeometry'
import { type RecordedCall, type RecordedSet, recordingContext } from '../helpers/recordingContext'

const viewport = { width: 800, height: 600 }
const state = benchBoard(100)
const index = new SpatialIndex()
index.rebuild(state, new Map())

function fake() {
  const { ctx, calls, sets } = recordingContext()
  return {
    canvas: { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement,
    calls,
    sets,
  }
}

function render(camera: Camera, framed: ReadonlySet<string>, focused?: string) {
  const yarn = fake()
  const pins = fake()
  const r = new YarnRenderer(yarn.canvas, pins.canvas, () => fake().canvas)
  r.resize(viewport, 1)
  const cull = cullRect(camera, viewport)
  const attach = createAttach(topologyOf(state), boardFrames(state.notes, { rotation: false }))
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
    endsOf: (ref: SegmentRef) => attach.ends(ref),
    sagOf: (_ref, a, b) => restSagPoint(a, b),
    dynamicKeys: new Set(),
    dynamicNotes: new Set(),
    paperOf: (id) => {
      const n = state.notes.get(id)
      return n && { rect: noteBounds(n), pivot: pinPosition(n), deg: 0, z: n.z }
    },
    framedNotes: framed,
    ...(focused === undefined ? {} : { focusedNote: focused }),
  }
  r.render(input)
  return { pins, visible: input.visibleNotes }
}

const strokes = (calls: RecordedCall[]) => calls.filter((c) => c.name === 'stroke').length
const widths = (sets: RecordedSet[]) =>
  sets.filter((s) => s.prop === 'lineWidth').map((s) => s.value)
const inks = (sets: RecordedSet[]) =>
  sets.filter((s) => s.prop === 'strokeStyle').map((s) => s.value)

describe('the frame of several selected notes, drawn on the pin layer', () => {
  it('is as thick at zoom 0.2 as at zoom 1: screen px, not world px', () => {
    for (const zoom of [1, 0.2]) {
      const camera: Camera = { x: 100, y: 50, zoom }
      const cull = cullRect(camera, viewport)
      const some = index.notesIn(cull).slice(0, 3)
      expect(some.length).toBe(3)
      const { pins } = render(camera, new Set(some))
      const w = widths(pins.sets)
      expect(w).toContain(SELECTION_FRAME.width)
      expect(w).toContain(SELECTION_FRAME.halo)
    }
  })

  it('draws one frame (a halo and an ink stroke) per culled selected note, none for one note', () => {
    const camera: Camera = { x: 100, y: 50, zoom: 1 }
    const some = index.notesIn(cullRect(camera, viewport)).slice(0, 3)
    const base = render(camera, new Set(), undefined)
    const three = render(camera, new Set(some))
    expect(strokes(three.pins.calls) - strokes(base.pins.calls)).toBe(6)
    const one = render(camera, new Set(some.slice(0, 1)))
    expect(strokes(one.pins.calls)).toBe(strokes(base.pins.calls))
  })

  it('takes the focus ink for the note that has the keyboard, the pencil ink for the rest', () => {
    const camera: Camera = { x: 100, y: 50, zoom: 1 }
    const some = index.notesIn(cullRect(camera, viewport)).slice(0, 3)
    const { pins } = render(camera, new Set(some), some[1])
    const ink = inks(pins.sets)
    expect(ink.filter((c) => c === SELECTION_FRAME.focus)).toHaveLength(1)
    expect(ink.filter((c) => c === SELECTION_FRAME.ink)).toHaveLength(2)
  })

  it('leaves off notes that are not culled, however big the selection', () => {
    const camera: Camera = { x: 100, y: 50, zoom: 1 }
    const all = new Set(state.notes.keys())
    const base = render(camera, new Set())
    const { pins, visible } = render(camera, all)
    expect(strokes(pins.calls) - strokes(base.pins.calls)).toBe(2 * visible.length)
  })
})
