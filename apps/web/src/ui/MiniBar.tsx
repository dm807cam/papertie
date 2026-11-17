import { type ReactNode, useLayoutEffect, useRef } from 'react'
import {
  BooksButton,
  PhotoButton,
  SELECT,
  SearchButton,
  SettingsButton,
  ToolButton,
} from './buttons'
import { SelectionActions, type SelectionHost } from './SelectionActions'
import './sidebar.css'

/**
 * The sidebar under 768 px: a floating pill at the bottom left with "+" (`newNote`), Select,
 * Yarn (`yarn`), Photo, Search, Books and Settings, the same set as the panel. Every target is at
 * least 44 px. While notes are selected their section (Duplicate, Focus, Delete) unfolds as a row
 * above the tools, which stay where they are. Under a book sheet (`books`: the shelf, a book) it
 * holds Books (pressed), Search and Settings only; under a book (`book`) it says so (`data-sheet`),
 * so the writer can step it out of the text while you write (`writer.css`). The save dot (`foot`)
 * has its own 44 px slot at the pill's end, after Settings, kept whether it shows or not (as the
 * panel keeps its room), so it is never out on the board and at rest reads as the pill's end;
 * under a book (or beside it, while the user works in it) the writer's tools (`writing`) are a row
 * above Books, Search and Settings, as the selection's is above the board's tools;
 * below 400 px it marks Settings' corner instead, a mark that takes no press. Below 360 px Photo
 * moves to the "+" picker's end.
 */
export function MiniBar({
  newNote,
  yarn,
  selection,
  foot,
  boardId = null,
  books = false,
  writing,
}: {
  newNote: ReactNode
  yarn: ReactNode
  selection: SelectionHost | null
  foot?: ReactNode
  boardId?: string | null
  books?: boolean | 'book'
  /** The writer's tools, under a book. */
  writing?: ReactNode
}) {
  const sheet = books !== false
  const bar = useRef<HTMLDivElement>(null)
  const writes = writing !== undefined
  // The writing row is out: said on the page's root (`data-writing-row`), so the "Papertie was
  // updated" slip, outside the UI layer, rises above it as above the selection's row.
  useLayoutEffect(() => {
    const root = bar.current?.ownerDocument.documentElement
    if (!writes || !root) return
    root.dataset.writingRow = ''
    return () => {
      delete root.dataset.writingRow
    }
  }, [writes])
  return (
    <div
      ref={bar}
      className="minibar"
      data-chrome="bottom"
      role="toolbar"
      aria-label="Tools"
      aria-orientation="horizontal"
      data-sheet={books === 'book' ? 'book' : undefined}
    >
      {!sheet && <SelectionActions host={selection} className="minibar-selection" says />}
      {writing !== undefined && (
        <div className="minibar-writing">
          {writing}
          <span className="sidebar-rule" aria-hidden="true" />
        </div>
      )}
      <div className="minibar-tools">
        {!sheet && (
          <>
            {newNote}
            <ToolButton entry={SELECT} />
            {yarn}
            <PhotoButton className="sidebar-btn minibar-photo" />
          </>
        )}
        {sheet && <BooksButton boardId={boardId} />}
        <SearchButton />
        {!sheet && <BooksButton boardId={boardId} />}
        <SettingsButton />
        {foot && <div className="minibar-foot">{foot}</div>}
      </div>
    </div>
  )
}
