import { LIMITS } from '@papertie/core'
import fc from 'fast-check'
import {
  ANCHOR_REACH_PX,
  anchorFor,
  anchorScreen,
  type Camera,
  cameraTransform,
  drawnCamera,
  needsRebase,
  ORIGIN,
  panBy,
  screenMapper,
  snapToDevice,
  worldToScreen,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../src/canvas/Camera'
import type { Point } from '../src/canvas/types'
import { noteStyle } from '../src/notes/noteStyle'

const viewport = { width: 1280, height: 720 }
const M = LIMITS.maxCoord
const coord = fc.double({ min: -M, max: M, noNaN: true })
const zoom = fc.double({ min: ZOOM_MIN, max: ZOOM_MAX, noNaN: true })
const dpr = fc.constantFrom(1, 1.5, 2, 3)
const camera = fc.record({ x: coord, y: coord, zoom }) as fc.Arbitrary<Camera>

/** The camera whose viewport centre is `p`. */
const centredOn = (p: Point, z: number): Camera => ({
  x: p.x - viewport.width / 2 / z,
  y: p.y - viewport.height / 2 / z,
  zoom: z,
})

/** What the runtime does each apply: keep the anchor until the camera leaves its reach. */
const follow = (a: Point, c: Camera) => (needsRebase(c, viewport, a) ? anchorFor(c, viewport) : a)

describe('floating origin', () => {
  it('rebases past ANCHOR_REACH_PX: world px up to zoom 1, screen px above', () => {
    const a = { x: 9_000_000, y: -9_000_000 }
    for (const z of [0.1, 0.5, 1]) {
      expect(needsRebase(centredOn({ x: a.x + ANCHOR_REACH_PX, y: a.y }, z), viewport, a)).toBe(
        false,
      )
      expect(needsRebase(centredOn({ x: a.x, y: a.y - ANCHOR_REACH_PX - 1 }, z), viewport, a)).toBe(
        true,
      )
    }
    for (const z of [2, 4]) {
      const reach = ANCHOR_REACH_PX / z
      expect(needsRebase(centredOn({ x: a.x - reach, y: a.y }, z), viewport, a)).toBe(false)
      expect(needsRebase(centredOn({ x: a.x - reach - 0.5, y: a.y }, z), viewport, a)).toBe(true)
    }
  })

  it('anchors at the viewport centre in whole world px, which never needs a rebase', () => {
    fc.assert(
      fc.property(camera, (c) => {
        const a = anchorFor(c, viewport)
        expect(Number.isInteger(a.x) && Number.isInteger(a.y)).toBe(true)
        expect(needsRebase(c, viewport, a)).toBe(false)
      }),
    )
  })

  it('keeps what the GPU sees small anywhere up to ±maxCoord', () => {
    fc.assert(
      fc.property(camera, zoom, dpr, (c, z, d) => {
        // Any camera the anchor still serves: a rebase-free move from the anchoring one.
        const a = anchorFor(c, viewport)
        const moved = { ...c, zoom: z }
        const used = follow(a, moved)
        const o = anchorScreen(moved, used, d)
        const bound = ANCHOR_REACH_PX * Math.min(1, moved.zoom) + viewport.width
        expect(Math.abs(o.x)).toBeLessThanOrEqual(bound)
        expect(Math.abs(o.y)).toBeLessThanOrEqual(bound)
        // A note at the viewport centre is placed within the reach of the anchor.
        const n = {
          id: 'note_x',
          x: moved.x + 640 / z,
          y: moved.y + 360 / z,
          w: 200,
          h: 100,
          style: 'rustic' as const,
        }
        const m = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(
          noteStyle(n, false, used).transform,
        )
        expect(Math.abs(Number(m?.[1]))).toBeLessThanOrEqual(ANCHOR_REACH_PX + 1)
        expect(Math.abs(Number(m?.[2]))).toBeLessThanOrEqual(ANCHOR_REACH_PX + 1)
      }),
    )
  })

  it('round-trips world -> screen -> world through the drawn camera at ±maxCoord', () => {
    fc.assert(
      fc.property(camera, dpr, fc.double({ min: -2000, max: 2000, noNaN: true }), (c, d, off) => {
        const a = anchorFor(c, viewport)
        const w = { x: c.x + off, y: c.y - off }
        const s = screenMapper(c, d, a)(w)
        const dc = drawnCamera(c, d, a)
        const viaCamera = worldToScreen(dc, w)
        expect(Math.abs(s.x - viaCamera.x)).toBeLessThan(1e-6)
        expect(Math.abs(s.y - viaCamera.y)).toBeLessThan(1e-6)
        const back = { x: s.x / dc.zoom + dc.x, y: s.y / dc.zoom + dc.y }
        // Doubles at 1e7 hold ~2e-9; the screen error is that times the zoom.
        expect(Math.abs(back.x - w.x) * c.zoom).toBeLessThan(1e-6)
        expect(Math.abs(back.y - w.y) * c.zoom).toBeLessThan(1e-6)
        // And the drawn camera is the real one up to the device snap.
        expect(Math.abs(dc.x - c.x) * c.zoom).toBeLessThanOrEqual(0.5 / d + 1e-6)
      }),
    )
  })

  it('draws the same pixels after a rebase, to the device snap', () => {
    fc.assert(
      fc.property(camera, dpr, fc.integer({ min: -50_000, max: 50_000 }), (c, d, shift) => {
        const a = anchorFor(c, viewport)
        const b = { x: a.x + shift, y: a.y - shift }
        const w = { x: c.x + 123.25, y: c.y + 45.5 }
        const pa = screenMapper(c, d, a)(w)
        const pb = screenMapper(c, d, b)(w)
        expect(Math.abs(pa.x - pb.x)).toBeLessThanOrEqual(1 / d + 1e-6)
        expect(Math.abs(pa.y - pb.y)).toBeLessThanOrEqual(1 / d + 1e-6)
      }),
    )
    // At a whole zoom (and whole-px anchors) a rebase moves nothing at all.
    const c = { x: 9_811_000.37, y: -9_811_000.61, zoom: 4 }
    const w = { x: 9_811_100, y: -9_810_900 }
    expect(screenMapper(c, 2, { x: 9_811_000, y: -9_811_000 })(w)).toEqual(
      screenMapper(c, 2, { x: 9_815_123, y: -9_805_000 })(w),
    )
  })

  it('does not drift over many rebases: a long pan out and back lands where it began', () => {
    const start = { x: M - 4000.37, y: -M + 3000.61, zoom: 4 }
    const w = { x: M - 3800, y: -M + 3100 }
    let c: Camera = start
    let a = anchorFor(c, viewport)
    const first = screenMapper(c, 2, a)(w)
    let rebases = 0
    const steps: Array<[number, number]> = []
    for (let k = 0; k < 400; k++) steps.push([997.3, -611.9])
    for (const [dx, dy] of [...steps, ...steps.map(([x, y]): [number, number] => [-x, -y])]) {
      c = panBy(c, dx, dy)
      const next = follow(a, c)
      if (next !== a) rebases++
      a = next
      // Every frame: the anchored mapping equals the plain double one, to the device snap.
      const p = screenMapper(c, 2, a)(w)
      const plain = worldToScreen(c, w)
      expect(Math.abs(p.x - plain.x)).toBeLessThanOrEqual(0.5 / 2 + 1e-6)
      expect(Math.abs(p.y - plain.y)).toBeLessThanOrEqual(0.5 / 2 + 1e-6)
    }
    expect(rebases).toBeGreaterThan(10)
    // The anchor is a function of the camera, never accumulated: back home, the same pixels.
    expect(Math.abs(c.x - start.x)).toBeLessThan(1e-6)
    expect(Math.abs(screenMapper(c, 2, a)(w).x - first.x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(screenMapper(c, 2, a)(w).y - first.y)).toBeLessThanOrEqual(0.5)
  })

  it('defaults to the world origin, as before the floating origin', () => {
    const c = { x: 10.3, y: -4.1, zoom: 0.5 }
    expect(cameraTransform(c, 2)).toBe(cameraTransform(c, 2, ORIGIN))
    expect(cameraTransform(c, 2)).toBe(
      `translate3d(${snapToDevice(-c.x * c.zoom, 2)}px, ${snapToDevice(-c.y * c.zoom, 2)}px, 0) scale(0.5)`,
    )
    expect(drawnCamera(c, 2)).toEqual({
      x: -snapToDevice(-c.x * c.zoom, 2) / c.zoom,
      y: -snapToDevice(-c.y * c.zoom, 2) / c.zoom,
      zoom: 0.5,
    })
    const n = {
      id: 'note_x',
      x: 9_811_968,
      y: -9_811_968,
      w: 200,
      h: 100,
      style: 'rustic' as const,
    }
    expect(noteStyle(n, false).transform).toBe('translate(9811968px, -9811968px) rotate(0deg)')
    expect(noteStyle(n, false, { x: 9_811_900, y: -9_812_000 }).transform).toBe(
      'translate(68px, 32px) rotate(0deg)',
    )
  })
})
