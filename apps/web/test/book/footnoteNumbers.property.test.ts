/**
 * Every copy of the footnote numbering rule agrees: core's
 * `numberFootnotes`, the server's export (`exportFootnotes`, Markdown and Word), the writer's
 * `numberAll` (the unsaved `.md`) and its window numbering (`numberWindow`, any window). Books of
 * random kinds and anchors: several anchors to a block, overlapping ones, a footnote anchored
 * twice, anchors in prompts and anchors whose footnote is gone.
 */
import { type Block as CoreBlock, numberFootnotes, orphanFootnotes } from '@papertie/core'
import fc from 'fast-check'
import { exportFootnotes, isExported } from '../../../server/src/export/inline'
import { BookModel } from '../../src/book/editor/model'
import { numberAll } from '../../src/book/footnotes/marks'
import { numberWindow } from '../../src/book/footnotes/numbers'

const KINDS = ['p', 'p', 'p', 'quote', 'li', 'h1', 'h2', 'prompt', 'footnote', 'footnote'] as const

const id = (k: number) => `block_${String(k).padStart(26, '0')}`

/** A book: kinds, texts, and anchors naming footnotes of it (or one that is not there). */
const arbBook = fc
  .array(
    fc.record({
      kind: fc.constantFrom(...KINDS),
      len: fc.integer({ min: 1, max: 24 }),
      anchors: fc.array(
        fc.record({
          to: fc.nat(40),
          from: fc.nat(40),
          note: fc.nat(30),
        }),
        { maxLength: 4 },
      ),
    }),
    { minLength: 1, maxLength: 30 },
  )
  .map((specs) => {
    const blocks: CoreBlock[] = specs.map((s, k) => ({
      type: 'block',
      id: id(k),
      bookId: `book_${'0'.repeat(25)}1`,
      pos: String(k),
      kind: s.kind,
      text: 'x'.repeat(s.len),
      marks: [],
    }))
    blocks.forEach((b, k) => {
      if (b.kind === 'footnote') return
      const marks = (specs[k]?.anchors ?? []).map((a) => {
        const from = a.from % b.text.length
        const to = from + 1 + (a.to % (b.text.length - from))
        // An id among the book's blocks (a footnote or not: then it names none), or past them.
        return { t: `n:${id(a.note)}`, from, to }
      })
      // Normalized as core keeps marks: by (t, from), one run per type where they meet.
      marks.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : x.from - y.from))
      const merged: typeof marks = []
      for (const m of marks) {
        const last = merged.at(-1)
        if (last && last.t === m.t && m.from <= last.to) last.to = Math.max(last.to, m.to)
        else merged.push({ ...m })
      }
      b.marks = merged as CoreBlock['marks']
    })
    return blocks
  })

/** `numbers` without the orphans: the footnotes every output shows a number for. */
function anchored(blocks: readonly CoreBlock[], numbers: ReadonlyMap<string, number>) {
  const orphans = orphanFootnotes(blocks)
  return new Map([...numbers].filter(([k]) => !orphans.has(k)))
}

describe('footnote numbers: every copy of the rule agrees', () => {
  it('core, the export, numberAll and the window numbering number alike', () => {
    fc.assert(
      fc.property(arbBook, fc.nat(), fc.nat(), (blocks, w0, w1) => {
        const core = numberFootnotes(blocks)
        const shown = anchored(blocks, core)
        // The server's export: Markdown and Word (prompts are not exported).
        expect(exportFootnotes(blocks.filter(isExported)).numbers).toEqual(shown)
        // The writer's unsaved .md: every footnote, orphans after, as core.
        expect(numberAll(blocks)).toEqual(core)
        // The writer's page, the whole book and any window of it: each footnote anchored there
        // as core numbers it.
        const model = new BookModel(blocks)
        const all = blocks.map((b) => b.id)
        expect(numberWindow(model, all)).toEqual(shown)
        const a = w0 % all.length
        const z = a + (w1 % (all.length - a))
        const window = numberWindow(model, all.slice(a, z + 1))
        for (const [k, v] of window) expect(v).toBe(shown.get(k))
      }),
      { numRuns: 500 },
    )
  })
})
