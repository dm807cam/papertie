import type { Note } from '@papertie/core'
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { usePrefs } from '../app/prefs'
import type { EditorExit } from '../notes/NoteEditor'
import { type NoteEditing, NoteView, SELECTED_MARK_ID } from '../notes/NoteView'
import type { EditorHandle } from '../notes/sourceEditor'
import { useView } from '../proto/viewStore'
import { type BoardStore, useBoard } from '../store/boardStore'
import { cardUsesFor } from '../sync/books/cardUses'
import type { CanvasRuntime } from './runtime'

const MemoNoteView = memo(NoteView)

/** The page has marked its first paint of notes. */
let painted = false

/**
 * Mark the page's first notes drawn (`papertie:first-paint`, a User Timing mark naming them), so the
 * time to it from navigation can be read. Once per page, two animation frames after they are in
 * the DOM: the first frame paints them, the second starts once that paint is done.
 */
function markFirstPaint(shown: readonly Note[]): void {
  if (painted || shown.length === 0 || typeof requestAnimationFrame !== 'function') return
  painted = true
  const ids = shown.map((n) => n.id)
  requestAnimationFrame(() =>
    requestAnimationFrame(() => performance.mark?.('papertie:first-paint', { detail: { ids } })),
  )
}

/**
 * The culled notes inside `.world`, in the runtime's DOM order: reading order (rows of 200 world
 * px, then x), which is the tab order. What paints over what is not the DOM's to say; the
 * runtime ranks the notes by z and gives each its `--stack`, the z-index. Each is a memoised
 * `NoteView`, so only notes whose record, selection or the LOD changed re-render; the layer
 * itself renders only on a recull, an LOD flip, a selection change or a board change. Notes read
 * the floating origin's anchor when they render; a rebase re-places them outside React. A
 * ResizeObserver reports rendered heights. Drags move notes outside React (`writeNoteStyle`); a
 * render during one places the moved notes through the overrides. The note being edited gets
 * its editor; leaving it with Esc gives the keyboard back to the note, still selected.
 */
export function NoteLayer({ runtime, store }: { runtime: CanvasRuntime; store: BoardStore }) {
  const stored = useBoard(store, (s) => s.notes)
  // While the canvas catches up with a board swapped in whole, the notes it draws.
  const drawn = useView(runtime.view, (v) => v.drawn)
  const notes = drawn ?? stored
  const visible = useView(runtime.view, (v) => v.visible)
  const lod = useView(runtime.view, (v) => v.lod)
  const selected = useView(runtime.view, (v) => v.selected)
  const target = useView(runtime.view, (v) => v.editing)
  const rotation = usePrefs((p) => p.tilt)
  // Which cards shelf books use: each note follows its own, so a stamp wakes only the
  // notes it changed and this layer not at all.
  const uses = useMemo(() => cardUsesFor(store), [store])
  const editing = useMemo((): NoteEditing | undefined => {
    if (target === null) return undefined
    const { noteId } = target
    return {
      store,
      ...(target.caret === undefined ? {} : { caret: target.caret }),
      ...(target.holdH === undefined ? {} : { holdH: target.holdH }),
      heading: target.heading,
      register: (handle: EditorHandle | null) => runtime.registerEditor(noteId, handle),
      onDone: (how: EditorExit) => {
        runtime.stopEditing(noteId)
        // Esc: the note keeps the keyboard (Enter writes again, Delete removes it).
        if (how === 'escape') runtime.noteEls.get(noteId)?.focus({ preventScroll: true })
      },
    }
  }, [target, store, runtime])
  const shown = useMemo(() => {
    const out: Note[] = []
    for (const id of visible) {
      const n = notes.get(id)
      if (n !== undefined) out.push(n)
    }
    return out
  }, [visible, notes])
  const observer = useRef<ResizeObserver | null>(null)
  useLayoutEffect(() => markFirstPaint(shown), [shown])

  const registerEl = useCallback(
    (id: string, el: HTMLElement | null) => {
      const prev = runtime.noteEls.get(id)
      if (prev !== undefined && prev !== el) observer.current?.unobserve(prev)
      if (el === null) runtime.noteEls.delete(id)
      else {
        runtime.noteEls.set(id, el)
        runtime.noteMounted(id, el)
        observer.current?.observe(el)
      }
    },
    [runtime],
  )

  useLayoutEffect(() => {
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        const id = el.dataset.noteId
        if (id === undefined || runtime.noteEls.get(id) !== el) continue
        runtime.measured(id, entry.borderBoxSize[0]?.blockSize ?? el.offsetHeight)
      }
    })
    observer.current = ro
    for (const el of runtime.noteEls.values()) ro.observe(el)
    return () => {
      ro.disconnect()
      observer.current = null
    }
  }, [runtime])

  return [
    // Read aloud for each selected note that points at it; there to be referred to, not seen.
    <span
      key="selected-mark"
      id={SELECTED_MARK_ID}
      className="note-selected-mark"
      data-selected-mark
    >
      Selected
    </span>,
    ...shown.map((note) => (
      <MemoNoteView
        key={note.id}
        note={runtime.overrides.effective(note)}
        lod={lod}
        rotation={rotation}
        selected={selected.has(note.id)}
        anchorOf={runtime.anchorOf}
        registerEl={registerEl}
        editing={target?.noteId === note.id ? editing : undefined}
        tied={runtime.tied}
        sides={runtime.edgeSides}
        uses={uses}
      />
    )),
  ]
}
