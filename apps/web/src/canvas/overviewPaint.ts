import { PIN_BRASS } from '../styles/stationery'
import { LOD } from './lod'
import type { Point } from './types'
import type { CubicBezier } from './yarnGeometry'

/**
 * The overview's paint, shared by the card overview (`overview.ts`, which re-exports all of this)
 * and the far-zoom pyramid's worker, which must not pull in the board's schemas: the offset
 * shadow, the pin dot and thread sizes (screen px, clamped by zoom) and the threads' opacity, and
 * the fills and strokes that paint cards level by level, threads by dye and pins as brass dots.
 * See `OVERVIEW` for what each size is.
 */
export const PAINT = {
  shadow: 'rgba(40,24,8,0.28)',
  shadowOffset: { x: 0.75, y: 1.25 },
  printTone: '#9A968C',
  pin: PIN_BRASS,
  pinRadius: { world: 10, min: 0.75, max: 1.5 },
  yarnWidth: { world: 10, min: 1, max: 1.5 },
  yarnAlphaAtMin: 0.45,
  /** Where the threads' opacity reaches `yarnAlphaAtMin`: 2 % zoom. */
  yarnAlphaFloorZoom: 0.02,
} as const

/** A 2D context on the page or in a worker (the picture pyramid's tiles). */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
export const safeZoom = (zoom: number) => (Number.isFinite(zoom) && zoom > 0 ? zoom : 1)

/** Screen radius of a card's pin dot. */
export function overviewPinRadius(zoom: number): number {
  const r = PAINT.pinRadius
  return clamp(r.world * safeZoom(zoom), r.min, r.max)
}

/** Screen width of a thread. */
export function overviewYarnWidth(zoom: number): number {
  const w = PAINT.yarnWidth
  return clamp(w.world * safeZoom(zoom), w.min, w.max)
}

/**
 * Threads' opacity: `yarnAlphaAtMin` at `yarnAlphaFloorZoom` and below, rising with log zoom to 1
 * where overview begins, so the level hands over to lite's opaque strands without a jump.
 */
export function overviewYarnAlpha(zoom: number): number {
  const lo = Math.log(PAINT.yarnAlphaFloorZoom)
  const t = clamp((Math.log(safeZoom(zoom)) - lo) / (Math.log(LOD.overview.enterBelow) - lo), 0, 1)
  return PAINT.yarnAlphaAtMin + (1 - PAINT.yarnAlphaAtMin) * t
}

/** One flat polygon to fill, in screen px. */
export interface CardPaint {
  fill: string
  corners: Point[]
}

/**
 * Add a polygon to the current path, left open: `fill` closes every subpath itself, and Chrome's
 * `closePath` costs time in proportion to the subpaths before it (5,000 cards: 157 ms).
 */
export function trace(ctx: Ctx2D, corners: readonly Point[], dx = 0, dy = 0): void {
  for (const [k, c] of corners.entries()) {
    if (k === 0) ctx.moveTo(c.x + dx, c.y + dy)
    else ctx.lineTo(c.x + dx, c.y + dy)
  }
}

/** Screen px per cell of the grid that finds overlapping cards. */
const LEVEL_CELL_PX = 64

/**
 * Each card's paint level: 0, or one above the highest level of any earlier card whose box
 * (paper plus shadow) it overlaps. Cards on one level never overlap, so their order within it
 * does not show, and every card lands above each earlier card it overlaps.
 */
export function cardLevels(cards: readonly CardPaint[][]): number[] {
  const { x: sx, y: sy } = PAINT.shadowOffset
  const boxes: Array<[number, number, number, number]> = []
  const levels: number[] = []
  const grid = new Map<number, number[]>()
  const key = (cx: number, cy: number) => cx * 0x100000 + cy
  for (const [k, paints] of cards.entries()) {
    let x0 = Number.POSITIVE_INFINITY
    let y0 = Number.POSITIVE_INFINITY
    let x1 = Number.NEGATIVE_INFINITY
    let y1 = Number.NEGATIVE_INFINITY
    for (const c of paints[0]?.corners ?? []) {
      x0 = Math.min(x0, c.x)
      y0 = Math.min(y0, c.y)
      x1 = Math.max(x1, c.x)
      y1 = Math.max(y1, c.y)
    }
    x1 += Math.max(0, sx)
    y1 += Math.max(0, sy)
    boxes.push([x0, y0, x1, y1])
    if (!(x0 <= x1 && y0 <= y1)) {
      levels.push(0)
      continue
    }
    const c0 = Math.floor(x0 / LEVEL_CELL_PX)
    const c1 = Math.floor(x1 / LEVEL_CELL_PX)
    const r0 = Math.floor(y0 / LEVEL_CELL_PX)
    const r1 = Math.floor(y1 / LEVEL_CELL_PX)
    let level = 0
    for (let cx = c0; cx <= c1; cx++) {
      for (let cy = r0; cy <= r1; cy++) {
        for (const other of grid.get(key(cx, cy)) ?? []) {
          const b = boxes[other] as [number, number, number, number]
          const lv = levels[other] as number
          if (lv >= level && x0 < b[2] && b[0] < x1 && y0 < b[3] && b[1] < y1) level = lv + 1
        }
      }
    }
    levels.push(level)
    for (let cx = c0; cx <= c1; cx++) {
      for (let cy = r0; cy <= r1; cy++) {
        const cell = grid.get(key(cx, cy))
        if (cell === undefined) grid.set(key(cx, cy), [k])
        else cell.push(k)
      }
    }
  }
  return levels
}

/**
 * Paint cards (each its paints, back to front; the given order is z order) level by level
 * (`cardLevels`): a level's shadows in one fill, then its papers and then its print images, one
 * fill per colour. Where cards overlap, z order holds; elsewhere a whole board of cards takes a
 * fill per palette colour. Returns the number of fills.
 */
export function drawCards(ctx: Ctx2D, cards: readonly CardPaint[][]): number {
  if (cards.length === 0) return 0
  const byLevel: number[][] = []
  for (const [k, level] of cardLevels(cards).entries()) {
    const ids = byLevel[level]
    if (ids === undefined) byLevel[level] = [k]
    else ids.push(k)
  }
  const { x, y } = PAINT.shadowOffset
  let fills = 0
  for (const ids of byLevel) {
    if (ids === undefined) continue
    ctx.beginPath()
    for (const k of ids) {
      const paper = cards[k]?.[0]
      if (paper !== undefined) trace(ctx, paper.corners, x, y)
    }
    ctx.fillStyle = PAINT.shadow
    ctx.fill()
    fills++
    for (let depth = 0; ; depth++) {
      const runs = new Map<string, CardPaint[]>()
      for (const k of ids) {
        const p = cards[k]?.[depth]
        if (p === undefined) continue
        const run = runs.get(p.fill)
        if (run === undefined) runs.set(p.fill, [p])
        else run.push(p)
      }
      if (runs.size === 0) break
      for (const [fill, run] of runs) {
        ctx.beginPath()
        for (const p of run) trace(ctx, p.corners)
        ctx.fillStyle = fill
        ctx.fill()
        fills++
      }
    }
  }
  return fills
}

/** A thread to stroke: its screen-space curve, dye and opacity. */
export interface ThreadPaint {
  curve: CubicBezier
  color: string
  alpha: number
  width: number
}

/**
 * Stroke threads, one stroke per dye, opacity and width: at overview size their order among
 * themselves does not show, so the paint order is not kept. Returns the number of strokes.
 */
export function drawThreads(ctx: Ctx2D, threads: readonly ThreadPaint[]): number {
  const runs = new Map<string, ThreadPaint[]>()
  for (const t of threads) {
    if (!(t.alpha > 0)) continue
    const key = `${t.color}|${t.alpha}|${t.width}`
    const run = runs.get(key)
    if (run === undefined) runs.set(key, [t])
    else run.push(t)
  }
  ctx.save()
  ctx.lineCap = 'round'
  for (const run of runs.values()) {
    const first = run[0] as ThreadPaint
    ctx.beginPath()
    for (const { curve: c } of run) {
      ctx.moveTo(c.p0.x, c.p0.y)
      ctx.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y)
    }
    ctx.globalAlpha = Math.min(1, first.alpha)
    ctx.strokeStyle = first.color
    ctx.lineWidth = first.width
    ctx.stroke()
  }
  ctx.restore()
  return runs.size
}

/**
 * Take cards (their paper and offset shadow), threads of `width` and pin dots of radius `r` out
 * of a picture already drawn (`destination-out`), a px past their edges for the antialiasing:
 * what a picture shown under a pass drew where it is drawn live now. What lay
 * under them goes with them until the pass is done.
 */
export function eraseOverview(
  ctx: Ctx2D,
  cards: readonly (readonly Point[])[],
  threads: readonly CubicBezier[],
  width: number,
  pins: readonly Point[] = [],
  r = 0,
): void {
  if (cards.length + threads.length + pins.length === 0) return
  const { x, y } = PAINT.shadowOffset
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.globalAlpha = 1
  ctx.fillStyle = '#000'
  ctx.strokeStyle = '#000'
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (cards.length > 0) {
    ctx.beginPath()
    for (const c of cards) {
      trace(ctx, c)
      trace(ctx, c, x, y)
    }
    ctx.fill()
    ctx.lineWidth = 2
    ctx.stroke()
  }
  if (threads.length > 0) {
    ctx.beginPath()
    for (const c of threads) {
      ctx.moveTo(c.p0.x, c.p0.y)
      ctx.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y)
    }
    ctx.lineWidth = width + 2
    ctx.stroke()
  }
  if (pins.length > 0) {
    ctx.beginPath()
    for (const p of pins) {
      ctx.moveTo(p.x + r + 1, p.y)
      ctx.arc(p.x, p.y, r + 1, 0, Math.PI * 2)
    }
    ctx.fill()
  }
  ctx.restore()
}

/** Every pin as a brass dot of radius `r`, in one path. */
export function drawPinDots(ctx: Ctx2D, pins: readonly Point[], r: number): void {
  if (pins.length === 0) return
  ctx.beginPath()
  for (const p of pins) {
    ctx.moveTo(p.x + r, p.y)
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
  }
  ctx.fillStyle = PAINT.pin
  ctx.fill()
}
