import type { Splice } from '@papertie/core'
import type { EditorKind, EditorMark } from './editor/BookEditor'

/**
 * The writer's typing rules, as pure functions of a block's text: typography corrected as
 * you type, the Markdown-style accelerators of the selection popover's controls, and words
 * counted. The engine applies them to a keystroke typed outside a composition only, as part of
 * that keystroke's own change (`blockEngine.ts`).
 */

export type BookLang = 'de' | 'en'

const QUOTES: Record<BookLang, { open2: string; close2: string; open1: string; close1: string }> = {
  en: { open2: '“', close2: '”', open1: '‘', close1: '’' },
  de: { open2: '„', close2: '“', open1: '‚', close1: '‘' },
}

/** Where a quote opens: at the start, after a space or an opening bracket or dash. */
const opensAfter = (c: string | undefined) => c === undefined || /[\s([{–—/]/.test(c)

/**
 * The splices (against `text`, the block's text with the key just typed ending at `at`) that
 * correct that keystroke: `--` → `–` (and `–-` → `—`), `...` → `…`, and a straight quote → the
 * book's: „…“ and ‚…‘ in German, “…” and ‘…’ in English, an apostrophe always ’. Nothing else in
 * the text is looked at again. Never called during a composition.
 */
export function smartTypography(text: string, at: number, lang: BookLang): Splice[] {
  const ch = text[at - 1]
  const prev = text[at - 2]
  const q = QUOTES[lang]
  switch (ch) {
    case '-':
      if (prev === '-') return [{ at: at - 2, del: 2, ins: '–' }]
      if (prev === '–') return [{ at: at - 2, del: 2, ins: '—' }]
      return []
    case '.':
      return prev === '.' && text[at - 3] === '.' ? [{ at: at - 3, del: 3, ins: '…' }] : []
    case '"':
      return [{ at: at - 1, del: 1, ins: opensAfter(prev) ? q.open2 : q.close2 }]
    case "'": {
      if (opensAfter(prev)) return [{ at: at - 1, del: 1, ins: q.open1 }]
      // A German single quote left open earlier in the block closes here (‘); else it is an
      // apostrophe, which is also English's closing single quote (’).
      const before = text.slice(0, at - 1)
      const pending = lang === 'de' && before.lastIndexOf(q.open1) > before.lastIndexOf(q.close1)
      return [{ at: at - 1, del: 1, ins: pending ? q.close1 : '’' }]
    }
    default:
      return []
  }
}

/** What an accelerator does: the syntax deleted (`splices`, in order), and a kind or a mark. */
export interface Accelerated {
  splices: Splice[]
  kind?: EditorKind
  addMarks?: EditorMark[]
}

const LINE: ReadonlyArray<readonly [string, EditorKind]> = [
  ['## ', 'h2'],
  ['# ', 'h1'],
  ['> ', 'quote'],
  ['- ', 'li'],
]

/**
 * The accelerator the keystroke ending at `at` completes in a block of `kind` with `text`: `# `,
 * `## `, `> `, `- ` at the block's start (its kind: chapter, section, quote, list); the closing
 * star of `*…*` (italic) or `**…**` (bold), whose stars go and whose text takes the mark. Null
 * when it completes none. Emphasis needs text right inside its stars, as Markdown's does.
 */
export function accelerate(text: string, at: number, kind: EditorKind): Accelerated | null {
  for (const [prefix, k] of LINE) {
    if (at === prefix.length && text.startsWith(prefix)) {
      return kind === k ? null : { splices: [{ at: 0, del: prefix.length, ins: '' }], kind: k }
    }
  }
  if (text[at - 1] !== '*') return null
  const bold = text[at - 2] === '*'
  const n = bold ? 2 : 1
  const close = at - n
  const inner = text[close - 1]
  if (inner === undefined || inner === '*' || /\s/.test(inner)) return null
  // The opening stars: the nearest before, alone (not part of a longer run), text right after.
  const stars = bold ? '**' : '*'
  for (let open = text.lastIndexOf(stars, close - n - 1); open >= 0; ) {
    const after = text[open + n]
    const before = text[open - 1]
    const run = before === '*' || (!bold && after === '*')
    if (!run && after !== undefined && !/\s/.test(after) && open + n < close) {
      const t = bold ? 'b' : 'i'
      return {
        splices: [
          { at: close, del: n, ins: '' },
          { at: open, del: n, ins: '' },
        ],
        addMarks: [{ t, from: open, to: close - n }],
      }
    }
    if (run || open === 0) return null
    open = text.lastIndexOf(stars, open - 1)
  }
  return null
}

const LETTER = /[\p{L}\p{N}]/u
const INSIDE = /[\p{L}\p{N}\p{M}]/u

/** Whether code unit `c` (at `i` of `text`) is a letter or digit: ASCII at once, else Unicode's. */
function wordChar(text: string, i: number, re: RegExp): boolean {
  const c = text.charCodeAt(i)
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
  return re.test(text[i] as string)
}

/**
 * The words of `text`: runs starting with a letter or digit (punctuation alone is none), going
 * on through letters, digits, marks and the joiners of a word (' ’ - .). A scan, no match objects:
 * counting a book's words makes no garbage to collect.
 */
export function countWords(text: string): number {
  let n = 0
  let inWord = false
  for (let i = 0; i < text.length; i++) {
    if (inWord) {
      if (wordChar(text, i, INSIDE)) continue
      const c = text[i]
      if (c === "'" || c === '’' || c === '-' || c === '.') continue
      inWord = false
    } else if (wordChar(text, i, LETTER)) {
      inWord = true
      n++
    }
  }
  return n
}
