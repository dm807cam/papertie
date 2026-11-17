import { type BoardState, bookBlocks } from '@papertie/core'
import { type JSX, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BoardSession } from '../../app/session'
import type { BlockEngine } from '../editor/blockEngine'
import type { Pos } from '../editor/model'
import { findInBook, type Match } from './find'

/** The field's rest before it searches again (ms). */
export const FIND_REST_MS = 120

/** Where a search starts: the first match at or after this place is the current one. */
interface Anchor {
  blockId: string
  /** The block's place in the book as it was (the block may be gone since). */
  pos: string
  from: number
}

/** Whether match `m` (of `state`) is at or after `a`, in book order. */
function atOrAfter(state: BoardState, m: Match, a: Anchor): boolean {
  const b = state.blocks.get(m.blockId)
  if (b === undefined) return false
  if (b.pos !== a.pos) return b.pos > a.pos
  if (b.id !== a.blockId) return b.id > a.blockId
  return m.from >= a.from
}

/**
 * `from` of `old` carried into `now`, one block's text rewritten: unchanged before the change,
 * shifted after it, at the change's start inside it.
 */
function carried(old: string, now: string, from: number): number {
  let p = 0
  const most = Math.min(old.length, now.length)
  while (p < most && old.charCodeAt(p) === now.charCodeAt(p)) p++
  if (from <= p) return from
  let q = 0
  while (q < most - p && old.charCodeAt(old.length - 1 - q) === now.charCodeAt(now.length - 1 - q))
    q++
  if (from >= old.length - q) return from + now.length - old.length
  return p
}

const ChevronUp = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
)
const ChevronDown = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
)
const Cross = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
)

/**
 * The find bar: a small paper bar at the pane's top, a field, "3 of 41",
 * previous and next, and Esc (or ×) to close it. It searches the whole book (`findInBook`, in
 * slices) after the field has rested 120 ms, the first match at or after the caret the current
 * one as it is found. Enter or ↓ goes to the next match, ⇧Enter or ↑ to the previous; the page
 * shows it (`reveal`) and draws the matches on it (`highlight`). A change to the book makes the
 * results stale: the next Enter searches again from the current match, carried through the
 * change, so the current match is kept wherever its text is. Closing selects the current match.
 */
export function FindBar(p: {
  session: Pick<BoardSession, 'store'>
  bookId: string
  engine: Pick<BlockEngine, 'reveal' | 'select' | 'highlight' | 'liveBlocks' | 'onLayout'> &
    Pick<BlockEngine, 'selection' | 'focusAt'>
  onClose(): void
}): JSX.Element {
  const { session, bookId, engine, onClose } = p
  const store = session.store
  const field = useRef<HTMLInputElement>(null)
  // The search's state, outside React (a long book's matches are many); `shown` re-renders.
  const s = useRef({
    matches: [] as Match[],
    byBlock: new Map<string, Match[]>(),
    cur: -1,
    done: false,
    stale: false,
    query: '',
    anchor: null as Anchor | null,
    run: null as AbortController | null,
    timer: null as ReturnType<typeof setTimeout> | null,
  })
  const [, setShown] = useState(0)
  const show = () => setShown((n) => n + 1)

  const anchorOf = (pos: Pos | null): Anchor | null => {
    const b = pos === null ? undefined : store.getState().blocks.get(pos.blockId)
    return pos === null || b === undefined ? null : { blockId: b.id, pos: b.pos, from: pos.offset }
  }
  // Where the first search starts: the caret as the bar opened.
  const caret = useRef<Anchor | null>(null)
  if (caret.current === null) caret.current = anchorOf(engine.selection())

  /** The matches of the blocks on the page, the current one apart. */
  const paint = () => {
    const st = s.current
    const current = st.cur >= 0 ? (st.matches[st.cur] ?? null) : null
    if (st.stale) {
      engine.highlight([], current)
      return
    }
    const live: Match[] = []
    for (const b of engine.liveBlocks()) {
      const ms = st.byBlock.get(b.id)
      if (ms !== undefined) live.push(...ms)
    }
    engine.highlight(live, current)
  }

  const go = (i: number) => {
    const st = s.current
    const m = st.matches[i]
    if (m === undefined) return
    st.cur = i
    st.anchor = null
    engine.reveal(m.blockId, m.from)
    paint()
    show()
  }

  const search = () => {
    const st = s.current
    st.run?.abort()
    if (st.timer !== null) clearTimeout(st.timer)
    st.timer = null
    const from =
      st.anchor ?? (st.cur >= 0 ? anchorOf(posOf(st.matches[st.cur])) : null) ?? caret.current
    st.matches = []
    st.byBlock = new Map()
    st.cur = -1
    st.done = false
    st.stale = false
    st.anchor = from
    const query = st.query
    if (query.trim() === '') {
      st.run = null
      st.done = true
      paint()
      show()
      return
    }
    const run = new AbortController()
    st.run = run
    const state = store.getState()
    findInBook(state, bookId, query, {
      signal: run.signal,
      onSome(found, done) {
        let pick = -1
        for (const m of found) {
          const i = st.matches.push(m) - 1
          const list = st.byBlock.get(m.blockId)
          if (list === undefined) st.byBlock.set(m.blockId, [m])
          else list.push(m)
          if (st.cur < 0 && pick < 0 && (from === null || atOrAfter(state, m, from))) pick = i
        }
        // None at or after the place: round to the book's first.
        if (done) st.done = true
        if (done && st.cur < 0 && pick < 0 && st.matches.length > 0) pick = 0
        if (pick >= 0) go(pick)
        else {
          paint()
          show()
        }
      },
    })
  }

  const step = (by: 1 | -1) => {
    const st = s.current
    if (st.stale || st.timer !== null) {
      search()
      return
    }
    const n = st.matches.length
    if (n === 0) return
    go(st.cur < 0 ? 0 : (st.cur + by + n) % n)
  }

  const close = () => {
    const st = s.current
    st.run?.abort()
    if (st.timer !== null) clearTimeout(st.timer)
    engine.highlight([])
    const m = st.cur >= 0 && !st.stale ? st.matches[st.cur] : undefined
    if (m !== undefined)
      engine.select({ blockId: m.blockId, offset: m.from }, { blockId: m.blockId, offset: m.to })
    else {
      const c = engine.selection()
      if (c !== null) engine.focusAt(c)
    }
    onClose()
  }

  useLayoutEffect(() => {
    field.current?.focus({ preventScroll: true })
  }, [])

  // The matches redrawn as the page lays out (the window moves, a block is drawn again).
  // biome-ignore lint/correctness/useExhaustiveDependencies: paint reads the refs
  useEffect(() => engine.onLayout(paint), [engine])

  // A change to the book: the results stale, the current match carried through it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: paint and anchorOf read the refs
  useEffect(
    () =>
      store.subscribe((now, prev) => {
        if (bookBlocks(now.blocks, bookId) === bookBlocks(prev.blocks, bookId)) return
        const st = s.current
        const m = st.cur >= 0 ? st.matches[st.cur] : undefined
        const at = st.anchor ?? (m === undefined ? null : anchorOf(posOf(m)))
        if (at !== null) {
          const was = prev.blocks.get(at.blockId)?.text
          const is = now.blocks.get(at.blockId)
          st.anchor = {
            ...at,
            pos: is?.pos ?? at.pos,
            from: was === undefined || is === undefined ? at.from : carried(was, is.text, at.from),
          }
        }
        if (st.matches.length > 0 || st.run !== null) {
          st.run?.abort()
          st.run = null
          st.stale = true
          paint()
        }
      }),
    [store, bookId],
  )

  // Gone: nothing left drawn, nothing left searching.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are this mount's
  useEffect(
    () => () => {
      s.current.run?.abort()
      if (s.current.timer !== null) clearTimeout(s.current.timer)
      engine.highlight([])
    },
    [],
  )

  const st = s.current
  const n = st.matches.length
  const count =
    st.query.trim() === '' || (n === 0 && !st.done)
      ? ''
      : n === 0
        ? 'No matches'
        : `${st.cur < 0 ? 0 : st.cur + 1} of ${n.toLocaleString('en')}`

  return (
    // biome-ignore lint/a11y/useSemanticElements: <search> has no role in every engine's tree yet
    <div className="find-bar sync-paper" role="search" aria-label="Find in the book">
      <input
        ref={field}
        type="search"
        className="find-field"
        aria-label="Find in the book"
        placeholder="Find in the book"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          st.query = e.currentTarget.value
          if (st.timer !== null) clearTimeout(st.timer)
          st.timer = setTimeout(search, FIND_REST_MS)
          show()
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          } else if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            step(e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1)
          }
        }}
      />
      <output className="find-count" aria-live="polite">
        {count}
      </output>
      <button
        type="button"
        className="find-button"
        aria-label="Previous match"
        aria-keyshortcuts="Shift+Enter"
        title="Previous match (⇧Enter)"
        onClick={() => step(-1)}
      >
        <ChevronUp />
      </button>
      <button
        type="button"
        className="find-button"
        aria-label="Next match"
        aria-keyshortcuts="Enter"
        title="Next match (Enter)"
        onClick={() => step(1)}
      >
        <ChevronDown />
      </button>
      <button
        type="button"
        className="find-button"
        aria-label="Close find"
        aria-keyshortcuts="Escape"
        title="Close (Esc)"
        onClick={close}
      >
        <Cross />
      </button>
    </div>
  )
}

const posOf = (m: Match | undefined): Pos | null =>
  m === undefined ? null : { blockId: m.blockId, offset: m.from }
