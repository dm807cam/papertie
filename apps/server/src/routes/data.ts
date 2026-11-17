import { rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Hono } from 'hono'
import type { QuotaTracker } from '../assets/quota'
import type { ServerConfig } from '../config'
import type { AppEnv } from '../http/env'
import { ApiError } from '../http/errors'
import { readJson } from '../http/json'
import type { Logger } from '../log'
import { bodyLimit } from '../middleware/limits'
import type { BoardStore } from '../store/boardStore'
import { fsyncDir, isEnoent } from '../store/durable'
import { trashDir, userDir } from '../store/paths'

/** What "Delete all data" asks to be typed, compared trimmed and in any case. */
export const DELETE_ALL_WORD = 'delete'

/** The name of the empty board "Delete all data" leaves, as the app names a first board. */
const FRESH_BOARD_NAME = 'My board'

export interface DataRouteDeps {
  config: ServerConfig
  log: Logger
  store: BoardStore
  quota: QuotaTracker
  userId: string
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    (e: unknown) => {
      if (isEnoent(e)) return false
      throw e
    },
  )

/**
 * Removes everything of the user's (every board, with its photos, books and backups) and leaves
 * one empty board, the user the same. The user's boards are tombstoned first (no load, write or upload of theirs meanwhile; running ones awaited, streams
 * closed), then their directory is renamed into `trash/` (both parents fsynced) and removed. Once
 * the rename is durable the deletion stands: a crash after it is finished at the next start
 * (`sweepTrash` in `user.ts`); one before it leaves everything as it was.
 */
export async function deleteAllData(deps: DataRouteDeps): Promise<void> {
  const { config, log, store, quota, userId } = deps
  const home = userDir(config.dataDir, userId)
  const trash = trashDir(config.dataDir)
  const target = join(trash, userId)
  await store.beginDeletion(userId)
  try {
    // A leftover of an earlier attempt is removed first (trash is never restored).
    await rm(target, { recursive: true, force: true })
    if (await exists(home)) {
      await rename(home, target)
      await fsyncDir(join(config.dataDir, 'users'))
      await fsyncDir(trash)
    }
  } catch (e) {
    store.cancelDeletion(userId)
    throw e
  }
  try {
    await rm(target, { recursive: true, force: true })
    await fsyncDir(trash)
  } catch (e) {
    // Moved aside already: the next start removes it.
    log.warn('data cleanup failed', { kind: e instanceof Error ? e.name : 'unknown' })
  }
  quota.forget(userId)
  store.cancelDeletion(userId)
  await store.createBoard(userId, FRESH_BOARD_NAME)
}

/**
 * `POST /api/data/delete` (`{confirm}`: {@link DELETE_ALL_WORD}, typed). One deletion at a time.
 */
export function mountDataRoutes(deps: DataRouteDeps): (app: Hono<AppEnv>) => void {
  let deleting: Promise<void> = Promise.resolve()
  return (app) => {
    app.post('/api/data/delete', bodyLimit(deps.config.limits.jsonBodyBytes), async (c) => {
      const { confirm } = await readJson(c)
      if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== DELETE_ALL_WORD) {
        throw new ApiError(400, 'invalid')
      }
      const run = deleting.then(() => deleteAllData(deps))
      deleting = run.catch(() => {})
      await run
      return c.json({ ok: true })
    })
  }
}
