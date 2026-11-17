import { type Camera, visibleWorldRect } from './Camera'
import type { Rect, Size } from './types'

/**
 * The cull rect grows the viewport by `marginFrac` of its larger side. A recull is due once the
 * view has panned `recullMoveFrac` of the viewport or zoomed past `recullZoomRatio` either way.
 */
export const CULL = { marginFrac: 0.5, recullMoveFrac: 0.25, recullZoomRatio: 1.1 } as const

/** World rect whose notes and yarn are mounted and drawn. */
export function cullRect(c: Camera, viewport: Size): Rect {
  return visibleWorldRect(c, viewport, CULL.marginFrac * Math.max(viewport.width, viewport.height))
}

/** Whether the camera has left the area the last cull (if any) covered with room to spare. */
export function needsRecull(
  last: { c: Camera; viewport: Size } | null,
  c: Camera,
  viewport: Size,
): boolean {
  if (last === null) return true
  if (last.viewport.width !== viewport.width || last.viewport.height !== viewport.height) {
    return true
  }
  const ratio = c.zoom / last.c.zoom
  if (!(ratio <= CULL.recullZoomRatio && ratio >= 1 / CULL.recullZoomRatio)) return true
  const dx = Math.abs(c.x - last.c.x) * c.zoom
  const dy = Math.abs(c.y - last.c.y) * c.zoom
  if (!(dx <= CULL.recullMoveFrac * viewport.width)) return true
  return !(dy <= CULL.recullMoveFrac * viewport.height)
}

/**
 * Note ids in paint order: by z, then id (an id with no note counts as z 0). The keys are read
 * once per id rather than inside the comparator, which keeps a 5,000-note cull at a few ms.
 */
export function inPaintOrder(
  ids: readonly string[],
  notes: ReadonlyMap<string, { readonly z: number }>,
): string[] {
  const zs = ids.map((id) => notes.get(id)?.z ?? 0)
  const order = ids.map((_, k) => k)
  order.sort((a, b) => {
    const dz = (zs[a] as number) - (zs[b] as number)
    if (dz !== 0) return dz
    const ia = ids[a] as string
    const ib = ids[b] as string
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })
  return order.map((k) => ids[k] as string)
}
