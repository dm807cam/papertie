import type { BoardState } from '@papertie/core'
import { benchBoard } from '@papertie/tools/gen-board'
import { boardFrames, createAttach, type SegmentRef, topologyOf } from '../../src/canvas/attach'
import { type Camera, ORIGIN, screenMapper } from '../../src/canvas/Camera'
import { noteBounds, pinPosition } from '../../src/canvas/geometry'
import type { PaperShape } from '../../src/canvas/layering'
import { cardShape } from '../../src/canvas/overview'
import { type YarnFrameInput, YarnRenderer } from '../../src/canvas/YarnRenderer'
import { restSagPoint } from '../../src/canvas/yarnGeometry'
import { noteRotationDeg } from '../../src/lib/seed'
import { type RecordedCall, recordingContext } from '../helpers/recordingContext'

/**
 * The card overview of a board in view whole (a cold open fitting the lifetime
 * board, before its picture pyramid is made) drew every card and thread of it in one frame: one
 * task of 416–474 ms at 100,000 notes. Past a size it is drawn over several frames, a bounded
 * piece at a time, into layers of its own; the last whole picture is shown meanwhile (scaled,
 * after a zoom), or, with none, the picture as far as it has come.
 */

interface Fake {
  canvas: HTMLCanvasElement
  calls: RecordedCall[]
}

function fakeCanvas(): Fake {
  const { ctx, calls } = recordingContext()
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  return { canvas: canvas as unknown as HTMLCanvasElement, calls }
}

const PATHS = new Set(['moveTo', 'lineTo', 'bezierCurveTo', 'arc'])
/** What a set of canvases traced, as a sorted list: the picture's geometry, whatever the batching. */
const traced = (fakes: Fake[]) =>
  fakes
    .flatMap((f) => f.calls)
    .filter((c) => PATHS.has(c.name))
    .map((c) => `${c.name}(${c.args.join(',')})`)
    .sort()

const state: BoardState = benchBoard(1000)
const viewport = { width: 800, height: 600 }
/** Every note of the board in view. */
const camera: Camera = { x: -2000, y: -2000, zoom: 0.03 }
const shapeOf = (id: string): (PaperShape & { z: number }) | undefined => {
  const n = state.notes.get(id)
  if (n === undefined) return undefined
  return { rect: noteBounds(n), pivot: pinPosition(n), deg: noteRotationDeg(n), z: n.z }
}
const attach = createAttach(topologyOf(state), boardFrames(state.notes, { rotation: true }))
const segments = [...state.yarns.keys()].flatMap((y) => [
  ...(topologyOf(state).byYarn.get(y) ?? []),
])
const byZ = [...state.notes.values()].sort((a, b) => a.z - b.z).map((n) => n.id)

/** A clock that moves 1 ms each time it is read: a pass's pieces per frame are then fixed. */
function ticking() {
  let t = 0
  return () => ++t
}

/** `itemMs`: what a card or thread is first taken to cost (0: always drawn whole). */
function setup(itemMs: number) {
  const yarn = fakeCanvas()
  const pins = fakeCanvas()
  const made: Fake[] = []
  const r = new YarnRenderer(
    yarn.canvas,
    pins.canvas,
    () => {
      const f = fakeCanvas()
      made.push(f)
      return f.canvas
    },
    { now: ticking(), overviewItemMs: itemMs, overviewPiece: 64 },
  )
  r.resize(viewport, 1)
  const input: YarnFrameInput = {
    state,
    camera,
    viewport,
    dpr: 1,
    lod: 'overview',
    segments,
    visibleNotes: byZ,
    pinOf: (id) => {
      const n = state.notes.get(id)
      return n && pinPosition(n)
    },
    endsOf: (ref: SegmentRef) => attach.ends(ref),
    sagOf: (_ref, a, b) => restSagPoint(a, b),
    dynamicKeys: new Set(),
    dynamicNotes: new Set(),
    paperOf: shapeOf,
    geometryKey: attach,
  }
  return { r, input, yarn, pins, made }
}

/** Render until the pass is done; how many frames it took. */
function finish(r: YarnRenderer, input: YarnFrameInput): number {
  let frames = 0
  do {
    r.render(input)
    frames++
  } while (r.passing && frames < 1000)
  return frames
}

describe('a card overview too large for one frame', () => {
  it('is drawn over several frames, a bounded piece each, then blitted as a whole cache', () => {
    const whole = setup(0)
    const one = whole.r.render(whole.input)
    expect(whole.r.passing).toBe(false)
    expect(one.cards).toBe(byZ.length)

    const s = setup(1)
    const first = s.r.render(s.input)
    expect(s.r.passing).toBe(true)
    // The first frame shows the cards drawn so far: some, never all.
    expect(first.cards ?? 0).toBeGreaterThan(0)
    expect(first.cards ?? 0).toBeLessThan(byZ.length)
    const frames = 1 + finish(s.r, s.input)
    expect(s.r.passing).toBe(false)
    expect(frames).toBeGreaterThan(3)
    // Every card, thread and pin the whole redraw traces, each once.
    expect(traced(s.made)).toEqual(traced(whole.made))
    // Done: the next frame blits it and draws nothing into the layers again.
    for (const f of s.made) f.calls.length = 0
    const after = s.r.render(s.input)
    expect(after.staticRedrawn).toBe(false)
    expect(after.cards).toBe(byZ.length)
    expect(traced(s.made)).toEqual([])
  })

  it('a frame of the pass traces at most what its budget allows', () => {
    const s = setup(1)
    let most = 0
    do {
      for (const f of s.made) f.calls.length = 0
      s.r.render(s.input)
      most = Math.max(most, traced(s.made).length)
    } while (s.r.passing)
    // The whole picture's geometry, for scale: a frame traces a small share of it.
    const whole = setup(0)
    whole.r.render(whole.input)
    expect(most).toBeLessThan(traced(whole.made).length / 3)
  })

  it('a board change during the pass lets it finish, then draws once more', () => {
    const s = setup(1)
    s.r.render(s.input)
    s.r.invalidateStatic()
    finish(s.r, s.input)
    // The change came after the pass began: another pass follows, over the cache just made.
    s.r.render(s.input)
    expect(s.r.passing).toBe(true)
    for (const f of s.made) f.calls.length = 0
    finish(s.r, s.input)
    expect(s.r.passing).toBe(false)
    const again = s.r.render(s.input)
    expect(again.staticRedrawn).toBe(false)
  })

  it('a zoom during the pass starts it again, the last whole picture scaled meanwhile', () => {
    const s = setup(1)
    finish(s.r, s.input)
    s.yarn.calls.length = 0
    const zoomed = { ...s.input, camera: { ...camera, zoom: camera.zoom * 1.25 } }
    s.r.render(zoomed)
    expect(s.r.passing).toBe(true)
    // The visible layer shows the whole picture made at the old zoom, drawn 1.25× larger.
    const blit = s.yarn.calls.find((c) => c.name === 'drawImage' && c.args.length === 5)
    expect(blit).toBeDefined()
    const [, , , w] = (blit as RecordedCall).args as [unknown, number, number, number]
    const src = s.made[0]?.canvas as HTMLCanvasElement
    expect(w).toBeCloseTo(src.width * 1.25, 6)
    finish(s.r, zoomed)
    expect(s.r.render(zoomed).staticRedrawn).toBe(false)
  })

  // The last whole picture shown under a pass was taken as it was,
  // whatever was drawn live then and now. A card that began to move (a drag in the card overview)
  // showed twice for the pass, its static copy left where it was; one put down vanished for it.
  describe('the last whole picture, shown under a pass begun by what is drawn live', () => {
    /** Calls and the composite mode each ran under, in order. */
    function ordered() {
      const log: Array<{ name: string; args: unknown[]; op: string }> = []
      let op = 'source-over'
      const saved: string[] = []
      const ctx = new Proxy(
        {},
        {
          get(_t, prop) {
            const name = String(prop)
            if (name === 'globalCompositeOperation') return op
            return (...args: unknown[]) => {
              if (name === 'save') saved.push(op)
              if (name === 'restore') op = saved.pop() ?? 'source-over'
              log.push({ name, args, op })
            }
          },
          set(_t, prop, value) {
            if (prop === 'globalCompositeOperation') op = String(value)
            return true
          },
        },
      )
      const canvas = { width: 0, height: 0, getContext: () => ctx }
      return { canvas: canvas as unknown as HTMLCanvasElement, log }
    }
    const moved = byZ[Math.floor(byZ.length / 2)] as string
    const shifted = (id: string) => {
      const sh = shapeOf(id)
      if (sh === undefined || id !== moved) return sh
      return {
        ...sh,
        rect: { ...sh.rect, x: sh.rect.x + 3000, y: sh.rect.y + 2000 },
        pivot: { x: sh.pivot.x + 3000, y: sh.pivot.y + 2000 },
      }
    }
    const map = screenMapper(camera, 1, ORIGIN)
    const cornersAt = (id: string, of: typeof shapeOf) => {
      const n = state.notes.get(id)
      const sh = of(id)
      if (n === undefined || sh === undefined) throw new Error('no note')
      return cardShape(n, sh).corners.map(map)
    }
    /** Whether `log` traced a polygon starting at `at` under composite mode `op`. */
    const tracedAt = (
      log: ReturnType<typeof ordered>['log'],
      at: { x: number; y: number },
      op: string,
    ) =>
      log.some(
        (c) =>
          c.name === 'moveTo' &&
          c.op === op &&
          Math.abs((c.args[0] as number) - at.x) < 1.5 &&
          Math.abs((c.args[1] as number) - at.y) < 1.5,
      )

    function drawn() {
      const yarn = ordered()
      const pins = ordered()
      const r = new YarnRenderer(yarn.canvas, pins.canvas, () => fakeCanvas().canvas, {
        now: ticking(),
        overviewItemMs: 1,
        overviewPiece: 64,
      })
      r.resize(viewport, 1)
      const { input } = setup(1)
      finish(r, input)
      expect(r.passing).toBe(false)
      return { r, input, yarn }
    }

    it('a card that begins to move is not left in it where it was', () => {
      const { r, input, yarn } = drawn()
      const drag = {
        ...input,
        paperOf: shifted,
        dynamicNotes: new Set([moved]),
        geometryKey: {},
      }
      yarn.log.length = 0
      r.render(drag)
      expect(r.passing).toBe(true)
      // Its static copy is taken out of the picture shown, where the picture drew it...
      const was = cornersAt(moved, shapeOf)[0] as { x: number; y: number }
      expect(tracedAt(yarn.log, was, 'destination-out')).toBe(true)
      // ...and the card is drawn live where it is now.
      const now = cornersAt(moved, shifted)[0] as { x: number; y: number }
      expect(tracedAt(yarn.log, now, 'source-over')).toBe(true)
    })

    it('a card put down shows where it lies while the pass that draws it there runs', () => {
      const { r, input, yarn } = drawn()
      const drag = { ...input, paperOf: shifted, dynamicNotes: new Set([moved]), geometryKey: {} }
      finish(r, drag)
      expect(r.passing).toBe(false)
      const down = { ...drag, dynamicNotes: new Set<string>() }
      yarn.log.length = 0
      r.render(down)
      expect(r.passing).toBe(true)
      const now = cornersAt(moved, shifted)[0] as { x: number; y: number }
      expect(tracedAt(yarn.log, now, 'source-over')).toBe(true)
    })
  })
})
