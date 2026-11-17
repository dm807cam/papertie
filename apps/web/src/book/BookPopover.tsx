import type { Book } from '@papertie/core'
import { type MouseEvent, useEffect, useId, useRef, useState } from 'react'
import { announce } from '../app/liveRegion'
import type { BoardSession } from '../app/session'
import { Choice, isComposing, PickerSheet, Row } from '../ui/PickerSheet'
import { openBook, redrawCover, setBookLang } from './shelfActions'

const LANGS: readonly { lang: Book['lang']; name: string }[] = [
  { lang: 'en', name: 'English' },
  { lang: 'de', name: 'German' },
]

/** A book's export as a file: the owner-only route, an attachment. */
const exportHref = (boardId: string, bookId: string, format: 'md' | 'docx') =>
  `/api/boards/${boardId}/books/${bookId}/export?format=${format}`

/** Said when the server does not give the file (a limit, a book gone meanwhile). */
export const EXPORT_FAILED = 'The export didn’t come through. Try again in a moment.'

/**
 * Until nothing is unsent: the session's batches flushed, then its feed's count
 * of what only this page holds at 0, so the store's book (which Markdown and Word are made
 * from) has every word the writer has. With the store out of reach, or sending stopped, it waits
 * no longer: the fetch says what it can.
 */
async function sent(session: BoardSession): Promise<void> {
  await session.sync?.flush()
  const { feed } = session
  const calm = () => {
    const s = feed.getState()
    return s.pending === 0 || s.status === 'offline' || s.status === 'error'
  }
  if (calm()) return
  await new Promise<void>((resolve) => {
    const off = feed.subscribe(() => {
      if (!calm()) return
      off()
      resolve()
    })
  })
}

/**
 * The export at `href` saved as the file the server names, only when it answers with one (an
 * error's body is never saved as a file).
 */
async function save(href: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(href, { credentials: 'same-origin' })
  } catch {
    announce(EXPORT_FAILED)
    return
  }
  if (!res.ok) {
    announce(EXPORT_FAILED)
    return
  }
  const blob = await res.blob()
  const named = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = named?.[1] ?? 'book'
  a.click()
  // Let go of the file once the browser has taken it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Markdown or Word: a link to the export route, followed once nothing is unsent and saved
 * only when it is a file; quietly pressed meanwhile, with no words. Before the board's id is
 * known, a choice that is not a link yet.
 */
function ExportLink({
  session,
  bookId,
  format,
  children,
}: {
  session: BoardSession
  bookId: string
  format: 'md' | 'docx'
  children: string
}) {
  const [pressed, setPressed] = useState(false)
  const { boardId } = session
  if (boardId === null) {
    return (
      <span className="book-popover-choice" aria-disabled="true">
        {children}
      </span>
    )
  }
  const href = exportHref(boardId, bookId, format)
  const follow = (e: MouseEvent) => {
    e.preventDefault()
    if (pressed) return
    setPressed(true)
    void sent(session)
      .then(() => save(href))
      .finally(() => setPressed(false))
  }
  return (
    <a
      className="book-popover-choice"
      href={href}
      download
      data-pressed={pressed ? '' : undefined}
      onClick={follow}
    >
      {children}
    </a>
  )
}

/**
 * A book's options, beside it in the panel's own material (`PickerSheet`): Rename (the writer's
 * title field, selected: the one place a title is edited), New cover (a fresh seed), the book's
 * language, Export (Markdown and Word as files), and Delete,
 * which asks first. Esc, a press outside and the focus leaving close it.
 */
export function BookPopover({
  session,
  book,
  anchor,
  onClose,
  onDelete,
}: {
  session: BoardSession
  book: Book
  anchor: HTMLElement
  onClose(refocus: boolean): void
  onDelete(): void
}) {
  const lang = useId()
  const [exporting, setExporting] = useState(false)
  return (
    <PickerSheet
      anchor={anchor}
      label={book.title.trim() || 'Untitled'}
      className="book-popover"
      // Enter on a row is a press of it (the sheet's own Enter is a picker's "choose").
      onEnter={() => (document.activeElement as HTMLElement | null)?.click()}
      onClose={onClose}
    >
      <div className="book-popover-menu">
        <button
          type="button"
          className="book-popover-row"
          onClick={() => {
            onClose(false)
            openBook(book.id, 'select')
          }}
        >
          Rename
        </button>
        <button
          type="button"
          className="book-popover-row"
          onClick={() => {
            redrawCover(session, book.id)
            onClose(true)
          }}
        >
          New cover
        </button>
        <Row title="Language" cols={2}>
          {LANGS.map((l) => (
            <Choice
              key={l.lang}
              className="book-popover-lang"
              name={lang}
              checked={book.lang === l.lang}
              onPick={() => setBookLang(session, book.id, l.lang)}
            >
              <span>{l.name}</span>
            </Choice>
          ))}
        </Row>
        <button
          type="button"
          className="book-popover-row"
          aria-expanded={exporting}
          onClick={() => setExporting((on) => !on)}
        >
          Export
        </button>
        {exporting && (
          // Downloads keep the sheet open: a link taken out under its click would not follow.
          <fieldset className="book-popover-export" aria-label="Export as">
            <ExportLink session={session} bookId={book.id} format="md">
              Markdown
            </ExportLink>
            <ExportLink session={session} bookId={book.id} format="docx">
              Word
            </ExportLink>
          </fieldset>
        )}
        <button
          type="button"
          className="book-popover-row"
          data-danger=""
          onClick={() => onDelete()}
        >
          Delete
        </button>
      </div>
    </PickerSheet>
  )
}

/**
 * Delete's question, over the shelf: the book's title, and that it can be put back for 30 days
 * (there is no word count: a book never opened has no paragraphs here). "Keep" has the focus;
 * Esc keeps it too. Where the focus goes after is the shelf's to say (the book's options).
 */
export function DeletePrompt({
  title,
  onDelete,
  onKeep,
}: {
  title: string
  onDelete(): void
  onKeep(): void
}) {
  const keep = useRef<HTMLButtonElement>(null)
  const kept = useRef(onKeep)
  kept.current = onKeep
  const text = useId()
  useEffect(() => {
    keep.current?.focus()
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isComposing(e)) return
      e.preventDefault()
      e.stopPropagation()
      kept.current()
    }
    document.addEventListener('keydown', esc, true)
    return () => document.removeEventListener('keydown', esc, true)
  }, [])
  return (
    <div className="shelf-ask-veil">
      <div className="shelf-ask" role="alertdialog" aria-modal="true" aria-labelledby={text}>
        <p className="shelf-ask-text" id={text}>
          Delete “{title}”? You can put it back for 30 days.
        </p>
        <div className="shelf-ask-actions">
          <button type="button" className="shelf-ask-button" ref={keep} onClick={onKeep}>
            Keep
          </button>
          <button
            type="button"
            className="shelf-ask-button shelf-ask-button--delete"
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
