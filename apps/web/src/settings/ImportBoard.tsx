import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { cancelImport, commitImport, type ImportPreview, previewImport } from '../api/boards'
import { failureText } from '../api/failure'
import { ApiError } from '../api/http'
import { takeOfferedFiles } from '../app/openedFile'
import { RouteLink } from '../app/RouteLink'
import type { BoardSession } from '../app/session'
import { Button, Message } from './controls'
import { IMPORTED } from './format'
import { rememberOwnRecovery } from './ownRecovery'

const MIB = 1_048_576

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The question asked before a file replaces the board. */
export const importTitle = (name: string) => `Replace your board with “${name}”?`
/** The question's line: the books too, when the file has any (they come with the board). */
export const importBody = (notes: number, threads: number, books = 0) =>
  books > 0
    ? `It has ${count(notes, 'note', 'notes')}, ${count(threads, 'thread', 'threads')} and ${count(books, 'book', 'books')}. Your current board is saved to History first.`
    : `It has ${count(notes, 'note', 'notes')} and ${count(threads, 'thread', 'threads')}. Your current board is saved to History first.`

export const NOT_A_BOARD = 'This file isn’t a Papertie board.'
export const damagedLine = (line: number) =>
  `This board file is damaged (line ${line}). Nothing was changed.`
export const quotaLine = (mb: number, free: number) =>
  `This board needs ${mb} MB and you have ${free} MB left.`
export const TOO_MANY_NOTES = 'This board has more than 100,000 notes. Nothing was changed.'
export const TOO_MANY_THREADS =
  'This board has more threads than Papertie holds. Nothing was changed.'
export const TOO_MANY_PHOTOS = 'This board has more photo records than notes. Nothing was changed.'
export const OTHER_VERSION =
  'This board was made by a different version of Papertie. Nothing was changed.'
export const PHOTO_TOO_LARGE = 'A photo in this file is larger than 25 MB. Nothing was changed.'
export const TOO_MANY_BOOKS = 'This board has more than 500 books. Nothing was changed.'
export const TOO_MANY_BLOCKS =
  'A book in this file has more than 60,000 paragraphs. Nothing was changed.'
export const BOOK_TOO_LONG =
  'A book in this file is longer than Papertie holds. Nothing was changed.'
export const MISSING_BOOK =
  'A paragraph in this file belongs to a book that isn’t in it. Nothing was changed.'

/** The refusals that are not about a damaged or foreign file, by the server's reason. */
const BY_REASON: Record<string, string> = {
  'too-many-notes': TOO_MANY_NOTES,
  'too-many-threads': TOO_MANY_THREADS,
  'too-many-assets': TOO_MANY_PHOTOS,
  'unsupported-version': OTHER_VERSION,
  'asset-too-large': PHOTO_TOO_LARGE,
  'too-many-books': TOO_MANY_BOOKS,
  'too-many-blocks': TOO_MANY_BLOCKS,
  'missing-book': MISSING_BOOK,
  'book-too-long': BOOK_TOO_LONG,
}

const numberIn = (body: unknown, key: string): number | null => {
  const v = (body as Record<string, unknown> | null)?.[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** What a failed preview says: an import line, or the common one. */
function previewFailure(e: unknown, file: File): string {
  if (!(e instanceof ApiError)) return failureText(e)
  if (e.status === 422 && e.code === 'import-invalid') {
    const reason = (e.body as { reason?: unknown } | null)?.reason
    const said = typeof reason === 'string' ? BY_REASON[reason] : undefined
    if (said) return said
    const line = numberIn(e.body, 'line')
    return line !== null && line > 0 ? damagedLine(line) : NOT_A_BOARD
  }
  if (e.status === 507 && e.code === 'quota') {
    return quotaLine(numberIn(e.body, 'needMb') ?? 0, numberIn(e.body, 'freeMb') ?? 0)
  }
  // Larger than what is left of the quota and the board text's allowance together: the file
  // itself is the least it needs. A 413 that does not say what is free is not the server's.
  const free = numberIn(e.body, 'freeMb')
  if (e.status === 413 && free !== null) return quotaLine(Math.ceil(file.size / MIB), free)
  return failureText(e)
}

/** Tell the server to drop a staged file. Nothing waits on it: one never told expires anyway. */
const discardStaged = (boardId: string, importId: string) => {
  void Promise.resolve()
    .then(() => cancelImport(boardId, importId))
    .catch(() => {})
}

type Step =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'asking'; preview: ImportPreview; importId: string; replacing: boolean }

/**
 * Bring a board in from a `.papertie` (or plain `.jsonl`) file. The file is sent to the server,
 * which reads it whole and stages it without touching the board; then the question is asked, on
 * the paper, with the counts the server found. `Keep current` (or Esc) discards the staged file;
 * `Replace board` sends the page's unsent edits first, then swaps the board. The page
 * then reads the board again by itself (the store tells it to `reset`), and the line that follows points to
 * History, where the board as it was is kept.
 */
export function ImportBoard({ session }: { session: BoardSession }) {
  const { boardId, sync } = session
  const input = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [note, setNote] = useState<{ tone: 'error' | 'notice'; text: ReactNode } | null>(null)
  const live = useRef(true)
  /** The staged import the question is about, if one is being asked: left, it is discarded. */
  const staged = useRef<string | null>(null)
  useEffect(() => {
    // Mounted again (StrictMode) or on another board: answers are wanted again.
    live.current = true
    return () => {
      live.current = false
      const importId = staged.current
      staged.current = null
      if (boardId !== null && importId !== null) discardStaged(boardId, importId)
    }
  }, [boardId])
  // A file the desktop app opened (`app/openedFile.ts`) is read as a chosen one is, and asked
  // about the same way; one opened while another is asked about waits for the answer.
  // `busy` is checked as a file arrives, not when React has drawn: two files opened back to back
  // (or one landing before the effect below unsubscribes) must not both start a preview.
  const readOffered = useRef<(file: File) => boolean>(() => false)
  const busy = useRef(false)
  useLayoutEffect(() => {
    busy.current = step.kind !== 'idle'
  })
  const free = boardId !== null && step.kind === 'idle'
  useEffect(
    () => (free ? takeOfferedFiles((file) => readOffered.current(file)) : undefined),
    [free],
  )

  if (boardId === null) return null

  const focusOpener = () => opener.current?.querySelector<HTMLButtonElement>('button')?.focus()

  const read = async (file: File) => {
    setNote(null)
    setStep({ kind: 'reading' })
    try {
      const { preview, importId } = await previewImport(boardId, file)
      if (!live.current) {
        discardStaged(boardId, importId)
        return
      }
      staged.current = importId
      setStep({ kind: 'asking', preview, importId, replacing: false })
    } catch (e) {
      if (!live.current) return
      setStep({ kind: 'idle' })
      setNote({ tone: 'error', text: previewFailure(e, file) })
    }
  }
  readOffered.current = (file) => {
    if (busy.current) return false
    busy.current = true
    void read(file)
    return true
  }

  const keep = (importId: string) => {
    staged.current = null
    setStep({ kind: 'idle' })
    // Nothing waits on it: a staged file the server never hears about expires by itself.
    discardStaged(boardId, importId)
    queueMicrotask(focusOpener)
  }

  const replace = async (preview: ImportPreview, importId: string) => {
    // Committing now: leaving Settings meanwhile must not cancel it.
    staged.current = null
    setStep({ kind: 'asking', preview, importId, replacing: true })
    try {
      // The page's unsent edits belong in the board the safety backup keeps.
      await sync?.flush().catch(() => {})
      // Said here, in the sheet: the reset the server sends for it brings no slip of its own.
      const own = session.feed.ownReset()
      let done: { revision: number; safetyBackup: string }
      try {
        done = await commitImport(boardId, importId)
      } catch (e) {
        own.failed()
        throw e
      }
      own.done(done.revision)
      // Asked for here: its recovery notice is not shown again.
      rememberOwnRecovery(boardId, done.safetyBackup)
      if (!live.current) {
        // Settings closed meanwhile: the board says it, quietly, on a slip.
        session.feed.notice({ kind: 'reset', count: 0, message: IMPORTED })
        return
      }
      setNote({
        tone: 'notice',
        text: (
          <>
            Board replaced. You can undo this from{' '}
            <RouteLink to={{ name: 'settings', section: 'history' }}>History</RouteLink>.
          </>
        ),
      })
    } catch (e) {
      if (!live.current) return
      setNote({ tone: 'error', text: failureText(e) })
    }
    setStep({ kind: 'idle' })
    queueMicrotask(focusOpener)
  }

  return (
    <div className="settings-group">
      <p className="settings-lead">
        Bring in a .papertie or JSONL file. It takes your board’s place; the board as it is now is
        kept in History.
      </p>
      <input
        ref={input}
        type="file"
        accept=".papertie,.jsonl,application/zip,application/x-ndjson"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          // The same file chosen again is a change too.
          e.currentTarget.value = ''
          if (file) void read(file)
        }}
      />
      <div className="settings-actions" ref={opener}>
        <Button
          tone="quiet"
          disabled={step.kind !== 'idle'}
          onClick={() => {
            setNote(null)
            input.current?.click()
          }}
        >
          Import…
        </Button>
      </div>
      {step.kind === 'reading' && (
        <p className="settings-lead" role="status">
          Reading the file…
        </p>
      )}
      {step.kind === 'asking' && (
        <ReplaceQuestion
          preview={step.preview}
          busy={step.replacing}
          onKeep={() => keep(step.importId)}
          onReplace={() => replace(step.preview, step.importId)}
        />
      )}
      <Message tone={note?.tone}>{note?.text}</Message>
    </div>
  )
}

/** The buttons a Tab can reach in `root`, in order. */
const buttonsIn = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
]

/**
 * The question, on the paper it came from, as an alert (not a modal: the rest of Settings stays
 * usable, and leaving it discards the staged file): focus starts on `Keep current` (the
 * safe answer, first) and Tab stays between the two answers; Esc is `Keep current`, answered
 * before the settings sheet hears it.
 */
function ReplaceQuestion({
  preview,
  busy,
  onKeep,
  onReplace,
}: {
  preview: ImportPreview
  busy: boolean
  onKeep(): void
  onReplace(): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])
  // While the board is being replaced both answers are off: focus waits on the question itself.
  useEffect(() => {
    if (busy) box.current?.focus()
  }, [busy])
  return (
    <div
      ref={box}
      className="settings-ask settings-import"
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      aria-busy={busy || undefined}
      tabIndex={-1}
      data-tone="danger"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          if (!busy) onKeep()
          return
        }
        if (e.key !== 'Tab' || !box.current) return
        const els = buttonsIn(box.current)
        const first = els[0]
        const last = els.at(-1)
        if (!first || !last) {
          e.preventDefault()
          return
        }
        const at = document.activeElement
        if (e.shiftKey && (at === first || !box.current.contains(at))) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (at === last || !box.current.contains(at))) {
          e.preventDefault()
          first.focus()
        }
      }}
    >
      <p className="settings-ask-title" id={`${id}-title`}>
        {importTitle(preview.name)}
      </p>
      <p className="settings-ask-text" id={`${id}-body`}>
        {importBody(preview.notes, preview.yarns, preview.books)}
      </p>
      <div className="settings-actions">
        <Button tone="quiet" disabled={busy} onClick={onKeep}>
          Keep current
        </Button>
        <Button tone="danger" disabled={busy} onClick={onReplace}>
          Replace board
        </Button>
      </div>
    </div>
  )
}
