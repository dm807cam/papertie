import RBush, { type BBox } from 'rbush'
import {
  type Attach,
  boardFrames,
  createAttach,
  type SegmentRef,
  type Topology,
  type TopologyBoard,
  topologyOf,
} from './attach'
import { noteBounds } from './geometry'
import type { Point, Rect } from './types'
import { bezierBounds, restSagPoint, segmentBezier } from './yarnGeometry'

export type { SegmentRef } from './attach'

interface NoteItem extends BBox {
  id: string
}

interface SegItem extends BBox {
  ref: SegmentRef
  /** Its edge pins, at rest on the stored board. */
  a: Point
  b: Point
}

/** What the index took in since it was last asked ({@link SpatialIndex.takeChanges}). */
export interface IndexChanges {
  /** Rebuilt from scratch: everything may have changed. */
  all: boolean
  /** Notes indexed again (moved, resized, added or removed). */
  notes: Set<string>
  /** Segments indexed again or dropped, by key. */
  segments: Set<string>
}

const noChanges = (): IndexChanges => ({ all: false, notes: new Set(), segments: new Set() })

type Heights = ReadonlyMap<string, number>

const box = (r: Rect): BBox => ({ minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h })

/** World bounds of a segment at rest: its curve's hull grown by max(8, a quarter of the sag). */
export function segmentBounds(a: Point, b: Point): Rect {
  const sag = restSagPoint(a, b)
  const depth = sag.y - (a.y + b.y) / 2
  const r = bezierBounds(segmentBezier(a, b, sag))
  const by = Math.max(8, 0.25 * depth)
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by }
}

/**
 * rbush index of note rects and yarn segments, in world px, both at the displayed height
 * (`max(h, measured)`). Segments run between their edge pins (`attach.ts`), tilted when
 * `rotation` is on; their bounds use the rest sag, so a live spring that sags further than a
 * quarter of its rest depth can poke out of them. A note's edge pins depend on its neighbours,
 * so a changed note re-indexes every segment touching it or one of its neighbours (as indexed
 * and as on the board now, found through the board's topology): what a change costs follows the
 * notes beside it, never the length of their threads or the number of threads on the board.
 */
export class SpatialIndex {
  private readonly notes = new RBush<NoteItem>()
  private readonly segs = new RBush<SegItem>()
  private readonly noteItems = new Map<string, NoteItem>()
  /** Every indexed segment by key. */
  private readonly segItems = new Map<string, SegItem>()
  /** The keys of the segments indexed with an end on each note. */
  private readonly segsOfNote = new Map<string, Set<string>>()
  /** What changed since the last {@link takeChanges}: a mirror of the index (the pyramid) follows it. */
  private changes: IndexChanges = noChanges()

  get size(): { notes: number; segments: number } {
    return { notes: this.noteItems.size, segments: this.segItems.size }
  }

  /** What was indexed since the last call (O(changes)); the next call starts afresh. */
  takeChanges(): IndexChanges {
    const out = this.changes
    this.changes = noChanges()
    return out
  }

  /** A note's indexed rect (its stored rect at the displayed height), as an rbush box. */
  noteBox(id: string): BBox | undefined {
    return this.noteItems.get(id)
  }

  /** An indexed segment: its ref, its edge pins at rest and its bounds. */
  segment(key: string): (BBox & { ref: SegmentRef; a: Point; b: Point }) | undefined {
    return this.segItems.get(key)
  }

  /** Index the whole board from scratch. */
  rebuild(s: TopologyBoard, measuredH: Heights, rotation = false): void {
    this.changes = { ...noChanges(), all: true }
    this.notes.clear()
    this.segs.clear()
    this.noteItems.clear()
    this.segItems.clear()
    this.segsOfNote.clear()
    const noteItems: NoteItem[] = []
    for (const n of s.notes.values()) {
      const item = { ...box(noteBounds(n, measuredH.get(n.id))), id: n.id }
      this.noteItems.set(n.id, item)
      noteItems.push(item)
    }
    this.notes.load(noteItems)
    const topo = topologyOf(s)
    const attach = this.attachFor(s, topo, measuredH, rotation)
    const items: SegItem[] = []
    for (const refs of topo.byYarn.values()) {
      for (const ref of refs) {
        const item = this.itemOf(ref, attach)
        if (item !== undefined) items.push(item)
      }
    }
    this.segs.load(items)
  }

  /**
   * Re-index the given notes (moved, resized, added or deleted, or on a thread that changed) and
   * every segment touching them or their neighbours, before or after the change. O(those
   * segments).
   */
  updateNotes(
    s: TopologyBoard,
    noteIds: Iterable<string>,
    measuredH: Heights,
    rotation = false,
  ): void {
    const ids = new Set(noteIds)
    if (ids.size === 0) return
    const topo = topologyOf(s)
    // The notes whose edge pins may have moved: these and their neighbours, then and now.
    const near = new Set(ids)
    for (const id of ids) {
      for (const k of this.segsOfNote.get(id) ?? []) {
        const ref = this.segItems.get(k)?.ref
        if (ref !== undefined) near.add(ref.aNoteId === id ? ref.bNoteId : ref.aNoteId)
      }
      for (const e of topo.byNote.get(id) ?? []) near.add(e.other)
    }
    for (const id of ids) {
      if (!this.changes.all) this.changes.notes.add(id)
      const old = this.noteItems.get(id)
      if (old !== undefined) {
        this.notes.remove(old)
        this.noteItems.delete(id)
      }
      const n = s.notes.get(id)
      if (n !== undefined) {
        const item = { ...box(noteBounds(n, measuredH.get(id))), id }
        this.noteItems.set(id, item)
        this.notes.insert(item)
      }
    }
    const fresh = new Map<string, SegmentRef>()
    for (const id of near) {
      for (const k of [...(this.segsOfNote.get(id) ?? [])]) this.untrack(k)
      for (const e of topo.byNote.get(id) ?? []) fresh.set(e.ref.key, e.ref)
    }
    const attach = this.attachFor(s, topo, measuredH, rotation)
    for (const ref of fresh.values()) {
      const item = this.itemOf(ref, attach)
      if (item !== undefined) this.segs.insert(item)
    }
  }

  /** Ids of notes whose rect touches `r`, in no particular order. */
  notesIn(r: Rect): string[] {
    return this.notes.search(box(r)).map((i) => i.id)
  }

  /**
   * At most `limit` of the notes whose rects meet `r`: the tree walked only until that many are
   * found, so a point on a deep pile costs `limit`, not the pile (a pin's cover).
   */
  notesInUpTo(r: Rect, limit: number): string[] {
    const b = box(r)
    const out: string[] = []
    const meets = (n: BBox) =>
      n.minX <= b.maxX && b.minX <= n.maxX && n.minY <= b.maxY && b.minY <= n.maxY
    type TreeNode = BBox & { leaf: boolean; children: (TreeNode | NoteItem)[] }
    // rbush's root (`data`) is not part of its API: the dependency is pinned (4.0.1), and
    // spatialIndexLimit.test fails if its node shape ever changes.
    const root = (this.notes as unknown as { data: TreeNode }).data
    const stack: TreeNode[] = meets(root) ? [root] : []
    while (stack.length > 0 && out.length < limit) {
      const node = stack.pop() as TreeNode
      for (const child of node.children) {
        if (!meets(child)) continue
        if (node.leaf) {
          out.push((child as NoteItem).id)
          if (out.length >= limit) break
        } else stack.push(child as TreeNode)
      }
    }
    return out
  }

  /** Segments whose rest bounds touch `r`, in no particular order. */
  segmentsIn(r: Rect): SegmentRef[] {
    return this.segs.search(box(r)).map((i) => i.ref)
  }

  private attachFor(
    s: TopologyBoard,
    topo: Topology,
    measuredH: Heights,
    rotation: boolean,
  ): Attach {
    const heightOf = (n: { id: string; h: number }) => Math.max(n.h, measuredH.get(n.id) ?? 0)
    return createAttach(topo, boardFrames(s.notes, { rotation, heightOf }))
  }

  /** A segment's item, recorded (the caller puts it in the tree); none when a note is gone. */
  private itemOf(ref: SegmentRef, attach: Attach): SegItem | undefined {
    const e = attach.ends(ref)
    if (e === undefined) return undefined
    const item = { ...box(segmentBounds(e.a, e.b)), ref, a: e.a, b: e.b }
    this.segItems.set(ref.key, item)
    if (!this.changes.all) this.changes.segments.add(ref.key)
    for (const id of [ref.aNoteId, ref.bNoteId]) {
      let set = this.segsOfNote.get(id)
      if (set === undefined) {
        set = new Set()
        this.segsOfNote.set(id, set)
      }
      set.add(ref.key)
    }
    return item
  }

  private untrack(key: string): void {
    const item = this.segItems.get(key)
    if (item === undefined) return
    this.segs.remove(item)
    this.segItems.delete(key)
    if (!this.changes.all) this.changes.segments.add(key)
    for (const id of [item.ref.aNoteId, item.ref.bNoteId]) {
      const set = this.segsOfNote.get(id)
      set?.delete(key)
      if (set?.size === 0) this.segsOfNote.delete(id)
    }
  }
}
