import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import { AppMark, MARK_P, MARK_TIE } from '../../src/ui/sidebarIcons'

describe('the Papertie mark', () => {
  it('is a P and its tie, decorative: the button that holds it says its name', () => {
    const { container } = render(<AppMark />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('focusable')).toBe('false')
    const paths = [...container.querySelectorAll('path')]
    expect(paths.map((p) => p.getAttribute('d'))).toEqual([MARK_P, MARK_TIE])
    // The P takes the button's colour; the tie keeps its own green, drawn over the stem.
    expect(paths.map((p) => p.getAttribute('class'))).toEqual([null, 'sidebar-mark-tie'])
  })

  it('is the favicon too, and so the small app icons drawn from it', () => {
    const favicon = readFileSync(resolve(process.cwd(), 'public/favicon.svg'), 'utf8')
    expect(favicon).toContain(`class="p" d="${MARK_P}"`)
    expect(favicon).toContain(`class="tie" d="${MARK_TIE}"`)
  })
})
