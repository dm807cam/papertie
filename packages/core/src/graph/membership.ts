import type { BoardState } from '../state'

/**
 * Thread membership, indexed both ways. This is a membership graph: every note on a thread is one
 * step from every other note on it. Thread order (`noteIds`) is preserved in `notesByYarn` but
 * never affects distance.
 *
 * `yarnsByNote` has an entry for EVERY note on the board, with an empty set when the note has no
 * yarns. Consumers that only hold a `Membership` (such as `computeFocus`) rely on this to tell a
 * note that exists but is unconnected from one that no longer exists.
 */
export interface Membership {
  readonly yarnsByNote: ReadonlyMap<string, ReadonlySet<string>>
  readonly notesByYarn: ReadonlyMap<string, readonly string[]>
}

/** Build the membership index. Iterates the state's maps in insertion order, so output is deterministic. */
export function buildMembership(state: BoardState): Membership {
  const yarnsByNote = new Map<string, Set<string>>()
  for (const id of state.notes.keys()) yarnsByNote.set(id, new Set())
  const notesByYarn = new Map<string, readonly string[]>()
  for (const [yarnId, yarn] of state.yarns) {
    notesByYarn.set(yarnId, [...yarn.noteIds])
    for (const noteId of yarn.noteIds) yarnsByNote.get(noteId)?.add(yarnId)
  }
  return { yarnsByNote, notesByYarn }
}
