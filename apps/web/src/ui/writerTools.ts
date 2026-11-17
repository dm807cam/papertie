import type { ComponentType } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { EditorKind } from '../book/editor/BookEditor'
import type { BlockEngine } from '../book/editor/blockEngine'
import type { Pos } from '../book/editor/model'

/** Where the writing tools stand: the panel's column, or the mini-bar's row. */
export type ToolsBar = 'sidebar' | 'minibar'

/** What the book's selection offers the writing tools, as last read (once per selection change). */
export interface WriterSelection {
  /** The caret's (or every selected) block's kind; null for a mix, or with no caret in the book. */
  kind: EditorKind | null
  b: boolean
  i: boolean
  /** The caret is in a block of the book (Text style acts on it). */
  at: boolean
  /** Text is selected (Bold, Italic, Footnote and Pin act on it). */
  has: boolean
}

export interface WriterToolsState {
  /**
   * The open book's writing tools, set by the writer (its chunk holds their code); null while no
   * book is open in the writer.
   */
  Tools: ComponentType<{ bar: ToolsBar }> | null
  /** How the open book lies (null: none open). */
  layout: 'split' | 'full' | null
  /** Beside the board: whether the user works in the book or on the board now. */
  working: 'book' | 'board'
  engine: BlockEngine | null
  /** The selection to the board (`move`: out of the book); null where the board takes none. */
  pin: ((move: boolean) => void) | null
  sel: WriterSelection
  /** The last range the selection had in the book: put back when the browser dropped it. */
  last: { a: Pos; b: Pos } | null
}

export const NO_SELECTION: WriterSelection = {
  kind: null,
  b: false,
  i: false,
  at: false,
  has: false,
}

export const writerTools = createStore<WriterToolsState>()(() => ({
  Tools: null,
  layout: null,
  working: 'book',
  engine: null,
  pin: null,
  sel: NO_SELECTION,
  last: null,
}))

export function useWriterTools<T>(pick: (s: WriterToolsState) => T): T {
  return useStore(writerTools, pick)
}

/**
 * What the sidebar shows: the board's tools, or the writer's. Under a book at full width
 * (`books === 'book'`) the writer's; beside the board, those of where the user works; under the
 * shelf and on the board alone, the board's.
 */
export function useToolsMode(books: boolean | 'book'): 'board' | 'book' {
  const beside = useWriterTools((s) => s.layout === 'split' && s.working === 'book')
  if (books === 'book') return 'book'
  return books === false && beside ? 'book' : 'board'
}
