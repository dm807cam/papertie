// Electron's binary, fetched if its package's install step has not run (pnpm can leave it
// unrun, e.g. on a node_modules copied from another checkout): `electron .` needs it.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const pkg = dirname(require.resolve('electron/package.json'))
if (!existsSync(join(pkg, 'path.txt'))) {
  console.log('Fetching the Electron binary…')
  execFileSync(process.execPath, [join(pkg, 'install.js')], { stdio: 'inherit' })
}
