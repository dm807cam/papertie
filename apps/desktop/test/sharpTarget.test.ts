import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  lockedIntegrity,
  matchesIntegrity,
  sharpPackages,
  tarballUrl,
} from '../scripts/sharpTarget.mjs'

/** sharp's own list, read from its installed package.json (what the packaging reads). */
const sharpOptional = JSON.parse(
  readFileSync(join(__dirname, '..', 'node_modules', 'sharp', 'package.json'), 'utf8'),
).optionalDependencies as Record<string, string>
const lockfile = readFileSync(join(__dirname, '..', '..', '..', 'pnpm-lock.yaml'), 'utf8')

describe('sharp per target', () => {
  it('takes the binding and its libvips where the target has one', () => {
    const v = sharpOptional['@img/sharp-linux-x64']
    const vips = sharpOptional['@img/sharp-libvips-linux-x64']
    expect(sharpPackages(sharpOptional, 'linux', 'x64')).toEqual([
      { name: '@img/sharp-linux-x64', version: v },
      { name: '@img/sharp-libvips-linux-x64', version: vips },
    ])
    expect(sharpPackages(sharpOptional, 'darwin', 'arm64').map((p) => p.name)).toEqual([
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-arm64',
    ])
    // Windows' binding carries libvips itself.
    expect(sharpPackages(sharpOptional, 'win32', 'x64').map((p) => p.name)).toEqual([
      '@img/sharp-win32-x64',
    ])
  })

  it('refuses a target sharp has no build for', () => {
    expect(() => sharpPackages(sharpOptional, 'linux', 'mips')).toThrow(/no build for linux-mips/)
  })

  it("reads each target package's integrity from the lockfile", () => {
    for (const [platform, arch] of [
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['win32', 'x64'],
    ] as const) {
      for (const { name, version } of sharpPackages(sharpOptional, platform, arch)) {
        expect(lockedIntegrity(lockfile, name, version)).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/)
      }
    }
    expect(() => lockedIntegrity(lockfile, '@img/sharp-linux-x64', '0.0.1')).toThrow(
      /not in pnpm-lock/,
    )
  })

  it('checks bytes against an integrity, and names the tarball', () => {
    const bytes = Buffer.from('papertie')
    const good = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    expect(matchesIntegrity(bytes, good)).toBe(true)
    expect(matchesIntegrity(Buffer.from('musubv'), good)).toBe(false)
    expect(tarballUrl('https://registry.npmjs.org', '@img/sharp-linux-x64', '0.35.5')).toBe(
      'https://registry.npmjs.org/@img/sharp-linux-x64/-/sharp-linux-x64-0.35.5.tgz',
    )
  })
})
