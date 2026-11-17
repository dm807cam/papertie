/**
 * Footnotes: a footnote is a block of kind `footnote` after the paragraph it
 * belongs to, and its anchor is a mark `n:` + the footnote block's id over the text it annotates.
 * The anchor is an ordinary block mark, so it is sorted, merged, split and sliced by
 * the code bold, italic and card marks use (`splice.ts`): typing inside it
 * extends it, and deleting all of its text removes it, which leaves the footnote an orphan (shown,
 * never dropped). An anchor naming no footnote of its book (its footnote deleted) is a normal
 * leftover, not damage: it is dropped quietly on load (`repairReferences`, no issue).
 *
 * Numbers follow the references: a footnote's reference sits at its
 * anchor's end (`to`), so footnotes are numbered by that offset within a block. An anchor in a
 * prompt (a note to the writer, never exported) counts for nothing.
 */
import type { Block, Mark } from '../schema/records'

/** Whether `t` is an anchor's type: `n` at 0 and `:` at 1 (no other `n…` type exists). */
const isAnchor = (t: string) => t.charCodeAt(0) === 110 && t.charCodeAt(1) === 58

/** The footnote block an anchor's type names, `null` for any other mark type. */
export const footnoteOfMark = (t: Mark['t']): string | null => (isAnchor(t) ? t.slice(2) : null)

/**
 * The anchors of a block in the order of their references (by `to`, then type), none for a
 * footnote or a prompt. O(marks).
 */
function anchorsOf(b: Block): Mark[] | null {
  if (b.kind === 'footnote' || b.kind === 'prompt') return null
  let out: Mark[] | null = null
  // The re-key's scratch index holds stand-ins with a place and no marks (`rekey.ts`).
  for (const m of b.marks ?? []) {
    if (!isAnchor(m.t)) continue
    out ??= []
    out.push(m)
  }
  if (out && out.length > 1) out.sort((a, c) => a.to - c.to || (a.t < c.t ? -1 : 1))
  return out
}

/**
 * Footnote ids in book order of their references (blocks in order, by each anchor's end within a
 * block), then the unanchored footnotes (in block order). Numbers are 1-based, in that order.
 * Only the footnote blocks among `blocks` (given in book order) are numbered; a footnote anchored
 * twice (a split paragraph) counts at its first anchor; anchors in prompts do not count.
 * O(blocks given and their marks).
 */
export function numberFootnotes(blocks: readonly Block[]): Map<string, number> {
  const notes: string[] = []
  const isNote = new Set<string>()
  for (const b of blocks) {
    if (b.kind !== 'footnote') continue
    notes.push(b.id)
    isNote.add(b.id)
  }
  const out = new Map<string, number>()
  if (notes.length === 0) return out
  for (const b of blocks) {
    const anchors = anchorsOf(b)
    if (anchors === null) continue
    for (const m of anchors) {
      const id = m.t.slice(2)
      if (isNote.has(id) && !out.has(id)) out.set(id, out.size + 1)
    }
  }
  for (const id of notes) if (!out.has(id)) out.set(id, out.size + 1)
  return out
}

/**
 * The footnote blocks among `blocks` whose anchor mark is gone (none of `blocks` anchors them, a
 * prompt's anchor not counted).
 */
export function orphanFootnotes(blocks: readonly Block[]): Set<string> {
  const anchored = new Set<string>()
  for (const b of blocks) for (const m of anchorsOf(b) ?? []) anchored.add(m.t.slice(2))
  const out = new Set<string>()
  for (const b of blocks) if (b.kind === 'footnote' && !anchored.has(b.id)) out.add(b.id)
  return out
}

/**
 * `b` without the anchors that name no footnote of its book (`isFootnote(id, bookId)` false),
 * and any anchor on a footnote itself; the block itself when none goes. O(marks).
 */
export function withoutDanglingAnchors(
  b: Block,
  isFootnote: (id: string, bookId: string) => boolean,
): Block {
  let gone = false
  const marks = (b.marks ?? []).filter((m) => {
    if (!isAnchor(m.t)) return true
    const keep = b.kind !== 'footnote' && isFootnote(m.t.slice(2), b.bookId)
    if (!keep) gone = true
    return keep
  })
  return gone ? { ...b, marks } : b
}
