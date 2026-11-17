import type { BoardState, PaletteToken, Yarn } from '@papertie/core'
import {
  type FocusLayer,
  type FocusPaint,
  inLayer,
  LOOSE_END_ALPHA,
  looseStub,
  type Part,
  partOf,
} from '../focus/focusMode'
import { yarnColor } from '../styles/palette'
import { type End, type EndsOf, HANGING, type Topology, topologyOf } from './attach'
import { type Camera, ORIGIN, screenMapper } from './Camera'
import {
  createPinSprites,
  drawStrand,
  type PinKind,
  pinRadiusPx,
  SELECTED_SCALE,
  strandWidthPx,
} from './drawYarn'
import { isTag, noteBounds, pinPosition } from './geometry'
import {
  buildDrawList,
  type DrawItem,
  type LayerMode,
  type PaperShape,
  PIN_STUB_WORLD,
  paperCorners,
  pinStubs,
  strandOverPaper,
} from './layering'
import type { LodMode } from './lod'
import {
  type CardPaint,
  type CardShape,
  cardPaints,
  cardShape,
  drawCards,
  drawOutline,
  drawPinDots,
  drawThreads,
  eraseOverview,
  hullBox,
  OVERVIEW,
  overviewPinRadius,
  overviewYarnAlpha,
  overviewYarnWidth,
  rectsTouch,
  type ThreadPaint,
} from './overview'
import type { PyramidFrame, PyramidView } from './pyramid/pyramid'
import { drawSelectionFrame } from './selectionFrame'
import type { SegmentRef } from './spatialIndex'
import type { Point, Rect, Size } from './types'
import {
  type CubicBezier,
  flattenBezier,
  polylineLength,
  restSagPoint,
  segmentBezier,
  sliceByLength,
  truncatePolyline,
} from './yarnGeometry'

/** How much wider a pulsing thread is drawn at the crest of its pulse (on top of any selection). */
export const PULSE_SWELL = 0.4

/** A deleted thread still loosening out: its segments' ends at delete time, sag and opacity. */
export interface GhostYarn {
  yarn: Yarn
  segments: ReadonlyArray<{ a: Point; b: Point }>
  sagScale: number
  alpha: number
}

/** The thread being connected, in world px: drawn on top every frame, never cached. */
export interface LiveStrand {
  from: Point
  to: Point
  sag: Point
  color: PaletteToken
  /** The note whose hanging pin it leaves from: above the paper, it runs beneath that paper. */
  under?: string
}

/** A pin head that glows, by position: an edge pin under the hover or a connect's landing. */
export interface GlowPin {
  p: Point
  kind: PinKind
}

/**
 * What one yarn frame draws. `sagOf` gives each segment's sag point; the anim hooks are optional.
 */
export interface YarnFrameInput {
  state: BoardState
  /** The threads' segments and ends as drawn (default: the board's own, `topologyOf(state)`). */
  topology?: Topology
  camera: Camera
  /** World point everything is drawn relative to (floating origin); the world origin if none. */
  anchor?: Point
  viewport: Size
  dpr: number
  lod: LodMode
  segments: SegmentRef[]
  visibleNotes: readonly string[]
  /** A note's hanging pin (through gesture overrides). */
  pinOf(noteId: string): Point | undefined
  /**
   * Whether a note's hanging pin lies under a higher note's paper, which hides it (a pin cannot
   * pass through paper). Read for each pin drawn; the runtime keeps the answers until paper moves.
   */
  pinCovered?(noteId: string): boolean
  /** A segment's two edge pins (through gesture overrides); yarn runs between them. */
  endsOf: EndsOf
  /**
   * The pin a segment end is tied at when it is not an edge pin of its own (`Attach.sharedPin`):
   * null at the note's hanging pin (no edge pin drawn), else an id its sharers have (drawn once).
   */
  sharedPinOf?(ref: SegmentRef, end: End): string | null | undefined
  /** Whether a note's pin is a tag hook (through gesture overrides); defaults to the record. */
  hookOf?(noteId: string): boolean
  sagOf(ref: SegmentRef, a: Point, b: Point): Point
  alphaOf?(yarnId: string): number
  /** Drawn share of the thread's whole length (draw-in); 1 or undefined draws it all. */
  progressOf?(yarnId: string): number
  /** Deleted threads drawn on top this frame, never cached. */
  ghosts?: readonly GhostYarn[]
  /** Segments drawn every frame instead of from the cache. */
  dynamicKeys: ReadonlySet<string>
  /** Notes whose pins, and every segment touching them, are drawn every frame. */
  dynamicNotes: ReadonlySet<string>
  selectedYarnId?: string
  /** A thread's pulse, 0 (none) to 1 (the crest): it swells the cord by `PULSE_SWELL`. */
  pulseOf?(yarnId: string): number
  /** Notes whose hanging pin glows (hover, connect source); drawn over the cache. */
  glowNotes?: ReadonlySet<string>
  /** Edge pins that glow (hover, the connect's landing); drawn over the cache. */
  glowPins?: readonly GlowPin[]
  live?: LiveStrand | null
  /** Yarn above the notes (`over`, the default), above with covered spans erased, or below. */
  layer?: LayerMode
  /** `over-fix`: a note's paper as drawn and its z, through any gesture override. */
  paperOf?(noteId: string): (PaperShape & { z: number }) | undefined
  /** `over-fix`: notes above a segment whose paper its world polyline `pts` crosses. */
  occludersOf?(ref: SegmentRef, pts: readonly Point[]): readonly string[]
  /** Overview: the selected notes, outlined over the cache. */
  selectedNotes?: ReadonlySet<string>
  /**
   * Several selected notes (not one: the overlay frames that): the culled ones are framed on the
   * pin layer in screen px, so the frame is as thick at any zoom. Overview outlines them itself.
   */
  framedNotes?: ReadonlySet<string>
  /** Among the framed notes, the one that has the keyboard: its frame is in the focus ink. */
  focusedNote?: string
  /** Overview: the note under the hover, outlined over the cache. */
  hoverNoteId?: string
  /**
   * Overview on a lifetime board: the far-zoom picture pyramid draws the board (cards, threads,
   * pins), and only what is dynamic, the outlines and the hover are drawn over it here; the
   * dynamic notes and segments are left out of its tiles. Undefined: the card overview.
   */
  pyramid?: { draw(ctx: CanvasRenderingContext2D, view: PyramidView): PyramidFrame }
  /** With `pyramid`, a selection too large to walk each frame: the selected notes in view. */
  selectedInView?(): Iterable<string>
  /** Overview: a print's image tone (its average colour) by asset id, once measured. */
  toneOf?(assetId: string): string | undefined
  /**
   * Overview: an object that stays the same exactly while every note's paper and pin and every
   * segment's ends do (the runtime passes its edge-pin attachment). The static layer's world
   * geometry is cached under it; without one nothing is cached.
   */
  geometryKey?: object
  /**
   * Focus mode: only the shown notes' pins (cards) and the threads between them are drawn, a
   * thread from a shown note to a hidden one as its loose end; fading notes come from a second
   * cached layer, blitted under the static one at the fade's opacity. Null: the whole board.
   */
  focus?: FocusPaint | null
  /**
   * The board's spatial index, for the lite cache's patches: the segments (at their rest bounds)
   * and the notes (their rects) meeting a world rect. A patch then reads only what lies near the
   * change. Without it a patch walks the view (tests).
   */
  near?: {
    segments(r: Rect): Iterable<SegmentRef>
    notes(r: Rect): Iterable<string>
  }
}

/** Overview world geometry, per note and per segment, valid while `key` is unchanged. */
interface Geometry {
  key: object
  cards: Map<string, { card: CardShape; pin: Point | undefined }>
  threads: Map<string, { curve: CubicBezier; box: Rect }>
}

/** One segment ready to paint: its drawn world polyline and stroke style. */
interface Strand {
  ref: SegmentRef
  pts: Point[]
  /** False while a draw-in shows only the leading part. */
  whole: boolean
  /** Its edge pins, world px. */
  ends: { a: Point; b: Point }
  /**
   * What of `pts` shows above the paper when that is not all of it (`strandOverPaper`): a strand
   * from a hanging pin lies beneath its own note's paper.
   */
  runs?: Point[][]
  style: Parameters<typeof drawStrand>[2]
  /** A loose end (focus mode): only this end's stub is drawn, with only this end's pin. */
  loose?: End
}

export interface RenderStats {
  /** Segments held by the static cache. */
  segmentsStatic: number
  /** Segments drawn on top this frame. */
  segmentsDynamic: number
  /** Pins on screen, hanging and edge: cached plus drawn this frame. */
  pins: number
  /** Whether this frame redrew the static cache (otherwise it was blitted). */
  staticRedrawn: boolean
  /** Overview only: note cards on screen, cached plus drawn this frame. */
  cards?: number
  /** Overview from the picture pyramid: what its frame drew. */
  pyramid?: PyramidFrame
  /**
   * Lite, when this frame patched the static cache: the areas it cleared and how many segments
   * and pins it looked at to find what to draw again (what a patch costs, beside what it draws).
   */
  patched?: { areas: number; examined: number }
}

/** With the pyramid, a selection up to this size is outlined by walking it. */
const OUTLINE_WALK = 2000

/** The static cache covers the viewport plus this fraction of it on every side. */
export const STATIC_MARGIN = 0.25

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas
type CreateCanvas = (width: number, height: number) => AnyCanvas

const makeCanvas: CreateCanvas = (width, height) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

const context2d = (c: AnyCanvas) => c.getContext('2d') as CanvasRenderingContext2D | null

/**
 * Test only: with `globalThis.__papertieTest.yarnCpuRaster` set before the board opens, the static
 * canvases are CPU-backed (`willReadFrequently`), so a spec can compare a patched layer with a
 * whole redraw without the GPU canvas's raster, which depends on what else a flush holds. Never
 * set by the app.
 */
const staticContext = (c: AnyCanvas) =>
  (globalThis as { __papertieTest?: { yarnCpuRaster?: boolean } }).__papertieTest?.yarnCpuRaster ===
  true
    ? (c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null)
    : context2d(c)

/**
 * Whether the static cache drawn at `prev.camera` can be blitted for camera `c`: only at the same
 * zoom and while the pan since that redraw stays within the margin.
 */
export function staticCacheAction(
  prev: { camera: Camera; invalid: boolean } | null,
  c: Camera,
  viewport: Size,
): 'blit' | 'redraw' {
  if (prev === null || prev.invalid || prev.camera.zoom !== c.zoom) return 'redraw'
  const dx = Math.abs(c.x - prev.camera.x) * c.zoom
  const dy = Math.abs(c.y - prev.camera.y) * c.zoom
  const inside = dx <= STATIC_MARGIN * viewport.width && dy <= STATIC_MARGIN * viewport.height
  return inside ? 'blit' : 'redraw'
}

/**
 * Whether a static cache drawn for `i` can be patched: lite (no edge pins, so no pin shared
 * between threads), the whole board shown, and no erasing of covered spans (`over-fix`).
 */
function patchable_(i: YarnFrameInput): boolean {
  return i.lod === 'lite' && !i.focus && (i.layer ?? 'over') !== 'over-fix'
}

interface Cache {
  camera: Camera
  anchor: Point
  lod: LodMode
  layer: LayerMode
  selected: string | undefined
  dynamicKeys: Set<string>
  dynamicNotes: Set<string>
  segments: number
  pins: number
  cards: number
  /** The shared pins it holds: segments drawn live do not draw them again. */
  shared: Set<string>
  /** The focus paint's key the cache was drawn for (null: the whole board). */
  focusKey: object | null
  /** The fade layer's key it holds, drawn at `camera` too; null when it holds none. */
  fadeKey: object | null
  /**
   * Lite, the whole board shown, above or below the paper (not `over-fix`): where each thing it
   * holds was drawn, in its canvases' device px, so a change can be patched (`patchStatic`):
   * segments by key, hanging pins by note. Null when the cache cannot be patched.
   */
  drawn: { segs: Map<string, Box>; pins: Map<string, Box> } | null
  /**
   * The card overview's: the geometry its cards and threads were drawn from (world), so that
   * while a pass is drawn under it, what it holds and is drawn live now can be taken out of it
   * where it drew it (`overStale`). Null otherwise.
   */
  geometry?: Geometry | null
}

/** A device-px box in the static canvases: x0, y0, x1, y1. */
type Box = [number, number, number, number]

const meets = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

/** `boxes` with every two that overlap replaced by their bounding box, until none overlap. */
function disjoint(boxes: readonly Box[]): Box[] {
  const out = boxes.map((b): Box => [b[0], b[1], b[2], b[3]])
  for (let merged = true; merged; ) {
    merged = false
    for (let a = 0; a < out.length; a++) {
      for (let b = a + 1; b < out.length; b++) {
        const p = out[a] as Box
        const q = out[b] as Box
        if (!meets(p, q)) continue
        out[a] = [
          Math.min(p[0], q[0]),
          Math.min(p[1], q[1]),
          Math.max(p[2], q[2]),
          Math.max(p[3], q[3]),
        ]
        out.splice(b, 1)
        merged = true
        b = a
      }
    }
  }
  return out
}

/**
 * More changed segments and notes than this in one patch, or a patch over more than
 * `PATCH_AREA` of the canvas, and the static layer is redrawn whole instead.
 */
const PATCH_MAX = 256
const PATCH_AREA = 0.4

/** A pair of offscreen layers, yarn and pins, the size of the static cache. */
interface Layers {
  yarn: AnyCanvas
  pins: AnyCanvas
  yarnCtx: CanvasRenderingContext2D | null
  pinCtx: CanvasRenderingContext2D | null
}

/**
 * A card overview whose redraw would take longer than this, ms, is drawn over several frames
 * instead: the lifetime board in view whole, before its picture pyramid is made,
 * drew 100,000 cards and 10,000 threads in one frame, a task of 416–474 ms, and the 6,519 cards of
 * its first paint 51–64 ms. A redraw's cost is guessed from the cards and threads in view at what
 * an overview's card or thread last cost here ({@link OVERVIEW_ITEM_MS} until one is measured);
 * a cheaper one is drawn whole in its frame, as ever.
 */
const OVERVIEW_WHOLE_MS = 12
/** A redraw of fewer cards and threads than this teaches nothing of their cost. */
const OVERVIEW_MEASURED_FROM = 4096
/**
 * What a card or thread of the card overview is taken to cost, ms, until one is measured: about
 * half the 4 µs that 110,000 took under load (416–474 ms), the first draw computing every
 * card's geometry. A smaller board in view whole (a few thousand) is then drawn whole at once.
 */
export const OVERVIEW_ITEM_MS = 0.002
/** A frame gives a sliced overview's pass this long, ms (at least one piece). */
const OVERVIEW_SLICE_MS = 6
/** Cards, threads or pins drawn in one piece of a pass. */
const OVERVIEW_PIECE = 1024

/**
 * A card overview drawn a piece at a time into layers of its own (`back`): its cards in paint
 * order, then its threads, then the pins, as a whole redraw draws them, each piece batched as
 * `drawCards` batches a frame's. Its input is the one it began with (the ids and segments in view,
 * what was live), read against the board of each frame; it becomes the cache once done.
 */
interface Pass {
  /** What the cache holds once the pass is done (its counts grow as it goes). */
  cache: Cache
  map: (p: Point) => Point
  area: Rect
  ids: readonly string[]
  segs: readonly SegmentRef[]
  isDynamic: (ref: SegmentRef) => boolean
  /** 0 cards, 1 threads, 2 pins, 3 done. */
  stage: number
  /** The time its cards and threads took so far, ms. */
  spent: number
  next: number
  pins: Point[]
  layers: Layers
}

/**
 * Options (tests): the clock redraws and a pass are timed by, the first guess of a card's or
 * thread's cost ({@link OVERVIEW_ITEM_MS}), and the pieces a pass is drawn in.
 */
export interface YarnRendererOptions {
  now?: () => number
  overviewItemMs?: number
  overviewPiece?: number
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a.size !== b.size) return false
  for (const k of a) if (!b.has(k)) return false
  return true
}

const sanitizeDpr = (dpr: number) => (Number.isFinite(dpr) && dpr > 0 ? dpr : 1)

/** No ids: shared, never written (an empty sort is skipped). */
const NO_IDS: string[] = []

/**
 * Draws yarn onto the yarn canvas and pins onto the pin canvas. Each segment runs between its
 * two edge pins (`endsOf`), which are drawn with it on the pin layer; a note's hanging pin is
 * drawn per visible note. Everything not dynamic is drawn once into an offscreen static layer
 * (viewport plus 25% per side) and blitted while the camera pans within that margin; dynamic
 * segments with their edge pins, moving notes' pins, loosening ghosts, the live thread and
 * glowing pins are drawn on top every frame. Everything maps relative to `anchor` (the floating
 * origin), and a rebase redraws the cache.
 * In `over-fix` each layer paints its own `buildDrawList`, erasing every occluding note's paper
 * (`destination-out`) between levels; dynamic segments that need an erase go through their own
 * buffer so it cannot touch the cache. In `under` the yarn canvas sits below the notes (CSS) and
 * each segment's `pinStubs` are painted on the pin layer beneath the heads.
 * Focus mode (`focus`) draws the shown notes' part only, with a loose end (on the pin layer,
 * beneath the heads) for each thread leaving them; while a fade runs, what fades is drawn once
 * into a second cache and blitted beneath the first at the fade's opacity, so a fade frame costs
 * two blits, not a redraw.
 */
export class YarnRenderer {
  private readonly yarnCtx: CanvasRenderingContext2D | null
  private readonly pinCtx: CanvasRenderingContext2D | null
  // The static cache's layers; a sliced overview's pass, once done, trades them for its own.
  private staticYarn: AnyCanvas
  private staticPins: AnyCanvas
  private staticYarnCtx: CanvasRenderingContext2D | null
  private staticPinCtx: CanvasRenderingContext2D | null
  /** A sliced card overview under way, and the layers it draws into; made on first use. */
  private pass: Pass | null = null
  private back: Layers | null = null
  /** The last render ended a pass on a board that changed while it ran (`behind`). */
  private ended = false
  private readonly now: () => number
  /**
   * What a card or thread of the card overview costs, ms: the costliest measured recently (a
   * whole redraw's, a pass piece's), slowly forgotten.
   */
  private itemMs: number
  private readonly piece: number
  private viewport: Size = { width: 0, height: 0 }
  private dpr = 1
  private sprites = createPinSprites(1)
  /** Static margin per side, in device px. */
  private margin = { x: 0, y: 0 }
  private cache: Cache | null = null
  private invalid = true
  /** `i.segments` and `i.visibleNotes` by place (paint order), made once per cull for patches. */
  private segPlace: { of: readonly SegmentRef[]; at: Map<string, number> } | null = null
  private notePlace: { of: readonly string[]; at: Map<string, number> } | null = null
  /** What the last patch looked at (`RenderStats.patched`). */
  private lastPatch: { areas: number; examined: number } | null = null
  /**
   * Test seam: told, for each area a patch clears, the segments (by key) and pins (by note) it
   * draws there again, in the order it draws them. Never set by the app.
   */
  onPatchArea:
    | ((area: readonly [number, number, number, number], segs: string[], pins: string[]) => void)
    | null = null
  /** Segments (by key) and notes changed since the cache was drawn: patched where it can be. */
  private changedSegs = new Set<string>()
  private changedNotes = new Set<string>()
  private warmed = false
  private geometry: Geometry | null = null
  /** `over-fix` buffer for dynamic segments with erases; made on first use. */
  private dynamicYarn: { canvas: AnyCanvas; ctx: CanvasRenderingContext2D | null } | null = null
  /** Focus mode's fade layer: what fades in or out, drawn once per fade; made on first use. */
  private fadeLayers: Layers | null = null

  constructor(
    private readonly yarnCanvas: HTMLCanvasElement,
    private readonly pinCanvas: HTMLCanvasElement,
    private readonly createCanvas: CreateCanvas = makeCanvas,
    options: YarnRendererOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now())
    this.itemMs = options.overviewItemMs ?? OVERVIEW_ITEM_MS
    this.piece = options.overviewPiece ?? OVERVIEW_PIECE
    this.yarnCtx = yarnCanvas.getContext('2d')
    this.pinCtx = pinCanvas.getContext('2d')
    this.staticYarn = createCanvas(1, 1)
    this.staticPins = createCanvas(1, 1)
    this.staticYarnCtx = staticContext(this.staticYarn)
    this.staticPinCtx = staticContext(this.staticPins)
  }

  /** True when the next render must redraw the static cache, whole or in part. */
  get staticInvalid(): boolean {
    return this.invalid || this.changedSegs.size > 0 || this.changedNotes.size > 0
  }

  /** A sliced card overview is under way: each frame draws a piece more of it, until done. */
  get passing(): boolean {
    return this.pass !== null
  }

  /**
   * The last render ended a pass while the board had changed since it began: the picture it made lacks the change, so the next frame must begin the pass that
   * draws it. A frame is asked for on it, else an idle board would show the old picture until
   * something unrelated asked for one.
   */
  get behind(): boolean {
    return this.ended && this.staticInvalid
  }

  /** Resize the static layers for a new viewport or DPR; the cache is redrawn next frame. */
  resize(viewport: Size, dpr: number): void {
    const ratio = sanitizeDpr(dpr)
    if (ratio !== this.dpr || !this.warmed) {
      if (ratio !== this.dpr) this.sprites = createPinSprites(ratio)
      this.warmSprites()
    }
    this.dpr = ratio
    this.viewport = { width: Math.max(0, viewport.width), height: Math.max(0, viewport.height) }
    this.margin = {
      x: Math.ceil(STATIC_MARGIN * this.viewport.width * ratio),
      y: Math.ceil(STATIC_MARGIN * this.viewport.height * ratio),
    }
    const w = Math.max(1, Math.round(this.viewport.width * ratio) + 2 * this.margin.x)
    const h = Math.max(1, Math.round(this.viewport.height * ratio) + 2 * this.margin.y)
    const fade = this.fadeLayers
    const back = this.back
    for (const c of [
      this.staticYarn,
      this.staticPins,
      ...(fade === null ? [] : [fade.yarn, fade.pins]),
      ...(back === null ? [] : [back.yarn, back.pins]),
    ]) {
      if (c.width !== w) c.width = w
      if (c.height !== h) c.height = h
    }
    this.pass = null
    if (this.dynamicYarn !== null) this.sizeDynamic(this.dynamicYarn.canvas)
    this.invalid = true
  }

  /**
   * Pre-render the pin sprites while the browser is idle, a few per idle period, so a zoom never
   * renders one mid-frame.
   */
  private warmSprites(): void {
    if (typeof requestIdleCallback !== 'function') return
    this.warmed = true
    const sprites = this.sprites
    const step = (d: IdleDeadline) => {
      if (sprites === this.sprites && !sprites.warm(() => d.timeRemaining())) {
        requestIdleCallback(step)
      }
    }
    requestIdleCallback(step)
  }

  private sizeDynamic(c: AnyCanvas): void {
    const w = Math.max(1, Math.round(this.viewport.width * this.dpr))
    const h = Math.max(1, Math.round(this.viewport.height * this.dpr))
    if (c.width !== w) c.width = w
    if (c.height !== h) c.height = h
  }

  /**
   * Drop the static cache, e.g. after the board changed. With `changed` (the segments whose ends
   * or sag moved and the notes whose pins did), a lite cache is patched where they were and are
   * (`patchStatic`) rather than redrawn whole; otherwise it is redrawn whole.
   */
  invalidateStatic(changed?: { segments: Iterable<string>; notes: Iterable<string> }): void {
    if (changed === undefined) {
      this.invalid = true
      return
    }
    if (this.invalid) return
    for (const k of changed.segments) this.changedSegs.add(k)
    for (const id of changed.notes) this.changedNotes.add(id)
    if (this.changedSegs.size + this.changedNotes.size > PATCH_MAX) this.invalid = true
  }

  render(i: YarnFrameInput): RenderStats {
    this.ended = false
    const dpr = sanitizeDpr(i.dpr)
    if (
      dpr !== this.dpr ||
      i.viewport.width !== this.viewport.width ||
      i.viewport.height !== this.viewport.height
    ) {
      this.resize(i.viewport, dpr)
    }
    const stats: RenderStats = {
      segmentsStatic: 0,
      segmentsDynamic: 0,
      pins: 0,
      staticRedrawn: false,
    }
    if (this.viewport.width * this.viewport.height === 0) return stats

    const anchor = i.anchor ?? ORIGIN
    const map = screenMapper(i.camera, dpr, anchor)
    const layer = i.layer ?? 'over'
    const cache = this.cache
    // A lite cache follows a change of what is drawn live by a patch (`patchStatic`).
    const patchable = cache?.drawn != null && patchable_(i)
    let redraw =
      cache === null ||
      cache.anchor.x !== anchor.x ||
      cache.anchor.y !== anchor.y ||
      cache.lod !== i.lod ||
      cache.layer !== layer ||
      cache.selected !== i.selectedYarnId ||
      cache.focusKey !== (i.focus?.key ?? null) ||
      (!patchable &&
        (this.changedSegs.size > 0 ||
          this.changedNotes.size > 0 ||
          !sameSet(cache.dynamicKeys, i.dynamicKeys) ||
          !sameSet(cache.dynamicNotes, i.dynamicNotes))) ||
      staticCacheAction(
        cache && { camera: cache.camera, invalid: this.invalid },
        i.camera,
        i.viewport,
      ) === 'redraw'
    let shift = { x: 0, y: 0 }
    if (!redraw && cache !== null) {
      // Measured at the shared anchor, so both offsets are small and exact.
      const then = screenMapper(cache.camera, dpr, anchor)(anchor)
      const now = map(anchor)
      shift = { x: Math.round((now.x - then.x) * dpr), y: Math.round((now.y - then.y) * dpr) }
      redraw = Math.abs(shift.x) > this.margin.x || Math.abs(shift.y) > this.margin.y
      if (redraw) shift = { x: 0, y: 0 }
    }
    const isDynamic = (ref: SegmentRef) =>
      i.dynamicKeys.has(ref.key) ||
      i.dynamicNotes.has(ref.aNoteId) ||
      i.dynamicNotes.has(ref.bNoteId)

    if (i.lod === 'overview' && i.pyramid !== undefined) {
      // The pyramid draws every frame from its tiles: no static cache (the card overview draws
      // its own again when it is back).
      this.cache = null
      this.pass = null
      for (const [ctx, canvas] of [
        [this.yarnCtx, this.yarnCanvas],
        [this.pinCtx, this.pinCanvas],
      ] as const) {
        if (ctx === null) continue
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
      if (this.yarnCtx !== null) {
        stats.pyramid = i.pyramid.draw(this.yarnCtx, {
          camera: i.camera,
          anchor,
          dpr,
          viewport: i.viewport,
        })
        this.yarnCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      this.pinCtx?.setTransform(dpr, 0, 0, dpr, 0, 0)
      stats.staticRedrawn = true
      this.paintOverviewDynamic(i, map, isDynamic, stats)
      return stats
    }

    // A card overview too large for one frame is drawn over several. A pass under way
    // goes on while what it draws still holds; a change of the board meanwhile is drawn by the
    // pass after it.
    if (this.pass !== null && !this.passHolds(this.pass, i)) this.pass = null
    if (
      i.lod === 'overview' &&
      (this.pass !== null || ((redraw || this.cache === null) && this.sliced(i)))
    ) {
      return this.renderPass(i, map, isDynamic, stats)
    }
    this.pass = null
    this.lastPatch = null
    if ((redraw || this.cache === null) && i.lod === 'overview') {
      const began = this.now()
      this.cache = this.redrawStatic(i, map, isDynamic)
      this.measured(i.visibleNotes.length + i.segments.length, this.now() - began)
    } else if (redraw || this.cache === null) this.cache = this.redrawStatic(i, map, isDynamic)
    else if (!this.patchStatic(i, isDynamic)) {
      this.cache = this.redrawStatic(i, map, isDynamic)
      redraw = true
    }
    stats.staticRedrawn = redraw
    if (this.lastPatch !== null) stats.patched = this.lastPatch
    stats.segmentsStatic = this.cache.segments
    stats.pins = this.cache.pins
    // Focus fading: its layer is drawn once at the cache's camera (with each static redraw, or
    // when the fade begins), then only blitted under the cache at the fade's opacity.
    const fade = i.focus?.fade ?? null
    if (fade === null) this.cache.fadeKey = null
    else if (redraw || this.cache.fadeKey !== fade.key) {
      this.redrawFade(i, isDynamic)
      this.cache.fadeKey = fade.key
    }
    const under = fade === null ? null : this.fadeLayers
    const fadeAlpha = fade === null ? 0 : Math.max(0, Math.min(1, fade.alpha || 0))

    const blit = (
      ctx: CanvasRenderingContext2D | null,
      canvas: HTMLCanvasElement,
      src: AnyCanvas,
      below: AnyCanvas | undefined,
    ) => {
      if (ctx === null) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (below !== undefined && fadeAlpha > 0) {
        ctx.globalAlpha = fadeAlpha
        ctx.drawImage(below, shift.x - this.margin.x, shift.y - this.margin.y)
        ctx.globalAlpha = 1
      }
      ctx.drawImage(src, shift.x - this.margin.x, shift.y - this.margin.y)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    blit(this.yarnCtx, this.yarnCanvas, this.staticYarn, under?.yarn)
    blit(this.pinCtx, this.pinCanvas, this.staticPins, under?.pins)
    if (i.lod === 'overview') {
      stats.cards = this.cache.cards
      this.paintOverviewDynamic(i, map, isDynamic, stats)
      return stats
    }

    const dynamic: Strand[] = []
    const dynamicLoose: Strand[] = []
    for (const ref of i.segments) {
      if (!isDynamic(ref)) continue
      const part = this.partIn(i, 'shown', ref)
      const s = part === null ? null : this.strand(ref, i, part)
      if (s !== null) (s.loose === undefined ? dynamic : dynamicLoose).push(s)
    }
    stats.segmentsDynamic = dynamic.length + dynamicLoose.length
    if (this.yarnCtx !== null) {
      this.paintDynamic(this.yarnCtx, dynamic, i, map)
      for (const g of i.ghosts ?? [])
        stats.segmentsDynamic += this.drawGhost(this.yarnCtx, g, i, map)
      if (i.live) {
        const { from, to, sag, color, under } = i.live
        const pts = flattenBezier(segmentBezier(from, to, sag), 0.5 / i.camera.zoom)
        const own = under === undefined || layer === 'under' ? undefined : this.shapeOf(under, i)
        const style = { color: yarnColor(color), zoom: i.camera.zoom, lite: i.lod === 'lite' }
        for (const run of own ? strandOverPaper(pts, { start: own }) : [pts]) {
          drawStrand(this.yarnCtx, run.map(map), style)
        }
        stats.segmentsDynamic++
      }
    }
    if (this.pinCtx !== null) {
      // Beneath everything already on the pin layer, so the cached heads stay on top.
      const beneath = layer === 'under' || dynamicLoose.length > 0
      if (beneath) {
        this.pinCtx.save()
        this.pinCtx.globalCompositeOperation = 'destination-over'
        for (const s of dynamicLoose) drawStrand(this.pinCtx, s.pts.map(map), s.style)
      }
      if (layer === 'under') {
        for (const s of dynamic) this.drawStubs(this.pinCtx, s, map)
        if (i.live) {
          const { from, to, sag, color } = i.live
          const pts = flattenBezier(segmentBezier(from, to, sag), 0.5 / i.camera.zoom)
          const start = sliceByLength(pts, 0, PIN_STUB_WORLD)
          drawStrand(this.pinCtx, start.map(map), {
            color: yarnColor(color),
            zoom: i.camera.zoom,
            lite: i.lod === 'lite',
          })
        }
      }
      if (beneath) this.pinCtx.restore()
      const shared = new Set(this.cache.shared)
      for (const s of dynamic) stats.pins += this.drawEnds(this.pinCtx, s, i, map, shared)
      for (const s of dynamicLoose) stats.pins += this.drawEnds(this.pinCtx, s, i, map, shared)
      for (const g of i.ghosts ?? []) this.drawGhostPins(this.pinCtx, g, i, map)
      for (const id of i.visibleNotes) {
        if (!i.dynamicNotes.has(id) || !this.noteIn(i, 'shown', id)) continue
        if (this.drawPin(this.pinCtx, id, i, map)) stats.pins++
      }
      this.drawFrames(this.pinCtx, i, map)
      for (const id of i.glowNotes ?? []) this.drawPin(this.pinCtx, id, i, map, true)
      for (const g of i.glowPins ?? []) {
        this.sprites.draw(this.pinCtx, map(g.p), i.camera.zoom, {
          lite: i.lod === 'lite',
          glow: true,
          kind: g.kind,
        })
      }
    }
    return stats
  }

  /** Whether `i` draws a card overview too large for one frame (focus mode never slices). */
  private sliced(i: YarnFrameInput): boolean {
    return !i.focus && (i.visibleNotes.length + i.segments.length) * this.itemMs > OVERVIEW_WHOLE_MS
  }

  /**
   * `items` cards or threads of the overview took `ms`: what the next redraw is guessed from. Only
   * a large redraw (a whole one, or a whole pass) is a measure: a small one's cost is mostly what
   * any frame costs, and a board that small is drawn whole whatever it is guessed at.
   */
  private measured(items: number, ms: number): void {
    if (items >= OVERVIEW_MEASURED_FROM && Number.isFinite(ms))
      this.itemMs = Math.max(ms / items, this.itemMs * 0.8)
  }

  /**
   * Whether pass `p` still draws what `i` shows: the card overview at the same zoom and anchor,
   * the same layer and selected thread, and a pan since it began within the static margin.
   */
  private passHolds(p: Pass, i: YarnFrameInput): boolean {
    const c = p.cache
    const anchor = i.anchor ?? ORIGIN
    if (
      i.lod !== 'overview' ||
      i.focus ||
      c.camera.zoom !== i.camera.zoom ||
      c.anchor.x !== anchor.x ||
      c.anchor.y !== anchor.y ||
      c.layer !== (i.layer ?? 'over') ||
      c.selected !== i.selectedYarnId
    )
      return false
    const s = this.shiftFrom(c, i)
    return Math.abs(s.x) <= this.margin.x && Math.abs(s.y) <= this.margin.y
  }

  /** How far (device px) a cache drawn at `c`'s camera has moved on screen at `i`'s, same zoom. */
  private shiftFrom(c: Cache, i: YarnFrameInput): Point {
    const then = screenMapper(c.camera, this.dpr, c.anchor)(c.anchor)
    const now = screenMapper(i.camera, this.dpr, c.anchor)(c.anchor)
    return {
      x: Math.round((now.x - then.x) * this.dpr),
      y: Math.round((now.y - then.y) * this.dpr),
    }
  }

  private startPass(i: YarnFrameInput): Pass {
    if (this.back === null) {
      const yarn = this.createCanvas(this.staticYarn.width, this.staticYarn.height)
      const pins = this.createCanvas(this.staticPins.width, this.staticPins.height)
      for (const [c, like] of [
        [yarn, this.staticYarn],
        [pins, this.staticPins],
      ] as const) {
        c.width = like.width
        c.height = like.height
      }
      this.back = { yarn, pins, yarnCtx: staticContext(yarn), pinCtx: staticContext(pins) }
    }
    const anchor = i.anchor ?? ORIGIN
    const dynamicKeys = new Set(i.dynamicKeys)
    const dynamicNotes = new Set(i.dynamicNotes)
    this.invalid = false
    this.changedSegs.clear()
    this.changedNotes.clear()
    const layers = this.back
    for (const [ctx, canvas] of [
      [layers.yarnCtx, layers.yarn],
      [layers.pinCtx, layers.pins],
    ] as const) {
      if (ctx === null) continue
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.setTransform(this.dpr, 0, 0, this.dpr, this.margin.x, this.margin.y)
    }
    return {
      cache: {
        camera: i.camera,
        anchor,
        lod: i.lod,
        layer: i.layer ?? 'over',
        selected: i.selectedYarnId,
        dynamicKeys,
        dynamicNotes,
        segments: 0,
        pins: 0,
        cards: 0,
        shared: new Set(),
        focusKey: null,
        fadeKey: null,
        drawn: null,
        geometry: this.geometryFor(i),
      },
      map: screenMapper(i.camera, this.dpr, anchor),
      area: this.staticArea(i.camera),
      ids: i.visibleNotes.slice(),
      segs: i.segments.slice(),
      isDynamic: (ref) =>
        dynamicKeys.has(ref.key) || dynamicNotes.has(ref.aNoteId) || dynamicNotes.has(ref.bNoteId),
      stage: 0,
      spent: 0,
      next: 0,
      pins: [],
      layers,
    }
  }

  /** Draw pieces of pass `p` for this frame's share of time (one at least). */
  private advancePass(p: Pass, i: YarnFrameInput): void {
    const until = this.now() + OVERVIEW_SLICE_MS
    const { yarnCtx, pinCtx } = p.layers
    const keepNote = (id: string) => !p.cache.dynamicNotes.has(id) && this.noteIn(i, 'shown', id)
    const keepRef = (ref: SegmentRef) =>
      !p.isDynamic(ref) && this.partIn(i, 'shown', ref) === 'whole'
    do {
      const began = this.now()
      if (p.stage === 0) {
        const ids = p.ids.slice(p.next, p.next + this.piece)
        p.next += ids.length
        const cards = this.overviewCards({ ...i, visibleNotes: ids }, p.map, keepNote, p.area, true)
        if (yarnCtx !== null) drawCards(yarnCtx, cards.paints)
        p.cache.cards += cards.paints.length
        for (const pin of cards.pins) p.pins.push(pin)
      } else if (p.stage === 1) {
        const segs = p.segs.slice(p.next, p.next + this.piece)
        p.next += segs.length
        const threads = this.overviewThreads(
          { ...i, segments: segs, camera: p.cache.camera },
          p.map,
          keepRef,
          p.area,
          true,
        )
        // Each piece strokes its threads by dye, as a whole redraw strokes all of them: where two
        // threads of one dye from different pieces cross, the crossing takes the threads'
        // opacity twice (one stroke takes it once), and dyes from different pieces stack in
        // piece order there. A sub-px difference at a crossing of 1–1.5 px threads, invisible at
        // overview zoom; one stroke per dye would be the whole redraw's long task again. Cards and pins are drawn exactly as whole: a piece's levels keep z
        // order, and a pin dot is opaque.
        if (yarnCtx !== null) drawThreads(yarnCtx, threads)
        p.cache.segments += threads.length
      } else {
        const pins = p.pins.slice(p.next, p.next + this.piece)
        p.next += pins.length
        if (pinCtx !== null) drawPinDots(pinCtx, pins, overviewPinRadius(p.cache.camera.zoom))
        p.cache.pins += pins.length
      }
      // Pins are a fraction of a card's cost: only cards and threads are what a redraw is guessed by.
      if (p.stage < 2) p.spent += this.now() - began
      const length = p.stage === 0 ? p.ids.length : p.stage === 1 ? p.segs.length : p.pins.length
      if (p.next >= length) {
        p.stage++
        p.next = 0
      }
    } while (p.stage < 3 && this.now() < until)
  }

  /**
   * A frame of a sliced card overview: a piece more of the pass (begun now if need be); the cache
   * blitted (scaled, when it was drawn at another zoom), or with none, the pass as far as it has
   * come; then what is live over it. The pass, once done, is the cache.
   */
  private renderPass(
    i: YarnFrameInput,
    map: (p: Point) => Point,
    isDynamic: (ref: SegmentRef) => boolean,
    stats: RenderStats,
  ): RenderStats {
    this.lastPatch = null
    if (this.pass === null) this.pass = this.startPass(i)
    const p = this.pass
    this.advancePass(p, i)
    stats.staticRedrawn = true
    if (p.stage >= 3) {
      this.measured(p.ids.length + p.segs.length, p.spent)
      // Done: its layers are the cache's now, and the cache's are the next pass's.
      const front = {
        yarn: this.staticYarn,
        pins: this.staticPins,
        yarnCtx: this.staticYarnCtx,
        pinCtx: this.staticPinCtx,
      }
      this.staticYarn = p.layers.yarn
      this.staticPins = p.layers.pins
      this.staticYarnCtx = p.layers.yarnCtx
      this.staticPinCtx = p.layers.pinCtx
      this.back = front
      this.cache = p.cache
      this.pass = null
      this.ended = true
    }
    const anchor = i.anchor ?? ORIGIN
    const c = this.cache
    // The last whole picture of the card overview at this anchor, else the pass's so far.
    const whole =
      c !== null &&
      c.lod === 'overview' &&
      c.focusKey === null &&
      c.anchor.x === anchor.x &&
      c.anchor.y === anchor.y &&
      c.layer === (i.layer ?? 'over')
    const shown =
      whole && c !== null
        ? { cache: c, yarn: this.staticYarn, pins: this.staticPins }
        : { cache: p.cache, yarn: p.layers.yarn, pins: p.layers.pins }
    const from = shown.cache
    const k = i.camera.zoom / from.camera.zoom
    // Device px on screen of a point at device px `q` in the shown layers.
    const then = screenMapper(from.camera, this.dpr, from.anchor)(from.anchor)
    const now = map(from.anchor)
    const dx = this.dpr * now.x - k * (this.margin.x + this.dpr * then.x)
    const dy = this.dpr * now.y - k * (this.margin.y + this.dpr * then.y)
    const dpr = this.dpr
    const blit = (
      ctx: CanvasRenderingContext2D | null,
      canvas: HTMLCanvasElement,
      src: AnyCanvas,
    ) => {
      if (ctx === null) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (k === 1) ctx.drawImage(src, Math.round(dx), Math.round(dy))
      else ctx.drawImage(src, dx, dy, src.width * k, src.height * k)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    blit(this.yarnCtx, this.yarnCanvas, shown.yarn)
    blit(this.pinCtx, this.pinCanvas, shown.pins)
    stats.segmentsStatic = from.segments
    stats.pins = from.pins
    stats.cards = from.cards
    const over = this.overStale(from, i, isDynamic, map)
    if (over === null) this.paintOverviewDynamic(i, map, isDynamic, stats)
    else this.paintOverviewDynamic(over.i, map, over.isDynamic, stats)
    return stats
  }

  /**
   * The picture `c` shown under a pass (the last whole one, or the pass's own so far) was drawn
   * with other things live or another thread selected than frame `i` has: a drag begun or ended, a
   * thread picked. What it drew that is live now (a card that began to move, its threads, the
   * thread selected then) is taken out of it where it drew it, from the geometry it was drawn
   * from; that and what it left out that is static now (a card put down) is drawn live over it
   * until the pass is done. Null when nothing differs. O(the live sets), and the threads in view
   * once, as a frame with live notes walks them anyway.
   */
  private overStale(
    c: Cache,
    i: YarnFrameInput,
    isDynamic: (ref: SegmentRef) => boolean,
    map: (p: Point) => Point,
  ): { i: YarnFrameInput; isDynamic: (ref: SegmentRef) => boolean } | null {
    const picked = c.selected !== i.selectedYarnId
    if (!picked && sameSet(c.dynamicNotes, i.dynamicNotes) && sameSet(c.dynamicKeys, i.dynamicKeys))
      return null
    const g = c.geometry ?? null
    const wasLive = (ref: SegmentRef) =>
      c.dynamicKeys.has(ref.key) ||
      c.dynamicNotes.has(ref.aNoteId) ||
      c.dynamicNotes.has(ref.bNoteId)
    const liveKeys = new Set(i.dynamicKeys)
    const threads: CubicBezier[] = []
    for (const ref of i.segments) {
      const was = wasLive(ref)
      const now = isDynamic(ref)
      const repicked = picked && (ref.yarnId === c.selected || ref.yarnId === i.selectedYarnId)
      if (was === now && !repicked) continue
      liveKeys.add(ref.key)
      const t = was ? undefined : g?.threads.get(ref.key)
      if (t !== undefined) threads.push(mapCubic(t.curve, map))
    }
    const liveNotes = new Set(i.dynamicNotes)
    for (const id of c.dynamicNotes) liveNotes.add(id)
    const cards: Point[][] = []
    const pins: Point[] = []
    for (const id of i.dynamicNotes) {
      if (c.dynamicNotes.has(id)) continue
      const k = g?.cards.get(id)
      if (k === undefined) continue
      cards.push(k.card.corners.map(map))
      if (k.pin !== undefined) pins.push(map(k.pin))
    }
    const zoom = i.camera.zoom
    if (this.yarnCtx !== null)
      eraseOverview(
        this.yarnCtx,
        cards,
        threads,
        overviewYarnWidth(zoom) * OVERVIEW.selectedYarnScale,
      )
    if (this.pinCtx !== null) eraseOverview(this.pinCtx, [], [], 0, pins, overviewPinRadius(zoom))
    return {
      i: { ...i, dynamicNotes: liveNotes, dynamicKeys: liveKeys },
      isDynamic: (ref) =>
        liveKeys.has(ref.key) || liveNotes.has(ref.aNoteId) || liveNotes.has(ref.bNoteId),
    }
  }

  private redrawStatic(
    i: YarnFrameInput,
    map: (p: Point) => Point,
    isDynamic: (ref: SegmentRef) => boolean,
  ): Cache {
    const cache: Cache = {
      camera: i.camera,
      anchor: i.anchor ?? ORIGIN,
      lod: i.lod,
      layer: i.layer ?? 'over',
      selected: i.selectedYarnId,
      dynamicKeys: new Set(i.dynamicKeys),
      dynamicNotes: new Set(i.dynamicNotes),
      segments: 0,
      pins: 0,
      cards: 0,
      shared: new Set(),
      focusKey: i.focus?.key ?? null,
      fadeKey: null,
      drawn: patchable_(i) ? { segs: new Map(), pins: new Map() } : null,
      geometry: i.lod === 'overview' ? this.geometryFor(i) : null,
    }
    this.invalid = false
    this.changedSegs.clear()
    this.changedNotes.clear()
    const layers = {
      yarn: this.staticYarn,
      pins: this.staticPins,
      yarnCtx: this.staticYarnCtx,
      pinCtx: this.staticPinCtx,
    }
    const counts = this.paintLayer(
      i,
      map,
      isDynamic,
      'shown',
      layers,
      cache.shared,
      cache.drawn ?? undefined,
    )
    cache.segments = counts.segments
    cache.pins = counts.pins
    cache.cards = counts.cards
    return cache
  }

  /** Focus mode's fade layer, at the static cache's camera, so the two blit as one. */
  private redrawFade(i: YarnFrameInput, isDynamic: (ref: SegmentRef) => boolean): void {
    const cache = this.cache
    if (cache === null) return
    if (this.fadeLayers === null) {
      const yarn = this.createCanvas(this.staticYarn.width, this.staticYarn.height)
      const pins = this.createCanvas(this.staticPins.width, this.staticPins.height)
      this.fadeLayers = { yarn, pins, yarnCtx: context2d(yarn), pinCtx: context2d(pins) }
    }
    const at = { ...i, camera: cache.camera, anchor: cache.anchor }
    this.paintLayer(
      at,
      screenMapper(cache.camera, this.dpr, cache.anchor),
      isDynamic,
      'fade',
      this.fadeLayers,
      // A shared pin the shown layer holds is its: the fading layer does not draw it again.
      new Set(cache.shared),
    )
  }

  /**
   * Paint the non-dynamic yarn and pins of one focus `layer` (with focus off, everything is on
   * the shown layer) into `to`, cleared first, adding the shared pins it draws to `shared`.
   * Returns what it drew.
   */
  private paintLayer(
    i: YarnFrameInput,
    map: (p: Point) => Point,
    isDynamic: (ref: SegmentRef) => boolean,
    focusLayer: FocusLayer,
    to: Layers,
    shared: Set<string>,
    drawn?: { segs: Map<string, Box>; pins: Map<string, Box> },
  ): { segments: number; pins: number; cards: number } {
    const layer = i.layer ?? 'over'
    const out = { segments: 0, pins: 0, cards: 0 }
    const prepare = (ctx: CanvasRenderingContext2D | null, canvas: AnyCanvas) => {
      if (ctx === null) return null
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.setTransform(this.dpr, 0, 0, this.dpr, this.margin.x, this.margin.y)
      return ctx
    }
    if (i.lod === 'overview') {
      // At a few px a loose end is a speck: overview draws whole threads only.
      const area = this.staticArea(i.camera)
      const keepNote = (id: string) => !i.dynamicNotes.has(id) && this.noteIn(i, focusLayer, id)
      const keepRef = (ref: SegmentRef) =>
        !isDynamic(ref) && this.partIn(i, focusLayer, ref) === 'whole'
      const cards = this.overviewCards(i, map, keepNote, area, true)
      const threads = this.overviewThreads(i, map, keepRef, area, true)
      const yarnCtx = prepare(to.yarnCtx, to.yarn)
      if (yarnCtx !== null) {
        drawCards(yarnCtx, cards.paints)
        drawThreads(yarnCtx, threads)
      }
      const pinCtx = prepare(to.pinCtx, to.pins)
      if (pinCtx !== null) drawPinDots(pinCtx, cards.pins, overviewPinRadius(i.camera.zoom))
      out.cards = cards.paints.length
      out.pins = cards.pins.length
      out.segments = threads.length
      return out
    }
    const strands: Strand[] = []
    const loose: Strand[] = []
    for (const ref of i.segments) {
      if (isDynamic(ref)) continue
      const part = this.partIn(i, focusLayer, ref)
      const s = part === null ? null : this.strand(ref, i, part)
      if (s !== null) (s.loose === undefined ? strands : loose).push(s)
    }
    out.segments = strands.length + loose.length
    if (drawn !== undefined) {
      for (const st of strands) drawn.segs.set(st.ref.key, this.strandBox(st, map))
      for (const id of i.visibleNotes) {
        if (i.dynamicNotes.has(id)) continue
        const b = this.pinBox(id, i, map)
        if (b !== undefined) drawn.pins.set(id, b)
      }
    }
    const yarnCtx = prepare(to.yarnCtx, to.yarn)
    if (yarnCtx !== null) {
      if (layer === 'over-fix') {
        // Dynamic notes move every frame: segments they cover are drawn dynamic instead.
        const list = this.drawList(strands, i, (id) => !i.dynamicNotes.has(id))
        this.runList(yarnCtx, list, strands, i, map)
      } else for (const s of strands) this.paint(yarnCtx, s, map)
    }
    const pinCtx = prepare(to.pinCtx, to.pins)
    if (pinCtx !== null) {
      if (layer === 'under') for (const s of strands) this.drawStubs(pinCtx, s, map)
      // Loose ends on the pin layer, under the heads: above the paper in every layer mode.
      for (const s of loose) drawStrand(pinCtx, s.pts.map(map), s.style)
      for (const s of strands) out.pins += this.drawEnds(pinCtx, s, i, map, shared)
      for (const s of loose) out.pins += this.drawEnds(pinCtx, s, i, map, shared)
      for (const id of i.visibleNotes) {
        if (i.dynamicNotes.has(id) || !this.noteIn(i, focusLayer, id)) continue
        if (this.drawPin(pinCtx, id, i, map)) out.pins++
      }
    }
    return out
  }

  /**
   * Patch the lite static cache for what changed since it was drawn: the segments and pins told
   * by `invalidateStatic`, the segments at the notes told, and those now drawn live or no longer.
   * Where each was and is drawn is cleared (under a clip of whole device px), then everything
   * the cache holds that meets those areas is drawn again, in the order a whole redraw draws it,
   * so the pixels are the ones a whole redraw would give. What meets an area is asked of the
   * spatial index (`near`): a patch looks at the change and what lies around it, never the view
   * (besides the places of the view's segments and notes, made once per cull). False when it
   * cannot (the cache redraws whole instead).
   */
  private patchStatic(i: YarnFrameInput, isDynamic: (ref: SegmentRef) => boolean): boolean {
    const cache = this.cache
    const drawn = cache?.drawn
    if (cache === null || drawn == null) {
      return this.changedSegs.size === 0 && this.changedNotes.size === 0
    }
    const segs = this.changedSegs
    const notes = this.changedNotes
    for (const k of cache.dynamicKeys) if (!i.dynamicKeys.has(k)) segs.add(k)
    for (const k of i.dynamicKeys) if (!cache.dynamicKeys.has(k)) segs.add(k)
    for (const id of cache.dynamicNotes) if (!i.dynamicNotes.has(id)) notes.add(id)
    for (const id of i.dynamicNotes) if (!cache.dynamicNotes.has(id)) notes.add(id)
    cache.dynamicKeys = new Set(i.dynamicKeys)
    cache.dynamicNotes = new Set(i.dynamicNotes)
    if (segs.size === 0 && notes.size === 0) return true
    if (segs.size + notes.size > PATCH_MAX) return false
    const segAt = this.segPlaces(i)
    const noteAt = this.notePlaces(i)
    let examined = 0
    // The segments at the notes told, through the board's threads.
    const topo = i.topology ?? topologyOf(i.state)
    for (const id of notes) {
      for (const e of topo.byNote.get(id) ?? []) {
        segs.add(e.ref.key)
        examined++
      }
    }
    // Drawn at the cache's camera: a pan since then is the blit's shift.
    const map = screenMapper(cache.camera, this.dpr, cache.anchor)
    const at = { ...i, camera: cache.camera }
    const dirty: Box[] = []
    const strands = new Map<string, Strand | null>()
    const strandOf = (ref: SegmentRef) => {
      let st = strands.get(ref.key)
      if (st === undefined) {
        st = this.strand(ref, at)
        strands.set(ref.key, st)
      }
      return st
    }
    for (const key of segs) {
      examined++
      const old = drawn.segs.get(key)
      if (old !== undefined) {
        dirty.push(old)
        drawn.segs.delete(key)
      }
      const k = segAt.get(key)
      const ref = k === undefined ? undefined : i.segments[k]
      if (ref === undefined || isDynamic(ref)) continue
      const st = strandOf(ref)
      if (st === null) continue
      const b = this.strandBox(st, map)
      drawn.segs.set(key, b)
      dirty.push(b)
    }
    for (const id of notes) {
      examined++
      const old = drawn.pins.get(id)
      if (old !== undefined) {
        dirty.push(old)
        drawn.pins.delete(id)
      }
      if (i.dynamicNotes.has(id) || !noteAt.has(id)) continue
      const b = this.pinBox(id, at, map)
      if (b !== undefined) {
        drawn.pins.set(id, b)
        dirty.push(b)
      }
    }
    segs.clear()
    notes.clear()
    cache.segments = drawn.segs.size
    cache.pins = drawn.pins.size
    const yarnCtx = this.staticYarnCtx
    const pinCtx = this.staticPinCtx
    if (dirty.length === 0 || yarnCtx === null || pinCtx === null) return true
    const w = this.staticYarn.width
    const h = this.staticYarn.height
    const clips: Box[] = []
    for (const b of dirty) {
      const c: Box = [
        Math.max(0, Math.floor(b[0])),
        Math.max(0, Math.floor(b[1])),
        Math.min(w, Math.ceil(b[2])),
        Math.min(h, Math.ceil(b[3])),
      ]
      if (c[2] <= c[0] || c[3] <= c[1]) continue
      clips.push(c)
    }
    if (clips.length === 0) return true
    // Overlapping areas become their bounding box: each area is then patched under a clip of its
    // own, a plain rectangle. A clip of many rectangles at once changes how the canvas rasters
    // what is drawn under it (its antialiasing differed from a whole redraw's by up to 20 of 255).
    const areas = disjoint(clips)
    let area = 0
    for (const c of areas) area += (c[2] - c[0]) * (c[3] - c[1])
    if (area > PATCH_AREA * w * h) return false
    // What the cache holds that meets each area: the index's segments and notes near it (wide by
    // the most a stroke or pin paints past its geometry), kept if their drawn box meets it.
    const zoom = cache.camera.zoom
    // How far past its indexed geometry a thing paints, world px: a stroke (its widest, selected
    // and swelling) past its segment's rest bounds; a pin, its head and hook, past its note.
    const strandReach = (3 * strandWidthPx(zoom) * SELECTED_SCALE * (1 + PULSE_SWELL) + 3) / zoom
    const pinReach = (8 * pinRadiusPx(zoom, true) + 5) / zoom
    const origin = map({ x: 0, y: 0 })
    const world = (c: Box, reach: number): Rect => {
      const x0 = ((c[0] - this.margin.x) / this.dpr - origin.x) / zoom - reach
      const y0 = ((c[1] - this.margin.y) / this.dpr - origin.y) / zoom - reach
      const x1 = ((c[2] - this.margin.x) / this.dpr - origin.x) / zoom + reach
      const y1 = ((c[3] - this.margin.y) / this.dpr - origin.y) / zoom + reach
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
    const segsMeeting = (c: Box): SegmentRef[] => {
      const out: number[] = []
      const candidates = i.near === undefined ? i.segments : i.near.segments(world(c, strandReach))
      for (const ref of candidates) {
        examined++
        const k = segAt.get(ref.key)
        const b = drawn.segs.get(ref.key)
        if (k === undefined || b === undefined || !meets(b, c)) continue
        out.push(k)
      }
      // In paint order, as a whole redraw draws them.
      return out.sort((a, b) => a - b).map((k) => i.segments[k] as SegmentRef)
    }
    const pinsMeeting = (c: Box): string[] => {
      const out: number[] = []
      const candidates = i.near === undefined ? i.visibleNotes : i.near.notes(world(c, pinReach))
      for (const id of candidates) {
        examined++
        const k = noteAt.get(id)
        const b = drawn.pins.get(id)
        if (k === undefined || b === undefined || !meets(b, c) || i.dynamicNotes.has(id)) continue
        out.push(k)
      }
      return out.sort((a, b) => a - b).map((k) => i.visibleNotes[k] as string)
    }
    const layer = i.layer ?? 'over'
    for (const c of areas) {
      const meeting: Strand[] = []
      for (const ref of segsMeeting(c)) {
        if (isDynamic(ref)) continue
        const st = strandOf(ref)
        if (st !== null) meeting.push(st)
      }
      const begin = (ctx: CanvasRenderingContext2D) => {
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.beginPath()
        ctx.rect(c[0], c[1], c[2] - c[0], c[3] - c[1])
        ctx.clip()
        ctx.clearRect(c[0], c[1], c[2] - c[0], c[3] - c[1])
        ctx.setTransform(this.dpr, 0, 0, this.dpr, this.margin.x, this.margin.y)
      }
      begin(yarnCtx)
      for (const st of meeting) this.paint(yarnCtx, st, map)
      yarnCtx.restore()
      begin(pinCtx)
      if (layer === 'under') for (const st of meeting) this.drawStubs(pinCtx, st, map)
      const pinsHere = pinsMeeting(c)
      for (const id of pinsHere) this.drawPin(pinCtx, id, at, map)
      pinCtx.restore()
      this.onPatchArea?.(
        c,
        meeting.map((st) => st.ref.key),
        pinsHere,
      )
    }
    this.lastPatch = { areas: areas.length, examined }
    return true
  }

  /** Each segment of `i.segments` by its place (paint order); made again only for a new cull. */
  private segPlaces(i: YarnFrameInput): Map<string, number> {
    if (this.segPlace?.of !== i.segments) {
      const at = new Map<string, number>()
      i.segments.forEach((ref, k) => {
        at.set(ref.key, k)
      })
      this.segPlace = { of: i.segments, at }
    }
    return this.segPlace.at
  }

  /** Each note of `i.visibleNotes` by its place (paint order); made again only for a new cull. */
  private notePlaces(i: YarnFrameInput): Map<string, number> {
    if (this.notePlace?.of !== i.visibleNotes) {
      const at = new Map<string, number>()
      i.visibleNotes.forEach((id, k) => {
        at.set(id, k)
      })
      this.notePlace = { of: i.visibleNotes, at }
    }
    return this.notePlace.at
  }

  /** Where a strand paints, in the static canvases' device px, with room for its width. */
  private strandBox(st: Strand, map: (p: Point) => Point): Box {
    const style = st.style
    const w =
      strandWidthPx(style.zoom) *
      (style.selected ? SELECTED_SCALE : 1) *
      (style.widthScale !== undefined && style.widthScale > 0 ? style.widthScale : 1)
    return this.box(st.pts, map, 3 * w + 2)
  }

  /** Where a note's hanging pin paints (its head, shadow and a tag's hook), device px. */
  private pinBox(id: string, i: YarnFrameInput, map: (p: Point) => Point): Box | undefined {
    const p = i.pinOf(id)
    if (p === undefined) return undefined
    return this.box([p], map, 8 * pinRadiusPx(i.camera.zoom, i.lod === 'lite') + 4)
  }

  /** The device-px box of world points `pts`, grown by `pad` CSS px. */
  private box(pts: readonly Point[], map: (p: Point) => Point, pad: number): Box {
    let x0 = Number.POSITIVE_INFINITY
    let y0 = Number.POSITIVE_INFINITY
    let x1 = Number.NEGATIVE_INFINITY
    let y1 = Number.NEGATIVE_INFINITY
    for (const p of pts) {
      const q = map(p)
      if (q.x < x0) x0 = q.x
      if (q.y < y0) y0 = q.y
      if (q.x > x1) x1 = q.x
      if (q.y > y1) y1 = q.y
    }
    const d = this.dpr
    return [
      (x0 - pad) * d + this.margin.x,
      (y0 - pad) * d + this.margin.y,
      (x1 + pad) * d + this.margin.x,
      (y1 + pad) * d + this.margin.y,
    ]
  }

  /** Whether note `id`'s pin (or card) is on focus layer `layer`; with focus off, the shown one. */
  private noteIn(i: YarnFrameInput, layer: FocusLayer, id: string): boolean {
    return i.focus ? inLayer(i.focus, layer, id) : layer === 'shown'
  }

  /** How focus layer `layer` draws a segment; with focus off, the shown one draws it whole. */
  private partIn(i: YarnFrameInput, layer: FocusLayer, ref: SegmentRef): Part | null {
    if (!i.focus) return layer === 'shown' ? 'whole' : null
    return partOf(i.focus, layer, ref.aNoteId, ref.bNoteId)
  }

  /** The static layer's world rect: the viewport plus its margin, at camera `c`. */
  private staticArea(c: Camera): Rect {
    const mx = this.margin.x / this.dpr / c.zoom
    const my = this.margin.y / this.dpr / c.zoom
    return {
      x: c.x - mx,
      y: c.y - my,
      w: this.viewport.width / c.zoom + 2 * mx,
      h: this.viewport.height / c.zoom + 2 * my,
    }
  }

  /** A note's paper as drawn: `paperOf`, or else its stored rect, unturned. */
  private shapeOf(id: string, i: YarnFrameInput): (PaperShape & { z: number }) | undefined {
    const p = i.paperOf?.(id)
    if (p !== undefined) return p
    const n = i.state.notes.get(id)
    return n && { rect: noteBounds(n), pivot: pinPosition(n), deg: 0, z: n.z }
  }

  /**
   * The frames of several selected notes: the culled ones that are selected, so the cost follows
   * the view and not the size of the selection.
   */
  private drawFrames(ctx: CanvasRenderingContext2D, i: YarnFrameInput, map: (p: Point) => Point) {
    const framed = i.framedNotes
    if (framed === undefined || framed.size < 2) return
    for (const id of i.visibleNotes) {
      if (!framed.has(id)) continue
      const shape = this.shapeOf(id, i)
      if (shape !== undefined) {
        drawSelectionFrame(ctx, shape, i.camera.zoom, map, id === i.focusedNote)
      }
    }
  }

  /** The overview's world geometry cache for `i.geometryKey`, emptied when the key changes. */
  private geometryFor(i: YarnFrameInput): Geometry | null {
    const key = i.geometryKey
    if (key === undefined) return null
    if (this.geometry?.key !== key) this.geometry = { key, cards: new Map(), threads: new Map() }
    return this.geometry
  }

  /**
   * Overview cards for the visible notes `keep` accepts, in their order (paint order), and
   * their pins, screen px; within `area` (world) when given. `cached` reads and fills the
   * geometry cache (for notes that are not moving).
   */
  private overviewCards(
    i: YarnFrameInput,
    map: (p: Point) => Point,
    keep: (id: string) => boolean,
    area?: Rect,
    cached = false,
  ): { paints: CardPaint[][]; pins: Point[] } {
    const geometry = cached ? this.geometryFor(i) : null
    const paints: CardPaint[][] = []
    const pins: Point[] = []
    for (const id of i.visibleNotes) {
      if (!keep(id)) continue
      const n = i.state.notes.get(id)
      if (n === undefined) continue
      let g = geometry?.cards.get(id)
      if (g === undefined) {
        const shape = this.shapeOf(id, i)
        if (shape === undefined) continue
        g = { card: cardShape(n, shape), pin: i.pinOf(id) }
        geometry?.cards.set(id, g)
      }
      if (area !== undefined && !rectsTouch(g.card.box, area)) continue
      const tone = n.image ? i.toneOf?.(n.image.assetId) : undefined
      paints.push(cardPaints(n, g.card, map, tone))
      if (g.pin !== undefined) pins.push(map(g.pin))
    }
    return { paints, pins }
  }

  /**
   * Overview threads for the segments `keep` accepts, at their current sag; within `area`.
   * `cached` reads and fills the geometry cache: static segments are at rest, so their curve
   * follows from their ends alone.
   */
  private overviewThreads(
    i: YarnFrameInput,
    map: (p: Point) => Point,
    keep: (ref: SegmentRef) => boolean,
    area?: Rect,
    cached = false,
  ): ThreadPaint[] {
    const geometry = cached ? this.geometryFor(i) : null
    const out: ThreadPaint[] = []
    const width = overviewYarnWidth(i.camera.zoom)
    const fade = overviewYarnAlpha(i.camera.zoom)
    for (const ref of i.segments) {
      if (!keep(ref)) continue
      const yarn = i.state.yarns.get(ref.yarnId)
      if (yarn === undefined) continue
      let g = geometry?.threads.get(ref.key)
      if (g === undefined) {
        const e = i.endsOf(ref)
        if (e === undefined) continue
        const curve = segmentBezier(e.a, e.b, i.sagOf(ref, e.a, e.b))
        g = { curve, box: hullBox(curve) }
        geometry?.threads.set(ref.key, g)
      }
      if (area !== undefined && !rectsTouch(g.box, area)) continue
      const alpha =
        fade * (i.alphaOf?.(ref.yarnId) ?? 1) * Math.min(1, i.progressOf?.(ref.yarnId) ?? 1)
      out.push({
        curve: mapCubic(g.curve, map),
        color: yarnColor(yarn.color),
        alpha: Number.isFinite(alpha) ? alpha : 1,
        width: ref.yarnId === i.selectedYarnId ? width * OVERVIEW.selectedYarnScale : width,
      })
    }
    return out
  }

  /**
   * Overview over the blitted cache: moving notes' cards (top of the z order) with their pins,
   * dynamic threads, loosening ghosts and the live thread, then the selection and hover outlines.
   */
  private paintOverviewDynamic(
    i: YarnFrameInput,
    map: (p: Point) => Point,
    isDynamic: (ref: SegmentRef) => boolean,
    stats: RenderStats,
  ): void {
    const zoom = i.camera.zoom
    const anyNotes = i.dynamicNotes.size > 0
    const moving = anyNotes
      ? i.visibleNotes.filter((id) => i.dynamicNotes.has(id) && this.noteIn(i, 'shown', id))
      : NO_IDS
    // Each card's z read once, not in the comparator (`shapeOf` builds the paper's shape); one
    // card or none needs no sort, and most frames move none.
    if (moving.length > 1) {
      const zOf = new Map(moving.map((id) => [id, this.shapeOf(id, i)?.z ?? 0]))
      moving.sort((a, b) => (zOf.get(a) ?? 0) - (zOf.get(b) ?? 0))
    }
    const cards = this.overviewCards({ ...i, visibleNotes: moving }, map, () => true)
    // Most frames move nothing: skip the scan of every culled segment then.
    const threads =
      anyNotes || i.dynamicKeys.size > 0
        ? this.overviewThreads(
            i,
            map,
            (ref) => isDynamic(ref) && this.partIn(i, 'shown', ref) === 'whole',
          )
        : []
    stats.segmentsDynamic = threads.length
    const width = overviewYarnWidth(zoom)
    for (const g of i.ghosts ?? []) {
      for (const { a, b } of g.segments) {
        const rest = restSagPoint(a, b)
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const sag = { x: mx + (rest.x - mx) * g.sagScale, y: my + (rest.y - my) * g.sagScale }
        const curve = mapCubic(segmentBezier(a, b, sag), map)
        const alpha = overviewYarnAlpha(zoom) * g.alpha
        threads.push({ curve, color: yarnColor(g.yarn.color), alpha, width })
        stats.segmentsDynamic++
      }
    }
    if (i.live) {
      const { from, to, sag, color } = i.live
      const curve = mapCubic(segmentBezier(from, to, sag), map)
      threads.push({ curve, color: yarnColor(color), alpha: 1, width })
      stats.segmentsDynamic++
    }
    if (this.yarnCtx !== null) {
      drawCards(this.yarnCtx, cards.paints)
      drawThreads(this.yarnCtx, threads)
    }
    stats.cards = (stats.cards ?? 0) + cards.paints.length
    stats.pins += cards.pins.length
    const ctx = this.pinCtx
    if (ctx === null) return
    drawPinDots(ctx, cards.pins, overviewPinRadius(zoom))
    // A large selection (select all) is outlined where it is seen: walk the culled notes then.
    const picked = i.selectedNotes
    const outlined =
      picked === undefined
        ? []
        : i.pyramid !== undefined
          ? picked.size <= OUTLINE_WALK
            ? picked
            : (i.selectedInView?.() ?? [])
          : picked.size <= i.visibleNotes.length
            ? picked
            : i.visibleNotes.filter((id) => picked.has(id))
    for (const id of outlined) {
      const shape = this.shapeOf(id, i)
      if (shape !== undefined) drawOutline(ctx, shape, zoom, map, 'selected')
    }
    const hover = i.hoverNoteId
    if (hover !== undefined && !i.selectedNotes?.has(hover)) {
      const shape = this.shapeOf(hover, i)
      if (shape !== undefined) drawOutline(ctx, shape, zoom, map, 'hover')
    }
  }

  /**
   * A segment's drawn world polyline and style; null when its yarn or notes are gone. `part`
   * other than whole makes it that end's loose end: its first `LOOSE_END_WORLD`, at half alpha.
   */
  private strand(ref: SegmentRef, i: YarnFrameInput, part: Part = 'whole'): Strand | null {
    const yarn = i.state.yarns.get(ref.yarnId)
    const ends = i.endsOf(ref)
    if (yarn === undefined || ends === undefined) return null
    const { a, b } = ends
    const zoom = i.camera.zoom
    const tolerance = 0.5 / zoom
    let pts = flattenBezier(segmentBezier(a, b, i.sagOf(ref, a, b)), tolerance)
    const progress = i.progressOf?.(ref.yarnId)
    const whole = !(progress !== undefined && progress < 1)
    if (!whole) {
      const f = drawnShare(yarn, ref.index, polylineLength(pts), progress ?? 1, i, tolerance)
      if (!(f > 0)) return null
      pts = truncatePolyline(pts, f)
    }
    const pulse = i.pulseOf?.(ref.yarnId) ?? 0
    const style = {
      color: yarnColor(yarn.color),
      zoom,
      alpha: i.alphaOf?.(ref.yarnId),
      lite: i.lod === 'lite',
      selected: ref.yarnId === i.selectedYarnId,
      widthScale: pulse > 0 ? 1 + PULSE_SWELL * pulse : undefined,
    }
    if (part !== 'whole') {
      const alpha = (style.alpha ?? 1) * LOOSE_END_ALPHA
      return {
        ref,
        pts: looseStub(pts, part),
        whole,
        ends,
        style: { ...style, alpha },
        loose: part,
      }
    }
    const runs = this.overOwnPaper(ref, pts, whole, i)
    return runs === undefined
      ? { ref, pts, whole, ends, style }
      : { ref, pts, whole, ends, style, runs }
  }

  /**
   * Above the paper (`over`, `over-fix`), a strand tied at a note's hanging pin runs beneath that
   * note's own paper past the pin's stub: the runs that show, or undefined when all of it does.
   * The far end counts only once a draw-in reaches it.
   */
  private overOwnPaper(
    ref: SegmentRef,
    pts: Point[],
    whole: boolean,
    i: YarnFrameInput,
  ): Point[][] | undefined {
    if ((i.layer ?? 'over') === 'under' || i.sharedPinOf === undefined) return undefined
    const start = i.sharedPinOf(ref, 'a') === null ? this.shapeOf(ref.aNoteId, i) : undefined
    const end = whole && i.sharedPinOf(ref, 'b') === null ? this.shapeOf(ref.bNoteId, i) : undefined
    if (start === undefined && end === undefined) return undefined
    const runs = strandOverPaper(pts, { start, end })
    return runs.length === 1 && runs[0] === pts ? undefined : runs
  }

  /** The strand: what of it shows. */
  private paint(ctx: CanvasRenderingContext2D, s: Strand, map: (p: Point) => Point): void {
    if (s.runs === undefined) drawStrand(ctx, s.pts.map(map), s.style)
    else for (const run of s.runs) drawStrand(ctx, run.map(map), s.style)
  }

  /**
   * A strand's edge pins; the far one only once a draw-in reaches it. Lite mode draws none: at
   * that size they are specks, and two per thread on a zoomed-out board cost. An end at its
   * note's hanging pin draws none either, and a pin several ends share is drawn only by the
   * first of them (`shared` holds those already drawn). Returns pins drawn.
   */
  private drawEnds(
    ctx: CanvasRenderingContext2D,
    s: Strand,
    i: YarnFrameInput,
    map: (p: Point) => Point,
    shared: Set<string>,
  ): number {
    if (i.lod === 'lite') return 0
    const draw = (end: End) => this.drawEdgePin(ctx, s, end, i, map, shared)
    if (s.loose !== undefined) return draw(s.loose)
    return draw('a') + (s.whole ? draw('b') : 0)
  }

  /** One end's edge pin, unless it is a hanging pin or a shared one already drawn: 1 or 0. */
  private drawEdgePin(
    ctx: CanvasRenderingContext2D,
    s: Strand,
    end: End,
    i: YarnFrameInput,
    map: (p: Point) => Point,
    shared: Set<string>,
  ): number {
    const pin = i.sharedPinOf?.(s.ref, end)
    if (pin === null) return 0
    if (pin !== undefined) {
      if (shared.has(pin)) return 0
      shared.add(pin)
    }
    this.sprites.draw(ctx, map(end === 'a' ? s.ends.a : s.ends.b), i.camera.zoom, {
      lite: i.lod === 'lite',
      kind: edgeKind(end === 'a' ? s.ref.aNoteId : s.ref.bNoteId, i),
    })
    return 1
  }

  /** A loosening ghost's edge pins, fading with it. */
  private drawGhostPins(
    ctx: CanvasRenderingContext2D,
    g: GhostYarn,
    i: YarnFrameInput,
    map: (p: Point) => Point,
  ): void {
    if (i.lod === 'lite') return
    ctx.save()
    ctx.globalAlpha = Number.isFinite(g.alpha) ? Math.max(0, Math.min(1, g.alpha)) : 0
    // The ghost's segments ran between its notes still on the board, in thread order.
    const notes = g.yarn.noteIds.filter((id) => i.state.notes.has(id))
    g.segments.forEach(({ a, b }, k) => {
      const draw = (p: Point, id: string | undefined) => {
        // An end tied at the hanging pin had no edge pin of its own, and a pin another thread
        // still holds stays.
        const key = id === undefined ? undefined : g.yarn.pins?.[id]
        if (key === HANGING) return
        if (
          key !== undefined &&
          (i.topology ?? topologyOf(i.state)).byNote.get(id as string)?.some((e) => e.pin === key)
        )
          return
        this.sprites.draw(ctx, map(p), i.camera.zoom, {
          kind: id === undefined ? 'edge' : edgeKind(id, i),
        })
      }
      draw(a, notes[k])
      draw(b, notes[k + 1])
    })
    ctx.restore()
  }

  /**
   * The thread's ends on the pin layer (`under`); a thread still drawing in shows only its start.
   */
  private drawStubs(ctx: CanvasRenderingContext2D, s: Strand, map: (p: Point) => Point): void {
    const { start, end } = s.whole
      ? pinStubs(s.pts)
      : { start: sliceByLength(s.pts, 0, PIN_STUB_WORLD), end: [] }
    drawStrand(ctx, start.map(map), s.style)
    drawStrand(ctx, end.map(map), s.style)
  }

  /** `buildDrawList` over `strands` (keyed by position), keeping only occluders `keep` accepts. */
  private drawList(
    strands: readonly Strand[],
    i: YarnFrameInput,
    keep: (noteId: string) => boolean = () => true,
  ): DrawItem[] {
    const zOf = (id: string) => i.paperOf?.(id)?.z ?? 0
    return buildDrawList(
      strands.map((s, k) => ({
        key: String(k),
        level: Math.max(zOf(s.ref.aNoteId), zOf(s.ref.bNoteId)),
        occluders: (i.occludersOf?.(s.ref, s.pts) ?? []).filter(keep),
      })),
      zOf,
    )
  }

  private runList(
    ctx: CanvasRenderingContext2D,
    list: readonly DrawItem[],
    strands: readonly Strand[],
    i: YarnFrameInput,
    map: (p: Point) => Point,
  ): void {
    for (const item of list) {
      if (item.kind === 'erase') this.erase(ctx, item.noteId, i, map)
      else {
        const s = strands[Number(item.key)]
        if (s !== undefined) this.paint(ctx, s, map)
      }
    }
  }

  /** Clear the yarn under a note's paper: its rect inset 1 world px, turned about its pin. */
  private erase(
    ctx: CanvasRenderingContext2D,
    noteId: string,
    i: YarnFrameInput,
    map: (p: Point) => Point,
  ): void {
    const p = i.paperOf?.(noteId)
    if (p === undefined) return
    const r = p.rect
    const rect = { x: r.x + 1, y: r.y + 1, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) }
    const cs = paperCorners({ rect, pivot: p.pivot, deg: p.deg }).map(map)
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.globalAlpha = 1
    ctx.fillStyle = '#000'
    ctx.beginPath()
    for (const [k, c] of cs.entries()) {
      if (k === 0) ctx.moveTo(c.x, c.y)
      else ctx.lineTo(c.x, c.y)
    }
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  /**
   * Dynamic segments over the blitted cache. In `over-fix`, when their draw list erases, it runs
   * in its own buffer (so the erase spares the cache) and that buffer is composited on top.
   */
  private paintDynamic(
    ctx: CanvasRenderingContext2D,
    strands: readonly Strand[],
    i: YarnFrameInput,
    map: (p: Point) => Point,
  ): void {
    if (strands.length === 0) return
    const list = (i.layer ?? 'over') === 'over-fix' ? this.drawList(strands, i) : null
    if (list === null || !list.some((d) => d.kind === 'erase')) {
      for (const s of strands) this.paint(ctx, s, map)
      return
    }
    if (this.dynamicYarn === null) {
      const canvas = this.createCanvas(1, 1)
      this.dynamicYarn = { canvas, ctx: context2d(canvas) }
    }
    const buf = this.dynamicYarn
    this.sizeDynamic(buf.canvas)
    if (buf.ctx === null) return
    buf.ctx.setTransform(1, 0, 0, 1, 0, 0)
    buf.ctx.clearRect(0, 0, buf.canvas.width, buf.canvas.height)
    buf.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.runList(buf.ctx, list, strands, i, map)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(buf.canvas, 0, 0)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  /** One loosening ghost: rest sag offset scaled by `sagScale`, faded by `alpha`. */
  private drawGhost(
    ctx: CanvasRenderingContext2D,
    g: GhostYarn,
    i: YarnFrameInput,
    map: (p: Point) => Point,
  ): number {
    const zoom = i.camera.zoom
    let drawn = 0
    for (const { a, b } of g.segments) {
      const rest = restSagPoint(a, b)
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const sag = { x: mx + (rest.x - mx) * g.sagScale, y: my + (rest.y - my) * g.sagScale }
      drawStrand(ctx, flattenBezier(segmentBezier(a, b, sag), 0.5 / zoom).map(map), {
        color: yarnColor(g.yarn.color),
        zoom,
        alpha: g.alpha,
        lite: i.lod === 'lite',
      })
      drawn++
    }
    return drawn
  }

  private drawPin(
    ctx: CanvasRenderingContext2D,
    noteId: string,
    i: YarnFrameInput,
    map: (p: Point) => Point,
    glow = false,
  ): boolean {
    const p = i.pinOf(noteId)
    if (p === undefined || i.pinCovered?.(noteId) === true) return false
    this.sprites.draw(ctx, map(p), i.camera.zoom, {
      lite: i.lod === 'lite',
      glow,
      hook: isHook(noteId, i),
    })
    return true
  }
}

/** A Bézier mapped to the screen: the map is affine, so mapping its control points is exact. */
function mapCubic(c: CubicBezier, map: (p: Point) => Point): CubicBezier {
  return { p0: map(c.p0), p1: map(c.p1), p2: map(c.p2), p3: map(c.p3) }
}

function isHook(noteId: string, i: YarnFrameInput): boolean {
  const note = i.state.notes.get(noteId)
  return i.hookOf?.(noteId) ?? (note !== undefined && isTag(note))
}

/** A tag's edge pins are the small kind. */
const edgeKind = (noteId: string, i: YarnFrameInput): PinKind =>
  isHook(noteId, i) ? 'tag' : 'edge'

/**
 * The share of segment `index` (of flattened length `len`) shown when the leading `progress` of
 * the whole thread's flattened length is drawn: `truncatePolyline` over the thread, per segment.
 */
function drawnShare(
  yarn: Yarn,
  index: number,
  len: number,
  progress: number,
  i: YarnFrameInput,
  tolerance: number,
): number {
  let total = 0
  let before = 0
  for (const ref of (i.topology ?? topologyOf(i.state)).byYarn.get(yarn.id) ?? []) {
    let l = len
    if (ref.index !== index) {
      const e = i.endsOf(ref)
      if (e === undefined) continue
      l = polylineLength(flattenBezier(segmentBezier(e.a, e.b, i.sagOf(ref, e.a, e.b)), tolerance))
    }
    if (ref.index < index) before += l
    total += l
  }
  if (!(len > 0)) return progress * total > before ? 1 : 0
  return Math.min(1, (progress * total - before) / len)
}
