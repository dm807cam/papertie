import { type BoardState, type ClientOp, type Note, PALETTE } from '@papertie/core'
import { announce } from '../app/liveRegion'
import {
  MERGE,
  type MergeSide,
  type MergeTarget,
  mergeable,
  mergedCopy,
  mergeFits,
  mergeOps,
  mergeRefusal,
  pickTarget,
} from '../interactions/merge'
import type { DragWatch } from '../interactions/selectTool'
import { noteStyle } from '../notes/noteStyle'
import type { CommitOptions } from '../store/boardStore'
import { EASE, MOTION } from '../styles/motion'
import { PIN, pinOffsetX } from './geometry'
import type { LodMode } from './lod'
import { type BridgeGeom, bridgeOutline, outlinePoints, paintBridge } from './mergeBridge'
import { expandRect, type Point, type Rect, type Size } from './types'

export interface MergeWatchDeps {
  board(): BoardState
  /** Bring these notes' records up to the store's before an edit is built from them. */
  takeNow?(ids: readonly string[]): void
  /** Notes whose rect touches world rect `r`: with focus on, the shown ones only. */
  notesIn(r: Rect): string[]
  /** The height a note is drawn at. */
  heightOf(n: Note): number
  zoom(): number
  lod(): LodMode
  /** performance.now ms, as the frame loop's. */
  now(): number
  reduced(): boolean
  /** World to viewport CSS px, as every layer draws it now. */
  mapper(): (p: Point) => Point
  dpr(): number
  viewport(): Size
  rotation(): boolean
  /** The floating origin the world layer is drawn relative to. */
  anchor(): Point
  /** The overlay layer the bridge's canvas goes in. */
  overlay: HTMLElement
  noteEl(id: string): HTMLElement | undefined
  /** Ask for a frame. */
  request(): void
  commit(ops: readonly ClientOp[], o: CommitOptions): void
  select(id: string): void
}

/** The bridge's look; shares are of half the stretch the papers share along their edges. */
export const BRIDGE = {
  /** The waist while forming: just in reach, and at no gap. */
  waistFar: 0.08,
  waistNear: 0.24,
  /** While forming the feet meet the papers this many waists wide, plus `footPx` screen px. */
  footSpread: 1.8,
  footPx: 6,
  /** Armed: a full join, the waist drawn in only a little. */
  waistArmed: 0.94,
  footArmed: 1,
  /**
   * World px inside each paper's edge where the bridge's meniscus leaves it: the torn edge's mean
   * bite (4.2), so the bridge meets the paper and not the cork in its bites.
   */
  bite: 4,
  /** World px further under each paper (the deepest bite is 8), faded in from there. */
  inset: 6,
  fadeIn: 0.55,
  /** Screen px left round the outline on the canvas for the shadow. */
  pad: 4,
  shadow: { color: 'rgb(40 24 8 / 0.2)', blur: 3, y: 1 },
  /** The papers' fibre fibre (note.css): a 256 world px tile, multiplied in at 0.55. */
  fibre: '/textures/fibre.webp',
  fibreTile: 256,
  fibreAlpha: 0.55,
  /** On ink it lightens instead, at 0.25. */
  fibreDarkAlpha: 0.25,
} as const

/** The waist's spring while forming: a soft surface tension that wobbles once and rests. */
const SPRING = { omega: 22, zeta: 0.5, restX: 0.002, restV: 0.02 } as const

/**
 * The absorbed paper flows in over the target: across the gap and `tuck` of its own depth,
 * shrinking by `shrink` toward its facing edge (evenly: its writing keeps its shape), fading from
 * `fadeFrom` of the way on.
 */
const ABSORB = { tuck: 0.45, shrink: 0.2, fadeFrom: 0.3, tiltPad: 3 } as const

/** The target's paper growing to take the merged text in: its height before, and its element. */
interface Growth {
  paper: HTMLElement
  from: number
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'forming' }
  | {
      kind: 'relaxing'
      at: number
      waist: number
      foot: number
      note: Note
      hit: MergeTarget
    }
  | {
      kind: 'absorbing'
      at: number
      ghost: HTMLElement | null
      growth: Growth | null
      note: Note
      hit: MergeTarget
    }

const IDLE: Phase = { kind: 'idle' }

/** A paper's colour as the bridge fills it. */
function paperRgb(n: Note): string {
  const hex = (PALETTE[n.paper] ?? PALETTE.cream).paper
  const v = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(v >> 16) & 255} ${(v >> 8) & 255} ${v & 255})`
}

const lerp = (a: number, b: number, t: number) => (t >= 1 ? b : a + (b - a) * t)

/**
 * Merging by holding one note beside another with Alt (Option) held (only with Alt,
 * like ⌥ into a book: without it a note held beside another only moves there;
 * on touch and pen, which have no Alt, the hold alone, `allow`). It follows a single-note drag of the
 * select tool (`DragWatch`): each move asks the spatial index for the notes around the dragged
 * one (an rbush query, never the board) and picks the one it faces (`pickTarget`): a note it
 * lies over is never its target, but lying over one note does not keep it from joining another
 * beside it. Held there for `MERGE.dwellMs` the bridge is armed and a release merges: one batch
 * (`mergeOps`), committed at once, the merged note selected and named in the live region. A
 * release before that, moving away, or Alt let go (`allow`) lets the bridge relax and the note
 * drops as usual.
 *
 * The liquid bridge is drawn on a small canvas of its own in the overlay, sized to the bridge
 * within the viewport, from the frame loop: it follows the camera and the dragged note every
 * frame and never touches React. Forming, the waist springs toward a narrow neck (thicker as the
 * gap closes): it wobbles and rests, and then frames stop. Armed, it fills out to a full join over
 * `MOTION.base`. After a merge the dragged paper (a copy of its element, the note itself already
 * gone) flows in over the target and fades while the target's paper grows to its new text, over
 * `MOTION.slow`; the bridge draws it in, thinning with the closing gap and never painting over
 * it. Reduced motion: the waist snaps, nothing relaxes, absorbs or grows.
 */
export class MergeWatch implements DragWatch {
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null = null
  private phase: Phase = IDLE
  /** The dragged note where the drag holds it. */
  private dragged: Note | null = null
  private hit: MergeTarget | null = null
  /** When the note came within reach of `hit`. */
  private since = 0
  /** Alt is held (or the drag is a touch's): merging may happen. */
  private allowed = false
  /** The board the target was last found on. */
  private seen: BoardState | null = null
  /** The forming waist's spring (share) and its speed, and the waist and feet drawn. */
  private x = 0
  private v = 0
  private drawnWaist = 0
  private drawnFoot = 0
  private last: number | null = null
  /**
   * The last bridge drawn and where its canvas lies (null: hidden), so a still frame draws
   * nothing.
   */
  private drawn = ''
  private box: Rect | null = null
  /** The device pixel ratio the canvas is sized for. */
  private sizedFor = 0
  /** The fibre fibre: decoded off the main thread, then made a pattern. */
  private fibre: HTMLImageElement | null = null
  private fibreReady = false
  private fibrePattern: CanvasPattern | null = null

  constructor(private readonly deps: MergeWatchDeps) {
    const doc = deps.overlay.ownerDocument
    this.canvas = doc.createElement('canvas')
    this.canvas.className = 'merge-bridge'
    this.canvas.setAttribute('aria-hidden', 'true')
    this.canvas.hidden = true
    this.canvas.width = 0
    this.canvas.height = 0
    deps.overlay.append(this.canvas)
  }

  /** The note the dragged one would merge into now, if any. */
  get target(): string | undefined {
    return this.phase.kind === 'forming' ? this.hit?.id : undefined
  }

  /** Whether a release now merges. */
  get armed(): boolean {
    return this.isArmed(this.deps.now())
  }

  /** The waist as drawn now, a share of half the shared stretch (1: all of it). */
  get neck(): number {
    return this.drawnWaist
  }

  /** Where the feet meet the papers as drawn now, a share of half the shared stretch. */
  get foot(): number {
    return this.drawnFoot
  }

  /** The viewport rect the bridge's canvas covers; null while it is hidden. */
  get bounds(): Rect | null {
    return this.canvas.hidden ? null : this.box
  }

  move(n: Note): void {
    if (this.phase.kind === 'absorbing') return
    const was = this.dragged
    this.dragged = n
    this.refind(was)
  }

  release(n: Note): boolean {
    const now = this.deps.now()
    const hit = this.hit
    if (this.phase.kind !== 'forming' || hit === null || !this.isArmed(now)) return false
    // The board as it is now: an undo or a restore may have removed the target, or made it a photo.
    this.deps.takeNow?.([n.id, hit.id])
    const s = this.deps.board()
    const target = s.notes.get(hit.id)
    const stored = s.notes.get(n.id)
    if (target === undefined || stored === undefined) return false
    if (!mergeable(stored, target) || !mergeFits(stored, target, hit.side)) return false
    const ops = mergeOps(s, n.id, hit.id, hit.side)
    const reduced = this.deps.reduced()
    const ghost = reduced ? null : this.ghostOf(n)
    const growth = reduced ? null : this.growthOf(target)
    try {
      this.deps.commit(ops, { label: MERGE.label })
    } catch (err) {
      ghost?.remove()
      const said = mergeRefusal(err)
      if (said === undefined) throw err
      announce(said)
      return false
    }
    this.deps.select(hit.id)
    announce(mergedCopy(this.deps.board().notes.get(hit.id)?.text ?? ''))
    this.dragged = null
    if (reduced) {
      this.stop()
      return true
    }
    this.phase = { kind: 'absorbing', at: now, ghost, growth, note: n, hit }
    this.last = null
    this.deps.request()
    return true
  }

  end(): void {
    if (this.phase.kind === 'forming') this.relax(this.dragged)
    this.dragged = null
    this.hit = null
  }

  /**
   * Whether merging may happen: Alt (Option) held while dragging, or a touch's or a pen's drag.
   * Allowed, the hold beside a note starts; no longer allowed, a bridge forming lets go, so a
   * note is only ever merged on purpose and otherwise just moves.
   */
  allow(on: boolean): void {
    if (this.allowed === on) return
    this.allowed = on
    if (this.phase.kind === 'absorbing') return
    if (!on) {
      if (this.phase.kind === 'forming') this.relax(this.dragged)
      this.hit = null
    } else if (this.dragged !== null) this.refind(this.dragged)
  }

  /** End an absorb under way at once (a new press, an undo): its merge has landed already. */
  settle(): void {
    if (this.phase.kind === 'absorbing') this.stop()
  }

  /** Draw the bridge for this frame; whether it wants another. */
  frame(now: number): boolean {
    const p = this.phase
    if (p.kind === 'idle') return false
    const dt = this.last === null ? 0 : Math.max(0, Math.min(0.05, (now - this.last) / 1000))
    this.last = now
    if (p.kind === 'forming') {
      // The board changed under the hold: the target may have gone or changed.
      if (this.deps.board() !== this.seen) this.refind(this.dragged)
      return this.phase.kind === 'forming' ? this.form(now, dt) : this.frame(now)
    }
    if (p.kind === 'relaxing') {
      const t = (now - p.at) / MOTION.fast
      if (t >= 1 || this.deps.reduced()) {
        this.stop()
        return false
      }
      // It thins and draws back into the target's edge, never hanging where the note was.
      const e = EASE(t)
      this.drawnWaist = p.waist * (1 - e)
      this.drawnFoot = p.foot * (1 - e)
      this.draw(p.note, p.hit, Math.max(0, p.hit.gap) * (1 - e), 1 - e)
      return true
    }
    const t = (now - p.at) / MOTION.slow
    if (t >= 1) {
      this.stop()
      return false
    }
    // It moves in at once and fades once on its way, so the eye follows it in.
    this.absorbStep(p, EASE(t), EASE(Math.max(0, t - ABSORB.fadeFrom) / (1 - ABSORB.fadeFrom)))
    return true
  }

  dispose(): void {
    this.stop()
    this.canvas.remove()
  }

  private isArmed(now: number): boolean {
    return this.phase.kind === 'forming' && this.hit !== null && now - this.since >= MERGE.dwellMs
  }

  /** Find the target for the dragged note `n` again; `was` is where it was (for a relax). */
  private refind(was: Note | null): void {
    const n = this.dragged
    this.seen = this.deps.board()
    const hit = n === null ? null : this.find(n)
    if (hit === null) {
      if (this.phase.kind === 'forming') this.relax(was)
      this.hit = null
      return
    }
    if (hit.id !== this.hit?.id || this.phase.kind !== 'forming') this.since = this.deps.now()
    this.hit = hit
    if (this.phase.kind !== 'forming') {
      if (this.phase.kind === 'idle') {
        this.x = 0
        this.v = 0
      }
      this.phase = { kind: 'forming' }
      this.last = null
    }
    this.deps.request()
  }

  /**
   * The note `n` faces, found among its neighbours in the index (never one it lies over); none
   * unless merging is allowed (`allow`).
   */
  private find(n: Note): MergeTarget | null {
    if (!this.allowed || this.deps.lod() === 'overview' || n.image !== null) return null
    const zoom = this.deps.zoom()
    const rect = { x: n.x, y: n.y, w: n.w, h: this.deps.heightOf(n) }
    const { notes } = this.deps.board()
    const candidates: Array<{ id: string; rect: Rect }> = []
    for (const id of this.deps.notesIn(expandRect(rect, MERGE.gapPx / zoom))) {
      const t = notes.get(id)
      if (t === undefined || id === n.id || !mergeable(n, t)) continue
      candidates.push({ id, rect: { x: t.x, y: t.y, w: t.w, h: this.deps.heightOf(t) } })
    }
    return pickTarget(rect, candidates, zoom, (id, side) => {
      const t = notes.get(id) as Note
      return mergeFits(n, t, side)
    })
  }

  /**
   * Let the bridge being formed (between `note` and the target) go: it thins away into the
   * target over `MOTION.fast`; at once under reduced motion.
   */
  private relax(note: Note | null): void {
    const hit = this.hit
    if (this.deps.reduced() || note === null || hit === null) {
      this.stop()
      return
    }
    const at = this.deps.now()
    this.phase = { kind: 'relaxing', at, waist: this.drawnWaist, foot: this.drawnFoot, note, hit }
    this.last = null
    this.deps.request()
  }

  private stop(): void {
    const p = this.phase
    if (p.kind === 'absorbing') {
      p.ghost?.remove()
      if (p.growth !== null) {
        p.growth.paper.style.maxHeight = ''
        p.growth.paper.style.overflow = ''
      }
    }
    this.phase = IDLE
    this.hit = null
    this.x = 0
    this.v = 0
    this.drawnWaist = 0
    this.drawnFoot = 0
    this.last = null
    this.hide()
    // Idle, the canvas holds no backing store.
    this.canvas.width = 0
    this.canvas.height = 0
    this.sizedFor = 0
    this.box = null
  }

  private hide(): void {
    this.canvas.hidden = true
    this.drawn = ''
  }

  private form(now: number, dt: number): boolean {
    const hit = this.hit
    if (hit === null || this.dragged === null) return false
    const zoom = this.deps.zoom()
    const armed = this.isArmed(now)
    const near = 1 - Math.min(1, (Math.max(0, hit.gap) * zoom) / MERGE.gapPx)
    const goal = lerp(BRIDGE.waistFar, BRIDGE.waistNear, near)
    const reduced = this.deps.reduced()
    // Armed, the join fills out over the 200 ms token: decisive, and calm.
    const armedAt = this.since + MERGE.dwellMs
    const a = !armed ? 0 : reduced ? 1 : EASE(Math.min(1, (now - armedAt) / MOTION.base))
    let moving = false
    if (reduced) {
      this.x = goal
      this.v = 0
    } else if (a < 1) {
      // Semi-implicit steps of at most 4 ms: stable at any frame rate.
      for (let left = dt; left > 0; left -= 0.004) {
        const h = Math.min(0.004, left)
        const acc = -(SPRING.omega ** 2) * (this.x - goal) - 2 * SPRING.zeta * SPRING.omega * this.v
        this.v += acc * h
        this.x += this.v * h
      }
      if (Math.abs(this.x - goal) < SPRING.restX && Math.abs(this.v) < SPRING.restV) {
        this.x = goal
        this.v = 0
      } else moving = true
    }
    const half = this.shared(this.dragged, hit) / 2
    const flare = half > 0 ? BRIDGE.footPx / zoom / half : 0
    this.drawnWaist = lerp(this.x, BRIDGE.waistArmed, a)
    this.drawnFoot = lerp(this.x * BRIDGE.footSpread + flare, BRIDGE.footArmed, a)
    this.draw(this.dragged, hit, Math.max(0, hit.gap), 1)
    // Until armed (and filled out), frames run to arm it on time.
    return moving || a < 1
  }

  private absorbStep(p: Extract<Phase, { kind: 'absorbing' }>, e: number, fade: number): void {
    const { note: n, hit } = p
    const dir = this.toward(hit.side)
    const gap = Math.max(0, hit.gap)
    const depth = dir.x !== 0 ? n.w : this.deps.heightOf(n)
    const slide = (gap + ABSORB.tuck * depth) * e
    const at = { ...n, x: n.x + dir.x * slide, y: n.y + dir.y * slide }
    if (p.ghost !== null) this.placeGhost(p.ghost, at, hit.side, e, fade)
    if (p.growth !== null) this.grow(p.growth, e)
    // The bridge draws the paper in: it closes with the gap, fading as it closes, and is gone once
    // the paper reaches the target's edge. It never paints over the paper (above the target now).
    const closing = Math.min(gap, slide)
    const bridged = { ...n, x: n.x + dir.x * closing, y: n.y + dir.y * closing }
    const open = gap > 0 ? (gap - closing) / gap : 0
    this.drawnWaist = BRIDGE.waistArmed
    this.drawnFoot = BRIDGE.footArmed
    this.draw(bridged, hit, gap - closing, open * (1 - fade), this.ghostRect(at, hit.side, e))
  }

  /**
   * World rect of the absorbing paper at `n`, shrunk by `e` toward its facing edge (unturned, so
   * grown by the reach of the most a note tilts).
   */
  private ghostRect(n: Note, side: MergeSide, e: number): Rect {
    const h = this.deps.heightOf(n)
    const k = 1 - ABSORB.shrink * e
    const edge =
      side === 'right'
        ? { x: n.x, y: n.y + h / 2 }
        : side === 'left'
          ? { x: n.x + n.w, y: n.y + h / 2 }
          : side === 'below'
            ? { x: n.x + n.w / 2, y: n.y }
            : { x: n.x + n.w / 2, y: n.y + h }
    const r = {
      x: edge.x + (n.x - edge.x) * k,
      y: edge.y + (n.y - edge.y) * k,
      w: n.w * k,
      h: h * k,
    }
    return expandRect(r, ABSORB.tiltPad)
  }

  /** The way from the dragged note to the target. */
  private toward(side: MergeSide): Point {
    if (side === 'right') return { x: -1, y: 0 }
    if (side === 'left') return { x: 1, y: 0 }
    return side === 'below' ? { x: 0, y: -1 } : { x: 0, y: 1 }
  }

  /**
   * A copy of the dragged note's element left in the world layer for the absorb: inert, hidden
   * from assistive tech and out of every query (no note id); null when it is not mounted. It keeps
   * the drag's lift (a z-index above every note's rank), so it stays over the target and ties
   * with no other note.
   */
  private ghostOf(n: Note): HTMLElement | null {
    const el = this.deps.noteEl(n.id)
    if (el === undefined || el.parentElement === null) return null
    const ghost = el.cloneNode(true) as HTMLElement
    for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>('*')]) {
      node.removeAttribute('id')
      node.removeAttribute('tabindex')
      delete node.dataset.noteId
      for (const a of [...node.attributes]) {
        if (a.name.startsWith('aria-')) node.removeAttribute(a.name)
      }
    }
    ghost.classList.add('note--merging')
    ghost.setAttribute('aria-hidden', 'true')
    ghost.inert = true
    ghost.style.pointerEvents = 'none'
    el.parentElement.append(ghost)
    return ghost
  }

  /** The target's paper, to grow from its height now to the merged text's; null unmounted. */
  private growthOf(target: Note): Growth | null {
    const paper = this.deps.noteEl(target.id)?.querySelector<HTMLElement>('.note-paper')
    return paper ? { paper, from: this.deps.heightOf(target) } : null
  }

  /**
   * The target's paper `e` of the way from its old height to its new one (its content's), its
   * torn edge moving down as it takes the merged text in. One read and one write, of one note.
   */
  private grow(g: Growth, e: number): void {
    const to = g.paper.scrollHeight
    if (!(to > g.from)) return
    g.paper.style.overflow = 'hidden'
    g.paper.style.maxHeight = `${lerp(g.from, to, e)}px`
  }

  /** The absorbing copy at `n`, shrunk by `e` toward its facing edge, faded by `fade`. */
  private placeGhost(ghost: HTMLElement, n: Note, side: MergeSide, e: number, fade: number): void {
    const box = noteStyle(n, this.deps.rotation(), this.deps.anchor())
    const h = this.deps.heightOf(n)
    const origin = { x: n.w / 2 + pinOffsetX(n), y: PIN.insetY }
    const edge =
      side === 'right'
        ? { x: 0, y: h / 2 }
        : side === 'left'
          ? { x: n.w, y: h / 2 }
          : side === 'below'
            ? { x: n.w / 2, y: 0 }
            : { x: n.w / 2, y: h }
    const k = 1 - ABSORB.shrink * e
    const ox = edge.x - origin.x
    const oy = edge.y - origin.y
    const about = (x: number, y: number) => `translate(${x}px, ${y}px)`
    ghost.style.transform = `${box.transform} ${about(ox, oy)} scale(${k}) ${about(-ox, -oy)}`
    ghost.style.opacity = `${1 - fade}`
  }

  /** Length of the stretch the dragged paper `n` and the target share along their edges. */
  private shared(n: Note, hit: MergeTarget): number {
    const t = this.deps.board().notes.get(hit.id)
    if (t === undefined) return 0
    if (hit.side === 'left' || hit.side === 'right') {
      const lo = Math.max(n.y, t.y)
      return Math.max(0, Math.min(n.y + this.deps.heightOf(n), t.y + this.deps.heightOf(t)) - lo)
    }
    return Math.max(0, Math.min(n.x + n.w, t.x + t.w) - Math.max(n.x, t.x))
  }

  /**
   * The bridge between `n` (the dragged paper) and the target, `gap` world px apart, at `alpha`,
   * leaving world rect `exclude` (the absorbing paper) unpainted.
   */
  private draw(
    n: Note,
    hit: MergeTarget,
    gap: number,
    alpha: number,
    exclude: Rect | null = null,
  ): void {
    const target = this.deps.board().notes.get(hit.id)
    if (target === undefined || !(alpha > 0)) {
      this.hide()
      return
    }
    const geom = this.geometry(n, target, hit.side, gap)
    const cmds = bridgeOutline(geom)
    const map = this.deps.mapper()
    const pts = outlinePoints(cmds).map(map)
    const hole = exclude === null ? null : this.toViewport(exclude, map)
    const cut = hole === null ? '' : `${hole.x},${hole.y},${hole.w},${hole.h}`
    const outline = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
    const key = `${outline}|${alpha.toFixed(3)}|${n.paper}|${target.paper}|${cut}`
    if (key === this.drawn && !this.canvas.hidden) return
    const ctx = this.context()
    const box = ctx === null ? null : this.fit(pts)
    if (ctx === null || box === null) {
      this.hide()
      return
    }
    this.drawn = key
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    paintBridge(ctx, cmds, {
      geom,
      map,
      zoom: this.deps.zoom(),
      dpr: this.deps.dpr(),
      box,
      alpha,
      fromColour: paperRgb(target),
      toColour: paperRgb(n),
      bite: BRIDGE.bite,
      fadeIn: BRIDGE.fadeIn,
      shadow: BRIDGE.shadow,
      fibre: this.fibreFor(ctx, target, n),
      exclude: hole,
    })
    this.canvas.hidden = false
  }

  /** World rect `r` in viewport px through `map` (the camera neither turns nor flips). */
  private toViewport(r: Rect, map: (p: Point) => Point): Rect {
    const a = map({ x: r.x, y: r.y })
    const b = map({ x: r.x + r.w, y: r.y + r.h })
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
  }

  /**
   * The fibre fibre over the bridge's paper, laid as the target's paper lays it (from its top-left
   * corner, at its scale), so the target's fibre runs on into the bridge. None in lite, which
   * draws no fibre, and none until the texture has been decoded.
   */
  private fibreFor(
    ctx: CanvasRenderingContext2D,
    target: Note,
    n: Note,
  ): ((ctx: CanvasRenderingContext2D, box: Rect) => void) | null {
    if (this.deps.lod() !== 'full' || (target.style !== 'rustic' && n.style !== 'rustic'))
      return null
    const pattern = this.patternOf(ctx)
    const img = this.fibre
    if (pattern === null || img === null) return null
    const o = this.deps.mapper()({ x: target.x, y: target.y })
    const k = (this.deps.zoom() * BRIDGE.fibreTile) / (img.naturalWidth || BRIDGE.fibreTile)
    const dark = target.paper === 'ink'
    return (c, box) => {
      pattern.setTransform?.(new DOMMatrix([k, 0, 0, k, o.x, o.y]))
      c.globalAlpha = dark ? BRIDGE.fibreDarkAlpha : BRIDGE.fibreAlpha
      c.globalCompositeOperation = dark ? 'screen' : 'multiply'
      c.fillStyle = pattern
      c.fillRect(box.x, box.y, box.w, box.h)
      c.globalCompositeOperation = 'source-over'
      c.globalAlpha = 1
    }
  }

  private patternOf(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.fibrePattern !== null) return this.fibrePattern
    if (this.fibre === null) {
      if (typeof Image !== 'function') return null
      const img = new Image()
      img.decoding = 'async'
      img.src = BRIDGE.fibre
      this.fibre = img
      // Decoded off the main thread before its first use; then the bridge is drawn again.
      img.decode?.().then(
        () => {
          this.fibreReady = true
          this.drawn = ''
          if (this.phase.kind !== 'idle') this.deps.request()
        },
        () => {},
      )
    }
    if (!this.fibreReady) return null
    this.fibrePattern = ctx.createPattern(this.fibre, 'repeat')
    return this.fibrePattern
  }

  /** The bridge's world geometry between the dragged paper `n` and `target`, `gap` apart. */
  private geometry(n: Note, target: Note, side: MergeSide, gap: number): BridgeGeom {
    const hn = this.deps.heightOf(n)
    const ht = this.deps.heightOf(target)
    const horizontal = side === 'left' || side === 'right'
    const [lo, hi] = horizontal
      ? [Math.max(n.y, target.y), Math.min(n.y + hn, target.y + ht)]
      : [Math.max(n.x, target.x), Math.min(n.x + n.w, target.x + target.w)]
    const edge =
      side === 'right'
        ? target.x + target.w
        : side === 'left'
          ? target.x
          : side === 'below'
            ? target.y + ht
            : target.y
    const sign = side === 'right' || side === 'below' ? 1 : -1
    return {
      axis: horizontal ? 'x' : 'y',
      from: edge - sign * BRIDGE.bite,
      to: edge + sign * (gap + BRIDGE.bite),
      mid: (lo + hi) / 2,
      half: Math.max(0, hi - lo) / 2,
      waist: this.drawnWaist,
      foot: this.drawnFoot,
      inset: BRIDGE.inset,
    }
  }

  private context(): CanvasRenderingContext2D | null {
    if (this.ctx === null) this.ctx = this.canvas.getContext('2d')
    return this.ctx
  }

  /**
   * Place the canvas over viewport points `pts` (with room for the shadow), within the viewport,
   * growing its backing store only when it is too small. The viewport rect it covers, or null
   * when the bridge is out of view.
   */
  private fit(pts: readonly Point[]): Rect | null {
    let x0 = Number.POSITIVE_INFINITY
    let y0 = Number.POSITIVE_INFINITY
    let x1 = Number.NEGATIVE_INFINITY
    let y1 = Number.NEGATIVE_INFINITY
    for (const p of pts) {
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x)
      y1 = Math.max(y1, p.y)
    }
    const { width, height } = this.deps.viewport()
    const pad = BRIDGE.pad
    const x = Math.floor(Math.max(-pad, x0 - pad))
    const y = Math.floor(Math.max(-pad, y0 - pad))
    const w = Math.ceil(Math.min(width + pad, x1 + pad)) - x
    const h = Math.ceil(Math.min(height + pad, y1 + pad)) - y
    if (!(w > 0 && h > 0)) return null
    const dpr = this.deps.dpr()
    const c = this.canvas
    const needW = Math.ceil(w * dpr)
    const needH = Math.ceil(h * dpr)
    if (c.width < needW || c.height < needH || this.sizedFor !== dpr) {
      // Some room to spare, so a growing bridge reallocates seldom.
      const keep = this.sizedFor === dpr
      this.sizedFor = dpr
      c.width = Math.max(keep ? c.width : 0, needW + 64)
      c.height = Math.max(keep ? c.height : 0, needH + 64)
      c.style.width = `${c.width / dpr}px`
      c.style.height = `${c.height / dpr}px`
    }
    if (this.box?.x !== x || this.box?.y !== y) c.style.transform = `translate(${x}px, ${y}px)`
    this.box = { x, y, w, h }
    return this.box
  }
}
