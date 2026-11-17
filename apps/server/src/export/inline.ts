/**
 * What Markdown and Word share of a book's export: which blocks are exported,
 * the footnotes and their numbers, and a block's text as runs of one style, with the footnote
 * references where their anchors end. Pure.
 */
import { type Block, footnoteOfMark, numberFootnotes, orphanFootnotes } from '@papertie/core'

/** Prompts are notes to the writer: never exported (and neither is what anchors in them). */
export const isExported = (b: Block): boolean => b.kind !== 'prompt'

/** Whether a block matters to the footnotes: a footnote, or a block with an anchor. O(marks). */
export function touchesFootnotes(b: Block): boolean {
  if (b.kind === 'footnote') return true
  for (const m of b.marks) if (footnoteOfMark(m.t) !== null) return true
  return false
}

export interface Footnotes {
  /** Each anchored footnote's number, 1-based (`numberFootnotes`): orphans are left out. */
  readonly numbers: ReadonlyMap<string, number>
  /** The anchored footnote blocks, in number order. */
  readonly blocks: readonly Block[]
}

/**
 * The footnotes of the exported blocks `blocks` (book order). Only the footnotes and the blocks
 * with anchors matter (`touchesFootnotes`), so a caller may pass just those. Orphans, and
 * footnotes anchored only in a prompt, are left out; `numberFootnotes` numbers orphans after
 * every anchored one, so the numbers left are 1 to n.
 */
export function exportFootnotes(blocks: readonly Block[]): Footnotes {
  const numbers = numberFootnotes(blocks)
  const orphans = orphanFootnotes(blocks)
  const byId = new Map<string, Block>()
  for (const b of blocks) if (b.kind === 'footnote' && !orphans.has(b.id)) byId.set(b.id, b)
  const kept = new Map<string, number>()
  const out: Block[] = []
  for (const [id, n] of numbers) {
    const b = byId.get(id)
    if (b === undefined) continue
    kept.set(id, n)
    out[n - 1] = b
  }
  return { numbers: kept, blocks: out }
}

/**
 * The reference numbers of a footnote's anchors as the export meets them: a footnote is
 * referenced at its first anchor only (a split paragraph can leave it two), as it is numbered.
 */
export class FootnoteRefs {
  private readonly seen = new Set<string>()
  constructor(readonly notes: Footnotes) {}

  /** The number to reference at an anchor of `id`, or null (an orphan's, or not its first). */
  at(id: string): number | null {
    const n = this.notes.numbers.get(id)
    if (n === undefined || this.seen.has(id)) return null
    this.seen.add(id)
    return n
  }
}

export type Run =
  | { readonly text: string; readonly b: boolean; readonly i: boolean; readonly link: number }
  | { readonly ref: number }

/**
 * `b`'s text as runs of one style (bold, italic; card marks are not exported), with a `ref` run
 * after each footnote anchor's end (in number order where several end together). `links` are
 * ranges the runs are cut at too, a run inside one carrying its index (else -1). O(text + marks).
 */
export function runsOf(
  b: Pick<Block, 'text' | 'marks'>,
  refs: FootnoteRefs | null,
  links: readonly { from: number; to: number }[] = [],
): Run[] {
  const text = b.text
  const len = text.length
  const cuts = new Set<number>([0, len])
  const ends = new Map<number, number[]>()
  for (const m of b.marks) {
    const from = Math.max(0, Math.min(len, m.from))
    const to = Math.max(from, Math.min(len, m.to))
    if (m.t === 'b' || m.t === 'i') {
      cuts.add(from)
      cuts.add(to)
      continue
    }
    const id = footnoteOfMark(m.t)
    if (id === null || refs === null) continue
    const n = refs.at(id)
    if (n === null) continue
    cuts.add(to)
    const at = ends.get(to)
    if (at) at.push(n)
    else ends.set(to, [n])
  }
  for (const l of links) {
    cuts.add(l.from)
    cuts.add(l.to)
  }
  const points = [...cuts].sort((x, y) => x - y)
  const covered = (t: 'b' | 'i', from: number, to: number) =>
    b.marks.some((m) => m.t === t && m.from <= from && m.to >= to)
  const out: Run[] = []
  for (let k = 0; k < points.length; k++) {
    const p = points[k] as number
    // An anchor's `to` is past its `from`, so never 0: its reference follows text.
    for (const n of (ends.get(p) ?? []).sort((x, y) => x - y)) out.push({ ref: n })
    const q = points[k + 1]
    if (q === undefined) continue
    const link = links.findIndex((l) => l.from <= p && l.to >= q)
    out.push({ text: text.slice(p, q), b: covered('b', p, q), i: covered('i', p, q), link })
  }
  return out
}

/** The http(s) addresses in `text`, trailing punctuation left out: a footnote's links. */
export function linksIn(text: string): { from: number; to: number; url: string }[] {
  const out: { from: number; to: number; url: string }[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const url = m[0].replace(/[.,;:!?)\]}'’”]+$/, '')
    if (url.length <= 'https://'.length) continue
    out.push({ from: m.index, to: m.index + url.length, url })
  }
  return out
}

/**
 * `s` without what XML 1.0 forbids (C0 controls but tab and newline, lone surrogates, U+FFFE/F),
 * `\r\n` and `\r` as `\n`. Applied to a run's text, after the marks have cut it.
 */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the characters XML 1.0 forbids
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  )
}
