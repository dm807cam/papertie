import { FrameLoop } from '../src/canvas/FrameLoop'
import {
  dragPoint,
  GESTURE,
  panDelta,
  RafRecorder,
  ZoomDriver,
  ZoomToDriver,
} from '../src/perf/benchGestures'
import { FrameStats, loopSampler } from '../src/perf/frameStats'
import { fakeRaf } from './helpers/fakeRaf'

describe('bench gestures', () => {
  it('pan wheels 6·sin(t) across and 4 down per frame', () => {
    expect(panDelta(0)).toEqual({ deltaX: 0, deltaY: 4 })
    expect(panDelta(Math.PI / 2).deltaX).toBeCloseTo(6, 9)
  })

  it('zoom steps ±4, reversing every second and at the 0.25..2 bounds', () => {
    const z = new ZoomDriver()
    let zoom = 1
    let t = 0
    const signs: number[] = []
    for (let i = 0; i < 600; i++, t += 16) {
      const dy = z.next(t, zoom)
      expect(Math.abs(dy)).toBe(GESTURE.zoomDeltaY)
      zoom *= Math.exp(-dy * 0.01)
      expect(zoom).toBeGreaterThanOrEqual(GESTURE.zoomMin)
      expect(zoom).toBeLessThanOrEqual(GESTURE.zoomMax)
      signs.push(Math.sign(dy))
    }
    expect(new Set(signs)).toEqual(new Set([1, -1]))
    // Never more than a second without a reversal.
    let run = 0
    for (let i = 1; i < signs.length; i++) {
      run = signs[i] === signs[i - 1] ? run + 1 : 0
      expect(run * 16).toBeLessThanOrEqual(1000)
    }
  })

  it('a swept pan reverses its vertical wheel every sweepSec, so it stays over one stretch', () => {
    expect(panDelta(0, 1).deltaY).toBe(GESTURE.panDeltaY)
    expect(panDelta(0.99, 1).deltaY).toBe(GESTURE.panDeltaY)
    expect(panDelta(1, 1).deltaY).toBe(-GESTURE.panDeltaY)
    expect(panDelta(2.5, 1).deltaY).toBe(GESTURE.panDeltaY)
    expect(panDelta(1.5, 1).deltaX).toBe(panDelta(1.5).deltaX)
    // 60 frames a second for 6 s: it never travels more than one sweep's distance from the start.
    let y = 0
    for (let i = 0; i < 360; i++) {
      y += panDelta(i / 60, 1).deltaY
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(GESTURE.panDeltaY * 60)
    }
    // A sweep of 0, negative or not finite is the plain drift.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(panDelta(1.5, bad).deltaY).toBe(GESTURE.panDeltaY)
  })

  it('zoom keeps to a given band, and walks into it from outside', () => {
    const band = { min: 0.025, max: 0.12 }
    const z = new ZoomDriver(band)
    let zoom = 0.0214
    let t = 0
    let inside = false
    for (let i = 0; i < 600; i++, t += 16) {
      zoom *= Math.exp(-z.next(t, zoom) * 0.01)
      if (zoom >= band.min) inside = true
      if (inside) {
        expect(zoom).toBeGreaterThanOrEqual(band.min)
        expect(zoom).toBeLessThanOrEqual(band.max)
      }
    }
    expect(inside).toBe(true)
  })

  it('zoom-to steps the wheel toward a target zoom and stops once it is reached', () => {
    const out = new ZoomToDriver(0.16)
    let zoom = 4
    let steps = 0
    for (let dy = out.next(zoom); dy !== null; dy = out.next(zoom)) {
      expect(dy).toBe(GESTURE.zoomDeltaY)
      zoom *= Math.exp(-dy * 0.01)
      steps++
      expect(steps).toBeLessThan(200)
    }
    expect(zoom).toBeLessThanOrEqual(0.16)
    // At most one wheel step past the target.
    expect(zoom).toBeGreaterThan(0.16 * Math.exp(-GESTURE.zoomDeltaY * 0.01) - 1e-12)
    expect(steps).toBe(Math.ceil(Math.log(4 / 0.16) / (GESTURE.zoomDeltaY * 0.01)))
    expect(out.next(zoom)).toBeNull()

    const into = new ZoomToDriver(2)
    expect(into.next(0.5)).toBe(-GESTURE.zoomDeltaY)
    expect(into.next(2)).toBeNull()
    expect(new ZoomToDriver(Number.NaN).next(1)).toBeNull()
  })

  it('zoom-to gives up after twice the steps the distance needs, if the zoom does not move', () => {
    const stuck = new ZoomToDriver(0.16)
    const needed = Math.ceil(Math.log(4 / 0.16) / (GESTURE.zoomDeltaY * 0.01))
    let steps = 0
    while (stuck.next(4) !== null) {
      steps++
      expect(steps).toBeLessThanOrEqual(2 * needed)
    }
    expect(steps).toBe(2 * needed)
    expect(stuck.capped).toBe(true)
    expect(stuck.next(0.1)).toBeNull()
    // Reaching the target is not capping.
    const fine = new ZoomToDriver(0.5)
    let zoom = 1
    for (let dy = fine.next(zoom); dy !== null; dy = fine.next(zoom)) zoom *= Math.exp(-dy * 0.01)
    expect(fine.capped).toBe(false)
  })

  it('drag starts at the press point and circles 220 px at 0.5 rev/s', () => {
    const start = { x: 600, y: 400 }
    expect(dragPoint(start, 0)).toEqual(start)
    const half = dragPoint(start, 1)
    expect(half.x).toBeCloseTo(600 - 2 * GESTURE.dragRadius, 9)
    expect(half.y).toBeCloseTo(400, 9)
    const full = dragPoint(start, 2)
    expect(full.x).toBeCloseTo(600, 9)
    expect(full.y).toBeCloseTo(400, 9)
  })

  it('the loop sampler records only intervals between back-to-back frames', () => {
    const r = fakeRaf()
    const loop = new FrameLoop(r.raf, r.now)
    const stats = new FrameStats()
    loop.add(loopSampler(stats))
    let frames = 3
    loop.add(() => --frames > 0)
    loop.request()
    r.drain(20)
    expect(stats.snapshot()).toMatchObject({ frames: 2, p95FrameMs: 20 })
    // An idle gap is not a frame interval.
    r.frame(5000)
    frames = 2
    loop.request()
    r.drain(10)
    expect(stats.snapshot()).toMatchObject({ frames: 3, longFrames: 0 })
  })
})

describe('RafRecorder', () => {
  it('records rAF intervals until stopped, and a restart runs one chain', () => {
    const r = fakeRaf()
    const rec = new RafRecorder(r.raf)
    rec.start()
    for (let i = 0; i < 5; i++) r.frame(20)
    expect(rec.stop()).toMatchObject({ frames: 4, p95FrameMs: 20 })
    rec.start()
    rec.stop()
    rec.start()
    for (let i = 0; i < 4; i++) r.frame(10)
    expect(r.pending).toBe(1)
    expect(rec.stop()).toMatchObject({ frames: 3, p95FrameMs: 10 })
    r.frame(10)
    expect(r.pending).toBe(0)
  })
})
