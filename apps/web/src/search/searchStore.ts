import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

/**
 * Whether the search palette is open. One palette per page, so this is shared: ⌘K, the sidebar's
 * search button and anything else that wants search call `openSearch`, and `SearchPalette` (on
 * the canvas) follows it.
 */
const searchStore = createStore<{ open: boolean }>(() => ({ open: false }))

export const openSearch = (): void => searchStore.setState({ open: true })
export const closeSearch = (): void => searchStore.setState({ open: false })
export const toggleSearch = (): void => searchStore.setState((s) => ({ open: !s.open }))

export const isSearchOpen = (): boolean => searchStore.getState().open

/** Call `fn` each time search opens (a sheet it replaces puts itself away). Returns the unsubscribe. */
export const onSearchOpen = (fn: () => void): (() => void) =>
  searchStore.subscribe((s, prev) => {
    if (s.open && !prev.open) fn()
  })

export function useSearchOpen(): boolean {
  return useStore(searchStore, (s) => s.open)
}
