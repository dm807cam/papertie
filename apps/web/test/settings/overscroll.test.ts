import { readFileSync } from 'node:fs'

const css = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8')

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(source: string, selector: string): string {
  const at = source.split(/(?<=})/).find((r) => {
    const head = r.slice(0, r.indexOf('{')).replace(/\/\*[\s\S]*?\*\//g, '')
    return head.replace(/\s+/g, ' ').trim() === selector
  })
  if (at === undefined) throw new Error(`no rule for ${selector}`)
  return at.slice(at.indexOf('{') + 1, -1)
}

describe('a sideways swipe never leaves the board', () => {
  it('stops the page itself overscrolling (the back/forward swipe) while the board is shown', () => {
    // A wheel over the sidebar or the Settings sheet is not the camera's: it chains to the page.
    expect(rule(css('canvas/canvas.css'), 'html:has(.viewport)')).toMatch(
      /overscroll-behavior:\s*none/,
    )
  })

  it("keeps the sheet's own scrolling inside the sheet", () => {
    expect(rule(css('settings/settings.css'), '.settings-body')).toMatch(
      /overscroll-behavior:\s*contain/,
    )
    const narrow = css('settings/settings.css').slice(
      css('settings/settings.css').indexOf('@media (max-width: 767'),
    )
    expect(rule(narrow, '.settings-tabs')).toMatch(/overscroll-behavior:\s*contain/)
  })
})
