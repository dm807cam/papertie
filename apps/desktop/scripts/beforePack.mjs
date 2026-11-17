// electron-builder's beforePack hook (electron-builder.yml): before each target is packed, its
// own sharp packages are put where the config copies them from (`sharpTarget.mjs`).
import { stageSharp } from './sharpTarget.mjs'

/** electron-builder's `Arch` enum, by value. */
const ARCH = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

export default async function beforePack(context) {
  const platform = context.electronPlatformName
  const arch = ARCH[context.arch]
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Papertie is not built for ${platform}-${arch}`)
  }
  await stageSharp(platform, arch)
}
