import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `clearMovedList` once its `moved.json` is
 * unlinked. A directory fsync that fails after the unlink is no reason to report the list as left
 * (the import's "moved list left" error): the file is gone, and a later start that saw it again
 * would find the photos named by the board and keep them.
 */

const failing = new Set<string>()
vi.mock('../src/store/durable', async (original) => {
  const real = await original<typeof import('../src/store/durable')>()
  return {
    ...real,
    fsyncDir: async (dir: string) => {
      if (failing.has(dir)) throw Object.assign(new Error('EIO'), { code: 'EIO' })
      return real.fsyncDir(dir)
    },
  }
})

const { clearMovedList } = await import('../src/store/importBoard')

const roots: string[] = []
afterEach(async () => {
  failing.clear()
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function importDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'papertie-moved-'))
  roots.push(dir)
  await writeFile(join(dir, 'moved.json'), '{"ids":[],"sha256":""}\n')
  return dir
}

describe('clearMovedList', () => {
  it('is true once moved.json is unlinked, even when the directory fsync after it fails', async () => {
    const dir = await importDir()
    failing.add(dir)
    expect(await clearMovedList(dir)).toBe(true)
    expect(existsSync(join(dir, 'moved.json'))).toBe(false)
  })

  it('is true when there is nothing to clear, and when the unlink works', async () => {
    const dir = await importDir()
    expect(await clearMovedList(dir)).toBe(true)
    expect(await clearMovedList(dir)).toBe(true)
  })

  it('is false only when the file can neither be removed nor emptied', async () => {
    // A `moved.json` that is a directory: unlink fails (EPERM/EISDIR), and so does opening it r+.
    const dir = await mkdtemp(join(tmpdir(), 'papertie-moved-'))
    roots.push(dir)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'moved.json'))
    expect(await clearMovedList(dir)).toBe(false)
  })
})
