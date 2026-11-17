import { type Camera, screenToWorld, zoomAt } from '../src/canvas/Camera'
import { CameraController, MOVING_TAIL_MS } from '../src/canvas/CameraController'
import { FrameLoop } from '../src/canvas/FrameLoop'
import { MOTION } from '../src/styles/motion'
import { fakeRaf } from './helpers/fakeRaf'

const start: Camera = { x: 0, y: 0, zoom: 1 }

function setup(initial = start) {
  const r = fakeRaf()
  const loop = new FrameLoop(r.raf, r.now)
  const cam = new CameraController(initial, loop)
  const applied: Camera[] = []
  cam.onApply((c) => applied.push(c))
  return { r, loop, cam, applied }
}

describe('CameraController', () => {
  it('applies the initial camera on the first frame without counting it as movement', () => {
    const { r, cam, applied } = setup()
    expect(r.pending).toBe(1)
    r.frame()
    expect(applied).toEqual([start])
    expect(cam.moving).toBe(false)
    expect(r.pending).toBe(0)
  })

  it('applies once per frame however many set() calls', () => {
    const { r, cam, applied } = setup()
    r.frame()
    applied.length = 0
    for (let i = 1; i <= 5; i++) cam.set({ x: i, y: 0, zoom: 1 })
    expect(cam.get()).toEqual({ x: 5, y: 0, zoom: 1 })
    expect(applied).toEqual([])
    r.frame()
    expect(applied).toEqual([{ x: 5, y: 0, zoom: 1 }])
  })

  it('set() ignores non-finite cameras and clamps zoom', () => {
    const { cam } = setup()
    cam.set({ x: Number.NaN, y: 0, zoom: 1 })
    cam.set({ x: 0, y: 0, zoom: Number.POSITIVE_INFINITY })
    expect(cam.get()).toEqual(start)
    cam.set({ x: 1, y: 2, zoom: 50 })
    expect(cam.get()).toEqual({ x: 1, y: 2, zoom: 2 })
  })

  it('moving is false 150 ms after the last change', () => {
    const { r, loop, cam, applied } = setup()
    r.frame()
    expect(MOVING_TAIL_MS).toBe(150)
    cam.set({ x: 10, y: 0, zoom: 1 })
    expect(cam.moving).toBe(true)
    r.frame(10)
    const changedAt = r.now()
    applied.length = 0
    while (r.now() - changedAt < 140) r.frame(10)
    expect(cam.moving).toBe(true)
    expect(loop.running).toBe(true)
    r.frame(10)
    r.frame(10)
    expect(r.now() - changedAt).toBeGreaterThanOrEqual(150)
    expect(cam.moving).toBe(false)
    expect(applied).toEqual([{ x: 10, y: 0, zoom: 1 }])
    r.drain()
    expect(loop.running).toBe(false)
  })

  it('notifies onApply when moving ends, then the loop idles', () => {
    const { r, loop, cam } = setup()
    r.frame()
    const states: boolean[] = []
    cam.onApply(() => states.push(cam.moving))
    cam.set({ x: 1, y: 1, zoom: 1 })
    r.drain(16)
    expect(states).toEqual([true, false])
    expect(loop.running).toBe(false)
  })

  it('animateTo with reduced jumps in one frame', () => {
    const { r, cam, applied } = setup()
    r.frame()
    applied.length = 0
    const target = { x: 300, y: -40, zoom: 2 }
    cam.animateTo(target, true)
    r.frame()
    expect(applied).toEqual([target])
    expect(cam.get()).toEqual(target)
  })

  it('animateTo eases to the exact target in MOTION.slow', () => {
    const { r, cam, applied } = setup()
    r.frame()
    applied.length = 0
    const target = { x: 300, y: -40, zoom: 2 }
    const called = r.now()
    cam.animateTo(target, false)
    expect(cam.target()).toEqual(target)
    while (r.now() - called < MOTION.slow - 20) r.frame(16)
    const mid = applied.at(-1) as Camera
    expect(mid).not.toEqual(target)
    r.frame(16)
    r.frame(16)
    expect(cam.get()).toEqual(target)
    expect(applied.at(-1)).toEqual(target)
  })

  it('animating a zoom about a point keeps that point fixed throughout', () => {
    const { r, cam, applied } = setup({ x: 40, y: 80, zoom: 0.8 })
    r.frame()
    const centre = { x: 500, y: 300 }
    const anchor = screenToWorld(cam.get(), centre)
    cam.animateTo(zoomAt(cam.get(), centre, 0.8 * 1.25), false)
    r.drain(16)
    expect(applied.length).toBeGreaterThan(5)
    for (const c of applied) {
      const w = screenToWorld(c, centre)
      expect(w.x).toBeCloseTo(anchor.x, 9)
      expect(w.y).toBeCloseTo(anchor.y, 9)
    }
  })

  it('set() during an animation cancels it', () => {
    const { r, cam } = setup()
    r.frame()
    cam.animateTo({ x: 500, y: 0, zoom: 1 }, false)
    r.frame()
    r.frame()
    cam.set({ x: -7, y: 0, zoom: 1 })
    r.drain()
    expect(cam.get()).toEqual({ x: -7, y: 0, zoom: 1 })
  })

  it('refresh() re-applies the unchanged camera without moving', () => {
    const { r, cam, applied } = setup()
    r.frame()
    applied.length = 0
    cam.refresh()
    r.frame()
    expect(applied).toEqual([start])
    expect(cam.moving).toBe(false)
  })

  it('dispose() stops applying', () => {
    const { r, cam, applied } = setup()
    r.frame()
    applied.length = 0
    cam.dispose()
    cam.set({ x: 3, y: 3, zoom: 1 })
    r.drain()
    expect(applied).toEqual([])
  })
})
