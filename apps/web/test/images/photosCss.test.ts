import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(
  fileURLToPath(new URL('../../src/images/photos.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

const rule = (sel: string) => {
  const at = css.indexOf(`${sel} {`)
  if (at < 0) throw new Error(`no rule ${sel}`)
  return css.slice(at, css.indexOf('}', at))
}

describe('photos.css', () => {
  it('draws the upload as a hairline in the print’s bottom border, with a track to grow along', () => {
    expect(rule('.photo-progress')).toMatch(/height: 2px/)
    expect(rule('.photo-progress')).toMatch(/bottom: -7px/)
  })
})

describe('the upload line against the print', () => {
  it('draws its track and its fill at 3:1 or more against the print stock', async () => {
    const { colour, rootVars, toHex, over } = await import('../styles/cssColour')
    const { contrastRatio } = await import('@papertie/core')
    const vars = rootVars()
    const stock = colour('var(--print-stock)', vars)
    const bg = (sel: string) => /background: ([^;]+);/.exec(rule(sel))?.[1] as string
    for (const sel of ['.photo-progress', '.photo-progress > i']) {
      const c = over(colour(bg(sel), vars), stock)
      expect(contrastRatio(toHex(c), toHex(stock)), sel).toBeGreaterThanOrEqual(3)
    }
  })
})
