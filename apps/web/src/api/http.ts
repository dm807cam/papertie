/** A failed request: an error status from the server, or no answer at all (`code: 'network'`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The body's `error` key, `'network'` (no answer) or `'http-<status>'` (no code in the body). */
    readonly code: string,
    /** The `Retry-After` wait, when the server sent one. */
    readonly retryAfterMs: number | null = null,
    /** The parsed JSON body, or null when there was none. */
    readonly body: unknown = null,
  ) {
    super(`${code} (${status})`)
    this.name = 'ApiError'
  }
}

export interface ApiJsonInit {
  method?: string
  json?: unknown
  signal?: AbortSignal
  keepalive?: boolean
  /** See {@link apiRaw}. */
  timeoutMs?: number
}

/** `Retry-After` in seconds (the only form the server sends) as milliseconds, else null. */
export function retryAfterMs(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null
  return Number(header.trim()) * 1000
}

/** The error for a non-2xx response: reads its body once, as JSON if it is. */
async function errorFor(res: Response): Promise<ApiError> {
  const body: unknown = await res
    .text()
    .then((t) => (t === '' ? null : JSON.parse(t)))
    .catch(() => null)
  const code =
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `http-${res.status}`
  return new ApiError(res.status, code, retryAfterMs(res.headers.get('Retry-After')), body)
}

/** How long a request may wait for its response headers before it counts as unanswered. */
export const REQUEST_TIMEOUT_MS = 20_000

/**
 * `fetch` with same-origin credentials. A response outside 2xx throws {@link ApiError}, and so
 * does a request that gets no answer (`code: 'network'`), including one whose response headers
 * have not arrived within `timeoutMs` (default {@link REQUEST_TIMEOUT_MS}). The body is not
 * timed. An abort of the caller's own `signal` stays the abort.
 *
 * `timeoutMs: Infinity` lifts the timeout, for a request the server answers only after all of
 * it was uploaded and processed (an import's upload and commit, a restore): the wait is then as
 * long as that work takes.
 */
export async function apiRaw(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, signal: callerSignal, ...rest } = init
  // Where `AbortSignal.any` exists (Safari 17.4+), it links the signals with no listener of ours
  // on the caller's, and the caller's abort still cuts a body that follows the headers. Without
  // it the caller's signal is linked by hand, and that listener is removed when the headers (or a
  // failure) end the wait: on those browsers a later abort no longer cuts the body.
  const timeout = new AbortController()
  let unlink = () => {}
  let signal = timeout.signal
  if (callerSignal) {
    if (typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([callerSignal, timeout.signal])
    } else if (callerSignal.aborted) {
      timeout.abort(callerSignal.reason)
    } else {
      const onAbort = () => timeout.abort(callerSignal.reason)
      callerSignal.addEventListener('abort', onAbort, { once: true })
      unlink = () => callerSignal.removeEventListener('abort', onAbort)
    }
  }
  const timer = Number.isFinite(timeoutMs)
    ? setTimeout(
        () => timeout.abort(new DOMException('Request timed out', 'TimeoutError')),
        timeoutMs,
      )
    : undefined
  let res: Response
  try {
    res = await fetch(path, { ...rest, signal, credentials: 'same-origin' })
  } catch (e) {
    if (callerSignal?.aborted) throw e
    throw new ApiError(0, 'network')
  } finally {
    clearTimeout(timer)
    unlink()
  }
  if (!res.ok) throw await errorFor(res)
  return res
}

/**
 * The body of a response as text. A connection that drops mid-body is `code: 'network'`; an abort
 * of the caller's `signal` stays the abort, as in {@link apiRaw}.
 */
export async function readBody(res: Response, signal?: AbortSignal): Promise<string> {
  try {
    return await res.text()
  } catch (e) {
    if (signal?.aborted) throw e
    throw new ApiError(0, 'network')
  }
}

/** {@link readBody}, as bytes (for a parse elsewhere than this thread). */
export async function readBytes(res: Response, signal?: AbortSignal): Promise<ArrayBuffer> {
  try {
    return await res.arrayBuffer()
  } catch (e) {
    if (signal?.aborted) throw e
    throw new ApiError(0, 'network')
  }
}

/** A JSON request and its parsed answer (`undefined` for an empty body such as a 204). */
export async function apiJson<T>(path: string, init: ApiJsonInit = {}): Promise<T> {
  const { json, ...rest } = init
  const request: RequestInit = { ...rest }
  if (json !== undefined) {
    request.headers = { 'Content-Type': 'application/json' }
    request.body = JSON.stringify(json)
  }
  const res = await apiRaw(path, request)
  const text = await readBody(res, init.signal)
  if (text === '') return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    // a 2xx that is not JSON: a proxy's or the SPA fallback's HTML page, or a cut-off body
    throw new ApiError(res.status, 'bad-response')
  }
}
