import {
  type BoardState,
  type ClientOp,
  LIMITS,
  type Note,
  OpError,
  type Yarn,
} from '@papertie/core'
import { topologyOf } from '../canvas/attach'
import type { Rect } from '../canvas/types'

/** Merging a dragged note into the one it is held beside. */
export const MERGE = {
  /** Screen px the facing edges may lie apart. */
  gapPx: 18,
  /** Screen px the papers may overlap and still be side by side (they touch). */
  touchPx: 2,
  /** Share of the shorter note's side the two must lie alongside each other. */
  overlapShare: 0.4,
  /** How long (ms) the note is held there before a release merges. */
  dwellMs: 250,
  /** What notices and undo announcements call a merge. */
  label: 'merge',
} as const

/** Where the dragged note lies, seen from the note it would merge into. */
export type MergeSide = 'left' | 'right' | 'above' | 'below'

/**
 * How two papers face each other: the side, the gap between the facing edges (world px; down to
 * minus the touch allowance) and the stretch [lo, hi] they share along those edges.
 */
export interface Facing {
  side: MergeSide
  gap: number
  lo: number
  hi: number
}

export interface MergeTarget extends Facing {
  id: string
}

/**
 * How `dragged` faces `target` (unturned rects, world px) at camera zoom `zoom`, or null when it
 * does not: the facing edges no more than `MERGE.gapPx` screen px apart, overlapping by no more
 * than `MERGE.touchPx`, and alongside each other for `MERGE.overlapShare` of the shorter side.
 */
export function facing(dragged: Rect, target: Rect, zoom: number): Facing | null {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1
  const maxGap = MERGE.gapPx / z
  const touch = MERGE.touchPx / z
  const sides: Array<[MergeSide, number, 'x' | 'y']> = [
    ['right', dragged.x - (target.x + target.w), 'y'],
    ['left', target.x - (dragged.x + dragged.w), 'y'],
    ['below', dragged.y - (target.y + target.h), 'x'],
    ['above', target.y - (dragged.y + dragged.h), 'x'],
  ]
  for (const [side, gap, along] of sides) {
    if (!(gap >= -touch && gap <= maxGap)) continue
    const [a, b] = along === 'y' ? [dragged.y, target.y] : [dragged.x, target.x]
    const [la, lb] = along === 'y' ? [dragged.h, target.h] : [dragged.w, target.w]
    const lo = Math.max(a, b)
    const hi = Math.min(a + la, b + lb)
    if (hi - lo >= MERGE.overlapShare * Math.min(la, lb)) return { side, gap, lo, hi }
  }
  return null
}

/**
 * The note `dragged` would merge into among `candidates`: the smallest gap (a touch counts as
 * none), then the longest shared stretch, then the lower id. `accept` leaves candidates out.
 */
export function pickTarget(
  dragged: Rect,
  candidates: Iterable<{ id: string; rect: Rect }>,
  zoom: number,
  accept: (id: string, side: MergeSide) => boolean = () => true,
): MergeTarget | null {
  let best: MergeTarget | null = null
  for (const c of candidates) {
    const f = facing(dragged, c.rect, zoom)
    if (f === null || !accept(c.id, f.side)) continue
    if (best === null || better(f, c.id, best)) best = { ...f, id: c.id }
  }
  return best
}

function better(f: Facing, id: string, than: MergeTarget): boolean {
  const g = Math.max(0, f.gap)
  const h = Math.max(0, than.gap)
  if (g !== h) return g < h
  const l = f.hi - f.lo
  const m = than.hi - than.lo
  return l !== m ? l > m : id < than.id
}

/** Whether `dragged` may merge into `target`: two notes, and neither a photo. */
export function mergeable(dragged: Note, target: Note): boolean {
  return dragged.id !== target.id && dragged.image === null && target.image === null
}

const BLANK = /^\s*$/

/**
 * `first` then `second` with exactly one blank line between them: blank lines at the seam (the
 * end of `first`, the start of `second`) go, the rest stays as written. A blank text adds nothing.
 */
export function mergedText(first: string, second: string): string {
  const a = first.split('\n')
  const b = second.split('\n')
  while (a.length > 0 && BLANK.test(a.at(-1) as string)) a.pop()
  while (b.length > 0 && BLANK.test(b[0] as string)) b.shift()
  if (a.length === 0) return BLANK.test(second) ? '' : second
  if (b.length === 0) return BLANK.test(first) ? '' : first
  return `${a.join('\n')}\n\n${b.join('\n')}`
}

/** The merged text: the dragged note's after the target's when it lies right of or below it. */
export function mergeText(dragged: Note, target: Note, side: MergeSide): string {
  return side === 'right' || side === 'below'
    ? mergedText(target.text, dragged.text)
    : mergedText(dragged.text, target.text)
}

/** Whether the merged text keeps within the text limit. */
export function mergeFits(dragged: Note, target: Note, side: MergeSide): boolean {
  if (dragged.text.length + target.text.length + 2 <= LIMITS.maxTextLength) return true
  return mergeText(dragged, target, side).length <= LIMITS.maxTextLength
}

/**
 * Re-tie thread `yarn` from note `from` to note `to`: `to` takes `from`'s place, or, where the
 * thread holds `to` already, `from` is untied (a thread left with one note goes, as core does).
 * A thread of more than two notes loses `from` first, so a full thread never overflows; a
 * two-note thread takes `to` first, so it never drops to one.
 */
export function retieOps(yarn: Yarn, from: string, to: string): ClientOp[] {
  const ids = yarn.noteIds
  const at = ids.indexOf(from)
  if (at === -1) return []
  const remove: ClientOp = { op: 'yarn.removeNote', id: yarn.id, noteId: from }
  if (ids.includes(to)) return [remove]
  if (ids.length > 2) {
    const afterNoteId = at === 0 ? null : (ids[at - 1] as string)
    return [remove, { op: 'yarn.insertNote', id: yarn.id, noteId: to, afterNoteId }]
  }
  return [{ op: 'yarn.insertNote', id: yarn.id, noteId: to, afterNoteId: from }, remove]
}

/**
 * After {@link retieOps} has put `to` in `from`'s place on `yarn`: the pin `yarn` had on `from` (a
 * shared pin's key, or the hanging pin) goes on with it to `to`, so threads that shared a pin on
 * the dragged note share one on the merged note. A thread that held both notes keeps the pin it
 * had on `to`.
 */
export function carryPinOps(yarn: Yarn, from: string, to: string): ClientOp[] {
  const key = yarn.pins?.[from]
  if (key === undefined || yarn.noteIds.includes(to) || !yarn.noteIds.includes(from)) return []
  const { [from]: _gone, ...rest } = yarn.pins as Record<string, string>
  return [{ op: 'yarn.update', id: yarn.id, set: { pins: { ...rest, [to]: key } } }]
}

/**
 * The batch that merges note `draggedId` into `targetId`, lying on `side` of it: the target
 * takes the merged text (keeping its place, size, paper and decoration; its paper grows to the
 * text as it does while writing), every thread of the dragged note is re-tied to the target
 * (with the pin it had there: {@link carryPinOps}), and the dragged note is deleted. Its threads come from the memoised topology, not a board walk.
 */
export function mergeOps(
  s: BoardState,
  draggedId: string,
  targetId: string,
  side: MergeSide,
): ClientOp[] {
  const dragged = s.notes.get(draggedId)
  const target = s.notes.get(targetId)
  if (dragged === undefined || target === undefined) return []
  const ops: ClientOp[] = []
  const text = mergeText(dragged, target, side)
  if (text !== target.text) ops.push({ op: 'note.update', id: targetId, set: { text } })
  const yarns = new Set<string>()
  for (const e of topologyOf(s).byNote.get(draggedId) ?? []) yarns.add(e.ref.yarnId)
  for (const id of yarns) {
    const yarn = s.yarns.get(id)
    if (yarn !== undefined) {
      ops.push(...retieOps(yarn, draggedId, targetId), ...carryPinOps(yarn, draggedId, targetId))
    }
  }
  ops.push({ op: 'note.delete', id: draggedId })
  return ops
}

/** How long the merged note's name may be when it is said. */
const SAID_MAX = 40

/** What is said once a merge lands: the merged note named by its first line. */
export function mergedCopy(text: string): string {
  const line = text
    .split('\n')
    .find((l) => !BLANK.test(l))
    ?.trim()
  if (line === undefined) return 'Merged the notes'
  const name = line.length > SAID_MAX ? `${line.slice(0, SAID_MAX)}…` : line
  return `Merged into “${name}”`
}

/** Why a merge was refused, in words for the live region; undefined for a bug (not an OpError). */
export function mergeRefusal(err: unknown): string | undefined {
  if (!(err instanceof OpError)) return undefined
  if (err.code === 'not-found') return 'Couldn’t merge: that note is no longer on the board'
  return 'Couldn’t merge the notes'
}
