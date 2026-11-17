import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import type { AppDeps } from '../../src/app'
import { type Clock, systemClock } from '../../src/clock'
import type { ServerConfig } from '../../src/config'
import { openApp } from '../../src/host'
import type { AppEnv } from '../../src/http/env'
import { createLogger } from '../../src/log'
import type { AssetSweeper } from '../../src/store/assetSweeper'
import { type Faults, noFaults } from '../../src/store/faults'

/*
 * Papertie's app behind a port on 127.0.0.1, for the tests: they ask it over HTTP (raw sockets, a
 * child process to kill). Papertie itself opens no port: the desktop host hands the same app its
 * requests in-process (`createHostApp`).
 */

export interface RunningServer {
  url: string
  port: number
  deps: AppDeps
  /** Runs each board's asset sweep (tests wait for it with `settled`). */
  assets: AssetSweeper
  close(): Promise<void>
}

export interface StartOptions {
  clock?: Clock
  logSink?: (line: string) => void
  /** The fault seam: a named point that throws in-process, or kills the process (`faultsFromEnv`). */
  faults?: Faults
}

const HOST = '127.0.0.1'

/** On any free port. */
function listen(
  fetch: (req: Request, env: unknown) => Response | Promise<Response>,
): Promise<{ server: Server; address: AddressInfo }> {
  return new Promise((resolve, reject) => {
    // Plain HTTP options make this an http.Server; the library's return type is a wider union.
    const s = serve({ fetch, port: 0, hostname: HOST }, (info) =>
      resolve({ server: s, address: info }),
    ) as Server
    s.once('error', reject)
  })
}

function closeHttp(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
    server.closeAllConnections()
  })
}

/** The app on `config`, behind a port; the bound origin is trusted for writes beside the app's. */
export async function startServer(
  config: ServerConfig,
  opts: StartOptions = {},
): Promise<RunningServer> {
  // Listen first: the origin is known only once bound.
  let app: Hono<AppEnv> | null = null
  const { server, address } = await listen((req, env) =>
    app ? app.fetch(req, env) : new Response(null, { status: 503 }),
  )
  const url = `http://${HOST}:${address.port}`
  try {
    const cfg = { ...config, trustedOrigins: [...config.trustedOrigins, url] }
    const log = createLogger(opts.logSink ?? ((line) => process.stdout.write(`${line}\n`)))
    const opened = await openApp(cfg, {
      clock: opts.clock ?? systemClock,
      log,
      faults: opts.faults ?? noFaults,
    })
    app = opened.app
    return {
      url,
      port: address.port,
      deps: opened.deps,
      assets: opened.assets,
      close: () => opened.services.close(() => closeHttp(server)),
    }
  } catch (e) {
    await closeHttp(server).catch(() => {})
    throw e
  }
}
