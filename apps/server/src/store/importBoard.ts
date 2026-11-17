import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Asset,
  type Block,
  type BoardState,
  type Book,
  booksNamingOnly,
  figureAsCaption,
  figureAsCaptionMessage,
  isId,
  type LoadIssue,
  type Note,
  newId,
  stateBuilder,
} from '@papertie/core'
import type { Entry, ZipFile } from 'yauzl'
import { ImageError, processImage, sniffImage } from '../assets/pipeline'
import type { QuotaTracker } from '../assets/quota'
import { ASSET_SIZES } from '../limits'
import type { Logger } from '../log'
import { assetBytes } from './assetFiles'
import { namedInBackups } from './assetSweep'
import { CHECK, SLICE_MS, Slicer } from './compact'
import { fsyncDir, isEnoent, writeFileDurable } from './durable'
import { noFaults } from './faults'
import {
  capped,
  IMPORT_LIMITS,
  ImportAborted,
  ImportInvalid,
  ImportQuota,
  ImportStagingFull,
  readAll,
} from './importErrors'
import { type ReadBoard, readBoardLines } from './importLines'
import { entryStream, isZipError, list, openZip, readManifest } from './importZip'
import { JOURNAL_FILE } from './journal'

export {
  IMPORT_LIMITS,
  ImportAborted,
  ImportInvalid,
  ImportQuota,
  ImportStagingFull,
} from './importErrors'

/**
 * A `.papertie` (or plain `.jsonl`) file made into a board that can replace one: stage → validate → re-encode → remap. The archive is read by `importZip.ts`, the
 * board's lines by `importLines.ts`; this file stages photos, builds the state and clears
 * leftovers. Nothing here touches the board itself; `stageImport` works only in its own
 * `import-<ulid>/` directory beside the board, and `BoardStore.replaceBoard` installs what it
 * made. Validation is strict: a malformed line, a failed schema check, an `eof` checksum
 * mismatch or a broken invariant rejects the whole file; only unknown record types are skipped
 * (and counted).
 *
 * The archive is never trusted: only the three kinds of entry name are accepted, sizes are capped
 * while each entry is read (its headers' sizes only decide what to refuse early), and nothing in
 * it is ever written to disk under its own name. Nothing from it reaches the logs.
 */

/** An import's staging directory, beside `board.jsonl`. */
export const IMPORT_DIR_RE = /^import-[0-9A-HJKMNP-TV-Z]{26}$/
export const IMPORT_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

export const importDirOf = (boardDir: string, importId: string) => {
  if (!IMPORT_ID_RE.test(importId)) throw new Error('not an import id')
  return join(boardDir, `import-${importId}`)
}

/** A fresh import id: a bare ULID. */
export const newImportId = (ms: number) => newId('tab', ms).slice('tab_'.length)

export interface ImportPreview {
  /** The file's board name, which the board takes. */
  name: string
  notes: number
  yarns: number
  /** Photos re-encoded and staged. */
  assets: number
  /** The file's books and their blocks (the board and its books are one unit). */
  books: number
  blocks: number
  /** What the staged photos take of the quota (every stored variant). */
  bytes: number
  /** Lines of a record type this build does not know, skipped. */
  skippedRecords: number
}

export interface StagedImport {
  preview: ImportPreview
  /** The file's records: photos under their new ids, no `rev`, the file's board record. */
  state: BoardState
  /** Asset records with no photo in the file, dropped, and the notes that lost their image. */
  issues: LoadIssue[]
  /** `<assetId>/<size>.webp` for every staged photo. */
  assetsDir: string
  /** Quota bytes reserved for the staged photos (`QuotaTracker.tryAdd`). */
  reserved: number
}

export interface StageOptions {
  userId: string
  quota: QuotaTracker
  quotaBytes: number
  /** Asset ids and their `createdAt` are taken at this time. */
  now: () => Date
  /** Calls the import off (a newer one of the board, the account's deletion): `ImportAborted`. */
  signal?: AbortSignal
  /**
   * Told the bytes of each photo's files before they are written, so the server's staging room
   * can count them; throws (`ImportStagingFull`) when there is none.
   */
  hold?: (bytes: number) => void
}

const isZip = (head: Buffer) =>
  head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5)

async function headOf(path: string): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(4)
    const { bytesRead } = await fh.read(buf, 0, 4, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * Stage the uploaded file at `upload` into `dir` (the import's own directory, which the caller
 * removes on any failure): validate it, re-encode its photos into `dir/assets/<newId>/` and build
 * the state to install. Quota for the photos is reserved one photo at a time, each before its
 * files are written, and released again here if staging fails.
 */
export async function stageImport(
  upload: string,
  dir: string,
  opts: StageOptions,
): Promise<StagedImport> {
  const assetsDir = join(dir, 'assets')
  const reservation = { bytes: 0 }
  try {
    const staged = isZip(await headOf(upload))
      ? await stageZip(upload, assetsDir, opts, reservation)
      : await stageJsonl(upload, opts)
    return {
      ...staged,
      // Every stored variant of every staged photo: what the import takes of the quota.
      preview: { ...staged.preview, bytes: reservation.bytes },
      assetsDir,
      reserved: reservation.bytes,
    }
  } catch (e) {
    if (reservation.bytes > 0) opts.quota.release(opts.userId, reservation.bytes)
    throw e
  }
}

type Staged = Omit<StagedImport, 'assetsDir' | 'reserved'>

async function stageJsonl(upload: string, opts: StageOptions): Promise<Staged> {
  const { signal } = opts
  const stream = createReadStream(upload, { highWaterMark: 65_536 })
  const read = await readBoardLines(capped(stream, IMPORT_LIMITS.jsonlBytes, 'too-large'), signal)
  const shown = read.imageNotes[0] ?? read.imageBlocks[0]
  // A plain JSONL file carries no photos: one that shows any (a note's, a figure's) cannot be
  // imported whole.
  if (shown) throw new ImportInvalid('needs-photos', shown.line)
  return build(read, new Map(), opts.now())
}

async function stageZip(
  upload: string,
  assetsDir: string,
  opts: StageOptions,
  reservation: { bytes: number },
): Promise<Staged> {
  const zip: ZipFile = await openZip(upload)
  try {
    const listing = await list(zip)
    await readManifest(zip, listing.manifest)
    const read = await readBoardLines(
      entryStream(zip, listing.jsonl, IMPORT_LIMITS.jsonlBytes),
      opts.signal,
    )

    // The photos the board's records name, and what they take (as the archive says; each is
    // capped again while it is read).
    const wanted = [...read.assets.keys()].filter((id) => listing.assets.has(id))
    const estimate = wanted.reduce(
      (n, id) => n + (listing.assets.get(id)?.uncompressedSize ?? 0),
      0,
    )
    const free = Math.max(0, opts.quotaBytes - (await opts.quota.usage(opts.userId)))
    if (estimate > free) throw new ImportQuota(estimate, free)

    const photos = new Map<string, Asset>()
    let left = estimate
    for (const oldId of wanted) {
      if (opts.signal?.aborted) throw new ImportAborted()
      const entry = listing.assets.get(oldId) as Entry
      left -= entry.uncompressedSize
      const input = await readAll(entryStream(zip, entry, IMPORT_LIMITS.assetBytes))
      photos.set(oldId, await stagePhoto(input, assetsDir, opts, reservation, left))
    }
    return build(read, photos, opts.now())
  } catch (e) {
    if (
      e instanceof ImportInvalid ||
      e instanceof ImportQuota ||
      e instanceof ImportAborted ||
      e instanceof ImportStagingFull
    ) {
      throw e
    }
    // yauzl's own refusals (a bad header, a size that does not match, a CRC that fails).
    if (isZipError(e)) throw new ImportInvalid('not-papertie')
    throw e
  } finally {
    zip.close()
  }
}

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * One photo through the upload pipeline (sniffed by its bytes, decoded, re-encoded as WebP in
 * every size), its quota reserved, then its files written durably under a fresh id. `left` is
 * the estimate of the photos still to come, for the 507's `needMb`.
 */
async function stagePhoto(
  input: Buffer,
  assetsDir: string,
  opts: StageOptions,
  reservation: { bytes: number },
  left: number,
): Promise<Asset> {
  if ((await sniffImage(input)) === null) throw new ImportInvalid('undecodable-image')
  let image: Awaited<ReturnType<typeof processImage>>
  try {
    image = await processImage(input)
  } catch (e) {
    if (e instanceof ImageError) throw new ImportInvalid('undecodable-image')
    throw e
  }
  const total = ASSET_SIZES.reduce((sum, s) => sum + image.variants[s].byteLength, 0)
  opts.hold?.(total)
  if (!(await opts.quota.tryAdd(opts.userId, total, opts.quotaBytes))) {
    const used = await opts.quota.usage(opts.userId)
    // What is reserved for this import is the import's own: it counts as needed, not as used.
    const free = Math.max(0, opts.quotaBytes - (used - reservation.bytes))
    throw new ImportQuota(reservation.bytes + total + left, free)
  }
  reservation.bytes += total
  const at = opts.now()
  const id = newId('asset', at.getTime())
  const dir = join(assetsDir, id)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const size of ASSET_SIZES) {
    await writeFileDurable(join(dir, `${size}.webp`), image.variants[size], noFaults, 'asset')
  }
  await fsyncDir(dir)
  const largest = image.variants[ASSET_SIZES[0]]
  return {
    type: 'asset',
    id,
    mime: 'image/webp',
    width: image.width,
    height: image.height,
    bytes: largest.byteLength,
    sha256: sha256Hex(largest),
    createdAt: at.toISOString(),
  }
}

// ---- the board's lines ------------------------------------------------------------------------

/**
 * The state to install: the file's board record (its `clients` dropped: marks of tabs of another
 * board, or of this one before), the photos under their new ids, and every asset record left
 * without a photo dropped with the images of the notes showing it, as `withoutAssets` does (its
 * issues, in its order: the asset records, then the notes).
 */
async function build(read: ReadBoard, photos: Map<string, Asset>, at: Date): Promise<Staged> {
  const s = await Slicer.start(SLICE_MS)
  const issues: LoadIssue[] = []
  for (const [id, { record }] of read.assets) {
    if (photos.has(id)) continue
    issues.push({
      line: 0,
      kind: 'dangling-reference',
      raw: JSON.stringify(record),
      message: `asset ${id}: its files are missing; record removed`,
    })
  }
  const notes = read.notes
  let i = 0
  for (const n of read.imageNotes) {
    const note = notes[n.index] as Note
    const photo = photos.get(n.assetId)
    if (photo && note.image) {
      notes[n.index] = { ...note, image: { ...note.image, assetId: photo.id } }
    } else {
      issues.push({
        line: 0,
        kind: 'dangling-reference',
        raw: JSON.stringify(note),
        message: `note ${note.id}: image asset ${n.assetId} is missing; image removed`,
      })
      notes[n.index] = { ...note, image: null }
    }
    if (++i % CHECK === 0 && s.due()) await s.pause()
  }
  // A figure shows its photo under the photo's new id; one whose photo is gone (no record, or its
  // files missing) is kept as the paragraph of its caption, as a restore keeps it: a figure cannot drop its image as a note does.
  const blocks = read.blocks
  const captions: Block[] = []
  for (const f of read.imageBlocks) {
    const block = blocks[f.index] as Block
    const photo = photos.get(f.assetId)
    if (photo && block.image) {
      blocks[f.index] = { ...block, image: { ...block.image, assetId: photo.id } }
    } else {
      issues.push({
        line: 0,
        kind: 'dangling-reference',
        raw: JSON.stringify(block),
        message: figureAsCaptionMessage(block),
      })
      captions.push(block)
      blocks[f.index] = figureAsCaption(block)
    }
    if (++i % CHECK === 0 && s.due()) await s.pause()
  }

  const builder = stateBuilder(
    { ...read.board, clients: {} },
    {
      assets: photos.size,
      notes: notes.length,
      yarns: read.yarns.length,
      books: read.books.length,
      blocks: read.blocks.length,
    },
  )
  builder.add(photos.values())
  // Blocks a few at a time: each goes into its book's sorted index as it comes.
  for (const [list, batch] of [
    [notes, 2048],
    [read.yarns, 2048],
    [trashedNow(read.books, at.toISOString()), 2048],
    [read.blocks, 256],
  ] as const) {
    for (let at = 0; at < list.length; at += batch) {
      builder.add(list.slice(at, at + batch))
      if (s.due()) await s.pause()
    }
  }
  const built = builder.finish()
  // A card only a caption-less figure named leaves its book's list (recomputed from the figure).
  const state = captions.length > 0 ? { ...built, books: booksNamingOnly(built, captions) } : built
  return {
    preview: {
      name: read.board.name,
      notes: state.notes.size,
      yarns: state.yarns.size,
      assets: photos.size,
      books: state.books.size,
      blocks: state.blocks.size,
      bytes: 0, // `stageImport` sets it: the quota the photos take
      skippedRecords: read.skipped,
    },
    state,
    issues,
  }
}

/**
 * `books` with each deleted one's `trashedAt` the import's own time (the server's clock): the
 * purge never trusts a time from a file, so a book deleted long ago in it gets its 30 days to be
 * put back from the import on.
 */
function trashedNow(books: readonly Book[], at: string): Book[] {
  return books.map((b) => (b.trashedAt === null ? b : { ...b, trashedAt: at }))
}

const MOVED_FILE = 'moved.json'

/**
 * `moved.json` in an import's directory: the photo directories about to move into the board, the
 * eof `sha256` of the snapshot that will name them, and `before`, the eof of the board it replaces
 * (null when that cannot be read). Written durably before the move.
 */
export async function writeMovedList(
  importDir: string,
  moved: { ids: string[]; sha256: string; before: string | null },
): Promise<void> {
  await writeFileDurable(
    join(importDir, MOVED_FILE),
    `${JSON.stringify(moved)}\n`,
    noFaults,
    'asset',
  )
}

/**
 * Take `moved.json` away once its import is installed: the photos it names are the board's now,
 * and a later start must never weigh them as leftovers. Removed durably; if that fails it is
 * emptied instead (an empty list names nothing). False when neither could be done.
 */
export async function clearMovedList(importDir: string): Promise<boolean> {
  const path = join(importDir, MOVED_FILE)
  try {
    await unlink(path)
  } catch (e) {
    if (isEnoent(e)) return true
    return emptyMovedList(path)
  }
  // Gone. Should a crash undo the unlink, the list comes back naming photos the installed board
  // names itself, which a later start keeps; a failed directory fsync is not worth an error.
  await fsyncDir(importDir).catch(() => {})
  return true
}

/** Empty `moved.json` in place (an empty list names nothing). False when that fails too. */
async function emptyMovedList(path: string): Promise<boolean> {
  try {
    const fh = await open(path, 'r+')
    try {
      await fh.truncate(0)
      await fh.sync()
    } finally {
      await fh.close()
    }
    return true
  } catch {
    return false
  }
}

const ASSET_ID_RE = /asset_[0-9A-HJKMNP-TV-Z]{26}/g
/** Chars of a chunk kept for the next, so an id cut by a chunk boundary is still found. */
const ID_OVERLAP = 64

/**
 * The ids among `ids` that the files at `paths` name anywhere (a record, an image reference, an
 * op), read as a stream with no JSON parse. A file that is not there names nothing.
 */
async function idsNamedIn(paths: string[], ids: ReadonlySet<string>): Promise<Set<string>> {
  const found = new Set<string>()
  for (const path of paths) {
    let tail = ''
    try {
      for await (const chunk of createReadStream(path, {
        encoding: 'utf8',
        highWaterMark: 65_536,
      })) {
        const text = tail + (chunk as string)
        for (const m of text.matchAll(ASSET_ID_RE)) if (ids.has(m[0])) found.add(m[0])
        tail = text.slice(-ID_OVERLAP)
      }
    } catch (e) {
      if (!isEnoent(e)) throw e
    }
  }
  return found
}

interface MovedList {
  ids: string[]
  sha256: string
  /** The replaced board's eof; null when it was not known (or the list predates it). */
  before: string | null
}

async function readMovedList(importDir: string): Promise<MovedList | null> {
  let text: string
  try {
    text = await readFile(join(importDir, MOVED_FILE), 'utf8')
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
  try {
    const m = JSON.parse(text) as { ids?: unknown; sha256?: unknown; before?: unknown }
    if (!Array.isArray(m.ids) || typeof m.sha256 !== 'string') return null
    return {
      ids: m.ids.filter((id): id is string => isId(id, 'asset')),
      sha256: m.sha256,
      before: typeof m.before === 'string' ? m.before : null,
    }
  } catch {
    return null
  }
}

/** The `sha256` of the eof record ending `board.jsonl` (its last line only), or null. */
export async function boardEofSha(boardDir: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(join(boardDir, 'board.jsonl'), 'r')
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
  try {
    const { size } = await fh.stat()
    const length = Math.min(size, 4096)
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, size - length)
    const last = buf.toString('utf8').trimEnd().split('\n').at(-1) ?? ''
    const eof = JSON.parse(last) as { type?: unknown; sha256?: unknown }
    return eof.type === 'eof' && typeof eof.sha256 === 'string' ? eof.sha256 : null
  } catch {
    return null
  } finally {
    await fh.close()
  }
}

/**
 * Remove every `import-*` directory beside every board under `dataDir`: staged imports live in
 * memory, so after a restart what is on disk of them belongs to no one. An import cut short after
 * its photos moved into the board (`moved.json`) but before its snapshot went in leaves those
 * photo directories without records: they go first, each only when the board reads, its eof is
 * not the one `moved.json` names, and neither `board.jsonl`, `journal.jsonl` nor a retained
 * backup names the photo. Run at startup, before any board loads. Resolves to the directories and photo directories
 * removed. What cannot be read or removed (a leftover, or a user or board directory that cannot
 * be listed) is left for a later start, with one count-only warning: it never stops the start.
 */
export async function removeImportDirs(
  dataDir: string,
  log?: Logger,
): Promise<{ dirs: number; photos: number }> {
  let dirs = 0
  let photos = 0
  /** Leftovers (or directories that may hold some) left for a later start. */
  let kept = 0
  /** A directory's entries; one that cannot be listed (EACCES, EIO) is left for a later start. */
  const names = async (dir: string) => {
    try {
      return await readdir(dir, { withFileTypes: true })
    } catch (e) {
      if (!isEnoent(e)) kept++
      return []
    }
  }
  const users = join(dataDir, 'users')
  for (const user of await names(users)) {
    if (!user.isDirectory() || !/^user_/.test(user.name)) continue
    const boards = join(users, user.name, 'boards')
    for (const board of await names(boards)) {
      if (!board.isDirectory() || !isId(board.name, 'board')) continue
      const boardDir = join(boards, board.name)
      for (const e of await names(boardDir)) {
        if (!IMPORT_DIR_RE.test(e.name)) continue
        const importDir = join(boardDir, e.name)
        try {
          photos += (await removeMovedPhotos(boardDir, importDir)).photos
          await rm(importDir, { recursive: true, force: true })
          dirs++
        } catch {
          // A file that cannot be read or removed (EIO, EACCES): the import's directory stays,
          // with its `moved.json`, so a later start looks again; the server starts all the same.
          // Photos a failed removal had already taken stay gone: they were unnamed leftovers.
          kept++
        }
      }
    }
  }
  if (kept > 0) log?.warn('import leftovers kept', { count: kept })
  return { dirs, photos }
}

/**
 * The photo directories an import cut short after its move left in `boardDir` without records,
 * removed (see `removeImportDirs`); resolves to how many, and the bytes of their `.webp` files.
 * Throws when a file it must read cannot be read (then nothing is removed) or a photo cannot be
 * removed (then those removed before it stay removed, uncounted, and the rest stay for a later
 * start).
 */
async function removeMovedPhotos(
  boardDir: string,
  importDir: string,
): Promise<{ photos: number; bytes: number }> {
  const moved = await readMovedList(importDir)
  // Only a board that reads, and whose snapshot is not the one the import was installing:
  // an unreadable board deletes nothing.
  const eof = moved && moved.ids.length > 0 ? await boardEofSha(boardDir) : null
  if (!moved || eof === null || eof === moved.sha256) return { photos: 0, bytes: 0 }
  // And never a photo the board names, in its snapshot or its journal, nor one a retained backup
  // names: restoring that backup must find its photos (the asset sweep's own check).
  const named = await idsNamedIn(
    [join(boardDir, 'board.jsonl'), join(boardDir, JOURNAL_FILE)],
    new Set(moved.ids),
  )
  const unnamed = new Set(moved.ids.filter((id) => !named.has(id)))
  for (const id of unnamed.size > 0 ? await namedInBackups(boardDir, unnamed) : []) {
    named.add(id)
  }
  let photos = 0
  let bytes = 0
  for (const id of moved.ids) {
    if (named.has(id)) continue
    const dir = join(boardDir, 'assets', id)
    const size = await assetBytes(dir)
    await rm(dir, { recursive: true, force: true })
    photos++
    bytes += size
  }
  if (photos > 0) await fsyncDir(join(boardDir, 'assets')).catch(() => {})
  return { photos, bytes }
}

/** What `rollBackImport` did: the photo bytes it removed, or why it left the import as it was. */
export type RollBack = { freed: number } | { left: 'unreadable' | 'changed' }

/**
 * Undo an import whose commit failed (`replaceBoard` threw) at once, as the next start would
 * (`removeImportDirs`): the photos it moved into the board that nothing names (the board, its
 * journal, a retained backup), then its directory, with the photos still staged there and its
 * `moved.json`, which so goes only after the photos it names. The caller holds the board's
 * writer. Resolves to the bytes of the `.webp` files removed (what the quota counts for them).
 *
 * Photos moved in are removed only while the board is still the one the import was replacing
 * (its eof is `moved.json`'s `before`). Otherwise nothing is removed and the directory stays,
 * `moved.json` in it, for the next start: `left: 'changed'` when the board moved on (the new
 * snapshot went in before the failure, and a restore or another import queued on the board may
 * have run since, its safety backup naming these photos), `'unreadable'` when its eof cannot be
 * read. Throws when a file cannot be read or removed; the directory then stays the same way, and
 * photos already removed stay removed, uncounted (their bytes stay on the quota until the next
 * start's scan, never the reverse).
 */
export async function rollBackImport(boardDir: string, importDir: string): Promise<RollBack> {
  const moved = await readMovedList(importDir)
  if (moved && moved.ids.length > 0) {
    const eof = await boardEofSha(boardDir)
    if (eof === null) return { left: 'unreadable' }
    if (moved.before === null || eof !== moved.before) return { left: 'changed' }
  }
  const { bytes } = await removeMovedPhotos(boardDir, importDir)
  const staged = join(importDir, 'assets')
  let left = 0
  for (const id of await readdir(staged).catch((e) => {
    if (isEnoent(e)) return [] as string[]
    throw e
  })) {
    if (isId(id, 'asset')) left += await assetBytes(join(staged, id))
  }
  await rm(importDir, { recursive: true, force: true })
  return { freed: bytes + left }
}
