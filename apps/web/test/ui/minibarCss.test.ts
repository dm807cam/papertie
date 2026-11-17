import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )
const sidebar = read('../../src/ui/sidebar.css')
const sync = read('../../src/sync/sync.css')
const notePicker = read('../../src/ui/notePicker.css')

const rule = (selector: string, from: string) => {
  const at = from.indexOf(`${selector} {`)
  if (at < 0) throw new Error(`no rule ${selector}`)
  return from.slice(at, from.indexOf('}', at))
}
const inMedia = (media: string, from: string) => from.slice(from.indexOf(`@media ${media}`))

const px = (v: string | undefined) => {
  if (v === undefined) throw new Error('no value')
  return Number(/^(-?\d+(?:\.\d+)?)px$/.exec(v.trim())?.[1] ?? Number.NaN)
}
/** The rule whose selector is `selector` alone (not one of a list). */
const own = (selector: string, from: string) => {
  for (
    let at = from.indexOf(`${selector} {`);
    at >= 0;
    at = from.indexOf(`${selector} {`, at + 1)
  ) {
    const before = from.slice(0, at).trimEnd()
    if (before === '' || before.endsWith('}')) return from.slice(at, from.indexOf('}', at))
  }
  throw new Error(`no rule ${selector} of its own`)
}
const prop = (block: string, name: string) =>
  new RegExp(`(?:^|[;{\\s])${name.replace(/[-]/g, '\\-')}:\\s*([^;]+);`).exec(block)?.[1]

describe('the mini-bar on the phone (Books joins it)', () => {
  it('the mini-bar fits 320, 360 and 375 px with every target 44 px', () => {
    const bar = own('.minibar', sidebar)
    const btn = px(prop(bar, '--sb-btn'))
    const pad = px(prop(bar, 'padding'))
    const gap = px(prop(rule('.minibar-tools', sidebar), 'gap'))
    // Its left edge (max(10px, the safe area)) and its widest (100% less 20 px).
    expect(prop(bar, 'left')).toMatch(/^max\(10px, /)
    expect(prop(bar, 'max-width')).toBe('calc(100% - 20px)')
    expect(btn).toBe(44)
    // Every press in the pill is the button size: the save dot's slot too.
    expect(prop(rule('.minibar-foot', sidebar), 'width')).toBe('var(--sb-btn)')
    expect(prop(rule('.minibar .sidebar-add', sidebar), 'width')).toBe('var(--sb-btn)')

    // On the board: "+", Select, Yarn, Photo, Search, Books, Settings, then the dot's slot.
    // Below 400 px the dot is Settings' corner mark (no slot); below 360 px Photo leaves for
    // the "+" picker's Photo row.
    const under400 = inMedia('(max-width: 399px)', sidebar)
    expect(prop(rule('.minibar-foot', under400), 'position')).toBe('absolute')
    const under360 = inMedia('(max-width: 359px)', sidebar)
    expect(prop(rule('.minibar-tools > .minibar-photo', under360), 'display')).toBe('none')
    expect(prop(rule('.note-picker-photo', notePicker), 'display')).toBe('none')
    expect(
      prop(rule('.note-picker-photo', inMedia('(max-width: 359px)', notePicker)), 'display'),
    ).toBe('grid')
    const width = (targets: number) => targets * btn + (targets - 1) * gap + 2 * pad
    const slots = (vw: number) => (vw >= 400 ? 8 : vw >= 360 ? 7 : 6)
    for (const vw of [320, 359, 360, 375, 399, 400, 767]) {
      expect(width(slots(vw)), `${vw} px`).toBeLessThanOrEqual(vw - 20)
    }
    // Under a book sheet: Books, Search, Settings and the dot's slot.
    expect(width(4)).toBeLessThanOrEqual(320 - 20)
  })
})

describe('touch targets on the phone', () => {
  it('gives the mini-bar’s save dot a 44 × 44 press', () => {
    const dot = rule('.minibar-foot .save-dot', sidebar)
    expect(dot).toMatch(/width: var\(--sb-btn\)/)
    expect(dot).toMatch(/height: var\(--sb-btn\)/)
    expect(rule('.minibar-foot', sidebar)).toMatch(/width: var\(--sb-btn\)/)
  })

  it('under 400 px the dot is a mark on Settings that takes no press, kept on Settings', () => {
    const narrow = inMedia('(max-width: 399px)', sidebar)
    expect(rule('.minibar-foot', narrow)).toMatch(/pointer-events: none/)
    expect(rule('.minibar-foot .save-dot', narrow)).toMatch(/pointer-events: none/)
    // Placed against the tools' row, so the selection's row above never moves it.
    expect(rule('.minibar-tools', sidebar)).toMatch(/position: relative/)
  })

  it('gives the quiet text buttons a 44 px press where the pointer is a finger', () => {
    expect(rule('.sync-text-button', inMedia('(pointer: coarse)', sync))).toMatch(
      /min-height: 44px/,
    )
  })
})
