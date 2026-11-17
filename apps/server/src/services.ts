import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { primeOpSchemas } from '@papertie/core'
import { QuotaTracker } from './assets/quota'
import type { Clock } from './clock'
import type { ServerConfig } from './config'
import type { Logger } from './log'
import { AssetSweeper, retentionPass } from './store/assetSweeper'
import { BoardStore } from './store/boardStore'
import { BookPurger } from './store/bookPurge'
import { fsyncDir } from './store/durable'
import type { Faults } from './store/faults'
import { trashDir } from './store/paths'
import { StagingArea } from './store/staging'

/*
 * What the app runs on: the data dir, the board store and what works beside it (staging, the photo
 * quota, the asset sweep, the book purge, the daily retention pass). `host.ts` opens them for the
 * one user.
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Compiles what a cold process would otherwise compile inside its first commits: every op schema
 * (1–3 ms a branch on a Mac).
 */
export function primeHotPath(): void {
  primeOpSchemas()
}

/** The data dir's `users/` and `trash/` (0700), made durable. The modes are `repairModes`'. */
export async function prepareDataDir(cfg: ServerConfig): Promise<void> {
  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(cfg.dataDir, 'users'), { recursive: true, mode: 0o700 })
  mkdirSync(trashDir(cfg.dataDir), { recursive: true, mode: 0o700 })
  await fsyncDir(cfg.dataDir)
}

export interface BoardServices {
  store: BoardStore
  staging: StagingArea
  quota: QuotaTracker
  assets: AssetSweeper
  books: BookPurger
  /**
   * Stops the retention pass and staging, runs `between` (a listener's close, in the tests), then waits for
   * a pass in flight and closes the sweeps and the store, so the data dir is quiet afterwards.
   */
  close(between?: () => Promise<void>): Promise<void>
}

/**
 * The board store and its companions, after the data dir is prepared and its trash swept. The
 * retention pass runs once now (in the
 * background), then daily: each board's backups, then its assets if it is loaded
 * (`retentionPass`; the others are swept after their next load). It never overlaps itself and never
 * rejects.
 */
export async function openBoardServices(o: {
  config: ServerConfig
  clock: Clock
  log: Logger
  faults: Faults
}): Promise<BoardServices> {
  const { config: cfg, clock, log, faults } = o
  let sweeper: AssetSweeper | null = null
  let purger: BookPurger | null = null
  const boards = new BoardStore({
    dataDir: cfg.dataDir,
    clock,
    log,
    faults,
    ...cfg.store,
    maxBoardsPerUser: cfg.limits.maxBoardsPerUser,
    // A board just loaded or compacted gets its asset sweep, at most once a day.
    onBoardReady: (userId, boardId) => {
      sweeper?.boardReady(userId, boardId)
      purger?.boardReady(userId, boardId)
    },
  })
  let staging: StagingArea | null = null
  try {
    // Staged imports live in memory: what is on disk of one from before this start is no one's.
    const leftovers = await boards.removeImportLeftovers()
    if (leftovers.dirs > 0) log.info('removed import leftovers', { count: leftovers.dirs })
    if (leftovers.photos > 0)
      log.info('removed photos of a cut-short import', { count: leftovers.photos })
    staging = new StagingArea({
      clock,
      maxParts: cfg.limits.stageMaxParts,
      boardBytes: cfg.limits.stageBytesPerBoard,
      globalBytes: cfg.limits.stageBytesServer,
      ttlMs: cfg.limits.stageIdleMs,
    })
    const quota = new QuotaTracker(cfg.dataDir)
    const assets = new AssetSweeper({
      dataDir: cfg.dataDir,
      store: boards,
      log,
      quota,
      clock,
      faults,
    })
    sweeper = assets
    // Deleted books 30 days on, scheduled as the asset sweep is.
    const books = new BookPurger({ store: boards, log, clock })
    purger = books

    let sweeping: Promise<void> | null = null
    const sweep = () => {
      if (sweeping) return
      sweeping = retentionPass(cfg.dataDir, clock.now(), log, assets, books)
        .catch((e) =>
          log.warn('backup sweep failed', { kind: e instanceof Error ? e.name : 'unknown' }),
        )
        .finally(() => {
          sweeping = null
        })
    }
    sweep()
    const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
    sweepTimer.unref()

    const stage = staging
    return {
      store: boards,
      staging: stage,
      quota,
      assets,
      books,
      close: async (between) => {
        clearInterval(sweepTimer)
        stage.close()
        await between?.()
        await sweeping
        await assets.close()
        await books.close()
        await boards.close()
      },
    }
  } catch (e) {
    staging?.close()
    await sweeper?.close()
    await purger?.close()
    await boards.close().catch(() => {})
    throw e
  }
}
