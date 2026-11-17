import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DeepPartial, loadConfig, type ServerConfig } from '../../src/config'
import type { Faults } from '../../src/store/faults'
import { USER_FILE } from '../../src/user'
import type { TestUser } from './client'
import { FakeClock } from './clock'
import { type RunningServer, startServer } from './httpServer'

/** The desktop app's own origin (its custom scheme), the one the app trusts for writes. */
export const APP_ORIGIN = 'papertie://app'

export type TestServer = RunningServer & {
  dataDir: string
  clock: FakeClock
  logs: string[]
  /** The one user (Papertie has no accounts): requests need no cookie. */
  user: TestUser
}

/**
 * The app behind a port on 127.0.0.1 (`startServer`) with a temp data dir.
 */
export async function startTestServer(
  opts: {
    config?: DeepPartial<ServerConfig>
    clock?: FakeClock
    dataDir?: string
    /** The fault seam, for a test that makes a named point throw in-process. */
    faults?: Faults
  } = {},
): Promise<TestServer> {
  // A caller-supplied dir (to restart on the same data) is the caller's to clean up.
  const ownsDir = opts.dataDir === undefined
  const dataDir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), 'papertie-test-')))
  try {
    const clock = opts.clock ?? new FakeClock()
    const logs: string[] = []
    const config = loadConfig(dataDir, opts.config)
    const running = await startServer(config, {
      clock,
      logSink: (l) => logs.push(l),
      faults: opts.faults,
    })
    const request = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      if (!headers.has('Origin')) headers.set('Origin', running.url)
      if (
        init.body !== undefined &&
        !(init.body instanceof FormData) &&
        !headers.has('Content-Type')
      ) {
        headers.set('Content-Type', 'application/json')
      }
      return fetch(`${running.url}${path}`, { redirect: 'manual', ...init, headers })
    }
    // The one user, as the server keeps it in the data dir (the board list names it too, but a
    // test may start the server over boards it cannot list).
    const { id } = JSON.parse(await readFile(join(dataDir, USER_FILE), 'utf8')) as { id: string }
    return {
      ...running,
      dataDir,
      clock,
      logs,
      user: { id, request },
      close: async () => {
        await running.close()
        if (ownsDir) await rm(dataDir, { recursive: true, force: true })
      },
    }
  } catch (e) {
    if (ownsDir) await rm(dataDir, { recursive: true, force: true })
    throw e
  }
}
