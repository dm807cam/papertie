import type { Note } from '@papertie/core'
import type { End, EndsOf, SegmentRef } from './attach'
import type { Camera } from './Camera'
import { SELECTED_SCALE, strandWidthPx } from './drawYarn'
import type { SpatialIndex } from './spatialIndex'
import type { Point } from './types'
import { distanceToPolyline } from './yarnGeometry'

/** Screen px within which a press or hover takes a pin. */
export const PIN_HIT_RADIUS_PX = 10
/** The least screen px from the flattened curve within which a press or hover takes a yarn. */
export const YARN_HIT_TOLERANCE_PX = 6
/** Screen px a press may land outside the drawn cord's edge and still take the yarn. */
export const YARN_HIT_MARGIN_PX = 3

/**
 * How far from a yarn's centre line a press takes it, in screen px: the drawn cord's half-width
 * (`selected`: `SELECTED_SCALE` wider, as drawn) plus `YARN_HIT_MARGIN_PX`, and never under
 * `YARN_HIT_TOLERANCE_PX` (thin strands at low zoom).
 */
export function yarnHitTolerancePx(zoom: number, selected = false): number {
  const w = strandWidthPx(zoom) * (selected ? SELECTED_SCALE : 1)
  return Math.max(YARN_HIT_TOLERANCE_PX, w / 2 + YARN_HIT_MARGIN_PX)
}

/** An edge pin: which segment end it holds. */
export interface EdgePin {
  yarnId: string
  segIndex: number
  end: End
}

/** A pin hit names its note; an edge pin also names the yarn end it holds. */
export type Hit =
  | { kind: 'pin'; noteId: string; edge?: EdgePin }
  | { kind: 'yarn'; yarnId: string; segIndex: number }
  | { kind: 'none' }

const NONE: Hit = { kind: 'none' }

/** What `hitTest` reads. `curveOf` gives a segment's flattened world points at its current sag. */
export interface HitContext {
  camera: Camera
  /** The spatial index, or a view of it (focus mode leaves hidden notes and threads out). */
  index: Pick<SpatialIndex, 'notesIn' | 'segmentsIn'>
  notes: ReadonlyMap<string, Note>
  /** A note's hanging pin. */
  pinOf(noteId: string): Point | undefined
  /** A segment's edge pins. */
  endsOf: EndsOf
  curveOf(ref: SegmentRef): Point[]
  isCovered?(ref: SegmentRef, world: Point): boolean
  /** Lite LOD: edge pins are not drawn, so only hanging pins take a pin hit. */
  lite?: boolean
  /** Segments to test besides the index's, e.g. springs swinging outside their rest bounds. */
  liveSegments?(): Iterable<SegmentRef>
  /** The selected yarn, drawn wider, so its segments take presses further out. */
  selectedYarnId?: string
}

const finite = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y)

/**
 * Paint order of segments: by level (the higher z of their two notes), then yarn id, then index.
 * The runtime draws culled segments in this order, so "drawn later" means a positive result.
 */
export function compareDrawOrder(
  notes: ReadonlyMap<string, Pick<Note, 'z'>>,
): (a: SegmentRef, b: SegmentRef) => number {
  const level = (r: SegmentRef) =>
    Math.max(notes.get(r.aNoteId)?.z ?? 0, notes.get(r.bNoteId)?.z ?? 0)
  return (a, b) => {
    const d = level(a) - level(b)
    if (d !== 0) return d
    if (a.yarnId !== b.yarnId) return a.yarnId < b.yarnId ? -1 : 1
    return a.index - b.index
  }
}

/**
 * What a viewport point lands on. Pins come first, hanging and edge pins alike: of those within
 * `PIN_HIT_RADIUS_PX`, the one on the highest note wins, then the nearest (then the later
 * note id, then the selected thread's end, then the hanging pin: ends tied at one shared pin,
 * or at the hanging pin, are at one point). Edge pins are found through their segments (index plus
 * `liveSegments`), and not at all in `lite` LOD, which does not draw them. Then yarn: segments
 * within `yarnHitTolerancePx` of their flattened curve (the selected yarn's wider, as drawn) and
 * not covered; the nearest wins, and on a tie the one drawn later. Non-finite input gives `none`.
 */
export function hitTest(screen: Point, ctx: HitContext): Hit {
  const { zoom } = ctx.camera
  if (!finite(screen) || !(Number.isFinite(zoom) && zoom > 0)) return NONE
  const w = { x: screen.x / zoom + ctx.camera.x, y: screen.y / zoom + ctx.camera.y }
  if (!finite(w)) return NONE

  const r = PIN_HIT_RADIUS_PX / zoom
  let pin: { id: string; z: number; d: number; rank: number; edge?: EdgePin } | undefined
  // Ends at one point (a shared pin) tie: the selected thread's end, then the hanging pin.
  const rankOf = (edge?: EdgePin) =>
    edge === undefined ? 1 : edge.yarnId === ctx.selectedYarnId ? 2 : 0
  const consider = (id: string, p: Point, edge?: EdgePin) => {
    const n = ctx.notes.get(id)
    if (n === undefined) return
    const d = Math.hypot(p.x - w.x, p.y - w.y)
    if (!(d <= r)) return
    const rank = rankOf(edge)
    const better =
      pin === undefined ||
      n.z > pin.z ||
      (n.z === pin.z &&
        (d < pin.d || (d === pin.d && (id > pin.id || (id === pin.id && rank > pin.rank)))))
    if (better) pin = edge === undefined ? { id, z: n.z, d, rank } : { id, z: n.z, d, rank, edge }
  }
  for (const id of ctx.index.notesIn({ x: w.x - r, y: w.y - r, w: 2 * r, h: 2 * r })) {
    const p = ctx.pinOf(id)
    if (p !== undefined) consider(id, p)
  }

  const tol = yarnHitTolerancePx(zoom) / zoom
  const selectedTol = yarnHitTolerancePx(zoom, true) / zoom
  const tolOf = (ref: SegmentRef) => (ref.yarnId === ctx.selectedYarnId ? selectedTol : tol)
  const reach = Math.max(r, ctx.selectedYarnId === undefined ? tol : selectedTol)
  const refs = new Map<string, SegmentRef>()
  const near = { x: w.x - reach, y: w.y - reach, w: 2 * reach, h: 2 * reach }
  for (const ref of ctx.index.segmentsIn(near)) refs.set(ref.key, ref)
  for (const ref of ctx.liveSegments?.() ?? []) refs.set(ref.key, ref)
  for (const ref of ctx.lite ? [] : refs.values()) {
    const e = ctx.endsOf(ref)
    if (e === undefined) continue
    consider(ref.aNoteId, e.a, { yarnId: ref.yarnId, segIndex: ref.index, end: 'a' })
    consider(ref.bNoteId, e.b, { yarnId: ref.yarnId, segIndex: ref.index, end: 'b' })
  }
  const found = pin as { id: string; edge?: EdgePin } | undefined
  if (found !== undefined) {
    return found.edge === undefined
      ? { kind: 'pin', noteId: found.id }
      : { kind: 'pin', noteId: found.id, edge: found.edge }
  }
  const later = compareDrawOrder(ctx.notes)
  const eps = 1e-6 / zoom
  let best: { ref: SegmentRef; d: number } | undefined
  for (const ref of refs.values()) {
    const d = distanceToPolyline(w, ctx.curveOf(ref))
    if (!(d <= tolOf(ref))) continue
    if (best !== undefined && d > best.d + eps) continue
    if (best !== undefined && d >= best.d - eps && later(ref, best.ref) < 0) continue
    if (ctx.isCovered?.(ref, w)) continue
    best = { ref, d }
  }
  return best === undefined
    ? NONE
    : { kind: 'yarn', yarnId: best.ref.yarnId, segIndex: best.ref.index }
}
