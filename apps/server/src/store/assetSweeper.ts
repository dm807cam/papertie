import type { QuotaTracker } from '../assets/quota'
import type { Clock } from '../clock'
import type { Logger } from '../log'
import { type AssetSweepResult, sweepAssets } from './assetSweep'
import { sweepBackups } from './backups'
import type { BoardStore } from './boardStore'
import { StoreError } from './errors'
import type { Faults } from './faults'

/**
 * A board's asset sweep runs at most once in this long. It also keeps the run that deletes a
 * photo's files a day after the run whose commit took its record off: far longer than any
 * compaction that could still install a backup taken before that commit.
 */
export const ASSET_SWEEP_SPACING_MS = 23 * 3_600_000

export interface AssetSweeperDeps {
  dataDir: string
  store: BoardStore
  log: Logger
  quota: QuotaTracker
  clock: Clock
  faults?: Faults
}

/**
 * When each board's asset sweep (`sweepAssets`) runs: on the daily pass if the board is loaded,
 * and otherwise once it is loaded or compacted (`BoardStore`'s `onBoardReady`), so the sweep never
 * loads a board itself. Each board runs at most once per `ASSET_SWEEP_SPACING_MS`, by the time of
 * its last run, kept in memory only: after a restart a board's first load sweeps it again (the
 * previous process's compactions died with it). Never more than one run per board at a time.
 */
export class AssetSweeper {
  private readonly lastRun = new Map<string, number>()
  private readonly running = new Map<string, Promise<AssetSweepResult | null>>()
  private closed = false

  constructor(private readonly deps: AssetSweeperDeps) {}

  /**
   * Sweep the board now unless it ran within the spacing, or one is running. Resolves to the
   * result (`deferred` when the board is not loaded), or null when it did not run. Never rejects:
   * a failure is logged.
   */
  sweep(userId: string, boardId: string): Promise<AssetSweepResult | null> {
    const key = `${userId}/${boardId}`
    const running = this.running.get(key)
    if (running) return running
    const now = this.deps.clock.now()
    const last = this.lastRun.get(key)
    if (this.closed || (last !== undefined && now.getTime() - last < ASSET_SWEEP_SPACING_MS)) {
      return Promise.resolve(null)
    }
    const { dataDir, store, log, quota, faults } = this.deps
    const p = sweepAssets(dataDir, userId, boardId, now, store, log, { quota, faults })
      .then((r) => {
        // A board not loaded was not swept: its next load does it.
        if (!r.deferred) this.lastRun.set(key, now.getTime())
        return r
      })
      .catch((e: unknown) => {
        this.lastRun.set(key, now.getTime())
        // A deletion in progress refuses it: the account's data is going away.
        if (!(e instanceof StoreError && e.code === 'not-found')) {
          log.warn('asset sweep failed', { kind: e instanceof Error ? e.name : 'unknown' })
        }
        return null
      })
      .finally(() => this.running.delete(key))
    this.running.set(key, p)
    return p
  }

  /** `BoardStore`'s `onBoardReady`: a board was just loaded or compacted. */
  readonly boardReady = (userId: string, boardId: string): void => {
    void this.sweep(userId, boardId)
  }

  /** Every run started so far has settled. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values())
  }

  /** Start no more runs, and wait for the ones running. */
  async close(): Promise<void> {
    this.closed = true
    await this.settled()
  }
}

/**
 * The startup and daily retention pass: each board's backups pruned (`sweepBackups`), then its
 * assets swept and its due deleted books purged (`purger`) if it is loaded. Boards that are not
 * loaded are counted and logged by count: each is swept after its next load. Never rejects for
 * one board.
 */
export async function retentionPass(
  dataDir: string,
  now: Date,
  log: Logger,
  sweeper: AssetSweeper,
  purger?: { purge(userId: string, boardId: string): Promise<unknown> },
): Promise<void> {
  let deferred = 0
  await sweepBackups(dataDir, now, log, async (userId, boardId) => {
    if ((await sweeper.sweep(userId, boardId))?.deferred) deferred++
    await purger?.purge(userId, boardId)
  })
  if (deferred > 0) log.info('asset sweep deferred', { count: deferred })
}
