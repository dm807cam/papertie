import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The search palette's classes (`search/picker.css`) belong to it alone. Stylesheets are global,
 * so another sheet defining `.picker-row` (the "+" and yarn sheets once did) would lay out ⌘K's
 * rows too: the swatch on a line of its own, another title colour.
 */
const SRC = fileURLToPath(new URL('../../src', import.meta.url))
const PICKER = join(SRC, 'search', 'picker.css')

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(name) ? [p] : []
  })
}

/** Every class a stylesheet's selectors name. */
function classesIn(css: string): Set<string> {
  const out = new Set<string>()
  for (const block of strip(css).split('}')) {
    const selector = block.split('{')[0] ?? ''
    for (const m of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1] as string)
  }
  return out
}

const palette = [...classesIn(readFileSync(PICKER, 'utf8'))].filter((c) => c.startsWith('picker'))

describe('the search palette owns its classes', () => {
  it('defines its row, title and swatch', () => {
    expect(palette).toEqual(expect.arrayContaining(['picker-row', 'picker-title', 'picker-swatch']))
  })

  it('no other stylesheet styles them', () => {
    for (const file of files(SRC, /\.css$/)) {
      if (file === PICKER) continue
      const theirs = classesIn(readFileSync(file, 'utf8'))
      const shared = palette.filter((c) => theirs.has(c))
      expect({ file: file.slice(SRC.length), shared }).toEqual({
        file: file.slice(SRC.length),
        shared: [],
      })
    }
  })

  it('no component outside search puts them on its markup', () => {
    for (const file of files(SRC, /\.tsx?$/)) {
      if (file.startsWith(join(SRC, 'search'))) continue
      const text = readFileSync(file, 'utf8')
      // Every class token in a `className`, plain or a template.
      const tokens = new Set<string>()
      for (const m of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        for (const t of (m[1] ?? m[2] ?? '').split(/\s+/)) tokens.add(t)
      }
      const used = palette.filter((c) => tokens.has(c))
      expect({ file: file.slice(SRC.length), used }).toEqual({
        file: file.slice(SRC.length),
        used: [],
      })
    }
  })
})
