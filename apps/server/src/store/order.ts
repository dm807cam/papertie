import type { Note } from '@papertie/core'

/** The canonical file's orders (serializeBoard's): ids by code unit, notes by z then id. */
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
export const byId = (a: { id: string }, b: { id: string }) => cmp(a.id, b.id)
export const byZ = (a: Note, b: Note) => a.z - b.z || cmp(a.id, b.id)
