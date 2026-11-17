/**
 * Footnotes in the writer, pure: a footnote is a block of kind `footnote`
 * after the paragraph it belongs to, anchored by a mark `n:` + its id over the text it annotates.
 * These are the commands that make one (after its paragraph's other footnotes, in anchor order),
 * remove one with its anchor, and fill one, stated as editor changes against the book's blocks in
 * order (the engine's model, or the board's book: `BlockSeq`). Each reads its paragraph and the
 * blocks beside it, never the book.
 */
import type { EditorBlock, EditorChange, EditorMark } from '../editor/BookEditor'
import { noteMark as noteMarkT } from './marks'

/** The undo labels of the footnote commands. */
export const FOOTNOTE_LABELS = {
  add: 'add a footnote',
  remove: 'remove a footnote',
  fill: 'fill a footnote',
} as const

/** The book's blocks in order, as a command reads them: by index, and an id's index (-1: none). */
export interface BlockSeq {
  at(i: number): EditorBlock | undefined
  indexOf(id: string): number
}

/** How far back from a footnote its anchor is looked for (its paragraph split since, say). */
const LOOK_BACK = 64

/** Whether block `b` can carry a footnote's anchor: text of the book (no prompt, caption or footnote). */
export const anchorable = (b: EditorBlock | undefined): boolean =>
  b !== undefined && b.kind !== 'footnote' && b.kind !== 'prompt' && b.kind !== 'figure'

/** Footnote `id`'s anchor in block `b`: its first run there, or undefined. */
export const anchorIn = (b: EditorBlock, id: string): EditorMark | undefined => {
  const t = noteMarkT(id)
  let first: EditorMark | undefined
  for (const m of b.marks) if (m.t === t && (first === undefined || m.from < first.from)) first = m
  return first
}

/**
 * The block a new footnote anchored at `from` of block `blockId` goes after: the block itself,
 * or the last of the prompts and footnotes after it whose anchor there begins at or before
 * `from` (the footnotes stay in anchor order; one anchored elsewhere stays before).
 */
export function footnotePlace(seq: BlockSeq, blockId: string, from: number): string {
  const i = seq.indexOf(blockId)
  const b = seq.at(i)
  let after = blockId
  if (b === undefined) return after
  for (let j = i + 1; ; j++) {
    const n = seq.at(j)
    if (n === undefined || (n.kind !== 'prompt' && n.kind !== 'footnote')) break
    if (n.kind === 'footnote') {
      const m = anchorIn(b, n.id)
      if (m !== undefined && m.from > from) break
    }
    after = n.id
  }
  return after
}

/**
 * A footnote `id` with `text` anchored over `[from, to)` of block `blockId`: its block after the
 * paragraph's footnotes before it, and the anchor's mark. Empty when the block takes none.
 */
export function addFootnote(
  seq: BlockSeq,
  blockId: string,
  from: number,
  to: number,
  id: string,
  text = '',
): EditorChange[] {
  const b = seq.at(seq.indexOf(blockId))
  if (!anchorable(b) || from >= to) return []
  return [
    { t: 'create', id, after: footnotePlace(seq, blockId, from), kind: 'footnote', text },
    { t: 'edit', id: blockId, splices: [], addMarks: [{ t: noteMarkT(id), from, to }] },
  ]
}

/**
 * Where footnote `id`'s anchor is: the nearest block before it that anchors it (past its
 * paragraph's other footnotes and prompts, a bounded look back), with its first run there.
 */
export function anchorOf(
  seq: BlockSeq,
  id: string,
): { block: EditorBlock; mark: EditorMark } | null {
  const i = seq.indexOf(id)
  for (let j = i - 1; j >= 0 && j >= i - LOOK_BACK; j--) {
    const b = seq.at(j)
    if (b === undefined) break
    const mark = b.kind === 'footnote' ? undefined : anchorIn(b, id)
    if (mark !== undefined) return { block: b, mark }
  }
  return null
}

/** The paragraph footnote `id` hangs from: the first block before it that is not beside the text. */
export function paragraphOf(seq: BlockSeq, id: string): EditorBlock | undefined {
  for (let j = seq.indexOf(id) - 1; j >= 0; j--) {
    const b = seq.at(j)
    if (b === undefined || (b.kind !== 'footnote' && b.kind !== 'prompt')) return b
  }
  return undefined
}

/** Footnote `id` removed, and its anchor with it (every run of it in the block that anchors it). */
export function removeFootnote(seq: BlockSeq, id: string): EditorChange[] {
  const b = seq.at(seq.indexOf(id))
  if (b?.kind !== 'footnote') return []
  const out: EditorChange[] = [{ t: 'delete', id }]
  const at = anchorOf(seq, id)
  if (at !== null) {
    const t = noteMarkT(id)
    out.push({
      t: 'edit',
      id: at.block.id,
      splices: [],
      removeMarks: at.block.marks.filter((m) => m.t === t).map((m) => ({ ...m })),
    })
  }
  return out
}

/**
 * `text` (a card's ref) inserted into footnote `at.blockId` at `at.offset` (within its text now),
 * after a space where a word ends there: the footnote's own text is kept.
 */
export function insertInFootnote(
  seq: BlockSeq,
  at: { blockId: string; offset: number },
  text: string,
): EditorChange[] {
  const b = seq.at(seq.indexOf(at.blockId))
  if (b?.kind !== 'footnote' || text === '') return []
  const o = Math.max(0, Math.min(b.text.length, at.offset))
  const ins = o > 0 && !/\s/.test(b.text.charAt(o - 1)) ? ` ${text}` : text
  return [{ t: 'edit', id: b.id, splices: [{ at: o, del: 0, ins }] }]
}

/** The word that ends at `at` of `text` (`[from, at)`), or null when a space or nothing is there. */
export function wordBefore(text: string, at: number): { from: number; to: number } | null {
  let from = at
  while (from > 0 && !/\s/.test(text.charAt(from - 1))) from--
  return from < at ? { from, to: at } : null
}
