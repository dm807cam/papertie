import type { Note, PaletteToken } from '@papertie/core'
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { BoardStore } from '../store/boardStore'
import '../sync/sync.css'
import { matchRange } from './highlight'
import './picker.css'
import { type SearchIndex, searchIndexFor } from './searchIndex'

/** Hits shown at once. */
export const PICKER_RESULTS = 8
/**
 * How long a new sheet waits, unseen, for its first answer: a sheet that shows empty and then
 * grows would jump. The field has the keyboard all the while.
 */
export const PICKER_HOLD_MS = 50
/** Where a recent note's text is cut. */
const LEAD_MAX = 80
const NONE: ReadonlySet<string> = new Set()

interface Row {
  id: string
  paper: PaletteToken
  /** The text to show (whitespace collapsed); '' for a note with none. */
  text: string
  /** The span of `text` to emphasise. */
  mark: [number, number] | null
  /** What to say for a note with no text. */
  blank: 'Empty note' | 'Picture' | null
}

/** One question to the index: what was typed (trimmed to '' when blank) and its rows. */
interface Ask {
  q: string
  rows: Promise<Row[]>
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The start of a note's text, cut on a whole character. */
function lead(text: string): string {
  const t = collapse(text)
  if (t.length <= LEAD_MAX) return t
  let end = LEAD_MAX
  const c = t.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return `${t.slice(0, end)}…`
}

function blankOf(n: Note): Row['blank'] {
  return n.image !== null ? 'Picture' : 'Empty note'
}

/**
 * The rows for `query` ('' lists the notes edited last), from the index, on the board as it is
 * when the answer comes: a note removed meanwhile is left out, never shown.
 */
async function rowsFor(
  index: SearchIndex,
  store: BoardStore,
  query: string,
  exclude: ReadonlySet<string>,
  only?: ReadonlySet<string>,
): Promise<Row[]> {
  // The index leaves `exclude` out itself, and keeps to `only` itself (ranking those alone), so
  // the list fills however many are excluded, or however many others match.
  const rows: Row[] = []
  if (query === '') {
    const ids = await index.recent(PICKER_RESULTS, exclude, only)
    const notes = store.getState().notes
    for (const id of ids) {
      const n = notes.get(id)
      if (n === undefined || exclude.has(id)) continue
      const text = lead(n.text)
      rows.push({ id, paper: n.paper, text, mark: null, blank: text === '' ? blankOf(n) : null })
      if (rows.length === PICKER_RESULTS) break
    }
    return rows
  }
  const hits = await index.query(query, PICKER_RESULTS, exclude, only)
  const notes = store.getState().notes
  for (const h of hits) {
    const n = notes.get(h.id)
    if (n === undefined || exclude.has(h.id)) continue
    const text = collapse(h.snippet)
    rows.push({ id: h.id, paper: n.paper, text, mark: matchRange(text, query), blank: null })
    if (rows.length === PICKER_RESULTS) break
  }
  return rows
}

function Snippet({ row }: { row: Row }) {
  if (row.blank !== null) return row.blank
  if (row.mark === null) return row.text
  const [a, b] = row.mark
  return (
    <>
      {row.text.slice(0, a)}
      <mark className="picker-mark">{row.text.slice(a, b)}</mark>
      {row.text.slice(b)}
    </>
  )
}

/**
 * Finds a note on the board: a paper popover with a field and the notes that match, each a
 * snippet (the match inked in) beside a swatch of its paper. Up and Down move (and wrap), Enter
 * picks, Esc or a press outside closes. With no query it lists the notes edited last. `multi`
 * keeps it open after a pick so several can be added; the caller grows `exclude`.
 *
 * Every keystroke asks the board's search index (`searchIndexFor`), which answers from its
 * worker in a few milliseconds whatever the board's size, so typing never waits on the board.
 * The list changes only when an answer to what was typed comes, never with a remote change, so
 * nothing moves under the eye; until then it shows the last answer. A new sheet is held unseen
 * until its first answer (at most `PICKER_HOLD_MS`), so it never shows empty and then grows.
 * `search` stands in for the board's index in tests.
 */
export function Picker({
  store,
  search: given,
  title,
  placeholder,
  exclude,
  onPick,
  onClose,
  multi = false,
  how,
  only,
}: {
  store: BoardStore
  search?: SearchIndex
  title: string
  placeholder: string
  exclude?: ReadonlySet<string>
  /** `how.alt`: picked with Alt (Alt+Enter, Alt+click): Insert card moves the card. */
  onPick(noteId: string, how: { alt: boolean }): void
  onClose(): void
  multi?: boolean
  /**
   * The two ways a pick can go, as visible controls under the list (Insert card's copy and move:
   * Enter is the first's accelerator, Alt+Enter the second's). Absent: none.
   */
  how?: { copy: string; move: string }
  /**
   * Only these notes, read as each question is asked (the cards with a ref: a kept set);
   * absent: every note.
   */
  only?: () => ReadonlySet<string>
}) {
  const search = useMemo(() => given ?? searchIndexFor(store), [given, store])
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState<{ ask: Ask; rows: Row[] } | null>(null)
  const [held, setHeld] = useState(true)
  const [active, setActive] = useState(0)
  /** The latest question, answered or not. */
  const asked = useRef<Ask | null>(null)
  /** The question an Enter waits on, so a second Enter does not pick twice. */
  const waitingPick = useRef<Ask | null>(null)
  const typed = useRef('')
  const live = useRef(false)
  const box = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const ids = useId()
  const titleId = `${ids}-title`
  const listId = `${ids}-list`

  const ask = useCallback(
    (text: string) => {
      const q = text.trim() === '' ? '' : text
      const a: Ask = { q, rows: rowsFor(search, store, q, exclude ?? NONE, only?.()) }
      asked.current = a
      void a.rows.then((rows) => {
        if (live.current && asked.current === a) setShown({ ask: a, rows })
      })
    },
    [search, store, exclude, only],
  )

  // On opening, and again when `exclude` grows (a note brought in).
  useEffect(() => ask(typed.current), [ask])
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const rows = shown?.rows ?? []
  const index = Math.min(active, rows.length - 1)
  const activeRow = rows[index]
  const optionId = (id: string) => `${listId}-${id}`

  useEffect(() => {
    field.current?.focus({ preventScroll: true })
  }, [])

  // Shown with its first answer, or after a short wait whatever happens to it.
  useEffect(() => {
    if (!held) return
    if (shown !== null) {
      setHeld(false)
      return
    }
    const t = setTimeout(() => setHeld(false), PICKER_HOLD_MS)
    return () => clearTimeout(t)
  }, [held, shown])

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && !box.current?.contains(t)) onClose()
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [onClose])

  // Keep the active row in view as the arrows move it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` is what moved
  useEffect(() => {
    const el = box.current?.querySelector('[aria-selected="true"]')
    if (el instanceof HTMLElement && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [index])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter and Esc belong to a composition while it runs.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((index + step + rows.length) % rows.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const a = asked.current
      if (a === null) return
      const how = { alt: e.altKey }
      if (shown?.ask === a) {
        if (activeRow !== undefined) onPick(activeRow.id, how)
        return
      }
      // The list still shows an earlier answer: Enter picks from what is typed now, once its
      // answer comes (a few milliseconds).
      if (waitingPick.current === a) return
      waitingPick.current = a
      const at = active
      void a.rows.then((fresh) => {
        const row = fresh[Math.min(at, fresh.length - 1)]
        if (live.current && asked.current === a && row !== undefined) onPick(row.id, how)
      })
    }
  }

  const count = rows.length
  const q = shown?.ask.q ?? ''
  // Nothing is said before the first answer (a moment): never a wrong "Nothing pinned yet".
  const status =
    shown === null
      ? ''
      : count === 0
        ? q === ''
          ? 'Nothing pinned yet'
          : 'No matching notes'
        : q === ''
          ? ''
          : `${count} ${count === 1 ? 'note' : 'notes'}`

  return (
    <div
      ref={box}
      className="picker sync-paper"
      data-waiting={held || undefined}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        // The field is the only stop: Tab would leave the palette for the board behind its veil,
        // where Esc no longer reaches it. (A composing IME uses Tab for its candidates.)
        if (e.key === 'Tab' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault()
          field.current?.focus({ preventScroll: true })
          return
        }
        if (e.key !== 'Escape' || e.nativeEvent.isComposing || e.keyCode === 229) return
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      <p className="picker-title" id={titleId}>
        {title}
      </p>
      <input
        ref={field}
        className="picker-input"
        type="text"
        role="combobox"
        aria-labelledby={titleId}
        aria-autocomplete="list"
        aria-expanded={count > 0}
        aria-controls={listId}
        aria-activedescendant={activeRow ? optionId(activeRow.id) : undefined}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          typed.current = e.target.value
          setQuery(e.target.value)
          setActive(0)
          ask(e.target.value)
        }}
        onKeyDown={onKeyDown}
      />
      <div className="picker-list" id={listId} role="listbox" aria-label={title}>
        {rows.map((row, i) => (
          // The field keeps the keyboard; the list is driven through aria-activedescendant.
          // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the combobox
          <div
            key={row.id}
            id={optionId(row.id)}
            className="picker-row"
            role="option"
            tabIndex={-1}
            aria-selected={i === index}
            data-blank={row.blank !== null || undefined}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => i !== index && setActive(i)}
            onClick={(e) => onPick(row.id, { alt: e.altKey })}
          >
            <span
              className="picker-swatch"
              aria-hidden="true"
              style={{ background: `var(--paper-${row.paper})` }}
            />
            <span className="picker-text">
              <Snippet row={row} />
            </span>
          </div>
        ))}
      </div>
      <p
        className="picker-status"
        role="status"
        data-empty={(shown !== null && count === 0) || undefined}
      >
        {status}
      </p>
      {how && (
        <div className="picker-how">
          {[false, true].map((alt) => (
            <button
              key={alt ? 'move' : 'copy'}
              type="button"
              className="picker-how-button"
              aria-keyshortcuts={alt ? 'Alt+Enter' : 'Enter'}
              disabled={activeRow === undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => activeRow !== undefined && onPick(activeRow.id, { alt })}
            >
              {alt ? how.move : how.copy}
            </button>
          ))}
        </div>
      )}
      <p className="picker-keys" aria-hidden="true">
        {multi
          ? '↑ ↓ to move   ↵ to add   Esc to finish'
          : how
            ? '↑ ↓ to move   ↵ to copy   ⌥ ↵ to move in   Esc to close'
            : '↑ ↓ to move   ↵ to choose   Esc to close'}
      </p>
    </div>
  )
}
