import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { CanvasView } from '../canvas/CanvasView'
import { createSyncFeed, type SyncFeed, useFeed } from '../sync/feed'
import { isSideKey, pressBooks } from '../ui/buttons'
import { atIdle } from './atIdle'
import { bootstrapBoard, rememberedBoard } from './bootstrap'
import { ChunkBoundary } from './ChunkBoundary'
import { announce } from './liveRegion'
import {
  BookChunk,
  prefetchBookChunks,
  ShelfChunk,
  showUses,
  UsesChunk,
  usesShown,
} from './prefetchBooks'
import { prepayHover } from './prepayHover'
import { navigate, type SettingsSection } from './router'
import { CorkStage, PinnedCard, useCoverShellCork } from './Stage'
import { boardViewport, onSplit, recallScreen, recallSplit, splitFits } from './screenMemory'
import { type BoardSession, openServerSession } from './session'
import { useSlipOnPane } from './slipPlace'
import { UpdateSlip } from './UpdateSlip'

/** What a screen reader hears as the board opens: how many notes it holds. */
export const boardOpenCopy = (n: number): string =>
  `Your board is open: ${n === 0 ? 'no notes yet' : n === 1 ? '1 note' : `${n.toLocaleString('en')} notes`}`

const toBoard = () => navigate({ name: 'board' })

// Settings loads when it is first opened, not with the board.
const Settings = lazy(() => import('../settings/Settings').then((m) => ({ default: m.Settings })))

type Screen =
  | { kind: 'loading'; feed: SyncFeed }
  | { kind: 'ready'; session: BoardSession }
  | { kind: 'failed' }

/** Whether this page has opened a board screen yet: only its first open goes where you left off. */
let opened = false
/**
 * Papertie opened at the board goes where you left off: to the book that was
 * open, if writing was the last screen; the board's opening runs under it, covered,
 * and the writer's chunk comes at once beside it. Only the page's first open: going to the board
 * later stays on the board.
 */
function whereYouLeftOff(atBoard: boolean): void {
  if (opened) return
  opened = true
  if (!atBoard) return
  const boardId = rememberedBoard()
  if (boardId === null) return
  const bookId = bookLeftOpen(boardId)
  if (bookId === null) return
  prefetchBookChunks()
  // Pushed: Back goes to the board it opened at (which stays the board: `opened` is set).
  navigate({ name: 'book', id: bookId })
}

/** The book open in the writer when `boardId` was last left, or null. */
function bookLeftOpen(boardId: string): string | null {
  const last = recallScreen(boardId).last
  return last.screen === 'book' ? last.bookId : null
}

/**
 * One bootstrap at a time: a remount while one runs (StrictMode runs effects twice) must not make
 * a second first board; once it is over, a later open asks again (and finds the board made).
 * Resolves with the board to open.
 */
let booting: Promise<string> | null = null

function bootOnce(): Promise<string> {
  if (booting === null) {
    const promise = bootstrapBoard(() => new Date().toISOString())
    booting = promise
    const over = () => {
      if (booting === promise) booting = null
    }
    promise.then(over, over)
  }
  return booting
}

/**
 * Before the board's first paint: the bare cork, saying nothing (no loading screen; the notes
 * arrive nearest first). While the store cannot be reached, it says what it waits for.
 */
function Opening({ feed }: { feed: SyncFeed }) {
  const waiting = useFeed(feed, (s) => s.status === 'offline')
  if (!waiting) return <CorkStage />
  return (
    <PinnedCard title="Still opening">
      <p className="stage-lead">Your board opens as soon as Papertie can read it.</p>
    </PinnedCard>
  )
}

/**
 * The board, and over it the slip that asks for a reload once this page is out of date. Settings
 * lies over the board the same way: the board stays mounted and inert under it.
 */
function OpenBoard({
  session,
  book,
  children,
}: {
  session: BoardSession
  /** Whether a book is open (not under Settings). */
  book: boolean
  children: ReactNode
}) {
  useCoverShellCork()
  const layout = useBookLayout()
  const updated = useFeed(session.feed, (s) => s.updated)
  const updatedCopy = useFeed(session.feed, (s) => s.updatedCopy)
  // Said once, through the page's live region (the slip mounts with its words, which a live
  // region of its own might not be heard saying).
  // biome-ignore lint/correctness/useExhaustiveDependencies: said when the slip comes, once
  useEffect(() => {
    if (updated) announce(updatedCopy)
  }, [updated])
  // Beside the book, the slip stands on the pane the user works in, never across the seam.
  const updatedSlip = useRef<HTMLElement>(null)
  useSlipOnPane(updatedSlip, updated)
  return (
    <>
      <div className="board-stage">{children}</div>
      {updated && (
        // Over every screen (the board, the shelf, a book): this page sends nothing more until it
        // is reloaded.
        <section ref={updatedSlip} className="sync-updated" aria-label="Notices">
          <div className="sync-slip sync-paper" role="note" data-kind="updated">
            <p className="sync-slip-text">{updatedCopy}</p>
            <button
              type="button"
              className="sync-text-button"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </section>
      )}
      {/* Desktop app: a newer Papertie, said quietly; never on the writer's text. */}
      <UpdateSlip writing={book ? layout : null} waiting={updated} />
    </>
  )
}

/** The shelf, or a book. */
type Books = { kind: 'shelf' } | { kind: 'book'; bookId: string }

/** How an open book lies: beside the board on a wide window when kept so, else full width. */
const layoutNow = (): 'split' | 'full' =>
  splitFits(window.innerWidth) && recallSplit().board ? 'split' : 'full'

/** The open book's layout, following the window's width and the split preference. */
function useBookLayout(): 'split' | 'full' {
  const subscribe = useCallback((fn: () => void) => {
    window.addEventListener('resize', fn)
    const off = onSplit(fn)
    return () => {
      window.removeEventListener('resize', fn)
      off()
    }
  }, [])
  return useSyncExternalStore(subscribe, layoutNow)
}

/**
 * The board, and a book screen with it (the split view): the shelf lies over the board as
 * a sheet (as Settings does, `sheet`); an open book always lies beside it, in the one slot after
 * the board (`beside`), so a change of layout never remounts the writer or breaks a composition.
 * Split, the board stays live beside the book; full width (a narrow window, or the
 * board not wanted beside it), the book lies over the covered board.
 *
 * ⌘\ is two visible controls' accelerator: in the writer its "Board" (`BookScreen`), on the board
 * side Books; from a split view with the focus on the board it closes the book side.
 */
export function BoardWithBooks({
  session,
  books,
  settings = null,
}: {
  session: BoardSession
  books: Books | null
  /** The Settings sheet lying over the board, when it is open. */
  settings?: ReactNode
}) {
  const layout = useBookLayout()
  const book = settings === null && books?.kind === 'book' ? books.bookId : null
  const bookLayout = book === null ? 'full' : layout
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSideKey(e) || e.isComposing || e.defaultPrevented) return
      // In the book's pane it is the writer's ("Board": `BookScreen`).
      if (e.target instanceof Element && e.target.closest('.book-pane')) return
      e.preventDefault()
      if (book !== null && bookLayout === 'split') navigate({ name: 'board' })
      else pressBooks(session.boardId, books !== null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session, book, bookLayout, books])
  return (
    <>
      <CanvasView
        session={session}
        covered={
          settings !== null || books?.kind === 'shelf' || (book !== null && layout === 'full')
        }
        books={settings === null && books !== null && (books.kind === 'book' ? 'book' : true)}
        layout={bookLayout}
        sheet={
          settings ??
          (books?.kind === 'shelf' && (
            <ChunkBoundary sheet retry onEscape={toBoard}>
              <Suspense fallback={null}>
                <ShelfChunk.Component session={session} />
              </Suspense>
            </ChunkBoundary>
          ))
        }
        beside={
          book === null
            ? undefined
            : (rt) => (
                <ChunkBoundary sheet retry onEscape={toBoard}>
                  <Suspense fallback={null}>
                    <BookChunk.Component
                      key={book}
                      session={session}
                      bookId={book}
                      layout={bookLayout}
                      runtime={rt}
                    />
                  </Suspense>
                </ChunkBoundary>
              )
        }
      />
      <CardUsesHost session={session} />
    </>
  )
}

/**
 * A card's reverse mark, open: the books it names (its own chunk). The only
 * subscriber to `usesShown`, so hovering ink dots re-renders this alone, never the board and the
 * book beside it.
 */
function CardUsesHost({ session }: { session: BoardSession }) {
  const uses = useSyncExternalStore(usesShown.subscribe, usesShown.get)
  if (uses === null) return null
  return (
    <ChunkBoundary>
      <Suspense fallback={null}>
        <UsesChunk.Component
          key={uses.noteId}
          session={session}
          noteId={uses.noteId}
          anchor={uses.anchor}
          onClose={() => showUses(null)}
        />
      </Suspense>
    </ChunkBoundary>
  )
}

/**
 * The user's board (made on first use) on the canvas, synced through a server session.
 */
export function BoardScreen({
  settings = null,
  books = null,
}: {
  /** The Settings section lying over the board, when it is open. */
  settings?: SettingsSection | null
  /** The book sheet lying over the board, when one is open: the shelf, or a book. */
  books?: Books | null
}) {
  const [screen, setScreen] = useState<Screen>(() => ({ kind: 'loading', feed: createSyncFeed() }))
  const [attempt, setAttempt] = useState(0)
  const atBoard = settings === null && books === null
  // biome-ignore lint/correctness/useExhaustiveDependencies: the page's first open only
  useEffect(() => whereYouLeftOff(atBoard), [])
  // The first key typed must not pay Chrome's first hover move on macOS: made at idle.
  useEffect(() => prepayHover(), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the open
  useEffect(() => {
    const abort = new AbortController()
    const feed = createSyncFeed()
    setScreen({ kind: 'loading', feed })
    let opened: BoardSession | null = null
    // A book opens with the board (on its address, or Papertie gone back into it, which the first
    // open's effect above has set by now): the board lies beside it.
    const beside = settings === null && books?.kind === 'book'
    const open = (id: string) =>
      openServerSession(id, {
        feed,
        signal: abort.signal,
        // Beside a book, the board's half of the window: its first paint is read for that.
        viewport: boardViewport(window.innerWidth, window.innerHeight, beside),
      })
    /** The open being shown (or to be): a session of any other open is let go. */
    let current: Promise<BoardSession> | null = null
    const fail = () => {
      if (abort.signal.aborted) return
      setScreen({ kind: 'failed' })
    }
    /** Show `p`'s session once it opens; `onFail` when it fails (a failed open, by default). */
    const show = (p: Promise<BoardSession>, onFail: () => void = fail) => {
      current = p
      p.then(
        (s) => {
          if (abort.signal.aborted || current !== p) {
            s.dispose()
            return
          }
          opened = s
          setScreen({ kind: 'ready', session: s })
          // Said once the whole board is in (a route change says nothing by itself); the book
          // screens' chunks come in at idle then, so Books opens the shelf at once.
          s.opening.done.then(
            () => {
              if (!abort.signal.aborted && opened === s) {
                announce(boardOpenCopy(s.store.getState().notes.size))
                atIdle(prefetchBookChunks)
              }
            },
            () => {},
          )
          // Shown from its first paint: an opening that fails after it ends as a failed open would.
          s.opening.done.catch(() => {
            if (abort.signal.aborted || opened !== s) return
            s.dispose()
            opened = null
            setScreen({ kind: 'failed' })
          })
        },
        () => {
          if (current === p) onFail()
        },
      )
    }
    // The board opened last opens at once, beside the board list, not after it: the list's
    // round trip (the main process's first moments) does not hold it. Should the list name
    // another board (after "Delete all data", say), that one opens instead.
    const guess = rememberedBoard()
    const booted = bootOnce()
    if (guess === null) {
      show(booted.then(open))
    } else {
      const early = open(guess)
      // Whether the list has the board opened early (an unanswered list leaves it standing).
      const kept = booted.then(
        (id) => (id === guess ? null : id),
        () => null,
      )
      // An early open that fails stands as failed only once the list has named its board too.
      show(early, () => void kept.then((other) => other === null && fail()))
      void kept.then((other) => {
        if (other === null || abort.signal.aborted) return
        // The early open is let go: shown already, here; still opening, once it opens (`show`).
        if (opened !== null) {
          opened.dispose()
          opened = null
          setScreen({ kind: 'loading', feed })
        }
        show(open(other))
      })
    }
    return () => {
      abort.abort()
      opened?.dispose()
    }
  }, [attempt])

  if (screen.kind === 'loading') return <Opening feed={screen.feed} />
  if (screen.kind === 'failed')
    return (
      <PinnedCard title="Couldn’t open your board">
        <p className="stage-lead">Nothing on it is lost. Try again in a moment.</p>
        <button className="stage-button" type="button" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </PinnedCard>
    )
  return (
    <OpenBoard session={screen.session} book={settings === null && books?.kind === 'book'}>
      <BoardWithBooks
        session={screen.session}
        books={books}
        settings={
          settings === null ? null : (
            <Suspense fallback={null}>
              <Settings section={settings} session={screen.session} />
            </Suspense>
          )
        }
      />
    </OpenBoard>
  )
}
