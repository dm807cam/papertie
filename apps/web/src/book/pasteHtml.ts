import type { EditorKind, EditorMark } from './editor/BookEditor'
import type { Block, Piece } from './editor/model'

/**
 * Pasted HTML as the writer keeps it (nothing else is formatting): the five kinds, bold and
 * italic, and text. Headings below a section are sections, a table's cells and anything else
 * block-like are paragraphs; links, images, styles, scripts and the rest are dropped, keeping
 * their text where they have one. The markup is read in an inert document (`DOMParser`): nothing
 * of it runs, loads or is styled.
 */

const KIND: Record<string, EditorKind> = {
  H1: 'h1',
  H2: 'h2',
  H3: 'h2',
  H4: 'h2',
  H5: 'h2',
  H6: 'h2',
  BLOCKQUOTE: 'quote',
  LI: 'li',
}
const BLOCK = new Set([
  'P',
  'DIV',
  'PRE',
  'TD',
  'TH',
  'DT',
  'DD',
  'FIGCAPTION',
  'ARTICLE',
  'SECTION',
  'HEADER',
  'FOOTER',
  'ADDRESS',
  ...Object.keys(KIND),
])
const SKIP = new Set([
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'NOSCRIPT',
  'HEAD',
  'TITLE',
  'META',
  'IFRAME',
  'OBJECT',
  'SVG',
  'MATH',
])

/**
 * Whether `e` sets bold (or italic) on, off, or leaves it as it was (null). An explicit weight
 * under 600 (`normal`, 400) turns bold off, as a style does in a browser: Google Docs wraps the
 * whole clipboard in `<b style="font-weight:normal">`. Likewise `font-style: normal` for italic.
 */
const bolds = (e: HTMLElement): boolean | null =>
  e.hasAttribute('data-paste-nb')
    ? false
    : e.tagName === 'B' || e.tagName === 'STRONG' || e.hasAttribute('data-paste-b')
      ? true
      : null
const slants = (e: HTMLElement): boolean | null =>
  e.hasAttribute('data-paste-ni')
    ? false
    : e.tagName === 'I' || e.tagName === 'EM' || e.hasAttribute('data-paste-i')
      ? true
      : null

/**
 * The markup with nothing in it a parser would hold up to the page's CSP (an inert document's
 * parse is checked against it too): scripts and style sheets taken out whole, event handler
 * attributes dropped, `style` attributes read for what the writer keeps (a weight of 600 or
 * more, italic) and dropped.
 */
function unstyled(html: string): string {
  const attrs = (tag: string) =>
    tag
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (_, v: string) => {
        const css = v.replace(/^["']|["']$/g, '').toLowerCase()
        const weight = /font-weight\s*:\s*([a-z0-9]+)/.exec(css)?.[1]
        const style = /font-style\s*:\s*([a-z]+)/.exec(css)?.[1]
        const w =
          weight === undefined
            ? ''
            : weight === 'bold' || weight === 'bolder' || Number(weight) >= 600
              ? ' data-paste-b'
              : ' data-paste-nb'
        const i =
          style === 'italic' || style === 'oblique'
            ? ' data-paste-i'
            : style === 'normal'
              ? ' data-paste-ni'
              : ''
        return `${w}${i}`
      })
  return (
    html
      .replace(/<(script|style|template|noscript|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, '')
      // A start tag, its quoted values taken whole (a `>` in one does not end the tag).
      .replace(/<[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi, attrs)
  )
}

/** The pieces of pasted `html`; none when it holds no text. */
export function piecesFromHtml(html: string): Piece[] {
  const doc = new DOMParser().parseFromString(unstyled(html), 'text/html')
  const out: Piece[] = []
  let cur: { kind: EditorKind | null; text: string; marks: EditorMark[] } | null = null
  const end = () => {
    if (cur !== null) {
      const text = cur.text.replace(/\s+/g, ' ')
      const lead = text.length - text.trimStart().length
      const trimmed = text.trim()
      if (trimmed !== '') {
        const marks = cur.marks
          .map((m) => ({
            t: m.t,
            from: Math.max(0, m.from - lead),
            to: Math.min(trimmed.length, m.to - lead),
          }))
          .filter((m) => m.to > m.from)
        out.push({ kind: cur.kind, text: trimmed, marks })
      }
    }
    cur = null
  }
  // Collapsing white space after the fact would move the marks: it is collapsed as it is read.
  const add = (s: string, b: boolean, i: boolean) => {
    cur ??= { kind: null, text: '', marks: [] }
    let t = s.replace(/\s+/g, ' ')
    if (t.startsWith(' ') && (cur.text === '' || cur.text.endsWith(' '))) t = t.slice(1)
    if (t === '') return
    const from = cur.text.length
    cur.text += t
    if (b) cur.marks.push({ t: 'b', from, to: from + t.length })
    if (i) cur.marks.push({ t: 'i', from, to: from + t.length })
  }
  const walk = (node: Node, kind: EditorKind | null, b: boolean, i: boolean) => {
    for (let c = node.firstChild; c !== null; c = c.nextSibling) {
      if (c.nodeType === Node.TEXT_NODE) {
        add((c as Text).data, b, i)
        continue
      }
      if (c.nodeType !== Node.ELEMENT_NODE) continue
      const e = c as HTMLElement
      const tag = e.tagName.toUpperCase()
      if (SKIP.has(tag)) continue
      if (tag === 'BR') {
        const k = cur?.kind ?? kind
        end()
        cur = { kind: k, text: '', marks: [] }
        continue
      }
      if (BLOCK.has(tag)) {
        // The outermost kind holds (a paragraph in a quote is the quote's).
        const k = kind ?? KIND[tag] ?? null
        end()
        cur = { kind: k, text: '', marks: [] }
        walk(e, k, bolds(e) ?? b, slants(e) ?? i)
        end()
        continue
      }
      walk(e, kind, bolds(e) ?? b, slants(e) ?? i)
    }
  }
  walk(doc.body, null, false, false)
  end()
  return out.map((p) => ({ ...p, kind: p.kind ?? 'p' }))
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const TAG: Record<EditorKind, string> = {
  p: 'p',
  h1: 'h1',
  h2: 'h2',
  quote: 'blockquote',
  li: 'li',
  // A prompt and a caption copy as plain paragraphs: a paste never makes a prompt, a
  // figure or a card mark (the five kinds, bold and italic only), here or in another app.
  prompt: 'p',
  figure: 'p',
  // A footnote copies as a plain paragraph too.
  footnote: 'p',
}

/** `blocks` as HTML (the five kinds, bold and italic), for a copy: other apps and the writer read it. */
export function htmlOf(blocks: readonly Block[]): string {
  const parts: string[] = []
  let list = false
  for (const b of blocks) {
    const cuts = new Set([0, b.text.length])
    for (const m of b.marks) cuts.add(m.from).add(m.to)
    const pts = [...cuts].sort((x, y) => x - y)
    let inner = ''
    for (let k = 0; k + 1 < pts.length; k++) {
      const s = pts[k] as number
      const e = pts[k + 1] as number
      const on = (t: 'b' | 'i') => b.marks.some((m) => m.t === t && m.from <= s && m.to >= e)
      let t = esc(b.text.slice(s, e))
      if (on('i')) t = `<em>${t}</em>`
      if (on('b')) t = `<strong>${t}</strong>`
      inner += t
    }
    if (b.kind === 'li' && !list) parts.push('<ul>')
    if (b.kind !== 'li' && list) parts.push('</ul>')
    list = b.kind === 'li'
    const tag = TAG[b.kind]
    parts.push(`<${tag}>${inner}</${tag}>`)
  }
  if (list) parts.push('</ul>')
  return parts.join('')
}
