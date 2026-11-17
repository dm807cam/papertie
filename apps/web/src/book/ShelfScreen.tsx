import type { Book } from '@papertie/core'
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { announce } from '../app/liveRegion'
import { navigate } from '../app/router'
import { type BoardSession, stepHistory } from '../app/session'
import { historyKey } from '../interactions/keys'
import { useBooks } from '../sync/books/bookStore'
import { PlusIcon } from '../ui/sidebarIcons'
import { useNarrow } from '../ui/useNarrow'
import { BookNotices } from './BookNotices'
import { BookPopover, DeletePrompt } from './BookPopover'
import { CoverSvg } from './cover/CoverSvg'
import { RecentlyDeleted } from './RecentlyDeleted'
import {
  createBook,
  moveBook,
  openBook,
  trashBook,
  useFocusBack,
  useRememberedScreen,
} from './shelfActions'
import { restorable, useTrashedBooks } from './trashedBooks'
import './shelf.css'

/** A cover on the shelf: 104 × 150 scaled, smaller on a phone (three across). */
const WIDE = { w: 120, h: 173 } as const
const NARROW = { w: 94, h: 136 } as const

/** How far (px) a press travels before it is a drag; how long a finger holds before one. */
const DRAG_PX = 6
const HOLD_MS = 350

const titleOf = (b: Book) => b.title.trim() || 'Untitled'

/** One book standing face-out: its cover (once it is near the view), and its options. */
const ShelfBook = memo(function ShelfBook({
  book,
  near,
  size,
  dragging,
  optionsOpen,
  onOpen,
  onOptions,
  onKey,
}: {
  book: Book
  near: boolean
  size: { w: number; h: number }
  dragging: boolean
  optionsOpen: boolean
  onOpen(id: string): void
  /** `toggle`: the options button, which closes them again; a right click only opens them. */
  onOptions(id: string, anchor: HTMLElement, toggle: boolean): void
  onKey(id: string, e: KeyboardEvent<HTMLButtonElement>): void
}) {
  const title = titleOf(book)
  const more = useRef<HTMLButtonElement>(null)
  return (
    <li
      className="shelf-book"
      data-book-id={book.id}
      data-book-title={title}
      data-dragging={dragging || undefined}
    >
      <button
        type="button"
        className="shelf-open"
        aria-label={title}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
        onClick={() => onOpen(book.id)}
        onKeyDown={(e) => onKey(book.id, e)}
        onContextMenu={(e) => {
          if (!more.current) return
          e.preventDefault()
          onOptions(book.id, more.current, false)
        }}
      >
        <span className="shelf-cover" lang={book.lang}>
          {near ? (
            <CoverSvg
              cover={book.cover}
              title={book.title}
              size={size}
              idBase={`${book.id}-shelf`}
            />
          ) : (
            <span className="shelf-blank" />
          )}
        </span>
      </button>
      <button
        ref={more}
        type="button"
        className="shelf-more"
        aria-label={`Options for ${title}`}
        aria-haspopup="dialog"
        aria-expanded={optionsOpen}
        onClick={(e) => onOptions(book.id, e.currentTarget, true)}
      >
        <svg viewBox="0 0 24 12" aria-hidden="true" focusable="false">
          <circle cx="7.5" cy="6" r="1.15" />
          <circle cx="12" cy="6" r="1.15" />
          <circle cx="16.5" cy="6" r="1.15" />
        </svg>
      </button>
    </li>
  )
})

/** The covers near the view (`IntersectionObserver` on the scroller); every one without it. */
function useNear(
  scroller: RefObject<HTMLElement | null>,
  list: RefObject<HTMLElement | null>,
  books: readonly Book[],
): ReadonlySet<string> | null {
  const [near, setNear] = useState<ReadonlySet<string> | null>(() =>
    typeof IntersectionObserver === 'undefined' ? null : new Set(),
  )
  const io = useRef<IntersectionObserver | null>(null)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const obs = new IntersectionObserver(
      (entries) =>
        setNear((was) => {
          let next: Set<string> | null = null
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.bookId
            if (id === undefined || (was?.has(id) ?? false) === e.isIntersecting) continue
            next ??= new Set(was)
            if (e.isIntersecting) next.add(id)
            else next.delete(id)
          }
          return next ?? was
        }),
      // A view above and below: a cover is drawn before it scrolls in.
      { root: scroller.current, rootMargin: '100% 0px' },
    )
    io.current = obs
    return () => {
      obs.disconnect()
      io.current = null
    }
  }, [scroller])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the books changing is the cue
  useEffect(() => {
    const obs = io.current
    const el = list.current
    if (!obs || !el) return
    for (const li of el.querySelectorAll('li[data-book-id]')) obs.observe(li)
  }, [books, list])
  return near
}

interface Drag {
  id: string
  pointerId: number
  x: number
  y: number
  started: boolean
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * The bookshelf: a wall of light wood with its shelves, the books standing face-out in
 * shelf order and wrapping onto as many shelves as they need, "New book" at the end of the last,
 * and "Recently deleted" below while a book can be put back. It lies over the board (which stays
 * mounted, dimmed and inert, under it); the sidebar stays in use beside it. Covers are drawn only
 * near the view. A book is moved by dragging it (a finger holds it first), or with Alt and the
 * arrows; ⌘Z undoes the shelf's own changes. Esc, or a press outside the wall, goes back to the
 * board.
 */
const NO_BOOKS: readonly Book[] = []

export function ShelfScreen({ session }: { session: BoardSession }) {
  useRememberedScreen(session, { screen: 'shelf' })
  useFocusBack()
  // While the board is still coming in its books may be none, or one: the shelf waits, empty
  // and quiet, until it has them all (never some of them, never "New book" alone).
  const { opening } = session
  const whole = useSyncExternalStore(
    useCallback((fn: () => void) => opening.onBooksWhole(fn), [opening]),
    () => opening.booksWhole,
  )
  const all = useBooks()
  const books = whole ? all : NO_BOOKS
  const trashed = useTrashedBooks()
  const narrow = useNarrow()
  const size = narrow ? NARROW : WIDE
  const sheet = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const near = useNear(scroller, list, books)
  const [preview, setPreview] = useState<{ id: string; to: number } | null>(null)
  const [options, setOptions] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  /** The book Delete asks about, and its options button, which has the focus back after Keep. */
  const [asking, setAsking] = useState<{ id: string; opener: HTMLElement } | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const drag = useRef<Drag | null>(null)
  /** When a drag ended: the click that ends the press that dragged does not open the book. */
  const dragged = useRef(Number.NEGATIVE_INFINITY)
  /** The book whose button takes the focus after the next commit (a keyboard move). */
  const refocus = useRef<string | null>(null)
  const restorableNow = restorable(trashed, Date.now())

  const shown = useMemo(() => {
    if (!preview) return books
    const moving = books.find((b) => b.id === preview.id)
    if (!moving) return books
    const rest = books.filter((b) => b.id !== preview.id)
    rest.splice(preview.to, 0, moving)
    return rest
  }, [books, preview])

  useEffect(() => {
    sheet.current?.focus({ preventScroll: true })
  }, [])

  useLayoutEffect(() => {
    const id = refocus.current
    if (id === null) return
    refocus.current = null
    list.current
      ?.querySelector<HTMLElement>(`li[data-book-id="${id}"] .shelf-open`)
      ?.focus({ preventScroll: true })
  })

  // Esc goes back to the board; ⌘Z and ⇧⌘Z step the board's history (the canvas under the
  // sheet takes no keys). What is open over the shelf (a popover, a question) has Esc first.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return
      const step = historyKey(e)
      if (step) {
        e.preventDefault()
        stepHistory(session, step)
        return
      }
      if (e.key === 'Escape' && sheet.current?.isConnected) {
        e.preventDefault()
        navigate({ name: 'board' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session])

  const onOpen = useCallback((id: string) => {
    if (performance.now() - dragged.current < 400) return
    openBook(id)
  }, [])
  const onOptions = useCallback((id: string, anchor: HTMLElement, toggle: boolean) => {
    // A long press that is a drag (Android's context menu) opens nothing.
    if (drag.current?.started) return
    setOptions((o) => (toggle && o?.id === id ? null : { id, anchor }))
  }, [])

  const move = useCallback(
    (id: string, to: number) => {
      const from = books.findIndex((b) => b.id === id)
      if (!moveBook(session, books, id, to)) return
      refocus.current = id
      const book = books[from]
      const at = Math.max(0, Math.min(books.length - 1, to))
      if (book) announce(`Moved ${titleOf(book)} to place ${at + 1} of ${books.length}`)
    },
    [books, session],
  )

  const onKey = useCallback(
    (id: string, e: KeyboardEvent<HTMLButtonElement>) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return
      const from = books.findIndex((b) => b.id === id)
      // A row's length: the books standing at the first book's height.
      const slots = [...(list.current?.querySelectorAll<HTMLElement>('li[data-book-id]') ?? [])]
      const top = slots[0]?.offsetTop
      const cols = Math.max(1, slots.filter((s) => s.offsetTop === top).length)
      const by: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -cols,
        ArrowDown: cols,
      }
      const d = by[e.key]
      if (d === undefined) return
      e.preventDefault()
      const to = Math.max(0, Math.min(books.length - 1, from + d))
      if (to !== from) move(id, to)
    },
    [books, move],
  )

  // ---- dragging: the book moves into the place under the pointer as it goes -----------------

  const placeAt = (x: number, y: number): number | null => {
    const slots = [...(list.current?.querySelectorAll<HTMLElement>('li[data-book-id]') ?? [])]
    let best: number | null = null
    let bestD = Number.POSITIVE_INFINITY
    slots.forEach((s, i) => {
      const r = s.getBoundingClientRect()
      if (r.width === 0) return
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }

  const startDrag = (d: Drag) => {
    d.started = true
    setOptions(null)
    try {
      list.current?.setPointerCapture?.(d.pointerId)
    } catch {
      // The pointer is gone already.
    }
    setPreview({ id: d.id, to: books.findIndex((b) => b.id === d.id) })
  }

  const onPointerDown = (e: PointerEvent<HTMLOListElement>) => {
    if (e.button !== 0 || !(e.target instanceof Element) || e.target.closest('.shelf-more')) return
    const li = e.target.closest<HTMLElement>('li[data-book-id]')
    const id = li?.dataset.bookId
    if (id === undefined) return
    const d: Drag = {
      id,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      started: false,
      timer: null,
    }
    // A finger holds the book a moment first, so a swipe still scrolls the shelf.
    if (e.pointerType === 'touch') d.timer = setTimeout(() => startDrag(d), HOLD_MS)
    drag.current = d
  }

  const onPointerMove = (e: PointerEvent<HTMLOListElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    if (!d.started) {
      const far = Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_PX
      if (!far) return
      if (d.timer !== null) {
        // A finger moved before it held: a scroll, not a drag.
        clearTimeout(d.timer)
        drag.current = null
        return
      }
      startDrag(d)
    }
    const to = placeAt(e.clientX, e.clientY)
    if (to !== null) setPreview((p) => (p && p.to !== to ? { id: p.id, to } : p))
  }

  const endDrag = (e: PointerEvent<HTMLOListElement>, drop: boolean) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    drag.current = null
    if (d.timer !== null) clearTimeout(d.timer)
    if (!d.started) return
    dragged.current = performance.now()
    const p = preview
    setPreview(null)
    if (drop && p) move(p.id, p.to)
  }

  // A held finger's drag must not scroll the shelf under it.
  useEffect(() => {
    const el = list.current
    if (!el) return
    const hold = (e: TouchEvent) => {
      if (drag.current?.started) e.preventDefault()
    }
    el.addEventListener('touchmove', hold, { passive: false })
    return () => el.removeEventListener('touchmove', hold)
  }, [])

  const optionsBook = options ? books.find((b) => b.id === options.id) : undefined
  const askingBook = asking ? books.find((b) => b.id === asking.id) : undefined

  const deleteBook = (id: string) => {
    const at = books.findIndex((b) => b.id === id)
    setAsking(null)
    trashBook(session, id)
    // The focus goes to the book that takes its place, or "New book".
    const next = books[at + 1] ?? books[at - 1]
    requestAnimationFrame(() => {
      const el = next
        ? list.current?.querySelector<HTMLElement>(`li[data-book-id="${next.id}"] .shelf-open`)
        : list.current?.querySelector<HTMLElement>('.shelf-new-button')
      el?.focus({ preventScroll: true })
    })
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc is the keyboard's way out; the veil is for the pointer
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above
    <div
      className="books-veil shelf-veil"
      onClick={(e) => {
        if (e.target === e.currentTarget) navigate({ name: 'board' })
      }}
    >
      <section ref={sheet} className="shelf" role="dialog" aria-label="Books" tabIndex={-1}>
        <div className="shelf-scroll" ref={scroller}>
          <div className="shelf-wall">
            <h1 className="shelf-heading">Books</h1>
            <ol
              ref={list}
              className="shelf-books"
              aria-label="Books on the shelf"
              aria-busy={!whole || undefined}
              data-dragging={preview ? '' : undefined}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => endDrag(e, true)}
              onPointerCancel={(e) => endDrag(e, false)}
            >
              {shown.map((b) => (
                <ShelfBook
                  key={b.id}
                  book={b}
                  near={near === null || near.has(b.id)}
                  size={size}
                  dragging={preview?.id === b.id}
                  optionsOpen={options?.id === b.id}
                  onOpen={onOpen}
                  onOptions={onOptions}
                  onKey={onKey}
                />
              ))}
              {whole && (
                <li className="shelf-new">
                  <button
                    type="button"
                    className="shelf-new-button"
                    onClick={() => createBook(session)}
                  >
                    <PlusIcon />
                    <span>New book</span>
                  </button>
                </li>
              )}
            </ol>
            {/* An empty shelf: a quiet line beside "New book", in the empty board's voice. */}
            {whole && shown.length === 0 && <p className="shelf-invite">Begin with a first book</p>}
            {whole && restorableNow.length > 0 && (
              <p className="shelf-foot">
                <button
                  type="button"
                  className="shelf-trash-link"
                  aria-haspopup="dialog"
                  aria-expanded={trashOpen}
                  onClick={() => setTrashOpen((o) => !o)}
                >
                  Recently deleted
                </button>
              </p>
            )}
          </div>
        </div>
        <BookNotices session={session} />
        {trashOpen && restorableNow.length > 0 && (
          <RecentlyDeleted
            session={session}
            books={restorableNow}
            onClose={() => setTrashOpen(false)}
          />
        )}
        {askingBook && (
          <DeletePrompt
            title={titleOf(askingBook)}
            onDelete={() => deleteBook(askingBook.id)}
            onKeep={() => {
              const opener = asking?.opener
              setAsking(null)
              queueMicrotask(() => opener?.isConnected && opener.focus({ preventScroll: true }))
            }}
          />
        )}
      </section>
      {options && optionsBook && (
        <BookPopover
          session={session}
          book={optionsBook}
          anchor={options.anchor}
          onClose={(refocusAnchor) => {
            setOptions(null)
            if (refocusAnchor) options.anchor.focus()
          }}
          onDelete={() => {
            // Recorded now: the popover going hands the focus to the board.
            setAsking({ id: optionsBook.id, opener: options.anchor })
            setOptions(null)
          }}
        />
      )}
    </div>
  )
}
