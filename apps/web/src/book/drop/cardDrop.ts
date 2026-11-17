/**
 * The open book's side of a card dragged across the seam: the `SeamDrop` the
 * writer registers with the board's runtime. The board keeps the pointer (its capture) and hands
 * the drag over while the pointer is over the page: a small paper ghost follows it with the card's
 * first line ("Move" while ⌥ is held), a fine crimson line marks the gap between two blocks it would
 * land in (never inside a paragraph: a prompt's gap is after the block it annotates),
 * and near the page's top or bottom edge the page scrolls (≤ 1 px/ms). The drop is one commit of
 * the board's store (`cardDropOps`): one batch, one undo step; the caret, the board's selection
 * and the keyboard focus stay where they were. What it reads per move is the window's blocks
 * (`liveBlocks`, O(window)) and two rects, never the book.
 */
import { type Note, newId, OpError } from '@papertie/core'
import { announce } from '../../app/liveRegion'
import type { BoardSession } from '../../app/session'
import type { SeamDrop } from '../../canvas/seamDrop'
import { parseNoteText } from '../../notes/noteText'
import type { BlockEngine } from '../editor/blockEngine'
import { blockBeforeId } from '../editorOps'
import { sayLimit } from '../sayLimit'
import { cardDropOps, type DropForm, FORM_NOUN, readingOrder } from './cardBlocks'

/** Within this many px of the page's top or bottom edge, a drag hovering there scrolls it. */
export const EDGE_PX = 48
/** The edge scroll's speed at the very edge, px per ms (≤ 1). */
export const EDGE_SPEED = 1

export const FULL_COPY = 'This book is full.'
export const EMPTY_COPY = 'That card is empty.'
/** The undo labels of a drop: a copy, a move (one step with the cards' deletes). */
export const DROP_LABELS = { copy: 'add to the book', move: 'move into the book' } as const

/** What the live region says of a drop into `title`. */
export function droppedCopy(title: string, as: DropForm | 'figure', move: boolean): string {
  const name = title.trim() || 'Untitled'
  return move
    ? `Moved into “${name}” as ${FORM_NOUN[as]}.`
    : `Added to “${name}” as ${FORM_NOUN[as]}.`
}

/** What lands where: the block the new text follows (null: first), and the line's top (client px). */
interface Gap {
  after: string | null
  y: number
}

/** What a drop of text made, for the chooser: its blocks (no figure), those from bullets. */
export interface Dropped {
  blockIds: readonly string[]
  bullets: readonly string[]
  form: DropForm
  move: boolean
  /** The last block made (a figure's too, a footnote's): the caret goes after it on an insert. */
  last: string | null
  /**
   * A card of it has a ref: its form was the ref's, not a choice, so neither keeping
   * it nor switching it is counted for the likely form.
   */
  reffed: boolean
}

export interface CardDropHost {
  session: Pick<BoardSession, 'store' | 'sync' | 'feed'>
  bookId: string
  engine: Pick<BlockEngine, 'liveBlocks' | 'onLayout'>
  /** The book's blocks' parent (`liveBlocks`' coordinates are its own). */
  page(): HTMLElement | null
  /** What scrolls the page; the drop's target is its box. */
  scroller: HTMLElement
  /** The form the text lands in (the likely one); `'p'` by default. */
  form?(): DropForm
  /** Whether the drop moves the cards, where ⌥ is not the say (touch: `armed`). */
  armed?(): 'copy' | 'move' | null
  /** After a drop: its text blocks (none for figures alone), its form, whether it moved. */
  dropped?(r: Dropped): void
  /** A drag came over the page (the chooser of the last drop goes). */
  hovering?(): void
  /** On touch, a card held still: the Copy · Move chip. */
  press?(noteId: string, x: number, y: number): void
  newBlockId?(): string
}

/**
 * The cards `noteIds` put into the book after block `after` (null: first), as `form` (a photo as a
 * figure): one commit, labelled as a copy or a move, said in the live region. A full book
 * changes nothing and says so; so does a card with nothing in it. What was made, for the chooser
 * (its text blocks: none when only figures came), or null when nothing was.
 */
export function landCards(o: {
  session: Pick<BoardSession, 'store' | 'sync' | 'feed'>
  bookId: string
  after: string | null
  noteIds: readonly string[]
  move: boolean
  form: DropForm
  newBlockId?(): string
}): Dropped | null {
  const store = o.session.store
  const state = store.getState()
  const notes: Note[] = []
  for (const id of o.noteIds) {
    const n = state.notes.get(id)
    if (n !== undefined) notes.push(n)
  }
  const { ops, blockIds, bullets, form, reffed, last } = cardDropOps({
    state,
    bookId: o.bookId,
    after: o.after,
    notes,
    form: o.form,
    move: o.move,
    newBlockId: o.newBlockId ?? (() => newId('block')),
  })
  if (ops.length === 0) {
    announce(EMPTY_COPY)
    return null
  }
  try {
    store.commit(ops, { label: o.move ? DROP_LABELS.move : DROP_LABELS.copy })
  } catch (e) {
    if (e instanceof OpError && /too-many-blocks|book-too-long/.test(e.message)) {
      sayLimit(o.session, FULL_COPY)
      return null
    }
    throw e
  }
  const after = store.getState()
  const text = blockIds.filter((id) => after.blocks.get(id)?.kind !== 'figure')
  const title = after.books.get(o.bookId)?.title ?? ''
  announce(droppedCopy(title, text.length === 0 ? 'figure' : form, o.move))
  return { blockIds: text, bullets, form, move: o.move, last, reffed }
}

export interface CardDrop extends SeamDrop {
  destroy(): void
}

/** The first line a card shows (its title, or a photo's caption). */
function firstLine(n: Note | undefined): string {
  if (n === undefined) return ''
  const b = parseNoteText(n.text)[0]
  return b?.text.split('\n')[0] ?? (n.image === null ? '' : 'Photo')
}

export function createCardDrop(h: CardDropHost): CardDrop {
  const store = h.session.store
  let line: HTMLElement | null = null
  let ghost: { el: HTMLElement; move: HTMLElement; of: string } | null = null
  /** The last pointer over the page, for the edge scroll's frames. */
  let at: { x: number; y: number; ids: readonly string[]; alt: boolean } | null = null
  let frame = 0
  let last = 0

  /** The gap nearest client y: above or below a block's middle, prompts kept with their block. */
  const gapAt = (y: number): Gap => {
    const page = h.page()
    const top = page?.getBoundingClientRect().top ?? 0
    const by = y - top
    // Each block with the prompts and footnotes that follow it (they annotate it): one unit.
    let firstId: string | null = null
    let lastId: string | null = null
    let unitTop = 0
    let unitBottom = 0
    let prevLast: string | null = null
    let seen = false
    for (const b of h.engine.liveBlocks()) {
      if ((b.kind === 'prompt' || b.kind === 'footnote') && seen) {
        lastId = b.id
        continue
      }
      if (seen) {
        if (by < (unitTop + unitBottom) / 2) break
        prevLast = lastId
      }
      seen = true
      firstId = b.id
      lastId = b.id
      unitTop = b.top
      unitBottom = b.top + b.height
    }
    const state = store.getState()
    const onBook = (id: string | null) =>
      id !== null && state.blocks.get(id)?.bookId === h.bookId ? id : null
    if (!seen || firstId === null) return { after: null, y: top }
    if (by < (unitTop + unitBottom) / 2) {
      // Before this unit: after the one before it (on the page, or the book's block before it).
      const after = prevLast ?? blockBeforeId(state, h.bookId, firstId)
      return { after: onBook(after), y: top + unitTop }
    }
    return { after: onBook(lastId), y: top + unitBottom }
  }

  const show = (x: number, y: number, ids: readonly string[], alt: boolean) => {
    const gap = gapAt(y)
    const page = h.page()
    const box = (page ?? h.scroller).getBoundingClientRect()
    if (line === null) {
      line = document.createElement('div')
      line.className = 'bk-drop-gap'
      line.setAttribute('aria-hidden', 'true')
      document.body.append(line)
    }
    line.dataset.after = gap.after ?? ''
    line.style.top = `${Math.round(gap.y)}px`
    line.style.left = `${Math.round(box.left)}px`
    line.style.width = `${Math.round(box.width)}px`
    const first = [...ids]
      .map((id) => store.getState().notes.get(id))
      .filter((n): n is Note => n !== undefined)
      .sort(readingOrder)[0]
    const of = first?.id ?? ''
    if (ghost === null || ghost.of !== of) {
      ghost?.el.remove()
      const el = document.createElement('div')
      el.className = 'card-ghost'
      el.setAttribute('aria-hidden', 'true')
      const text = document.createElement('p')
      text.className = 'card-ghost-line'
      text.textContent = firstLine(first)
      const move = document.createElement('span')
      move.className = 'card-ghost-move'
      move.textContent = 'Move'
      el.append(text, move)
      if (ids.length > 1) {
        const more = document.createElement('span')
        more.className = 'card-ghost-more'
        more.textContent = `+${ids.length - 1}`
        el.append(more)
      }
      document.body.append(el)
      ghost = { el, move, of }
    }
    const armed = h.armed?.() ?? null
    ghost.move.hidden = !(armed === null ? alt : armed === 'move')
    ghost.el.style.translate = `${Math.round(x + 14)}px ${Math.round(y + 10)}px`
  }

  /** The edge scroll's speed for client y, px/ms (negative: up). */
  const edgeSpeed = (y: number): number => {
    const r = h.scroller.getBoundingClientRect()
    if (y < r.top + EDGE_PX) return -EDGE_SPEED * Math.min(1, (r.top + EDGE_PX - y) / EDGE_PX)
    if (y > r.bottom - EDGE_PX)
      return EDGE_SPEED * Math.min(1, (y - (r.bottom - EDGE_PX)) / EDGE_PX)
    return 0
  }

  const tick = (now: number) => {
    frame = 0
    if (at === null) return
    const v = edgeSpeed(at.y)
    if (v === 0) return
    const dt = last === 0 ? 16 : Math.min(50, now - last)
    last = now
    h.scroller.scrollTop += v * dt
    show(at.x, at.y, at.ids, at.alt)
    frame = requestAnimationFrame(tick)
  }

  const clear = () => {
    at = null
    last = 0
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
    line?.remove()
    line = null
    ghost?.el.remove()
    ghost = null
  }

  // The window moved or a block was measured under the hover: the line follows.
  const offLayout = h.engine.onLayout(() => {
    if (at !== null) show(at.x, at.y, at.ids, at.alt)
  })

  return {
    over(x, y) {
      const r = h.scroller.getBoundingClientRect()
      return x >= r.left && x < r.right && y >= r.top && y < r.bottom
    },

    hover(x, y, ids, alt) {
      if (at === null) h.hovering?.()
      at = { x, y, ids, alt }
      show(x, y, ids, alt)
      if (frame === 0 && edgeSpeed(y) !== 0) {
        last = 0
        frame = requestAnimationFrame(tick)
      }
    },

    drop(_x, y, ids, alt) {
      const gap = gapAt(y)
      clear()
      const armed = h.armed?.() ?? null
      const made = landCards({
        session: h.session,
        bookId: h.bookId,
        after: gap.after,
        noteIds: ids,
        move: armed === null ? alt : armed === 'move',
        form: h.form?.() ?? 'p',
        ...(h.newBlockId ? { newBlockId: h.newBlockId } : {}),
      })
      if (made === null) return false
      h.dropped?.(made)
      return true
    },

    ...(h.press ? { press: h.press } : {}),
    ...(h.armed ? { armed: h.armed } : {}),

    leave: clear,

    destroy() {
      clear()
      offLayout()
    },
  }
}
