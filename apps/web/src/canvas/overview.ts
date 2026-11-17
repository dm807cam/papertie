import { type Note, PALETTE } from '@papertie/core'
import { PRINT_STOCK } from '../styles/stationery'
import { type PaperShape, paperCorners } from './layering'
import { type CardPaint, type Ctx2D, PAINT, safeZoom, trace } from './overviewPaint'
import type { Point, Rect } from './types'
import type { CubicBezier } from './yarnGeometry'

export {
  type CardPaint,
  type Ctx2D,
  cardLevels,
  drawCards,
  drawPinDots,
  drawThreads,
  eraseOverview,
  overviewPinRadius,
  overviewYarnAlpha,
  overviewYarnWidth,
  type ThreadPaint,
} from './overviewPaint'

/**
 * The overview look, in screen px unless a name says world: a card's offset shadow (the DOM
 * papers' shadow brown, cast down and right like the cork's light from the upper left, about the
 * reach of a paper shadow's middle layer at the 0.15 handover, and kept at that screen size below
 * so a card's lower edge always lifts off the cork), a print's stock, border and caption band
 * and its image tone until the file's is measured, the pin dot and thread widths (world size
 * times zoom, clamped so they meet lite's at its threshold), the threads' opacity at
 * `yarnAlphaFloorZoom` and below (a whole board's threads would otherwise bury its cards), and the
 * selection and hover outlines drawn just outside the paper.
 */
export const OVERVIEW = {
  ...PAINT,
  printStock: PRINT_STOCK,
  printBorderWorld: 12,
  printCaptionWorld: 32,
  selectedYarnScale: 2,
  selected: PALETTE.cream.ink,
  hover: 'rgba(251,248,242,0.9)',
  outline: { selected: 1.5, hover: 1, gap: 1.5 },
} as const

/** A note's paper colour as the DOM paints it: its palette paper, or a print's white stock. */
export function cardFill(n: Pick<Note, 'paper' | 'style'>): string {
  if (n.style === 'print') return OVERVIEW.printStock
  return (PALETTE[n.paper] ?? PALETTE.cream).paper
}

/** A card in world px: its paper's turned corners, a print's image area, the paper's box. */
export interface CardShape {
  corners: Point[]
  image: Point[] | null
  box: Rect
}

/** Axis-aligned bounds of `pts`. */
function boundsOf(pts: readonly Point[]): Rect {
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * A card's world geometry: the paper as drawn (`shape`, already through overrides and the tilt
 * pref) and, for a print, its image area: inside the 12 px border, above a caption band when it
 * has text, turned with the paper.
 */
export function cardShape(n: Pick<Note, 'style' | 'text'>, shape: PaperShape): CardShape {
  const corners = paperCorners(shape)
  if (n.style !== 'print') return { corners, image: null, box: boundsOf(corners) }
  const b = OVERVIEW.printBorderWorld
  const caption = n.text.trim() === '' ? 0 : OVERVIEW.printCaptionWorld
  const r = shape.rect
  const rect: Rect = {
    x: r.x + b,
    y: r.y + b,
    w: Math.max(0, r.w - 2 * b),
    h: Math.max(0, r.h - 2 * b - caption),
  }
  return { corners, image: paperCorners({ ...shape, rect }), box: boundsOf(corners) }
}

/**
 * A card's paints, back to front, mapped to the screen: its paper, then a print's image in
 * `tone`.
 */
export function cardPaints(
  n: Pick<Note, 'paper' | 'style'>,
  c: CardShape,
  map: (p: Point) => Point,
  tone: string = OVERVIEW.printTone,
): CardPaint[] {
  const paper = { fill: cardFill(n), corners: c.corners.map(map) }
  return c.image === null ? [paper] : [paper, { fill: tone, corners: c.image.map(map) }]
}

/** Whether rects `a` and `b` touch (edges included). */
export function rectsTouch(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
}

/** The bounds of a Bézier's control points, which contain the curve. */
export function hullBox(c: CubicBezier): Rect {
  return boundsOf([c.p0, c.p1, c.p2, c.p3])
}

/**
 * The selection or hover outline around a card, `OVERVIEW.outline.gap` screen px outside the
 * paper (`shape` grown by that much at `zoom`, so it shows on a card a few px wide).
 */
export function drawOutline(
  ctx: Ctx2D,
  shape: PaperShape,
  zoom: number,
  map: (p: Point) => Point,
  kind: 'selected' | 'hover',
): void {
  const g = (OVERVIEW.outline.gap + OVERVIEW.outline[kind] / 2) / safeZoom(zoom)
  const r = shape.rect
  const grown = { ...shape, rect: { x: r.x - g, y: r.y - g, w: r.w + 2 * g, h: r.h + 2 * g } }
  ctx.save()
  ctx.beginPath()
  trace(ctx, paperCorners(grown).map(map))
  ctx.closePath()
  ctx.strokeStyle = kind === 'selected' ? OVERVIEW.selected : OVERVIEW.hover
  ctx.lineWidth = OVERVIEW.outline[kind]
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.restore()
}
