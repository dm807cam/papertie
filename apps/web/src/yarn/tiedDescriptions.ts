import { type BoardState, mapChangesWithin } from '@papertie/core'
import { noteLabel } from '../selection/selection'
import type { BoardStore } from '../store/boardStore'
import { tiedTo } from './tiedTo'

/**
 * More changed notes or threads than this in one change, and every kept description is read
 * again (an opening's hand-over, an import, a board loaded again): finding out which would cost
 * more than reading the mounted notes.
 */
const CHANGES_MAX = 256

/**
 * The mounted notes' "Tied to … by … yarn." descriptions (`tiedToCopy`), each kept until a
 * change could alter it and recomputed only when it is next read. A note's description changes
 * only when one of its threads changes (made, deleted, recoloured, a note wound on or taken
 * off), or when a note it names changes its name (its first line as shown). So each change of
 * the board (a commit, an undo, a remote batch, a replace) is read as what it changed: the
 * store's own account of a replace, or the two versions' change set (`mapChangesWithin`,
 * O(changes × log n)). Then only the notes on the changed threads, and the kept descriptions
 * that name a renamed note (an index of who names whom), are told. A keystroke that leaves a
 * note's name as it was, or in a note no description names, costs nothing here; one that
 * renames a tied note, the few descriptions that name it (each lists at most five notes per
 * colour).
 *
 * Only subscribed notes (the mounted ones) are kept; a note is dropped as it unmounts. It
 * listens to the store only while a note is subscribed, so making one has no side effect.
 */
export class TiedDescriptions {
  private readonly kept_ = new Map<string, { copy: string; named: readonly string[] }>()
  /** Note id → the kept descriptions that name it (a rename tells only those). */
  private readonly namedBy = new Map<string, Set<string>>()
  private readonly listeners = new Map<string, Set<() => void>>()
  /** The store's subscription, held while any note is subscribed. */
  private off: (() => void) | null = null
  /** How many descriptions have been computed (for tests). */
  computed = 0
  /** Main-thread time spent on them, ms: reading changes and computing (for tests). */
  spentMs = 0

  constructor(private readonly store: BoardStore) {}

  /** The note's description ('' when it is on no thread), computed when not kept. */
  get(noteId: string): string {
    const kept = this.kept_.get(noteId)
    if (kept !== undefined) return kept.copy
    const t = performance.now()
    const made = tiedTo(this.store.getState(), noteId)
    this.spentMs += performance.now() - t
    this.computed++
    if (this.listeners.has(noteId)) {
      this.kept_.set(noteId, made)
      for (const id of made.named) {
        let by = this.namedBy.get(id)
        if (by === undefined) {
          by = new Set()
          this.namedBy.set(id, by)
        }
        by.add(noteId)
      }
    }
    return made.copy
  }

  /** Drop `noteId`'s kept description, and its place in the names index. */
  private forget(noteId: string): void {
    const kept = this.kept_.get(noteId)
    if (kept === undefined) return
    this.kept_.delete(noteId)
    for (const id of kept.named) {
      const by = this.namedBy.get(id)
      by?.delete(noteId)
      if (by?.size === 0) this.namedBy.delete(id)
    }
  }

  /** Be told when `noteId`'s description may have changed (it is mounted). */
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
        this.forget(noteId)
      }
      if (this.listeners.size === 0) this.stop()
    }
  }

  private stop(): void {
    this.off?.()
    this.off = null
  }

  /** How many descriptions are kept. */
  get kept(): number {
    return this.kept_.size
  }

  /** Forget every note and stop listening to the store. */
  dispose(): void {
    this.stop()
    this.listeners.clear()
    this.kept_.clear()
    this.namedBy.clear()
  }

  private changed(s: BoardState, prev: BoardState): void {
    if (this.listeners.size === 0) return
    const t = performance.now()
    this.tellChanges(s, prev)
    this.spentMs += performance.now() - t
  }

  private tellChanges(s: BoardState, prev: BoardState): void {
    if (s.notes === prev.notes && s.yarns === prev.yarns) return
    const told = this.store.touched(s, prev)
    let notes: Iterable<string>
    let yarns: Iterable<string>
    if (told === 'all' || (told !== undefined && told.notes.size + told.yarns.size > CHANGES_MAX)) {
      this.forgetAll()
      return
    }
    if (told !== undefined) {
      notes = told.notes
      yarns = told.yarns
    } else {
      const n = s.notes === prev.notes ? null : mapChangesWithin(prev.notes, s.notes, CHANGES_MAX)
      const y = s.yarns === prev.yarns ? null : mapChangesWithin(prev.yarns, s.yarns, CHANGES_MAX)
      if ((s.notes !== prev.notes && n === null) || (s.yarns !== prev.yarns && y === null)) {
        this.forgetAll()
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
      if (was === undefined || is === undefined) {
        // Made or deleted: its own description, and those that name it. (Its threads changing
        // with it is a change of those threads, above.)
        stale.add(id)
        for (const by of this.namedBy.get(id) ?? []) stale.add(by)
        continue
      }
      // Only a note's name (its first line as shown) is said by others, and only by the kept
      // descriptions that list it: a move, a recolour, a line below the first, or a note no
      // kept description names, tells no one.
      const by = this.namedBy.get(id)
      if (by === undefined || was.text === is.text) continue
      if (noteLabel(was.text) === noteLabel(is.text)) continue
      for (const n of by) stale.add(n)
    }
    for (const id of stale) this.tell(id)
  }

  private tell(noteId: string): void {
    const fns = this.listeners.get(noteId)
    if (fns === undefined) return
    this.forget(noteId)
    for (const fn of [...fns]) fn()
  }

  private forgetAll(): void {
    this.kept_.clear()
    this.namedBy.clear()
    for (const id of [...this.listeners.keys()]) this.tell(id)
  }
}
