import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Handler } from 'hono'
import type { AppEnv } from '../http/env'
import { ApiError } from '../http/errors'
import type { Logger } from '../log'
import { type BackupScan, listBackups, parseBackupName, scanBackup } from '../store/backups'
import type { BoardStore } from '../store/boardStore'
import { StoreError } from '../store/errors'
import { boardDir } from '../store/paths'
import type { StagingArea } from '../store/staging'

export interface BackupRow {
  /** The backup's file name: what restore takes as `:backupId`. */
  id: string
  revision: number
  takenAt: string
  /** -1 when the backup cannot be loaded. */
  notes: number
  yarns: number
  /** The books on its shelf and their words; -1 when the backup cannot be loaded. */
  books: number
  words: number
  /** The file is torn or does not match its checksum: a restore keeps what the parser recovers. */
  damaged: boolean
  bytes: number
}

export interface BackupRouteDeps {
  dataDir: string
  store: BoardStore
  staging: StagingArea
  log: Logger
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
const errCode = (e: unknown): string => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown'
}

/**
 * How many backups' counts are remembered. A backup is a file of its own, written once and renamed
 * into place, so its bytes never change and (path, inode, size) identifies them.
 */
const COUNT_CACHE_MAX = 4096

/**
 * `GET /api/boards/:id/backups` and `POST /api/boards/:id/backups/:backupId/restore` (after auth
 * and ownership). The listing is newest first; a restore goes through `BoardStore.restoreBackup`
 * (safety backup, revision above every one reached, `reset` to every stream) and then discards
 * the board's open stages, whose parts were staged against the replaced state.
 */
export function backupHandlers(deps: BackupRouteDeps): {
  list: Handler<AppEnv>
  restore: Handler<AppEnv>
} {
  const { dataDir, store, staging, log } = deps
  const counts = new Map<string, BackupScan>()

  /** `scanBackup` of the file, remembered; null when it vanished. */
  async function scanOf(path: string, ino: number, size: number): Promise<BackupScan | null> {
    const key = `${path}\u0000${ino}\u0000${size}`
    const hit = counts.get(key)
    if (hit) return hit
    let result: BackupScan
    try {
      result = scanBackup(await readFile(path, 'utf8'))
    } catch (e) {
      if (isMissing(e)) return null
      // Unreadable for now, but not remembered: the next listing tries again.
      log.warn('backup read failed', { code: errCode(e) })
      return { notes: -1, yarns: -1, books: -1, words: -1, damaged: true }
    }
    if (counts.size >= COUNT_CACHE_MAX) counts.clear()
    counts.set(key, result)
    // A clean scan is a few ms (2.6 ms for 1000 notes, 530 KiB); a damaged file's full parse is
    // tens of ms. Either way, let other requests in between files.
    await new Promise<void>((resolve) => setImmediate(resolve))
    return result
  }

  const list: Handler<AppEnv> = async (c) => {
    const dir = boardDir(dataDir, c.var.user.id, c.req.param('id') ?? '')
    let infos: Awaited<ReturnType<typeof listBackups>>
    try {
      infos = await listBackups(dir)
    } catch (e) {
      log.error('backup list failed', { code: errCode(e) })
      throw new StoreError('storage')
    }
    const backups: BackupRow[] = []
    for (const info of infos) {
      const path = join(dir, 'backups', info.file)
      let s: Stats
      try {
        s = await stat(path)
      } catch (e) {
        if (isMissing(e)) continue // pruned meanwhile
        log.error('backup list failed', { code: errCode(e) })
        throw new StoreError('storage')
      }
      if (!s.isFile()) continue
      const n = await scanOf(path, s.ino, s.size)
      if (!n) continue
      backups.push({
        id: info.file,
        revision: info.revision,
        takenAt: info.time.toISOString(),
        notes: n.notes,
        yarns: n.yarns,
        books: n.books,
        words: n.words,
        damaged: n.damaged,
        bytes: s.size,
      })
    }
    return c.json({ backups })
  }

  const restore: Handler<AppEnv> = async (c) => {
    const userId = c.var.user.id
    const boardId = c.req.param('id') ?? ''
    const file = c.req.param('backupId') ?? ''
    if (parseBackupName(file) === null) throw new ApiError(404, 'not-found')
    const result = await store.restoreBackup(userId, boardId, file)
    staging.dropBoard(`${userId}/${boardId}`)
    return c.json(result)
  }

  return { list, restore }
}
