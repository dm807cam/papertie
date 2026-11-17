import { LIMITS } from '@papertie/core'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { navigate } from '../app/router'
import { recallSplit, rememberSplit, splitFits } from '../app/screenMemory'
import type { BoardSession } from '../app/session'
import { NEW_NOTE } from '../notes/noteDesign'
import { useBook } from '../sync/books/bookStore'
import { isSideKey, SIDE_KEYS } from '../ui/buttons'
import { BooksIcon } from '../ui/sidebarIcons'
import { type BesideRuntime, wholeBoard } from './beside'
import { CopyMoveChip, type CopyOrMove } from './drop/CopyMoveChip'
import { type DropForm, switchLabel, switchOps } from './drop/cardBlocks'
import { createCardDrop, type Dropped } from './drop/cardDrop'
import { DropChooser } from './drop/DropChooser'
import { likelyForm } from './drop/dropForms'
import { InsertCard, insertAfter } from './drop/InsertCard'
import type { Pos } from './editor/model'
import { FindBar } from './find/FindBar'
import { FindRef } from './footnotes/FindRef'
import { FootnoteLayer } from './footnotes/FootnoteLayer'
import { Outline } from './Outline'
import { writerOpen } from './openWriter'
import { startSelectionDrag } from './out/selectionDrag'
import { pinSelection } from './out/toCard'
import { PinLayer } from './pins/PinLayer'
import { Seam } from './Seam'
import {
  forgetTitleIntent,
  renameBook,
  titleIntent,
  useFocusBack,
  useRememberedScreen,
} from './shelfActions'
import { useWritingTools } from './tools/WritingTools'
import type { BookLang } from './typography'
import { startWriter, type Writer } from './writer'
import './writerFonts'
import './shelf.css'
import './writer.css'

/** What the shelf says when a restore leaves the open book out. */
const GONE = 'This book isn’t in the restored board.'
/** What the page says while its book could not be read (it is read again by itself). */
export const UNREAD = 'This book couldn’t be read just now. Papertie will try again.'

const apple = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** ⌘K (Ctrl+K) in the book: Insert card's accelerator. */
const isInsertKey = (e: KeyboardEvent) =>
  e.metaKey !== e.ctrlKey &&
  !e.altKey &&
  !e.shiftKey &&
  (e.key.toLowerCase() === 'k' || e.code === 'KeyK')

/** ⌘F (Ctrl+F) in the book: Find's accelerator; on the board it stays the browser's. */
const isFindKey = (e: KeyboardEvent) =>
  e.metaKey !== e.ctrlKey &&
  !e.altKey &&
  !e.shiftKey &&
  (e.key.toLowerCase() === 'f' || e.code === 'KeyF')

/** The drop's chooser: what was made, the form it is in now, and which drop (its key). */
interface Made {
  d: Dropped
  form: DropForm
  n: number
}

/**
 * "Board" (⌘\): on a window wide enough for the split, the board beside the book or not (the app
 * keeps it); below it, to the board (the book kept as the last one: Books comes back to it).
 */
export function toggleBoard(): void {
  if (!splitFits(window.innerWidth)) {
    navigate({ name: 'board' })
    return
  }
  const s = recallSplit()
  rememberSplit({ ...s, board: !s.board })
}

interface Props {
  session: BoardSession
  bookId: string
  layout?: 'split' | 'full'
  /**
   * The board's runtime beside the book: a card dragged across the seam lands here, and
   * a selection goes out onto it.
   */
  runtime?: BesideRuntime | null
}

/**
 * A book open in the writer, beside the board or over it (`layout`: the split view's pane or the
 * full-width sheet):
 * the book's title, the one place it is renamed, heading the page; the text below it, written
 * in the board's own way (`writer.ts`); its words in the corner; its formatting in the sidebar
 * (`tools/WritingTools.tsx`); the chapters' outline at the page's left edge. It opens where the book was left (its
 * place, the caret there unless the title is to be typed in first). "Books" at the top left and
 * Esc go to the shelf (never Esc while a dead key composes). A book restored away
 * sends the writer to the shelf, which says so.
 */
export function BookScreen({ session, bookId, layout = 'full', runtime = null }: Props) {
  useRememberedScreen(session, { screen: 'book', bookId })
  useFocusBack()
  const book = useBook(bookId)
  // How it was asked to open: this mount's, whatever StrictMode runs twice.
  const [asked] = useState(() => titleIntent(bookId))
  const sheet = useRef<HTMLElement>(null)
  const title = useRef<HTMLInputElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [writer, setWriter] = useState<Writer | null>(null)
  const [shown, setShown] = useState(false)
  const [words, setWords] = useState<number | null>(null)
  const [unread, setUnread] = useState(false)
  const lang = useRef<BookLang>(book?.lang ?? 'en')
  lang.current = book?.lang ?? 'en'

  useLayoutEffect(() => {
    forgetTitleIntent(bookId)
    const t = asked
    const field = title.current
    if (t !== null && field) {
      field.focus({ preventScroll: true })
      if (t === 'select') field.select()
    } else sheet.current?.focus({ preventScroll: true })
  }, [bookId, asked])

  // The writer, per mount (StrictMode's second mount makes its own).
  useEffect(() => {
    const el = body.current
    if (el === null) return
    const w = startWriter({
      session,
      bookId,
      body: el,
      scroller: scroller.current,
      lang: () => lang.current,
      onWords: setWords,
      onShown: setShown,
      onUnread: setUnread,
      place: { focus: asked === null },
      onGone: (restored) => {
        if (restored) session.feed.notice({ kind: 'book-gone', count: 1, message: GONE, bookId })
        navigate({ name: 'shelf' })
      },
    })
    setWriter(w)
    return () => {
      w.destroy()
      setWriter(null)
    }
    // `asked` is this mount's own (read once as it was made).
  }, [session, bookId, asked])

  // What a card dropped or inserted became, and its chooser.
  const [made, setMade] = useState<Made | null>(null)
  const drops = useRef(0)
  const showMade = (d: Dropped) => {
    if (d.blockIds.length > 0) setMade({ d, form: d.form, n: ++drops.current })
    else setMade(null)
  }
  const switchTo = (m: Made, f: DropForm) => {
    const ops = switchOps(session.store.getState(), bookId, m.d.blockIds, new Set(m.d.bullets), f)
    if (ops.length > 0) session.store.commit(ops, { label: switchLabel(f) })
    setMade({ ...m, form: f })
  }
  // On touch: a card held still beside the book offers Copy · Move, which arms its next drag.
  const [chip, setChip] = useState<{ x: number; y: number } | null>(null)
  const [armedShown, setArmedShown] = useState<CopyOrMove | null>(null)
  const armed = useRef<CopyOrMove | null>(null)
  const arm = (how: CopyOrMove | null) => {
    armed.current = how
    setArmedShown(how)
  }
  const page = () => body.current?.querySelector<HTMLElement>('.bk-book') ?? body.current

  // Beside the board, the page takes a card dragged across the seam.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the setters and refs are stable
  useEffect(() => {
    const el = scroller.current
    if (layout !== 'split' || runtime === null || writer === null || el === null) return
    const drop = createCardDrop({
      session,
      bookId,
      engine: writer.engine,
      page,
      scroller: el,
      form: likelyForm,
      armed: () => armed.current,
      dropped: (d) => {
        arm(null)
        showMade(d)
      },
      hovering: () => setMade(null),
      press: (_id, x, y) => {
        arm(null)
        setChip({ x, y })
      },
    })
    runtime.setSeamDrop(drop)
    return () => {
      runtime.setSeamDrop(null)
      drop.destroy()
    }
  }, [layout, runtime, writer, session, bookId])

  // Beside the board, a selection dragged out of the book onto it is a card there.
  useEffect(() => {
    if (layout !== 'split' || !wholeBoard(runtime) || writer === null) return
    const engine = writer.engine
    return engine.onDragOut((press) => {
      const range = engine.range()
      if (range === null) return
      startSelectionDrag({
        session,
        bookId,
        range,
        board: runtime,
        book: pane.current,
        from: press,
      })
    })
  }, [layout, runtime, writer, session, bookId])

  // "Pin to board" (and "Move to board"): a card of the selection at the board's view centre,
  // in a split view or not; the board selects it.
  const board = wholeBoard(runtime) ? runtime : null
  const pin =
    board === null || writer === null
      ? undefined
      : (move: boolean) => {
          const range = writer.engine.range()
          if (range === null) return
          pinSelection({ session, bookId, range, at: board.placeNear(NEW_NOTE), move, board })
        }

  // The formatting tools in the sidebar (where the selection popover was): this book's engine
  // and Pin, its selection, and beside the board where the user works.
  useWritingTools(writer?.engine ?? null, pin, layout)

  // The book open here: the reverse view's "Used in" and "From" go to a block of it through the
  // writer (the route is the one shown, so a navigation would not move it).
  useEffect(() => {
    if (writer === null) return
    return writerOpen({ bookId, reveal: (id) => writer.engine.reveal(id) })
  }, [writer, bookId])

  // Shown (no longer inert): the caret to where the book was left, when it opened at its place.
  useEffect(() => {
    if (shown) writer?.shown()
  }, [shown, writer])

  const pane = useRef<HTMLElement>(null)
  // ⌘K and Insert card: the picker, after the paragraph the caret was in as it opened.
  const [inserting, setInserting] = useState<{ after: string | null } | null>(null)
  // ⌘K in a footnote: the ref picker, to insert a card's ref at the caret there.
  const [citing, setCiting] = useState<Pos | null>(null)
  const openInsert = () => {
    if (writer === null) return
    const at = writer.engine.footnoteAt()
    if (at !== null) {
      setMade(null)
      setCiting(at)
      return
    }
    const caret = writer.engine.selection()?.blockId ?? null
    const view = { page: page(), scroller: scroller.current }
    setMade(null)
    setInserting({ after: insertAfter(session, bookId, writer.engine, caret, view) })
  }
  const inserted = (d: Dropped) => {
    const last = d.last === null ? undefined : session.store.getState().blocks.get(d.last)
    if (writer !== null && last !== undefined) {
      writer.engine.focusAt({ blockId: last.id, offset: last.text.length })
    }
    showMade(d)
  }
  const insertKey = useRef(openInsert)
  insertKey.current = openInsert
  // Find: the bar at the pane's top; ⌘F again, its field focused and selected.
  const [finding, setFinding] = useState(false)
  const openFind = () => {
    setFinding(true)
    const f = sheet.current?.querySelector<HTMLInputElement>('.find-field')
    f?.focus({ preventScroll: true })
    f?.select()
  }
  const findKey = useRef(openFind)
  findKey.current = openFind

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return
      // Beside the board, only the book's own keys: the board's Esc is the board's.
      const mine = !(e.target instanceof Node) || pane.current?.contains(e.target) === true
      if (isSideKey(e)) {
        if (!mine) return
        e.preventDefault()
        toggleBoard()
        return
      }
      if (isInsertKey(e)) {
        if (!mine) return
        e.preventDefault()
        insertKey.current()
        return
      }
      if (isFindKey(e)) {
        if (!mine) return
        e.preventDefault()
        findKey.current()
        return
      }
      if (e.key !== 'Escape' || (layout === 'split' && !mine)) return
      // A dead key pending is cancelled by its Esc, never the page.
      if (writer?.engine.composing()) return
      e.preventDefault()
      navigate({ name: 'shelf' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [writer, layout])

  // The book's share of the window beside the board, as the app keeps it (CSSOM: the CSP).
  useLayoutEffect(() => {
    const wrap = pane.current?.closest<HTMLElement>('.board-split')
    if (layout === 'split' && wrap && wrap.style.getPropertyValue('--book-share') === '')
      wrap.style.setProperty('--book-share', String(recallSplit().ratio))
  }, [layout])

  // Renamed elsewhere while the field is not in use: it shows the new title.
  const remoteTitle = book?.title
  useEffect(() => {
    const field = title.current
    if (field && remoteTitle !== undefined && document.activeElement !== field) {
      if (field.value !== remoteTitle) field.value = remoteTitle
    }
  }, [remoteTitle])

  const name = book?.title.trim() || 'Untitled'
  const split = layout === 'split'
  return (
    // Beside the board the pane is the book's landmark (its seam in it); full width, a dialog.
    <section
      ref={pane}
      className={split ? 'book-pane' : 'book-pane books-veil book-veil'}
      data-layout={layout}
      aria-label={split ? name : undefined}
    >
      {split && <Seam board={runtime} />}
      <section
        ref={sheet}
        className="book-sheet writer"
        role={split ? undefined : 'dialog'}
        aria-label={split ? undefined : name}
        tabIndex={-1}
        lang={book?.lang}
      >
        {/* The top band: Books at the left; Find, Insert card and Board at the right, in the
            same quiet ink. */}
        <div className="writer-band">
          <button
            type="button"
            className="writer-books"
            onClick={() => navigate({ name: 'shelf' })}
          >
            <BooksIcon />
            <span>Books</span>
          </button>
          <button
            type="button"
            className="writer-books writer-find"
            aria-keyshortcuts="Meta+F Control+F"
            aria-expanded={finding}
            title={`Find (${apple() ? '⌘F' : 'Ctrl+F'})`}
            // The caret stays in the page: the search starts there.
            onMouseDown={(e) => e.preventDefault()}
            onClick={openFind}
          >
            <span>Find</span>
          </button>
          <button
            type="button"
            className="writer-books writer-insert"
            aria-keyshortcuts="Meta+K Control+K"
            title={`Insert card (${apple() ? '⌘K' : 'Ctrl+K'})`}
            // The caret stays in the page, for the card to go after its paragraph.
            onMouseDown={(e) => e.preventDefault()}
            onClick={openInsert}
          >
            <span>Insert card</span>
          </button>
          <button
            type="button"
            className="writer-books writer-board"
            aria-pressed={split}
            aria-keyshortcuts={SIDE_KEYS}
            title={`Board (${apple() ? '⌘\\' : 'Ctrl+\\'})`}
            onClick={toggleBoard}
          >
            <span>Board</span>
          </button>
        </div>
        {finding && writer && (
          <FindBar
            session={session}
            bookId={bookId}
            engine={writer.engine}
            onClose={() => setFinding(false)}
          />
        )}
        <div ref={scroller} className="writer-scroll">
          <div className="writer-page" lang={book?.lang}>
            {book && (
              <input
                ref={title}
                key={book.id}
                className="book-title"
                aria-label="Title"
                placeholder="Untitled"
                maxLength={LIMITS.maxBookTitle}
                defaultValue={book.title}
                onChange={(e) => {
                  if ((e.nativeEvent as InputEvent).isComposing) return
                  renameBook(session, bookId, e.currentTarget.value)
                }}
                onCompositionEnd={(e) => renameBook(session, bookId, e.currentTarget.value)}
                onKeyDown={(e) => {
                  // From the title, Enter (or ↓) goes on into the text.
                  if (e.nativeEvent.isComposing || (e.key !== 'Enter' && e.key !== 'ArrowDown'))
                    return
                  const first = body.current?.querySelector<HTMLElement>('[data-id]')
                  if (!writer || !first?.dataset.id) return
                  e.preventDefault()
                  writer.engine.focusAt({ blockId: first.dataset.id, offset: 0 })
                }}
              />
            )}
            <div
              ref={body}
              className="writer-body"
              data-shown={shown || undefined}
              aria-busy={!shown || undefined}
              inert={!shown}
            />
            {/* The pins of text from cards, in the left margin, outside the editing host. */}
            {writer && shown && (
              <PinLayer
                session={session}
                bookId={bookId}
                engine={writer.engine}
                page={page}
                layout={layout}
                runtime={runtime}
              />
            )}
            {writer && shown && <FootnoteLayer engine={writer.engine} page={page} />}
          </div>
        </div>
        {unread && !shown && (
          <div className="sync-slip sync-paper writer-unread" role="status">
            <p className="sync-slip-text">{UNREAD}</p>
          </div>
        )}
        {words !== null && shown && (
          <p className="writer-count">
            {words.toLocaleString('en')} {words === 1 ? 'word' : 'words'}
          </p>
        )}
        {writer && shown && <Outline session={session} bookId={bookId} engine={writer.engine} />}
        {made && (
          <DropChooser
            key={made.n}
            blockIds={made.d.blockIds}
            form={made.form}
            count={!made.d.reffed}
            onSwitch={(f) => switchTo(made, f)}
            onDone={() => setMade(null)}
          />
        )}
        {inserting && (
          <InsertCard
            session={session}
            bookId={bookId}
            after={inserting.after}
            onClose={() => setInserting(null)}
            onInserted={inserted}
          />
        )}
        {citing && writer && (
          <FindRef
            session={session}
            engine={writer.engine}
            at={citing}
            onClose={() => setCiting(null)}
          />
        )}
        {chip && (
          <CopyMoveChip
            x={chip.x}
            y={chip.y}
            armed={armedShown}
            onPick={arm}
            onDone={() => setChip(null)}
          />
        )}
      </section>
    </section>
  )
}
