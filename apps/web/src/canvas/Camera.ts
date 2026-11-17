import type { Point, Rect, Size } from './types'

/** `x, y` is the world point at the viewport's top-left; one world px is `zoom` screen px. */
export interface Camera {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

/**
 * Zoom range. 0.005 shows a 256,000 world px wide board on a 1280 px screen, so fit-all frames a
 * lifetime board (100,000 notes, about 108,000 × 95,000 world px on genBoard's grid) whole; it was
 * 0.02 (64,000 px) until the far-zoom picture pyramid made such a view cheap.
 * 2 is reading distance, the closest the camera goes: zoom is for seeing the bigger picture and
 * moving between clusters, and a note is never zoomed into more than it takes to read it.
 */
export const ZOOM_MIN = 0.005
export const ZOOM_MAX = 2

/** Zoom clamped to [ZOOM_MIN, ZOOM_MAX]; NaN gives 1. */
export function clampZoom(z: number): number {
  if (Number.isNaN(z)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
}

export function worldToScreen(c: Camera, p: Point): Point {
  return { x: (p.x - c.x) * c.zoom, y: (p.y - c.y) * c.zoom }
}

export function screenToWorld(c: Camera, s: Point): Point {
  return { x: s.x / c.zoom + c.x, y: s.y / c.zoom + c.y }
}

/**
 * Zoom to `nextZoom` (clamped) keeping the world point under `screenPt` fixed. A non-finite or
 * non-positive `nextZoom` returns `c` itself.
 */
export function zoomAt(c: Camera, screenPt: Point, nextZoom: number): Camera {
  if (!Number.isFinite(nextZoom) || nextZoom <= 0) return c
  const zoom = clampZoom(nextZoom)
  const w = screenToWorld(c, screenPt)
  const next = { x: w.x - screenPt.x / zoom, y: w.y - screenPt.y / zoom, zoom }
  return Number.isFinite(next.x) && Number.isFinite(next.y) ? next : c
}

/**
 * Move content by a screen-space delta, so it follows the pointer. Non-finite deltas count as 0.
 */
export function panBy(c: Camera, dxScreen: number, dyScreen: number): Camera {
  const dx = Number.isFinite(dxScreen) ? dxScreen : 0
  const dy = Number.isFinite(dyScreen) ? dyScreen : 0
  if (dx === 0 && dy === 0) return c
  const next = { x: c.x - dx / c.zoom, y: c.y - dy / c.zoom, zoom: c.zoom }
  return Number.isFinite(next.x) && Number.isFinite(next.y) ? next : c
}

/** The world rect the viewport shows, grown by `marginPx` screen px on every side. */
export function visibleWorldRect(c: Camera, viewport: Size, marginPx = 0): Rect {
  return {
    x: c.x - marginPx / c.zoom,
    y: c.y - marginPx / c.zoom,
    w: (viewport.width + 2 * marginPx) / c.zoom,
    h: (viewport.height + 2 * marginPx) / c.zoom,
  }
}

/** Screen px `fitRect` leaves around the rect by default. */
export const FIT_PADDING_PX = 64

/**
 * The camera that centres `r` in the viewport with `paddingPx` to spare, at the largest zoom that
 * fits (clamped, and at most `maxZoom`). No rect or an empty one centres the world origin, or the
 * rect, at `maxZoom`.
 */
export function fitRect(
  r: Rect | null,
  viewport: Size,
  paddingPx = FIT_PADDING_PX,
  maxZoom = ZOOM_MAX,
): Camera {
  const whole = { x: 0, y: 0, w: Math.max(0, viewport.width), h: Math.max(0, viewport.height) }
  return fitRectIn(r, whole, paddingPx, maxZoom)
}

/**
 * `fitRect` into `area`, a part of the viewport (screen px: what the app's chrome leaves free,
 * `CanvasRuntime.safeViewport`): `r` centred there with `paddingPx` to spare, at the largest zoom
 * that fits, kept within [`minZoom`, `maxZoom`] (and the camera's range). At the floor a rect too
 * big to fit stays centred, for the user to pan.
 */
export function fitRectIn(
  r: Rect | null,
  area: Rect,
  paddingPx = FIT_PADDING_PX,
  maxZoom = ZOOM_MAX,
  minZoom = ZOOM_MIN,
): Camera {
  const availW = Math.max(1, area.w - 2 * paddingPx)
  const availH = Math.max(1, area.h - 2 * paddingPx)
  const rect = r ?? { x: 0, y: 0, w: 0, h: 0 }
  const fit = Math.min(availW / rect.w, availH / rect.h, maxZoom)
  const zoom = clampZoom(Math.max(Math.min(minZoom, maxZoom), fit))
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  return {
    x: cx - (area.x + area.w / 2) / zoom,
    y: cy - (area.y + area.h / 2) / zoom,
    zoom,
  }
}

/**
 * How far the viewport centre may drift from the render anchor before it is rebased: in world px
 * up to zoom 1 and in screen px above it, so every offset the GPU sees stays under 2^15 px plus
 * a viewport.
 */
export const ANCHOR_REACH_PX = 2 ** 15

/** The anchor every board starts from until its first rebase. */
export const ORIGIN: Point = { x: 0, y: 0 }

/** `v` rounded to the nearest device pixel, in CSS px. */
export function snapToDevice(v: number, dpr: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  return Math.round(v * d) / d
}

/**
 * Floating origin: the layers are drawn relative to an anchor `a` near the camera, so the numbers
 * the compositor sees stay small while the camera and the board keep world doubles. This is the
 * viewport position of `a`, snapped to device pixels: the world layer's translation.
 */
export function anchorScreen(c: Camera, a: Point, dpr: number): Point {
  return { x: snapToDevice((a.x - c.x) * c.zoom, dpr), y: snapToDevice((a.y - c.y) * c.zoom, dpr) }
}

/** The anchor for camera `c`: the viewport centre in whole world px. */
export function anchorFor(c: Camera, viewport: Size): Point {
  return {
    x: Math.round(c.x + viewport.width / 2 / c.zoom),
    y: Math.round(c.y + viewport.height / 2 / c.zoom),
  }
}

/** Whether the viewport centre is past `ANCHOR_REACH_PX` from anchor `a` (or not finite). */
export function needsRebase(c: Camera, viewport: Size, a: Point): boolean {
  const k = Math.max(1, c.zoom)
  const dx = Math.abs(c.x + viewport.width / 2 / c.zoom - a.x) * k
  const dy = Math.abs(c.y + viewport.height / 2 / c.zoom - a.y) * k
  return !(dx <= ANCHOR_REACH_PX && dy <= ANCHOR_REACH_PX)
}

/** World to viewport CSS px, as the anchored world layer draws it. */
export function screenMapper(c: Camera, dpr: number, a: Point = ORIGIN): (p: Point) => Point {
  const o = anchorScreen(c, a, dpr)
  return (p) => ({ x: (p.x - a.x) * c.zoom + o.x, y: (p.y - a.y) * c.zoom + o.y })
}

/**
 * The camera as drawn: `screenMapper(c, dpr, a)` is `worldToScreen` of this camera, so pointer
 * positions map through it to land exactly where things are painted.
 */
export function drawnCamera(c: Camera, dpr: number, a: Point = ORIGIN): Camera {
  const o = anchorScreen(c, a, dpr)
  return { x: a.x - o.x / c.zoom, y: a.y - o.y / c.zoom, zoom: c.zoom }
}

/** CSS transform for the world layer drawn relative to anchor `a`. */
export function cameraTransform(c: Camera, dpr: number, a: Point = ORIGIN): string {
  const o = anchorScreen(c, a, dpr)
  return `translate3d(${o.x}px, ${o.y}px, 0) scale(${c.zoom})`
}
