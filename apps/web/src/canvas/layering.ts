import { LIMITS, type Note } from '@papertie/core'
import type { EndsOf, SegmentRef } from './attach'
import type { Point, Rect } from './types'
import { polylineLength, sliceByLength } from './yarnGeometry'

/** Where yarn paints relative to the notes: above, above with covered spans erased, or below. */
export type LayerMode = 'over' | 'over-fix' | 'under'

/**
 * World px of thread drawn on the pin layer at each end of a segment in `under`: across the
 * edge pin's inset (`EDGE_PIN.inset`) to the paper's edge and a little past it.
 */
export const PIN_STUB_WORLD = 24

/** A note's paper as drawn: its rect turned `deg` (CSS, clockwise on screen) about `pivot`. */
export interface PaperShape {
  rect: Rect
  pivot: Point
  deg: number
}

const finite = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y)

/** True when the segment a-b touches the closed rect `r` (Liang-Barsky clipping). */
function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  return (
    clip(-dx, a.x - r.x) &&
    clip(dx, r.x + r.w - a.x) &&
    clip(-dy, a.y - r.y) &&
    clip(dy, r.y + r.h - a.y)
  )
}

/** Whether a world polyline touches the closed rect `r`. Non-finite points are skipped. */
export function polylineIntersectsRect(pts: readonly Point[], r: Rect): boolean {
  let prev: Point | undefined
  for (const p of pts) {
    if (!finite(p)) {
      prev = undefined
      continue
    }
    if (prev === undefined) {
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return true
    } else if (segmentHitsRect(prev, p, r)) return true
    prev = p
  }
  return false
}

/**
 * Notes that cover part of a segment: higher than both its notes (`z > max(a.z, b.z)`) and with
 * a rect its polyline crosses. Its own notes are never listed.
 */
export function segmentOccluders(
  seg: { aNote: Note; bNote: Note; pts: readonly Point[] },
  candidates: readonly Note[],
  rectOf: (n: Note) => Rect,
): string[] {
  const level = Math.max(seg.aNote.z, seg.bNote.z)
  const out: string[] = []
  for (const n of candidates) {
    if (n.id === seg.aNote.id || n.id === seg.bNote.id || !(n.z > level)) continue
    if (out.includes(n.id)) continue
    if (polylineIntersectsRect(seg.pts, rectOf(n))) out.push(n.id)
  }
  return out
}

export type DrawItem = { kind: 'segment'; key: string } | { kind: 'erase'; noteId: string }

/**
 * Paint order for `over-fix`: segments by level (`max(z_a, z_b)`), with each occluding note
 * erased once, after every segment below its z and before every segment at or above it. Ties
 * keep input order.
 */
export function buildDrawList(
  segs: ReadonlyArray<{ key: string; level: number; occluders: readonly string[] }>,
  zOf: (noteId: string) => number,
): DrawItem[] {
  const sorted = segs.map((s, i) => ({ s, i })).sort((a, b) => a.s.level - b.s.level || a.i - b.i)
  const seen = new Set<string>()
  const erases: Array<{ id: string; z: number; i: number }> = []
  for (const { s } of sorted) {
    for (const id of s.occluders) {
      if (seen.has(id)) continue
      seen.add(id)
      erases.push({ id, z: zOf(id), i: erases.length })
    }
  }
  erases.sort((a, b) => a.z - b.z || a.i - b.i)
  const out: DrawItem[] = []
  let e = 0
  for (const { s } of sorted) {
    while (e < erases.length && (erases[e] as { z: number }).z <= s.level) {
      out.push({ kind: 'erase', noteId: (erases[e] as { id: string }).id })
      e++
    }
    out.push({ kind: 'segment', key: s.key })
  }
  for (; e < erases.length; e++)
    out.push({ kind: 'erase', noteId: (erases[e] as { id: string }).id })
  return out
}

/** `p` in the unturned frame of `s`'s rect. */
function unturned(s: PaperShape, p: Point): Point {
  const a = rad(s.deg)
  const dx = p.x - s.pivot.x
  const dy = p.y - s.pivot.y
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return { x: s.pivot.x + dx * cos + dy * sin, y: s.pivot.y - dx * sin + dy * cos }
}

/** The spans of a polyline over the paper, by length along it from its first point. */
function spansOver(pts: readonly Point[], paper: PaperShape): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const r = paper.rect
  let at = 0
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k - 1] as Point
    const q = pts[k] as Point
    const len = Math.hypot(q.x - p.x, q.y - p.y)
    if (!(len > 0)) continue
    const a = unturned(paper, p)
    const b = unturned(paper, q)
    // Liang-Barsky: the part [t0, t1] of a-b inside the rect.
    let t0 = 0
    let t1 = 1
    const dx = b.x - a.x
    const dy = b.y - a.y
    const inside = [
      [-dx, a.x - r.x],
      [dx, r.x + r.w - a.x],
      [-dy, a.y - r.y],
      [dy, r.y + r.h - a.y],
    ].every(([pp, qq]) => {
      const pv = pp as number
      const qv = qq as number
      if (pv === 0) return qv >= 0
      const t = qv / pv
      if (pv < 0) t0 = Math.max(t0, t)
      else t1 = Math.min(t1, t)
      return t0 <= t1
    })
    if (inside && t1 > t0) {
      const span: [number, number] = [at + t0 * len, at + t1 * len]
      const last = out.at(-1)
      if (last !== undefined && span[0] - last[1] < 1e-9) last[1] = span[1]
      else out.push(span)
    }
    at += len
  }
  return out
}

/**
 * The runs of a strand that show when it is tied at the hanging pin of a note at either end
 * (`start`: the note of its first point, `end`: of its last) and lies beneath that note's paper
 * there: past a `PIN_STUB_WORLD` stub at the pin, what crosses its own paper is hidden, so the
 * note's text stays clear. The strand whole (one run) when nothing is hidden.
 */
export function strandOverPaper(
  pts: readonly Point[],
  own: { start?: PaperShape; end?: PaperShape },
): Point[][] {
  const total = polylineLength(pts)
  const hidden: Array<[number, number]> = []
  if (own.start) {
    for (const [a, b] of spansOver(pts, own.start)) {
      if (b > PIN_STUB_WORLD) hidden.push([Math.max(a, PIN_STUB_WORLD), b])
    }
  }
  if (own.end) {
    for (const [a, b] of spansOver(pts, own.end)) {
      if (a < total - PIN_STUB_WORLD) hidden.push([a, Math.min(b, total - PIN_STUB_WORLD)])
    }
  }
  if (hidden.length === 0) return [pts as Point[]]
  hidden.sort((x, y) => x[0] - y[0])
  const runs: Point[][] = []
  let from = 0
  for (const [a, b] of hidden) {
    if (a > from + 1e-6) runs.push(sliceByLength(pts, from, a))
    from = Math.max(from, b)
  }
  if (total > from + 1e-6) runs.push(sliceByLength(pts, from, total))
  return runs
}

/**
 * Whether world point `p` on a strand tied at a note's hanging pin `pin` lies beneath that note's
 * own paper (`strandOverPaper`), so a press there is the note's.
 */
export function underOwnPaper(p: Point, pin: Point, paper: PaperShape): boolean {
  return Math.hypot(p.x - pin.x, p.y - pin.y) > PIN_STUB_WORLD && paperContains(paper, p)
}

/** The first and last `PIN_STUB_WORLD` of a polyline; each is half of it when it is shorter. */
export function pinStubs(pts: readonly Point[]): { start: Point[]; end: Point[] } {
  const total = polylineLength(pts)
  const s = Math.min(PIN_STUB_WORLD, total / 2)
  return { start: sliceByLength(pts, 0, s), end: sliceByLength(pts, total - s, total) }
}

const rad = (deg: number) => (Number.isFinite(deg) ? (deg * Math.PI) / 180 : 0)

/** The paper's four corners in world px, clockwise from top-left. */
export function paperCorners(s: PaperShape): Point[] {
  const a = rad(s.deg)
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const { x, y, w, h } = s.rect
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ].map((p) => {
    const dx = p.x - s.pivot.x
    const dy = p.y - s.pivot.y
    return { x: s.pivot.x + dx * cos - dy * sin, y: s.pivot.y + dx * sin + dy * cos }
  })
}

/** Axis-aligned bounds of the turned paper. */
export function paperBounds(s: PaperShape): Rect {
  if (rad(s.deg) === 0) return s.rect
  const cs = paperCorners(s)
  const xs = cs.map((p) => p.x)
  const ys = cs.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** Whether world point `p` lies on the turned paper (edges included). */
export function paperContains(s: PaperShape, p: Point): boolean {
  const a = rad(s.deg)
  const dx = p.x - s.pivot.x
  const dy = p.y - s.pivot.y
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const x = s.pivot.x + dx * cos + dy * sin
  const y = s.pivot.y - dx * sin + dy * cos
  const r = s.rect
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

/**
 * How far a paper up to `w` × `h` (the board's note limits by default), turned up to `maxDeg`
 * about a point inside it, can reach past its unturned rect: the pad a rect query needs.
 */
export function tiltReach(
  maxDeg: number,
  w: number = LIMITS.noteMaxW,
  h: number = LIMITS.noteMaxH,
): number {
  return Math.ceil(2 * Math.hypot(w, h) * Math.sin(Math.abs(rad(maxDeg)) / 2))
}

/** The topmost of `notes` (by z, then id) whose turned paper contains world point `p`. */
export function topPaperAt<N extends Pick<Note, 'id' | 'z'>>(
  p: Point,
  notes: Iterable<N>,
  shapeOf: (n: N) => PaperShape,
): N | undefined {
  if (!finite(p)) return undefined
  let top: N | undefined
  for (const n of notes) {
    if (!paperContains(shapeOf(n), p)) continue
    if (top === undefined || n.z > top.z || (n.z === top.z && n.id > top.id)) top = n
  }
  return top
}

/** What `coveredTest` reads. `angleOf` (degrees, about the note's pin) defaults to 0. */
export interface CoverContext {
  notes: ReadonlyMap<string, Note>
  /** Notes that may contain a world point (e.g. from the spatial index); all notes when absent. */
  notesAt?(world: Point): Iterable<string>
  rectOf(n: Note): Rect
  angleOf?(n: Note): number
  occludersOf(ref: SegmentRef): readonly string[]
  /** A note's hanging pin, which its paper turns about. */
  pinOf(noteId: string): Point | undefined
  /** The segment's edge pins, where its stubs are drawn above the paper in `under`. */
  endsOf: EndsOf
}

/**
 * Whether a world point on a segment is hidden by paper, so a press there goes to the note:
 * never in `over`; in `over-fix` inside one of the segment's occluders; in `under` inside any
 * note, except within `PIN_STUB_WORLD` of either of the segment's edge pins.
 */
export function coveredTest(
  mode: LayerMode,
  ctx: CoverContext,
): (ref: SegmentRef, world: Point) => boolean {
  const on = (n: Note, p: Point) => {
    const pivot = ctx.pinOf(n.id)
    const deg = pivot === undefined ? 0 : (ctx.angleOf?.(n) ?? 0)
    return paperContains({ rect: ctx.rectOf(n), pivot: pivot ?? { x: 0, y: 0 }, deg }, p)
  }
  if (mode === 'over') return () => false
  if (mode === 'over-fix') {
    return (ref, p) =>
      ctx.occludersOf(ref).some((id) => {
        const n = ctx.notes.get(id)
        return n !== undefined && on(n, p)
      })
  }
  return (ref, p) => {
    const e = ctx.endsOf(ref)
    for (const pin of e === undefined ? [] : [e.a, e.b]) {
      if (Math.hypot(pin.x - p.x, pin.y - p.y) <= PIN_STUB_WORLD) return false
    }
    for (const id of ctx.notesAt?.(p) ?? ctx.notes.keys()) {
      const n = ctx.notes.get(id)
      if (n !== undefined && on(n, p)) return true
    }
    return false
  }
}
