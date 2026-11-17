import { readFileSync } from 'node:fs'
import { contrastRatio, PALETTE } from '@papertie/core'
import { PRINT_STOCK } from '../../src/styles/stationery'
import { colour as cssColour, rootVars, toHex } from '../styles/cssColour'

const css = readFileSync(new URL('../../src/settings/settings.css', import.meta.url), 'utf8')

const BASE: Record<string, string> = {
  '--ink-cream': PALETTE.cream.ink,
  '--paper-cream': PALETTE.cream.paper,
  '--yarn-apricot': PALETTE.apricot.yarn,
  '--print-stock': PRINT_STOCK,
  // The UI's muted ink (tokens.css), which this sheet's muted ink is.
  '--ui-muted': toHex(cssColour('var(--ui-muted)', rootVars())),
}

/** sRGB hex mix as CSS `color-mix(in srgb, a p%, b)` computes it. */
function mix(a: string, b: string, p: number): string {
  const ch = (hex: string, i: number) => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) * p + ch(b, i) * (1 - p)))
  return `#${out.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/** A `--set-*` custom property: a `color-mix` of two base colours, or a base colour itself. */
function colour(name: string): string {
  const decl = new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim()
  if (decl === undefined) throw new Error(`${name} is not declared in settings.css`)
  const m = /^color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, var\((--[\w-]+)\)\)$/.exec(decl)
  if (m)
    return mix(BASE[m[1] as string] as string, BASE[m[3] as string] as string, Number(m[2]) / 100)
  const v = /^var\((--[\w-]+)\)$/.exec(decl)
  const base = v && BASE[v[1] as string]
  if (!base) throw new Error(`cannot resolve ${name}: ${decl}`)
  return base
}

describe('settings contrast (UI text at least 4.5:1)', () => {
  const paper = PALETTE.cream.paper
  const field = colour('--set-field')

  it('keeps ink, muted ink and error ink legible on the paper and in the fields', () => {
    for (const ground of [paper, field]) {
      expect(contrastRatio(colour('--set-ink'), ground)).toBeGreaterThanOrEqual(7)
      expect(contrastRatio(colour('--set-muted'), ground)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(colour('--set-error'), ground)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('reads paper-coloured labels on the ink button, the danger button and the checked chip', () => {
    expect(contrastRatio(paper, PALETTE.cream.ink)).toBeGreaterThanOrEqual(7)
    expect(contrastRatio(paper, colour('--set-error'))).toBeGreaterThanOrEqual(4.5)
  })
})
