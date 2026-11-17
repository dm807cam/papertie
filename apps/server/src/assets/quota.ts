import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isId } from '@papertie/core'
import { KeyedMutex } from '../store/mutex'
import { userDir } from '../store/paths'

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

/** Total size of `users/<userId>/boards/*\/assets/*\/*.webp`; only id-shaped directory names are walked. */
async function scanUsage(dataDir: string, userId: string): Promise<number> {
  const boards = join(userDir(dataDir, userId), 'boards')
  let total = 0
  for (const board of await entries(boards)) {
    if (!isId(board, 'board')) continue
    const assets = join(boards, board, 'assets')
    for (const asset of await entries(assets)) {
      if (!isId(asset, 'asset')) continue
      for (const file of await entries(join(assets, asset))) {
        if (!file.endsWith('.webp')) continue
        try {
          const s = await stat(join(assets, asset, file))
          if (s.isFile()) total += s.size
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
      }
    }
  }
  return total
}

/**
 * Per-user stored image bytes. The first `usage` call for a user scans the disk; after that the
 * count is kept in memory. Every read and change for one user runs through a `KeyedMutex`, so a
 * `tryAdd` is atomic and the scan cannot interleave with one.
 */
export class QuotaTracker {
  private readonly used = new Map<string, number>()
  private readonly mutex = new KeyedMutex()

  constructor(private readonly dataDir: string) {}

  private async load(userId: string): Promise<number> {
    const known = this.used.get(userId)
    if (known !== undefined) return known
    const scanned = await scanUsage(this.dataDir, userId)
    this.used.set(userId, scanned)
    return scanned
  }

  usage(userId: string): Promise<number> {
    return this.mutex.run(userId, () => this.load(userId))
  }

  /** Reserves `bytes` when the total stays within `limit`; false (and no change) otherwise. */
  tryAdd(userId: string, bytes: number, limit: number): Promise<boolean> {
    return this.mutex.run(userId, async () => {
      const now = await this.load(userId)
      if (now + bytes > limit) return false
      this.used.set(userId, now + bytes)
      return true
    })
  }

  /**
   * Frees stored bytes: runs `free` (which deletes files and resolves to the bytes it deleted)
   * under the user's lock, then takes those bytes off the count. Under the lock, a first scan
   * cannot count files `free` is deleting and then have them taken off again. A user whose usage
   * was never loaded has nothing to take off: their first scan sees the files gone. Resolves to
   * the bytes freed. The asset sweep frees collected assets through it.
   */
  credit(userId: string, free: () => Promise<number>): Promise<number> {
    return this.mutex.run(userId, async () => {
      const bytes = await free()
      const now = this.used.get(userId)
      if (now !== undefined) this.used.set(userId, Math.max(0, now - bytes))
      return bytes
    })
  }

  /**
   * Forget the user's count (queued behind any pending change): the next `usage` scans the disk
   * again, which counts the boards' photos only, never what staged imports hold reserved. Tests
   * use it to compare the count with the disk; a failed import commit credits what it removed
   * instead (`credit`), so other imports' reservations stand.
   */
  forget(userId: string): void {
    void this.mutex.run(userId, async () => {
      this.used.delete(userId)
    })
  }

  /** Gives back bytes reserved by `tryAdd` (queued behind any pending change for the user). */
  release(userId: string, bytes: number): void {
    void this.mutex.run(userId, async () => {
      const now = this.used.get(userId)
      if (now !== undefined) this.used.set(userId, Math.max(0, now - bytes))
    })
  }
}
