import { readFileSync } from 'node:fs'

const css = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')

/** The declarations of `selector` inside the `@media (max-width: 767px)` block of `source`. */
function narrowRule(source: string, selector: string): Record<string, string> {
  const media = source.slice(source.indexOf('@media (max-width: 767px)'))
  const at = media.indexOf(selector)
  if (at < 0) return {}
  const body = media.slice(media.indexOf('{', at) + 1, media.indexOf('}', at))
  return Object.fromEntries(
    body
      .split(';')
      .map((d) => d.split(':').map((x) => x.trim()))
      .filter((d) => d.length >= 2)
      .map(([k, ...v]) => [k, v.join(':')]),
  )
}

describe('narrow layout', () => {
  it('notice slips sit centred above the mini-bar, its save dot in it, never over them', () => {
    const slips = narrowRule(css('sync/sync.css'), '.viewport > .ui > .sync-notices')
    // Centred (the base rule's translateX(-50%) about left: 50%), nearly the full width.
    expect(slips.left).toBeUndefined()
    expect(slips.width).toBe('calc(100% - 24px)')
    // The pill (56 px, its save dot in its own slot) and a gap; and the selection's
    // row while it is out.
    expect(slips.bottom?.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')')).toBe(
      'calc(max(12px, env(safe-area-inset-bottom)) + 56px + 10px + var(--minibar-rise, 0px))',
    )
    const rise = narrowRule(
      css('ui/sidebar.css'),
      '.viewport > .ui:has(> .minibar .minibar-selection[data-shown])',
    )
    expect(rise['--minibar-rise']).toBe('57px')
  })
})
