import { MOTIFS, type Note } from '@papertie/core'
import { cleanup, render } from '@testing-library/react'
import { NoteView } from '../../src/notes/NoteView'
import { STAMP_DETAIL_FROM, StampMark } from '../../src/notes/StampMark'
import { idOf, note } from '../helpers/fakeServer'

const N1 = idOf('note', 1)
const view = (over: Partial<Note>, lod: 'full' | 'lite' = 'full') =>
  render(<NoteView note={note(N1, { text: 'Proofs', ...over })} lod={lod} rotation={false} />)
    .container

afterEach(cleanup)

describe('a note’s decoration', () => {
  it.each(MOTIFS)('%s is one element drawn by the stylesheet: no image, nothing to read', (m) => {
    const c = view({ motif: m })
    expect(c.querySelector('article')?.getAttribute('data-motif')).toBe(m)
    const decor = c.querySelector('.note-decor') as HTMLElement
    expect(decor.getAttribute('aria-hidden')).toBe('true')
    expect([...decor.children].map((el) => [el.tagName, el.className])).toEqual([
      ['DIV', `note-motif note-motif--${m}`],
    ])
    expect(c.querySelector('img')).toBeNull()
  })

  it('a plain note has no decoration layer, and far away none is drawn', () => {
    expect(view({}).querySelector('.note-decor')).toBeNull()
    expect(view({ motif: 'dots', stamp: true }, 'lite').querySelector('.note-decor')).toBeNull()
  })

  it('the stamp is the string tie, drawn inline in the decoration layer', () => {
    const c = view({ stamp: true })
    const stamp = c.querySelector('.note-decor > svg.note-stamp') as SVGSVGElement
    expect(stamp.getAttribute('viewBox')).toBe('0 0 40 40')
    expect(stamp.getAttribute('aria-hidden')).toBe('true')
    expect(c.querySelector('.note-motif')).toBeNull()
  })

  it('only a note with a photo says so (its fibre is then laid over the photo)', () => {
    expect(view({}).querySelector('article')?.hasAttribute('data-photo')).toBe(false)
  })
})

describe('the string-tie stamp', () => {
  const paths = (size: number) => {
    const svg = render(<StampMark size={size} />).container.querySelector('svg') as SVGSVGElement
    return { svg, paths: [...svg.querySelectorAll('path')] }
  }
  /** The closed outlines of a path: its buttons, and their eyelets. */
  const outlines = (d: string) => d.split('Z').filter((s) => s !== '').length

  it('is one thread and two buttons in a single ink, with no lettering', () => {
    const {
      svg,
      paths: [thread, buttons],
    } = paths(26)
    expect(svg.children).toHaveLength(2)
    expect(svg.querySelector('text')).toBeNull()
    expect(thread?.getAttribute('fill')).toBe('none')
    expect(thread?.getAttribute('stroke')).toBe('currentColor')
    expect(thread?.getAttribute('stroke-linecap')).toBe('round')
    expect(buttons?.getAttribute('fill')).toBe('currentColor')
    expect(outlines(buttons?.getAttribute('d') ?? '')).toBe(2)
  })

  it('the thread is a figure-eight: it crosses itself between the buttons and ends in a tail', () => {
    const d = paths(26).paths[0]?.getAttribute('d') ?? ''
    const [loop = '', tail = ''] = d.slice(1).split('M')
    const pts = loop.split('L').map((p) => p.split(' ').map(Number) as [number, number])
    expect(pts).toHaveLength(49)
    expect(pts[0]).toEqual(pts[48])
    // The crossing, midway between the buttons, is passed twice.
    const centre = pts.filter(([x, y]) => Math.hypot(x - 20, y - 19) < 0.11)
    expect(centre).toHaveLength(2)
    expect(tail).toMatch(/^[\d. ]+q[-\d. ]+$/)
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThan(1)
      expect(x).toBeLessThan(39)
      expect(y).toBeGreaterThan(1)
      expect(y).toBeLessThan(39)
    }
  })

  it('drawn large it has a finer thread and an eyelet cut through each button', () => {
    const small = paths(STAMP_DETAIL_FROM - 1).paths
    const large = paths(STAMP_DETAIL_FROM).paths
    expect(Number(large[0]?.getAttribute('stroke-width'))).toBeLessThan(
      Number(small[0]?.getAttribute('stroke-width')),
    )
    expect(large[1]?.getAttribute('fill-rule')).toBe('evenodd')
    expect(outlines(large[1]?.getAttribute('d') ?? '')).toBe(4)
  })
})
