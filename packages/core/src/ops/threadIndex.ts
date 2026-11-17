/**
 * Internal: which threads name each note, so a note delete finds its threads without scanning
 * every thread. An index belongs to one yarn map and is cached for it; a draft carries it over
 * to the yarn map it makes by re-indexing only the threads it wrote.
 */
import { PMap, type TransientMap } from '../pmap'
import type { Yarn } from '../schema/records'

/** Note id → the keys of the threads naming it, in the order they were indexed. */
export type ThreadIndex = PMap<string, readonly string[]>

const cache = new WeakMap<ReadonlyMap<string, Yarn>, ThreadIndex>()

/** The index of `yarns`: cached, and built in one pass over the threads the first time. */
export function threadIndex(yarns: ReadonlyMap<string, Yarn>): ThreadIndex {
  let ix = cache.get(yarns)
  if (ix === undefined) {
    const byNote = new Map<string, string[]>()
    for (const [key, yarn] of yarns) {
      for (const noteId of new Set(yarn.noteIds)) {
        const keys = byNote.get(noteId)
        if (keys) keys.push(key)
        else byNote.set(noteId, [key])
      }
    }
    ix = PMap.from<string, readonly string[]>(byNote)
    cache.set(yarns, ix)
  }
  return ix
}

export function hasThreadIndex(yarns: ReadonlyMap<string, Yarn>): boolean {
  return cache.has(yarns)
}

export function keepThreadIndex(yarns: ReadonlyMap<string, Yarn>, ix: ThreadIndex): void {
  cache.set(yarns, ix)
}

/** Update `t` for the thread under `key` changing from `before` to `after` (absent: none). */
export function reindex(
  t: TransientMap<string, readonly string[]>,
  key: string,
  before: Yarn | undefined,
  after: Yarn | undefined,
): void {
  const was = new Set(before?.noteIds)
  const is = new Set(after?.noteIds)
  for (const noteId of was) {
    if (is.has(noteId)) continue
    const keys = (t.get(noteId) ?? []).filter((k) => k !== key)
    if (keys.length > 0) t.set(noteId, keys)
    else t.delete(noteId)
  }
  for (const noteId of is) if (!was.has(noteId)) t.set(noteId, [...(t.get(noteId) ?? []), key])
}
