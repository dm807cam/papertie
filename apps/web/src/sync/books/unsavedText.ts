/**
 * The book text in the unsaved-changes download: beside the ops' JSONL, a plain `.md`
 * of each paragraph the unsaved batches touch, under its book's title, so words a conflict could
 * not place are a file anyone can open. No zip, no dependency. A prompt is a `Prompt: …` line
 * and a figure its `Figure: <caption>`, so nothing written there is lost either. A
 * footnote is a `[^n]: …` line after its paragraph, whose anchor is a `[^n]` in it,
 * numbered through its book as the writer numbers it (core's `numberFootnotes`' rule: once a download, for
 * the books it names footnotes of).
 */
import { type Block, type BoardState, bookBlocks, type ClientOp } from '@papertie/core'
import { footnoteOf as footnoteOfMark, numberAll } from '../../book/footnotes/marks'

/** A paragraph a batch names, and what it typed into it (`ins`), in order; its kind if made. */
type Touched = { bookId: string; typed: string[]; kind?: string }

/** A block's text as the `.md` has it: a prompt and a figure's caption say what they are. */
const line = (kind: string | undefined, text: string) =>
  kind === 'prompt' ? `Prompt: ${text}` : kind === 'figure' ? `Figure: ${text}` : text

/**
 * The text of every paragraph the batches touch, under its book's title, books and paragraphs in
 * the order first touched: as `state` (the view) has it; then, for the `dropped` batches (those
 * rejected or let go, which the view does not show), every fragment they typed into it. Empty
 * when no batch touches a book.
 */
export function unsavedMarkdown(
  state: BoardState,
  pending: readonly ClientOp[][],
  dropped: readonly ClientOp[][] = [],
): string {
  const blocks = new Map<string, Touched>()
  const touch = (bookId: string, id: string, typed?: string) => {
    const t = blocks.get(id) ?? { bookId, typed: [] }
    blocks.set(id, t)
    if (typed) t.typed.push(typed)
  }
  const lists: Array<[readonly ClientOp[][], boolean]> = [
    [pending, false],
    [dropped, true],
  ]
  for (const [batches, kept] of lists) {
    for (const op of batches.flat()) {
      const typed = (s: string) => (kept ? s : undefined)
      if (op.op === 'block.edit') for (const s of op.splices) touch(op.bookId, op.id, typed(s.ins))
      else if (op.op === 'block.create') {
        touch(op.block.bookId, op.block.id, typed(op.block.text))
        const t = blocks.get(op.block.id)
        if (t !== undefined) t.kind ??= op.block.kind
      } else if (op.op === 'block.split') {
        touch(op.bookId, op.id)
        touch(op.bookId, op.newId)
      } else if (op.op === 'block.merge') touch(op.bookId, op.into)
    }
  }
  // The footnotes' numbers of a book, read once, and only for a book with footnotes in play.
  const numbered = new Map<string, Map<string, number>>()
  const numberOf = (bookId: string, id: string): number | undefined => {
    let m = numbered.get(bookId)
    if (m === undefined) {
      m = numberAll(bookBlocks(state.blocks, bookId).chunks.flat())
      numbered.set(bookId, m)
    }
    return m.get(id)
  }
  const note = (bookId: string, id: string, text: string) =>
    `[^${numberOf(bookId, id) ?? '?'}]: ${text}`
  /** A paragraph's text with its anchors' `[^n]` at their ends; its footnotes, in reference order. */
  const anchored = (b: Block): { text: string; notes: string[] } => {
    const ends: Array<{ from: number; at: number; id: string }> = []
    if (b.kind !== 'footnote')
      for (const m of b.marks) {
        const id = footnoteOfMark(m.t)
        if (id !== null && !ends.some((e) => e.id === id)) ends.push({ from: m.from, at: m.to, id })
      }
    if (ends.length === 0) return { text: b.text, notes: [] }
    let text = b.text
    for (const e of [...ends].sort((x, y) => y.at - x.at))
      text = `${text.slice(0, e.at)}[^${numberOf(b.bookId, e.id) ?? '?'}]${text.slice(e.at)}`
    // In the order of their references (where each anchor ends: core's numbering).
    return { text, notes: ends.sort((x, y) => x.at - y.at || x.from - y.from).map((e) => e.id) }
  }
  const books = new Map<string, string[]>()
  const done = new Set<string>()
  for (const [id, t] of blocks) {
    if (done.has(id)) continue
    done.add(id)
    const b = state.blocks.get(id)
    const kind = b?.kind ?? t.kind
    const typed = t.typed.join('')
    const lineOf = (x: string) => (kind === 'footnote' ? note(t.bookId, id, x) : line(kind, x))
    let shown = b?.text ?? ''
    const after: string[] = []
    if (b !== undefined && kind !== 'footnote') {
      // Its footnotes follow it, whether the batches touched them or not.
      const a = anchored(b)
      shown = a.text
      for (const n of a.notes) {
        const f = state.blocks.get(n)
        if (f === undefined || f.kind !== 'footnote' || done.has(n)) continue
        done.add(n)
        after.push(note(t.bookId, n, f.text))
        const more = blocks.get(n)?.typed.join('') ?? ''
        if (more.trim() !== '') after.push(note(t.bookId, n, more))
      }
    }
    const parts = [shown, typed].filter((x) => x.trim() !== '').map(lineOf)
    if (after.length > 0) parts.push(after.join('\n'))
    if (parts.length === 0) continue
    const text = parts.join('\n\n')
    const list = books.get(t.bookId) ?? []
    books.set(t.bookId, [...list, text])
  }
  const out: string[] = []
  for (const [bookId, paras] of books) {
    const title = state.books.get(bookId)?.title.trim() || 'Untitled book'
    out.push(`# ${title}\n\n${paras.join('\n\n')}\n`)
  }
  return out.join('\n')
}
