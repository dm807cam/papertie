import { type BoardState, mapChangesWithin, type Note, threadsOf } from '@papertie/core'
import { facingEdge } from '../canvas/attach'
import { noteBounds, pinPosition } from '../canvas/geometry'
import type { BoardStore } from '../store/boardStore'

/** The sides of a note's paper that carry an edge pin, as a `data-pin-sides` value. */
export type PinSides = '' | 'left' | 'right' | 'left right'

/** More changed notes or threads than this in one change, and every mounted note is told. */
const CHANGES_MAX = 256

const centre = (n: Note) => {
  const r = noteBounds(n)
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

/**
 * The sides of `noteId`'s paper that carry an edge pin: a thread's end sits on the edge facing
 * the note it runs to (`facingEdge`, as the attachment places it), unless it is tied at the
 * note's hanging pin. Only left and right matter (a title runs between them). Read from the
 * note's own threads, so it costs the size of those threads, never the board. The paper is
 * taken unturned: a tilt of a degree or two never changes which edge faces a neighbour that
 * matters here.
 */
export function pinSides(state: BoardState, noteId: string): PinSides {
  const n = state.notes.get(noteId)
  if (n === undefined) return ''
  const frame = { rect: noteBounds(n), pivot: pinPosition(n), deg: 0 }
  let left = false
  let right = false
  for (const y of threadsOf(state, noteId)) {
    if (y.pins?.[noteId] === 'hanging') continue
    const present = y.noteIds.filter((id) => state.notes.has(id))
    const at = present.indexOf(noteId)
    for (const k of [at - 1, at + 1]) {
      const m = state.notes.get(present[k] ?? '')
      if (m === undefined) continue
      const edge = facingEdge(frame, centre(m))
      if (edge === 'left') left = true
      else if (edge === 'right') right = true
    }
  }
  return left && right ? 'left right' : left ? 'left' : right ? 'right' : ''
}

/**
 * The mounted notes' pinned sides (`pinSides`), each kept until a change could alter it: a
 * thread of the note changing, or the note or a thread neighbour moving, resizing, coming or
 * going. A text edit tells no one. Only subscribed (mounted) notes are kept; it listens to the
 * store only while one is.
 */
export class EdgeSides {
  private readonly kept = new Map<string, PinSides>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private off: (() => void) | null = null

  constructor(private readonly store: BoardStore) {}

  get(noteId: string): PinSides {
    const kept = this.kept.get(noteId)
    if (kept !== undefined) return kept
    const sides = pinSides(this.store.getState(), noteId)
    if (this.listeners.has(noteId)) this.kept.set(noteId, sides)
    return sides
  }

  subscribe(noteId: string, fn: () => void): () => void {
    this.off ??= this.store.subscribe((s, prev) => this.changed(s, prev))
    let set = this.listeners.get(noteId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(noteId, set)
    }
    set.add(fn)
    return () => {
      const s = this.listeners.get(noteId)
      if (s === undefined) return
      s.delete(fn)
      if (s.size === 0) {
        this.listeners.delete(noteId)
        this.kept.delete(noteId)
      }
      if (this.listeners.size === 0) {
        this.off?.()
        this.off = null
      }
    }
  }

  dispose(): void {
    this.off?.()
    this.off = null
    this.listeners.clear()
    this.kept.clear()
  }

  private changed(s: BoardState, prev: BoardState): void {
    if (this.listeners.size === 0 || (s.notes === prev.notes && s.yarns === prev.yarns)) return
    const told = this.store.touched(s, prev)
    let notes: Iterable<string>
    let yarns: Iterable<string>
    if (told === 'all' || (told !== undefined && told.notes.size + told.yarns.size > CHANGES_MAX)) {
      this.tellAll()
      return
    }
    if (told !== undefined) {
      notes = told.notes
      yarns = told.yarns
    } else {
      const n = s.notes === prev.notes ? null : mapChangesWithin(prev.notes, s.notes, CHANGES_MAX)
      const y = s.yarns === prev.yarns ? null : mapChangesWithin(prev.yarns, s.yarns, CHANGES_MAX)
      if ((s.notes !== prev.notes && n === null) || (s.yarns !== prev.yarns && y === null)) {
        this.tellAll()
        return
      }
      notes = n === null ? [] : [...n.set, ...n.deleted]
      yarns = y === null ? [] : [...y.set, ...y.deleted]
    }
    const stale = new Set<string>()
    for (const id of yarns) {
      for (const st of [prev, s]) for (const m of st.yarns.get(id)?.noteIds ?? []) stale.add(m)
    }
    for (const id of notes) {
      const was = prev.notes.get(id)
      const is = s.notes.get(id)
      // A text edit, a recolour: no edge moves.
      if (
        was !== undefined &&
        is !== undefined &&
        was.x === is.x &&
        was.y === is.y &&
        was.w === is.w &&
        was.h === is.h
      ) {
        continue
      }
      stale.add(id)
      for (const st of [prev, s]) {
        for (const y of threadsOf(st, id)) for (const m of y.noteIds) stale.add(m)
      }
    }
    for (const id of stale) this.tell(id)
  }

  private tell(noteId: string): void {
    const fns = this.listeners.get(noteId)
    if (fns === undefined) return
    this.kept.delete(noteId)
    for (const fn of [...fns]) fn()
  }

  private tellAll(): void {
    this.kept.clear()
    for (const id of [...this.listeners.keys()]) this.tell(id)
  }
}
