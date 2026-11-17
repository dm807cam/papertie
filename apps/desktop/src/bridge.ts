import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { OPENED_PREFIX, type OpenedFiles } from './openedFiles'
import { APP_HOST, APP_ORIGIN, SCHEME } from './origin'

export { APP_ORIGIN } from './origin'

/** What the bridge hands requests to: the app (`createHostApp(...).app`). */
export interface Fetcher {
  fetch(request: Request): Response | Promise<Response>
}

export interface BridgeOptions {
  /** The app, or the promise of it while its data opens (the window loads meanwhile). */
  app: Fetcher | Promise<Fetcher>
  /** Files the system opened, served once each at `/_opened/<token>`. */
  opened?: OpenedFiles
}

/**
 * A path no page of the app asks for: an encoded slash or backslash, a backslash, or a NUL. The
 * URL parser has already resolved dot segments (raw or encoded); these it leaves. The server's
 * static handler would refuse them too; here they never reach it.
 */
const FORGED_PATH = /%2f|%5c|%00|\\/i

const notFound = () =>
  new Response('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  })

/**
 * The `papertie` protocol's handler (`protocol.handle`): every request of the page goes to the
 * app's `fetch` as it came, its method, headers and body (streamed) unchanged, and the app's
 * `Response` comes back as it is, its body streamed (the event stream, the board's NDJSON, a zip
 * export). The app serves the built web app too, with the SPA fallback, its content types and the
 * strict CSP; nothing here reads the web app's files. Only `papertie://app` is answered. The one
 * thing the bridge serves itself is a file the system opened, once, by its token.
 */
export function createBridge(o: BridgeOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return notFound()
    }
    if (url.protocol !== `${SCHEME}:` || url.host !== APP_HOST) return notFound()
    if (FORGED_PATH.test(url.pathname)) return notFound()
    if (url.pathname.startsWith(OPENED_PREFIX)) {
      return request.method === 'GET' && o.opened
        ? openedFile(o.opened, url.pathname.slice(OPENED_PREFIX.length))
        : notFound()
    }
    try {
      const app = await o.app
      return await app.fetch(withOrigin(request))
    } catch {
      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }
  }
}

/**
 * The request with `Origin: papertie://app` when it came with none. Chromium sends no `Origin` on
 * a custom scheme's requests (the server's write check needs one), and nothing but the app's own
 * page reaches this handler: no port is open, and the window never leaves `papertie://app`. A
 * request that names another origin keeps it, and the server refuses its writes.
 */
function withOrigin(request: Request): Request {
  if (request.headers.has('Origin') || request.method === 'GET' || request.method === 'HEAD') {
    return request
  }
  const headers = new Headers(request.headers)
  headers.set('Origin', APP_ORIGIN)
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    duplex: 'half',
  } as RequestInit)
}

/** The opened file behind `token`, streamed from disk; a 404 when unknown, spent or gone. */
async function openedFile(opened: OpenedFiles, token: string): Promise<Response> {
  const path = opened.take(token)
  if (path === undefined) return notFound()
  try {
    const info = await stat(path)
    if (!info.isFile()) return notFound()
    const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(info.size),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return notFound()
  }
}
