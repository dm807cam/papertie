import { contrastRatio, PALETTE, PALETTE_TOKENS } from '../src/index'

describe('palette', () => {
  it('has the 8 tokens in order', () =>
    expect(PALETTE_TOKENS).toEqual([
      'cream',
      'rose',
      'apricot',
      'indigo',
      'sage',
      'lilac',
      'ochre',
      'ink',
    ]))
  it.each(PALETTE_TOKENS)('%s ink on paper is >= 7:1', (t) =>
    expect(contrastRatio(PALETTE[t].ink, PALETTE[t].paper)).toBeGreaterThanOrEqual(7),
  )
  it('contrastRatio black/white is 21', () =>
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5))
})
