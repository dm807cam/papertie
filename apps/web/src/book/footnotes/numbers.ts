/**
 * Footnote numbers on the page: numbered through the whole book by core's rule
 * (`numberFootnotes`: anchors in book order, by where each ends within a block (`to`), a
 * footnote at its first anchor; an anchor whose footnote is gone, or in a prompt, counts for
 * nothing), but read from the window's blocks only. The model keeps each chunk's anchors beside
 * its blocks (`BookModel.anchorsBefore`), so a run of blocks on the page starts at the count of
 * the anchors before it and numbers what it holds: O(the window), never the book. A footnote
 * anchored in two blocks (a paragraph split inside its anchor) counts once, at its first: the
 * model takes the few such footnotes off its sums, and the window skips their later anchors. An orphan (no
 * block anchors it, `BookModel.anchored`) has no number; it is drawn faded.
 */
import type { EditorMark } from '../editor/BookEditor'
import { anchorIds, type Block, type BookModel } from '../editor/model'
import { footnoteOf as footnoteOfMark } from './marks'

/** How many blocks the numbering read (the count test's). */
export const footnoteStats = { reads: 0 }

/** Anchors in the order of their references: by where each ends, then by type (core's order). */
const byRef = (a: EditorMark, b: EditorMark) => a.to - b.to || (a.t < b.t ? -1 : 1)

/**
 * The first run of each footnote `b` anchors that is in the book (`model.isFootnote`), in the
 * order of their references. A block's marks are sorted by (type, from), so a footnote's first
 * run is its first in the list.
 */
function firstsOf(model: BookModel, b: Block): EditorMark[] {
  const firsts = new Map<string, EditorMark>()
  for (const m of b.marks) {
    const id = footnoteOfMark(m.t)
    if (id !== null && !firsts.has(id) && model.isFootnote(id)) firsts.set(id, m)
  }
  return [...firsts.values()].sort(byRef)
}

/**
 * The numbers of the footnotes anchored in the blocks of `ids` (book order, the window's: runs
 * of neighbours, a kept block apart), and of the anchors there. Each run is read from its first
 * block back to the paragraph its first footnotes hang from.
 */
export function numberWindow(model: BookModel, ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>()
  const at = ids.map((id) => model.indexOf(id)).filter((i) => i >= 0)
  let k = 0
  while (k < at.length) {
    let end = k
    while (end + 1 < at.length && (at[end + 1] as number) <= (at[end] as number) + 1) end++
    let from = at[k] as number
    while (from > 0) {
      const b = model.at(from)
      if (b?.kind !== 'footnote' && b?.kind !== 'prompt') break
      from--
    }
    let n = model.anchorsBefore(from)
    const last = at[end] as number
    for (let i = from; i <= last; i++) {
      const b = model.at(i) as Block
      footnoteStats.reads++
      if (b.kind === 'footnote' || b.marks.length === 0) continue
      if (anchorIds(b).length === 0) continue
      for (const m of firstsOf(model, b)) {
        const id = footnoteOfMark(m.t) as string
        // Anchored in two blocks (a split inside its anchor): numbered at its first block only.
        if (model.anchoredTwice(id)) {
          const first = model.firstAnchor(id)
          if (first !== i) {
            if (!out.has(id) && first >= 0) out.set(id, numberAt(model, id, first))
            continue
          }
        }
        n++
        if (!out.has(id)) out.set(id, n)
      }
    }
    k = end + 1
  }
  return out
}

/**
 * The number of footnote `id`, numbered at block `first` (its first anchor) out of the window:
 * the footnotes before that block, and its place among the block's own. One block read.
 */
function numberAt(model: BookModel, id: string, first: number): number {
  const b = model.at(first) as Block
  footnoteStats.reads++
  let n = model.anchorsBefore(first)
  for (const m of firstsOf(model, b)) {
    const f = footnoteOfMark(m.t) as string
    if (model.anchoredTwice(f) && model.firstAnchor(f) !== first) continue
    n++
    if (f === id) return n
  }
  return n
}

/**
 * The window's footnotes and anchors given their numbers (`data-n`) and orphans their mark
 * (`data-orphan`): attributes only, written only where they changed, never the text.
 */
export function paintNumbers(
  els: ReadonlyMap<string, HTMLElement>,
  model: BookModel,
  ids: readonly string[],
  numbers: ReadonlyMap<string, number>,
): void {
  const set = (el: HTMLElement, n: number | undefined) => {
    const v = n === undefined ? undefined : String(n)
    if (el.dataset.n === v) return
    if (v === undefined) delete el.dataset.n
    else el.dataset.n = v
  }
  for (const id of ids) {
    const el = els.get(id)
    const b = model.get(id)
    if (el === undefined || b === undefined) continue
    if (b.kind === 'footnote') {
      const orphan = !model.anchored(id)
      set(el, orphan ? undefined : numbers.get(id))
      if (orphan !== el.hasAttribute('data-orphan')) el.toggleAttribute('data-orphan', orphan)
      continue
    }
    if (b.marks.length === 0) continue
    for (const a of el.querySelectorAll<HTMLElement>('.bk-anchor'))
      set(a, numbers.get(a.dataset.note ?? ''))
  }
}
