import { LIFTED_Z_INDEX, noteStyle, writeNoteStyle } from '../src/notes/noteStyle'

/** Just enough of an element for `writeNoteStyle`. */
function fakeNoteEl(classes: string[]) {
  const set = new Set(classes)
  const paper = { style: {} as Record<string, string> }
  const el = {
    style: {} as Record<string, string>,
    classList: {
      toggle: (c: string, on: boolean) => {
        if (on) set.add(c)
        else set.delete(c)
        return on
      },
      contains: (c: string) => set.has(c),
    },
    querySelector: () => paper,
  }
  return { el: el as unknown as HTMLElement, set, paper }
}

const base = { id: 'note_tag', x: 10, y: 20, h: 290, style: 'rustic' } as const

describe('writeNoteStyle', () => {
  it('writes the same box as noteStyle', () => {
    const { el, paper } = fakeNoteEl(['note'])
    const n = { ...base, w: 260 }
    writeNoteStyle(el, n, true, true)
    const s = noteStyle(n, true)
    expect(el.style.transform).toBe(s.transform)
    expect(el.style.transformOrigin).toBe(s.transformOrigin)
    expect(el.style.width).toBe('260px')
    expect(el.style.zIndex).toBe(LIFTED_Z_INDEX)
    expect(paper.style.minHeight).toBe('290px')
  })

  it('follows a live resize across the tag width', () => {
    const { el, set } = fakeNoteEl(['note', 'note--rustic', 'note--tag'])
    writeNoteStyle(el, { ...base, w: 180 }, true, false)
    expect(set.has('note--tag')).toBe(false)
    writeNoteStyle(el, { ...base, w: 120 }, true, false)
    expect(set.has('note--tag')).toBe(true)
    expect(set.has('note--rustic')).toBe(true)
  })
})
