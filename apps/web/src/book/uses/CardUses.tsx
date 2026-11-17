import { type Block, cardsOfBlock } from '@papertie/core'
import { type JSX, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { navigate } from '../../app/router'
import { rememberPlace } from '../../app/screenMemory'
import type { BoardSession } from '../../app/session'
import { blocksOfBook } from '../../sync/books/bookStore'
import { cardUsesFor } from '../../sync/books/cardUses'
import { slicer } from '../../sync/pace'
import { revealInWriter } from '../openWriter'
import './cardUses.css'

/** How long the popover stays once the pointer has left it and its mark (ms). */
const LEAVE_GRACE_MS = 300
/** Room kept between the popover and its mark, and from the window's edges (px). */
const GAP = 8
const EDGE = 8

/**
 * The book's blocks, held: at once when the board holds them, else once the book store has held
 * it (null: it could not be read, or there is no such book).
 */
async function heldBlocks(
  session: Pick<BoardSession, 'store' | 'books'>,
  bookId: string,
): Promise<readonly Block[] | null> {
  const now = blocksOfBook(session.store.getState(), bookId)
  if (now !== null || session.books === null) return now
  await session.books.open(bookId).catch(() => false)
  return blocksOfBook(session.store.getState(), bookId)
}

/**
 * The first block of book `bookId` naming card `noteId`: one scan of the held book, in 4 ms
 * slices (`sync/pace.ts`), only on the user's command. Null when none does (or it is not held).
 */
export async function firstUse(
  session: Pick<BoardSession, 'store' | 'books'>,
  bookId: string,
  noteId: string,
): Promise<string | null> {
  const blocks = await heldBlocks(session, bookId)
  if (blocks === null) return null
  const step = slicer()
  for (const b of blocks) {
    if ((b.marks.length > 0 || b.image?.card !== undefined) && cardsOfBlock(b).has(noteId))
      return b.id
    await step()
  }
  return null
}

/**
 * Open `bookId` at block `blockId` when there is one (else at the book's last place); the book
 * already open in the writer goes to the block there (its route is the one shown).
 */
function openAt(session: Pick<BoardSession, 'boardId'>, bookId: string, blockId: string | null) {
  if (blockId !== null && revealInWriter(bookId, blockId)) return
  if (blockId !== null && session.boardId !== null) {
    rememberPlace(session.boardId, bookId, { blockId, offset: 0, scrollTop: 0 })
  }
  // Not `openBook` (the shelf's actions and covers): this chunk stays small for a hover.
  navigate({ name: 'book', id: bookId })
}

/**
 * The reverse view: the popover of a card's ink mark on the board. "Used
 * in" lists each shelf book naming the card (`cardUses.usedIn`), "From" the book it was made
 * from (`note.from`, while that book is on the shelf); each title opens its book (beside the
 * board in a split view): "Used in" at the first block naming the card, "From" at the card's
 * block while it is still there, else at the book's last place. Hover (a tap on touch) or a
 * click opens it; Esc, a press elsewhere, or the pointer leaving it and its mark closes it.
 */
export function CardUses(p: {
  session: BoardSession
  noteId: string
  anchor: HTMLElement
  onClose(): void
}): JSX.Element {
  const { session, noteId, anchor, onClose } = p
  const store = session.store
  const uses = cardUsesFor(store)
  const usedIn = useSyncExternalStore(
    (fn) => uses.watch(noteId, fn),
    () => uses.usedIn(noteId),
  )
  const note = useSyncExternalStore(store.subscribe, () => store.getState().notes.get(noteId))
  const from = note?.from
  const fromShown = useSyncExternalStore(
    (fn) => (from === undefined ? () => {} : uses.watchBook(from.book, fn)),
    () => from !== undefined && uses.shelved(from.book),
  )
  const books = store.getState().books
  const title = (id: string) => books.get(id)?.title.trim() || 'Untitled'
  const pop = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  // Beside its mark, kept on screen: placed by the CSSOM (the CSP allows no inline styles).
  useLayoutEffect(() => {
    const el = pop.current
    if (el === null) return
    const r = anchor.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const room = { w: window.innerWidth, h: window.innerHeight }
    const x = Math.max(EDGE, Math.min(room.w - w - EDGE, r.left))
    const below = r.bottom + GAP
    const y = below + h > room.h - EDGE ? Math.max(EDGE, r.top - h - GAP) : below
    el.style.left = `${Math.round(x)}px`
    el.style.top = `${Math.round(y)}px`
  }, [anchor])

  // Esc, a press elsewhere, or the pointer gone from it and its mark a moment: closed.
  useEffect(() => {
    let leaving: ReturnType<typeof setTimeout> | null = null
    const stay = () => {
      if (leaving !== null) clearTimeout(leaving)
      leaving = null
    }
    const leave = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      stay()
      leaving = setTimeout(() => close.current(), LEAVE_GRACE_MS)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close.current()
    }
    const press = (e: PointerEvent) => {
      const t = e.target
      if (t instanceof Node && (pop.current?.contains(t) || anchor.contains(t))) return
      close.current()
    }
    const el = pop.current
    document.addEventListener('keydown', key, true)
    document.addEventListener('pointerdown', press, true)
    for (const x of [anchor, el]) {
      x?.addEventListener('pointerleave', leave)
      x?.addEventListener('pointerenter', stay)
    }
    return () => {
      stay()
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('pointerdown', press, true)
      for (const x of [anchor, el]) {
        x?.removeEventListener('pointerleave', leave)
        x?.removeEventListener('pointerenter', stay)
      }
    }
  }, [anchor])

  const openUse = (bookId: string) => {
    close.current()
    void firstUse(session, bookId, noteId).then((blockId) => openAt(session, bookId, blockId))
  }
  const openFrom = (bookId: string, blockId: string) => {
    close.current()
    void heldBlocks(session, bookId).then(() => {
      const b = store.getState().blocks.get(blockId)
      openAt(session, bookId, b !== undefined && b.bookId === bookId ? blockId : null)
    })
  }

  return (
    <div ref={pop} className="card-uses sync-paper" role="dialog" aria-label="Card uses">
      {usedIn.length > 0 && (
        <fieldset className="card-uses-part">
          <legend className="card-uses-head">Used in</legend>
          <ul className="card-uses-list">
            {usedIn.map((id) => (
              <li key={id}>
                <button type="button" className="card-uses-book" onClick={() => openUse(id)}>
                  {title(id)}
                </button>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {from !== undefined && fromShown && (
        <fieldset className="card-uses-part">
          <legend className="card-uses-head">From</legend>
          <ul className="card-uses-list">
            <li>
              <button
                type="button"
                className="card-uses-book"
                onClick={() => openFrom(from.book, from.block)}
              >
                {title(from.book)}
              </button>
            </li>
          </ul>
        </fieldset>
      )}
    </div>
  )
}
