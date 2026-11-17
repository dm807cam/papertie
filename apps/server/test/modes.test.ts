import { mkdir, mkdtemp, chmod as realChmod, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestServer, type TestServer } from './helpers/harness'

/**
 * A data dir loosened since it was made is repaired at start, best effort: the data, `users/` and
 * `trash/` directories 0700. A mode that cannot be set is a count-only warning, never a refusal.
 */

/** Paths whose chmod fails (EPERM), for the warning's case. */
const refuse = new Set<string>()
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    chmod: async (
      path: Parameters<typeof real.chmod>[0],
      mode: Parameters<typeof real.chmod>[1],
    ) => {
      if (refuse.has(String(path))) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      return real.chmod(path, mode)
    },
  }
})

const roots: string[] = []
let server: TestServer | null = null
afterEach(async () => {
  refuse.clear()
  await server?.close()
  server = null
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

/** A data directory loosened since: everything readable by all. */
async function looseInstall(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'papertie-modes-'))
  roots.push(root)
  const data = join(root, 'data')
  for (const d of [data, join(data, 'users'), join(data, 'trash')]) {
    await mkdir(d, { recursive: true })
    await realChmod(d, 0o755)
  }
  return data
}

const modeOf = async (p: string) => (await stat(p)).mode & 0o777

describe('modes at start', () => {
  it('a data dir with 0755 directories is repaired', async () => {
    const data = await looseInstall()
    server = await startTestServer({ dataDir: data })
    for (const d of ['', 'users', 'trash']) expect(await modeOf(join(data, d)), d).toBe(0o700)
    expect(server.logs.join('\n')).not.toContain('modes not repaired')
  })

  it('a mode that cannot be set is a count-only warning; the server starts', async () => {
    const data = await looseInstall()
    refuse.add(join(data, 'trash'))
    refuse.add(join(data, 'users'))
    server = await startTestServer({ dataDir: data })
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200)
    expect(server.logs.map((l) => JSON.parse(l))).toContainEqual({
      level: 'warn',
      msg: 'modes not repaired',
      count: 2,
    })
    expect(await modeOf(data)).toBe(0o700)
  })
})
