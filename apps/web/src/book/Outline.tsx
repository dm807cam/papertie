import { OpError } from '@papertie/core'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { announce } from '../app/liveRegion'
import type { BoardSession } from '../app/session'
import { chaptersOf, planChapterMove } from './chapterMove'
import type { BlockEngine } from './editor/blockEngine'

/**
 * The book's outline: its chapter titles, at the page's left edge, shown on
 * hover (or on focus, or a tap on touch). A title jumps to its chapter, the caret at its start;
 * dragging one up or down the list moves the chapter there (`planChapterMove`: one commit, one
 * undo step); Alt+↑ and Alt+↓ on a title are the drag's keyboard path. The list is read from the
 * board as it opens (O(book), never per keystroke).
 */

interface Chapter {
  id: string
  title: string
}

/** How far a press moves before it is a drag (px). */
const DRAG_PX = 4

export function Outline({
  session,
  bookId,
  engine,
}: {
  session: BoardSession
  bookId: string
  engine: BlockEngine
}) {
  const [open, setOpen] = useState(false)
  const [chapters, setChapters] = useState<Chapter[]>([])
  /** While a title is dragged: which, and the chapter it would go before (`null`: the end). */
  const [drag, setDrag] = useState<{ id: string; before: string | null } | null>(null)
  const list = useRef<HTMLOListElement>(null)
  const panel = useRef<HTMLElement>(null)
  /** Esc gave the focus back to the tab: that focus does not open it again. */
  const quiet = useRef(false)
  const hint = useId()

  const read = useCallback(
    () => setChapters(chaptersOf(session.store.getState(), bookId)),
    [session, bookId],
  )
  const show = () => {
    if (!open) read()
    setOpen(true)
  }
  const onTabFocus = () => {
    if (quiet.current) {
      quiet.current = false
      return
    }
    show()
  }

  // While open, the list follows the board (a title written, a chapter made elsewhere), a frame
  // after each change: O(book) only while it is open.
  useEffect(() => {
    if (!open) return
    let raf = 0
    const off = session.store.subscribe(() => {
      if (raf === 0)
        raf = requestAnimationFrame(() => {
          raf = 0
          read()
        })
    })
    return () => {
      off()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [open, session, read])
  const hide = () => {
    if (drag !== null) return
    if (panel.current?.contains(document.activeElement)) return
    setOpen(false)
  }

  /** Chapter `id` put before chapter `before` (`null`: at the end), as one commit. */
  const move = (id: string, before: string | null) => {
    const ops = planChapterMove(session.store.getState(), bookId, id, before)
    if (ops.length === 0) return false
    try {
      session.store.commit(ops, { label: 'Move chapter' })
    } catch (e) {
      // Refused (the book changed under it, a limit): said, and the list as the board has it.
      if (!(e instanceof OpError)) throw e
      read()
      announce('That chapter couldn’t be moved.')
      return false
    }
    const next = chaptersOf(session.store.getState(), bookId)
    setChapters(next)
    announce(`Moved to chapter ${next.findIndex((c) => c.id === id) + 1} of ${next.length}.`)
    return true
  }

  // A press on a title: a click jumps to it; moved past a few px, it drags the chapter.
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0 || list.current === null) return
    const items = [...list.current.querySelectorAll<HTMLElement>('[data-chapter]')]
    const mids = items.map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.dataset.chapter as string, mid: r.top + r.height / 2 }
    })
    const y0 = e.clientY
    let moved = false
    let before: string | null = null
    const target = e.currentTarget
    target.setPointerCapture?.(e.pointerId)
    const onMove = (m: PointerEvent) => {
      if (!moved && Math.abs(m.clientY - y0) < DRAG_PX) return
      moved = true
      before = mids.find((x) => m.clientY < x.mid)?.id ?? null
      setDrag({ id, before })
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onCancel)
      setDrag(null)
      if (moved) move(id, before)
      else {
        setOpen(false)
        engine.reveal(id)
      }
    }
    const onCancel = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onCancel)
      setDrag(null)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onCancel)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.nativeEvent.isComposing) return
    const id = chapters[i]?.id
    if (id === undefined) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen(false)
      engine.reveal(id)
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const up = e.key === 'ArrowUp'
      if (up ? i === 0 : i === chapters.length - 1) return
      // Up: before the one above. Down: before the one after the next (the end past the last).
      const before = up ? (chapters[i - 1]?.id ?? null) : (chapters[i + 2]?.id ?? null)
      if (move(id, before)) {
        // The focus stays with the chapter moved.
        requestAnimationFrame(() =>
          list.current?.querySelector<HTMLElement>(`[data-chapter="${id}"] button`)?.focus(),
        )
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const next =
        list.current?.querySelectorAll<HTMLElement>('[data-chapter] button')[
          e.key === 'ArrowUp' ? i - 1 : i + 1
        ]
      next?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      quiet.current = true
      panel.current?.querySelector<HTMLElement>('.writer-outline-tab')?.focus()
    }
  }

  // Closed when the focus leaves it, or a press lands elsewhere (a tap on touch), nothing dragged.
  useEffect(() => {
    if (!open) return
    const onFocus = () => {
      if (!panel.current?.contains(document.activeElement) && drag === null) setOpen(false)
    }
    const onPress = (e: PointerEvent) => {
      if (drag === null && !panel.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('focusin', onFocus)
    document.addEventListener('pointerdown', onPress, true)
    return () => {
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('pointerdown', onPress, true)
    }
  }, [open, drag])

  return (
    <nav
      ref={panel}
      className="writer-outline"
      aria-label="Chapters"
      data-open={open || undefined}
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') show()
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') hide()
      }}
    >
      <button
        type="button"
        className="writer-outline-tab"
        aria-expanded={open}
        aria-label="Chapters"
        onClick={show}
        onFocus={onTabFocus}
      >
        <span aria-hidden="true" />
      </button>
      {open && (
        <div className="writer-outline-list">
          <p id={hint} className="writer-outline-hint">
            Alt+Up or Alt+Down moves the chapter.
          </p>
          {chapters.length === 0 ? (
            <p className="writer-outline-none">No chapters yet</p>
          ) : (
            <ol ref={list}>
              {chapters.map((c, i) => (
                <li
                  key={c.id}
                  data-chapter={c.id}
                  data-dragged={drag?.id === c.id || undefined}
                  data-drop={drag !== null && drag.before === c.id ? 'before' : undefined}
                >
                  <button
                    type="button"
                    className="writer-outline-item"
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    aria-describedby={hint}
                    onPointerDown={(e) => onPointerDown(e, c.id)}
                    onKeyDown={(e) => onKeyDown(e, i)}
                  >
                    <span className="writer-outline-num" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className="writer-outline-title">
                      {c.title.trim() || 'Untitled chapter'}
                    </span>
                  </button>
                </li>
              ))}
              {drag !== null && drag.before === null && (
                <li className="writer-outline-end" data-drop="before" aria-hidden="true" />
              )}
            </ol>
          )}
        </div>
      )}
    </nav>
  )
}
