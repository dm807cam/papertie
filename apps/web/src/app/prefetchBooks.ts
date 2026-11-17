import { lazyChunk } from './ChunkBoundary'

/**
 * The book screens' chunks: the shelf and the writer, each loaded when first opened or,
 * once the board's opening is `ready`, at idle (`prefetchBookChunks`), so the Books button opens
 * the shelf in the very frame it is pressed. No module of the board's chunk imports them by value
 * (`pnpm budget` fails if one does).
 */
export const ShelfChunk = lazyChunk(() => import('../book/ShelfScreen').then((m) => m.ShelfScreen))
export const BookChunk = lazyChunk(() => import('../book/BookScreen').then((m) => m.BookScreen))
/** The reverse mark's popover: a dynamic entry of its own. */
export const UsesChunk = lazyChunk(() => import('../book/uses/CardUses').then((m) => m.CardUses))

/** The card whose reverse mark is open, and the mark (its anchor); null when none is. */
export type UsesAt = { noteId: string; anchor: HTMLElement } | null
let usesAt: UsesAt = null
const usesFns = new Set<() => void>()

/** Open the reverse mark's popover for a card (a note's `.note-ink`), or close it (null). */
export function showUses(at: UsesAt): void {
  if (at?.noteId === usesAt?.noteId && at?.anchor === usesAt?.anchor) return
  usesAt = at
  for (const fn of usesFns) fn()
}

/** What `showUses` set, followed (`useSyncExternalStore`). */
export const usesShown = {
  get: (): UsesAt => usesAt,
  subscribe(fn: () => void): () => void {
    usesFns.add(fn)
    return () => usesFns.delete(fn)
  },
}

let asked = false
let failed = 0

/**
 * Load the shelf's and the writer's chunks ahead of their first use (once: later calls do
 * nothing). A chunk that fails to load is only counted in the console; opening its screen tries
 * again.
 */
export function prefetchBookChunks(): void {
  if (asked) return
  asked = true
  for (const chunk of [ShelfChunk, BookChunk, UsesChunk]) {
    chunk.load().catch(() => {
      failed++
      console.warn(`book chunks: ${failed} did not prefetch`)
    })
  }
}
