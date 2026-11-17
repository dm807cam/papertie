// What electron-builder packed, checked and listed, for every target it
// left an unpacked app for in `release/`:
//
//   - the app is there: the main bundle, the preload, the web app and the icon;
//   - no account code (better-sqlite3, better-auth, nodemailer), sources, tests or source maps;
//   - sharp's native part is the target's own, and only that: its @img packages, with a binding
//     built for the target's OS and CPU.
//
// `node scripts/checkPackages.mjs <release dir> [version] [--all]`: with `--all` (CI), every
// target's package must be there too, named for its OS and CPU. Exits 1 on any problem.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The unpacked app electron-builder leaves per target, and where its resources are. */
export const TARGETS = [
  {
    os: 'mac',
    platform: 'darwin',
    arch: 'arm64',
    dir: 'mac-arm64',
    res: 'Papertie.app/Contents/Resources',
  },
  {
    os: 'mac',
    platform: 'darwin',
    arch: 'x64',
    dir: 'mac',
    res: 'Papertie.app/Contents/Resources',
  },
  { os: 'linux', platform: 'linux', arch: 'x64', dir: 'linux-unpacked', res: 'resources' },
  { os: 'linux', platform: 'linux', arch: 'arm64', dir: 'linux-arm64-unpacked', res: 'resources' },
  { os: 'win', platform: 'win32', arch: 'x64', dir: 'win-unpacked', res: 'resources' },
]

/** The packages a release has, by name (Linux's in its own CPU names: x86_64 and amd64 are x64). */
export const artifacts = (version) => [
  `Papertie-${version}-mac-arm64.zip`,
  `Papertie-${version}-mac-x64.zip`,
  `Papertie-${version}-linux-x86_64.AppImage`,
  `Papertie-${version}-linux-arm64.AppImage`,
  `Papertie-${version}-linux-amd64.deb`,
  `Papertie-${version}-linux-arm64.deb`,
  `Papertie-${version}-win-x64.exe`,
]

/** The files in an asar (its header: a pickle holding JSON), with whether each is unpacked. */
export function asarFiles(buf) {
  const json = buf.toString('utf8', 16, 16 + buf.readUInt32LE(12))
  const out = []
  const walk = (node, at) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = at ? `${at}/${name}` : name
      if (entry.files) walk(entry, path)
      else out.push({ path, unpacked: entry.unpacked === true })
    }
  }
  walk(JSON.parse(json), '')
  return out
}

/** The OS and CPU a native binary (Mach-O, ELF or PE) was built for, or null. */
export function binaryTarget(buf) {
  const magic = buf.readUInt32LE(0)
  if (magic === 0xfeedfacf) {
    const cpu = buf.readUInt32LE(4)
    return { platform: 'darwin', arch: { 16777223: 'x64', 16777228: 'arm64' }[cpu] ?? `cpu ${cpu}` }
  }
  if (buf.readUInt32BE(0) === 0x7f454c46) {
    const machine = buf.readUInt16LE(18)
    return { platform: 'linux', arch: { 62: 'x64', 183: 'arm64' }[machine] ?? `machine ${machine}` }
  }
  if (buf.toString('latin1', 0, 2) === 'MZ') {
    const pe = buf.readUInt32LE(0x3c)
    const machine = buf.readUInt16LE(pe + 4)
    return {
      platform: 'win32',
      arch: { 34404: 'x64', 43620: 'arm64' }[machine] ?? `machine ${machine}`,
    }
  }
  return null
}

const ACCOUNT_CODE = /(^|\/)node_modules\/(better-sqlite3|better-auth|@better-auth|nodemailer)\//
const DEV_FILE = /(\.map|\.ts|\.tsx|\.md)$|(^|\/)(src|test|tests|__tests__)\//
const REQUIRED = [
  'package.json',
  'dist/main.cjs',
  'dist/preload.cjs',
  'dist/icon.png',
  'dist/web/index.html',
]

/**
 * The problems with one target's app: `files` are its paths in the asar (with the unpacked ones
 * marked), `binary(path)` reads an unpacked file's first bytes.
 */
export function problems(files, target, binary) {
  const out = []
  const paths = new Set(files.map((f) => f.path))
  for (const p of REQUIRED) if (!paths.has(p)) out.push(`missing ${p}`)
  for (const { path } of files) {
    if (ACCOUNT_CODE.test(path)) out.push(`account code: ${path}`)
    else if (DEV_FILE.test(path) && !/^dist\/web\//.test(path)) out.push(`dev file: ${path}`)
    else if (/\.map$/.test(path)) out.push(`source map: ${path}`)
  }
  const own = `@img/sharp-${target.platform}-${target.arch}`
  const imgs = new Set(
    files.map((f) => /^node_modules\/(@img\/sharp-[^/]+)\//.exec(f.path)?.[1]).filter(Boolean),
  )
  if (!imgs.has(own)) out.push(`no ${own}`)
  for (const name of imgs) {
    if (name !== own && name !== `@img/sharp-libvips-${target.platform}-${target.arch}`) {
      out.push(`another target's sharp: ${name}`)
    }
  }
  const natives = files.filter((f) => /\.node$/.test(f.path))
  if (natives.length === 0) out.push('no native binding')
  for (const { path, unpacked } of natives) {
    if (!unpacked) {
      out.push(`packed in the asar, not unpacked: ${path}`)
      continue
    }
    const built = binaryTarget(binary(path))
    if (built?.platform !== target.platform || built?.arch !== target.arch) {
      out.push(
        `${path} is built for ${built ? `${built.platform}-${built.arch}` : 'nothing known'}`,
      )
    }
  }
  return out
}

function sizeOf(path) {
  const s = statSync(path)
  if (!s.isDirectory()) return s.size
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0)
}
const mb = (bytes) => `${(bytes / 1_048_576).toFixed(1)} MB`

function main() {
  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const [releaseDir = 'release', version] = args.filter((a) => !a.startsWith('--'))
  let failed = false
  let checked = 0
  for (const target of TARGETS) {
    const res = join(releaseDir, target.dir, target.res)
    if (!existsSync(join(res, 'app.asar'))) {
      if (all) {
        console.error(`✗ ${target.os}-${target.arch}: no unpacked app at ${res}`)
        failed = true
      }
      continue
    }
    checked++
    const files = asarFiles(readFileSync(join(res, 'app.asar')))
    const unpackedDir = join(res, 'app.asar.unpacked')
    const read = (p) => readFileSync(join(unpackedDir, ...p.split('/'))).subarray(0, 4096)
    const found = problems(files, target, read)
    const label = `${target.os}-${target.arch}`
    console.log(
      `${found.length ? '✗' : '✓'} ${label}: ${files.length} files, asar ${mb(sizeOf(join(res, 'app.asar')))}, unpacked ${mb(existsSync(unpackedDir) ? sizeOf(unpackedDir) : 0)}`,
    )
    // The app's own files, each package by its file count, and every native file by name.
    const groups = new Map()
    for (const f of files) {
      const pkg = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(f.path)?.[1]
      const key = pkg
        ? `node_modules/${pkg}/`
        : f.path.startsWith('dist/web/')
          ? 'dist/web/'
          : f.path
      const g = groups.get(key) ?? { count: 0, unpacked: 0 }
      g.count++
      if (f.unpacked) g.unpacked++
      groups.set(key, g)
    }
    for (const [key, g] of groups) {
      const where = g.unpacked === 0 ? 'asar' : g.unpacked === g.count ? 'unpacked' : 'mixed'
      console.log(`    ${where.padEnd(9)}${key}${key.endsWith('/') ? ` (${g.count} files)` : ''}`)
    }
    for (const f of files.filter((f) => /\.(node|dylib|so(\.\d+)*|dll)$/.test(f.path))) {
      const built = f.path.endsWith('.node') ? binaryTarget(read(f.path)) : null
      console.log(`    native   ${f.path}${built ? `  [${built.platform}-${built.arch}]` : ''}`)
    }
    for (const p of found) console.error(`  ✗ ${p}`)
    if (found.length) failed = true
  }
  if (checked === 0) {
    console.error(`No unpacked app in ${releaseDir}`)
    failed = true
  }
  if (version) {
    for (const name of artifacts(version)) {
      const path = join(releaseDir, name)
      if (existsSync(path)) console.log(`✓ ${name}  ${mb(statSync(path).size)}`)
      else if (all) {
        console.error(`✗ missing ${relative(process.cwd(), path).split(sep).join('/')}`)
        failed = true
      }
    }
  }
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
