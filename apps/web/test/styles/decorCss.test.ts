import { sheet } from './cssColour'

describe('the decorations’ stylesheet', () => {
  const css = sheet('notes/note.css')
  const picker = sheet('ui/notePicker.css')

  it('fetches no image for a decoration, on a note or in the picker', () => {
    expect(
      [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]).filter((u) => /decor/.test(u ?? '')),
    ).toEqual(['/decor/ink-mark.svg', '/decor/ink-mark.svg'])
    expect(picker).not.toMatch(/url\(/)
  })

  it('blends none of them, and presses the stamp in only while motion is allowed', () => {
    const decor = /\.note-decor \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(decor).toContain('pointer-events: none')
    expect(decor).not.toContain('mix-blend-mode')
    expect(css).toMatch(/\.note-stamp--press \{\s*animation: stamp-press var\(--motion-slow\)/)
  })

  it('cuts the folded corner out of the paper only where the flap is drawn', () => {
    expect(css).toMatch(
      /\.note\[data-motif="fold"\]:not\(\.note--lite\) \.note-paper \{\s*clip-path: polygon\(/,
    )
  })
})
