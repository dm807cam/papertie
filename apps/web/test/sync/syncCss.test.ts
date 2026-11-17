import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )
const sync = read('../../src/sync/sync.css')
const recovery = read('../../src/settings/recovery.css')

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string, from: string): string {
  const at = from.indexOf(`${selector} {`)
  if (at < 0) throw new Error(`no rule ${selector}`)
  return from.slice(at, from.indexOf('}', at))
}

describe('the save dot at rest', () => {
  it('draws Saving as a ring with an ink centre, apart from the solid Saved and the hollow Offline', () => {
    for (const [sel, from] of [
      ['.save-dot[data-status="saving"] .save-dot-ink', sync],
      ['.save-pop-status[data-status="saving"] .save-pop-ink', sync],
    ] as const) {
      const r = rule(sel, from)
      expect(r).toMatch(/box-shadow: inset 0 0 0 1\.5px/)
      expect(r).toMatch(/radial-gradient\(circle, var\(--[a-z-]+\) 0 1\.5px/)
    }
    expect(rule('.save-dot-ink', sync)).toMatch(/background: var\(--dot-ink\)/)
  })
})

describe('system messages in the UI sans', () => {
  it('sets the slips, the recovery slip and the popover’s kept notices in --font-note', () => {
    expect(rule('.sync-slip-text', sync)).toMatch(/font: 400 14px \/ 1\.45 var\(--font-note\)/)
    expect(rule('.save-pop-notices > ul', sync)).toMatch(/var\(--font-note\)/)
    expect(rule('.recovery-text', recovery)).toMatch(/font: 400 14px \/ 1\.45 var\(--font-note\)/)
    expect(sync).not.toMatch(/--font-hand/)
    expect(recovery).not.toMatch(/--font-hand/)
  })
})

describe('one place for notices', () => {
  it('stacks the recovery slip with the others: no place of its own at the top', () => {
    expect(rule('.recovery', recovery)).not.toMatch(/position: fixed|top:/)
  })
})

describe('the notices’ close × on touch', () => {
  it('keeps its 24 px look with a 44 px press where the pointer is a finger', () => {
    const coarse = sync.slice(sync.indexOf('@media (pointer: coarse)'))
    const hit = rule('.sync-slip-close::before', coarse)
    expect(hit).toMatch(/inset: -10px/)
    expect(rule('.sync-slip-close', sync)).toMatch(/width: 24px/)
  })
})

describe('the updated slip on a phone', () => {
  it('sits above the mini-bar and the home indicator under 768 px, as the other slips do', () => {
    const media = '@media (max-width: 767px)'
    const slips = rule('.viewport > .ui > .sync-notices', sync.slice(sync.indexOf(media)))
    // After the slip's own rule, so that it wins there.
    const at = sync.indexOf(media, sync.indexOf('.sync-updated {'))
    expect(at).toBeGreaterThan(0)
    const updated = rule('.sync-updated', sync.slice(at))
    const bottom = (r: string) => /bottom: ([^;]+);/.exec(r)?.[1]
    expect(bottom(updated)).toBe(bottom(slips))
    expect(bottom(updated)).toMatch(/env\(safe-area-inset-bottom\)/)
  })
})
