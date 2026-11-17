import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PALETTE_TOKENS } from '@papertie/core'
import { ZOOM_MAX } from '../../src/canvas/Camera'
import { CORK_TILES, corkImage } from '../../src/canvas/cork'

const SRC = new URL('../../src/', import.meta.url).pathname
const PUBLIC = new URL('../../public/', import.meta.url).pathname
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'textures', 'manifest.json'), 'utf8')) as {
  files: Array<{ path: string; width: number; height: number }>
}
const widthOf = (url: string) => {
  const f = manifest.files.find((m) => `/textures/${m.path}` === url)
  if (f === undefined) throw new Error(`${url} is not in the manifest`)
  return f.width
}
const largest = (urls: string[]) => Math.max(...urls.map(widthOf))

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p, ext) : n.endsWith(ext) ? [p] : []
  })
}
const css = files(SRC, '.css')
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')
const tokens = readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8')

/**
 * The file a screen of density `dpr` is served for a CSS image: `image-set(url(a) 1x, url(b) 2x)`
 * takes a at DPR 1 and b above it (the board's zoom plays no part), a plain `url(a)` always a.
 */
function served(image: string, dpr: number): string {
  const set = /image-set\(\s*url\(([^)]+)\) 1x,\s*url\(([^)]+)\) 2x\s*\)/.exec(image)
  if (set) return (dpr > 1 ? set[2] : set[1]) as string
  const one = /url\(([^)]+)\)/.exec(image)
  if (!one) throw new Error(`no image in ${image}`)
  return one[1] as string
}

/** A custom property's value in tokens.css. */
const token = (name: string) => {
  const v = new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1]
  if (v === undefined) throw new Error(`${name} is not declared`)
  return v.replace(/\s+/g, ' ')
}

/**
 * Device px a tile needs: a world-space texture (the fibre, the papers) is drawn at its CSS size
 * times the zoom; the cork is drawn at most at its file's own CSS size (`2 · base`, corkLayers'
 * octaves), whatever the zoom.
 */
const needPx = (tileCssPx: number, dpr: number, zoom: number) => tileCssPx * dpr * zoom

const ZOOMS = [0.25, 0.5, 1, 1.5, 1.9, ZOOM_MAX]

describe('textures never come sharper than their screen needs, nor softer than a 512 px tile at DPR 1', () => {
  const world = ['--fibre', ...PALETTE_TOKENS.map((t) => `--fibre-${t}`)]

  for (const dpr of [1, 2]) {
    it(`the fibre and the papers at DPR ${dpr}, zoom ${ZOOMS.join(', ')}`, () => {
      for (const name of world) {
        const image = token(name)
        const all = [...image.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1] as string)
        const file = served(image, dpr)
        for (const zoom of ZOOMS) {
          // The file shown is as wide as the tile needs, or the widest there is.
          const want = Math.min(needPx(256, dpr, zoom), largest(all))
          expect(widthOf(file), `${name} at DPR ${dpr}, zoom ${zoom}`).toBeGreaterThanOrEqual(want)
        }
        // At DPR 1 that is the 512 px tile (a 1x twin would be half of it).
        expect(widthOf(file)).toBe(512)
      }
    })

    it(`the cork tiles at DPR ${dpr}`, () => {
      for (const tile of Object.values(CORK_TILES)) {
        // Its octaves draw a tile at most at its file's own CSS size, at every zoom.
        const file = served(corkImage(tile), dpr)
        const want = Math.min(needPx(tile.px, dpr, 1), tile.px)
        expect(widthOf(file), `${tile.url} at DPR ${dpr}`).toBeGreaterThanOrEqual(want)
        expect(file).toBe(tile.url)
      }
    })
  }

  it('the fibre and cork files are named nowhere else', () => {
    const plain = /url\((\/textures\/(?:fibre|cork-)[^)]*)\)/g
    for (const m of css.matchAll(plain)) {
      expect(m[1]).not.toMatch(/-1x\.webp$/)
    }
    expect(manifest.files.some((f) => f.path.endsWith('-1x.webp'))).toBe(false)
  })
})
