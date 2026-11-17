import RBush, { type BBox } from 'rbush'
import {
  type CardPaint,
  type Ctx2D,
  drawCards,
  drawPinDots,
  drawThreads,
  overviewPinRadius,
  overviewYarnAlpha,
  overviewYarnWidth,
  PAINT,
  type ThreadPaint,
} from '../overviewPaint'
import type { Point } from '../types'
import type { CubicBezier } from '../yarnGeometry'
import {
  levelRefZoom,
  levelScale,
  reachWorld,
  TILE_PX,
  type TileId,
  tileRange,
  tileRect,
} from './levels'

/**
 * The far-zoom picture pyramid's worker: it keeps every card and thread the
 * page sends (world geometry already resolved there: a card's turned corners, its print's image
 * area, its pin and colours; a thread's two edge pins and dye) in two rbush trees, and rasters a
 * tile on request into an `OffscreenCanvas`, handed back as an `ImageBitmap`. A tile paints as the
 * card overview does (`overview.ts`), at its level's reference zoom: cards level by level with
 * their offset shadow, then the threads at their rest sag batched by dye, then the brass pin
 * dots. The page side is `pyramid.ts`; tests run this module in node, where it only exports.
 */

/** A card as the worker paints it, in world px. */
export interface CardRec {
  id: string
  z: number
  /** The turned paper's corners: x0, y0, … x3, y3. */
  corners: number[]
  /** A print's image area, turned with the paper; null for other notes. */
  image: number[] | null
  /** The hanging pin, or null. */
  pin: [number, number] | null
  /** The paper's colour (a print's white stock). */
  fill: string
  /** A print's image tone, null until measured (the neutral tone is drawn meanwhile). */
  tone: string | null
  /** A print's asset, to ask for its tone; null for other notes. */
  asset: string | null
  /** Bounds of the corners: x0, y0, x1, y1. */
  box: [number, number, number, number]
}

/**
 * A thread segment as the worker strokes it, world px: the cubic between its edge pins at rest
 * (`p`: x0, y0, … x3, y3), as the card overview's static layer draws it.
 */
export interface SegRec {
  key: string
  p: number[]
  color: string
}

export type PyramidRequest =
  /** Cards and segments to set (`cards`, `segs`) or drop, all as of version `v`. */
  | {
      t: 'put'
      v: number
      cards: CardRec[]
      drop: string[]
      segs: SegRec[]
      dropSegs: string[]
    }
  /** Raster one tile. */
  | { t: 'tile'; id: number; k: number; tx: number; ty: number; dpr: number }
  /** Raster every tile of level `k` that has anything on it, if there are at most `max`. */
  | { t: 'base'; k: number; dpr: number; max: number; gen: number }

export type PyramidReply =
  /** A tile, drawn at version `v`; null when nothing is on it. `tones`: prints with none yet. */
  | {
      t: 'tile'
      id: number
      k: number
      tx: number
      ty: number
      dpr: number
      v: number
      bitmap: ImageBitmap | null
      tones: string[]
    }
  /** Level `k`'s tiles have all been sent (`count`), or there were more than asked (-1). */
  | { t: 'base'; k: number; dpr: number; v: number; count: number; gen: number }
  /** The worker cannot draw (no 2D context): the page draws the card overview instead. */
  | { t: 'error'; reason: string }

/** One end of a message channel: a worker scope, a `Worker`, or a test's stand-in. */
export interface PyramidPort<In, Out> {
  onmessage: ((e: MessageEvent<In>) => void) | null
  postMessage(m: Out, transfer?: Transferable[]): void
}

/** Where a tile is drawn: a context, and how to take the drawing as a bitmap. */
export interface TileCanvas {
  ctx: Ctx2D | null
  /** The drawing as a bitmap (the canvas is left blank). */
  take(): ImageBitmap
}

interface CardItem extends BBox {
  rec: CardRec
}

interface SegItem extends BBox {
  rec: SegRec
}

const cardBox = (rec: CardRec): CardItem => ({
  minX: rec.box[0],
  minY: rec.box[1],
  maxX: rec.box[2],
  maxY: rec.box[3],
  rec,
})

/** The bounds of a cubic's control points, which hold the curve: x0, y0, x1, y1. */
export function hullOf(p: readonly number[]): [number, number, number, number] {
  const xs = [p[0], p[2], p[4], p[6]] as number[]
  const ys = [p[1], p[3], p[5], p[7]] as number[]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const segBox = (rec: SegRec): SegItem => {
  const [minX, minY, maxX, maxY] = hullOf(rec.p)
  return { minX, minY, maxX, maxY, rec }
}

/** Paint order: by z, then id (as the card overview's `inPaintOrder`). */
export const byPaintOrder = (a: { z: number; id: string }, b: { z: number; id: string }) =>
  a.z !== b.z ? a.z - b.z : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/**
 * Paint one tile: `cards` (in paint order) and `segs`, mapped from world px about `origin` (the
 * tile's top-left) at level `k`'s raster scale, with every screen-size detail at the level's
 * reference zoom. Returns what it drew.
 */
export function drawTile(
  ctx: Ctx2D,
  cards: readonly CardRec[],
  segs: readonly SegRec[],
  origin: Point,
  k: number,
  dpr: number,
): { cards: number; segs: number } {
  const zref = levelRefZoom(k)
  const c = (dpr * levelScale(k)) / zref
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, TILE_PX, TILE_PX)
  ctx.setTransform(c, 0, 0, c, 0, 0)
  const mx = (x: number) => (x - origin.x) * zref
  const my = (y: number) => (y - origin.y) * zref
  const quad = (q: readonly number[]): Point[] => [
    { x: mx(q[0] as number), y: my(q[1] as number) },
    { x: mx(q[2] as number), y: my(q[3] as number) },
    { x: mx(q[4] as number), y: my(q[5] as number) },
    { x: mx(q[6] as number), y: my(q[7] as number) },
  ]
  const paints: CardPaint[][] = []
  const pins: Point[] = []
  for (const card of cards) {
    const paper: CardPaint = { fill: card.fill, corners: quad(card.corners) }
    paints.push(
      card.image === null
        ? [paper]
        : [paper, { fill: card.tone ?? PAINT.printTone, corners: quad(card.image) }],
    )
    if (card.pin !== null) pins.push({ x: mx(card.pin[0]), y: my(card.pin[1]) })
  }
  drawCards(ctx, paints)
  const alpha = overviewYarnAlpha(zref)
  const width = overviewYarnWidth(zref)
  const threads: ThreadPaint[] = segs.map((s) => {
    const [p0, p1, p2, p3] = quad(s.p)
    return { curve: { p0, p1, p2, p3 } as CubicBezier, color: s.color, alpha, width }
  })
  drawThreads(ctx, threads)
  drawPinDots(ctx, pins, overviewPinRadius(zref))
  return { cards: cards.length, segs: segs.length }
}

/** The worker's side: keep what is put, answer tile requests. Returns its state for tests. */
export function serve(
  port: PyramidPort<PyramidRequest, PyramidReply>,
  makeCanvas: () => TileCanvas = tileCanvas,
) {
  const cards = new RBush<CardItem>()
  const segs = new RBush<SegItem>()
  const cardItems = new Map<string, CardItem>()
  const segItems = new Map<string, SegItem>()
  let v = 0
  let canvas: TileCanvas | null = null

  const put = (m: Extract<PyramidRequest, { t: 'put' }>) => {
    v = m.v
    for (const id of m.drop) {
      const old = cardItems.get(id)
      if (old === undefined) continue
      cards.remove(old)
      cardItems.delete(id)
    }
    for (const key of m.dropSegs) {
      const old = segItems.get(key)
      if (old === undefined) continue
      segs.remove(old)
      segItems.delete(key)
    }
    const fresh: CardItem[] = []
    for (const rec of m.cards) {
      const old = cardItems.get(rec.id)
      if (old !== undefined) cards.remove(old)
      const item = cardBox(rec)
      cardItems.set(rec.id, item)
      fresh.push(item)
    }
    // A first load comes in large pieces: bulk-insert them.
    if (fresh.length > 256) cards.load(fresh)
    else for (const item of fresh) cards.insert(item)
    const freshSegs: SegItem[] = []
    for (const rec of m.segs) {
      const old = segItems.get(rec.key)
      if (old !== undefined) segs.remove(old)
      const item = segBox(rec)
      segItems.set(rec.key, item)
      freshSegs.push(item)
    }
    if (freshSegs.length > 256) segs.load(freshSegs)
    else for (const item of freshSegs) segs.insert(item)
  }

  /** Raster tile `t`: null when nothing is on it; throws when there is nothing to draw with. */
  const render = (t: TileId, dpr: number): { bitmap: ImageBitmap | null; tones: string[] } => {
    const r = tileRect(t, dpr)
    const reach = reachWorld(t.k)
    const q = {
      minX: r.x - reach,
      minY: r.y - reach,
      maxX: r.x + r.w + reach,
      maxY: r.y + r.h + reach,
    }
    const onIt = cards.search(q).map((i) => i.rec)
    const lines = segs.search(q).map((i) => i.rec)
    if (onIt.length === 0 && lines.length === 0) return { bitmap: null, tones: [] }
    onIt.sort(byPaintOrder)
    canvas ??= makeCanvas()
    if (canvas.ctx === null) throw new NoContext()
    drawTile(canvas.ctx, onIt, lines, { x: r.x, y: r.y }, t.k, dpr)
    const tones = new Set<string>()
    for (const c of onIt) if (c.asset !== null && c.tone === null) tones.add(c.asset)
    return { bitmap: canvas.take(), tones: [...tones] }
  }

  const send = (t: TileId, id: number, dpr: number) => {
    const { bitmap, tones } = render(t, dpr)
    const reply: PyramidReply = { t: 'tile', id, ...t, dpr, v, bitmap, tones }
    port.postMessage(reply, bitmap === null ? [] : [bitmap])
  }

  port.onmessage = (e) => {
    try {
      take(e.data)
    } catch (err) {
      if (!(err instanceof NoContext)) throw err
      port.postMessage({ t: 'error', reason: err.message })
    }
  }
  const take = (m: PyramidRequest) => {
    if (m.t === 'put') put(m)
    else if (m.t === 'tile') send({ k: m.k, tx: m.tx, ty: m.ty }, m.id, m.dpr)
    else {
      const keys = new Map<string, TileId>()
      const reach = reachWorld(m.k)
      for (const item of cardItems.values()) {
        const g = tileRange(m.k, m.dpr, {
          x: item.minX - reach,
          y: item.minY - reach,
          w: item.maxX - item.minX + 2 * reach,
          h: item.maxY - item.minY + 2 * reach,
        })
        for (let tx = g.tx0; tx <= g.tx1; tx++) {
          for (let ty = g.ty0; ty <= g.ty1; ty++) keys.set(`${tx}/${ty}`, { k: m.k, tx, ty })
        }
        if (keys.size > m.max) break
      }
      if (keys.size > m.max) {
        port.postMessage({ t: 'base', k: m.k, dpr: m.dpr, v, count: -1, gen: m.gen })
        return
      }
      // A base tile's id names its raster: -(gen + 1).
      for (const t of keys.values()) send(t, -(m.gen + 1), m.dpr)
      port.postMessage({ t: 'base', k: m.k, dpr: m.dpr, v, count: keys.size, gen: m.gen })
    }
  }
  return {
    get size() {
      return { cards: cardItems.size, segs: segItems.size }
    },
    render,
  }
}

class NoContext extends Error {
  constructor() {
    super('no 2D context for the tiles')
  }
}

/**
 * The worker's tile canvas: one `OffscreenCanvas`, reused, rastered on the CPU in this thread
 * (`willReadFrequently` keeps Chrome's canvas off the GPU). On a GPU canvas the drawing goes to
 * the GPU process's main thread, which the page's frames share: a coarse tile of 100,000 notes
 * (each fill a path of thousands of cards) was 60–90 ms of raster there, and a key typed while it
 * ran was shown 64–96 ms late. Here the page only uploads the finished tile.
 * The tiles look the same: against the card overview, a mean difference of 2.59–5.35 of 255
 * (GPU: 2.56–5.42).
 */
export function tileCanvas(): TileCanvas {
  const c = new OffscreenCanvas(TILE_PX, TILE_PX)
  return {
    ctx: c.getContext('2d', { willReadFrequently: true }),
    take: () => c.transferToImageBitmap(),
  }
}

// Inside a worker, the scope itself is the port.
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  serve(globalThis as unknown as PyramidPort<PyramidRequest, PyramidReply>)
}
