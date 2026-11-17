import { useEffect, useRef, useState } from 'react'
import { navigate } from '../../app/router'
import { recallSplit, rememberSplit, splitFits } from '../../app/screenMemory'
import type { BoardSession } from '../../app/session'
import type { BesideRuntime } from '../beside'
import type { BlockEngine } from '../editor/blockEngine'
import { FOOTNOTE_LABELS } from '../footnotes/footnotes'
import { refFootnoteOps } from '../footnotes/refFootnote'
import { CardPeek } from './CardPeek'
import { type Pin, pinLabel, pinsOf, unpinOps } from './pins'
import '../../styles/pin.css'

/** The undo label of "Remove pin". */
export const UNPIN_LABEL = 'remove pin'
/** How long a peek stays once the pointer has left its pin and it (ms). */
const PEEK_GRACE_MS = 200

const samePins = (a: readonly Pin[], b: readonly Pin[]) =>
  a.length === b.length &&
  a.every((p, i) => {
    const q = b[i] as Pin
    return (
      p.blockId === q.blockId && p.noteId === q.noteId && p.top === q.top && p.faded === q.faded
    )
  })

/**
 * The provenance pins in the book's left margin, outside the editing host
 * (no DOM of theirs in the text). Laid out from the window's blocks (`pinsOf`)
 * as the page lays out (`onLayout`, once a frame at most), and as the board's notes or blocks
 * change (a card deleted, put back, a pin removed). Each pin is a button: hovering it (a tap on
 * touch) or focusing it shows its card (`CardPeek`) with "Remove pin", one undo step; a
 * click shows the card on the board, centred and selected, beside the book (from full width, the
 * split first; on a phone, the board).
 */
export function PinLayer({
  session,
  bookId,
  engine,
  page,
  layout,
  runtime,
}: {
  session: Pick<BoardSession, 'store'>
  bookId: string
  engine: Pick<BlockEngine, 'liveBlocks' | 'onLayout'>
  /** The book's blocks' parent: the pins' tops are in its coordinates. */
  page(): HTMLElement | null
  layout: 'split' | 'full'
  runtime: BesideRuntime | null
}) {
  const store = session.store
  const layer = useRef<HTMLDivElement>(null)
  const [pins, setPins] = useState<readonly Pin[]>([])
  const [peek, setPeek] = useState<Pin | null>(null)
  const pageRef = useRef(page)
  pageRef.current = page

  useEffect(() => {
    const compute = () => {
      const s = store.getState()
      const next = pinsOf(
        engine.liveBlocks(),
        (id) => s.blocks.get(id),
        (id) => s.notes.has(id),
      )
      setPins((was) => (samePins(was, next) ? was : next))
      // The layer at the page's top, in the page's own coordinates.
      const el = layer.current
      const p = pageRef.current()
      const parent = el?.offsetParent ?? el?.parentElement
      if (el && p && parent) {
        const top = p.getBoundingClientRect().top - parent.getBoundingClientRect().top
        el.style.top = `${Math.round(top)}px`
      }
    }
    compute()
    // A block changed is laid out by the engine, which tells `onLayout` once a frame after it:
    // never a layout read inside the keystroke. A card deleted or put back
    // (its pin fades or comes back) is read a frame on, once however many came.
    const offLayout = engine.onLayout(compute)
    let frame = 0
    const offStore = store.subscribe((s, prev) => {
      if (s.notes === prev.notes || frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        compute()
      })
    })
    return () => {
      offLayout()
      offStore()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [store, engine])

  // A peek whose pin went (removed, its text deleted) goes with it; one whose card came back or
  // went follows it.
  useEffect(() => {
    if (peek === null) return
    const now = pins.find((p) => p.blockId === peek.blockId && p.noteId === peek.noteId)
    if (now === undefined) setPeek(null)
    else if (now !== peek) setPeek(now)
  }, [pins, peek])

  // Esc closes the peek; a press outside the layer does too.
  const open = peek !== null
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !layer.current?.contains(document.activeElement)) return
      e.preventDefault()
      e.stopPropagation()
      setPeek(null)
    }
    const press = (e: PointerEvent) => {
      if (e.target instanceof Node && layer.current?.contains(e.target)) return
      setPeek(null)
    }
    document.addEventListener('keydown', key, true)
    document.addEventListener('pointerdown', press, true)
    return () => {
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('pointerdown', press, true)
    }
  }, [open])

  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stay = () => {
    if (leaving.current !== null) clearTimeout(leaving.current)
    leaving.current = null
  }
  const leave = () => {
    stay()
    leaving.current = setTimeout(() => setPeek(null), PEEK_GRACE_MS)
  }
  useEffect(
    () => () => {
      if (leaving.current !== null) clearTimeout(leaving.current)
    },
    [],
  )

  /** The card on the board: centred and selected, the board brought beside the book first. */
  const showOnBoard = (noteId: string) => {
    const rt = runtime
    if (rt?.focusNote === undefined || rt.selectNote === undefined) return
    if (!store.getState().notes.has(noteId)) return
    const show = () => {
      rt.focusNote?.(noteId, 1)
      rt.selectNote?.(noteId)
    }
    if (layout === 'split') {
      show()
      return
    }
    if (splitFits(window.innerWidth)) rememberSplit({ ...recallSplit(), board: true })
    else navigate({ name: 'board' })
    // Once the board has its size beside the book (or the whole window).
    requestAnimationFrame(() => requestAnimationFrame(show))
  }

  const remove = (p: Pin) => {
    const ops = unpinOps(store.getState(), bookId, p.blockId, p.noteId)
    if (ops.length > 0) store.commit(ops, { label: UNPIN_LABEL })
    setPeek(null)
  }

  /** A footnote of pin `p`'s card's ref on its block: one commit. */
  const footnote = (p: Pin) => {
    const ops = refFootnoteOps(store.getState(), bookId, p.blockId, p.noteId)
    if (ops.length > 0) store.commit(ops, { label: FOOTNOTE_LABELS.add })
    setPeek(null)
  }

  const touched = useRef(false)
  const notes = store.getState().notes
  return (
    <div ref={layer} className="bk-pins">
      {pins.map((p) => {
        const shown = peek?.blockId === p.blockId && peek.noteId === p.noteId
        const note = notes.get(p.noteId)
        return (
          <div key={`${p.blockId}:${p.noteId}`} className="bk-pin-slot">
            <button
              type="button"
              className="bk-pin brass-pin"
              ref={(el) => {
                if (el) el.style.top = `${Math.round(p.top)}px`
              }}
              aria-label={pinLabel(p.faded ? undefined : note)}
              aria-expanded={shown}
              data-faded={p.faded ? '' : undefined}
              onPointerDown={(e) => {
                touched.current = e.pointerType === 'touch' || e.pointerType === 'pen'
              }}
              onPointerEnter={(e) => {
                if (e.pointerType !== 'mouse') return
                stay()
                setPeek(p)
              }}
              onPointerLeave={(e) => {
                if (e.pointerType === 'mouse') leave()
              }}
              onFocus={() => setPeek(p)}
              onClick={() => {
                // On touch the first tap shows the card here; the next, on the board.
                if (touched.current && !shown) {
                  setPeek(p)
                  return
                }
                showOnBoard(p.noteId)
              }}
            />
            {shown && (
              <CardPeek
                note={p.faded ? undefined : note}
                top={p.top}
                onRemove={() => remove(p)}
                onFootnote={() => footnote(p)}
                onEnter={stay}
                onLeave={leave}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
