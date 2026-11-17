import {
  asPMap,
  type BoardState,
  mapChangesWithin,
  type Note,
  type PinKey,
  PMap,
  type TransientMap,
  type Yarn,
} from '@papertie/core'
import { noteRotationDeg } from '../lib/seed'
import { noteBounds, pinPosition } from './geometry'
import type { Point, Rect } from './types'
import { segmentKey } from './yarnGeometry'

/** One drawn segment of a yarn: between its `index`-th and next present note. */
export interface SegmentRef {
  key: string
  yarnId: string
  index: number
  aNoteId: string
  bNoteId: string
}

export type Edge = 'top' | 'right' | 'bottom' | 'left'
export type End = 'a' | 'b'

/**
 * Edge-pin placement in world px: how far a pin sits inside the paper, its least distance from
 * a corner along the edge, the least spacing between pins on one edge, and the half-width kept
 * clear around the hanging pin on the top edge.
 */
export const EDGE_PIN = { inset: 14, corner: 26, gap: 24, topGap: 28 } as const

/** A note as attachment sees it: the unturned rect (displayed height), its pin and its tilt. */
export interface AttachFrame {
  rect: Rect
  /** The hanging pin, which the paper turns about. */
  pivot: Point
  /** Degrees, clockwise on screen. */
  deg: number
}

const rad = (deg: number) => (Number.isFinite(deg) ? (deg * Math.PI) / 180 : 0)
const finiteN = (n: number, fallback = 0) => (Number.isFinite(n) ? n : fallback)

/** `p` turned `a` radians about `o`. */
function turn(p: Point, o: Point, a: number): Point {
  if (a === 0) return p
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dx = p.x - o.x
  const dy = p.y - o.y
  return { x: o.x + dx * c - dy * s, y: o.y + dx * s + dy * c }
}

/** `toward` in the frame's unturned coordinates. */
const local = (f: AttachFrame, toward: Point) => turn(toward, f.pivot, -rad(f.deg))

const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/** The edge, and the exit point's coordinate along it, of the ray from the centre to `t`. */
function exitOf(r: Rect, t: Point): { edge: Edge; s: number } {
  const c = centre(r)
  const dx = t.x - c.x
  const dy = t.y - c.y
  const w = Math.max(r.w, 1e-9)
  const h = Math.max(r.h, 1e-9)
  if (!(Number.isFinite(dx) && Number.isFinite(dy)) || (dx === 0 && dy === 0)) {
    return { edge: 'right', s: c.y }
  }
  if (Math.abs(dx) * h >= Math.abs(dy) * w) {
    const s = c.y + finiteN((dy * (w / 2)) / Math.abs(dx))
    return { edge: dx > 0 ? 'right' : 'left', s }
  }
  const s = c.x + finiteN((dx * (h / 2)) / Math.abs(dy))
  return { edge: dy > 0 ? 'bottom' : 'top', s }
}

/** The edge of the note facing `toward`: the one the ray from its centre leaves through. */
export function facingEdge(f: AttachFrame, toward: Point): Edge {
  return exitOf(f.rect, local(f, toward)).edge
}

/**
 * Positions along a line for ideals sorted ascending: each clamped to [lo, hi], at least `gap`
 * apart in order; when they cannot fit, evenly from lo to hi.
 */
function spread(ideals: readonly number[], lo: number, hi: number, gap: number): number[] {
  const n = ideals.length
  if (n === 0) return []
  if (!(hi >= lo)) return ideals.map(() => (lo + hi) / 2)
  if (n === 1) return [Math.min(hi, Math.max(lo, ideals[0] as number))]
  if ((n - 1) * gap > hi - lo) return ideals.map((_, i) => lo + ((hi - lo) * i) / (n - 1))
  const out = ideals.map((v) => Math.min(hi, Math.max(lo, v)))
  for (let i = 1; i < n; i++) out[i] = Math.max(out[i] as number, (out[i - 1] as number) + gap)
  if ((out[n - 1] as number) > hi) {
    out[n - 1] = hi
    for (let i = n - 2; i >= 0; i--)
      out[i] = Math.min(out[i] as number, (out[i + 1] as number) - gap)
  }
  return out
}

/** `spread` along [lo, hi] with the interval (h0, h1) kept clear: ends snap to its nearer side. */
function spreadAround(
  ideals: readonly number[],
  lo: number,
  hi: number,
  h0: number,
  h1: number,
): number[] {
  const a = Math.max(lo, h0)
  const b = Math.min(hi, h1)
  const width = b - a
  if (!(width > 0) || hi - lo - width < 0) return spread(ideals, lo, hi, EDGE_PIN.gap)
  const mid = (a + b) / 2
  // Collapse the hole to a point; the right side sits just past it so it maps back right.
  const u = ideals.map((s) => (s <= a ? s : s >= b ? s - width : s <= mid ? a : a + 1e-6))
  const order = u.map((_, i) => i).sort((i, j) => (u[i] as number) - (u[j] as number))
  const placed = spread(
    order.map((i) => u[i] as number),
    lo,
    hi - width,
    EDGE_PIN.gap,
  )
  const out = new Array<number>(ideals.length)
  order.forEach((i, k) => {
    const v = placed[k] as number
    out[i] = v <= a ? v : v + width
  })
  return out
}

/**
 * Where each yarn end on one note attaches, in world px: on the edge facing its neighbour
 * (`toward`, usually the neighbour's centre), where the ray from the note's centre leaves it,
 * moved `EDGE_PIN.inset` into the paper and kept `EDGE_PIN.corner` from the corners. Ends on one
 * edge are ordered by that exit point (ties by id), so threads leave without crossing, and kept
 * `EDGE_PIN.gap` apart (evenly spread when the edge is too short); top-edge ends stay clear of
 * the hanging pin. Everything is computed unturned and then turned with the note about its pin.
 * Total: every output is finite for finite rects, whatever the neighbours.
 */
export function attachPoints(
  f: AttachFrame,
  ends: ReadonlyArray<{ id: string; toward: Point }>,
): Map<string, Point> {
  const r = f.rect
  const groups = new Map<Edge, Array<{ id: string; s: number }>>()
  for (const e of ends) {
    const x = exitOf(r, local(f, e.toward))
    let g = groups.get(x.edge)
    if (g === undefined) {
      g = []
      groups.set(x.edge, g)
    }
    g.push({ id: e.id, s: x.s })
  }
  const out = new Map<string, Point>()
  const a = rad(f.deg)
  const { inset, corner } = EDGE_PIN
  for (const [edge, g] of groups) {
    g.sort((p, q) => p.s - q.s || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))
    const along = edge === 'top' || edge === 'bottom'
    const lo = (along ? r.x : r.y) + corner
    const hi = (along ? r.x + r.w : r.y + r.h) - corner
    const ideals = g.map((p) => p.s)
    const placed =
      edge === 'top'
        ? spreadAround(ideals, lo, hi, f.pivot.x - EDGE_PIN.topGap, f.pivot.x + EDGE_PIN.topGap)
        : spread(ideals, lo, hi, EDGE_PIN.gap)
    g.forEach((p, k) => {
      const s = placed[k] as number
      const pt =
        edge === 'top'
          ? { x: s, y: r.y + inset }
          : edge === 'bottom'
            ? { x: s, y: r.y + r.h - inset }
            : edge === 'left'
              ? { x: r.x + inset, y: s }
              : { x: r.x + r.w - inset, y: s }
      out.set(p.id, turn(pt, f.pivot, a))
    })
  }
  return out
}

/** The thread's segments in order, between consecutive notes `has` accepts. */
export function segmentRefs(yarn: Pick<Yarn, 'id' | 'noteIds'>, has: (id: string) => boolean) {
  const out: SegmentRef[] = []
  let prev: string | undefined
  for (const noteId of yarn.noteIds) {
    if (!has(noteId)) continue
    if (prev !== undefined) {
      out.push({
        key: segmentKey(yarn.id, prev, noteId),
        yarnId: yarn.id,
        index: out.length,
        aNoteId: prev,
        bNoteId: noteId,
      })
    }
    prev = noteId
  }
  return out
}

/** The pin key that ties an end at the note's own hanging pin. */
export const HANGING = 'hanging' satisfies PinKey

/**
 * The key of the pin that thread `yarnId`'s end on a note has when other threads are tied at it:
 * it names that end (`'a'`, toward the thread's next note; `'b'`, toward its previous one),
 * which goes on placing the pin, so a pin stays put whatever joins it.
 */
export function anchorKey(yarnId: string, end: End): PinKey {
  return `y${yarnId.slice(yarnId.indexOf('_') + 1)}${end === 'a' ? 'n' : 'p'}`
}

const ANCHOR_KEY = /^y([0-9A-HJKMNP-TV-Z]{26})([np])$/

/** The end an anchor key names, if it is one. */
function anchorOf(key: PinKey): { yarnId: string; end: End } | undefined {
  const m = ANCHOR_KEY.exec(key)
  return m ? { yarnId: `yarn_${m[1]}`, end: m[2] === 'n' ? 'a' : 'b' } : undefined
}

/**
 * One yarn end on a note: its segment, which end, the note at the other end and, when it is tied
 * at a shared pin, that pin's key (`yarn.pins`).
 */
export interface NoteEnd {
  ref: SegmentRef
  end: End
  other: string
  pin?: PinKey
}

/**
 * Every drawn segment by yarn and every yarn end by note: persistent maps, so a topology made
 * from another by an edit shares everything the edit left alone.
 */
export interface Topology {
  byYarn: ReadonlyMap<string, readonly SegmentRef[]>
  /** Each note's yarn ends, in a fixed order: by yarn id, then segment, then end. */
  byNote: ReadonlyMap<string, readonly NoteEnd[]>
  /** The threads naming each note, whether or not the note is on the board. */
  yarnsOf: ReadonlyMap<string, readonly string[]>
  segments: number
}

/** What a topology is made from: which notes are on the board, and the threads. */
export type TopologyBoard = Pick<BoardState, 'notes' | 'yarns'>

/** Topologies by yarn map, then note map. */
const topologies = new WeakMap<object, WeakMap<object, Topology>>()

const memoOf = (s: TopologyBoard): Topology | undefined => topologies.get(s.yarns)?.get(s.notes)

/**
 * Keep `topo` as `s`'s, and `s` among the boards made last of its kind: `advanced` (the canvas's
 * own boards, made by `advanceTopology`) or `looked` (any other asked of `topologyOf`: the store's
 * board, which differs from the canvas's while it catches up). Two lists, so the canvas's steps
 * never push the store's board out.
 */
function remember(s: TopologyBoard, topo: Topology, kind: 'advanced' | 'looked'): Topology {
  let byNotes = topologies.get(s.yarns)
  if (byNotes === undefined) {
    byNotes = new WeakMap()
    topologies.set(s.yarns, byNotes)
  }
  byNotes.set(s.notes, topo)
  const list = recent[kind]
  recent[kind] = [new WeakRef(s), ...list.filter((r) => r.deref() !== s)].slice(0, RECENT)
  return topo
}

/**
 * The boards whose topologies were made last, newest first, of each kind, held weakly (a board
 * let go is not kept alive for this): a board's next version is made from the one it shares its
 * maps with, by what changed.
 */
const recent: Record<'advanced' | 'looked', Array<WeakRef<TopologyBoard>>> = {
  advanced: [],
  looked: [],
}
const RECENT = 4

/** How many topologies were built from scratch (for tests: a whole-board cost). */
export const topologyStats = { built: 0 }

/** At most this many records changed since the topology made last: made from it, not anew. */
const ADVANCE_WITHIN = 256

const endOn = (ref: SegmentRef, end: End, other: string, pin: PinKey | undefined): NoteEnd =>
  pin === undefined ? { ref, end, other } : { ref, end, other, pin }

/** The order of a note's ends: by yarn id (time-ordered), then segment, then end. */
const endOrder = (x: NoteEnd, y: NoteEnd) =>
  x.ref.yarnId < y.ref.yarnId
    ? -1
    : x.ref.yarnId > y.ref.yarnId
      ? 1
      : x.ref.index - y.ref.index || (x.end < y.end ? -1 : x.end > y.end ? 1 : 0)

/** A yarn's segments and the ends they put on its notes. */
function yarnEnds(yarn: Yarn, has: (id: string) => boolean) {
  const refs = segmentRefs(yarn, has)
  const ends: Array<[string, NoteEnd]> = []
  const pinOf = (noteId: string) => yarn.pins?.[noteId]
  for (const ref of refs) {
    ends.push([ref.aNoteId, endOn(ref, 'a', ref.bNoteId, pinOf(ref.aNoteId))])
    ends.push([ref.bNoteId, endOn(ref, 'b', ref.aNoteId, pinOf(ref.bNoteId))])
  }
  return { refs, ends }
}

/** The board's topology from scratch: O(threads + their notes). */
export function buildTopology(s: TopologyBoard): Topology {
  topologyStats.built++
  const byYarn = PMap.sized<string, readonly SegmentRef[]>(s.yarns.size).asTransient()
  const byNote = new Map<string, NoteEnd[]>()
  const yarnsOf = new Map<string, string[]>()
  let segments = 0
  const has = (id: string) => s.notes.has(id)
  for (const yarn of s.yarns.values()) {
    const { refs, ends } = yarnEnds(yarn, has)
    byYarn.set(yarn.id, refs)
    segments += refs.length
    for (const [noteId, e] of ends) {
      const list = byNote.get(noteId)
      if (list === undefined) byNote.set(noteId, [e])
      else list.push(e)
    }
    for (const noteId of new Set(yarn.noteIds)) {
      const list = yarnsOf.get(noteId)
      if (list === undefined) yarnsOf.set(noteId, [yarn.id])
      else list.push(yarn.id)
    }
  }
  for (const list of byNote.values()) if (list.length > 1) list.sort(endOrder)
  return {
    byYarn: byYarn.persist(),
    byNote: PMap.from<string, readonly NoteEnd[]>(byNote),
    yarnsOf: PMap.from<string, readonly string[]>(yarnsOf),
    segments,
  }
}

/**
 * `base`, the topology of `prev`, brought to `next` by what changed between them: the threads
 * `yarns` (added, changed or removed) and the notes `notes` (only those that came or went
 * matter). Every other record must be the same in both. O(changed threads and their notes).
 */
function derive(
  base: Topology,
  prev: TopologyBoard,
  next: TopologyBoard,
  notes: Iterable<string>,
  yarns: Iterable<string>,
): Topology {
  const affected = new Set<string>()
  let yarnsOf: TransientMap<string, readonly string[]> | null = null
  for (const id of yarns) {
    const before = prev.yarns.get(id)
    const after = next.yarns.get(id)
    if (before === after) continue
    affected.add(id)
    const was = new Set(before?.noteIds)
    const is = new Set(after?.noteIds)
    if (was.size === is.size && [...was].every((n) => is.has(n))) continue
    yarnsOf ??= asPMap(base.yarnsOf).asTransient()
    for (const n of was) {
      if (is.has(n)) continue
      const left = (yarnsOf.get(n) ?? []).filter((y) => y !== id)
      if (left.length > 0) yarnsOf.set(n, left)
      else yarnsOf.delete(n)
    }
    for (const n of is) if (!was.has(n)) yarnsOf.set(n, [...(yarnsOf.get(n) ?? []), id])
  }
  const named = yarnsOf ?? base.yarnsOf
  for (const id of notes) {
    if (prev.notes.has(id) === next.notes.has(id)) continue
    for (const y of named.get(id) ?? []) affected.add(y)
  }
  const ofYarns = yarnsOf === null ? base.yarnsOf : yarnsOf.persist()
  if (affected.size === 0) return ofYarns === base.yarnsOf ? base : { ...base, yarnsOf: ofYarns }
  const byYarn = asPMap(base.byYarn).asTransient()
  const byNote = asPMap(base.byNote).asTransient()
  /** Working copies of the ends lists this change rewrites. */
  const lists = new Map<string, NoteEnd[]>()
  const listOf = (noteId: string) => {
    let list = lists.get(noteId)
    if (list === undefined) {
      list = [...(byNote.get(noteId) ?? [])]
      lists.set(noteId, list)
    }
    return list
  }
  let segments = base.segments
  const has = (id: string) => next.notes.has(id)
  for (const id of affected) {
    const old = byYarn.get(id) ?? []
    for (const ref of old) {
      for (const noteId of [ref.aNoteId, ref.bNoteId]) {
        const list = listOf(noteId)
        lists.set(
          noteId,
          list.filter((e) => e.ref.yarnId !== id),
        )
      }
    }
    segments -= old.length
    const yarn = next.yarns.get(id)
    if (yarn === undefined) {
      byYarn.delete(id)
      continue
    }
    const { refs, ends } = yarnEnds(yarn, has)
    byYarn.set(id, refs)
    segments += refs.length
    for (const [noteId, e] of ends) listOf(noteId).push(e)
  }
  for (const [noteId, list] of lists) {
    if (list.length === 0) byNote.delete(noteId)
    else byNote.set(noteId, list.length > 1 ? list.sort(endOrder) : list)
  }
  return { byYarn: byYarn.persist(), byNote: byNote.persist(), yarnsOf: ofYarns, segments }
}

/**
 * The board's segments and yarn ends; memoised on the yarn and note maps. A board one of the
 * boards whose topologies were made last can reach by a few changes (the next version of the same
 * board) is made from it, in what changed; any other is built anew.
 */
export function topologyOf(s: TopologyBoard): Topology {
  const hit = memoOf(s)
  if (hit !== undefined) return hit
  // Two versions of one board share their persistent maps; any other pair would be walked.
  const persistent = (b: TopologyBoard) => b.notes instanceof PMap && b.yarns instanceof PMap
  if (persistent(s)) {
    for (const ref of [...recent.looked, ...recent.advanced]) {
      const last = ref.deref()
      const topo = last && memoOf(last)
      if (last === undefined || topo === undefined || !persistent(last)) continue
      const yarns = mapChangesWithin(last.yarns, s.yarns, ADVANCE_WITHIN)
      const notes = yarns && mapChangesWithin(last.notes, s.notes, ADVANCE_WITHIN)
      if (yarns === null || notes === null) continue
      const changed = {
        notes: [...notes.set, ...notes.deleted],
        yarns: [...yarns.set, ...yarns.deleted],
      }
      return remember(s, derive(topo, last, s, changed.notes, changed.yarns), 'looked')
    }
  }
  return remember(s, buildTopology(s), 'looked')
}

/**
 * The topology of `next`, made from `prev`'s by what changed between them (`notes`, `yarns`:
 * the ids added, changed or removed; every other record is the same in both). O(changed).
 */
export function advanceTopology(
  prev: TopologyBoard,
  next: TopologyBoard,
  changed: { notes: Iterable<string>; yarns: Iterable<string> },
): Topology {
  const hit = memoOf(next)
  if (hit !== undefined) return hit
  const base = memoOf(prev)
  if (base === undefined) return topologyOf(next)
  return remember(next, derive(base, prev, next, changed.notes, changed.yarns), 'advanced')
}

/**
 * Take `topo` as `s`'s topology: made for a board whose notes and threads are the same as `s`'s
 * (a board caught up with `s` a slice at a time), so `s` is never built anew.
 */
export function adoptTopology(s: TopologyBoard, topo: Topology): void {
  remember(s, topo, 'advanced')
}

/** The notes plus every note sharing a segment with one of them. */
export function withNeighbours(topo: Topology, noteIds: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const id of noteIds) {
    out.add(id)
    for (const e of topo.byNote.get(id) ?? []) out.add(e.other)
  }
  return out
}

/** Both ends of a segment in world px; undefined when either note is gone. */
export type EndsOf = (ref: SegmentRef) => { a: Point; b: Point } | undefined

/** A note's attach frame by id; undefined for an unknown note. */
export type FrameOf = (noteId: string) => AttachFrame | undefined

/**
 * Frames for the board's notes as drawn: through `effective` (gesture overrides), at the
 * displayed height (`heightOf`, default the stored h) and, with `rotation`, at the seeded tilt.
 */
export function boardFrames(
  notes: ReadonlyMap<string, Note>,
  o: { rotation: boolean; heightOf?: (n: Note) => number; effective?: (n: Note) => Note },
): FrameOf {
  return (id) => {
    const stored = notes.get(id)
    if (stored === undefined) return undefined
    const n = o.effective ? o.effective(stored) : stored
    return {
      rect: noteBounds(n, o.heightOf?.(n)),
      pivot: pinPosition(n),
      deg: o.rotation ? noteRotationDeg(n) : 0,
    }
  }
}

/** Resolves yarn ends to world points; each note's ends are computed once and kept. */
export interface Attach {
  /** Where one end of a segment attaches; undefined when its note is gone. */
  point(ref: SegmentRef, end: End): Point | undefined
  /** Both ends of a segment; undefined when either note is gone. */
  ends(ref: SegmentRef): { a: Point; b: Point } | undefined
  /** Where a new thread from `towardNoteId` would attach on `noteId` (a new edge pin). */
  preview(noteId: string, towardNoteId: string): Point | undefined
  /**
   * The pin an end is tied at, when it is not its own edge pin: null for the note's hanging pin,
   * else an id that every end tied at that same pin shares. Undefined for an edge pin of its own
   * (or a gone note).
   */
  sharedPin(ref: SegmentRef, end: End): string | null | undefined
}

const endId = (ref: SegmentRef, end: End) => `${ref.yarnId}#${ref.index}${end}`

/** Whether end `x` was tied before end `y`: by yarn id (time-ordered), then place. */
const earlier = (x: NoteEnd, y: NoteEnd) =>
  x.ref.yarnId !== y.ref.yarnId
    ? x.ref.yarnId < y.ref.yarnId
    : x.ref.index !== y.ref.index
      ? x.ref.index < y.ref.index
      : x.end < y.end

/** One note's ends: where each attaches, and the shared pin of those tied at one. */
interface NoteAttach {
  points: Map<string, Point>
  shared: Map<string, string | null>
}

/**
 * Edge-pin attachment over a topology and note frames. Results are memoised per note, so make a
 * new one whenever a frame or the topology changes (per frame while anything moves).
 *
 * Shared pins (`NoteEnd.pin`): the ends on a note with one key are tied at one pin, placed where
 * its lead end alone would be: the end its key names ({@link anchorKey}), else the earliest. The
 * lead's thread's other end on the note (a thread through it) still takes its old place on the
 * edges, unseen, so nothing on the note moves when ends join a pin. `'hanging'` ends are tied at
 * the note's hanging pin.
 */
export function createAttach(topo: Topology, frameOf: FrameOf): Attach {
  const frames = new Map<string, AttachFrame | null>()
  const notes = new Map<string, NoteAttach | null>()
  const frame = (id: string) => {
    let f = frames.get(id)
    if (f === undefined) {
      f = frameOf(id) ?? null
      frames.set(id, f)
    }
    return f
  }
  const endsFor = (id: string, extra?: { id: string; toward: Point }): NoteAttach | null => {
    const f = frame(id)
    if (f === null) return null
    const ends: Array<{ id: string; toward: Point }> = []
    const shared = new Map<string, string | null>()
    const groups = new Map<string, { key: PinKey; members: NoteEnd[] }>()
    for (const e of topo.byNote.get(id) ?? []) {
      const eid = endId(e.ref, e.end)
      if (e.pin === HANGING) {
        shared.set(eid, null)
        continue
      }
      if (e.pin === undefined) {
        const o = frame(e.other)
        if (o !== null) ends.push({ id: eid, toward: centre(o.rect) })
        continue
      }
      const pid = `${id}\u0001${e.pin}`
      shared.set(eid, pid)
      const g = groups.get(pid)
      if (g === undefined) groups.set(pid, { key: e.pin, members: [e] })
      else g.members.push(e)
    }
    /** Each shared pin's lead end id: the pin is laid out as that end, under its own id. */
    const leads = new Map<string, string>()
    for (const [pid, { key, members }] of groups) {
      const a = anchorOf(key)
      const named = a && members.find((m) => m.ref.yarnId === a.yarnId && m.end === a.end)
      const lead = named ?? members.reduce((x, y) => (earlier(y, x) ? y : x))
      leads.set(pid, endId(lead.ref, lead.end))
      for (const m of members) {
        if (m !== lead && m.ref.yarnId !== lead.ref.yarnId) continue
        const o = frame(m.other)
        if (o !== null) ends.push({ id: endId(m.ref, m.end), toward: centre(o.rect) })
      }
    }
    if (extra !== undefined) ends.push(extra)
    const points = attachPoints(f, ends)
    for (const [eid, pid] of shared) {
      const p = pid === null ? f.pivot : points.get(leads.get(pid) as string)
      if (p !== undefined) points.set(eid, p)
    }
    return { points, shared }
  }
  const noteAttach = (ref: SegmentRef, end: End) => {
    const id = end === 'a' ? ref.aNoteId : ref.bNoteId
    let m = notes.get(id)
    if (m === undefined) {
      m = endsFor(id)
      notes.set(id, m)
    }
    return m
  }
  const point = (ref: SegmentRef, end: End) => noteAttach(ref, end)?.points.get(endId(ref, end))
  return {
    point,
    sharedPin(ref, end) {
      return noteAttach(ref, end)?.shared.get(endId(ref, end))
    },
    ends(ref) {
      const a = point(ref, 'a')
      const b = point(ref, 'b')
      return a === undefined || b === undefined ? undefined : { a, b }
    },
    preview(noteId, towardNoteId) {
      const t = frame(towardNoteId)
      if (t === null) return undefined
      // Sorted after every end on a tie, as the new thread's (time-ordered) id will be.
      const at = endsFor(noteId, { id: '\uffffpreview', toward: centre(t.rect) })
      return at?.points.get('\uffffpreview')
    },
  }
}
