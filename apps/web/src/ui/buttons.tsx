import type { ComponentPropsWithRef, ComponentType } from 'react'
import { prefsStore, type Tool, usePrefs } from '../app/prefs'
import { FIRST_SECTION, navigate, useRoute } from '../app/router'
import { recallScreen } from '../app/screenMemory'
import { openSearch } from '../search/searchStore'
import { onShelf } from '../sync/books/bookStore'
import { openPhotoPicker } from './photoPicker'
import {
  BooksIcon,
  ImageIcon,
  SearchIcon,
  SelectIcon,
  SettingsIcon,
  YarnIcon,
} from './sidebarIcons'

/** A tool: the `prefs.tool` it sets, its button's name and icon, and its key. */
export interface ToolEntry {
  tool: Tool
  label: string
  Icon: ComponentType
  key: string
}

export const SELECT: ToolEntry = { tool: 'select', label: 'Select', Icon: SelectIcon, key: 'V' }
export const YARN: ToolEntry = { tool: 'yarn', label: 'Yarn', Icon: YarnIcon, key: 'Y' }

const apple = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** ⌘K on a Mac, Ctrl+K elsewhere. */
export function searchShortcut(): string {
  return apple() ? '⌘K' : 'Ctrl+K'
}

/** ⌘D on a Mac, Ctrl+D elsewhere. */
export function duplicateShortcut(): string {
  return apple() ? '⌘D' : 'Ctrl+D'
}

/**
 * A tool's button. A press takes the tool up, unless `onClick` says otherwise (Yarn opens its
 * colour picker first).
 */
export function ToolButton({
  entry,
  onClick,
  ...rest
}: { entry: ToolEntry } & Omit<
  ComponentPropsWithRef<'button'>,
  'aria-label' | 'aria-pressed' | 'title' | 'type'
>) {
  const { tool, label, Icon, key } = entry
  const active = usePrefs((p) => p.tool === tool)
  return (
    <button
      type="button"
      className="sidebar-btn"
      data-tool={tool}
      aria-label={label}
      aria-pressed={active}
      aria-keyshortcuts={key}
      title={`${label} (${key})`}
      onClick={onClick ?? (() => prefsStore.setState({ tool }))}
      {...rest}
    >
      <Icon />
    </button>
  )
}

/** A button that runs a command: `shortcut` shows in the tooltip, `keys` is for assistive tech. */
export function ActionButton({
  label,
  Icon,
  shortcut,
  keys,
  className = 'sidebar-btn',
  ...rest
}: {
  label: string
  Icon: ComponentType
  shortcut?: string
  keys?: string
} & Omit<ComponentPropsWithRef<'button'>, 'aria-label' | 'title' | 'type'>) {
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      aria-keyshortcuts={keys}
      title={shortcut === undefined ? label : `${label} (${shortcut})`}
      {...rest}
    >
      <Icon />
    </button>
  )
}

/** Photo: the file picker (P). */
export function PhotoButton({ className }: { className?: string }) {
  return (
    <ActionButton
      className={className}
      label="Photo"
      Icon={ImageIcon}
      shortcut="P"
      keys="P"
      onClick={() => openPhotoPicker()}
    />
  )
}

/** Search: the ⌘K palette. */
export function SearchButton() {
  return (
    <ActionButton
      label="Search"
      Icon={SearchIcon}
      shortcut={searchShortcut()}
      keys="Meta+K Control+K"
      onClick={() => openSearch()}
    />
  )
}

/** Settings: opens the settings sheet; pressed while it is open, and then it closes it. */
export function SettingsButton() {
  const open = useRoute().name === 'settings'
  return (
    <ActionButton
      label="Settings"
      Icon={SettingsIcon}
      aria-pressed={open}
      data-settings=""
      onClick={() =>
        navigate(open ? { name: 'board' } : { name: 'settings', section: FIRST_SECTION })
      }
    />
  )
}

/**
 * Books: from the board, the book screen last shown on this board (the shelf when none, or when
 * that book has been deleted since); pressed
 * (on the shelf or in a book), back to the board.
 */
export function BooksButton({ boardId }: { boardId?: string | null }) {
  const name = useRoute().name
  const open = name === 'shelf' || name === 'book'
  return (
    <ActionButton
      label="Books"
      Icon={BooksIcon}
      shortcut={apple() ? '⌘\\' : 'Ctrl+\\'}
      keys={SIDE_KEYS}
      aria-pressed={open}
      data-books=""
      onClick={() => pressBooks(boardId ?? null, open)}
    />
  )
}

/** ⌘\ for assistive tech: Books' and the writer's Board. */
export const SIDE_KEYS = 'Meta+\\ Control+\\'

/** ⌘\ (Ctrl+\ elsewhere): Books' accelerator on the board side, the writer's "Board" in it. */
export const isSideKey = (e: KeyboardEvent): boolean =>
  e.metaKey !== e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === '\\' || e.code === 'Backslash')

/** What Books does: back to the board when a book screen is open, else the last one shown. */
export function pressBooks(boardId: string | null, open: boolean): void {
  if (open) {
    navigate({ name: 'board' })
    return
  }
  const last = boardId ? recallScreen(boardId).lastBook : null
  // A book since deleted (or gone) is not opened: the shelf is.
  navigate(
    last?.screen === 'book' && onShelf(last.bookId)
      ? { name: 'book', id: last.bookId }
      : { name: 'shelf' },
  )
}
