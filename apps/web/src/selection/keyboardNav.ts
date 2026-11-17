import { LIMITS, type Note } from '@papertie/core'
import { type Camera, visibleWorldRect } from '../canvas/Camera'
import type { Point, Rect, Size } from '../canvas/types'
import { isTypingTarget, type KeyLike, letterOf } from '../interactions/keys'

export type Direction = 'up' | 'down' | 'left' | 'right'

const VECTOR: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

/** How far off the direction (rad) a note's centre may lie and still be "that way": ±60°. */
const CONE = Math.PI / 3

/** The first band reaches this far (world px) along the direction from the note's centre. */
const FIRST_REACH = 600

/** Each band reaches twice as far as the one before it. */
const REACH_GROWTH = 2

/** Half the width of the ±60° cone per px of reach: tan 60°. */
const SPREAD = Math.tan(CONE)

/** What the search needs of the spatial index (`SpatialIndex.notesIn`). */
export interface NoteQuery {
  notesIn(r: Rect): string[]
}

const centreOf = (n: Note, heightOf: (n: Note) => number): Point => ({
  x: n.x + n.w / 2,
  y: n.y + heightOf(n) / 2,
})

/**
 * The note to move to from `fromId` in direction `dir`, or null at the edge of the board. A
 * candidate's centre must lie within ±60° of the direction; of those the lowest score wins,
 * `distance × (1 + angle / 60°)`, so a note straight ahead beats a nearer one off to the side.
 * `heightOf` gives a note's drawn height (default: its `h`).
 *
 * The cone is tiled by a staircase of bands, each twice as long as the last (along the
 * direction: [0, r], [r, 2r], [2r, 4r] …) and as wide as the cone is at its far end (±tan 60° ×
 * the band's reach). A query touches only its band, so a crowd beside the cone is never read,
 * and what is found is final once the next band starts beyond its score (a note farther along
 * than that scores worse, its distance being at least its way along). Bands run until the
 * coordinate range ends: about 16 queries for a note nothing lies beyond.
 */
export function nearestInDirection(
  state: { notes: ReadonlyMap<string, Note> },
  fromId: string,
  dir: Direction,
  index: NoteQuery,
  heightOf: (n: Note) => number = (n) => n.h,
): string | null {
  const pick = picker(state, fromId, dir, heightOf)
  if (pick === null) return null
  const { o, d, consider } = pick
  const end = 2 * LIMITS.maxCoord * Math.SQRT2
  for (let lo = 0, hi = FIRST_REACH; lo <= end; lo = hi, hi *= REACH_GROWTH) {
    const best = pick.best()
    if (best !== null && lo > best.score) break
    const side = SPREAD * hi
    const band: Rect = {
      x: d.x > 0 ? o.x + lo : d.x < 0 ? o.x - hi : o.x - side,
      y: d.y > 0 ? o.y + lo : d.y < 0 ? o.y - hi : o.y - side,
      w: d.x === 0 ? 2 * side : hi - lo,
      h: d.y === 0 ? 2 * side : hi - lo,
    }
    for (const id of index.notesIn(band)) consider(id)
  }
  return pick.best()?.id ?? null
}

/**
 * `nearestInDirection` among `ids` only, read once each: for a small set of candidates on a big
 * board (focus mode's shown notes), where the index's bands would read every hidden note in
 * them. O(ids).
 */
export function nearestAmong(
  state: { notes: ReadonlyMap<string, Note> },
  fromId: string,
  dir: Direction,
  ids: Iterable<string>,
  heightOf: (n: Note) => number = (n) => n.h,
): string | null {
  const pick = picker(state, fromId, dir, heightOf)
  if (pick === null) return null
  for (const id of ids) pick.consider(id)
  return pick.best()?.id ?? null
}

/** The scoring both searches share: `consider` each candidate, then read the `best`. */
function picker(
  state: { notes: ReadonlyMap<string, Note> },
  fromId: string,
  dir: Direction,
  heightOf: (n: Note) => number,
) {
  const from = state.notes.get(fromId)
  if (from === undefined) return null
  const o = centreOf(from, heightOf)
  const d = VECTOR[dir]
  let best: { id: string; score: number } | null = null
  const consider = (id: string): void => {
    if (id === fromId) return
    const n = state.notes.get(id)
    if (n === undefined) return
    const c = centreOf(n, heightOf)
    const vx = c.x - o.x
    const vy = c.y - o.y
    const dist = Math.hypot(vx, vy)
    if (dist === 0) return
    const angle = Math.acos(Math.min(1, Math.max(-1, (vx * d.x + vy * d.y) / dist)))
    if (angle > CONE) return
    const score = dist * (1 + angle / CONE)
    if (best === null || score < best.score || (score === best.score && id < best.id)) {
      best = { id, score }
    }
  }
  return { o, d, consider, best: (): { id: string; score: number } | null => best }
}

/** Height of a reading row, world px: notes whose tops fall in the same row read left to right. */
export const ROW_PX = 200

/** Reading order of two notes (rows of `ROW_PX`, then x, then id): negative when `a` comes first. */
export function readingRank(
  a: string,
  b: string,
  notes: ReadonlyMap<string, { readonly x: number; readonly y: number }>,
): number {
  const na = notes.get(a)
  const nb = notes.get(b)
  const dr = Math.floor((na?.y ?? 0) / ROW_PX) - Math.floor((nb?.y ?? 0) / ROW_PX)
  if (dr !== 0) return dr
  const dx = (na?.x ?? 0) - (nb?.x ?? 0)
  if (dx !== 0) return dx
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * `ids` in reading order: rows of 200 world px from the top, then x, then id. The keys are read
 * once per id; a new array, `ids` untouched. For the notes in view, never the whole board.
 */
export function readingOrder(
  ids: readonly string[],
  notes: ReadonlyMap<string, { readonly x: number; readonly y: number }>,
): string[] {
  const rows = ids.map((id) => Math.floor((notes.get(id)?.y ?? 0) / ROW_PX))
  const xs = ids.map((id) => notes.get(id)?.x ?? 0)
  const order = ids.map((_, k) => k)
  order.sort((a, b) => {
    const dr = (rows[a] as number) - (rows[b] as number)
    if (dr !== 0) return dr
    const dx = (xs[a] as number) - (xs[b] as number)
    if (dx !== 0) return dx
    const ia = ids[a] as string
    const ib = ids[b] as string
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })
  return order.map((k) => ids[k] as string)
}

/**
 * `next` (the order wanted) with every id that was in `prev` kept in its old relative place:
 * what is gone drops out, what is new goes after the nearest earlier kept id of `next`. A mounted
 * note that React moved in the DOM would lose the keyboard (an editor mid-composition, a focused
 * note), so while one holds it the list may grow and shrink but never reshuffle. O(n).
 */
export function stableOrder(prev: readonly string[], next: readonly string[]): string[] {
  const wanted = new Set(next)
  const kept = prev.filter((id) => wanted.has(id))
  const keptSet = new Set(kept)
  const head: string[] = []
  const after = new Map<string, string[]>()
  let anchor: string | null = null
  for (const id of next) {
    if (keptSet.has(id)) {
      anchor = id
    } else if (anchor === null) {
      head.push(id)
    } else {
      const list = after.get(anchor)
      if (list === undefined) after.set(anchor, [id])
      else list.push(id)
    }
  }
  const out = head
  for (const id of kept) {
    out.push(id)
    const list = after.get(id)
    if (list !== undefined) for (const n of list) out.push(n)
  }
  return out
}

/**
 * The camera that brings `rect` (world px) inside the viewport, `padPx` from its edges, moving
 * as little as it can (centred when it is larger than the view); null when it is in view already.
 */
export function revealCamera(c: Camera, viewport: Size, rect: Rect, padPx = 48): Camera | null {
  const v = visibleWorldRect(c, viewport, -padPx)
  const place = (pos: number, size: number, vpos: number, vsize: number) => {
    if (size >= vsize) return pos + size / 2 - vsize / 2
    if (pos < vpos) return pos
    if (pos + size > vpos + vsize) return pos + size - vsize
    return vpos
  }
  const x = place(rect.x, rect.w, v.x, v.w) - padPx / c.zoom
  const y = place(rect.y, rect.h, v.y, v.h) - padPx / c.zoom
  return x === c.x && y === c.y ? null : { x, y, zoom: c.zoom }
}

/** A key the board takes for the selection. */
export type SelectionCommand =
  | { kind: 'move'; dir: Direction }
  | { kind: 'nudge'; dir: Direction; step: 1 | 10 }
  | { kind: 'all' }

const ARROWS: Readonly<Record<string, Direction>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

/**
 * Arrows move the selection to the nearest note that way; Alt+arrows nudge it by 1 world px
 * (Shift: 10); ⌘A or Ctrl+A selects every note. Null in a typing target, where arrows and select
 * all are the field's own, and for any other chord.
 */
export function selectionKey(e: KeyLike): SelectionCommand | null {
  if (isTypingTarget(e.target)) return null
  const ctrl = e.ctrlKey === true
  const meta = e.metaKey === true
  const alt = e.altKey === true
  const dir = ARROWS[e.key]
  if (dir !== undefined) {
    if (ctrl || meta) return null
    if (alt) return { kind: 'nudge', dir, step: e.shiftKey ? 10 : 1 }
    return e.shiftKey ? null : { kind: 'move', dir }
  }
  if (ctrl !== meta && !alt && !e.shiftKey && letterOf(e) === 'a') return { kind: 'all' }
  return null
}
