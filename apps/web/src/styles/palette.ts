import {
  contrastRatio,
  PALETTE,
  PALETTE_TOKENS,
  type PaletteEntry,
  type PaletteToken,
} from '@papertie/core'

type Role = 'paper' | 'ink' | 'yarn'
type PaletteVars = Record<`--${Role}-${PaletteToken}`, string>

const ROLES: readonly Role[] = ['paper', 'ink', 'yarn']

/** A yarn token's dye as drawn; unknown tokens draw in ink. */
export function yarnColor(token: string): string {
  return (PALETTE[token as PaletteToken] ?? PALETTE.ink).yarn
}

/** Minimum ink-on-paper contrast for note text. */
const MIN_INK_CONTRAST = 7

/** One CSS custom property per token and role, taken from the palette. */
export function paletteCssVars(p: Record<PaletteToken, PaletteEntry> = PALETTE): PaletteVars {
  const vars: Record<string, string> = {}
  for (const token of PALETTE_TOKENS) {
    for (const role of ROLES) vars[`--${role}-${token}`] = p[token][role]
  }
  return vars as PaletteVars
}

export function applyPaletteVars(el: HTMLElement, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value)
}

/** Tokens whose ink/paper pair falls below 7:1. */
export function paletteWarnings(
  p: Record<PaletteToken, PaletteEntry>,
): Array<{ token: PaletteToken; ratio: number }> {
  const out: Array<{ token: PaletteToken; ratio: number }> = []
  for (const token of PALETTE_TOKENS) {
    const ratio = contrastRatio(p[token].ink, p[token].paper)
    if (ratio < MIN_INK_CONTRAST) out.push({ token, ratio })
  }
  return out
}
