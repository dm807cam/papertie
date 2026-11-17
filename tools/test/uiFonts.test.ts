import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { facesOf, isShipped, SHIPPED_SUBSETS, shippedStylesheet, woff2Only } from '../src/uiFonts'

const WEB = join(import.meta.dirname, '../../apps/web')
const FONTSOURCE = join(WEB, 'node_modules/@fontsource')
const sheet = (p: string) => readFileSync(join(FONTSOURCE, p), 'utf8')

/** Every Fontsource stylesheet the app imports, as `<package>/<file>.css`. */
const imported = ['src/styles/fonts.ts', 'src/book/writerFonts.ts'].flatMap((f) =>
  [...readFileSync(join(WEB, f), 'utf8').matchAll(/'@fontsource\/([\w-]+\/[\w-]+\.css)'/g)].map(
    (m) => m[1] as string,
  ),
)

describe('the fonts the app imports', () => {
  it('are the four faces, whole stylesheets with their unicode-ranges', () => {
    expect([...new Set(imported.map((p) => p.split('/')[0]))].sort()).toEqual([
      'cormorant-garamond',
      'instrument-sans',
      'newsreader',
      'patrick-hand',
    ])
    for (const p of imported) expect(p).toMatch(/\/\d+(-italic)?\.css$/)
  })

  it('are the only font packages installed', () => {
    expect(readdirSync(FONTSOURCE).sort()).toEqual([
      'cormorant-garamond',
      'instrument-sans',
      'newsreader',
      'patrick-hand',
    ])
  })
})

describe('shippedStylesheet', () => {
  it('keeps the Latin and Latin Extended faces of every stylesheet, each with its range', () => {
    for (const p of imported) {
      const kept = facesOf(shippedStylesheet(sheet(p)))
      expect(kept.map((f) => f.name.replace(/-\d+-(normal|italic)$/, '')).sort()).toEqual(
        SHIPPED_SUBSETS.map((s) => `${p.split('/')[0]}-${s}`).sort(),
      )
      expect(kept.every(isShipped)).toBe(true)
      expect(kept.every((f) => f.ranges.length > 0)).toBe(true)
      expect(kept.every((f) => /\.woff2\)/.test(f.text) && !/\.woff\)/.test(f.text))).toBe(true)
    }
  })

  it('leaves out every other subset', () => {
    const whole = facesOf(sheet('cormorant-garamond/400-italic.css'))
    const kept = facesOf(shippedStylesheet(sheet('cormorant-garamond/400-italic.css')))
    expect(whole.length).toBeGreaterThan(kept.length)
    expect(kept.some((f) => /cyrillic|vietnamese|greek/.test(f.name))).toBe(false)
  })
})

describe('woff2Only', () => {
  it('drops every woff fallback and keeps the woff2', () => {
    const css = sheet('instrument-sans/400.css')
    const cut = woff2Only(css)
    expect(cut).not.toMatch(/\.woff\)/)
    expect(cut.match(/\.woff2\)/g)?.length).toBe(css.match(/\.woff2\)/g)?.length)
  })
})
