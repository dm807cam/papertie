import { LIMITS, type Note, OpError } from '@papertie/core'
import { useLayoutEffect, useRef } from 'react'
import { announce } from '../app/liveRegion'
import type { BoardStore } from '../store/boardStore'
import { setNoteText } from './noteCommands'
import { textOffset } from './noteText'
import { caretPointAt, type EditorExit, type EditorHandle, SourceEditor } from './sourceEditor'

export type { EditorExit } from './sourceEditor'

/** Said once each time typing meets the text limit. */
export const TEXT_CAP_MESSAGE = 'Notes hold up to 20,000 characters.'

export interface NoteEditorProps {
  note: Note
  store: BoardStore
  /** Where the caret starts, as an offset into the text; after the last shown line when absent. */
  caret?: number
  /** The title's measure, px (`titleWidth`): what its size is decided in. */
  textWidth: number
  onDone(how: EditorExit): void
  /** Hands the runtime the editor while it is mounted (null on unmount). */
  register?(handle: EditorHandle | null): void
}

/** The note's text as a textarea or the editor holds it: line breaks as `\n`. */
const asValue = (text: string) => text.replace(/\r\n?/g, '\n')

/**
 * Where a click at client point (x, y) on note element `root`, as rendered (title, bullets and
 * body, each a `[data-block]` holding its shown text), falls in the note's `text`: the editor's
 * caret. The end of the text when the point is on no block, or the browser cannot say.
 */
export function caretOffsetAt(root: Element, x: number, y: number, text: string): number {
  const end = asValue(text).length
  const p = caretPointAt(root.ownerDocument, x, y)
  if (p === null || !root.contains(p.node)) return end
  const isText = p.node.nodeType === Node.TEXT_NODE
  const el = isText ? p.node.parentElement : (p.node as Element)
  const block = el?.closest<HTMLElement>('[data-block]')
  if (!block || !root.contains(block)) return end
  // On the block element itself: before its text, or after it.
  const at = isText ? p.offset : p.offset > 0 ? (block.textContent ?? '').length : 0
  return textOffset(text, Number(block.dataset.block), at)
}

/**
 * The note's text, editable in place of the rendered text and in its typography (a
 * `SourceEditor`): the title, subtitle, bullets and body keep their faces, sizes and leading, so
 * nothing moves when writing starts. The field is a `.note-text` like the rendered one (motif
 * margins, a heading's centring, a print's caption face all apply as there).
 *
 * - Every edit commits the whole text (`setNoteText`: coalesced under `text:<id>`, label `edit`).
 *   An IME composition commits once it ends, and Enter and Esc are its own until then.
 * - The editor owns its text once open: a re-render (a remote change of the note) never resets
 *   it, so neither a composition nor the caret is disturbed.
 * - At most `LIMITS.maxTextLength` characters; meeting the limit says so once.
 */
export function NoteEditor({ note, store, caret, textWidth, onDone, register }: NoteEditorProps) {
  const ref = useRef<HTMLDivElement>(null)
  // Read at mount only: from here the editor holds the text.
  const initial = useRef({ text: note.text, caret, textWidth }).current
  const latest = useRef({ store, onDone, register })
  latest.current = { store, onDone, register }
  const id = note.id

  // biome-ignore lint/correctness/useExhaustiveDependencies: made once, when the editor opens
  useLayoutEffect(() => {
    const root = ref.current
    if (root === null) return
    let capped = false
    const editor = new SourceEditor(root, {
      text: initial.text,
      textWidth: initial.textWidth,
      commit: (text) => {
        if (text.length < LIMITS.maxTextLength) capped = false
        try {
          setNoteText(latest.current.store, id, text)
        } catch (e) {
          // The note went (a restore or an import took it): the editor is closing. Anything else is
          // a fault, not a reason to lose the writing silently.
          if (!(e instanceof OpError) || latest.current.store.getState().notes.has(id)) throw e
        }
      },
      capped: () => {
        if (capped) return
        capped = true
        announce(TEXT_CAP_MESSAGE)
      },
      done: (how) => latest.current.onDone(how),
      // To the note's own ref field: still writing.
      keeps: (to) =>
        to instanceof Element &&
        to.closest('.note-ref-edit') !== null &&
        root.closest('article')?.contains(to) === true,
    })
    editor.focus(initial.caret)
    latest.current.register?.({ flush: () => editor.flush(), focusEnd: () => editor.focus() })
    return () => {
      latest.current.register?.(null)
      editor.dispose()
    }
  }, [])

  return (
    // A textarea sets one face for every line: the note's lines each keep their own.
    // biome-ignore lint/a11y/useSemanticElements: an editable field with per-line typography
    <div
      ref={ref}
      className="note-text note-edit"
      role="textbox"
      tabIndex={0}
      aria-multiline="true"
      aria-label="Note text"
      spellCheck
    />
  )
}
