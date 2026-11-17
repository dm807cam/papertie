import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type BoardState, isId, type LoadIssue, withoutAssets } from '@papertie/core'
import { ASSET_SIZES } from '../limits'
import { fsyncDir, isEnoent } from './durable'

/**
 * A board's image files: `assets/<assetId>/<size>.webp` beside `board.jsonl`, one directory per
 * asset (ADR-0001). Only id-shaped directory names are ever looked into.
 */
const assetsDir = (dir: string) => join(dir, 'assets')

const VARIANTS: ReadonlySet<string> = new Set(ASSET_SIZES.map((s) => `${s}.webp`))

async function entries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (e) {
    if (isEnoent(e)) return []
    throw e
  }
}

/** The ids of the asset directories of the board in `dir`. */
export async function assetDirIds(dir: string): Promise<string[]> {
  return (await entries(assetsDir(dir)))
    .filter((e) => e.isDirectory() && isId(e.name, 'asset'))
    .map((e) => e.name)
}

/**
 * The ids among `ids` whose files are missing: no directory, or one holding none of the
 * variants (a partial set still serves what it has).
 */
export async function missingAssetFiles(dir: string, ids: Iterable<string>): Promise<Set<string>> {
  const present = new Set(await assetDirIds(dir))
  const missing = new Set<string>()
  for (const id of ids) {
    if (!present.has(id)) {
      missing.add(id)
      continue
    }
    const files = await entries(join(assetsDir(dir), id))
    if (!files.some((f) => f.isFile() && VARIANTS.has(f.name))) missing.add(id)
  }
  return missing
}

/**
 * `state` without the asset records whose files are missing from the board in `dir`, and the
 * notes that showed them without their image (`withoutAssets`): what a restore (and an import)
 * keeps, so no record names a photo nothing can serve. The issues go to `repairs.jsonl`.
 */
export async function dropDanglingAssets(
  dir: string,
  state: BoardState,
): Promise<{ state: BoardState; issues: LoadIssue[] }> {
  if (state.assets.size === 0) return { state, issues: [] }
  return withoutAssets(state, await missingAssetFiles(dir, state.assets.keys()))
}

/** The bytes of the `.webp` files in one asset's directory (what the quota counts); 0 when it is gone. */
export async function assetBytes(path: string): Promise<number> {
  let bytes = 0
  for (const f of await entries(path)) {
    if (!f.isFile() || !f.name.endsWith('.webp')) continue
    try {
      bytes += (await stat(join(path, f.name))).size
    } catch (e) {
      if (!isEnoent(e)) throw e
    }
  }
  return bytes
}

/**
 * Delete `assets/<id>/` of the board in `dir` and fsync `assets/`. Resolves to the bytes of the
 * `.webp` files it held (what the quota counts); 0 when it was already gone.
 */
export async function removeAssetFiles(dir: string, id: string): Promise<number> {
  if (!isId(id, 'asset')) throw new Error('not an asset id')
  const path = join(assetsDir(dir), id)
  const bytes = await assetBytes(path)
  await rm(path, { recursive: true, force: true })
  await fsyncDir(assetsDir(dir))
  return bytes
}

/**
 * Move every `<assetId>/` directory under `from` (an import's staged photos) into the `assets/`
 * of the board in `dir`, then fsync both. Each is one rename on the same file system; an id the
 * board already has is refused (fresh ids never collide). Nothing else under `from` is touched.
 */
export async function moveAssetDirs(from: string, dir: string): Promise<number> {
  const to = assetsDir(dir)
  await mkdir(to, { recursive: true, mode: 0o700 })
  const present = new Set(await assetDirIds(dir))
  let moved = 0
  for (const e of await entries(from)) {
    if (!e.isDirectory() || !isId(e.name, 'asset')) continue
    if (present.has(e.name)) throw new Error('asset id taken')
    await rename(join(from, e.name), join(to, e.name))
    moved++
  }
  if (moved > 0) {
    await fsyncDir(to)
    await fsyncDir(from)
  }
  await fsyncDir(dir)
  return moved
}
