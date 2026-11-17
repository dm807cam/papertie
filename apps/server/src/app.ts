import { Hono } from 'hono'
import type { QuotaTracker } from './assets/quota'
import type { Clock } from './clock'
import type { ServerConfig } from './config'
import type { AppEnv } from './http/env'
import { onError } from './http/errors'
import type { Logger } from './log'
import { requestLog } from './middleware/logging'
import { csrfOrigin, securityHeaders } from './middleware/security'
import { assetRoutes } from './routes/assets'
import { boardRoutes } from './routes/boards'
import { mountDataRoutes } from './routes/data'
import { spaStatic } from './routes/static'
import type { BoardStore } from './store/boardStore'
import type { Faults } from './store/faults'
import type { StagingArea } from './store/staging'

/**
 * Everything the routes need. `openApp` (`host.ts`) provides them all; all but the config, clock
 * and log are optional, so in-process tests can build the bare app. The board routes need
 * `userId`, `store` and `staging`; the user's own routes, uploads and serving `quota` too.
 */
export interface AppDeps {
  config: ServerConfig
  clock: Clock
  log: Logger
  faults?: Faults
  /** The one user's id (`user.ts`): every board and asset is theirs. */
  userId?: string
  store?: BoardStore
  staging?: StagingArea
  quota?: QuotaTracker
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('log', deps.log)
    await next()
  })
  app.use('*', requestLog(deps.log))
  app.use('*', securityHeaders())
  app.use('/api/*', async (c, next) => {
    await next()
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
  })
  app.use('*', csrfOrigin(deps.config))
  app.onError(onError)
  app.notFound((c) => {
    c.set('unmatched', true)
    const path = c.req.path
    return path === '/api' || path.startsWith('/api/')
      ? c.json({ error: 'not-found' }, 404)
      : c.text('Not Found', 404)
  })

  app.get('/api/health', (c) => c.json({ ok: true }))

  const { userId, store, staging, quota } = deps
  if (userId && store && quota) {
    mountDataRoutes({ config: deps.config, log: deps.log, store, quota, userId })(app)
  }
  if (userId && store && staging) {
    app.route('/api/boards', boardRoutes({ ...deps, userId, store, staging }))
    if (quota) app.route('/api/assets', assetRoutes({ ...deps, userId, store, quota }))
  }

  // Last: only what no route answered reaches the web app (and `/api/*` never does).
  if (deps.config.webDist) app.use('*', spaStatic(deps.config.webDist))

  return app
}
