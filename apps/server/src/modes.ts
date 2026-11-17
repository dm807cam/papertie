import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from './log'
import { trashDir } from './store/paths'

/**
 * Data at rest (threat model): the data, `users/` and `trash/` directories 0700, so no other
 * account on the machine can read the boards. New data dirs are created so; one loosened since is
 * repaired here at every start, best effort. A mode that cannot be set (another owner, a
 * read-only volume) is one count-only warning: the app starts all the same.
 */
export async function repairModes(dataDir: string, log: Logger): Promise<void> {
  const wanted: [string, number][] = [
    [dataDir, 0o700],
    [join(dataDir, 'users'), 0o700],
    [trashDir(dataDir), 0o700],
  ]
  let failed = 0
  for (const [path, mode] of wanted) {
    try {
      await chmod(path, mode)
    } catch (e) {
      // One that is not there needs no mode.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') failed++
    }
  }
  if (failed > 0) log.warn('modes not repaired', { count: failed })
}
