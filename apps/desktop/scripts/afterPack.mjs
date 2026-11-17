// electron-builder's afterPack hook (electron-builder.yml): the Mac app is ad-hoc signed, whole,
// before it is zipped. Papertie is not signed with a Developer ID yet, and macOS calls a downloaded
// app whose seal is missing or broken "damaged", with no way to open it; an ad-hoc signed one can
// be opened from System Settings → Privacy & Security → Open Anyway.
//
// From Linux (CI) the signing is `rcodesign` (apple-codesign; the workflow installs a pinned,
// checked release and names it in PAPERTIE_RCODESIGN), and on a Mac without it, macOS's `codesign`.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

function onPath(tool) {
  try {
    execFileSync(tool, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const rcodesign = process.env.PAPERTIE_RCODESIGN || (onPath('rcodesign') ? 'rcodesign' : null)
  if (rcodesign) {
    console.log(`  ad-hoc signing ${app} (rcodesign)`)
    // No key given: an ad-hoc signature, nested code first, then the bundle's seal. No
    // `rcodesign verify` after it: it says itself that it is "known to be buggy", and it fails on
    // every ad-hoc signature ("CMS error: missing further values", as there is no certificate).
    // Apple's `codesign --verify` on a Mac is the proof (docs/release.md).
    run(rcodesign, ['sign', app])
  } else if (process.platform === 'darwin') {
    console.log(`  ad-hoc signing ${app} (codesign)`)
    run('codesign', ['--force', '--deep', '--sign', '-', app])
    run('codesign', ['--verify', '--deep', '--strict', app])
  } else {
    throw new Error('The Mac app needs signing: install rcodesign or set PAPERTIE_RCODESIGN')
  }
}
