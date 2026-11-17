import { LIMITS, type Note, OpError } from '@papertie/core'
import {
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { BoardStore } from '../store/boardStore'
import { LABELS, textKey } from './noteCommands'
import type { EditorExit } from './sourceEditor'
import './refField.css'

export interface RefFieldProps {
  note: Note
  store: BoardStore
  onDone(how: EditorExit): void
  /** Set to the field's commit while it is mounted: the runtime's flush of the editor sends it. */
  flush: RefObject<(() => void) | null>
}

/**
 * A note's reference while the note is written on (lazy):
 * the bottom of the note's editor, under the hairline the ref is shown under. With no ref, a quiet
 * "Add reference" opens the field: it sits in the paper's bottom padding and takes no height, so
 * writing starting never moves or resizes the paper. A ref the note has shows in the field, which
 * is laid out as the ref reads (its face, measure and wrapping, grown to its lines by a mirror of
 * its text), so the paper keeps its height then too. Free text, line breaks
 * allowed, at most `maxNoteRef` characters, trimmed. It commits as it closes (a blur out of the
 * note, Esc, ⌘Enter, or the editor closing under it), coalesced into the writing session's
 * own undo step, and only a ref typed since the field opened: what it compares with is the ref
 * as it opened (the last it sent), never the note as it is now, so a close never sends a stale
 * value over an edit made meanwhile. Emptied, the ref goes.
 */
export default function RefField({ note, store, onDone, flush }: RefFieldProps) {
  const id = note.id
  const [open, setOpen] = useState(note.ref !== undefined)
  // The field's text, mirrored under it so it grows to its lines as the shown ref does.
  const [value, setValue] = useState(note.ref ?? '')
  const field = useRef<HTMLTextAreaElement>(null)
  // What it last sent (the ref as it opened at first), and what was typed since (null: nothing).
  const sent = useRef(note.ref ?? '')
  const typed = useRef<string | null>(null)
  const latest = useRef({ store, onDone })
  latest.current = { store, onDone }
  const focusing = useRef(false)

  const commit = () => {
    if (typed.current === null) return
    const v = typed.current.trim().slice(0, LIMITS.maxNoteRef).trimEnd()
    typed.current = null
    if (v === sent.current) return
    sent.current = v
    const s = latest.current.store
    try {
      s.commit([{ op: 'note.update', id, set: { ref: v === '' ? null : v } }], {
        coalesceKey: textKey(id),
        label: LABELS.edit,
      })
    } catch (e) {
      // The note went (a restore or an import took it): the editor is closing.
      if (!(e instanceof OpError) || s.getState().notes.has(id)) throw e
    }
  }
  const commitRef = useRef(commit)
  commitRef.current = commit

  // biome-ignore lint/correctness/useExhaustiveDependencies: made once; the commit is read live
  useLayoutEffect(() => {
    const send = () => commitRef.current()
    flush.current = send
    return () => {
      // The editor closing under it (a press elsewhere, a zoom): what was typed is kept.
      send()
      if (flush.current === send) flush.current = null
    }
  }, [])

  useLayoutEffect(() => {
    if (!open || !focusing.current) return
    focusing.current = false
    field.current?.focus({ preventScroll: true })
  }, [open])

  /** The focus leaving: within the note (its text), writing goes on; out of it, it ends. */
  const left = (e: FocusEvent<HTMLElement>) => {
    // "Add reference" giving the focus to the field it opens.
    if (focusing.current) return
    commit()
    const to = e.relatedTarget
    if (to === null && document.activeElement === e.currentTarget) return // another window
    const article = e.currentTarget.closest('article')
    if (to instanceof Node && article?.contains(to)) return
    latest.current.onDone('blur')
  }
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault()
      e.stopPropagation()
      commit()
      latest.current.onDone('escape')
    }
  }

  return (
    <div className={open ? 'note-ref-edit' : 'note-ref-edit note-ref-edit--add'}>
      {open ? (
        <div className="note-ref-grow" data-value={value}>
          <textarea
            ref={field}
            className="note-ref-input"
            aria-label="Reference"
            rows={1}
            maxLength={LIMITS.maxNoteRef}
            defaultValue={note.ref ?? ''}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              typed.current = e.target.value
              setValue(e.target.value)
            }}
            onBlur={left}
            onKeyDown={key}
          />
        </div>
      ) : (
        <button
          type="button"
          className="note-ref-add"
          onClick={() => {
            focusing.current = true
            setOpen(true)
          }}
          onBlur={left}
        >
          Add reference
        </button>
      )}
    </div>
  )
}
