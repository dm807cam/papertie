import type { ClientOp, Note } from '@papertie/core'
import { clampCoord } from '../notes/noteCommands'
import { type NoteBlock, parseNoteText } from '../notes/noteText'

/** How a set of ids joins the selection: replaces it, is added to it, or flips in it. */
export type SelectMode = 'replace' | 'add' | 'toggle'

/**
 * The selection after `ids` are applied to `current` under `mode`. A new set every time: the
 * runtime tells a change by identity, and a view that holds the old set must not see it mutate.
 */
export function nextSelection(
  current: ReadonlySet<string>,
  ids: Iterable<string>,
  mode: SelectMode,
): ReadonlySet<string> {
  if (mode === 'replace') return new Set(ids)
  const next = new Set(current)
  for (const id of ids) {
    if (mode === 'add' || !next.delete(id)) next.add(id)
  }
  return next
}

/** What a screen reader says of a selection of several notes (said once, when it is made). */
export const selectedCopy = (n: number): string => `Selected ${n} notes`

/** What a screen reader says of a group moved by key or by drag. */
export const movedCopy = (n: number): string => (n === 1 ? 'Moved 1 note' : `Moved ${n} notes`)

const LABEL_MAX = 80

/** A note's name for assistive tech from its parsed text: the first line as shown, or "Empty note". */
export function blocksLabel(blocks: readonly NoteBlock[]): string {
  const first = blocks[0]?.text.replace(/\s+/g, ' ').trim() ?? ''
  if (first === '') return 'Empty note'
  return first.length > LABEL_MAX ? `${first.slice(0, LABEL_MAX)}…` : first
}

/** A note's name for assistive tech: its first line as the rendering shows it, or "Empty note". */
export const noteLabel = (text: string): string => blocksLabel(parseNoteText(text))

/**
 * One `note.update {x, y}` per note of `ids` that moves by (`dx`, `dy`) world px, kept inside the
 * coordinate limits; empty when none does. The stacking order is left as it is: a nudge is not a
 * lift. Ids that are not on the board are skipped.
 */
export function nudgeOps(
  notes: ReadonlyMap<string, Note>,
  ids: Iterable<string>,
  dx: number,
  dy: number,
): ClientOp[] {
  const ops: ClientOp[] = []
  for (const id of ids) {
    const n = notes.get(id)
    if (n === undefined) continue
    const x = clampCoord(n.x + dx, n.w)
    const y = clampCoord(n.y + dy, n.h)
    if (x !== n.x || y !== n.y) ops.push({ op: 'note.update', id, set: { x, y } })
  }
  return ops
}
