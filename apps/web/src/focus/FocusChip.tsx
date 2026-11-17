import type { FocusResult } from '@papertie/core'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { announce } from '../app/liveRegion'
import type { CanvasRuntime } from '../canvas/runtime'
import { Picker } from '../search/LazyPicker'
import type { BoardStore } from '../store/boardStore'
import { MOTION } from '../styles/motion'
import {
  bindFocusHash,
  deeper,
  type FocusState,
  MAX_STEPS,
  shallower,
  withDepth,
  withInclude,
} from './focusMode'
import './focus.css'

type ChipRuntime = Pick<
  CanvasRuntime,
  'focusView' | 'focusState' | 'setFocus' | 'onFocusChange' | 'selection' | 'noteEls' | 'els'
>

/** Give the keyboard to the selected note, or else to the board itself. */
function handBack(rt: ChipRuntime): void {
  const [id] = rt.selection
  const note = id === undefined ? undefined : rt.noteEls.get(id)
  if (note?.isConnected) {
    note.focus({ preventScroll: true })
    return
  }
  const root = rt.els.root
  // The board is not a tab stop; it takes the focus from script only.
  if (!root.hasAttribute('tabindex')) root.tabIndex = -1
  root.focus({ preventScroll: true })
}

/** A focus the chip shows. */
interface Shown {
  state: FocusState
  result: FocusResult
}

const sameNotes = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

const stepsLabel = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`

/**
 * The focus chip: a paper tag at the board's bottom centre while focus is on, reading
 * `Focus · {n} step(s)`, with − and + (depth 1 to 3), All (the whole connected component),
 * Bring in… (the note picker, `multi`: each note picked is shown, never expanded from) and ✕
 * (Esc). It also keeps focus in the URL hash (`bindFocusHash`), from the moment the board
 * opens. It renders only when the focus changes, never with the camera. Leaving focus, it sinks
 * away (as a notice slip does) while the board comes back.
 */
export function FocusChip({ runtime, store }: { runtime: ChipRuntime; store: BoardStore }) {
  const state = useStore(runtime.focusView, (v) => v.state)
  const result = useStore(runtime.focusView, (v) => v.result)
  // Bring in… is open: its list follows what is typed, never a remote change.
  const [picking, setPicking] = useState(false)
  const bringIn = useRef<HTMLButtonElement>(null)
  const returning = useRef(false)

  // Before the first paint: a reload in focus never shows the whole board first.
  useLayoutEffect(() => bindFocusHash(runtime), [runtime])

  // What a screen reader hears of a change of focus (not of the board opening as it is).
  const size = result?.notes.size ?? 0
  const depth = state?.depth ?? null
  const notes = `${size} ${size === 1 ? 'note' : 'notes'}`
  const spoken =
    depth === null
      ? 'Showing the whole board'
      : `Focus, ${depth === 'all' ? 'all steps' : stepsLabel(depth)}: ${notes}`
  const said = useRef(spoken)
  useEffect(() => {
    if (said.current === spoken) return
    said.current = spoken
    announce(spoken)
  }, [spoken])

  const closePicker = useCallback(() => {
    returning.current = true
    setPicking(false)
  }, [])

  // Leaving focus, the chip stays a moment, inert, to sink away. A chip button that had the
  // keyboard (✕, or Esc pressed on one) hands it to the selected note, or else to the board.
  const [leaving, setLeaving] = useState<Shown | null>(null)
  const lastShown = useRef<Shown | null>(null)
  const chip = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (state !== null && result !== null) {
      lastShown.current = { state, result }
      setLeaving(null)
      return
    }
    const was = lastShown.current
    lastShown.current = null
    if (was === null) return
    setLeaving(was)
    const t = setTimeout(() => setLeaving(null), MOTION.base)
    return () => clearTimeout(t)
  }, [state, result])

  // Handed back as focus ends, before the chip turns inert (which would drop it on the body).
  useEffect(
    () =>
      runtime.onFocusChange((f) => {
        if (f === null && chip.current?.contains(document.activeElement)) handBack(runtime)
      }),
    [runtime],
  )

  // Focus ended while picking (a remote change, the hash): the picker goes with it.
  useEffect(() => {
    if (state === null) setPicking(false)
  }, [state])

  useLayoutEffect(() => {
    if (picking || !returning.current) return
    returning.current = false
    bringIn.current?.focus({ preventScroll: true })
  }, [picking])

  // What Bring in… leaves out: the same set while the focus holds the same notes (a thread
  // changing among them makes a new result), so its list never moves under the eye.
  const focusNotes = useRef<ReadonlySet<string> | null>(null)
  const notesNow = result?.notes ?? null
  if (notesNow !== null && !(focusNotes.current && sameNotes(focusNotes.current, notesNow))) {
    focusNotes.current = notesNow
  }

  const view: Shown | null = state !== null && result !== null ? { state, result } : leaving
  if (view === null) return null
  const gone = view === leaving ? true : undefined
  const d = view.state.depth
  const steps = d === 'all' ? 'all steps' : stepsLabel(d)
  const canFewer = d !== 1
  const canMore = d !== 'all' && d < MAX_STEPS && view.result.canExpand

  const pick = (id: string) => {
    const f = runtime.focusState
    if (f !== null) runtime.setFocus(withInclude(f, id))
  }

  return (
    <>
      <div
        ref={chip}
        className="focus-chip sync-paper"
        role="toolbar"
        aria-label="Focus"
        data-leaving={gone}
        inert={gone}
        aria-hidden={gone}
      >
        <span className="focus-chip-label">
          {/* On a phone the label is the steps alone (focus.css): room for 44 px − and +. */}
          <span className="focus-chip-word">Focus · </span>
          {steps}
        </span>
        <button
          type="button"
          className="focus-chip-step"
          aria-label="Fewer steps"
          aria-disabled={!canFewer}
          onClick={() => canFewer && runtime.setFocus(withDepth(view.state, shallower(d)))}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 6h7" />
          </svg>
        </button>
        <button
          type="button"
          className="focus-chip-step"
          aria-label="More steps"
          aria-disabled={!canMore}
          onClick={() => canMore && runtime.setFocus(withDepth(view.state, deeper(d)))}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 6h7M6 2.5v7" />
          </svg>
        </button>
        <button
          type="button"
          className="focus-chip-text"
          aria-pressed={d === 'all'}
          onClick={() => runtime.setFocus(withDepth(view.state, 'all'))}
        >
          All
        </button>
        <span className="focus-chip-dot" aria-hidden="true">
          ·
        </span>
        <button
          ref={bringIn}
          type="button"
          className="focus-chip-text"
          aria-haspopup="dialog"
          onClick={() => setPicking(true)}
        >
          Bring in…
        </button>
        <button
          type="button"
          className="focus-chip-exit"
          aria-label="Exit focus (Esc)"
          onClick={() => runtime.setFocus(null)}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
          <span className="focus-chip-key" aria-hidden="true">
            Esc
          </span>
        </button>
      </div>
      {picking && gone === undefined && (
        <div className="search-stage">
          <Picker
            store={store}
            title="Bring into focus"
            placeholder="Find a note"
            exclude={focusNotes.current ?? view.result.notes}
            multi
            onPick={pick}
            onClose={closePicker}
          />
        </div>
      )}
    </>
  )
}
