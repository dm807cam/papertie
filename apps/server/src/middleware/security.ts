import type { MiddlewareHandler } from 'hono'
import type { ServerConfig } from '../config'
import type { AppEnv } from '../http/env'
import { ApiError } from '../http/errors'

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

/**
 * Sets the fixed security headers on every response, including errors and 404s (they are set
 * after the handlers ran, so nothing downstream can drop or change them).
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next()
    c.header('Content-Security-Policy', CSP)
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'DENY')
    c.header('Cross-Origin-Opener-Policy', 'same-origin')
    c.header('Cross-Origin-Resource-Policy', 'same-origin')
  }
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Every POST/PUT/PATCH/DELETE needs an `Origin` in `trustedOrigins`; otherwise 403 `forbidden-origin`. */
export function csrfOrigin(config: ServerConfig): MiddlewareHandler<AppEnv> {
  const trusted = new Set(config.trustedOrigins)
  return async (c, next) => {
    if (STATE_CHANGING.has(c.req.method)) {
      const origin = c.req.header('Origin')
      if (origin === undefined || !trusted.has(origin)) throw new ApiError(403, 'forbidden-origin')
    }
    await next()
  }
}
