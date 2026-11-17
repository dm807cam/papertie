import { EASE, MOTION } from '../styles/motion'
import { type Camera, clampZoom, screenToWorld } from './Camera'
import type { FrameLoop } from './FrameLoop'
import type { Point } from './types'

/** `moving` stays true this long after the last camera change. */
export const MOVING_TAIL_MS = 150

interface Anim {
  from: Camera
  to: Camera
  ms: number
  start: number | null
  /** The screen point both cameras map to the same world point, when the zoom changes. */
  fixed: { s: Point; w: Point } | null
}

function sanitize(c: Camera): Camera | null {
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.zoom)) return null
  if (c.zoom <= 0) return null
  return { x: c.x, y: c.y, zoom: clampZoom(c.zoom) }
}

const same = (a: Camera, b: Camera) => a.x === b.x && a.y === b.y && a.zoom === b.zoom

/**
 * Owns the camera outside React. `set` and `animateTo` only record the wish and request a frame;
 * the frame applies the camera once and calls the `onApply` listeners, however many changes came
 * in between.
 */
export class CameraController {
  private pending: Camera
  private applied: Camera | null = null
  private force = false
  private anim: Anim | null = null
  private isMoving = false
  private lastChange: number | null = null
  private readonly listeners = new Set<(c: Camera) => void>()
  private readonly removeTask: () => void

  constructor(
    initial: Camera,
    private readonly loop: FrameLoop,
  ) {
    this.pending = sanitize(initial) ?? { x: 0, y: 0, zoom: 1 }
    this.removeTask = loop.add((dt, now) => this.frame(dt, now))
    loop.request()
  }

  /** The latest camera, including changes not yet applied. */
  get(): Camera {
    return this.pending
  }

  /** Where the camera is heading: the animation target, or `get()`. */
  target(): Camera {
    return this.anim?.to ?? this.pending
  }

  /** Jump to `next` on the next frame, cancelling any animation. Non-finite cameras are ignored. */
  set(next: Camera): void {
    const c = sanitize(next)
    if (c === null) return
    this.anim = null
    if (same(c, this.pending)) return
    this.pending = c
    this.isMoving = true
    this.loop.request()
  }

  /** Ease to `target` over `ms` with EASE, or jump when `reduced`. */
  animateTo(target: Camera, reduced: boolean, ms: number = MOTION.slow): void {
    const to = sanitize(target)
    if (to === null) return
    if (reduced || !(ms > 0) || same(to, this.pending)) {
      this.set(to)
      return
    }
    const from = this.pending
    let fixed: Anim['fixed'] = null
    if (Math.abs(Math.log(to.zoom / from.zoom)) > 1e-6) {
      const k = 1 / from.zoom - 1 / to.zoom
      const s = { x: (to.x - from.x) / k, y: (to.y - from.y) / k }
      fixed = { s, w: screenToWorld(from, s) }
    }
    this.anim = { from, to, ms, start: null, fixed }
    this.isMoving = true
    this.loop.request()
  }

  /** Call `fn` inside the frame whenever the camera or `moving` changes. */
  onApply(fn: (c: Camera) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Re-run the `onApply` listeners on the next frame without changing the camera. */
  refresh(): void {
    this.force = true
    this.loop.request()
  }

  /** True from a change until MOVING_TAIL_MS after the last one. */
  get moving(): boolean {
    return this.isMoving
  }

  dispose(): void {
    this.removeTask()
    this.listeners.clear()
    this.anim = null
  }

  private frame(dt: number, now: number): boolean {
    if (this.anim !== null) this.step(this.anim, dt, now)
    const changed = this.applied !== this.pending
    if (changed || this.force) {
      this.applied = this.pending
      this.force = false
      if (changed && this.isMoving) this.lastChange = now
      this.emit(this.applied)
    }
    if (this.isMoving && this.anim === null) {
      this.lastChange ??= now
      if (now - this.lastChange >= MOVING_TAIL_MS) {
        this.isMoving = false
        this.lastChange = null
        this.emit(this.applied ?? this.pending)
      }
    }
    return this.isMoving || this.anim !== null
  }

  private step(a: Anim, dt: number, now: number): void {
    a.start ??= now - Math.min(dt * 1000, 1000 / 60)
    const t = (now - a.start) / a.ms
    if (!(t < 1)) {
      this.anim = null
      this.pending = a.to
      return
    }
    const e = EASE(Math.max(0, t))
    if (a.fixed === null) {
      this.pending = {
        x: a.from.x + (a.to.x - a.from.x) * e,
        y: a.from.y + (a.to.y - a.from.y) * e,
        zoom: a.from.zoom + (a.to.zoom - a.from.zoom) * e,
      }
      return
    }
    const zoom = a.from.zoom * (a.to.zoom / a.from.zoom) ** e
    const { s, w } = a.fixed
    this.pending = { x: w.x - s.x / zoom, y: w.y - s.y / zoom, zoom }
  }

  private emit(c: Camera): void {
    for (const fn of [...this.listeners]) fn(c)
  }
}
