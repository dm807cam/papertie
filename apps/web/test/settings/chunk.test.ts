import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8')

describe('Settings is code-split', () => {
  it('is reached only through a dynamic import, never with the board', () => {
    const board = read('app/BoardScreen.tsx')
    expect(board).not.toMatch(/import\s[^;]*from\s+'\.\.\/settings\/Settings'/)
    expect(board).toMatch(/import\('\.\.\/settings\/Settings'\)/)
    expect(read('app/AppShell.tsx')).not.toMatch(/settings\/Settings/)
  })

  it('keeps the recovery slip, which the board shows, out of the lazy files', () => {
    // The slip's watch is in the board's chunk, the slip a chunk of its own (the
    // budget): neither may pull the Settings panel along.
    for (const file of ['settings/RecoveryNotice.tsx', 'settings/RecoverySlip.tsx']) {
      const slip = read(file)
      for (const lazy of ['./Settings', './controls', './settings.css', './Account', './History'])
        expect(slip).not.toContain(`'${lazy}'`)
    }
    // The watch loads the slip only by a dynamic import.
    expect(read('settings/RecoveryNotice.tsx')).not.toMatch(
      /import\s[^;]*from\s+'\.\/RecoverySlip'/,
    )
  })
})
