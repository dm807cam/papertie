import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const settings = readFileSync(
  fileURLToPath(new URL('../../src/settings/settings.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

function rule(selector: string, from = settings): string {
  const at = from.indexOf(`${selector} {`)
  if (at < 0) throw new Error(`no rule ${selector}`)
  return from.slice(at, from.indexOf('}', at))
}

describe('one chosen look', () => {
  it('sinks the chosen segment like the picker’s Style row, never a solid ink block', () => {
    const chosen = rule('.settings-chip-input:checked + .settings-chip-face')
    expect(chosen).toMatch(
      /background: color-mix\(in srgb, var\(--ink-cream\) 8%, var\(--paper-cream\)\)/,
    )
    expect(chosen).toMatch(/inset 0 1px 2px/)
    expect(chosen).not.toMatch(/background: var\(--ink-cream\)/)
    expect(settings).not.toMatch(/settings-switch/)
  })
})

describe('the chosen segment reads at a glance', () => {
  it('rings the chosen one in ink (≥ 3:1 against the bare paper the others sit on), the others unfilled', async () => {
    const { colour, rootVars, customProps, toHex } = await import('../styles/cssColour')
    const { contrastRatio } = await import('@papertie/core')
    const chosen = rule('.settings-chip-input:checked + .settings-chip-face')
    const ring = /box-shadow:\s*inset 0 0 0 1\.5px (var\(--[a-z-]+\))/.exec(chosen)?.[1]
    expect(ring).toBeDefined()
    // The unchosen faces have no fill of their own: the group lies on the sheet's paper.
    expect(rule('.settings-chips')).not.toMatch(/background:/)
    expect(rule('.settings-chip-face')).not.toMatch(/background:/)
    const vars = { ...rootVars(), ...customProps(rule('.settings-sheet')) }
    const ink = toHex(colour(ring as string, vars))
    const paper = toHex(colour('var(--paper-cream)', vars))
    expect(contrastRatio(ink, paper)).toBeGreaterThanOrEqual(3)
  })
})
