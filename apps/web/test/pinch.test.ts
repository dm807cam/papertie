import { type Camera, screenToWorld, ZOOM_MAX, ZOOM_MIN } from '../src/canvas/Camera'
import type { Point } from '../src/canvas/types'
import { pinchCamera } from '../src/interactions/pinch'

const c: Camera = { x: 100, y: 50, zoom: 1 }
const pair = (ax: number, ay: number, bx: number, by: number): [Point, Point] => [
  { x: ax, y: ay },
  { x: bx, y: by },
]

describe('pinchCamera', () => {
  it('spreading fingers ×2 doubles zoom and keeps the midpoint world point fixed', () => {
    const prev = pair(300, 200, 400, 200)
    const next = pair(250, 200, 450, 200)
    const out = pinchCamera(c, prev, next)
    expect(out.zoom).toBeCloseTo(2, 12)
    const mid = { x: 350, y: 200 }
    const before = screenToWorld(c, mid)
    const after = screenToWorld(out, mid)
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  it('the world point under the old midpoint follows to the new midpoint', () => {
    const prev = pair(300, 200, 400, 300)
    const next = pair(320, 260, 520, 460)
    const out = pinchCamera(c, prev, next)
    const before = screenToWorld(c, { x: 350, y: 250 })
    const after = screenToWorld(out, { x: 420, y: 360 })
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  it('moving both fingers by (10,0) pans 10 px', () => {
    const out = pinchCamera({ ...c, zoom: 2 }, pair(300, 200, 400, 200), pair(310, 200, 410, 200))
    expect(out.zoom).toBe(2)
    expect(out.x).toBeCloseTo(100 - 10 / 2, 12)
    expect(out.y).toBeCloseTo(50, 12)
  })

  it('pinching past the limits clamps', () => {
    let cam = c
    for (let i = 0; i < 20; i++) cam = pinchCamera(cam, pair(0, 0, 10, 0), pair(0, 0, 100, 0))
    expect(cam.zoom).toBe(ZOOM_MAX)
    for (let i = 0; i < 40; i++) cam = pinchCamera(cam, pair(0, 0, 100, 0), pair(0, 0, 1, 0))
    expect(cam.zoom).toBe(ZOOM_MIN)
  })

  it('no single event changes zoom by more than ×2', () => {
    expect(pinchCamera(c, pair(0, 0, 1, 0), pair(0, 0, 1000, 0)).zoom).toBeCloseTo(2, 12)
    expect(pinchCamera(c, pair(0, 0, 1000, 0), pair(0, 0, 1, 0)).zoom).toBeCloseTo(0.5, 12)
  })

  it('coincident or non-finite fingers leave the camera finite', () => {
    const same = pinchCamera(c, pair(5, 5, 5, 5), pair(5, 5, 50, 5))
    expect(same.zoom).toBe(1)
    expect(same.x).toBeCloseTo(100 - 22.5, 12)
    expect(pinchCamera(c, pair(0, 0, 10, 0), pair(Number.NaN, 0, 10, 0))).toBe(c)
    expect(pinchCamera(c, pair(0, 0, 10, 0), pair(0, 0, Number.POSITIVE_INFINITY, 0))).toBe(c)
  })
})
