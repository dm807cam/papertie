import type { Yarn } from '@papertie/core'
import { type EndsOf, type SegmentRef, type TopologyBoard, topologyOf } from './attach'
import type { Point } from './types'
import {
  DRAW_IN_MS,
  drawInProgress,
  loosenState,
  PULSE_MS,
  pulseState,
  REDUCED_FADE_MS,
} from './yarnAnim'
import { restSagPoint } from './yarnGeometry'
import { SPRING, type SpringState, stepSpring } from './yarnPhysics'

/** A segment's two ends, world px. */
export interface SegmentEnds {
  a: Point
  b: Point
}

interface Spring {
  ref: SegmentRef
  s: SpringState
  target: Point
}

const atRest = (t: Point): SpringState => ({ x: t.x, y: t.y, vx: 0, vy: 0 })

/** `stepSpring` lands exactly on the target with zero velocity once it rests. */
const rests = (s: SpringState, t: Point) => s.vx === 0 && s.vy === 0 && s.x === t.x && s.y === t.y

/** Key of the live thread's spring, the one being connected; never a stored segment's key. */
export const LIVE_KEY = '__live'

export interface YarnGhost {
  yarn: Yarn
  /** Each segment's ends at delete time. */
  segments: SegmentEnds[]
  sagScale: number
  alpha: number
}

/**
 * Yarn motion: one damped spring per segment for its sag point, the draw-in of new threads and
 * the loosen-out of deleted ones. Springs sleep at rest and only awake ones are stepped, so
 * `step` returns false, and the frame loop goes idle, once everything rests. Under reduced
 * motion springs snap and both animations are short fades. `wake` is called whenever motion
 * starts, so the owner can request a frame.
 */
export class YarnMotion {
  private readonly springs = new Map<string, Spring>()
  private readonly awake = new Set<string>()
  private readonly byNote = new Map<string, Set<string>>()
  private readonly byYarn = new Map<string, string[]>()
  private readonly drawIns = new Map<string, number>()
  private readonly loosens = new Map<
    string,
    { yarn: Yarn; segments: SegmentEnds[]; start: number }
  >()
  private readonly pulses = new Map<string, number>()
  private now = 0
  /** The live thread's sag spring, while a connect gesture runs. */
  private live: { s: SpringState; target: Point; awake: boolean } | null = null

  constructor(
    private readonly reduced: () => boolean,
    private readonly wake: () => void = () => {},
  ) {}

  get awakeCount(): number {
    return this.awake.size
  }

  /** Draw-ins, loosen-outs and pulses in progress. */
  get activeAnimations(): number {
    return this.drawIns.size + this.loosens.size + this.pulses.size
  }

  /**
   * Match the springs to the board's segments: new ones start at rest between their ends, gone
   * ones are dropped. With `yarnIds`, only those threads' springs (the threads a change touched:
   * O(their segments)); without, every thread's.
   */
  sync(s: TopologyBoard, endsOf: EndsOf, yarnIds?: Iterable<string>): void {
    const topo = topologyOf(s)
    if (yarnIds !== undefined) {
      for (const id of new Set(yarnIds)) this.syncYarn(s, id, topo.byYarn.get(id), endsOf)
      return
    }
    const seen = new Set<string>()
    this.byNote.clear()
    this.byYarn.clear()
    for (const [yarnId, refs] of topo.byYarn) {
      for (const ref of refs) seen.add(ref.key)
      this.byYarn.set(yarnId, this.track(refs, endsOf))
    }
    for (const key of this.springs.keys()) {
      if (seen.has(key)) continue
      this.springs.delete(key)
      this.awake.delete(key)
    }
    for (const id of this.drawIns.keys()) if (!s.yarns.has(id)) this.drawIns.delete(id)
    for (const id of this.pulses.keys()) if (!s.yarns.has(id)) this.pulses.delete(id)
  }

  /** One thread's springs to its segments `refs` (none: the thread is gone). */
  private syncYarn(
    s: TopologyBoard,
    yarnId: string,
    refs: readonly SegmentRef[] | undefined,
    endsOf: EndsOf,
  ): void {
    const keep = new Set<string>()
    for (const ref of refs ?? []) keep.add(ref.key)
    for (const key of this.byYarn.get(yarnId) ?? []) {
      if (keep.has(key)) continue
      const spring = this.springs.get(key)
      if (spring !== undefined) {
        for (const id of [spring.ref.aNoteId, spring.ref.bNoteId]) {
          const set = this.byNote.get(id)
          set?.delete(key)
          if (set?.size === 0) this.byNote.delete(id)
        }
      }
      this.springs.delete(key)
      this.awake.delete(key)
    }
    if (refs === undefined) this.byYarn.delete(yarnId)
    else this.byYarn.set(yarnId, this.track(refs, endsOf))
    if (!s.yarns.has(yarnId)) {
      this.drawIns.delete(yarnId)
      this.pulses.delete(yarnId)
    }
  }

  /** A spring for each of `refs` (at rest, when new) under its notes; returns their keys. */
  private track(refs: readonly SegmentRef[], endsOf: EndsOf): string[] {
    const keys: string[] = []
    for (const ref of refs) {
      const { key } = ref
      keys.push(key)
      const spring = this.springs.get(key)
      if (spring === undefined) {
        const e = endsOf(ref)
        if (e === undefined) continue
        const t = restSagPoint(e.a, e.b)
        this.springs.set(key, { ref, s: atRest(t), target: t })
      } else spring.ref = ref
      for (const id of [ref.aNoteId, ref.bNoteId]) {
        let set = this.byNote.get(id)
        if (set === undefined) {
          set = new Set()
          this.byNote.set(id, set)
        }
        set.add(key)
      }
    }
    return keys
  }

  /** The segments touching any of these notes. */
  segmentsOf(noteIds: Iterable<string>): SegmentRef[] {
    const keys = new Set<string>()
    for (const id of noteIds) for (const k of this.byNote.get(id) ?? []) keys.add(k)
    const out: SegmentRef[] = []
    for (const k of keys) {
      const spring = this.springs.get(k)
      if (spring) out.push(spring.ref)
    }
    return out
  }

  /** Segments drawn live: awake springs and every segment of a thread drawing in or pulsing. */
  *activeRefs(): Iterable<SegmentRef> {
    for (const k of this.awake) {
      const spring = this.springs.get(k)
      if (spring) yield spring.ref
    }
    for (const id of [...this.drawIns.keys(), ...this.pulses.keys()]) {
      for (const k of this.byYarn.get(id) ?? []) {
        const spring = this.springs.get(k)
        if (spring && !this.awake.has(k)) yield spring.ref
      }
    }
  }

  /**
   * Wake the springs whose rest point moved more than `restEpsilon`; reduced motion, or `snap`
   * (an end moved without a gesture: a measured height, the tilt toggle), puts them at rest.
   */
  retarget(refs: Iterable<SegmentRef>, endsOf: EndsOf, o?: { snap?: boolean }): void {
    const reduced = this.reduced() || o?.snap === true
    let woke = false
    for (const ref of refs) {
      const spring = this.springs.get(ref.key)
      const e = endsOf(ref)
      if (spring === undefined || e === undefined) continue
      const t = restSagPoint(e.a, e.b)
      if (!(Number.isFinite(t.x) && Number.isFinite(t.y))) continue
      const moved = Math.hypot(t.x - spring.target.x, t.y - spring.target.y) > SPRING.restEpsilon
      const isAwake = this.awake.has(ref.key)
      spring.target = t
      if (reduced || (!moved && !isAwake)) {
        spring.s = atRest(t)
        this.awake.delete(ref.key)
      } else if (moved && !isAwake) {
        this.awake.add(ref.key)
        woke = true
      }
    }
    if (woke) this.wake()
  }

  /**
   * Advance everything to `nowMs`; true while any spring is awake or any animation runs. Targets
   * come from `retarget`. A dt of 0, negative or NaN leaves the springs where they are; any
   * finite gap, however long, is exact.
   */
  step(dtSec: number, nowMs: number): boolean {
    if (Number.isFinite(nowMs)) this.now = nowMs
    const reduced = this.reduced()
    for (const key of this.awake) {
      const spring = this.springs.get(key)
      if (spring === undefined) {
        this.awake.delete(key)
        continue
      }
      const { target } = spring
      // An infinite gap is still a gap: land at rest rather than freeze.
      const snap = reduced || dtSec === Number.POSITIVE_INFINITY
      spring.s = snap ? atRest(target) : stepSpring(spring.s, target, dtSec)
      if (rests(spring.s, target)) this.awake.delete(key)
    }
    const drawInMs = reduced ? REDUCED_FADE_MS : DRAW_IN_MS
    for (const [id, start] of this.drawIns) {
      if (this.now - start >= drawInMs) this.drawIns.delete(id)
    }
    for (const [id, l] of this.loosens) {
      if (loosenState(this.now - l.start, reduced).done) this.loosens.delete(id)
    }
    for (const [id, start] of this.pulses) {
      if (this.now - start >= PULSE_MS) this.pulses.delete(id)
    }
    const live = this.live
    if (live?.awake) {
      const snap = reduced || dtSec === Number.POSITIVE_INFINITY
      live.s = snap ? atRest(live.target) : stepSpring(live.s, live.target, dtSec)
      if (rests(live.s, live.target)) live.awake = false
    }
    return this.awake.size > 0 || this.activeAnimations > 0 || live?.awake === true
  }

  /**
   * Aim the live thread's spring (key `LIVE_KEY`) at the rest sag between `a` and `b`. The first
   * call starts it at rest; later ones wake it, so the sag lags the pointer. Reduced motion snaps.
   */
  setLive(a: Point, b: Point): void {
    const t = restSagPoint(a, b)
    if (!(Number.isFinite(t.x) && Number.isFinite(t.y))) return
    const live = this.live
    if (live === null || this.reduced()) {
      this.live = { s: atRest(t), target: t, awake: false }
      return
    }
    const moved = Math.hypot(t.x - live.target.x, t.y - live.target.y) > SPRING.restEpsilon
    live.target = t
    if (moved && !live.awake) {
      live.awake = true
      this.wake()
    } else if (!moved && !live.awake) live.s = atRest(t)
  }

  /** End the live thread. */
  clearLive(): void {
    this.live = null
  }

  /** The live thread's sag point: its spring while one runs, otherwise the rest point. */
  liveSag(a: Point, b: Point): Point {
    return this.live === null ? restSagPoint(a, b) : { x: this.live.s.x, y: this.live.s.y }
  }

  /** The sag point to draw: the live spring while awake, otherwise the rest point. */
  sagOf(ref: SegmentRef, a: Point, b: Point): Point {
    if (ref.key === LIVE_KEY) return this.liveSag(a, b)
    if (this.awake.has(ref.key)) {
      const spring = this.springs.get(ref.key)
      if (spring) return { x: spring.s.x, y: spring.s.y }
    }
    return restSagPoint(a, b)
  }

  /** Start drawing in a just-created thread. */
  startDrawIn(yarnId: string, nowMs: number): void {
    const t = Number.isFinite(nowMs) ? nowMs : this.now
    this.now = t
    this.drawIns.set(yarnId, t)
    this.wake()
  }

  /**
   * Swell a thread once, over `PULSE_MS`, to say "this one": the way a tie that already exists is
   * shown. Under reduced motion there is none (the thread is only selected).
   */
  startPulse(yarnId: string, nowMs: number): void {
    if (this.reduced()) return
    const t = Number.isFinite(nowMs) ? nowMs : this.now
    this.now = t
    this.pulses.set(yarnId, t)
    this.wake()
  }

  /**
   * Start loosening a thread about to be deleted; its segments' ends (at delete time) are kept
   * until the ghost is gone.
   */
  startLoosen(yarn: Yarn, segments: readonly SegmentEnds[], nowMs: number): void {
    const t = Number.isFinite(nowMs) ? nowMs : this.now
    this.now = t
    this.drawIns.delete(yarn.id)
    this.loosens.set(yarn.id, { yarn, segments: segments.slice(), start: t })
    this.wake()
  }

  /** Deleted threads still loosening, as of the last step. */
  ghosts(): YarnGhost[] {
    const reduced = this.reduced()
    const out: YarnGhost[] = []
    for (const { yarn, segments, start } of this.loosens.values()) {
      const l = loosenState(this.now - start, reduced)
      if (!l.done) out.push({ yarn, segments, sagScale: l.sagScale, alpha: l.alpha })
    }
    return out
  }

  /** Drawn share of a thread's length: 1 unless it is drawing in. */
  progressOf(yarnId: string): number {
    const start = this.drawIns.get(yarnId)
    return start === undefined ? 1 : drawInProgress(this.now - start, this.reduced()).progress
  }

  /** How far a thread's pulse has swelled it, 0 (none or done) to 1 (the crest). */
  pulseOf(yarnId: string): number {
    const start = this.pulses.get(yarnId)
    return start === undefined || this.reduced() ? 0 : pulseState(this.now - start)
  }

  /** A thread's opacity: below 1 only while a reduced-motion draw-in fades it in. */
  alphaOf(yarnId: string): number {
    const start = this.drawIns.get(yarnId)
    return start === undefined ? 1 : drawInProgress(this.now - start, this.reduced()).alpha
  }
}
