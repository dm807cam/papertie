import {
  type BoardState,
  computeFocus,
  type FocusDepth,
  type FocusResult,
  isId,
  type LooseEnd,
  type Membership,
  type Yarn,
} from '@papertie/core'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { replaceHash } from '../app/router'
import type { Point } from '../canvas/types'
import { polylineLength, sliceByLength } from '../canvas/yarnGeometry'
import { EASE } from '../styles/motion'

/** What focus mode is asked to show; the URL hash holds it (`focusHash`), never the board. */
export interface FocusState {
  seeds: string[]
  depth: FocusDepth
  /** Notes brought in by hand: shown, never expanded from. */
  include: string[]
}

/** The rest of the board fades out over 250 ms (at once under reduced motion). */
export const FOCUS_FADE_MS = 250
/** A loose end is this much of its strand, in world px, from the visible note's edge pin. */
export const LOOSE_END_WORLD = 36
/** A loose end's opacity, in its yarn's dye. */
export const LOOSE_END_ALPHA = 0.5
/** − and + step through 1 to this many steps; past it is the whole component (All). */
export const MAX_STEPS = 3

/** One step deeper: 1, 2, 3, then the whole component. */
export function deeper(d: FocusDepth): FocusDepth {
  return d === 'all' || d >= MAX_STEPS ? 'all' : ((d + 1) as FocusDepth)
}

/** One step shallower, never below 1; from the whole component, `MAX_STEPS`. */
export function shallower(d: FocusDepth): FocusDepth {
  return d === 'all' ? MAX_STEPS : d <= 1 ? 1 : ((d - 1) as FocusDepth)
}

export function withDepth(f: FocusState, depth: FocusDepth): FocusState {
  return f.depth === depth ? f : { ...f, depth }
}

/** `f` with note `id` brought in; `f` itself when it is a seed or already in. */
export function withInclude(f: FocusState, id: string): FocusState {
  if (f.seeds.includes(id) || f.include.includes(id)) return f
  return { ...f, include: [...f.include, id] }
}

/**
 * `f` with every note of `ids` brought in, in one pass (a Set of what is already there); `f`
 * itself when none is new. O(seeds + include + ids), for a batch such as a duplicate's copies.
 */
export function withIncludes(f: FocusState, ids: Iterable<string>): FocusState {
  const have = new Set([...f.seeds, ...f.include])
  const added: string[] = []
  for (const id of ids) {
    if (have.has(id)) continue
    have.add(id)
    added.push(id)
  }
  return added.length === 0 ? f : { ...f, include: [...f.include, ...added] }
}

/**
 * What a press on a loose end does: one step deeper, or, at the whole component (where a loose
 * end can only lead from a note brought in), the note across it brought in too.
 */
export function expandLooseEnd(f: FocusState, toward: string): FocusState {
  return f.depth === 'all' ? withInclude(f, toward) : withDepth(f, deeper(f.depth))
}

/** `f` with ids that are not on board `s` dropped (and repeats), or null when nothing is left. */
export function normaliseFocus(f: FocusState, s: BoardState): FocusState | null {
  const seen = new Set<string>()
  const keep = (ids: readonly string[]) =>
    ids.filter((id) => {
      if (seen.has(id) || !s.notes.has(id)) return false
      seen.add(id)
      return true
    })
  const seeds = keep(f.seeds)
  const include = keep(f.include)
  if (seeds.length === 0 && include.length === 0) return null
  return { seeds, depth: f.depth, include }
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i])

export function sameFocus(a: FocusState | null, b: FocusState | null): boolean {
  if (a === null || b === null) return a === b
  return a.depth === b.depth && sameIds(a.seeds, b.seeds) && sameIds(a.include, b.include)
}

// --- The URL hash: `#focus=<id>,<id>&d=1|2|3|all&in=<id>,…` ---

const DEPTHS: Readonly<Record<string, FocusDepth>> = { 1: 1, 2: 2, 3: 3, all: 'all' }

/**
 * The most notes brought in that the hash lists. Past it (a large duplicate, say) the hash keeps
 * the focus by its seeds and depth only, so the URL stays short: a reload then shows the focus
 * without the notes brought in, which this page's focus keeps until then.
 */
export const HASH_INCLUDE_MAX = 64

/** The hash for `f` (with its `#`), or '' for none. */
export function focusHash(f: FocusState | null): string {
  if (f === null) return ''
  const list = (ids: readonly string[]) => ids.map(encodeURIComponent).join(',')
  const include =
    f.include.length === 0 || f.include.length > HASH_INCLUDE_MAX ? '' : `&in=${list(f.include)}`
  return `#focus=${list(f.seeds)}&d=${f.depth}${include}`
}

/**
 * The focus a hash asks for, or null for none. Anything that is not a note id is dropped, and an
 * unknown depth is 1; ids not on the board are left for the runtime to ignore.
 */
export function parseFocusHash(hash: string): FocusState | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''))
  const seen = new Set<string>()
  const ids = (v: string | null) =>
    (v ?? '').split(',').filter((id) => {
      if (!isId(id, 'note') || seen.has(id)) return false
      seen.add(id)
      return true
    })
  const seeds = ids(q.get('focus'))
  if (seeds.length === 0) return null
  return { seeds, depth: DEPTHS[q.get('d') ?? ''] ?? 1, include: ids(q.get('in')) }
}

/** What `bindFocusHash` needs of the canvas. */
export interface FocusHashTarget {
  setFocus(f: FocusState | null, opts?: { instant?: boolean }): void
  onFocusChange(fn: (f: FocusState | null) => void): () => void
}

/**
 * Keep focus in the URL hash: read it now (a reload restores focus at once, no fade) and on
 * `hashchange`, and write every change back with `history.replaceState`, so Back to the board
 * and reload both find it. Returns the unbind.
 */
export function bindFocusHash(rt: FocusHashTarget): () => void {
  const restored = parseFocusHash(location.hash)
  if (restored !== null) rt.setFocus(restored, { instant: true })
  const off = rt.onFocusChange((f) => replaceHash(focusHash(f)))
  const onHash = () => rt.setFocus(parseFocusHash(location.hash))
  window.addEventListener('hashchange', onHash)
  return () => {
    off()
    window.removeEventListener('hashchange', onHash)
  }
}

// --- What the yarn layer draws ---

/**
 * Focus as the yarn layer paints it. Notes `shown` are drawn as usual; notes the `fade` holds
 * are drawn at its `alpha` from a layer of their own, cached like the static one, so a fade
 * frame only blits; every other note is hidden.
 */
export interface FocusPaint {
  shown(noteId: string): boolean
  /** The same object exactly while `shown` says the same: the static cache is kept under it. */
  key: object
  fade: { has(noteId: string): boolean; alpha: number; key: object } | null
}

/** Which of a paint's two layers: the shown notes' (static), or the fading notes'. */
export type FocusLayer = 'shown' | 'fade'

/** How a layer draws a segment: whole, or only the loose end from its `a` or `b` note. */
export type Part = 'whole' | 'a' | 'b'

const stateOf = (p: FocusPaint, id: string) =>
  p.shown(id) ? 'shown' : p.fade?.has(id) ? 'fade' : 'hidden'

/** Whether a note's pin (or overview card) is drawn on `layer`. */
export function inLayer(p: FocusPaint, layer: FocusLayer, noteId: string): boolean {
  return layer === 'shown' ? p.shown(noteId) : p.fade?.has(noteId) === true
}

/**
 * How `layer` draws the segment between notes `a` and `b`. The shown layer draws it whole
 * between two shown notes, and as a loose end from a shown note to any other. The fade layer
 * draws it whole between two notes that are shown or fading (one at least fading), and as a loose
 * end from a fading note to a hidden one. Null: not on that layer.
 */
export function partOf(p: FocusPaint, layer: FocusLayer, a: string, b: string): Part | null {
  const sa = stateOf(p, a)
  const sb = stateOf(p, b)
  if (layer === 'shown') {
    if (sa === 'shown') return sb === 'shown' ? 'whole' : 'a'
    return sb === 'shown' ? 'b' : null
  }
  if (sa === 'hidden') return sb === 'fade' ? 'b' : null
  if (sb === 'hidden') return sa === 'fade' ? 'a' : null
  return sa === 'fade' || sb === 'fade' ? 'whole' : null
}

/** The loose end of a strand's world polyline: `LOOSE_END_WORLD` of it from its `from` end. */
export function looseStub(pts: readonly Point[], from: 'a' | 'b'): Point[] {
  if (from === 'a') return sliceByLength(pts, 0, LOOSE_END_WORLD)
  const total = polylineLength(pts)
  return sliceByLength(pts, total - LOOSE_END_WORLD, total)
}

// --- Thread membership, kept up to date ---

/** What a commit changed on the board, as the runtime's `onBoard` finds it. */
export interface BoardDiff {
  addedNotes: readonly string[]
  removedNotes: readonly string[]
  /** Threads whose record changed: `before` is absent for a new one, `after` for a deleted one. */
  threads: ReadonlyArray<{ id: string; before?: Yarn; after?: Yarn }>
}

/**
 * Core's thread membership (`buildMembership`'s two maps, same contents) built once and then
 * patched commit by commit from the board's diff, so a tie, an untie or a note added or removed
 * costs O(what changed), never O(board). A colour or label change touches nothing.
 */
export class LiveMembership implements Membership {
  readonly yarnsByNote = new Map<string, Set<string>>()
  readonly notesByYarn = new Map<string, readonly string[]>()

  /** O(notes + thread members): once, when focus is first used. */
  constructor(s: BoardState) {
    for (const id of s.notes.keys()) this.yarnsByNote.set(id, new Set())
    for (const [id, y] of s.yarns) this.tie(id, y)
  }

  /** Apply one commit's diff; returns whether the membership changed. */
  patch(d: BoardDiff): boolean {
    let changed = false
    for (const id of d.addedNotes) {
      if (this.yarnsByNote.has(id)) continue
      this.yarnsByNote.set(id, new Set())
      changed = true
    }
    for (const { id, before, after } of d.threads) {
      if (before && after && sameIds(before.noteIds, after.noteIds)) continue
      changed = true
      for (const n of this.notesByYarn.get(id) ?? []) this.yarnsByNote.get(n)?.delete(id)
      this.notesByYarn.delete(id)
      if (after) this.tie(id, after)
    }
    for (const id of d.removedNotes) changed = this.yarnsByNote.delete(id) || changed
    return changed
  }

  private tie(id: string, y: Yarn): void {
    this.notesByYarn.set(id, [...y.noteIds])
    for (const n of y.noteIds) this.yarnsByNote.get(n)?.add(id)
  }
}

// --- The mode itself ---

/** What focus mode needs of the canvas. */
export interface FocusHost {
  board(): BoardState
  /** The mounted notes' elements (`NoteLayer`'s). */
  readonly noteEls: ReadonlyMap<string, HTMLElement>
  readonly root: HTMLElement
}

export interface FocusView {
  state: FocusState | null
  result: FocusResult | null
}

interface Fade {
  /** performance.now ms of its first frame; null until then. */
  start: number | null
  from: number
  to: number
  paint: FocusPaint & { fade: NonNullable<FocusPaint['fade']> }
  /** The paint once it ends. */
  end: FocusPaint | null
  /** Focus is ending: the root's mark goes with the fade. */
  leaving: boolean
}

/** A paint showing exactly `notes`. */
const steady = (notes: ReadonlySet<string>): FocusPaint => ({
  shown: (id) => notes.has(id),
  key: notes,
  fade: null,
})

const inSet = (s: ReadonlySet<string> | null, id: string) => s === null || s.has(id)

/** Whether every id of `small` is in `big`; null stands for every note. O(|small|). */
function within(small: ReadonlySet<string> | null, big: ReadonlySet<string> | null): boolean {
  if (big === null) return true
  if (small === null || small.size > big.size) return false
  for (const id of small) if (!big.has(id)) return false
  return true
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && within(a, b)

/** Hide (or show) a mounted note: faded by CSS, then out of the accessibility tree and inert. */
function markHidden(el: HTMLElement, hidden: boolean): void {
  if (el.dataset.focusIn !== undefined) delete el.dataset.focusIn
  if (hidden === (el.dataset.focusOut !== undefined)) return
  if (hidden) {
    el.dataset.focusOut = ''
    el.setAttribute('inert', '')
    el.setAttribute('aria-hidden', 'true')
  } else {
    delete el.dataset.focusOut
    el.removeAttribute('inert')
    el.removeAttribute('aria-hidden')
  }
}

/**
 * Focus mode for one canvas: the focus asked for, what it shows (core's `computeFocus` over the
 * thread membership), the marks on the mounted notes and the fade between one and the next.
 *
 * Costs, so a 100k board stays smooth: the membership is built once, when focus is first used,
 * and from then on patched from each commit's diff (`LiveMembership`, O(changed)); the focus is
 * computed only when it is asked for something else or a commit changed the membership (never
 * for typing, a drag or a thread's colour). A change of focus touches the mounted notes only (`noteEls`, O(visible)); a note mounted later is marked as it mounts. The
 * fade is CSS on the notes and one cached layer on the yarn canvas, so a fade frame only blits.
 */
export class FocusMode {
  readonly view: StoreApi<FocusView> = createStore<FocusView>()(() => ({
    state: null,
    result: null,
  }))
  private membership: LiveMembership | null = null
  private builds = 0
  private paintNow: FocusPaint | null = null
  private fade: Fade | null = null
  /** Frames left before the root's `data-focus-snap` (no CSS fade) is taken off. */
  private snapFrames = 0

  constructor(private readonly host: FocusHost) {}

  get state(): FocusState | null {
    return this.view.getState().state
  }

  get result(): FocusResult | null {
    return this.view.getState().result
  }

  /** What the yarn layer draws now; null: the whole board. */
  get paint(): FocusPaint | null {
    return this.paintNow
  }

  /** Whether note `id` is shown: always, with focus off. */
  shown(id: string): boolean {
    const r = this.result
    return r === null || r.notes.has(id)
  }

  /** Whether the frame loop has focus work: a fade, or the snap mark to take off. */
  get busy(): boolean {
    return this.fade !== null || this.snapFrames > 0
  }

  /** Show `next` (null: the whole board), fading from what was shown unless `animate` is off. */
  set(next: FocusState | null, animate: boolean): void {
    const before = this.result
    const result = next === null ? null : computeFocus(this.membershipOf(), next)
    this.apply(next, result, before?.notes ?? null, animate)
  }

  /** The membership focus reads (null until focus is first used), for tests and the bench. */
  get liveMembership(): Membership | null {
    return this.membership
  }

  /** How many times the membership was built from the whole board: once, ever. */
  get membershipBuilds(): number {
    return this.builds
  }

  /**
   * A commit changed the board: the membership (once built) is patched from `diff`, and with focus
   * on and the membership changed, the focus is computed again and shown at once. Returns whether
   * what is shown changed.
   */
  boardChanged(diff: BoardDiff): boolean {
    if (this.membership === null || !this.membership.patch(diff)) return false
    const state = this.state
    const before = this.result
    if (state === null || before === null) return false
    const result = computeFocus(this.membership, state)
    if (sameSet(result.notes, before.notes)) {
      // The same notes (their threads changed): the loose ends may differ, the marks do not.
      this.view.setState({ result })
      return false
    }
    this.apply(state, result, before.notes, false)
    return true
  }

  /** Mark a note's element as it mounts. A note mounting while the board fades in fades in too. */
  mounted(id: string, el: HTMLElement): void {
    const hidden = !this.shown(id)
    markHidden(el, hidden)
    const f = this.fade
    if (!hidden && f !== null && f.to > f.from && f.paint.fade.has(id)) el.dataset.focusIn = ''
  }

  /**
   * One frame: step the fade. Returns whether the yarn layer must be drawn again, and whether
   * another frame is wanted.
   */
  frame(now: number): { changed: boolean; more: boolean } {
    if (this.snapFrames > 0 && --this.snapFrames === 0) delete this.host.root.dataset.focusSnap
    const f = this.fade
    if (f === null) return { changed: false, more: this.snapFrames > 0 }
    if (f.start === null) f.start = now
    const t = Math.min(1, Math.max(0, (now - f.start) / FOCUS_FADE_MS))
    f.paint.fade.alpha = f.from + (f.to - f.from) * EASE(t)
    if (t >= 1) this.endFade()
    return { changed: true, more: this.busy }
  }

  dispose(): void {
    const { dataset } = this.host.root
    delete dataset.focus
    delete dataset.focusSnap
  }

  private membershipOf(): Membership {
    if (this.membership === null) {
      this.membership = new LiveMembership(this.host.board())
      this.builds++
    }
    return this.membership
  }

  private endFade(): void {
    const f = this.fade
    if (f === null) return
    this.fade = null
    this.paintNow = f.end
    if (f.leaving) delete this.host.root.dataset.focus
  }

  private apply(
    state: FocusState | null,
    result: FocusResult | null,
    from: ReadonlySet<string> | null,
    animate: boolean,
  ): void {
    this.endFade()
    const to = result?.notes ?? null
    for (const [id, el] of this.host.noteEls) markHidden(el, !inSet(to, id))
    const { dataset } = this.host.root
    if (to !== null) dataset.focus = ''
    this.view.setState({ state, result })
    const shrink = to !== null && within(to, from)
    const grow = from !== null && within(from, to)
    if (!animate || !(shrink || grow) || from === to) {
      this.paintNow = to === null ? null : steady(to)
      if (to === null) delete dataset.focus
      // The notes' CSS fade is off until the marks have been drawn once.
      dataset.focusSnap = ''
      this.snapFrames = 2
      return
    }
    delete dataset.focusSnap
    this.snapFrames = 0
    if (shrink && to !== null) {
      // The rest fades out over the notes that stay; the static layer is already theirs.
      const end = steady(to)
      const fade = { has: (id: string) => inSet(from, id) && !to.has(id), alpha: 1, key: {} }
      this.fade = { start: null, from: 1, to: 0, paint: { ...end, fade }, end, leaving: false }
    } else if (from !== null) {
      // What joins fades in over what was shown (the whole board, leaving focus).
      const fade = { has: (id: string) => inSet(to, id) && !from.has(id), alpha: 0, key: {} }
      const end = to === null ? null : steady(to)
      this.fade = {
        start: null,
        from: 0,
        to: 1,
        paint: { ...steady(from), fade },
        end,
        leaving: to === null,
      }
    }
    this.paintNow = this.fade?.paint ?? null
  }
}

/** A loose end found under the pointer: the note across it, which expanding would reach. */
export type LooseEndHit = LooseEnd & { toward: string }
