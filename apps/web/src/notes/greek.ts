import { hash32 } from '../lib/seed'

const EM = 16
const LATIN_EM = 0.52
const SPACE_EM = 0.26
const MIN_BAR = 0.06
const RAGGED = 0.12

/** An emoji takes a whole em. */
const isWide = (cp: number): boolean => cp >= 0x1f000

/** Estimated width of `line` in ems: an emoji takes one, a letter about half. */
export function textWidthEm(line: string): number {
  let w = 0
  for (const ch of line) {
    const cp = ch.codePointAt(0) ?? 0
    w += ch.trim() === '' ? SPACE_EM : isWide(cp) ? 1 : LATIN_EM
  }
  return w
}

const textWidthPx = (line: string) => EM * textWidthEm(line)

/**
 * Greeked stand-in for `text` wrapped at `widthPx` (the note's content width at 16 px): one bar
 * width per visual line as a fraction in (0, 1], at most `maxLines`. Glyph widths are estimated, wrapped lines get a seeded ragged edge and blank lines are skipped.
 */
export function greekLines(text: string, widthPx: number, maxLines = 6): number[] {
  const cap = Math.floor(maxLines)
  if (!(widthPx > 0) || !Number.isFinite(widthPx) || !(cap >= 1)) return []
  const bars: number[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const units = textWidthPx(line) / widthPx
    const count = Math.max(1, Math.ceil(units))
    for (let k = 0; k < count; k++) {
      if (bars.length >= cap) return bars
      if (k < count - 1) {
        bars.push(1 - RAGGED * (hash32(`${line}:${k}`) / 0x100000000))
      } else {
        bars.push(Math.min(1, Math.max(MIN_BAR, units - k)))
      }
    }
  }
  return bars
}
