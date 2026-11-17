import { renameSync } from 'node:fs'
import { copyFile, open, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FaultPoint, Faults } from './faults'

export interface FileStamp {
  ino: number
  size: number
  mtimeMs: number
}

const FILE_MODE = 0o600

/** The part of FileHandle that writeAll needs (lets tests force short writes). */
export interface Writable {
  write(buf: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>
}

/** Write bytes[from, to) completely; `FileHandle.write` may write fewer bytes than asked. */
export async function writeAll(
  fh: Writable,
  bytes: Uint8Array,
  from: number,
  to: number,
): Promise<void> {
  let pos = from
  while (pos < to) {
    const { bytesWritten } = await fh.write(bytes, pos, to - pos)
    if (bytesWritten <= 0) throw new Error('write made no progress')
    pos += bytesWritten
  }
}

/** Flush a directory's entries (new names, renames, links) to disk. */
export async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r')
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/** A file or directory that is not there. */
export const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'

export async function stampOf(path: string): Promise<FileStamp | null> {
  try {
    const s = await stat(path)
    return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs }
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
}

/**
 * What a durable write is for. Per-step fault points fire only for snapshots; the others have
 * none (the asset pipeline fires `asset:after-files` itself).
 */
export type WriteKind = 'snapshot' | 'asset' | 'backup' | 'local-user'

/**
 * Atomic replace: write `<path>.tmp`, fsync it, rename over `path`, fsync the directory. A crash
 * leaves either the old file or the new one, never a mix.
 */
export async function writeFileDurable(
  path: string,
  data: string | Uint8Array,
  faults: Faults,
  kind: WriteKind,
): Promise<FileStamp> {
  const tmp = `${path}.tmp`
  await writeTmpDurable(tmp, [data], faults, kind)
  return renameDurable(tmp, path, faults, kind)
}

const hitFor = (faults: Faults, kind: WriteKind) => (step: string) => {
  if (kind === 'snapshot') faults.hit(`snapshot:${step}` as FaultPoint)
}

/**
 * The first half of an atomic replace: `parts`, in order, written to `tmp` and fsynced. A snapshot
 * fires `snapshot:partial-tmp` once exactly half of the bytes are written. `bytes`, their UTF-8
 * size, spares measuring large text in one go when the caller knows it.
 */
export async function writeTmpDurable(
  tmp: string,
  parts: ReadonlyArray<string | Uint8Array>,
  faults: Faults,
  kind: WriteKind,
  bytes?: number,
): Promise<void> {
  const hit = hitFor(faults, kind)
  let total = bytes ?? 0
  if (bytes === undefined) {
    for (const p of parts) total += typeof p === 'string' ? Buffer.byteLength(p, 'utf8') : p.length
  }
  const half = Math.floor(total / 2)
  const fh = await open(tmp, 'w', FILE_MODE)
  try {
    let written = 0
    let halfway = false
    for (const p of parts) {
      const buf = typeof p === 'string' ? Buffer.from(p, 'utf8') : p
      let from = 0
      if (!halfway && written + buf.length >= half) {
        from = half - written
        await writeAll(fh, buf, 0, from)
        halfway = true
        hit('partial-tmp')
      }
      await writeAll(fh, buf, from, buf.length)
      written += buf.length
    }
    if (!halfway) hit('partial-tmp')
    hit('after-tmp-write')
    await fh.sync()
    hit('after-tmp-fsync')
  } finally {
    await fh.close()
  }
}

/**
 * The second half of an atomic replace: rename `tmp` over `path`, then fsync the directory.
 * `syncRename` renames before this function first yields, so a caller's synchronous check just
 * before the call is the last thing that runs before the rename.
 */
export async function renameDurable(
  tmp: string,
  path: string,
  faults: Faults,
  kind: WriteKind,
  syncRename = false,
): Promise<FileStamp> {
  const hit = hitFor(faults, kind)
  if (syncRename) renameSync(tmp, path)
  else await rename(tmp, path)
  hit('after-rename')
  await fsyncDir(dirname(path))
  hit('after-dir-fsync')
  const stamp = await stampOf(path)
  if (!stamp) throw new Error('written file vanished')
  return stamp
}

/**
 * `src`, byte for byte, copied to `tmp` and fsynced: a file of its own (never a hard link, which
 * would change whenever `src` is written in place).
 */
export async function copyTmpDurable(src: string, tmp: string): Promise<void> {
  await copyFile(src, tmp)
  const fh = await open(tmp, 'r+')
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/** An Error with `code: 'EEXIST'`, as `open(..., 'wx')` would throw. */
const existsError = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`EEXIST: file already exists, ${path}`), { code: 'EEXIST', path })

/**
 * A durable, independent copy of `src` at `dest`: `copyTmpDurable` to `<dest>.tmp`, rename, fsync
 * the directory. A crash leaves no partial file under `dest`. Fails with EEXIST, touching
 * nothing, if `dest` exists. Callers hold the board's mutex, so no other copy writes `dest` or
 * its tmp meanwhile; the one write outside the mutex, a compaction's hourly backup, uses a tmp
 * name of its own (`COMPACT_BACKUP_TMP`).
 */
export async function copyDurable(src: string, dest: string): Promise<void> {
  if ((await stampOf(dest)) !== null) throw existsError(dest)
  const tmp = `${dest}.tmp`
  try {
    await copyTmpDurable(src, tmp)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
  await rename(tmp, dest)
  await fsyncDir(dirname(dest))
}

/** Append `line` plus a newline and fsync; fsyncs the directory too when the file is new. */
export async function appendLineDurable(path: string, line: string): Promise<void> {
  const existed = (await stampOf(path)) !== null
  const fh = await open(path, 'a', FILE_MODE)
  try {
    const bytes = Buffer.from(`${line}\n`, 'utf8')
    await writeAll(fh, bytes, 0, bytes.length)
    await fh.sync()
  } finally {
    await fh.close()
  }
  if (!existed) await fsyncDir(dirname(path))
}
