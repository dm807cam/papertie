// sharp for one build target. sharp's native part lives in a package per
// OS and CPU (`@img/sharp-<platform>-<arch>`, with its libvips in `@img/sharp-libvips-…` where it
// has one), and pnpm installs only the machine's own. So each target's packages are put in
// `.targets/sharp/<os>-<arch>/` before electron-builder packs that target
// (`scripts/beforePack.mjs`), and `electron-builder.yml` copies them into the app's
// `node_modules`, in place of the machine's.
//
// A package comes from this checkout's install when pnpm has it, and otherwise from the registry,
// checked against the integrity pnpm-lock.yaml records for it: the same bytes a pnpm install of
// that target would have.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Where the targets' packages are put: `<os>-<arch>/node_modules/@img/…`. */
export const TARGETS_DIR = join(root, '.targets', 'sharp')

/** electron-builder's OS names (its `${os}`) for Node's. */
export const BUILDER_OS = { darwin: 'mac', linux: 'linux', win32: 'win' }

/**
 * The packages sharp needs on `platform` (Node's: darwin, linux, win32) and `arch` (x64, arm64),
 * with their versions, from sharp's `optionalDependencies`. Linux is glibc's (musl is not built).
 */
export function sharpPackages(optionalDependencies, platform, arch) {
  const wanted = [`@img/sharp-${platform}-${arch}`, `@img/sharp-libvips-${platform}-${arch}`]
  const out = wanted
    .filter((name) => name in optionalDependencies)
    .map((name) => ({ name, version: optionalDependencies[name] }))
  if (out[0]?.name !== wanted[0]) throw new Error(`sharp has no build for ${platform}-${arch}`)
  return out
}

/** The integrity pnpm-lock.yaml records for `name@version` (its `resolution`). */
export function lockedIntegrity(lockfile, name, version) {
  const at = lockfile.indexOf(`\n  '${name}@${version}':\n`)
  if (at === -1) throw new Error(`${name}@${version} is not in pnpm-lock.yaml`)
  const entry = lockfile.slice(at + 1, lockfile.indexOf('\n\n', at + 1))
  const m = /resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/.exec(entry)
  if (!m) throw new Error(`pnpm-lock.yaml has no integrity for ${name}@${version}`)
  return m[1]
}

/** Whether `bytes` match an npm integrity string (`sha512-<base64>`). */
export function matchesIntegrity(bytes, integrity) {
  const [algo, want] = integrity.split('-', 2)
  return createHash(algo).update(bytes).digest('base64') === want
}

/** The registry's tarball for `name@version`. */
export function tarballUrl(registry, name, version) {
  const base = registry.endsWith('/') ? registry : `${registry}/`
  return `${base}${name}/-/${name.split('/')[1]}-${version}.tgz`
}

/** sharp's own folder (the real one, past pnpm's links) and its package.json. */
function installedSharp() {
  // sharp's `exports` hide its package.json from `require.resolve`; its main entry is enough.
  const require = createRequire(join(root, 'package.json'))
  let dir = dirname(realpathSync(require.resolve('sharp')))
  while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir)
  return { dir, pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }
}

/** The package pnpm installed beside sharp, if it is this one at this version. */
function installed(sharpDir, name, version) {
  const dir = join(dirname(sharpDir), name)
  const pkg = join(dir, 'package.json')
  if (!existsSync(pkg)) return null
  return JSON.parse(readFileSync(pkg, 'utf8')).version === version ? realpathSync(dir) : null
}

async function fromRegistry(name, version, integrity, dest) {
  const registry = process.env.npm_config_registry || 'https://registry.npmjs.org/'
  const url = tarballUrl(registry, name, version)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!matchesIntegrity(bytes, integrity)) {
    throw new Error(`${name}@${version} from ${url} does not match pnpm-lock.yaml's integrity`)
  }
  const tmp = mkdtempSync(join(tmpdir(), 'papertie-sharp-'))
  try {
    writeFileSync(join(tmp, 'p.tgz'), bytes)
    execFileSync('tar', ['-xzf', 'p.tgz'], { cwd: tmp })
    cpSync(join(tmp, 'package'), dest, { recursive: true })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Puts sharp's packages for `platform`-`arch` in `.targets/sharp/<os>-<arch>/node_modules/` and
 * returns that folder.
 */
export async function stageSharp(platform, arch) {
  const out = join(TARGETS_DIR, `${BUILDER_OS[platform]}-${arch}`)
  rmSync(out, { recursive: true, force: true })
  const sharp = installedSharp()
  const lockfile = readFileSync(join(root, '..', '..', 'pnpm-lock.yaml'), 'utf8')
  for (const { name, version } of sharpPackages(sharp.pkg.optionalDependencies, platform, arch)) {
    const dest = join(out, 'node_modules', name)
    mkdirSync(dirname(dest), { recursive: true })
    const local = installed(sharp.dir, name, version)
    if (local) cpSync(local, dest, { recursive: true, dereference: true })
    else await fromRegistry(name, version, lockedIntegrity(lockfile, name, version), dest)
    console.log(`  sharp for ${platform}-${arch}: ${name}@${version}${local ? '' : ' (registry)'}`)
  }
  return out
}
