import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyBoardState, serializeBoard } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The daily sweep prunes outside the board's mutex, so a restore's or an
 * import's `forceBackup` can place its backup and marker while a prune is reading `backups/`.
 * The prune must never take that fresh marker for an orphan. The hook runs `forceBackup` whole
 * right after the prune's first read of `backups/`, whatever that read is.
 */

const hook: { once: (() => Promise<unknown>) | null } = { once: null }
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    readdir: async (...args: Parameters<typeof real.readdir>) => {
      const out = await real.readdir(...args)
      const f = hook.once
      if (f && String(args[0]).endsWith('backups')) {
        hook.once = null
        await f()
      }
      return out
    },
  }
})

const { backupName, forceBackup, pruneBackups } = await import('../src/store/backups')
const { noFaults } = await import('../src/store/faults')

const BOARD = `board_${'Z'.repeat(26)}`
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'papertie-backups-race-'))
})
afterEach(async () => {
  hook.once = null
  await rm(dir, { recursive: true, force: true })
})

describe('pruneBackups beside a forceBackup', () => {
  it('keeps the marker of a safety backup placed while it reads backups/', async () => {
    const now = new Date('2026-10-27T12:00:00Z')
    const s = emptyBoardState(BOARD, 'b', '2026-10-27T10:00:00.000Z')
    await writeFile(
      join(dir, 'board.jsonl'),
      serializeBoard({ ...s, board: { ...s.board, revision: 7 } }),
    )
    await mkdir(join(dir, 'backups'))
    const old = backupName(new Date('2026-10-27T09:00:00Z'), 5)
    await writeFile(join(dir, 'backups', old), 'x')
    let made = ''
    hook.once = async () => {
      made = await forceBackup(dir, now, 7, noFaults)
    }
    await pruneBackups(dir, now)
    expect(made).toBe(backupName(now, 7))
    expect(existsSync(join(dir, 'backups', made))).toBe(true)
    expect(existsSync(join(dir, 'backups', `${made}.safety`))).toBe(true)
    // And a later prune with nothing interleaved still honours it.
    await pruneBackups(dir, now)
    expect(existsSync(join(dir, 'backups', `${made}.safety`))).toBe(true)
  })
})
