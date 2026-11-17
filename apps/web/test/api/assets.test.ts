import { afterEach, describe, expect, it, vi } from 'vitest'
import { assetUrl, uploadAsset } from '../../src/api/assets'

const BOARD_ID = 'board_01JBTEST000000000000000001'

describe('assetUrl', () => {
  it('is the server route for each size', () => {
    expect(assetUrl('asset_X', 256)).toBe('/api/assets/asset_X/256')
    expect(assetUrl('asset_X', 1024)).toBe('/api/assets/asset_X/1024')
    expect(assetUrl('asset_X', 2560)).toBe('/api/assets/asset_X/2560')
  })
})

describe('uploadAsset', () => {
  afterEach(() => vi.unstubAllGlobals())

  const file = () => new Blob([new Uint8Array(10)], { type: 'image/png' })
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === null ? '' : JSON.stringify(body), { status, headers })
  const stub = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
    const fetchMock = vi.fn(impl)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('posts the file as multipart field file and answers the 201 body', async () => {
    const fetchMock = stub(async () => answer(201, { asset: { id: 'asset_1' }, revision: 12 }))
    await expect(uploadAsset(BOARD_ID, file())).resolves.toEqual({
      asset: { id: 'asset_1' },
      revision: 12,
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/boards/${BOARD_ID}/assets`)
    expect(init.method).toBe('POST')
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob)
  })

  it('waits as long as the store takes to process the image', async () => {
    vi.useFakeTimers()
    try {
      let finish = (_: Response) => {}
      stub(() => new Promise<Response>((r) => (finish = r)))
      const done = uploadAsset(BOARD_ID, file())
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      finish(answer(201, { asset: { id: 'asset_1' }, revision: 1 }))
      await expect(done).resolves.toMatchObject({ revision: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps an error status to ApiError with its code and Retry-After', async () => {
    stub(async () => answer(429, { error: 'rate-limited' }, { 'Retry-After': '4' }))
    await expect(uploadAsset(BOARD_ID, file())).rejects.toMatchObject({
      status: 429,
      code: 'rate-limited',
      retryAfterMs: 4000,
    })
  })

  it('refuses a 2xx with no body to read the asset from', async () => {
    stub(async () => answer(200, null))
    await expect(uploadAsset(BOARD_ID, file())).rejects.toMatchObject({
      status: 200,
      code: 'http-200',
    })
  })

  it('maps a network failure to code network', async () => {
    stub(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(uploadAsset(BOARD_ID, file())).rejects.toMatchObject({
      status: 0,
      code: 'network',
    })
  })

  it('aborts the request with the signal and rejects as an abort', async () => {
    const controller = new AbortController()
    stub(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Upload aborted', 'AbortError')),
          )
        }),
    )
    const done = uploadAsset(BOARD_ID, file(), { signal: controller.signal })
    controller.abort()
    await expect(done).rejects.toMatchObject({ name: 'AbortError' })
  })
})
