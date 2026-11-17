import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { announce } from '../app/liveRegion'
import type { CanvasRuntime } from '../canvas/runtime'
import type { BoardStore } from '../store/boardStore'
import { handToBoard } from '../ui/handToBoard'
import { Picker } from './LazyPicker'
import { closeSearch, toggleSearch, useSearchOpen } from './searchStore'

/** What the palette asks of the canvas. */
export type SearchTarget = Pick<CanvasRuntime, 'focusNote' | 'selectNote' | 'stopEditing' | 'held'>

/** Zoom the camera lands on at a found note. */
const FOUND_ZOOM = 1
/** What a screen reader hears of the note it was taken to. */
const SPOKEN_MAX = 60

const isSearchKey = (e: KeyboardEvent): boolean =>
  e.metaKey !== e.ctrlKey &&
  !e.altKey &&
  !e.shiftKey &&
  (e.key.toLowerCase() === 'k' || e.code === 'KeyK')

/**
 * ⌘K (Ctrl+K): search the board's notes. Picking one jumps the camera to it at zoom 1 and selects
 * it. Opens from anywhere on the board, the note editor included: the editor is closed first
 * (through the runtime, which flushes what it holds, a composition too), so the palette reads
 * the text as typed. The sidebar's search button opens it with `openSearch`.
 *
 * It searches through the board's search index (a worker), so typing never waits on the board,
 * and the list changes only as the writer types, never with a remote change.
 */
export function SearchPalette({
  runtime,
  store,
}: {
  runtime: SearchTarget | null
  store: BoardStore
}) {
  const open = useSearchOpen()
  /** Open, with the editor closed first: the index has every keystroke before the palette asks. */
  const [shown, setShown] = useState(false)
  const returnTo = useRef<HTMLElement | null>(null)
  /** The board the palette was last shown over, for the focus to go back to. */
  const shownOn = useRef<HTMLElement | null>(null)
  const runtimeRef = useRef(runtime)
  runtimeRef.current = runtime

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSearchKey(e) || e.isComposing) return
      // In a book's pane beside the board it is the writer's.
      if (e.target instanceof Element && e.target.closest('.book-pane')) return
      // A screen or a sheet is over the board: it is not to be driven. Only the board's
      // own state says so; parts of it fold away inert (an empty selection, a closed sheet).
      if (runtimeRef.current?.held) return
      e.preventDefault()
      e.stopPropagation()
      toggleSearch()
    }
    // Captured: whatever has the keyboard (the editor included) does not get to keep ⌘K.
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      closeSearch()
    }
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setShown(false)
      const back = returnTo.current
      returnTo.current = null
      // What had the focus may be gone (a picker sheet that search replaced), or have been <body>
      // itself: the board takes it, never <body>.
      if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true })
      else if (shownOn.current) handToBoard(shownOn.current)
      return
    }
    const active = document.activeElement
    returnTo.current = active instanceof HTMLElement ? active : null
    // Writing ends first, so the board holds every keystroke.
    runtimeRef.current?.stopEditing()
    setShown(true)
  }, [open])

  if (!open || !shown) return null

  const pick = (id: string) => {
    // The camera and the selection are changed here and nowhere else in search.
    returnTo.current = null
    closeSearch()
    const rt = runtimeRef.current
    if (!rt) return
    if (!rt.focusNote(id, FOUND_ZOOM)) {
      announce('That note is no longer on the board')
      return
    }
    rt.selectNote(id)
    const text = store.getState().notes.get(id)?.text.replace(/\s+/g, ' ').trim() ?? ''
    announce(text === '' ? 'Showing a note' : `Showing ${text.slice(0, SPOKEN_MAX)}`)
  }

  return (
    <div
      className="search-stage"
      ref={(el) => {
        if (el) shownOn.current = el.closest<HTMLElement>('.viewport')
      }}
    >
      <Picker
        store={store}
        title="Search notes"
        placeholder="Search notes"
        onPick={pick}
        onClose={closeSearch}
      />
    </div>
  )
}
