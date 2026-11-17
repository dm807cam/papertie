import type { Note } from '@papertie/core'

/** Gesture-time geometry laid over a stored note. */
export type NoteOverride = Partial<Pick<Note, 'x' | 'y' | 'w' | 'h' | 'z'>>

const KEYS = ['x', 'y', 'w', 'h', 'z'] as const

/**
 * One shared move for a group of notes (a drag of the selection): each member is drawn at its own
 * position plus (`dx`, `dy`) and its own z plus `dz`. One entry for any number of notes.
 */
export interface GroupMove {
  readonly ids: ReadonlySet<string>
  readonly dx: number
  readonly dy: number
  readonly dz: number
}

/**
 * The transient override map: during a drag or resize, the DOM and the yarn read notes through
 * it while the store stays untouched until the gesture commits. `version` bumps on every change.
 */
export class TransientOverrides {
  private readonly map = new Map<string, NoteOverride>()
  private groupMove: GroupMove | null = null
  private readonly listeners = new Set<() => void>()
  private v = 0

  get version(): number {
    return this.v
  }

  /** The group move under way, if any: it holds the selection's ids, never a copy per frame. */
  get group(): GroupMove | null {
    return this.groupMove
  }

  /**
   * Move the notes `ids` together by one delta (replacing any earlier group move). O(1): the
   * members are read through `effective`, so a drag of thousands costs what a drag of one does.
   */
  setGroup(ids: ReadonlySet<string>, d: { dx: number; dy: number; dz: number }): void {
    this.groupMove = { ids, dx: d.dx, dy: d.dy, dz: d.dz }
    this.changed()
  }

  /** Whether note `id` is overridden on its own or moves with the group. */
  has(id: string): boolean {
    return this.map.has(id) || (this.groupMove?.ids.has(id) ?? false)
  }

  /** Replace the override for `id`; undefined fields are dropped. */
  set(id: string, o: NoteOverride): void {
    const clean: NoteOverride = {}
    for (const k of KEYS) if (o[k] !== undefined) clean[k] = o[k]
    this.map.set(id, clean)
    this.changed()
  }

  delete(id: string): void {
    if (this.map.delete(id)) this.changed()
  }

  clear(): void {
    if (this.map.size === 0 && this.groupMove === null) return
    this.map.clear()
    this.groupMove = null
    this.changed()
  }

  /** The note's own override (not the group's move). */
  get(id: string): NoteOverride | undefined {
    return this.map.get(id)
  }

  /** The note as the gesture shows it; `n` itself when it has no override. */
  effective(n: Note): Note {
    const g = this.groupMove
    const base = g?.ids.has(n.id) ? { ...n, x: n.x + g.dx, y: n.y + g.dy, z: n.z + g.dz } : n
    const o = this.map.get(n.id)
    return o === undefined ? base : { ...base, ...o }
  }

  /** The notes with an override of their own: few (a resize, a single drag), never the group. */
  ids(): string[] {
    return [...this.map.keys()]
  }

  /** Number of overridden notes, the group's members included. */
  get size(): number {
    return this.map.size + (this.groupMove?.ids.size ?? 0)
  }

  /** Call `fn` after every change; returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private changed(): void {
    this.v++
    for (const fn of [...this.listeners]) fn()
  }
}
