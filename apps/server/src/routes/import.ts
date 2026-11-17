import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Handler } from 'hono'
import type { QuotaTracker } from '../assets/quota'
import type { Clock } from '../clock'
import type { ServerConfig } from '../config'
import type { AppEnv } from '../http/env'
import { ApiError } from '../http/errors'
import { MULTIPART_SLACK_BYTES, receiveFile } from '../http/multipartFile'
import type { Logger } from '../log'
import type { BoardStore } from '../store/boardStore'
import {
  IMPORT_ID_RE,
  IMPORT_LIMITS,
  ImportAborted,
  ImportInvalid,
  ImportQuota,
  ImportStagingFull,
  importDirOf,
  newImportId,
  type StagedImport,
  stageImport,
} from '../store/importBoard'
import { ImportBudget } from '../store/importBudget'
import { boardDir } from '../store/paths'
import type { StagingArea } from '../store/staging'

export interface ImportRouteDeps {
  config: ServerConfig
  clock: Clock
  log: Logger
  store: BoardStore
  staging: StagingArea
  quota: QuotaTracker
}

/** A staged import waits this long for its commit or cancel. */
export const IMPORT_TTL_MS = 15 * 60_000
const SWEEP_INTERVAL_MS = 60_000
const MIB = 1_048_576

interface Pending {
  importId: string
  userId: string
  boardId: string
  dir: string
  staged: StagedImport
  expiresAt: number
  /** Bytes of the server's staging room this import holds (its photos' files). */
  held: number
  /** Unregisters its account-deletion hook. */
  off: () => void
}

/** A preview being received or staged. */
interface InFlight {
  abort: AbortController
  /** Settles once it has finished and cleaned up after itself. */
  done: Promise<void>
}

const errCode = (e: unknown): string => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown'
}

const keyOf = (userId: string, boardId: string) => `${userId}/${boardId}`

/**
 * `POST /api/boards/:id/import` (the preview), `POST …/import/:importId/commit` and
 * `DELETE …/import/:importId` (after auth and ownership).
 *
 * The preview streams the upload (multipart field `file`) into `import-<ulid>/` beside the board,
 * never into memory, reading at most what is left of the photo quota plus 1 GB for the board's
 * text; `stageImport` validates it and stages its photos. A board has one import at a time:
 * a preview first stops the board's preview still in flight (its upload cancelled, its directory
 * removed) and discards the board's staged import, before it writes anything. Server-wide, what
 * every import holds on disk (uploads as they stream in, staged photos) stays within
 * `ImportBudget` (507 `staging-full`). A staged import waits in memory for 15 minutes, then it is
 * discarded (its directory removed, its quota and staging room given back); after a restart none
 * is left (`removeImportLeftovers`). An account's deletion stops its previews and discards its
 * staged imports at once. The commit goes through `BoardStore.replaceBoard`, then drops the
 * board's open op stages, as a restore does.
 */
export function importHandlers(deps: ImportRouteDeps): {
  preview: Handler<AppEnv>
  commit: Handler<AppEnv>
  cancel: Handler<AppEnv>
} {
  const { config, clock, log, store, staging, quota } = deps
  const quotaBytes = config.limits.quotaBytes
  const budget = new ImportBudget({
    capBytes: config.limits.importStagingBytes,
    dataDir: config.dataDir,
  })
  const pending = new Map<string, Pending>()
  /** The staged import of each board. */
  const byBoard = new Map<string, string>()
  /** The preview in flight of each board. */
  const inFlight = new Map<string, InFlight>()

  // The expiry sweep runs only while something is staged, and never past the store's close.
  let timer: NodeJS.Timeout | null = null
  const arm = () => {
    if (timer !== null || pending.size === 0) return
    timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS)
    timer.unref()
  }
  const disarm = () => {
    if (timer !== null && pending.size === 0) {
      clearInterval(timer)
      timer = null
    }
  }
  store.onClose(() => {
    if (timer !== null) clearInterval(timer)
    timer = null
    for (const f of inFlight.values()) f.abort.abort()
  })

  const discard = async (p: Pending, releaseQuota = true) => {
    if (pending.get(p.importId) === p) pending.delete(p.importId)
    disarm()
    p.off()
    const key = keyOf(p.userId, p.boardId)
    if (byBoard.get(key) === p.importId) byBoard.delete(key)
    // Taken before any await: a second discard of the same import (a deletion during its commit)
    // gives nothing back twice.
    const held = p.held
    p.held = 0
    const reserved = releaseQuota ? p.staged.reserved : 0
    p.staged.reserved = 0
    if (reserved > 0) quota.release(p.userId, reserved)
    budget.give(held)
    await rm(p.dir, { recursive: true, force: true }).catch((e) =>
      log.warn('import dir removal failed', { code: errCode(e) }),
    )
  }

  /**
   * A commit that failed (`replaceBoard` threw), some of its photos perhaps moved in already: they
   * go back out and its directory goes (`BoardStore.rollBackImport`), and only the bytes that
   * removed come off the quota, so the user's other staged imports keep their reservations. What
   * cannot be removed now stays, still counted, with its `moved.json`, for the next start
   * (`removeImportDirs`). The commit has already taken the import out of `pending`.
   */
  const rollBack = async (p: Pending) => {
    const held = p.held
    p.held = 0
    budget.give(held)
    // Given back below by what is removed, not by what was reserved.
    p.staged.reserved = 0
    try {
      let left: string | null = null
      await quota.credit(p.userId, async () => {
        const done = await store.rollBackImport(p.userId, p.boardId, p.dir)
        if ('left' in done) {
          left = done.left
          return 0
        }
        return done.freed
      })
      if (left !== null) log.warn('import left for the next start', { reason: left })
    } catch (e) {
      log.warn('import left for the next start', { code: errCode(e) })
    }
  }

  const sweep = async () => {
    const now = clock.now().getTime()
    const due = [...pending.values()].filter((p) => p.expiresAt <= now)
    await Promise.all(due.map((p) => discard(p)))
  }

  /** The live staged import `importId` of this board, or 404. */
  const find = async (userId: string, boardId: string, importId: string): Promise<Pending> => {
    await sweep()
    const p = IMPORT_ID_RE.test(importId) ? pending.get(importId) : undefined
    if (!p || p.userId !== userId || p.boardId !== boardId) throw new ApiError(404, 'not-found')
    return p
  }

  /** Stop the board's preview in flight (waiting until it has cleaned up) and its staged import. */
  const clearBoard = async (key: string, me: InFlight) => {
    const earlier = inFlight.get(key)
    inFlight.set(key, me)
    if (earlier) {
      earlier.abort.abort()
      await earlier.done
    }
    const staged = byBoard.get(key)
    const p = staged ? pending.get(staged) : undefined
    if (p) await discard(p)
  }

  const preview: Handler<AppEnv> = async (c) => {
    const userId = c.var.user.id
    const boardId = c.req.param('id') ?? ''
    const key = keyOf(userId, boardId)
    let settle = () => {}
    const me: InFlight = {
      abort: new AbortController(),
      done: new Promise<void>((resolve) => {
        settle = resolve
      }),
    }
    const offDeletion = store.onDeletion(userId, () => me.abort.abort())
    const importId = newImportId(clock.now().getTime())
    const dir = importDirOf(boardDir(config.dataDir, userId, boardId), importId)
    /** Bytes of the staging room this preview holds: its upload, then its photos. */
    let held = 0
    const hold = (bytes: number, fail: () => Error) => {
      if (!budget.take(bytes)) throw fail()
      held += bytes
    }
    let staged: StagedImport
    try {
      await clearBoard(key, me)
      await sweep()
      if (me.abort.signal.aborted) throw new ImportAborted()
      await budget.refresh()
      const free = Math.max(0, quotaBytes - (await quota.usage(userId)))
      const maxBody = free + IMPORT_LIMITS.jsonlBytes + MULTIPART_SLACK_BYTES
      staged = await store.whileLive(userId, async () => {
        await mkdir(dir, { mode: 0o700 })
        const upload = join(dir, 'upload')
        const bytes = await receiveFile(
          c.req.raw,
          'file',
          upload,
          maxBody,
          { freeMb: Math.floor(free / MIB) },
          {
            signal: me.abort.signal,
            onAbort: () => new ImportAborted(),
            onChunk: (n) => hold(n, () => new ImportStagingFull()),
          },
        )
        log.info('import received', { bytes })
        const s = await stageImport(upload, dir, {
          userId,
          quota,
          quotaBytes,
          now: () => clock.now(),
          signal: me.abort.signal,
          hold: (n) => hold(n, () => new ImportStagingFull()),
        })
        await rm(upload, { force: true })
        budget.give(bytes)
        held -= bytes
        return s
      })
      // Called off while its last bytes were being written: nothing of it is kept.
      if (me.abort.signal.aborted) {
        if (staged.reserved > 0) quota.release(userId, staged.reserved)
        throw new ImportAborted()
      }
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      budget.give(held)
      held = 0
      if (inFlight.get(key) === me) inFlight.delete(key)
      offDeletion()
      settle()
      if (e instanceof ImportInvalid) {
        log.info('import refused', { reason: e.reason })
        throw new ApiError(422, 'import-invalid', {
          reason: e.reason,
          ...(e.line !== undefined ? { line: e.line } : {}),
        })
      }
      if (e instanceof ImportQuota) {
        log.info('import refused', { reason: 'quota', bytes: e.needBytes })
        throw new ApiError(507, 'quota', {
          needMb: Math.ceil(e.needBytes / MIB),
          freeMb: Math.floor(e.freeBytes / MIB),
        })
      }
      if (e instanceof ImportStagingFull) {
        log.warn('import refused', { reason: 'staging-full', bytes: budget.held })
        throw new ApiError(507, 'staging-full')
      }
      if (e instanceof ImportAborted) {
        log.info('import refused', { reason: 'superseded' })
        throw new ApiError(409, 'superseded')
      }
      if (e instanceof ApiError) throw e
      log.error('import staging failed', { code: errCode(e) })
      throw e
    }
    offDeletion()

    const p: Pending = {
      importId,
      userId,
      boardId,
      dir,
      staged,
      expiresAt: clock.now().getTime() + IMPORT_TTL_MS,
      held,
      off: () => {},
    }
    // An account being deleted takes its staged imports with it.
    p.off = store.onDeletion(userId, () => void discard(p))
    pending.set(importId, p)
    byBoard.set(key, importId)
    arm()
    if (inFlight.get(key) === me) inFlight.delete(key)
    settle()
    log.info('import staged', { count: staged.preview.notes, bytes: staged.preview.bytes })
    return c.json({ preview: staged.preview, importId })
  }

  const commit: Handler<AppEnv> = async (c) => {
    const userId = c.var.user.id
    const boardId = c.req.param('id') ?? ''
    const p = await find(userId, boardId, c.req.param('importId') ?? '')
    // Taken out first: a cancel, an expiry, a newer preview or a second commit can no longer
    // reach it.
    pending.delete(p.importId)
    p.off()
    disarm()
    if (byBoard.get(keyOf(userId, boardId)) === p.importId) byBoard.delete(keyOf(userId, boardId))
    let result: Awaited<ReturnType<BoardStore['replaceBoard']>>
    try {
      result = await store.replaceBoard(
        userId,
        boardId,
        p.staged.state,
        p.staged.assetsDir,
        p.staged.issues,
      )
    } catch (e) {
      await rollBack(p)
      throw e
    }
    // The photos are the board's now, and so is their quota; their staging room is free again.
    await discard(p, false)
    staging.dropBoard(keyOf(userId, boardId))
    return c.json(result)
  }

  const cancel: Handler<AppEnv> = async (c) => {
    const p = await find(c.var.user.id, c.req.param('id') ?? '', c.req.param('importId') ?? '')
    await discard(p)
    return c.body(null, 204)
  }

  return { preview, commit, cancel }
}
