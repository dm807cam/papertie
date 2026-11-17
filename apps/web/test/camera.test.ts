import fc from 'fast-check'
import {
  type Camera,
  cameraTransform,
  clampZoom,
  fitRect,
  fitRectIn,
  panBy,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAt,
} from '../src/canvas/Camera'

const coord = (limit: number) => fc.double({ min: -limit, max: limit, noNaN: true })
const pt = (limit: number) => fc.record({ x: coord(limit), y: coord(limit) })
const zoom = fc.double({ min: ZOOM_MIN, max: ZOOM_MAX, noNaN: true })
const camera = (limit: number) =>
  fc.record({ x: coord(limit), y: coord(limit), zoom }) as fc.Arbitrary<Camera>

const c: Camera = { x: 100, y: -50, zoom: 1 }
const p = { x: 300, y: 200 }

describe('camera', () => {
  it('worldToScreen and screenToWorld are inverse', () => {
    fc.assert(
      fc.property(camera(1e7), pt(1e7), (cam, w) => {
        const back = screenToWorld(cam, worldToScreen(cam, w))
        const scale = Math.max(1, Math.abs(w.x), Math.abs(w.y), Math.abs(cam.x), Math.abs(cam.y))
        expect(Math.abs(back.x - w.x) / scale).toBeLessThan(1e-9)
        expect(Math.abs(back.y - w.y) / scale).toBeLessThan(1e-9)
      }),
    )
  })

  it('worldToScreen is (p - c) * zoom', () => {
    expect(worldToScreen({ x: 10, y: 20, zoom: 2 }, { x: 15, y: 10 })).toEqual({ x: 10, y: -20 })
  })

  it('zoomAt keeps the world point under the pointer fixed', () => {
    fc.assert(
      fc.property(camera(1e6), pt(4000), zoom, (cam, s, next) => {
        const before = screenToWorld(cam, s)
        const after = screenToWorld(zoomAt(cam, s, next), s)
        const scale = Math.max(1, Math.abs(before.x), Math.abs(before.y))
        expect(Math.abs(after.x - before.x) / scale).toBeLessThan(1e-9)
        expect(Math.abs(after.y - before.y) / scale).toBeLessThan(1e-9)
      }),
    )
  })

  it('zoomAt clamps to [0.005, 2] and ignores NaN, Infinity and <= 0', () => {
    // 2× is reading distance: the camera never goes closer than a note needs to be read; 0.005
    // frames a lifetime board whole.
    expect([ZOOM_MIN, ZOOM_MAX]).toEqual([0.005, 2])
    expect(zoomAt(c, p, 0.001).zoom).toBe(0.005)
    expect(zoomAt(c, p, 0.05).zoom).toBe(0.05)
    expect(zoomAt(c, p, 9).zoom).toBe(2)
    expect(zoomAt(c, p, 2.5).zoom).toBe(2)
    for (const z of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) expect(zoomAt(c, p, z)).toBe(c)
  })

  it('clampZoom bounds the range', () => {
    expect(clampZoom(0.001)).toBe(ZOOM_MIN)
    expect(clampZoom(0.01)).toBe(0.01)
    expect(clampZoom(0.05)).toBe(0.05)
    expect(clampZoom(10)).toBe(ZOOM_MAX)
    expect(clampZoom(1.5)).toBe(1.5)
    expect(clampZoom(Number.NaN)).toBe(1)
  })

  it('panBy moves content with the pointer', () => {
    expect(panBy({ x: 0, y: 0, zoom: 2 }, 100, 0).x).toBe(-50)
    expect(panBy({ x: 0, y: 0, zoom: 0.5 }, 0, -10).y).toBe(20)
  })

  it('panBy ignores non-finite deltas', () => {
    const cam = { x: 5, y: 6, zoom: 1 }
    expect(panBy(cam, Number.NaN, Number.POSITIVE_INFINITY)).toEqual(cam)
  })

  it('visibleWorldRect at zoom 0.5', () => {
    expect(visibleWorldRect({ x: 10, y: 20, zoom: 0.5 }, { width: 1000, height: 800 })).toEqual({
      x: 10,
      y: 20,
      w: 2000,
      h: 1600,
    })
  })

  it('visibleWorldRect adds a screen-space margin', () => {
    expect(visibleWorldRect({ x: 0, y: 0, zoom: 2 }, { width: 100, height: 100 }, 20)).toEqual({
      x: -10,
      y: -10,
      w: 70,
      h: 70,
    })
  })

  it('fitRectIn fits a rect into a part of the viewport, centred there', () => {
    const vp = { width: 1280, height: 800 }
    // Right of a 120 px panel, above a 92 px foot.
    const area = { x: 120, y: 0, w: 1160, h: 708 }
    const r = { x: 0, y: 0, w: 900, h: 300 }
    const cam = fitRectIn(r, area, 64)
    expect(cam.zoom).toBeCloseTo((1160 - 128) / 900, 6)
    const toScreen = (x: number, y: number) => ({
      x: (x - cam.x) * cam.zoom,
      y: (y - cam.y) * cam.zoom,
    })
    const a = toScreen(r.x, r.y)
    const b = toScreen(r.x + r.w, r.y + r.h)
    expect(a.x).toBeCloseTo(120 + 64, 6)
    expect(b.x).toBeCloseTo(1280 - 64, 6)
    expect((a.y + b.y) / 2).toBeCloseTo(354, 6)
    // The whole viewport as the area: as fitRect.
    expect(fitRectIn(r, { x: 0, y: 0, w: 1280, h: 800 })).toEqual(fitRect(r, vp))
  })

  it('fitRectIn keeps the zoom within [minZoom, maxZoom], centring the rect at the floor', () => {
    const area = { x: 0, y: 0, w: 400, h: 700 }
    const wide = { x: 0, y: 0, w: 4000, h: 100 }
    const cam = fitRectIn(wide, area, 16, 1, 0.38)
    expect(cam.zoom).toBe(0.38)
    expect((2000 - cam.x) * cam.zoom).toBeCloseTo(200, 6)
    expect(fitRectIn({ x: 0, y: 0, w: 10, h: 10 }, area, 16, 1, 0.38).zoom).toBe(1)
  })

  it('fitRect centres the rect inside the padded viewport', () => {
    const vp = { width: 1000, height: 800 }
    const cam = fitRect({ x: 100, y: 100, w: 436, h: 200 }, vp)
    expect(cam.zoom).toBeCloseTo(2, 12)
    const centre = screenToWorld(cam, { x: 500, y: 400 })
    expect(centre.x).toBeCloseTo(318, 9)
    expect(centre.y).toBeCloseTo(200, 9)
  })

  it('fitRect clamps: null or empty rect → zoom 2; 400000-wide → 0.005', () => {
    const vp = { width: 1000, height: 800 }
    expect(fitRect(null, vp).zoom).toBe(2)
    expect(fitRect({ x: 5, y: 5, w: 0, h: 0 }, vp).zoom).toBe(2)
    // One small note (Shift+2 on it) fits at 3.3× but stops at reading distance.
    expect(fitRect({ x: 0, y: 0, w: 260, h: 190 }, vp).zoom).toBe(2)
    expect(fitRect({ x: 0, y: 0, w: 400000, h: 10 }, vp).zoom).toBe(0.005)
    // A lifetime board (108,000 wide) is no longer clamped: 872 px of room / 108,000.
    expect(fitRect({ x: 0, y: 0, w: 108000, h: 10 }, vp).zoom).toBeCloseTo(872 / 108000, 12)
    const none = fitRect(null, vp)
    expect(Number.isFinite(none.x) && Number.isFinite(none.y)).toBe(true)
  })

  it('fitRect survives a zero-size viewport', () => {
    const cam = fitRect({ x: 0, y: 0, w: 500, h: 500 }, { width: 0, height: 0 })
    expect(cam.zoom).toBe(ZOOM_MIN)
    expect(Number.isFinite(cam.x) && Number.isFinite(cam.y)).toBe(true)
  })

  it('cameraTransform snaps translation to device pixels', () => {
    expect(cameraTransform({ x: 0.3, y: 0, zoom: 1 }, 2)).toBe(
      'translate3d(-0.5px, 0px, 0) scale(1)',
    )
    expect(cameraTransform({ x: 10, y: -4, zoom: 0.5 }, 1)).toBe(
      'translate3d(-5px, 2px, 0) scale(0.5)',
    )
  })

  it('cameraTransform treats a bad dpr as 1', () => {
    expect(cameraTransform({ x: 0.3, y: 0, zoom: 1 }, 0)).toBe('translate3d(0px, 0px, 0) scale(1)')
  })
})
