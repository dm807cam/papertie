import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { isReducedMotion, prefsStore, systemReducedMotion, usePrefs } from '../app/prefs'
import type { NoteDesign } from '../notes/noteDesign'
import { onSearchOpen } from '../search/searchStore'
import { MOTION } from '../styles/motion'
import {
  ActionButton,
  BooksButton,
  PhotoButton,
  SELECT,
  SearchButton,
  SettingsButton,
  ToolButton,
  YARN,
} from './buttons'
import { MiniBar } from './MiniBar'
import { NotePicker } from './NotePicker'
import { SelectionActions, type SelectionHost } from './SelectionActions'
import { AppMark, PlusIcon } from './sidebarIcons'
import { useNarrow } from './useNarrow'
import { useToolsMode, useWriterTools } from './writerTools'
import { YarnPicker } from './YarnPicker'
import { registerYarnPicker } from './yarnTool'
import './sidebar.css'

/** What the sidebar asks of the board. */
export interface SidebarProps {
  /** "+": pin a note of `design` at the view's centre and open it for writing. */
  onNewNote(design: NoteDesign): void
  /** The board's selection, for its section; null until the canvas is up. */
  selection?: SelectionHost | null
  /** At the panel's foot, above Books and Settings: a server board's save dot. */
  foot?: ReactNode
  /** The board's id, for the book screen Books goes back to; null for a local board. */
  boardId?: string | null
  /**
   * Under a book sheet (the shelf; `book`, a book open in the writer at full width): the mini-bar
   * holds only what it uses, and under a book both hold the writer's tools, not the board's.
   */
  books?: boolean | 'book'
}

/** "+" and the paper picker it opens beside the panel (above the mini-bar). */
function NewNoteButton({
  onNewNote,
  open,
  onOpenChange,
}: {
  onNewNote(design: NoteDesign): void
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const button = useRef<HTMLButtonElement>(null)
  const close = useCallback(
    (refocus: boolean) => {
      onOpenChange(false)
      if (refocus) button.current?.focus()
    },
    [onOpenChange],
  )
  return (
    <>
      <ActionButton
        ref={button}
        label="New note"
        Icon={PlusIcon}
        className="sidebar-btn sidebar-add"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      />
      {open && (
        <NotePicker
          anchor={button.current}
          onClose={close}
          onPin={(design) => {
            onOpenChange(false)
            onNewNote(design)
          }}
        />
      )}
    </>
  )
}

/**
 * Yarn and its colour picker beside the panel (above the mini-bar): a colour chosen takes the
 * tool up in it and gives the keyboard to the board, to draw. Pressed again while it is the tool,
 * it opens the picker again, for the next threads' colour. Folded, Y opens it beside the mark
 * (`mark`), the one control left to stand by.
 */
function YarnButton({
  open,
  onOpenChange,
  mark,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  mark?: RefObject<HTMLButtonElement | null>
}) {
  const button = useRef<HTMLButtonElement>(null)
  const anchor = () => mark?.current ?? button.current
  const close = useCallback(
    (refocus: boolean) => {
      onOpenChange(false)
      if (refocus) (mark?.current ?? button.current)?.focus()
    },
    [onOpenChange, mark],
  )
  return (
    <>
      <ToolButton
        ref={button}
        entry={YARN}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      />
      {open && (
        <YarnPicker
          anchor={anchor()}
          onClose={close}
          onChoose={(color) => {
            prefsStore.setState({ tool: 'yarn', yarnColor: color })
            onOpenChange(false)
          }}
        />
      )}
    </>
  )
}

/** Which of the sidebar's pickers is open: one at a time. */
type Picking = 'note' | 'yarn' | null

/**
 * The floating tool panel, and the board's only persistent navigation: the
 * app mark, "+" (with its paper picker), the tools (Select, Yarn with its colour picker,
 * Photo, Search), the
 * selection's section while notes are selected, Books and Settings. `foot` sits at the panel's foot,
 * above Settings. What it holds follows what is on screen: under a book at full width, and beside
 * the board while the user works in the book, the writer's tools (`writerTools`: Text style, Bold,
 * Italic, Footnote, Pin to board) and Search instead of the board's, the switch a short fade, the
 * panel's width the same. The mark folds the panel up to itself and unrolls it again, as the app
 * remembers (`prefs.sidebar`): the sheet's clip and two shadows move, never its layout. Under
 * 768 px it is the mini-bar instead.
 */
export function Sidebar({
  onNewNote,
  selection = null,
  foot,
  boardId = null,
  books = false,
}: SidebarProps) {
  const narrow = useNarrow()
  const folded = usePrefs((p) => p.sidebar === 'folded')
  const mode = useToolsMode(books)
  const Tools = useWriterTools((s) => s.Tools)
  // A switch of the tools fades them in (never their first showing).
  const was = useRef(mode)
  const swapped = useRef(false)
  if (was.current !== mode) {
    was.current = mode
    swapped.current = true
  }
  const [picking, setPicking] = useState<Picking>(null)
  // Each picker closes only itself: the other may have opened meanwhile.
  const pickNote = useCallback(
    (open: boolean) => setPicking((p) => (open ? 'note' : p === 'note' ? null : p)),
    [],
  )
  const pickYarn = useCallback(
    (open: boolean) => setPicking((p) => (open ? 'yarn' : p === 'yarn' ? null : p)),
    [],
  )
  const body = useId()
  const tail = useId()
  const sheet = useRef<HTMLDivElement>(null)
  const mark = useRef<HTMLButtonElement>(null)
  // Where the save dot rests: it follows a fold only once it has faded where it was.
  const [footAt, setFootAt] = useState<'panel' | 'tile'>(folded ? 'tile' : 'panel')

  // Folding or unrolling puts the pickers away: what they stood beside is moving.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the fold changing is the cue
  useEffect(() => setPicking(null), [folded])

  // The board's tools giving way to the writer's (or back) put their pickers away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mode changing is the cue
  useEffect(() => setPicking(null), [mode])

  // Search replaces a picker: ⌘K (or Search) puts it away, wherever the focus was.
  useEffect(() => onSearchOpen(() => setPicking(null)), [])

  // The tool keys: Y opens or puts away the colour picker, as Yarn does; another tool's key puts
  // it away.
  useEffect(
    () =>
      registerYarnPicker({
        toggle: () => setPicking((p) => (p === 'yarn' ? null : 'yarn')),
        close: () => pickYarn(false),
      }),
    [pickYarn],
  )

  useEffect(() => {
    const settle = () => {
      setFootAt(folded ? 'tile' : 'panel')
      // Faded out by now: a short panel scrolled down rolls up from its top.
      if (folded && sheet.current) sheet.current.scrollTop = 0
    }
    if (isReducedMotion(prefsStore.getState(), systemReducedMotion())) {
      settle()
      return
    }
    const t = setTimeout(settle, MOTION.fast)
    return () => clearTimeout(t)
  }, [folded])

  if (narrow) {
    return (
      <MiniBar
        newNote={
          <NewNoteButton onNewNote={onNewNote} open={picking === 'note'} onOpenChange={pickNote} />
        }
        yarn={<YarnButton open={picking === 'yarn'} onOpenChange={pickYarn} />}
        selection={selection}
        foot={foot}
        boardId={boardId}
        books={mode === 'book' ? 'book' : books}
        writing={mode === 'book' && Tools ? <Tools bar="minibar" /> : undefined}
      />
    )
  }
  return (
    <div
      className="sidebar"
      data-chrome="left"
      role="toolbar"
      aria-label="Tools"
      aria-orientation="vertical"
      data-folded={folded || undefined}
      data-foot={footAt}
    >
      <span className="sidebar-shade" aria-hidden="true" />
      <span className="sidebar-shade sidebar-shade--tile" aria-hidden="true" />
      <div className="sidebar-sheet" ref={sheet}>
        <button
          ref={mark}
          type="button"
          className="sidebar-mark"
          aria-label={folded ? 'Papertie — show tools' : 'Papertie — hide tools'}
          title={folded ? 'Show tools' : 'Hide tools'}
          aria-expanded={!folded}
          aria-controls={`${body} ${tail}`}
          onClick={() => prefsStore.setState({ sidebar: folded ? 'open' : 'folded' })}
        >
          <AppMark />
        </button>
        <div className="sidebar-body" id={body} inert={folded}>
          <div
            key={mode}
            className="sidebar-group"
            data-tools={mode}
            data-swap={swapped.current || undefined}
          >
            <span className="sidebar-rule" aria-hidden="true" />
            {mode === 'book' ? (
              Tools && <Tools bar="sidebar" />
            ) : (
              <>
                <NewNoteButton
                  onNewNote={onNewNote}
                  open={picking === 'note'}
                  onOpenChange={pickNote}
                />
                <span className="sidebar-rule" aria-hidden="true" />
                <ToolButton entry={SELECT} />
                <YarnButton
                  open={picking === 'yarn'}
                  onOpenChange={pickYarn}
                  mark={folded ? mark : undefined}
                />
                <PhotoButton />
              </>
            )}
            <SearchButton />
            {mode === 'board' && <SelectionActions host={selection} />}
          </div>
          <span className="sidebar-rule" aria-hidden="true" />
        </div>
        {/* The save dot stays out of what folds: folded, it shows on the tile while it has
            something to say (waiting for the store, failing, notices kept). */}
        {foot && <div className="sidebar-foot">{foot}</div>}
        <div className="sidebar-tail" id={tail} inert={folded}>
          <BooksButton boardId={boardId} />
          <SettingsButton />
        </div>
      </div>
    </div>
  )
}
