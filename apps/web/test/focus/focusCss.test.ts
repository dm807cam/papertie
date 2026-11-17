import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(
  fileURLToPath(new URL('../../src/focus/focus.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

const syncCss = readFileSync(
  fileURLToPath(new URL('../../src/sync/sync.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string, from = css): string {
  const at = from.indexOf(`${selector} {`)
  if (at < 0) throw new Error(`no rule ${selector}`)
  return from.slice(at, from.indexOf('}', at))
}

describe('focus.css', () => {
  it('moves the notice slips above the chip by translate, eased, never by a jump in bottom', () => {
    expect(css).not.toMatch(/sync-notices[^{]*\{[^}]*bottom:/)
    expect(rule('.viewport > .ui > .sync-notices')).toMatch(
      /transition:\s*translate var\(--motion-base\) var\(--ease\)/,
    )
    expect(rule('.viewport[data-focus] > .ui > .sync-notices')).toMatch(/translate: 0 -\d+px/)
  })

  it('fits a phone: no Esc box, and the chip where the slips start, above the save dot', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 767px)'))
    expect(rule('.focus-chip-key', narrow)).toMatch(/display: none/)
    // The slips' phone base clears the mini-bar, its save dot in it; the chip
    // sits there, and the slips rise above it by the desktop lift.
    const slipsNarrow = syncCss.slice(syncCss.indexOf('@media (max-width: 767px)'))
    const base = /bottom: ([^;]+);/.exec(rule('.viewport > .ui > .sync-notices', slipsNarrow))?.[1]
    expect(base).toContain('56px')
    expect(rule('.viewport > .ui > .focus-chip', narrow)).toContain(`bottom: ${base};`)
    expect(narrow).not.toMatch(/sync-notices/)
    expect(rule('.viewport > .ui > .focus-chip', narrow)).toMatch(/max-width: calc\(100% - \d+px\)/)
  })
})
