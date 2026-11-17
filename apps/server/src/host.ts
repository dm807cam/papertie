import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { type AppDeps, createApp } from './app'
import { type Clock, systemClock } from './clock'
import { type DeepPartial, loadConfig, type ServerConfig } from './config'
import type { AppEnv } from './http/env'
import { createLogger, type Logger } from './log'
import { repairModes } from './modes'
import { type BoardServices, openBoardServices, prepareDataDir, primeHotPath } from './services'
import type { AssetSweeper } from './store/assetSweeper'
import { type Faults, noFaults } from './store/faults'
import { sweepTrash, userIdOf } from './user'

/*
 * Papertie's app on one data dir: the entry the desktop host imports (`createHostApp`). There are
 * no accounts: every request is the one user's (`user.ts`).
 */

export { APP_ORIGIN } from './config'

/** The app opened on a data dir: the app, its user, and what its host needs. */
export interface OpenedApp {
  app: Hono<AppEnv>
  /** The one user (`local-user.json` in the data dir). */
  userId: string
  deps: AppDeps
  assets: AssetSweeper
  services: BoardServices
}

/**
 * The data dir made ready (modes repaired, a cut-short "delete all data" finished), the user read
 * or made, and the board services opened behind the app.
 */
export async function openApp(
  config: ServerConfig,
  o: { clock: Clock; log: Logger; faults: Faults },
): Promise<OpenedApp> {
  primeHotPath()
  await prepareDataDir(config)
  await repairModes(config.dataDir, o.log)
  await sweepTrash(config.dataDir, o.log)
  const userId = await userIdOf(config.dataDir)
  const services = await openBoardServices({ config, ...o })
  const { store, staging, quota } = services
  const deps: AppDeps = { config, ...o, store, staging, quota, userId }
  return { app: createApp(deps), userId, deps, assets: services.assets, services }
}

export interface HostAppOptions {
  /** Where the boards live (the desktop app: `app.getPath('userData')/data`). Made if missing. */
  dataDir: string
  /** The built web app (`apps/web/dist`), served for every non-`/api` GET; null serves none. */
  webDist: string | null
  /** Where the log's JSON lines go; stdout by default. */
  logSink?: (line: string) => void
  /** Tests: a clock of their own, and settings of their own (limits, store sizes). */
  clock?: Clock
  config?: DeepPartial<ServerConfig>
}

export interface HostApp {
  /** Hand it every request: `await app.fetch(request)` answers with a `Response`. */
  app: Hono<AppEnv>
  /** The user's id. */
  userId: string
  /** Waits for writes in flight and closes the store; the data dir is quiet afterwards. */
  close(): Promise<void>
}

/**
 * The desktop host's factory: Papertie's app for the host to give its requests to
 * (`app.fetch(request)`) with no port opened. Only its own origin, `papertie://app`, is trusted for
 * writes.
 */
export async function createHostApp(opts: HostAppOptions): Promise<HostApp> {
  const config = loadConfig(opts.dataDir, {
    ...opts.config,
    webDist: opts.webDist === null ? null : resolve(opts.webDist),
  } as DeepPartial<ServerConfig>)
  const log = createLogger(opts.logSink ?? ((line) => process.stdout.write(`${line}\n`)))
  const opened = await openApp(config, {
    clock: opts.clock ?? systemClock,
    log,
    faults: noFaults,
  })
  return { app: opened.app, userId: opened.userId, close: () => opened.services.close() }
}
