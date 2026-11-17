/**
 * The writer's model commands:
 * - Enter by kind: at the end of a quote or prompt, or in an empty one, a
 *   paragraph; in the middle, two of the kind. A list item goes on as one, and an empty one ends
 *   the list as a paragraph. A heading's tail is a paragraph.
 * - Enter at the end of a block with footnotes or prompts after it makes the new block after them.
 * - A delete across a footnote takes its anchor with it, in the same change.
 * - The writer's numbers: an anchor whose footnote is gone, or in a prompt, counts for nothing;
 *   within a block by where each anchor ends.
 */
import type { EditorChange, EditorMark } from '../../src/book/editor/BookEditor'
import { anchorIds, type Block, BookModel, deleteRange, splitAt } from '../../src/book/editor/model'
import { numberWindow } from '../../src/book/footnotes/numbers'

const b = (id: string, kind: Block['kind'], text: string, marks: Block['marks'] = []): Block => ({
  id,
  kind,
  text,
  marks,
})
const n = (id: string, from: number, to: number): EditorMark => ({
  t: `n:${id}` as EditorMark['t'],
  from,
  to,
})

function after(blocks: Block[], changes: EditorChange[]): [string, string][] {
  const m = new BookModel(blocks)
  for (const c of changes) expect(m.apply(c)).toBe(true)
  const out: [string, string][] = []
  for (let i = 0; i < m.length; i++) {
    const x = m.at(i) as Block
    out.push([x.kind, x.text])
  }
  return out
}

describe('Enter by kind', () => {
  const enter = (blocks: Block[], id: string, offset: number) => {
    const m = new BookModel(blocks)
    return after(blocks, splitAt(m, { blockId: id, offset }, 'new'))
  }

  it('Enter at the end of a quote makes a paragraph', () => {
    expect(enter([b('q', 'quote', 'Simplify.')], 'q', 9)).toEqual([
      ['quote', 'Simplify.'],
      ['p', ''],
    ])
  })

  it('Enter in an empty quote makes it a paragraph', () => {
    expect(enter([b('a', 'quote', 'Simplify.'), b('q', 'quote', '')], 'q', 0)).toEqual([
      ['quote', 'Simplify.'],
      ['p', ''],
    ])
  })

  it('Enter in the middle of a quote splits it into two quotes', () => {
    expect(enter([b('q', 'quote', 'Simplify, simplify.')], 'q', 9)).toEqual([
      ['quote', 'Simplify,'],
      ['quote', ' simplify.'],
    ])
  })

  it('a list item goes on as one; an empty one ends the list as a paragraph', () => {
    expect(enter([b('l', 'li', 'First')], 'l', 5)).toEqual([
      ['li', 'First'],
      ['li', ''],
    ])
    expect(enter([b('l', 'li', 'First')], 'l', 2)).toEqual([
      ['li', 'Fi'],
      ['li', 'rst'],
    ])
    expect(enter([b('l', 'li', 'First'), b('e', 'li', '')], 'e', 0)).toEqual([
      ['li', 'First'],
      ['p', ''],
    ])
  })

  it('a prompt ends as a paragraph like a quote', () => {
    expect(enter([b('p', 'p', 'Text'), b('m', 'prompt', 'Why?')], 'm', 4)).toEqual([
      ['p', 'Text'],
      ['prompt', 'Why?'],
      ['p', ''],
    ])
    expect(enter([b('p', 'p', 'Text'), b('m', 'prompt', '')], 'm', 0)).toEqual([
      ['p', 'Text'],
      ['p', ''],
    ])
    expect(enter([b('m', 'prompt', 'Why so?')], 'm', 3)).toEqual([
      ['prompt', 'Why'],
      ['prompt', ' so?'],
    ])
  })

  it('a heading still goes to a paragraph; a paragraph to a paragraph', () => {
    expect(enter([b('h', 'h1', 'One')], 'h', 3)).toEqual([
      ['h1', 'One'],
      ['p', ''],
    ])
    expect(enter([b('h', 'h2', 'Two words')], 'h', 3)).toEqual([
      ['h2', 'Two'],
      ['p', ' words'],
    ])
    expect(enter([b('p', 'p', 'Plain')], 'p', 5)).toEqual([
      ['p', 'Plain'],
      ['p', ''],
    ])
  })

  it('Enter at the end of a footnoted paragraph makes the new one after its footnotes', () => {
    const blocks = [
      b('p1', 'p', 'Walden and the pond', [n('f1', 0, 6), n('f2', 15, 19)]),
      b('f1', 'footnote', 'Thoreau'),
      b('m', 'prompt', 'Why?'),
      b('f2', 'footnote', 'A pond'),
      b('p2', 'p', 'Next'),
    ]
    expect(enter(blocks, 'p1', 19)).toEqual([
      ['p', 'Walden and the pond'],
      ['footnote', 'Thoreau'],
      ['prompt', 'Why?'],
      ['footnote', 'A pond'],
      ['p', ''],
      ['p', 'Next'],
    ])
    // At the end of a quote with its footnote: a paragraph, after the footnote.
    const quoted = [b('q', 'quote', 'Simplify.', [n('f1', 0, 9)]), b('f1', 'footnote', 'Thoreau')]
    expect(enter(quoted, 'q', 9)).toEqual([
      ['quote', 'Simplify.'],
      ['footnote', 'Thoreau'],
      ['p', ''],
    ])
    // In the middle the paragraph splits as before (its tail before the footnotes).
    expect(enter(blocks, 'p1', 6).slice(0, 2)).toEqual([
      ['p', 'Walden'],
      ['p', ' and the pond'],
    ])
  })
})

describe('a delete across a footnote takes its anchor', () => {
  it('deleteRange removes the anchors of the footnotes it deletes, in the same change', () => {
    const blocks = [
      b('p1', 'p', 'Walden and the pond', [n('f1', 0, 6), n('f3', 7, 10)]),
      b('f1', 'footnote', 'Thoreau'),
      b('p2', 'p', 'Second paragraph', [n('f2', 0, 6)]),
      b('f2', 'footnote', 'Kept'),
      b('f3', 'footnote', 'Before the cut'),
    ]
    const m = new BookModel(blocks)
    // From "pond" in P1 to the middle of P2: F1 goes, P1's anchor of it with it.
    const changes = deleteRange(m, { blockId: 'p1', offset: 15 }, { blockId: 'p2', offset: 7 })
    for (const c of changes) expect(m.apply(c)).toBe(true)
    expect(m.get('f1')).toBeUndefined()
    expect(m.get('p1')?.text).toBe('Walden and the paragraph')
    // The anchor of F1 is gone; F3's (outside the cut) stays; P2's of F2 was cut with its text.
    expect(m.get('p1')?.marks).toEqual([n('f3', 7, 10)])
    expect(m.anchored('f1')).toBe(false)
  })
})

describe('the writer’s numbers', () => {
  const ids = (m: BookModel) => Array.from({ length: m.length }, (_, i) => (m.at(i) as Block).id)

  it('an anchor whose footnote is missing is never numbered', () => {
    const m = new BookModel([
      b('p1', 'p', 'Walden and the pond', [n('gone', 0, 6), n('f2', 15, 19)]),
      b('f2', 'footnote', 'A pond'),
      b('p2', 'p', 'More', [n('f3', 0, 4)]),
      b('f3', 'footnote', 'More'),
    ])
    const numbers = numberWindow(m, ids(m))
    expect(numbers.get('gone')).toBeUndefined()
    expect(numbers.get('f2')).toBe(1)
    expect(numbers.get('f3')).toBe(2)
    // From a window that starts after the paragraph, the same.
    expect(numberWindow(m, ['p2', 'f3']).get('f3')).toBe(2)
    // The footnote deleted later: its anchor counts for nothing from then on.
    m.apply({ t: 'delete', id: 'f2' })
    expect(numberWindow(m, ['p2', 'f3']).get('f3')).toBe(1)
    m.apply({ t: 'create', id: 'f2', after: 'p1', kind: 'footnote', text: 'Back' })
    expect(numberWindow(m, ['p2', 'f3']).get('f3')).toBe(2)
  })

  it('an anchor in a prompt counts for nothing: its footnote is an orphan', () => {
    const prompt = b('m', 'prompt', 'Why?', [n('f1', 0, 4)])
    expect(anchorIds(prompt)).toEqual([])
    const m = new BookModel([
      b('p1', 'p', 'Text'),
      prompt,
      b('f1', 'footnote', 'Note'),
      b('p2', 'p', 'Next', [n('f2', 0, 4)]),
      b('f2', 'footnote', 'Two'),
    ])
    expect(m.anchored('f1')).toBe(false)
    expect(numberWindow(m, ids(m)).get('f2')).toBe(1)
    expect(numberWindow(m, ids(m)).get('f1')).toBeUndefined()
  })

  it('within a block, by where each anchor ends', () => {
    const m = new BookModel([
      b('p1', 'p', 'Alpha beta gamma delta', [n('fa', 0, 22), n('fb', 6, 10)]),
      b('fa', 'footnote', 'Whole'),
      b('fb', 'footnote', 'Word'),
    ])
    const numbers = numberWindow(m, ids(m))
    expect(numbers.get('fb')).toBe(1)
    expect(numbers.get('fa')).toBe(2)
  })
})
