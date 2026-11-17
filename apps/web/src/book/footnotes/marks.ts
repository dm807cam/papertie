/**
 * A footnote's anchor mark as the web reads it: `n:` + the footnote block's id. Core's
 * `noteMarkT` and `footnoteOfMark` say the same; the writer and the unsaved `.md` keep these few
 * lines of their own so that core's footnote module stays in the one chunk that loads a board
 * (its repair), and no chunk is made for it alone (each one is a line of the first JS).
 */
import type { EditorMark } from '../editor/BookEditor'

/** The mark type of the anchor of footnote block `id`. */
export const noteMark = (id: string): EditorMark['t'] => `n:${id}`

/** The footnote an anchor's type names, null for any other mark type (`n` then `:`). */
export const footnoteOf = (t: string): string | null =>
  t.charCodeAt(0) === 110 && t.charCodeAt(1) === 58 ? t.slice(2) : null

/**
 * The footnotes of `blocks` (book order) numbered as core's `numberFootnotes` numbers them: by
 * their references in book order (by where each anchor ends within a block, then its type), each
 * at its first; a prompt's anchors not counted; the unanchored after.
 */
export function numberAll(
  blocks: Iterable<{
    id: string
    kind: string
    marks: readonly { t: string; from: number; to: number }[]
  }>,
): Map<string, number> {
  const notes: string[] = []
  const anchors: string[] = []
  for (const b of blocks) {
    if (b.kind === 'footnote') {
      notes.push(b.id)
      continue
    }
    if (b.kind === 'prompt') continue
    const here: Array<{ id: string; t: string; to: number }> = []
    for (const m of b.marks) {
      const id = footnoteOf(m.t)
      if (id !== null) here.push({ id, t: m.t, to: m.to })
    }
    here.sort((x, y) => x.to - y.to || (x.t < y.t ? -1 : 1))
    for (const a of here) anchors.push(a.id)
  }
  const isNote = new Set(notes)
  const out = new Map<string, number>()
  for (const id of anchors) if (isNote.has(id) && !out.has(id)) out.set(id, out.size + 1)
  for (const id of notes) if (!out.has(id)) out.set(id, out.size + 1)
  return out
}
