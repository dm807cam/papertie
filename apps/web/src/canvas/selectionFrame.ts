import { PALETTE } from '@papertie/core'
import { yarnColor } from '../styles/palette'
import { PRINT_STOCK } from '../styles/stationery'
import { type PaperShape, paperCorners } from './layering'
import type { Point } from './types'

/**
 * The pencil frame of each of several selected notes, as the overlay draws the one selected
 * note's: an ink line `gap` screen px outside the paper with a cream hairline either side, in
 * the focus ink (`--focus-ring`, indigo's yarn dye) while the note has the keyboard. Screen px
 * throughout, so it is as thick at any zoom. The colours come from the same sources as the CSS
 * tokens `--ink-cream`, `--print-stock` and `--focus-ring` the overlay's frame uses.
 */
export const SELECTION_FRAME = {
  gap: 5,
  width: 1.5,
  /** The cream halo's stroke: the line with 1.5 px of cream outside it and 1 inside. */
  halo: 4.5,
  ink: PALETTE.cream.ink,
  haloInk: PRINT_STOCK,
  focus: yarnColor('indigo'),
} as const

/**
 * Stroke the frame of `shape` (a note's paper as drawn, world px) on `ctx`, which draws in
 * viewport px: the paper's corners grown by `gap` screen px at `zoom`, mapped through `map`.
 */
export function drawSelectionFrame(
  ctx: CanvasRenderingContext2D,
  shape: PaperShape,
  zoom: number,
  map: (p: Point) => Point,
  focused: boolean,
): void {
  const g = (SELECTION_FRAME.gap - SELECTION_FRAME.width / 2) / (zoom > 0 ? zoom : 1)
  const r = shape.rect
  const grown = { ...shape, rect: { x: r.x - g, y: r.y - g, w: r.w + 2 * g, h: r.h + 2 * g } }
  ctx.save()
  ctx.beginPath()
  const corners = paperCorners(grown).map(map)
  for (const [k, c] of corners.entries()) {
    if (k === 0) ctx.moveTo(c.x, c.y)
    else ctx.lineTo(c.x, c.y)
  }
  ctx.closePath()
  ctx.lineJoin = 'round'
  ctx.strokeStyle = SELECTION_FRAME.haloInk
  ctx.lineWidth = SELECTION_FRAME.halo
  ctx.stroke()
  ctx.strokeStyle = focused ? SELECTION_FRAME.focus : SELECTION_FRAME.ink
  ctx.lineWidth = SELECTION_FRAME.width
  ctx.stroke()
  ctx.restore()
}
