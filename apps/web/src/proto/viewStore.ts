import type { Note } from '@papertie/core'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { LodMode } from '../canvas/lod'

/** The note being written on, as the editor opens on it. */
export interface EditTarget {
  noteId: string
  /** Where the caret starts, as an offset into the text; the end when absent. */
  caret?: number
  /**
   * The note's drawn height (world px) when editing began: the paper keeps at least that while
   * the editor is open, so it never shrinks under the writer's hand.
   */
  holdH?: number
  /** Whether the note was a heading (set centred) when editing began; kept while writing. */
  heading: boolean
}

/**
 * What the canvas mounts: culled note ids in paint order, the level of detail, the selection
 * and the note being edited.
 */
export interface ViewState {
  visible: string[]
  lod: LodMode
  selected: ReadonlySet<string>
  editing: EditTarget | null
  /**
   * The notes the canvas draws while it catches up with a board swapped in whole (each note as
   * drawn so far); null when it draws the store's.
   */
  drawn: ReadonlyMap<string, Note> | null
}

export type ViewStore = StoreApi<ViewState>

/**
 * One per canvas. The runtime writes it only on a recull, an LOD flip, a selection change or
 * when editing starts or stops; `NoteLayer` reads it.
 */
export function createViewStore(
  initial: ViewState = {
    visible: [],
    lod: 'full',
    selected: new Set(),
    editing: null,
    drawn: null,
  },
): ViewStore {
  return createStore<ViewState>()(() => initial)
}

/** Read a slice of the view from React. */
export function useView<T>(store: ViewStore, selector: (v: ViewState) => T): T {
  return useStore(store, selector)
}
