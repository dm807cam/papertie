import { PALETTE, PALETTE_TOKENS } from '@papertie/core'
import { paletteCssVars, paletteWarnings, yarnColor } from '../src/styles/palette'

describe('palette', () => {
  it('emits one var per token and role, equal to core', () => {
    const v = paletteCssVars()
    expect(Object.keys(v)).toHaveLength(24)
    expect(v['--paper-rose']).toBe('#F4DEDC')
    expect(v['--yarn-apricot']).toBe('#B8364A')
    expect(v['--ink-ink']).toBe('#F3EBDD')
  })

  it('core palette has no contrast warnings', () => {
    expect(paletteWarnings(PALETTE)).toEqual([])
  })

  it('flags a tuned paper below 7:1', () => {
    const p = { ...PALETTE, rose: { ...PALETTE.rose, paper: '#777777' } }
    expect(paletteWarnings(p).map((w) => w.token)).toEqual(['rose'])
  })

  it('carries the signed-off apricot and lilac yarn dyes, from core only', () => {
    const v = paletteCssVars()
    expect(v['--yarn-apricot']).toBe('#B8364A')
    expect(v['--yarn-lilac']).toBe('#9B7EC6')
  })

  it('yarnColor is the palette dye, and ink for an unknown token', () => {
    for (const t of PALETTE_TOKENS) expect(yarnColor(t)).toBe(PALETTE[t].yarn)
    expect(yarnColor('not-a-token')).toBe(PALETTE.ink.yarn)
  })
})
