import { readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { MiddlewareHandler } from 'hono'
import { getMimeType } from 'hono/utils/mime'
import type { AppEnv } from '../http/env'

/** Vite's hashed build output: a changed file gets a new name, so a copy never goes stale. */
const IMMUTABLE = 'public, max-age=31536000, immutable'
/** Everything else (index.html above all) is revalidated, so a new build is picked up at once. */
const REVALIDATE = 'no-cache'
const INDEX = 'index.html'

/**
 * A request path no browser sends for the app: a dot segment (raw or percent-encoded), an encoded
 * slash or backslash, a backslash, or a NUL. The URL parser resolves dot segments before any route
 * sees the path, so this looks at the path as it arrived (the query is not looked at).
 */
const FORGED_PATH = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|%2f|%5c|%00|\\/i

const isApi = (path: string) => path === '/api' || path.startsWith('/api/')

/** `rel` (from `relative`) stays inside its root. */
const inside = (rel: string) => rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)

/**
 * Serves the built web app from `webDist` (one process in production). Registered
 * after every route: a non-`/api` `GET` or `HEAD` gets the file at its path, or `index.html` for
 * any other path (the app's own routes), with the security headers every response gets. `/api/*`
 * and other methods pass through to the JSON or plain 404. `/assets/*` (hashed) is cached for good;
 * everything else is revalidated.
 *
 * Paths are decoded, resolved and checked to stay inside `webDist`, symlinks included. A forged
 * target (dot segments, encoded separators) is a 404 rather than a quiet fallback.
 */
export function spaStatic(webDist: string): MiddlewareHandler<AppEnv> {
  const root = resolve(webDist)
  let realRoot: string | null = null

  /** The bytes of the regular file at `path` inside the root, or null. */
  async function fileAt(path: string): Promise<Buffer | null> {
    try {
      if (!(await stat(path)).isFile()) return null
      realRoot ??= await realpath(root)
      if (!inside(relative(realRoot, await realpath(path)))) return null
      return await readFile(path)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw e
    }
  }

  return async (c, next) => {
    const method = c.req.method
    if ((method !== 'GET' && method !== 'HEAD') || isApi(c.req.path)) return next()
    const target = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.url
    if (target !== undefined && FORGED_PATH.test(target.split(/[?#]/, 1)[0] ?? '')) return next()

    let path: string
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname)
    } catch {
      return next()
    }
    if (path.includes('\0') || path.includes('\\')) return next()
    const file = resolve(root, `.${path}`)
    if (!inside(relative(root, file))) return next()

    let bytes = await fileAt(file)
    let name = file
    let cache = path.startsWith('/assets/') ? IMMUTABLE : REVALIDATE
    if (!bytes) {
      name = join(root, INDEX)
      bytes = await fileAt(name)
      cache = REVALIDATE
      if (!bytes) return next()
    }
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': getMimeType(name) ?? 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': cache,
    })
  }
}
