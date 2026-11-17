/**
 * A selection dragged out of the book onto the board beside it: a pointer
 * drag, never HTML5 drag and drop. The engine hands it over once a press inside the
 * selection has travelled `DRAG_THRESHOLD_PX` (`onDragOut`); from then on a small paper ghost
 * follows the pointer with the selection's first words ("Move" while ⌥ is held), and the release
 * decides: over the board's cork, one new card at the drop point (`pinSelection`: ⌥ there moves
 * the text out of the book, one undo step); over the book, or anywhere else, nothing (moving
 * text inside the book is cut and paste's). Esc and a cancelled pointer make nothing too. On
 * touch there is no drag-out: the popover's "Pin to board" and "Move to board" do it.
 */
import type { BoardSession } from '../../app/session'
import type { Camera } from '../../canvas/Camera'
import { screenToWorld } from '../../canvas/Camera'
import type { Point } from '../../canvas/types'
import type { Pos } from '../editor/model'
import { pinSelection } from './toCard'

/** What the drag-out asks of the board's runtime beside the book (`beside`'s). */
export interface OutBoard {
  els: { root: HTMLElement }
  toViewport(clientX: number, clientY: number): Point
  drawnCamera(): Camera
  selectNote(id: string | null): void
}

export interface SelectionDrag {
  /** Whether it has ended (dropped, cancelled or released over the book). */
  done(): boolean
  cancel(): void
}

const inside = (r: DOMRect, x: number, y: number) =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom

/** The first words of the selection [a, b) as the ghost shows them. */
function firstWords(s: BoardSession, a: Pos, b: Pos): string {
  const block = s.store.getState().blocks.get(a.blockId)
  if (block === undefined) return ''
  const end = a.blockId === b.blockId ? b.offset : block.text.length
  return block.text.slice(a.offset, end).trim()
}

/**
 * The drag of the selection `range` of book `bookId`, from the press `from` (its pointer): it
 * runs on the window's pointer events until the release, Esc or a cancel.
 */
export function startSelectionDrag(o: {
  session: BoardSession
  bookId: string
  range: { a: Pos; b: Pos }
  board: OutBoard
  /** The book's pane: a release over it makes nothing. */
  book: HTMLElement | null
  from: { clientX: number; clientY: number; pointerId: number }
  newBlockId?(): string
}): SelectionDrag {
  let ended = false
  let ghost: { el: HTMLElement; move: HTMLElement } | null = null

  const show = (x: number, y: number, alt: boolean) => {
    if (ghost === null) {
      const el = document.createElement('div')
      el.className = 'card-ghost'
      el.setAttribute('aria-hidden', 'true')
      const text = document.createElement('p')
      text.className = 'card-ghost-line'
      text.textContent = firstWords(o.session, o.range.a, o.range.b)
      const move = document.createElement('span')
      move.className = 'card-ghost-move'
      move.textContent = 'Move'
      el.append(text, move)
      document.body.append(el)
      ghost = { el, move }
    }
    ghost.move.hidden = !alt
    // The CSSOM, never a style attribute in markup (the CSP).
    ghost.el.style.translate = `${Math.round(x + 14)}px ${Math.round(y + 10)}px`
  }

  const end = () => {
    if (ended) return
    ended = true
    ghost?.el.remove()
    ghost = null
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    window.removeEventListener('keydown', onKey, true)
  }

  const mine = (e: PointerEvent) => e.pointerId === o.from.pointerId || e.pointerId === undefined

  const onMove = (e: PointerEvent) => {
    if (!mine(e)) return
    e.preventDefault()
    show(e.clientX, e.clientY, e.altKey)
  }
  const onUp = (e: PointerEvent) => {
    if (!mine(e)) return
    const { clientX: x, clientY: y } = e
    end()
    const overBook = o.book !== null && inside(o.book.getBoundingClientRect(), x, y)
    const overBoard = inside(o.board.els.root.getBoundingClientRect(), x, y)
    if (overBook || !overBoard) return
    const at = screenToWorld(o.board.drawnCamera(), o.board.toViewport(x, y))
    pinSelection({
      session: o.session,
      bookId: o.bookId,
      range: o.range,
      at,
      move: e.altKey,
      board: o.board,
      ...(o.newBlockId ? { newBlockId: o.newBlockId } : {}),
    })
  }
  const onCancel = (e: PointerEvent) => {
    if (mine(e)) end()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    end()
  }
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onCancel, true)
  window.addEventListener('keydown', onKey, true)
  show(o.from.clientX, o.from.clientY, false)
  return { done: () => ended, cancel: end }
}
