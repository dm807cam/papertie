// The desktop app, built: everything Electron runs, in `dist/`.
//
//   dist/main.cjs      the main process: src/main.ts with the server (apps/server
//                      `src/host.ts`) and its pure-JS dependencies bundled in;
//                      `electron` and `sharp` (native) stay external
//   dist/preload.cjs   the sandboxed preload, one file (a sandboxed preload cannot require ours)
//   dist/web/          the built web app (apps/web/dist, which must be built first)
//   dist/icon.png      the window's and the About box's icon
//
// The account code Papertie once had (better-sqlite3, better-auth, nodemailer) must never be in the
// bundle: the build fails if any of it is.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const webDist = join(root, '..', 'web', 'dist')
const ACCOUNT_CODE =
  /[\\/]node_modules[\\/](better-sqlite3|better-auth|@better-auth|nodemailer)[\\/]/

if (!existsSync(join(webDist, 'index.html'))) {
  console.error(`No built web app at ${webDist}: run \`pnpm --filter @papertie/web build\` first.`)
  process.exit(1)
}

rmSync(dist, { recursive: true, force: true })

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22.12',
  minify: true,
  sourcemap: 'linked',
  logLevel: 'warning',
  metafile: true,
}

const main = await build({
  ...common,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  external: ['electron', 'sharp'],
})
const bundled = Object.keys(main.metafile.inputs).filter((p) => ACCOUNT_CODE.test(join(root, p)))
if (bundled.length > 0) {
  console.error(`The account code is in the desktop bundle:\n  ${bundled.join('\n  ')}`)
  process.exit(1)
}

await build({
  ...common,
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
  external: ['electron'],
})

cpSync(webDist, join(dist, 'web'), { recursive: true })
cpSync(join(root, 'build', 'icons', '512x512.png'), join(dist, 'icon.png'))
console.log(`Built ${relative(process.cwd(), dist) || 'dist'}`)
