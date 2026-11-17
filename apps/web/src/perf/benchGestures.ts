import type { Point } from '../canvas/types'
import { FrameStats, type PerfSnapshot } from './frameStats'

/** Wheel pan, ctrl-wheel zoom, drag of a note, or a middle-button drag of the board (grab). */
export type GestureKind = 'pan' | 'zoom' | 'drag' | 'grab'

/** The scripted gestures' timing and shape. */
export const GESTURE = {
  warmupMs: 500,
  durationMs: 4000,
  panDeltaX: 6,
  panDeltaY: 4,
  zoomDeltaY: 4,
  zoomFlipMs: 1000,
  zoomMin: 0.25,
  zoomMax: 2,
  dragRadius: 220,
  dragRevPerSec: 0.5,
  /** After the last step of a zoom-to, frames are recorded this long (the LOD flip, the raster). */
  settleMs: 500,
} as const

/** Per-row changes to a gesture's shape. */
export interface GestureOptions {
  /** The zoom gesture's band (default `GESTURE.zoomMin`..`zoomMax`). */
  zoomMin?: number
  zoomMax?: number
  /** Reverse the pan's vertical wheel every this many seconds, so it sweeps one stretch. */
  sweepSec?: number
  /** Leave a drag or grab pressed at the end; `__papertiePerf.release()` lets it go. */
  hold?: boolean
  /** Drag with Alt (Option) held: a plain move, never a merge with a note it passes. */
  alt?: boolean
}

/**
 * `runGesture`'s options: with `onHold`, a drag or grab ends pressed and hands over its release.
 */
export interface RunOptions extends GestureOptions {
  onHold?: (release: () => void) => void
}

/** Zoom per wheel pixel, as the runtime's `interpretWheel` applies it. */
const ZOOM_PER_PX = 0.01

/**
 * The pan gesture's wheel deltas `tSec` seconds in: 6·sin(t) across and 4 down per frame, or,
 * with a positive finite `sweepSec`, 4 down and 4 up in turns of `sweepSec`.
 */
export function panDelta(tSec: number, sweepSec?: number): { deltaX: number; deltaY: number } {
  const sweep = sweepSec !== undefined && Number.isFinite(sweepSec) && sweepSec > 0
  const down = !sweep || Math.floor(tSec / sweepSec) % 2 === 0
  return {
    deltaX: GESTURE.panDeltaX * Math.sin(tSec),
    deltaY: down ? GESTURE.panDeltaY : -GESTURE.panDeltaY,
  }
}

/**
 * The zoom gesture's ctrl-wheel `deltaY` (positive zooms out): ±4, reversing every second and
 * whenever the next step would leave the band (default 0.25..2). From outside the band it steps
 * toward it.
 */
export class ZoomDriver {
  private sign = -1
  private flippedAt: number | null = null

  constructor(
    private readonly band: { min: number; max: number } = {
      min: GESTURE.zoomMin,
      max: GESTURE.zoomMax,
    },
  ) {}

  next(nowMs: number, zoom: number): number {
    this.flippedAt ??= nowMs
    const after = (s: number) => zoom * Math.exp(-s * GESTURE.zoomDeltaY * ZOOM_PER_PX)
    const out = (s: number) => {
      const z = after(s)
      return z < this.band.min || z > this.band.max
    }
    if (zoom < this.band.min || zoom > this.band.max) {
      this.sign = zoom < this.band.min ? -1 : 1
      this.flippedAt = nowMs
      return this.sign * GESTURE.zoomDeltaY
    }
    if (nowMs - this.flippedAt >= GESTURE.zoomFlipMs || out(this.sign)) {
      if (!out(-this.sign)) this.sign = -this.sign
      this.flippedAt = nowMs
    }
    return this.sign * GESTURE.zoomDeltaY
  }
}

/**
 * A zoom-to's ctrl-wheel `deltaY`: ±4 per frame toward `target`, then null once the zoom has
 * reached it (at most one step past). A non-finite target is reached at once. It gives up
 * (`capped`) after twice the steps the distance from the first zoom needs, so a zoom that stops
 * moving cannot keep it stepping.
 */
export class ZoomToDriver {
  private done: boolean
  private steps = 0
  private cap: number | null = null
  /** It stopped at the step cap, not at the target. */
  capped = false

  constructor(private readonly target: number) {
    this.done = !(Number.isFinite(target) && target > 0)
  }

  next(zoom: number): number | null {
    if (this.done || !(Number.isFinite(zoom) && zoom > 0) || zoom === this.target) {
      this.done = true
      return null
    }
    const perStep = GESTURE.zoomDeltaY * ZOOM_PER_PX
    this.cap ??= 2 * Math.max(1, Math.ceil(Math.abs(Math.log(zoom / this.target)) / perStep))
    if (this.steps >= this.cap) {
      this.done = true
      this.capped = true
      return null
    }
    this.steps++
    const out = zoom > this.target
    const after = zoom * Math.exp((out ? -1 : 1) * GESTURE.zoomDeltaY * ZOOM_PER_PX)
    // The step that reaches the target is the last one.
    if (out ? after <= this.target : after >= this.target) this.done = true
    return out ? GESTURE.zoomDeltaY : -GESTURE.zoomDeltaY
  }
}

/**
 * The drag gesture's pointer `tSec` seconds after the press at `start`: a 220 px circle from it.
 */
export function dragPoint(start: Point, tSec: number): Point {
  const r = GESTURE.dragRadius
  const a = 2 * Math.PI * GESTURE.dragRevPerSec * tSec
  return { x: start.x - r + r * Math.cos(a), y: start.y + r * Math.sin(a) }
}

/** What a scripted gesture drives: the viewport root and, for drag, the note to press. */
export interface GestureTarget {
  root: HTMLElement
  zoom(): number
  /** The note element and the client point on its paper to press, or null when there is none. */
  dragStart(): { el: HTMLElement; client: Point } | null
}

type Raf = (cb: (t: number) => void) => unknown

/** Records rAF timestamp intervals until stopped. */
export class RafRecorder {
  readonly stats = new FrameStats(8192)
  private prev: number | null = null
  /** Bumped by every start and stop, so an earlier rAF chain ends instead of doubling up. */
  private run = 0

  constructor(private readonly raf: Raf = (cb) => requestAnimationFrame(cb)) {}

  start(): void {
    this.stats.reset()
    this.prev = null
    const run = ++this.run
    const tick = (t: number) => {
      if (run !== this.run) return
      this.mark(t)
      this.raf(tick)
    }
    this.raf(tick)
  }

  /** Record one frame at rAF time `t` (for drivers that run their own rAF). */
  mark(t: number): void {
    if (this.prev !== null) this.stats.push(t - this.prev)
    this.prev = t
  }

  stop(): PerfSnapshot {
    this.run++
    this.prev = null
    return this.stats.snapshot()
  }
}

const POINTER = { pointerId: 41, pointerType: 'mouse', isPrimary: true } as const

function pointer(
  type: string,
  p: Point,
  button: number,
  buttons: number,
  altKey = false,
): PointerEvent {
  return new PointerEvent(type, {
    ...POINTER,
    altKey,
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: p.x,
    clientY: p.y,
    button: type === 'pointermove' ? -1 : button,
    buttons,
  })
}

function centreOf(root: HTMLElement): Point {
  const rect = root.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function wheelOn(root: HTMLElement, at: Point, deltaX: number, deltaY: number, ctrlKey: boolean) {
  root.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
      deltaX,
      deltaY,
      deltaMode: 0,
      ctrlKey,
    }),
  )
}

/**
 * Run a scripted gesture through the real input paths: one synthetic event per rAF on the
 * viewport (wheel, grab) or the note and the viewport (drag), so the runtime's own listeners
 * handle it. The first 500 ms warm up; the next `durationMs` of rAF intervals are recorded. The
 * grab is a middle-button drag of the board along the drag circle, from the viewport's centre.
 */
export function runGesture(
  target: GestureTarget,
  kind: GestureKind,
  durationMs: number = GESTURE.durationMs,
  options: RunOptions = {},
  raf: Raf = (cb) => requestAnimationFrame(cb),
): Promise<PerfSnapshot> {
  const { root } = target
  const centre = centreOf(root)
  const zoom = new ZoomDriver({
    min: options.zoomMin ?? GESTURE.zoomMin,
    max: options.zoomMax ?? GESTURE.zoomMax,
  })
  const press =
    kind === 'drag' ? target.dragStart() : kind === 'grab' ? { el: root, client: centre } : null
  if (kind === 'drag' && press === null) return Promise.reject(new Error('no note to drag'))
  // Drag presses the primary button (buttons 1), grab the middle one (buttons 4).
  const [button, buttons] = kind === 'grab' ? [1, 4] : [0, 1]
  const alt = options.alt === true

  const rec = new RafRecorder(raf)
  return new Promise((resolve) => {
    let start: number | null = null
    const tick = (t: number) => {
      start ??= t
      const elapsed = t - start
      const tSec = elapsed / 1000
      if (kind === 'pan') {
        const d = panDelta(tSec, options.sweepSec)
        wheelOn(root, centre, d.deltaX, d.deltaY, false)
      } else if (kind === 'zoom') wheelOn(root, centre, 0, zoom.next(elapsed, target.zoom()), true)
      else if (press !== null) {
        if (elapsed === 0)
          press.el.dispatchEvent(pointer('pointerdown', press.client, button, buttons, alt))
        else
          root.dispatchEvent(
            pointer('pointermove', dragPoint(press.client, tSec), button, buttons, alt),
          )
      }
      if (elapsed >= GESTURE.warmupMs) rec.mark(t)
      if (elapsed < GESTURE.warmupMs + durationMs) {
        raf(tick)
        return
      }
      if (press !== null) {
        const up = () =>
          root.dispatchEvent(pointer('pointerup', dragPoint(press.client, tSec), button, 0, alt))
        if (options.onHold !== undefined) options.onHold(up)
        else up()
      }
      resolve(rec.stop())
    }
    raf(tick)
  })
}

/**
 * Ctrl-wheel at the viewport's centre, one `ZoomToDriver` step per rAF, until the zoom reaches
 * `toZoom`; every frame from the first step until `GESTURE.settleMs` after the last is recorded
 * (no warm-up: the stall this looks for can come at any step).
 */
export function runZoomTo(
  target: GestureTarget,
  toZoom: number,
  raf: Raf = (cb) => requestAnimationFrame(cb),
): Promise<PerfSnapshot> {
  const { root } = target
  const centre = centreOf(root)
  const driver = new ZoomToDriver(toZoom)
  const rec = new RafRecorder(raf)
  return new Promise((resolve) => {
    let doneAt: number | null = null
    const tick = (t: number) => {
      rec.mark(t)
      if (doneAt === null) {
        const dy = driver.next(target.zoom())
        if (dy === null) doneAt = t
        else wheelOn(root, centre, 0, dy, true)
      }
      if (doneAt !== null && t - doneAt >= GESTURE.settleMs) {
        resolve(rec.stop())
        return
      }
      raf(tick)
    }
    raf(tick)
  })
}
