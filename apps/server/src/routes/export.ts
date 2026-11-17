import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
// Node loads its web streams on the first use of `ReadableStream` (some 2 ms on a Mac): loaded
// with this module, at the server's start, never inside an export's turn (`zipBody`).
import 'node:stream/web'
import type { Handler } from 'hono'
import { ZipFile } from 'yazl'
import type { Clock } from '../clock'
import type { AppEnv } from '../http/env'
import { ApiError } from '../http/errors'
import { ASSET_SIZES } from '../limits'
import type { Logger } from '../log'
import type { BoardStore } from '../store/boardStore'
import { assetDir } from '../store/paths'
import { jsonlStream } from '../store/servedText'

export interface ExportDeps {
  dataDir: string
  clock: Clock
  store: BoardStore
  log: Logger
}

const SLUG_MAX = 60

const errCode = (e: unknown): string => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown'
}

/**
 * The board name (or a book's title) as a file name: accents folded (NFKD), lower case,
 * whitespace to `-`, then everything outside `[a-z0-9-]` dropped. `fallback` when nothing is left.
 */
export function exportSlug(name: string, fallback = 'board'): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/^-|-$/g, '')
  return slug === '' ? fallback : slug
}

export type ZipInput =
  | { name: string; bytes: Buffer }
  | { name: string; path: string; size: number }
  /** Deflated as a stream of its pieces (the board's `Jsonl`): never copied or checksummed whole. */
  | { name: string; parts: readonly Buffer[]; size: number }

/**
 * A zip of `entries` as a web stream that does nothing until it is first read: a HEAD (whose body
 * is dropped unread) or an export nobody downloads opens no file. Files are opened one at a time,
 * when their entry's turn comes, and every open one is destroyed when the download is cancelled
 * or fails. JSON entries are deflated; the WebP files are stored as they are. The board's
 * `board.jsonl` goes in piece by piece: yazl checksums (a pure-JS crc32) and deflates each 128 KiB
 * piece as it streams; given as one 43 MB buffer, the copy and the checksum held the loop for
 * about 190 ms on a Mac (some 850 ms on a Raspberry Pi).
 */
export function zipBody(entries: ZipInput[], mtime: Date, log: Logger): ReadableStream<Uint8Array> {
  const open = new Set<Readable>()
  let zip: ZipFile | null = null
  let chunks: AsyncIterator<Buffer> | null = null

  const stop = () => {
    for (const r of open) r.destroy()
    open.clear()
    zip?.outputStream.destroy()
  }

  const start = (): ZipFile => {
    const z = new ZipFile()
    z.on('error', (e: unknown) => {
      log.error('export failed', { code: errCode(e) })
      for (const r of open) r.destroy()
      z.outputStream.destroy(e instanceof Error ? e : new Error('export failed'))
    })
    for (const entry of entries) {
      if ('bytes' in entry) {
        z.addBuffer(entry.bytes, entry.name, { mtime, compress: true })
        continue
      }
      const compress = 'parts' in entry
      z.addReadStreamLazy(entry.name, { mtime, compress, size: entry.size }, (cb) => {
        const r =
          'parts' in entry
            ? Readable.from(entry.parts, { objectMode: false })
            : createReadStream(entry.path)
        open.add(r)
        r.once('close', () => open.delete(r))
        r.once('error', (e: Error) => z.emit('error', e))
        cb(null, r)
      })
    }
    z.end()
    return z
  }

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!chunks) {
          zip = start()
          chunks = zip.outputStream[Symbol.asyncIterator]() as AsyncIterator<Buffer>
        }
        try {
          const { value, done } = await chunks.next()
          if (done) controller.close()
          else controller.enqueue(new Uint8Array(value))
        } catch (e) {
          stop()
          controller.error(e)
        }
      },
      cancel: stop,
    },
    { highWaterMark: 0 },
  )
}

/**
 * `GET /api/boards/:id/export?format=jsonl|papertie` (after auth and ownership), as a download named
 * `<slug>-<YYYYMMDD>.<format>`.
 *
 * Both formats hold the board's committed `board.jsonl` text, read under the board's lock, so the
 * file is one revision, whole. `papertie` is a zip of `manifest.json`, `board.jsonl` and the 2560
 * variant of every asset in that state as `assets/<assetId>.webp` (import re-encodes anyway); an
 * asset whose file is missing is left out (and logged), and the manifest counts what is in the zip.
 */
export function exportHandler(deps: ExportDeps): Handler<AppEnv> {
  const { dataDir, clock, store, log } = deps
  return async (c) => {
    const format = c.req.query('format')
    if (format !== 'jsonl' && format !== 'papertie') throw new ApiError(400, 'invalid')
    const userId = c.var.user.id
    const boardId = c.req.param('id') ?? ''
    // The board's `board.jsonl` (`serializeBoard(state)` as buffer pieces, books and blocks with
    // it: the board and its books are one unit), shared with `GET /:id`, which serves it up to its
    // first block line: not serialized again for each export.
    const { state, jsonl } = await store.read(userId, boardId)
    const now = clock.now()
    const filename = `${exportSlug(state.board.name)}-${now.toISOString().slice(0, 10).replaceAll('-', '')}.${format}`
    const disposition = `attachment; filename="${filename}"`

    if (format === 'jsonl') {
      return c.body(jsonlStream(jsonl), 200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Length': String(jsonl.bytes),
        'Content-Disposition': disposition,
      })
    }

    const files: ZipInput[] = []
    for (const assetId of state.assets.keys()) {
      const path = join(assetDir(dataDir, userId, boardId, assetId), `${ASSET_SIZES[0]}.webp`)
      try {
        const s = await stat(path)
        if (s.isFile()) {
          files.push({ name: `assets/${assetId}.webp`, path, size: s.size })
          continue
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      log.warn('export: asset file missing', { kind: 'missing-asset' })
    }
    const manifest = {
      format: 'papertie',
      version: 1,
      exportedAt: now.toISOString(),
      boardId: state.board.id,
      name: state.board.name,
      revision: state.board.revision,
      notes: state.notes.size,
      yarns: state.yarns.size,
      // A board with books says how many, and their paragraphs (the board and its books are one
      // unit); one without is the manifest it always was.
      ...(state.books.size > 0 ? { books: state.books.size, blocks: state.blocks.size } : {}),
      assets: files.length,
    }
    const entries: ZipInput[] = [
      { name: 'manifest.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
      { name: 'board.jsonl', parts: jsonl.parts, size: jsonl.bytes },
      ...files,
    ]
    return c.body(zipBody(entries, now, log), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': disposition,
    })
  }
}
