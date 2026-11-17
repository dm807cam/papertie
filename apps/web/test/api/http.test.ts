import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiJson, apiRaw, REQUEST_TIMEOUT_MS } from '../../src/api/http'

const fetchMock = vi.fn()

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body)
  fetchMock.mockResolvedValueOnce(new Response(status === 204 ? null : text, { status, headers }))
}

/** A 200 whose body stream fails after the headers, as a dropped connection does. */
function brokenBody(error: unknown = new TypeError('network error')): Response {
  const body = new ReadableStream({
    pull(controller) {
      controller.error(error)
    },
  })
  return new Response(body, { status: 200 })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('apiJson', () => {
  it('sends same-origin credentials and a JSON body with its content type', async () => {
    reply(200, { ok: true })
    await expect(apiJson('/api/x', { method: 'POST', json: { a: 1 } })).resolves.toEqual({
      ok: true,
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/x')
    expect(init.credentials).toBe('same-origin')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"a":1}')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
  })

  it('sends no content type without a body, and GET by default', async () => {
    reply(200, [])
    await apiJson('/api/x')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).has('Content-Type')).toBe(false)
  })

  it('passes keepalive and the abort signal through', async () => {
    reply(200, {})
    const ctl = new AbortController()
    await apiJson('/api/x', { method: 'POST', json: {}, keepalive: true, signal: ctl.signal })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.keepalive).toBe(true)
    expect(init.signal?.aborted).toBe(false)
    ctl.abort()
    expect(init.signal?.aborted).toBe(true)
  })

  it('answers undefined for an empty body (204)', async () => {
    reply(204, undefined)
    await expect(apiJson('/api/x', { method: 'POST' })).resolves.toBeUndefined()
  })

  it('turns a 429 with Retry-After: 3 into rate-limited with 3000 ms', async () => {
    reply(429, { error: 'rate-limited' }, { 'Retry-After': '3' })
    const err = await apiJson('/api/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({
      status: 429,
      code: 'rate-limited',
      retryAfterMs: 3000,
      body: { error: 'rate-limited' },
    })
  })

  it('reads the code from the body, keeping the whole body', async () => {
    reply(409, { error: 'client-expired', reason: 'idle' })
    await expect(apiJson('/api/x')).rejects.toMatchObject({
      status: 409,
      code: 'client-expired',
      retryAfterMs: null,
      body: { error: 'client-expired', reason: 'idle' },
    })
  })

  it('falls back to http-<status> when the body has no error code', async () => {
    reply(502, 'Bad gateway')
    await expect(apiJson('/api/x')).rejects.toMatchObject({
      status: 502,
      code: 'http-502',
      body: null,
    })
  })

  it('ignores an unusable Retry-After', async () => {
    reply(503, { error: 'storage' }, { 'Retry-After': 'soon' })
    await expect(apiJson('/api/x')).rejects.toMatchObject({ retryAfterMs: null })
  })

  it('throws bad-response for a 2xx body that is not JSON', async () => {
    reply(200, '<!doctype html><html></html>')
    const err = await apiJson('/api/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 200, code: 'bad-response' })
  })

  it('maps a connection dropped mid-body to network', async () => {
    fetchMock.mockResolvedValueOnce(brokenBody())
    await expect(apiJson('/api/x')).rejects.toMatchObject({ status: 0, code: 'network' })
  })

  it('lets an abort during the body read stay the abort', async () => {
    const controller = new AbortController()
    fetchMock.mockResolvedValueOnce(brokenBody(new DOMException('aborted', 'AbortError')))
    controller.abort()
    const err = await apiJson('/api/x', { signal: controller.signal }).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(ApiError)
    expect((err as DOMException).name).toBe('AbortError')
  })

  it('maps a rejected fetch to code network', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(apiJson('/api/x')).rejects.toMatchObject({
      status: 0,
      code: 'network',
      retryAfterMs: null,
    })
  })

  it('lets an abort through as the abort, not as a network error', async () => {
    const controller = new AbortController()
    controller.abort()
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    const err = await apiJson('/api/x', { signal: controller.signal }).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(ApiError)
    expect((err as DOMException).name).toBe('AbortError')
  })
})

describe('apiRaw', () => {
  it('answers the response of a 2xx', async () => {
    reply(200, 'hello')
    const res = await apiRaw('/api/x')
    expect(await res.text()).toBe('hello')
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].credentials).toBe('same-origin')
  })

  it('throws ApiError for a non-2xx', async () => {
    reply(404, { error: 'not-found' })
    await expect(apiRaw('/api/x')).rejects.toMatchObject({ status: 404, code: 'not-found' })
  })
})

describe('the request timeout', () => {
  /** A fetch that never answers, until its signal aborts. */
  function hang() {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError')),
          )
        }),
    )
  }

  afterEach(() => vi.useRealTimers())

  it('a request with no answer within REQUEST_TIMEOUT_MS fails as network', async () => {
    vi.useFakeTimers()
    hang()
    const pending = apiRaw('/api/x').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1)
    const err = await pending
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 0, code: 'network' })
  })

  it('a caller can lift the timeout with timeoutMs: Infinity', async () => {
    vi.useFakeTimers()
    let respond: () => void = () => {}
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          respond = () => resolve(new Response('{}', { status: 200 }))
        }),
    )
    const pending = apiRaw('/api/x', { timeoutMs: Number.POSITIVE_INFINITY })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 10)
    respond()
    await expect(pending).resolves.toBeInstanceOf(Response)
  })

  it('the timeout aborts the request with a TimeoutError reason', async () => {
    vi.useFakeTimers()
    hang()
    const pending = apiRaw('/api/x').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1)
    await pending
    const signal = (fetchMock.mock.calls[0] as [string, RequestInit])[1].signal
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toMatchObject({ name: 'TimeoutError' })
  })

  it('leaves no timer and no listener on the caller signal, on any path', async () => {
    vi.useFakeTimers()
    const ctl = new AbortController()
    const added = vi.spyOn(ctl.signal, 'addEventListener')
    const removed = vi.spyOn(ctl.signal, 'removeEventListener')
    const balance = () => added.mock.calls.length - removed.mock.calls.length
    reply(200, {})
    await apiRaw('/api/x', { signal: ctl.signal })
    expect(vi.getTimerCount()).toBe(0)
    expect(balance()).toBe(0)
    reply(500, { error: 'boom' })
    await apiRaw('/api/x', { signal: ctl.signal }).catch(() => {})
    expect(vi.getTimerCount()).toBe(0)
    expect(balance()).toBe(0)
    fetchMock.mockRejectedValueOnce(new TypeError('network error'))
    await apiRaw('/api/x', { signal: ctl.signal }).catch(() => {})
    expect(vi.getTimerCount()).toBe(0)
    expect(balance()).toBe(0)
  })

  it("a caller's abort still wins over the timeout", async () => {
    vi.useFakeTimers()
    hang()
    const ctl = new AbortController()
    const pending = apiRaw('/api/x', { signal: ctl.signal }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1000)
    ctl.abort(new DOMException('stop', 'AbortError'))
    const err = await pending
    expect(err).not.toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ name: 'AbortError' })
  })

  it('a slow body after prompt headers is not cut off', async () => {
    vi.useFakeTimers()
    let release: () => void = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => {
          controller.enqueue(new TextEncoder().encode('{"ok":true}'))
          controller.close()
        }
      },
    })
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }))
    const pending = apiJson('/api/x')
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 3)
    release()
    await expect(pending).resolves.toEqual({ ok: true })
  })
})

describe('the request timeout where AbortSignal.any is missing (Safari before 17.4)', () => {
  const real = AbortSignal.any
  beforeEach(() => {
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(AbortSignal, 'any', { value: real, configurable: true })
    vi.useRealTimers()
  })

  function hang() {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          if (init.signal?.aborted) reject(init.signal.reason)
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError')),
          )
        }),
    )
  }

  it('a request with a signal still goes out', async () => {
    reply(200, { ok: true })
    await expect(apiJson('/api/x', { signal: new AbortController().signal })).resolves.toEqual({
      ok: true,
    })
  })

  it('the timeout still fails as network', async () => {
    vi.useFakeTimers()
    hang()
    const pending = apiRaw('/api/x', { signal: new AbortController().signal }).catch(
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1)
    expect(await pending).toMatchObject({ status: 0, code: 'network' })
  })

  it("a caller's abort still wins and stays the AbortError", async () => {
    hang()
    const ctl = new AbortController()
    const pending = apiRaw('/api/x', { signal: ctl.signal }).catch((e: unknown) => e)
    ctl.abort(new DOMException('stop', 'AbortError'))
    const err = await pending
    expect(err).not.toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ name: 'AbortError' })
  })

  it('an already aborted signal is the abort, without a request being answered', async () => {
    hang()
    const ctl = new AbortController()
    ctl.abort(new DOMException('stop', 'AbortError'))
    await expect(apiRaw('/api/x', { signal: ctl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('leaves no timer and no listener on the caller signal, on any path', async () => {
    vi.useFakeTimers()
    const ctl = new AbortController()
    const added = vi.spyOn(ctl.signal, 'addEventListener')
    const removed = vi.spyOn(ctl.signal, 'removeEventListener')
    const balance = () => added.mock.calls.length - removed.mock.calls.length
    reply(200, {})
    await apiRaw('/api/x', { signal: ctl.signal })
    expect(vi.getTimerCount()).toBe(0)
    expect(balance()).toBe(0)
    reply(500, { error: 'boom' })
    await apiRaw('/api/x', { signal: ctl.signal }).catch(() => {})
    expect(balance()).toBe(0)
    fetchMock.mockRejectedValueOnce(new TypeError('network error'))
    await apiRaw('/api/x', { signal: ctl.signal }).catch(() => {})
    expect(balance()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
