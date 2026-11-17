/**
 * A book as Markdown. Pure: the export route feeds it the blocks a slice at a
 * time (`bookExport.ts`); `bookMarkdown` is the whole book at once.
 *
 * - `# Title`, then `##` for a chapter (h1) and `###` for a section (h2).
 * - `**bold**` and `*italic*`; the text escaped (`escapeMarkdown`) and nothing at a line's start
 *   read as a list, a heading or a code block.
 * - `> ` for a quote and `- ` for a list item (consecutive items as one list).
 * - A figure as `![caption](images/<assetId>.webp)` and its caption as a line under it.
 * - A footnote as `[^n]` after its anchor's end, numbered by `numberFootnotes`, and `[^n]: text`
 *   at the end of the file. Orphans are left out.
 * - Never: prompts, card marks (and so pins).
 */
import type { Block, BlockKind } from '@papertie/core'
import {
  cleanText,
  exportFootnotes,
  FootnoteRefs,
  type Footnotes,
  isExported,
  type Run,
  runsOf,
  touchesFootnotes,
} from './inline'

const SPECIAL = /[\\`*_[\]#<>|~&]/g

/** Every character Markdown could read as syntax inside a line, backslash-escaped. */
export const escapeMarkdown = (s: string): string => cleanText(s).replace(SPECIAL, '\\$&')

/**
 * Each line of `s` with nothing at its start read as a block: leading blanks dropped (four make
 * code), and a leading `-`, `+` or `=` (a list item, a setext underline) or `1.` / `1)` (an
 * ordered item) escaped. `#` and `>` are escaped everywhere already.
 */
function lineStarts(s: string): string {
  return s
    .split('\n')
    .map((line) =>
      line
        .replace(/^[ \t]+/, '')
        .replace(/^([-+=])/, '\\$1')
        .replace(/^(\d+)([.)])/, '$1\\$2'),
    )
    .join('\n')
}

const DELIM = { b: '**', i: '*' } as const
type Style = { b: boolean; i: boolean }
const PLAIN: Style = { b: false, i: false }

/**
 * Runs as inline Markdown. Emphasis opens and closes as a stack (bold outside italic when both
 * open together), whitespace is kept outside the delimiters (`** a**` is no emphasis), and a
 * footnote's reference goes after the emphasis that ends where its anchor does.
 */
function inline(runs: readonly Run[]): string {
  let out = ''
  let pending = ''
  const stack: Array<'b' | 'i'> = []
  const closeTo = (s: Style) => {
    const k = stack.findIndex((t) => !s[t])
    if (k >= 0) while (stack.length > k) out += DELIM[stack.pop() as 'b' | 'i']
    out += pending
    pending = ''
  }
  for (let k = 0; k < runs.length; k++) {
    const run = runs[k] as Run
    if ('ref' in run) {
      let next: Style = PLAIN
      for (let j = k + 1; j < runs.length; j++) {
        const r = runs[j] as Run
        if ('text' in r) {
          next = r
          break
        }
      }
      closeTo(next)
      out += `[^${run.ref}]`
      continue
    }
    closeTo(run)
    let text = escapeMarkdown(run.text)
    const open = (['b', 'i'] as const).filter((t) => run[t] && !stack.includes(t))
    if (open.length > 0) {
      const lead = /^\s*/.exec(text)?.[0] ?? ''
      out += lead
      text = text.slice(lead.length)
      // All blank: opened by the next run that has text, if any.
      if (text === '') continue
      for (const t of open) {
        stack.push(t)
        out += DELIM[t]
      }
    }
    if (stack.length > 0) {
      const trail = /\s*$/.exec(text)?.[0] ?? ''
      out += text.slice(0, text.length - trail.length)
      pending = trail
    } else out += text
  }
  closeTo(PLAIN)
  return out
}

/** The Markdown of a book, a block at a time: `head`, `block` for each, `note` for each footnote, `end`. */
export class MarkdownWriter {
  /** The figures' assets, each once, in book order: the zip's `images/<id>.webp`. */
  readonly images: string[] = []
  private readonly seen = new Set<string>()
  private readonly refs: FootnoteRefs
  private prev: BlockKind | 'title' = 'title'
  private notes = 0

  constructor(readonly footnotes: Footnotes) {
    this.refs = new FootnoteRefs(footnotes)
  }

  head(title: string): string {
    return `# ${escapeMarkdown(title.trim() === '' ? 'Untitled' : title).replace(/\n/g, ' ')}`
  }

  /** The block as Markdown, with the blank line (or, between list items, the newline) before it; '' for none. */
  block(b: Block): string {
    const text = this.render(b)
    if (text === '') return ''
    const sep = this.prev === 'li' && b.kind === 'li' ? '\n' : '\n\n'
    this.prev = b.kind
    return sep + text
  }

  /** An anchored footnote's definition (`Footnotes.blocks`, in order). */
  note(b: Block): string {
    const n = this.footnotes.numbers.get(b.id)
    if (n === undefined) return ''
    const body = lineStarts(inline(runsOf(b, null))).replace(/\n/g, '\\\n    ')
    return `${this.notes++ === 0 ? '\n\n' : '\n'}[^${n}]: ${body}`
  }

  end(): string {
    return '\n'
  }

  private render(b: Block): string {
    switch (b.kind) {
      case 'prompt':
      case 'footnote':
        return ''
      case 'h1':
      case 'h2': {
        const text = inline(runsOf(b, this.refs)).replace(/\n/g, ' ').trim()
        return text === '' ? '' : `${b.kind === 'h1' ? '##' : '###'} ${text}`
      }
      case 'figure': {
        const caption = lineStarts(inline(runsOf(b, this.refs))).trim()
        const asset = b.image?.assetId
        if (asset === undefined) return caption
        if (!this.seen.has(asset)) {
          this.seen.add(asset)
          this.images.push(asset)
        }
        const alt = escapeMarkdown(b.text.replace(/\s+/g, ' ').trim())
        const image = `![${alt}](images/${asset}.webp)`
        return caption === '' ? image : `${image}\n${caption.replace(/\n/g, '\\\n')}`
      }
      case 'quote':
      case 'li': {
        const text = lineStarts(inline(runsOf(b, this.refs))).trim()
        if (text === '') return ''
        return b.kind === 'quote'
          ? `> ${text.replace(/\n/g, '\\\n> ')}`
          : `- ${text.replace(/\n/g, '\\\n  ')}`
      }
      default: {
        const text = lineStarts(inline(runsOf(b, this.refs))).trim()
        return text.replace(/\n/g, '\\\n')
      }
    }
  }
}

/** The whole book at once (the blocks in book order): its Markdown and the figures' assets. */
export function bookMarkdown(
  title: string,
  blocks: readonly Block[],
): { text: string; images: string[] } {
  const kept = blocks.filter(isExported)
  const w = new MarkdownWriter(exportFootnotes(kept.filter(touchesFootnotes)))
  let text = w.head(title)
  for (const b of kept) text += w.block(b)
  for (const b of w.footnotes.blocks) text += w.note(b)
  return { text: text + w.end(), images: w.images }
}
