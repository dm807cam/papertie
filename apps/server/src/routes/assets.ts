import { createHash } from 'node:crypto'
import { type FileHandle, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Asset, isId, newId } from '@papertie/core'
import { type Handler, Hono, type MiddlewareHandler } from 'hono'
import { ImageError, processImage, sniffImage } from '../assets/pipeline'
import type { QuotaTracker } from '../assets/quota'
import type { Clock } from '../clock'
import type { ServerConfig } from '../config'
import type { AppEnv } from '../http/env'
import { ApiError } from '../http/errors'
import { ASSET_SIZES } from '../limits'
import { bodyLimit } from '../middleware/limits'
import { idParam } from '../middleware/owner'
import type { BoardStore } from '../store/boardStore'
import { fsyncDir, writeFileDurable } from '../store/durable'
import { type Faults, noFaults } from '../store/faults'
import { assetDir } from '../store/paths'
import { asUser } from '../user'

export interface AssetRouteDeps {
  config: ServerConfig
  clock: Clock
  /** The one user's id (`user.ts`). */
  userId: string
  store: BoardStore
  quota: QuotaTracker
  faults?: Faults
}

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * The chain behind `POST /api/boards/:id/assets` (after auth and ownership): body limit, per-user
 * rate limit, then the upload. The file's own name and MIME type are never read: the type comes
 * from its magic bytes, and the stored result is a fresh WebP set under a fresh id.
 */
export function uploadHandlers(deps: AssetRouteDeps): [MiddlewareHandler<AppEnv>, Handler<AppEnv>] {
  const { config, clock, store, quota } = deps
  const faults = deps.faults ?? noFaults
  const { quotaBytes, uploadFileBytes, uploadBodyBytes } = config.limits

  return [
    bodyLimit(uploadBodyBytes),
    async (c) => {
      const userId = c.var.user.id
      const boardId = c.req.param('id') ?? ''

      let field: unknown
      try {
        field = (await c.req.parseBody()).file
      } catch {
        throw new ApiError(400, 'invalid')
      }
      if (!(field instanceof File)) throw new ApiError(400, 'invalid')
      if (field.size > uploadFileBytes) throw new ApiError(413, 'too-large')
      if ((await quota.usage(userId)) >= quotaBytes) throw new ApiError(413, 'quota')

      const input = new Uint8Array(await field.arrayBuffer())
      if ((await sniffImage(input)) === null) throw new ApiError(415, 'unsupported-format')
      let image: Awaited<ReturnType<typeof processImage>>
      try {
        image = await processImage(input)
      } catch (e) {
        if (e instanceof ImageError) {
          throw e.code === 'unsupported-format'
            ? new ApiError(415, 'unsupported-format')
            : new ApiError(422, 'undecodable-image')
        }
        throw e
      }

      const assetId = newId('asset', clock.now().getTime())
      const total = ASSET_SIZES.reduce((sum, s) => sum + image.variants[s].byteLength, 0)
      const dir = assetDir(config.dataDir, userId, boardId, assetId)
      if (!(await quota.tryAdd(userId, total, quotaBytes))) throw new ApiError(413, 'quota')
      try {
        // Refused once the account's deletion has begun, which in turn waits for this upload, so
        // the mkdir below can never recreate `users/<id>/` after the directory moved to trash.
        return await store.whileLive(userId, async () => {
          await mkdir(dir, { mode: 0o700, recursive: true })
          for (const size of ASSET_SIZES) {
            await writeFileDurable(join(dir, `${size}.webp`), image.variants[size], faults, 'asset')
          }
          await fsyncDir(dir)
          await fsyncDir(join(dir, '..'))
          faults.hit('asset:after-files')

          const largest = image.variants[ASSET_SIZES[0]]
          const asset: Asset = {
            type: 'asset',
            id: assetId,
            mime: 'image/webp',
            width: image.width,
            height: image.height,
            bytes: largest.byteLength,
            sha256: sha256Hex(largest),
            createdAt: clock.now().toISOString(),
          }
          const ack = await store.submitServer(userId, boardId, [{ op: 'asset.add', asset }])
          return c.json({ asset, revision: ack.revision }, 201)
        })
      } catch (e) {
        quota.release(userId, total)
        await rm(dir, { recursive: true, force: true }).catch(() => {})
        throw e
      }
    },
  ]
}

const SERVE_HEADERS = {
  'Content-Type': 'image/webp',
  'Cache-Control': 'private, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline',
} as const

const isSize = (s: string) => ASSET_SIZES.some((n) => String(n) === s)

/**
 * The bytes of `assetId`'s `size` variant under any board of `userId`, or null. Read whole (a
 * variant is a few MB at most) so no file handle outlives this call: a response stream that nobody
 * drains (HEAD) would keep one open until GC, which is fatal on current Node.
 */
async function readVariant(
  dataDir: string,
  userId: string,
  assetId: string,
  size: string,
): Promise<Buffer | null> {
  let boards: string[]
  try {
    boards = await readdir(join(dataDir, 'users', userId, 'boards'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  for (const boardId of boards) {
    if (!isId(boardId, 'board')) continue
    let path: string
    try {
      path = join(assetDir(dataDir, userId, boardId, assetId), `${size}.webp`)
    } catch {
      continue
    }
    let fh: FileHandle
    try {
      fh = await open(path, 'r')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw e
    }
    try {
      if ((await fh.stat()).isFile()) return await fh.readFile()
    } finally {
      await fh.close()
    }
  }
  return null
}

/** `GET /api/assets/:id/:size`: the user's own image variants only. */
export function assetRoutes(deps: AssetRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get('/:id/:size', asUser(deps.userId), idParam('id', 'asset'), async (c) => {
    const size = c.req.param('size')
    if (!isSize(size)) throw new ApiError(404, 'not-found')
    const bytes = await readVariant(deps.config.dataDir, c.var.user.id, c.req.param('id'), size)
    if (!bytes) throw new ApiError(404, 'not-found')
    return c.body(new Uint8Array(bytes), 200, {
      ...SERVE_HEADERS,
      'Content-Length': String(bytes.byteLength),
    })
  })
  return app
}
