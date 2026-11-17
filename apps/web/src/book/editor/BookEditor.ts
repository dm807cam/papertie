/**
 * The writer's editor, behind one thin adapter (ADR-0007). It speaks editor changes, not core
 * ops: `editorOps.ts` maps between them. Offsets are UTF-16 code units into a block's
 * text; a mark covers `[from, to)`.
 */

/**
 * Core's block kinds. A `prompt` is a note to the writer drawn in the right margin beside
 * the block before it (inline where the margin is narrow); a `figure` is an image at the page's
 * measure, its text the caption. A `footnote` is a note after the paragraph that
 * anchors it.
 */
export type EditorKind = 'p' | 'h1' | 'h2' | 'quote' | 'li' | 'prompt' | 'figure' | 'footnote'
/**
 * Bold, italic, a card's passage (`c:` + its note id) or a footnote's anchor (`n:` + its
 * footnote block's id). A card mark or an anchor is never drawn in the text and never
 * read back from it: the engine keeps it through every edit as core does.
 */
export interface EditorMark {
  t: 'b' | 'i' | `c:${string}` | `n:${string}`
  from: number
  to: number
}
/**
 * At `at`, delete `del` code units, then insert `ins`. A change's splices apply in order. `takes`:
 * the marks `ins` takes, where a board's op says them (core's splice).
 */
export interface EditorSplice {
  at: number
  del: number
  ins: string
  takes?: EditorMark['t'][]
}
/** A figure's image: its asset, the card it came from, and its aspect (width / height). */
export interface EditorImage {
  assetId: string
  card?: string
  aspect: number
}
export interface EditorBlock {
  id: string
  kind: EditorKind
  text: string
  marks: readonly EditorMark[]
  /**
   * A figure's (only a figure has one). Its aspect is optional so that core's block is an
   * `EditorBlock` as it is (the model gives each figure its asset's aspect as it takes it in).
   */
  image?: Omit<EditorImage, 'aspect'> & { aspect?: number }
}
/**
 * A split keeps `id` on the head (`[0, at)`) and gives the tail `newId`; a merge appends `from`
 * to `into`, which keeps its id, and removes `from`.
 */
export type EditorChange =
  | {
      t: 'edit'
      id: string
      splices: EditorSplice[]
      addMarks?: EditorMark[]
      removeMarks?: EditorMark[]
    }
  | { t: 'split'; id: string; at: number; newId: string; kind: EditorKind }
  | { t: 'merge'; from: string; into: string }
  | { t: 'kind'; id: string; kind: EditorKind }
  | {
      t: 'create'
      id: string
      after: string | null
      kind: EditorKind
      text: string
      marks?: EditorMark[]
      /** A figure's image. */
      image?: EditorImage
    }
  | { t: 'delete'; id: string }
  /** A figure shows another image (or another card's). */
  | { t: 'image'; id: string; image: { assetId: string; card?: string } }
export interface BookEditor {
  mount(
    el: HTMLElement,
    blocks: readonly EditorBlock[],
    opts: {
      newBlockId(): string
      /** `label`: the undo step's own name (a footnote's), else the writing's. */
      onChange(changes: EditorChange[], meta: { coalesceKey?: string; label?: string }): void
      onHistory(dir: 'undo' | 'redo'): void // ⌘Z / ⇧⌘Z and beforeinput historyUndo/historyRedo
    },
  ): void
  /** Remote or undo changes, without moving the caret or breaking a composition. */
  apply(changes: readonly EditorChange[]): void
  /** Replace the whole book (History restore, import, a full reload). */
  reset(blocks: readonly EditorBlock[]): void
  window(range: { fromBlockId: string; toBlockId: string }): void
  selection(): { blockId: string; offset: number } | null
  focusAt(pos: { blockId: string; offset: number }): void
  composing(): boolean
  destroy(): void
}
