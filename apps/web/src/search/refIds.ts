import { mapChangesWithin, type Note } from '@papertie/core'
import type { BoardStore } from '../store/boardStore'

/** More notes changed than this since the set was last read, and it is made again from all. */
const CHANGES_MAX = 4096

const kept = new WeakMap<BoardStore, { notes: ReadonlyMap<string, Note>; ids: Set<string> }>()

/**
 * The ids of the notes on `store`'s board that have a ref: the ref picker's set. Kept beside the store and brought up to date as it is read, by what changed since
 * (`mapChangesWithin`: O(changes × log n)); a board loaded again is read whole. Small (the notes
 * with a ref), never a subscription: nothing is done between reads.
 */
export function refIdsOf(store: BoardStore): ReadonlySet<string> {
  const notes = store.getState().notes
  const k = kept.get(store)
  if (k?.notes === notes) return k.ids
  const changes = k === undefined ? null : mapChangesWithin(k.notes, notes, CHANGES_MAX)
  if (k === undefined || changes === null) {
    const ids = new Set<string>()
    for (const n of notes.values()) if (n.ref !== undefined) ids.add(n.id)
    kept.set(store, { notes, ids })
    return ids
  }
  const ids = new Set(k.ids)
  for (const id of changes.deleted) ids.delete(id)
  for (const id of changes.set) {
    if (notes.get(id)?.ref !== undefined) ids.add(id)
    else ids.delete(id)
  }
  kept.set(store, { notes, ids })
  return ids
}
