import { ZOOM_MIN } from '../Camera'
import { LOD } from '../lod'
import type { Rect } from '../types'

/**
 * The far-zoom picture pyramid's grid. Level k is rastered at `levelScale(k)`
 * device px per world px (times the DPR) and drawn for zooms in (scale / 2, scale]: shown at
 * most 2× smaller than it was rastered, never larger, so a card is as crisp as the card overview
 * draws it. Level 0 starts where overview ends (`LOD.overview.exitAtOrAbove`, the lite
 * threshold's side of the gap); the last reaches `ZOOM_MIN`.
 * The levels are 2× apart, not 4×: a 4× level is shown up to 4× smaller than rastered, which
 * at DPR 2 is 16 screens of pixels (about 236 MB on a 1280 × 800 viewport), past the cache's
 * 96 MB, and a 4× minification shimmers as it pans. At 2× the visible tiles stay under 4 screens.
 */
export const LEVEL_TOP = LOD.overview.exitAtOrAbove
/** Zoom between one level and the next. */
export const LEVEL_RATIO = 2
/** Enough levels that the last one's range reaches `ZOOM_MIN`. */
export const LEVELS = Math.max(
  1,
  Math.ceil(Math.log(LEVEL_TOP / ZOOM_MIN) / Math.log(LEVEL_RATIO) - 1e-9),
)
/** A tile's side in device px. */
export const TILE_PX = 512
/**
 * How far a card's paint reaches past its paper, in CSS px at the level's reference zoom: the
 * shadow (0.75, 1.25), a pin dot's radius (1.5) and a pixel of antialiasing. A tile draws every
 * card and thread within this of it, and a change dirties what lies within it.
 */
export const REACH_PX = 4

/** Device px per world px (at DPR 1) that level `k` is rastered at. */
export function levelScale(k: number): number {
  return LEVEL_TOP / LEVEL_RATIO ** k
}

/**
 * The zoom level `k`'s screen-size details (shadow offset, pin radius, thread width and opacity)
 * are drawn for: the middle of its range on a log scale, so they are within √2 of the card
 * overview's anywhere in it.
 */
export function levelRefZoom(k: number): number {
  return levelScale(k) / Math.SQRT2
}

/** The level a zoom is drawn from: the coarsest rastered at or above it. */
export function levelFor(zoom: number): number {
  if (!(Number.isFinite(zoom) && zoom > 0)) return 0
  const k = Math.floor(Math.log(LEVEL_TOP / zoom) / Math.log(LEVEL_RATIO) + 1e-9)
  return Math.max(0, Math.min(LEVELS - 1, k))
}

/** World px per side of a level-`k` tile at `dpr`. */
export function tileWorld(k: number, dpr: number): number {
  return TILE_PX / (levelScale(k) * dpr)
}

/** World px a level-`k` tile reaches for what it draws ({@link REACH_PX}). */
export function reachWorld(k: number): number {
  return REACH_PX / levelRefZoom(k)
}

export interface TileId {
  k: number
  tx: number
  ty: number
}

export const tileKey = (k: number, tx: number, ty: number): string => `${k}/${tx}/${ty}`

/** A tile's world rect at `dpr`. */
export function tileRect(t: TileId, dpr: number): Rect {
  const w = tileWorld(t.k, dpr)
  return { x: t.tx * w, y: t.ty * w, w, h: w }
}

/** The level-`k` tiles a world rect touches, as inclusive index ranges. */
export function tileRange(
  k: number,
  dpr: number,
  r: Rect,
): { tx0: number; tx1: number; ty0: number; ty1: number } {
  const w = tileWorld(k, dpr)
  return {
    tx0: Math.floor(r.x / w),
    tx1: Math.floor((r.x + r.w) / w),
    ty0: Math.floor(r.y / w),
    ty1: Math.floor((r.y + r.h) / w),
  }
}
