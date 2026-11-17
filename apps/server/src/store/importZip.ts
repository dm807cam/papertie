import { type Entry, openPromise, type ZipFile } from 'yauzl'
import { capped, IMPORT_LIMITS, ImportInvalid, readAll } from './importErrors'

/**
 * A `.papertie` archive, read without trusting it: the central directory is checked whole before any
 * entry is read, and each entry is read as a stream with a running byte cap. Names are compared
 * byte for byte and never used as paths.
 */

const ASSET_ENTRY = /^assets\/(asset_[0-9A-HJKMNP-TV-Z]{26})\.webp$/

export interface Listing {
  manifest: Entry
  jsonl: Entry
  /** Photo entries by the asset id in their name. */
  assets: Map<string, Entry>
}

/** The archive at `path`, its names left undecoded; anything yauzl cannot open is `not-papertie`. */
export async function openZip(path: string): Promise<ZipFile> {
  try {
    return await openPromise(path, {
      lazyEntries: true,
      autoClose: false,
      // Names are checked here, byte for byte, against the three kinds accepted.
      decodeStrings: false,
      validateEntrySizes: true,
    })
  } catch {
    throw new ImportInvalid('not-papertie')
  }
}

/** yauzl's refusals are plain errors; a broken deflate stream is zlib's `Z_*`. */
export function isZipError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code.startsWith('Z_') : e.constructor === Error
}

/**
 * Every entry of the central directory, checked before anything is read: only `manifest.json`,
 * `board.jsonl` and `assets/<assetId>.webp`, once each, regular files, unencrypted, stored or
 * deflated, within their size caps and at most 100:1.
 */
export async function list(zip: ZipFile): Promise<Listing> {
  if (zip.entryCount > IMPORT_LIMITS.maxEntries) throw new ImportInvalid('too-many-entries')
  let manifest: Entry | null = null
  let jsonl: Entry | null = null
  const assets = new Map<string, Entry>()
  for await (const entry of zip.eachEntry()) {
    const name = entry.fileNameRaw.toString('latin1')
    const unixType = (entry.externalFileAttributes >>> 16) & 0o170000
    // A directory, a symlink or anything else that is not a plain file (0 when no Unix mode).
    if (unixType !== 0 && unixType !== 0o100000) throw new ImportInvalid('entry-type')
    if (entry.isEncrypted() || !entry.canDecodeFileData()) throw new ImportInvalid('entry-type')
    const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize)
    if (ratio > IMPORT_LIMITS.maxRatio) throw new ImportInvalid('compression-ratio')
    const asset = ASSET_ENTRY.exec(name)
    if (name === 'manifest.json') {
      if (manifest) throw new ImportInvalid('duplicate-entry')
      if (entry.uncompressedSize > IMPORT_LIMITS.manifestBytes) throw new ImportInvalid('too-large')
      manifest = entry
    } else if (name === 'board.jsonl') {
      if (jsonl) throw new ImportInvalid('duplicate-entry')
      if (entry.uncompressedSize > IMPORT_LIMITS.jsonlBytes) throw new ImportInvalid('too-large')
      jsonl = entry
    } else if (asset) {
      const id = asset[1] as string
      if (assets.has(id)) throw new ImportInvalid('duplicate-entry')
      if (entry.uncompressedSize > IMPORT_LIMITS.assetBytes) {
        throw new ImportInvalid('asset-too-large')
      }
      assets.set(id, entry)
    } else {
      throw new ImportInvalid('entry-name')
    }
  }
  if (!manifest || !jsonl) throw new ImportInvalid('not-papertie')
  return { manifest, jsonl, assets }
}

export async function readManifest(zip: ZipFile, entry: Entry): Promise<void> {
  const bytes = await readAll(entryStream(zip, entry, IMPORT_LIMITS.manifestBytes))
  let m: unknown
  try {
    m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ImportInvalid('not-papertie')
  }
  const { format, version } = (m ?? {}) as { format?: unknown; version?: unknown }
  if (typeof m !== 'object' || m === null || format !== 'papertie') {
    throw new ImportInvalid('not-papertie')
  }
  if (version !== 1) throw new ImportInvalid('unsupported-version')
}

/** An entry's bytes as a stream, cut off with `too-large` past `cap` or its headers' size. */
export async function* entryStream(
  zip: ZipFile,
  entry: Entry,
  cap: number,
): AsyncGenerator<Buffer> {
  const limit = Math.min(cap, entry.uncompressedSize, entry.compressedSize * IMPORT_LIMITS.maxRatio)
  yield* capped(await zip.openReadStreamPromise(entry), limit, 'too-large')
}
