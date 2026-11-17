import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../http/env'
import type { Logger } from '../log'

/**
 * Logs `{method, route, status, ms}` once the response exists. `route` is the matched route
 * template (`/api/boards/:id`), never the raw path, so ids and query strings stay out of logs;
 * requests no route handled log `(unmatched)`.
 */
export function requestLog(log: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = performance.now()
    await next()
    log.info('request', {
      method: c.req.method,
      route: c.get('unmatched') ? '(unmatched)' : c.req.routePath,
      status: c.res.status,
      ms: Math.round(performance.now() - start),
    })
  }
}
