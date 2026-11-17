import { type BoardState, type PaletteToken, threadsOf } from '@papertie/core'
import { noteLabel } from '../selection/selection'
import { dyeName } from './yarnFlows'

/** The most notes named per colour; the rest are counted. */
const NAMED_MAX = 5

/** `["a"]` → `"a"`; two → `"a" and "b"`; more → `"a", "b" and "c"`. */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * What a note's accessible description says of its threads, which are drawn on the canvas and
 * nowhere in the DOM: the notes it is tied to, by each thread colour, in English
 * (`Tied to "Spring trip" and "Packing list" by indigo yarn.`); '' for a note on no thread.
 * A note on two threads of a colour is named once for it. Read from the note's own threads (the
 * thread index kept with the yarn map), so it costs the size of those threads, never the board.
 */
export function tiedToCopy(state: BoardState, noteId: string): string {
  return tiedTo(state, noteId).copy
}

/** {@link tiedToCopy}, with the notes it names (by id, at most five per colour). */
export function tiedTo(state: BoardState, noteId: string): { copy: string; named: string[] } {
  const threads = threadsOf(state, noteId)
  if (threads.length === 0) return { copy: '', named: [] }
  const byColour = new Map<PaletteToken, Set<string>>()
  for (const y of threads) {
    let others = byColour.get(y.color)
    if (others === undefined) {
      others = new Set()
      byColour.set(y.color, others)
    }
    for (const id of y.noteIds) if (id !== noteId) others.add(id)
  }
  const groups: string[] = []
  const named: string[] = []
  for (const [colour, ids] of byColour) {
    if (ids.size === 0) continue
    const names: string[] = []
    for (const id of ids) {
      if (names.length === NAMED_MAX) break
      // Named as the note names itself (its `aria-label`), so the two always match.
      names.push(`“${noteLabel(state.notes.get(id)?.text ?? '')}”`)
      named.push(id)
    }
    const more = ids.size - names.length
    if (more > 0) names.push(`${more} more ${more === 1 ? 'note' : 'notes'}`)
    groups.push(`${list(names)} by ${dyeName(colour)} yarn`)
  }
  return { copy: groups.length === 0 ? '' : `Tied to ${groups.join(', and to ')}.`, named }
}
