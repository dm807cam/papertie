import { readFileSync } from 'node:fs'
import { PALETTE, PALETTE_TOKENS, type PaletteToken } from '@papertie/core'
import type { RgbaImage } from '../src/image'
import { bakeFibre } from '../src/textures/derive'
import { generateFibre } from '../src/textures/fibre'
import { FIBRE_OVERLAY, TEXTURE_SEED } from '../src/textures/set'

const NOTE_CSS = readFileSync(
  new URL('../../apps/web/src/notes/note.css', import.meta.url),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

type Rgb = readonly [number, number, number]
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as never
const lin = (c: number) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const contrast = (a: Rgb, b: Rgb) => {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const over = (ground: Rgb, top: Rgb, alpha: number): Rgb =>
  ground.map((v, i) => v + ((top[i] as number) - v) * alpha) as never

/** The declaration of `property` in the rule of `selector`. */
function decl(selector: string, property: string): string {
  const at = NOTE_CSS.indexOf(`${selector} {`)
  if (at < 0) throw new Error(`no rule for ${selector}`)
  const body = NOTE_CSS.slice(at, NOTE_CSS.indexOf('}', at))
  const v = new RegExp(`${property}:\\s*([^;]+);`).exec(body)?.[1]
  if (v === undefined) throw new Error(`${selector} sets no ${property}`)
  return v.replace(/\s+/g, ' ')
}

/** A dot at its centre, where it is at its strongest, on `ground` of `paper`. */
function dot(paper: PaletteToken, ground: Rgb): Rgb {
  if (paper === 'ink') {
    const m = /^rgb\(0 0 0 \/ ([\d.]+)\)$/.exec(
      decl('.note[data-paper="ink"]:not(.note--print) .note-decor', '--decor-dot'),
    )
    if (!m) throw new Error('the dots on ink are not a let-down black')
    return over(ground, [0, 0, 0], Number(m[1]))
  }
  const m = /^color-mix\(in srgb, var\(--note-ink\) ([\d.]+)%, transparent\)$/.exec(
    decl('.note-decor', '--decor-dot'),
  )
  if (!m) throw new Error('the dots are not a let-down note ink')
  return over(ground, rgb(PALETTE[paper].ink), Number(m[1]) / 100)
}

/** The subtitle's ink on a dotted note: the note's ink let down toward its paper. */
function subtitleInk(paper: PaletteToken): Rgb {
  const m = /^color-mix\(in srgb, var\(--note-ink\) ([\d.]+)%, var\(--note-paper\)\)$/.exec(
    decl('.note[data-motif="dots"] .note-subtitle', 'color'),
  )
  if (!m) throw new Error('the dotted subtitle is not a let-down note ink')
  return over(rgb(PALETTE[paper].paper), rgb(PALETTE[paper].ink), Number(m[1]) / 100)
}

/** Every distinct colour of a paper's fibre sheet, the one a fibre note is drawn on. */
function sheetColours(image: RgbaImage): Rgb[] {
  const seen = new Map<number, Rgb>()
  const d = image.data
  for (let i = 0; i < d.length; i += 4) {
    const c: Rgb = [d[i] as number, d[i + 1] as number, d[i + 2] as number]
    seen.set((c[0] << 16) | (c[1] << 8) | c[2], c)
  }
  return [...seen.values()]
}

describe('the dot grid under a note’s text', () => {
  const fibre = generateFibre({ size: 512, seed: TEXTURE_SEED })

  it.each(PALETTE_TOKENS)('keeps the text at 7:1 and the subtitle at 4.5:1 on %s', (paper) => {
    const ink = rgb(PALETTE[paper].ink)
    const blend = paper === 'ink' ? 'screen' : 'multiply'
    const sheet = bakeFibre(fibre, PALETTE[paper].paper, blend, FIBRE_OVERLAY[blend])
    // Smooth paper is the flat colour; fibre paper is its sheet, at its least favourable pixel.
    const grounds = [rgb(PALETTE[paper].paper), ...sheetColours(sheet)]
    const worst = (text: Rgb) => Math.min(...grounds.map((g) => contrast(text, dot(paper, g))))
    expect(worst(ink)).toBeGreaterThanOrEqual(7)
    expect(worst(subtitleInk(paper))).toBeGreaterThanOrEqual(4.5)
  })

  it('is darker than the paper on ink, so the light text only gains contrast on it', () => {
    const paper = rgb(PALETTE.ink.paper)
    expect(lum(dot('ink', paper))).toBeLessThan(lum(paper))
  })
})
