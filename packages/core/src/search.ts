import type { Note } from './schema/records'
import type { BoardState } from './state'

/** Max UTF-16 code units of note text in a snippet. The `…` cut markers come on top of this. */
const SNIPPET_TEXT_MAX = 80
const ELLIPSIS = '…'

/**
 * The canonical search form: NFKC, then lowercase. Compatibility forms collapse
 * (`ⒶⒷⒸ` -> `abc`, `ﬁ` -> `fi`), so users do not have to care which they typed.
 */
export function normalizeForSearch(s: string): string {
  return s.normalize('NFKC').toLowerCase()
}

/**
 * Fold used for matching: `normalizeForSearch`, with final sigma `ς` unified to `σ`. Lowercasing `Σ`
 * depends on context (word end -> `ς`), which would make "ΟΔΟΣ" fail to match a typed "οδοσ" and make
 * results depend on how the text is segmented. Unifying makes matching context-free. A query's
 * needle is `foldForSearch(query).trim()`; a note matches when its folded text contains it.
 */
export const foldForSearch = (s: string): string => normalizeForSearch(s).replaceAll('ς', 'σ')
const foldUnit = foldForSearch

/**
 * Cheap whole-string fold per note, cached per immutable note object (so computed once per note
 * version, not once per keystroke). Used to find hits and rank them; no offsets are kept.
 */
const foldedCache = new WeakMap<object, string>()
function foldedText(note: Searchable): string {
  let f = foldedCache.get(note)
  if (f === undefined) {
    f = foldUnit(searchText(note))
    foldedCache.set(note, f)
  }
  return f
}

/** What search reads of a note: its text and its reference. */
export interface Searchable {
  readonly text: string
  readonly ref?: string
}

/** The text search reads of a note: its own text, then its `ref` on a line of its own. */
export function searchText(note: Searchable): string {
  const r = note.ref
  if (r === undefined) return note.text
  return note.text === '' ? r : `${note.text}\n${r}`
}

export interface SearchHit {
  readonly id: string
  /** Up to 80 chars of the note's ORIGINAL text around the first match, `…` at each cut edge. */
  readonly snippet: string
}

// Grapheme clusters keep NFKC-composing sequences together (a letter and its combining accent are one cluster).
// Locale-independent for graphemes. Standard ES2022 (Intl.Segmenter); no I/O, browser- and Node-safe.
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/**
 * A normalized text plus, for every UTF-16 unit of it, the span of ORIGINAL text it came from.
 *
 * NFKC and lowercasing change string length (e + U+0301 2 units -> é 1; `İ` 1 unit -> `i̇` 2), so offsets found
 * in the normalized text do not index the original. We therefore normalize one grapheme cluster at a
 * time and record, for each output unit, where its cluster starts and ends in the original text.
 * A match [p, p + q) in `text` then maps to the original span [starts[p], ends[p + q - 1]).
 * Because every cut is on a cluster boundary, mapped offsets never split a surrogate pair.
 *
 * This is the expensive path (Intl.Segmenter plus two arrays per unit), so it runs ONLY for the
 * final top-`limit` hits, to build snippets. Hit detection and ranking use the cheap cached
 * `foldedText`. Both use `foldUnit`, so they agree except in exotic cross-cluster compositions; if
 * the match is not found here the snippet falls back to the start of the text.
 */
interface Folded {
  readonly text: string
  readonly starts: readonly number[]
  readonly ends: readonly number[]
}

function fold(s: string): Folded {
  let text = ''
  const starts: number[] = []
  const ends: number[] = []
  for (const { segment, index } of segmenter.segment(s)) {
    const folded = foldUnit(segment)
    const end = index + segment.length
    for (let i = 0; i < folded.length; i++) {
      starts.push(index)
      ends.push(end)
    }
    text += folded
  }
  return { text, starts, ends }
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

/**
 * Up to SNIPPET_TEXT_MAX units of `text` around the original span [start, end), centred on the match,
 * with `…` where text was cut. Total length is therefore at most SNIPPET_TEXT_MAX + 2.
 * A match longer than the window is shown from its start (the window cannot contain all of it).
 * Window edges never fall inside a surrogate pair.
 */
function makeSnippet(text: string, start: number, end: number): string {
  if (text.length <= SNIPPET_TEXT_MAX) return text
  const matchLen = end - start
  const before = Math.max(0, Math.floor((SNIPPET_TEXT_MAX - matchLen) / 2))
  let from = Math.max(0, start - before)
  let to = Math.min(text.length, from + SNIPPET_TEXT_MAX)
  from = Math.max(0, to - SNIPPET_TEXT_MAX) // slide back when clamped at the end
  // `start` is a cluster boundary so a low surrogate at `from` always lies before it: move forward.
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from++
  // A high surrogate as the last kept unit would be orphaned: drop it.
  if (to < text.length && isHighSurrogate(text.charCodeAt(to - 1))) to--
  return (from > 0 ? ELLIPSIS : '') + text.slice(from, to) + (to < text.length ? ELLIPSIS : '')
}

/**
 * Substring search over note text (its reference too: {@link searchText}), insensitive to width
 * (NFKC) and case.
 *
 * Ranking: match at the start of the text first, then earlier match position (the start is position
 * 0, so one numeric order covers both), then newer `updatedAt` (ISO-8601 Z strings sort
 * lexicographically), then note id ascending so results are deterministic.
 * An empty or whitespace-only query returns `[]`. `limit <= 0` returns `[]`.
 */
export function searchNotes(state: BoardState, query: string, limit = 20): SearchHit[] {
  const needle = foldUnit(query).trim()
  if (needle === '' || !(limit > 0)) return []

  // Fast path: cached whole-string fold + indexOf. No segmentation, no offset maps, no snippets.
  const found: Array<{ note: Note; pos: number }> = []
  for (const note of state.notes.values()) {
    const pos = foldedText(note).indexOf(needle)
    if (pos >= 0) found.push({ note, pos })
  }

  found.sort(
    (a, b) =>
      a.pos - b.pos ||
      (a.note.updatedAt < b.note.updatedAt ? 1 : a.note.updatedAt > b.note.updatedAt ? -1 : 0) ||
      (a.note.id < b.note.id ? -1 : a.note.id > b.note.id ? 1 : 0),
  )

  // Slow path, top hits only: map the match back onto the original text for the snippet.
  return found
    .slice(0, Math.floor(limit))
    .map(({ note }) => ({ id: note.id, snippet: searchSnippet(searchText(note), needle) }))
}

/**
 * The snippet `searchNotes` shows for `text` matched by `needle` (a query already folded and
 * trimmed): up to 80 chars of the original text around the first match. Shared with the search
 * index's worker, so both answer the same hits. Run it on the hits shown, never on the board.
 */
export function searchSnippet(text: string, needle: string): string {
  const hay = fold(text)
  const pos = hay.text.indexOf(needle)
  if (pos < 0) return makeSnippet(text, 0, 0)
  const start = hay.starts[pos] ?? 0
  const end = hay.ends[pos + needle.length - 1] ?? start
  return makeSnippet(text, start, end)
}
