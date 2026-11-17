import { panBy, ZOOM_MAX, ZOOM_MIN, zoomAt } from '../src/canvas/Camera'
import { interpretWheel, WHEEL, type WheelLike } from '../src/interactions/wheel'

const at = { x: 400, y: 300 }
const pan = { wheel: 'pan' } as const
const wheel = (o: Partial<WheelLike>): WheelLike => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  ...o,
})

function factorOf(e: WheelLike, prefs: { wheel: 'pan' | 'zoom' } = pan): number {
  const i = interpretWheel(e, at, 800, prefs)
  if (i.kind !== 'zoom') throw new Error(`expected zoom, got ${i.kind}`)
  expect(i.at).toEqual(at)
  return i.factor
}

describe('interpretWheel', () => {
  it('has the documented constants', () => {
    expect(WHEEL).toEqual({ zoomPerPx: 0.01, maxStepPx: 50, linePx: 16 })
  })

  it('trackpad pinch (ctrlKey, deltaY -3) zooms by exp(0.03)', () => {
    expect(factorOf(wheel({ deltaY: -3, ctrlKey: true }))).toBeCloseTo(Math.exp(0.03), 12)
  })

  it('mouse ctrl+wheel notch (deltaY 120) zooms by exp(-0.5), never past ×2 per event', () => {
    expect(factorOf(wheel({ deltaY: 120, ctrlKey: true }))).toBeCloseTo(Math.exp(-0.5), 12)
    expect(factorOf(wheel({ deltaY: -120, metaKey: true }))).toBeCloseTo(Math.exp(0.5), 12)
    for (const deltaY of [1e9, -1e9, 3, -3, 50, -50]) {
      for (const deltaMode of [0, 1, 2]) {
        const f = factorOf(wheel({ deltaY, deltaMode, ctrlKey: true }))
        expect(f).toBeLessThanOrEqual(2)
        expect(f).toBeGreaterThanOrEqual(0.5)
      }
    }
  })

  it('line mode deltaY 3 pans 48 px', () => {
    expect(interpretWheel(wheel({ deltaY: 3, deltaMode: 1 }), at, 800, pan)).toEqual({
      kind: 'pan',
      dx: 0,
      dy: -48,
    })
  })

  it('page mode uses viewport height', () => {
    expect(interpretWheel(wheel({ deltaX: 1, deltaY: -1, deltaMode: 2 }), at, 800, pan)).toEqual({
      kind: 'pan',
      dx: -800,
      dy: 800,
    })
  })

  it('pixel mode pans by the negated deltas, so content follows the gesture', () => {
    expect(interpretWheel(wheel({ deltaX: 12, deltaY: 200 }), at, 800, pan)).toEqual({
      kind: 'pan',
      dx: -12,
      dy: -200,
    })
  })

  it('wheel pref "zoom" zooms on plain wheel', () => {
    expect(factorOf(wheel({ deltaY: 10 }), { wheel: 'zoom' })).toBeCloseTo(Math.exp(-0.1), 12)
  })

  it('NaN and Infinity deltas pan by 0', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(interpretWheel(wheel({ deltaX: bad, deltaY: bad }), at, 800, pan)).toEqual({
        kind: 'pan',
        dx: 0,
        dy: 0,
      })
      expect(factorOf(wheel({ deltaY: bad, ctrlKey: true }))).toBe(1)
    }
  })

  it('a bad viewport height in page mode pans by 0, and the camera stays finite', () => {
    let cam = { x: 0, y: 0, zoom: 1 }
    for (const h of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const i = interpretWheel(wheel({ deltaY: 1, deltaMode: 2 }), at, h, pan)
      expect(i).toEqual({ kind: 'pan', dx: 0, dy: 0 })
    }
    for (let k = 0; k < 200; k++) {
      const i = interpretWheel(
        wheel({ deltaY: k % 2 ? 1e308 : -1e308, ctrlKey: true }),
        at,
        800,
        pan,
      )
      if (i.kind === 'zoom') cam = zoomAt(cam, i.at, cam.zoom * i.factor)
      cam = panBy(cam, 1e300, -1e300)
      expect(Number.isFinite(cam.x) && Number.isFinite(cam.y)).toBe(true)
      expect(cam.zoom).toBeGreaterThanOrEqual(ZOOM_MIN)
      expect(cam.zoom).toBeLessThanOrEqual(ZOOM_MAX)
    }
  })
})
