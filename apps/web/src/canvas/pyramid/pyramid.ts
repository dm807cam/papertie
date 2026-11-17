import type { Note } from '@papertie/core'
import { type Camera, screenMapper, visibleWorldRect } from '../Camera'
import {
  type CardPaint,
  cardFill,
  cardShape,
  drawCards,
  drawPinDots,
  drawThreads,
  OVERVIEW,
  overviewPinRadius,
  overviewYarnAlpha,
  overviewYarnWidth,
  type ThreadPaint,
} from '../overview'
import type { Point, Rect, Size } from '../types'
import { restSagPoint, segmentBezier } from '../yarnGeometry'
import {
  LEVELS,
  levelFor,
  levelRefZoom,
  reachWorld,
  TILE_PX,
  type TileId,
  tileKey,
  tileRange,
  tileRect,
} from './levels'
import {
  byPaintOrder,
  type CardRec,
  hullOf,
  type PyramidPort,
  type PyramidReply,
  type PyramidRequest,
  type SegRec,
} from './worker'

/**
 * A note as the pyramid draws it: where its paper is (stored rect at the displayed height, the
 * tilt about its pin), its colour and kind. `tag` is a tag, whose pin is its hook (overview
 * draws both as the same brass dot).
 */
export interface NoteFrame {
  id: string
  x: number
  y: number
  w: number
  h: number
  z: number
  paper: Note['paper']
  style: Note['style']
  tag: boolean
  /** Tilt in degrees about `pin`. */
  deg: number
  pin: Point
  /** A print with a caption: its image area stops above the caption band. */
  caption: boolean
  /** A print's asset, whose tone its image area is drawn in. */
  asset: string | null
  /** That tone, once measured. */
  tone: string | null
}

/** A thread segment: its two edge pins at rest, and its dye as drawn. */
export interface SegFrame {
  key: string
  a: Point
  b: Point
  color: string
}

/**
 * Where the pyramid reads the board now: one note's or segment's frame (none when gone), and
 * which may touch a world rect (more is fine). It draws what changed from these over a stale tile
 * until the tile comes back from the worker.
 */
export interface PyramidSource {
  note(id: string): NoteFrame | undefined
  segment(key: string): SegFrame | undefined
  notesIn(r: Rect): Iterable<string>
  segmentsIn(r: Rect): Iterable<string>
  /** The worker drew a print without its tone: measure it (`retone` once known). */
  wantTone?(asset: string): void
}

/** Where and how a frame is drawn. */
export interface PyramidView {
  camera: Camera
  anchor: Point
  dpr: number
  viewport: Size
}

/** What one `draw` did. */
export interface PyramidFrame {
  level: number
  /** Tiles drawn from their own level. */
  tiles: number
  /** Tiles drawn from another level while theirs is on its way. */
  fallback: number
  /** Tiles with nothing to draw them from yet. */
  missing: number
  /** World rects drawn here over stale tiles. */
  patched: number
}

export interface PyramidStats {
  ready: boolean
  built: boolean
  /** Version of the last change sent to the worker. */
  version: number
  tiles: number
  bytes: number
  inFlight: number
  /** Tiles the worker has sent back, ever. */
  renders: number
  /** Of those, tiles drawn again in place of one held (after a change). */
  redraws: number
  /** Rects the replies have compared with the stale rects their tiles kept, ever. */
  compared: number
  /** Cards and segments the worker holds. */
  cards: number
  segments: number
  last: PyramidFrame | null
}

export interface Pyramid {
  /** Built, with its coarsest level in hand: it can draw any view. */
  readonly ready: boolean
  /** Raster tiles for the view and draw them, with what changed since drawn over them. */
  draw(ctx: CanvasRenderingContext2D, view: PyramidView): PyramidFrame
  /** Mark every tile that touches these world rects stale (it is drawn again). */
  invalidate(rects: readonly Rect[]): void
  /** These notes and segments changed (or went): take them from the source now. O(changed). */
  changed(notes: Iterable<string>, segments: Iterable<string>): void
  /**
   * What is drawn live over the pyramid (moving notes, springing threads, the selected thread):
   * left out of the tiles while it is.
   */
  setHidden(notes: ReadonlySet<string>, segments: ReadonlySet<string>): void
  /** A print's tone became known: its cards are drawn again. */
  retone(asset: string): void
  /** The worker failed (or could not draw): this pyramid never draws again. */
  readonly failed: boolean
  /** Not drawn for now: let go of every tile but the coarsest level's. */
  sleep(): void
  /** Test hook: hold the worker's replies (a slow worker) until let go, then take them in order. */
  holdReplies(on: boolean): void
  stats(): PyramidStats
  dispose(): void
}

/** The tile cache's cap (LRU): 96 MB of tiles, 4 bytes a device px. */
export const PYRAMID_CACHE_BYTES = 96 * 1024 * 1024
/** Stale rects drawn from the board in one frame at most; past it a tile waits whole. */
export const PATCH_RECTS = 64
/** Cards drawn from the board in one frame at most, the same way. */
export const PATCH_CARDS = 1500
/** Tiles asked of the worker at once: few, so the next ask follows the camera. */
const IN_FLIGHT = 2
/** The coarsest level is kept whole when it has at most this many tiles with anything on them. */
const BASE_MAX = 24
/**
 * A tile gathers the changes it misses as stale rects; past this many it is stale whole instead
 * (one mark, asked again first; away from the view it is dropped), so what is drawn over a tile
 * from the source never grows with the number of changes.
 */
const DIRTY_MAX = 16
/** The coarsest level's tiles are drawn again (when the worker is free) past this many. */
const BASE_REFRESH = 8
/**
 * Changes kept for the tiles on their way (asked before a change, answered after it); past this
 * many the tiles on their way are stale whole when they come.
 */
const LOG_MAX = 4096
/** A thread is staled piece by piece along its curve: pieces of about this many world px. */
const PIECE_WORLD = 512
/** At most this many pieces a thread: a longer one has longer pieces. */
const PIECES_MAX = 64
/** Tiles kept at most, empty ones included (they hold no pixels). */
const MAX_TILES = 4096
/** Prefetching stops while the cache is this full, so it never evicts what it just fetched. */
const PREFETCH_SHARE = 0.75
/** Frames converted per slice of the first build, between checks of the deadline. */
const BUILD_STEP = 256
/** A slice of the first build stops after this many ms. */
const BUILD_SLICE_MS = 4

type Box = [number, number, number, number]

interface Tile extends TileId {
  key: string
  /** Null: nothing on it. */
  bitmap: ImageBitmap | null
  /** The version it was drawn at. */
  v: number
  /** Stale parts (world rects grown by the level's reach) with the version that staled them. */
  dirty: Array<{ r: Rect; v: number }>
  /** Stale whole since this version (too many changes to draw over it); 0: not. */
  whole: number
  /** The frame it was last drawn in. */
  used: number
  base: boolean
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
const boxRect = (b: Box): Rect => ({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] })
const meets = (a: Rect, b: Rect) =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
/** Whether `a` grown by `by` meets `b` ({@link grow}, {@link meets}), making no rect. */
const meetsGrown = (a: Rect, by: number, b: Rect) =>
  a.x - by <= b.x + b.w && b.x <= a.x + a.w + by && a.y - by <= b.y + b.h && b.y <= a.y + a.h + by
const grow = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + 2 * by,
  h: r.h + 2 * by,
})

/** `[x0, y0, x1, y1, …]`, with no pair array a point (`flatMap`'s were a card's garbage). */
const flat = (pts: readonly Point[]): number[] => {
  const out = new Array<number>(pts.length * 2)
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Point
    out[2 * i] = p.x
    out[2 * i + 1] = p.y
  }
  return out
}

/** A note frame as the worker paints it: its card's world geometry and colours. */
export function cardRec(f: NoteFrame): CardRec {
  const shape = { rect: { x: f.x, y: f.y, w: f.w, h: f.h }, pivot: f.pin, deg: f.deg }
  const card = cardShape({ style: f.style, text: f.caption ? 'caption' : '' }, shape)
  const b = card.box
  return {
    id: f.id,
    z: f.z,
    corners: flat(card.corners),
    image: card.image === null ? null : flat(card.image),
    pin: [f.pin.x, f.pin.y],
    fill: cardFill(f),
    tone: f.style === 'print' ? f.tone : null,
    asset: f.style === 'print' ? f.asset : null,
    box: [b.x, b.y, b.x + b.w, b.y + b.h],
  }
}

/** A segment as the worker strokes it: at its rest sag, as the card overview's static layer. */
export function segRec(s: SegFrame): SegRec {
  const c = segmentBezier(s.a, s.b, restSagPoint(s.a, s.b))
  return { key: s.key, p: flat([c.p0, c.p1, c.p2, c.p3]), color: s.color }
}

/**
 * World rects that cover a segment's curve piece by piece (each piece's sampled points, grown by
 * its sag's share), so a long thread stales the tiles it crosses, not the hull's area.
 */
export function curvePieces(p: readonly number[]): Rect[] {
  const at = (t: number): Point => {
    const u = 1 - t
    const a = u * u * u
    const b = 3 * u * u * t
    const c = 3 * u * t * t
    const d = t * t * t
    return {
      x: a * (p[0] as number) + b * (p[2] as number) + c * (p[4] as number) + d * (p[6] as number),
      y: a * (p[1] as number) + b * (p[3] as number) + c * (p[5] as number) + d * (p[7] as number),
    }
  }
  const [x0, y0, x1, y1] = hullOf(p)
  const span = Math.hypot(x1 - x0, y1 - y0)
  const n = Math.max(1, Math.min(PIECES_MAX, Math.ceil(span / PIECE_WORLD)))
  const out: Rect[] = []
  let prev = at(0)
  for (let i = 1; i <= n; i++) {
    const mid = at((i - 0.5) / n)
    const next = at(i / n)
    const xs = [prev.x, mid.x, next.x]
    const ys = [prev.y, mid.y, next.y]
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    // A piece bows out from its three points by well under an eighth of its length.
    const pad = Math.hypot(next.x - prev.x, next.y - prev.y) / 8
    out.push({
      x: x - pad,
      y: y - pad,
      w: Math.max(...xs) - x + 2 * pad,
      h: Math.max(...ys) - y + 2 * pad,
    })
    prev = next
  }
  return out
}

/** Whether this page can run the pyramid: a module worker with `OffscreenCanvas`. */
export function pyramidSupported(): boolean {
  return (
    typeof Worker === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof createImageBitmap === 'function'
  )
}

type Port = PyramidPort<PyramidReply, PyramidRequest> & {
  onerror?: ((e: ErrorEvent) => void) | null
  onmessageerror?: ((e: MessageEvent) => void) | null
  terminate?(): void
}

function spawn(): Port {
  return new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'pyramid',
  }) as unknown as Port
}

type Idle = { timeRemaining(): number }
const idleApi = globalThis as {
  requestIdleCallback?: (fn: (d: Idle) => void, o?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}

export interface PyramidOptions {
  source: PyramidSource
  /** A tile came back, or the pyramid became ready: draw again. */
  onChange(): void
  dpr: number
  port?: Port
  cacheBytes?: number
  /** Run a slice of the first build later (default: when the page is idle). */
  schedule?(slice: (d: Idle) => void): () => void
}

const scheduleIdle = (slice: (d: Idle) => void): (() => void) => {
  if (idleApi.requestIdleCallback && idleApi.cancelIdleCallback) {
    const id = idleApi.requestIdleCallback(slice, { timeout: 250 })
    return () => idleApi.cancelIdleCallback?.(id)
  }
  const t = setTimeout(() => {
    const end = performance.now() + BUILD_SLICE_MS
    slice({ timeRemaining: () => end - performance.now() })
  }, 0)
  return () => clearTimeout(t)
}

/**
 * The far-zoom picture pyramid: the board as raster tiles, levels 2× apart from
 * where overview begins down to the zoom floor (`levels.ts`), rendered in a worker with
 * `OffscreenCanvas` from the notes' frames (`frames`) and the threads as straight segments in
 * their dye (`yarns`). Both are taken in idle slices; then the coarsest level is rastered whole
 * (when small), so every view has something to draw from while its own tiles come.
 * A frame blits the view's tiles, each scaled to whole device px, drawing a missing one from the
 * coarser level above it or the finer one below; the LRU cache is capped at 96 MB.
 * A change (`changed`) re-sends only what changed, and stales exactly the tiles its notes and
 * threads touched, old rect and new: until each comes back, the changed rects are cleared and
 * drawn here from the source, over the stale tile, so a move, a recolour or a delete shows in the
 * next frame with no ghost.
 */
export function createPyramid(
  frames: Iterable<NoteFrame>,
  yarns: Iterable<SegFrame>,
  o: PyramidOptions,
): Pyramid {
  const port = o.port ?? spawn()
  const cap = o.cacheBytes ?? PYRAMID_CACHE_BYTES
  const schedule = o.schedule ?? scheduleIdle
  let dpr = o.dpr
  let v = 0
  let frame = 0
  let renders = 0
  let compared = 0
  let redraws = 0
  let failed = false
  let disposed = false
  let built = false
  /** 'none': the coarsest level is not kept whole (too many tiles); it is drawn as any other. */
  let base: 'waiting' | 'asked' | 'done' | 'none' = 'waiting'
  let last: PyramidFrame | null = null
  /** Each card and segment the worker holds, by its bounds there. */
  const sent = new Map<string, Box>()
  /** Each segment the worker holds, by its curve there. */
  const segSent = new Map<string, number[]>()
  /** Prints by asset: a tone found is drawn on all of them. */
  const byAsset = new Map<string, Set<string>>()
  const assetOf = new Map<string, string>()
  let hiddenNotes: ReadonlySet<string> = new Set()
  let hiddenSegs: ReadonlySet<string> = new Set()
  const tiles = new Map<string, Tile>()
  /** How many of `tiles` each level holds: a change walks only the levels that hold any. */
  const perLevel = new Array<number>(LEVELS).fill(0)
  let bytes = 0
  /** Tiles asked and not back: the request's id, the version then, stale whole if set. */
  const inFlight = new Map<string, { id: number; at: number; whole: number }>()
  /** The coarsest level's raster on its way: the version it was asked at, stale whole if set. */
  let baseOut: { at: number; whole: number } | null = null
  /**
   * The coarsest level's raster asked last: its tiles come back as id `-(gen + 1)`. A raster from
   * before tiles were let go (a DPR change and back) is ignored, tiles and all.
   */
  let baseGen = 0
  /**
   * Changes since the oldest request on its way (raw world rects, by version): a tile asked
   * before a change and answered after it is stale where they touch it.
   */
  let log: Array<{ r: Rect; v: number }> = []
  /** The coarsest level's tiles, kept whole. */
  const baseKeys = new Set<string>()
  let nextId = 0
  const out: Extract<PyramidRequest, { t: 'put' }> = {
    t: 'put',
    v: 0,
    cards: [],
    drop: [],
    segs: [],
    dropSegs: [],
  }
  let stale: Rect[] = []

  const post = (m: PyramidRequest) => {
    if (failed || disposed) return
    try {
      port.postMessage(m)
    } catch {
      fail()
    }
  }

  const fail = () => {
    if (failed) return
    failed = true
    port.terminate?.()
    clearTiles()
    log = []
    o.onChange()
  }
  port.onerror = () => fail()
  port.onmessageerror = () => fail()

  const flush = () => {
    if (out.cards.length + out.drop.length + out.segs.length + out.dropSegs.length > 0) {
      out.v = ++v
      post({ ...out })
      out.cards = []
      out.drop = []
      out.segs = []
      out.dropSegs = []
    }
    if (stale.length > 0) {
      invalidate(stale)
      stale = []
    }
  }

  const untrackAsset = (id: string) => {
    const a = assetOf.get(id)
    if (a === undefined) return
    assetOf.delete(id)
    const set = byAsset.get(a)
    set?.delete(id)
    if (set?.size === 0) byAsset.delete(a)
  }

  /** Put note `id` as the source has it now (or drop it), staling its old and new rects. */
  const takeNote = (id: string, f?: NoteFrame) => {
    const frame = hiddenNotes.has(id) ? undefined : (f ?? o.source.note(id))
    const old = sent.get(id)
    if (old !== undefined) stale.push(boxRect(old))
    if (frame === undefined) {
      if (old === undefined) return
      sent.delete(id)
      untrackAsset(id)
      out.drop.push(id)
      return
    }
    const rec = cardRec(frame)
    sent.set(id, rec.box)
    stale.push(boxRect(rec.box))
    untrackAsset(id)
    if (rec.asset !== null) {
      assetOf.set(id, rec.asset)
      const set = byAsset.get(rec.asset)
      if (set === undefined) byAsset.set(rec.asset, new Set([id]))
      else set.add(id)
    }
    out.cards.push(rec)
  }

  const takeSeg = (key: string, f?: SegFrame) => {
    const seg = hiddenSegs.has(key) ? undefined : (f ?? o.source.segment(key))
    const old = segSent.get(key)
    if (old !== undefined) stale.push(...curvePieces(old))
    if (seg === undefined) {
      if (old === undefined) return
      segSent.delete(key)
      out.dropSegs.push(key)
      return
    }
    const rec = segRec(seg)
    segSent.set(key, rec.p)
    stale.push(...curvePieces(rec.p))
    out.segs.push(rec)
  }

  // The first build: every frame, a slice at a time, without staling (no tile is drawn yet).
  const noteIt = frames[Symbol.iterator]()
  const yarnIt = yarns[Symbol.iterator]()
  let unschedule: (() => void) | null = null
  const buildSlice = (d: Idle) => {
    unschedule = null
    if (disposed || failed) return
    const end = performance.now() + Math.min(BUILD_SLICE_MS, Math.max(1, d.timeRemaining()))
    let done = false
    while (performance.now() < end) {
      let steps = 0
      for (; steps < BUILD_STEP; steps++) {
        const n = noteIt.next()
        if (n.done) break
        takeNote(n.value.id, n.value)
      }
      for (; steps < BUILD_STEP; steps++) {
        const s = yarnIt.next()
        if (s.done) break
        takeSeg(s.value.key, s.value)
      }
      if (steps < BUILD_STEP) {
        done = true
        break
      }
    }
    // Nothing is on screen from the pyramid yet: what the build took stales nothing.
    stale = []
    flush()
    if (!done) {
      unschedule = schedule(buildSlice)
      return
    }
    built = true
    askBase()
  }

  const askBase = () => {
    base = 'asked'
    baseOut = { at: v, whole: 0 }
    baseGen++
    post({ t: 'base', k: LEVELS - 1, dpr, max: BASE_MAX, gen: baseGen })
  }

  const dropTile = (t: Tile) => {
    if (tiles.delete(t.key)) perLevel[t.k] = (perLevel[t.k] ?? 1) - 1
    baseKeys.delete(t.key)
    if (t.bitmap !== null) {
      bytes -= t.bitmap.width * t.bitmap.height * 4
      t.bitmap.close()
    }
  }

  const clearTiles = () => {
    for (const t of tiles.values()) t.bitmap?.close()
    tiles.clear()
    perLevel.fill(0)
    baseKeys.clear()
    inFlight.clear()
    baseOut = null
    log = []
    bytes = 0
  }

  /** Keep only the changes some request on its way has not seen. */
  const trimLog = () => {
    let oldest = baseOut?.at ?? Number.POSITIVE_INFINITY
    for (const f of inFlight.values()) oldest = Math.min(oldest, f.at)
    if (oldest === Number.POSITIVE_INFINITY) log = []
    else if (log.length > 0 && (log[0]?.v ?? 0) <= oldest) log = log.filter((e) => e.v > oldest)
  }

  /** A tile's stale rects past the cap: stale whole, or (away from the view) dropped. */
  const bound = (t: Tile) => {
    if (t.dirty.length <= DIRTY_MAX) return
    if (t.base || t.used === frame) {
      t.whole = Math.max(t.whole, ...t.dirty.map((d) => d.v))
      t.dirty = []
    } else dropTile(t)
  }

  const evict = () => {
    if (bytes <= cap && tiles.size <= MAX_TILES) return
    const victims = [...tiles.values()]
      .filter((t) => !t.base && t.used < frame)
      .sort((a, b) => a.used - b.used)
    for (const t of victims) {
      if (bytes <= cap && tiles.size <= MAX_TILES) break
      dropTile(t)
    }
  }

  let held: PyramidReply[] | null = null
  port.onmessage = (e) => {
    if (held !== null) held.push(e.data)
    else take(e.data)
  }
  const take = (r: PyramidReply) => {
    if (disposed) {
      if (r.t === 'tile') r.bitmap?.close()
      return
    }
    if (r.t === 'error') {
      fail()
      return
    }
    if (r.t === 'base') {
      if (r.dpr !== dpr || r.gen !== baseGen) return
      base = r.count < 0 ? 'none' : 'done'
      baseOut = null
      trimLog()
      o.onChange()
      return
    }
    const key = tileKey(r.k, r.tx, r.ty)
    const asked = r.id >= 0 ? inFlight.get(key) : undefined
    // Only what is still asked for is taken: a reply to a request let go since (tiles cleared
    // for a DPR change, even one changed back) was drawn before changes no longer logged, and
    // a base tile from an older raster stands for a raster no longer asked.
    const current = r.id >= 0 ? asked?.id === r.id : r.id === -(baseGen + 1) && baseOut !== null
    // The reply ends its request whatever becomes of its picture, so a request never stays in
    // flight (and holds back the asks behind it) for a picture not taken.
    if (current && asked !== undefined) inFlight.delete(key)
    if (!current || r.dpr !== dpr) {
      r.bitmap?.close()
      return
    }
    renders++
    const old = tiles.get(key)
    if (old !== undefined) redraws++
    if (old?.bitmap) {
      bytes -= old.bitmap.width * old.bitmap.height * 4
      old.bitmap.close()
    }
    if (r.bitmap !== null) bytes += r.bitmap.width * r.bitmap.height * 4
    // Drawn at version r.v: whatever changed after that is stale on it, whether the tile was
    // held then or not (asked before a change and answered after it).
    const area = grow(tileRect(r, dpr), 0)
    const reach = reachWorld(r.k)
    const dirty = old === undefined ? [] : old.dirty.filter((d) => d.v > r.v)
    // Past the cap the tile is stale whole (`bound`), since the newest change on it: only that one
    // is kept, so a reply after thousands of changes (an opening's slices) compares a few rects
    // for each, never each with all the others (36 ms a reply, by a CPU profile).
    let newest: { r: Rect; v: number } | null = null
    for (const e of log) {
      if (e.v <= r.v || !meetsGrown(e.r, reach, area)) continue
      if (dirty.length > DIRTY_MAX) {
        if (newest === null || e.v > newest.v) newest = { r: e.r, v: e.v }
        continue
      }
      const g = grow(e.r, reach)
      compared += dirty.length
      if (!dirty.some((d) => d.v === e.v && sameRect(d.r, g))) dirty.push({ r: g, v: e.v })
    }
    if (newest !== null) dirty.push({ r: grow(newest.r, reach), v: newest.v })
    const wholeSince = Math.max(
      old !== undefined && old.whole > r.v ? old.whole : 0,
      asked !== undefined && asked.whole > r.v ? asked.whole : 0,
      r.id < 0 && baseOut !== null && baseOut.whole > r.v ? baseOut.whole : 0,
    )
    const tile: Tile = {
      key,
      k: r.k,
      tx: r.tx,
      ty: r.ty,
      bitmap: r.bitmap,
      v: r.v,
      dirty: wholeSince > 0 ? [] : dirty,
      whole: wholeSince,
      used: old?.used ?? frame,
      base: r.id < 0 || old?.base === true,
    }
    tiles.set(key, tile)
    if (old === undefined) perLevel[tile.k] = (perLevel[tile.k] ?? 0) + 1
    if (tile.base) baseKeys.add(key)
    bound(tile)
    trimLog()
    for (const a of r.tones) o.source.wantTone?.(a)
    evict()
    o.onChange()
  }

  const invalidate = (rects: readonly Rect[]) => {
    if (rects.length === 0) return
    // Requests on their way are drawn before these changes: they are kept for their replies.
    if (inFlight.size > 0 || baseOut !== null) {
      if (log.length + rects.length > LOG_MAX) {
        for (const f of inFlight.values()) f.whole = v
        if (baseOut !== null) baseOut.whole = v
        log = []
      } else for (const r of rects) log.push({ r, v })
    }
    if (tiles.size === 0) return
    const touched = new Set<Tile>()
    for (let k = 0; k < LEVELS; k++) {
      // No tile of this level cached: nothing of it to stale (an opening's 100,000 notes, each a
      // rect, made a tile key a level for each, 51 MB of strings; by a heap profile).
      if (perLevel[k] === 0) continue
      const reach = reachWorld(k)
      for (const raw of rects) {
        const r = grow(raw, reach)
        const g = tileRange(k, dpr, r)
        // A huge rect (a far move's union is not asked for: each rect is one card's) still walks
        // only the tiles that are cached.
        const span = (g.tx1 - g.tx0 + 1) * (g.ty1 - g.ty0 + 1)
        const mark = (t: Tile | undefined) => {
          if (t === undefined || t.whole > 0) return
          t.dirty.push({ r, v })
          touched.add(t)
        }
        if (span > tiles.size) {
          for (const t of tiles.values()) {
            if (t.k === k && meets(tileRect(t, dpr), r)) mark(t)
          }
          continue
        }
        for (let tx = g.tx0; tx <= g.tx1; tx++) {
          for (let ty = g.ty0; ty <= g.ty1; ty++) mark(tiles.get(tileKey(k, tx, ty)))
        }
      }
    }
    for (const t of touched) bound(t)
  }

  const ask = (t: TileId) => {
    const key = tileKey(t.k, t.tx, t.ty)
    const id = nextId++
    inFlight.set(key, { id, at: v, whole: 0 })
    post({ t: 'tile', id, k: t.k, tx: t.tx, ty: t.ty, dpr })
  }

  /** Whether tile `key` should be asked for: missing, or stale past what is on its way. */
  const wanted = (key: string): boolean => {
    if (inFlight.has(key)) return false
    const t = tiles.get(key)
    return t === undefined || t.dirty.length > 0 || t.whole > 0
  }

  const draw = (ctx: CanvasRenderingContext2D, view: PyramidView): PyramidFrame => {
    frame++
    if (view.dpr !== dpr) {
      dpr = view.dpr
      clearTiles()
      if (built) askBase()
    }
    const c = view.camera
    const k = levelFor(c.zoom)
    const map = screenMapper(c, dpr, view.anchor)
    const dev = (p: Point) => {
      const s = map(p)
      return { x: Math.round(s.x * dpr), y: Math.round(s.y * dpr) }
    }
    const seen = visibleWorldRect(c, view.viewport)
    const g = tileRange(k, dpr, seen)
    const stats: PyramidFrame = { level: k, tiles: 0, fallback: 0, missing: 0, patched: 0 }
    const dirty: Array<{ r: Rect; tile: Tile }> = []
    const need: TileId[] = []
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    // Bilinear: a tile is never shown more than 2× smaller than rastered, where mipmaps
    // ('medium' and up) only soften it further.
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'low'
    const blit = (t: Tile, into: Rect) => {
      t.used = frame
      for (const d of t.dirty) dirty.push({ r: d.r, tile: t })
      if (t.bitmap === null) return
      const tr = tileRect(t, dpr)
      const a = dev({ x: into.x, y: into.y })
      const b = dev({ x: into.x + into.w, y: into.y + into.h })
      if (b.x <= a.x || b.y <= a.y) return
      const s = TILE_PX / tr.w
      ctx.drawImage(
        t.bitmap,
        (into.x - tr.x) * s,
        (into.y - tr.y) * s,
        into.w * s,
        into.h * s,
        a.x,
        a.y,
        b.x - a.x,
        b.y - a.y,
      )
    }
    for (let tx = g.tx0; tx <= g.tx1; tx++) {
      for (let ty = g.ty0; ty <= g.ty1; ty++) {
        const key = tileKey(k, tx, ty)
        const own = tiles.get(key)
        const r = tileRect({ k, tx, ty }, dpr)
        if (wanted(key)) need.push({ k, tx, ty })
        if (own !== undefined) {
          blit(own, r)
          stats.tiles++
          continue
        }
        // Its own is on its way: the finer level's four (sharper, where the view was just drawn
        // from them), else the nearest coarser level that has its place, with any of the four.
        const down: Tile[] = []
        if (k > 0) {
          for (let dx = 0; dx < 2; dx++) {
            for (let dy = 0; dy < 2; dy++) {
              const t = tiles.get(tileKey(k - 1, tx * 2 + dx, ty * 2 + dy))
              if (t !== undefined) down.push(t)
            }
          }
        }
        let found = down.length > 0
        if (down.length < 4) {
          for (let j = k + 1; j < LEVELS; j++) {
            const n = 2 ** (j - k)
            const up = tiles.get(tileKey(j, Math.floor(tx / n), Math.floor(ty / n)))
            if (up === undefined) continue
            blit(up, r)
            found = true
            break
          }
        }
        for (const t of down) blit(t, tileRect(t, dpr))
        if (found) stats.fallback++
        else stats.missing++
      }
    }
    if (dirty.length > 0) {
      stats.patched = patch(ctx, view, k, dirty, dev)
    }
    ctx.restore()
    // Ask for the view's tiles nearest its centre first, then (with room) a ring around it and
    // the coarser level, which a pan or a zoom out reaches next.
    const cx = (g.tx0 + g.tx1) / 2
    const cy = (g.ty0 + g.ty1) / 2
    // A tile stale whole (too many changes to draw over it) goes first, then by distance.
    const whole = (t: TileId) => ((tiles.get(tileKey(t.k, t.tx, t.ty))?.whole ?? 0) > 0 ? 0 : 1)
    need.sort(
      (a, b) =>
        whole(a) - whole(b) || Math.hypot(a.tx - cx, a.ty - cy) - Math.hypot(b.tx - cx, b.ty - cy),
    )
    let room = built ? IN_FLIGHT - inFlight.size : 0
    for (const t of need) {
      if (room <= 0) break
      ask(t)
      room--
    }
    if (room > 0 && need.length === 0 && bytes < cap * PREFETCH_SHARE) {
      // Only missing tiles: a stale one away from the view is drawn again when it is in view.
      const near = (j: number, ring: number) => {
        const h = tileRange(j, dpr, seen)
        const list: TileId[] = []
        for (let tx = h.tx0 - ring; tx <= h.tx1 + ring; tx++) {
          for (let ty = h.ty0 - ring; ty <= h.ty1 + ring; ty++) {
            const key = tileKey(j, tx, ty)
            if (!tiles.has(key) && !inFlight.has(key)) list.push({ k: j, tx, ty })
          }
        }
        return list
      }
      // The coarsest level, kept whole, is drawn again once it has gathered many changes.
      const worn: TileId[] = []
      for (const key of baseKeys) {
        const t = tiles.get(key)
        if (t === undefined || inFlight.has(key)) continue
        if (t.dirty.length >= BASE_REFRESH || t.whole > 0) worn.push(t)
      }
      for (const t of [...near(k, 1), ...(k + 1 < LEVELS ? near(k + 1, 0) : []), ...worn]) {
        if (room <= 0) break
        ask(t)
        room--
      }
    }
    last = stats
    return stats
  }

  /**
   * Draw the stale rects from the source, over the tiles: each is cleared, then everything in it
   * that is not hidden is drawn as the level draws it (its reference zoom's sizes, scaled to the
   * view), clipped to it. At most `PATCH_RECTS` rects and about `PATCH_CARDS` cards a frame: the
   * tiles of the rest are stale whole (shown as they are, and asked again first). Returns the
   * rects drawn.
   */
  const patch = (
    ctx: CanvasRenderingContext2D,
    view: PyramidView,
    k: number,
    dirty: ReadonlyArray<{ r: Rect; tile: Tile }>,
    dev: (p: Point) => Point,
  ): number => {
    const zref = levelRefZoom(k)
    const z = view.camera.zoom
    const seen = grow(visibleWorldRect(view.camera, view.viewport), reachWorld(k))
    // One query per distinct rect, with every tile it stales.
    const rects = new Map<string, { r: Rect; tiles: Tile[] }>()
    for (const d of dirty) {
      if (!meets(d.r, seen)) continue
      const key = `${d.r.x},${d.r.y},${d.r.w},${d.r.h}`
      const e = rects.get(key)
      if (e === undefined) rects.set(key, { r: d.r, tiles: [d.tile] })
      else e.tiles.push(d.tile)
    }
    if (rects.size === 0) return 0
    const ids = new Set<string>()
    const keys = new Set<string>()
    const clips: Rect[] = []
    let cards = 0
    for (const { r, tiles: on } of rects.values()) {
      const found =
        clips.length < PATCH_RECTS && cards < PATCH_CARDS ? [...o.source.notesIn(r)] : null
      if (found === null || cards + found.length > PATCH_CARDS + 64) {
        // Past the budget: these tiles wait whole for the worker instead.
        for (const t of on) {
          t.whole = Math.max(t.whole, ...t.dirty.map((d) => d.v), v)
          t.dirty = []
        }
        continue
      }
      cards += found.length
      for (const id of found) if (!hiddenNotes.has(id)) ids.add(id)
      for (const key of o.source.segmentsIn(r)) if (!hiddenSegs.has(key)) keys.add(key)
      const a = dev({ x: r.x, y: r.y })
      const b = dev({ x: r.x + r.w, y: r.y + r.h })
      const d = { x: a.x - 1, y: a.y - 1, w: b.x - a.x + 2, h: b.y - a.y + 2 }
      ctx.clearRect(d.x, d.y, d.w, d.h)
      clips.push(d)
    }
    if (clips.length === 0) return 0
    const notes: CardRec[] = []
    for (const id of ids) {
      const f = o.source.note(id)
      if (f !== undefined) notes.push(cardRec(f))
    }
    notes.sort(byPaintOrder)
    // As a tile draws: world about the anchor at the reference zoom, scaled to the view.
    const origin = dev(view.anchor)
    const scale = (dpr * z) / zref
    const mx = (x: number) => (x - view.anchor.x) * zref
    const my = (y: number) => (y - view.anchor.y) * zref
    const quad = (q: readonly number[]): Point[] => [
      { x: mx(q[0] as number), y: my(q[1] as number) },
      { x: mx(q[2] as number), y: my(q[3] as number) },
      { x: mx(q[4] as number), y: my(q[5] as number) },
      { x: mx(q[6] as number), y: my(q[7] as number) },
    ]
    const paints: CardPaint[][] = []
    const pins: Point[] = []
    for (const n of notes) {
      const paper = { fill: n.fill, corners: quad(n.corners) }
      paints.push(
        n.image === null
          ? [paper]
          : [paper, { fill: n.tone ?? OVERVIEW.printTone, corners: quad(n.image) }],
      )
      if (n.pin !== null) pins.push({ x: mx(n.pin[0]), y: my(n.pin[1]) })
    }
    const threads: ThreadPaint[] = []
    for (const key of keys) {
      const s = o.source.segment(key)
      if (s === undefined) continue
      const [p0, p1, p2, p3] = quad(segRec(s).p) as [Point, Point, Point, Point]
      threads.push({
        curve: { p0, p1, p2, p3 },
        color: s.color,
        alpha: overviewYarnAlpha(zref),
        width: overviewYarnWidth(zref),
      })
    }
    ctx.save()
    ctx.beginPath()
    for (const d of clips) ctx.rect(d.x, d.y, d.w, d.h)
    ctx.clip()
    ctx.setTransform(scale, 0, 0, scale, origin.x, origin.y)
    drawCards(ctx, paints)
    drawThreads(ctx, threads)
    drawPinDots(ctx, pins, overviewPinRadius(zref))
    ctx.restore()
    return clips.length
  }

  unschedule = schedule(buildSlice)

  return {
    get ready() {
      return !failed && built && (base === 'done' || base === 'none')
    },
    draw,
    invalidate,
    changed(notes, segments) {
      for (const id of notes) takeNote(id)
      for (const key of segments) takeSeg(key)
      flush()
    },
    setHidden(notes, segments) {
      const before = { notes: hiddenNotes, segs: hiddenSegs }
      if (notes === before.notes && segments === before.segs) return
      hiddenNotes = notes
      hiddenSegs = segments
      for (const id of before.notes) if (!notes.has(id)) takeNote(id)
      for (const id of notes) if (!before.notes.has(id)) takeNote(id)
      for (const key of before.segs) if (!segments.has(key)) takeSeg(key)
      for (const key of segments) if (!before.segs.has(key)) takeSeg(key)
      flush()
    },
    get failed() {
      return failed
    },
    holdReplies(on) {
      if (on) {
        held ??= []
        return
      }
      const replies = held ?? []
      held = null
      for (const r of replies) take(r)
    },
    sleep() {
      for (const t of [...tiles.values()]) if (!t.base) dropTile(t)
    },
    retone(asset) {
      const ids = byAsset.get(asset)
      if (ids === undefined) return
      for (const id of [...ids]) takeNote(id)
      flush()
    },
    stats: () => ({
      ready: !failed && built && (base === 'done' || base === 'none'),
      built,
      version: v,
      tiles: tiles.size,
      bytes,
      inFlight: inFlight.size,
      renders,
      redraws,
      compared,
      cards: sent.size,
      segments: segSent.size,
      last,
    }),
    dispose() {
      disposed = true
      unschedule?.()
      clearTiles()
      port.onmessage = null
      port.terminate?.()
    },
  }
}

/** World bounds of a note frame's card: what a change to it stales. */
export function frameBox(f: NoteFrame): Rect {
  return boxRect(cardRec(f).box)
}
