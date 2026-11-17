import type { Asset } from '@papertie/core'
import { ApiError, apiRaw, readBody } from './http'

export type AssetSize = 256 | 1024 | 2560

/** The URL of an asset's size variant (its long side) on the server. */
export function assetUrl(id: string, size: AssetSize): string {
  return `/api/assets/${id}/${size}`
}

export interface UploadOptions {
  signal?: AbortSignal
}

/**
 * Upload an image to a board (multipart field `file`). The store keeps the variants and commits
 * `asset.add` itself; it answers once the image is processed, however long that takes, so the
 * request has no timeout. Nothing reports how far along it is: the page and the store are one
 * app, the bytes arrive at once, and the time goes to the processing.
 */
export async function uploadAsset(
  boardId: string,
  file: Blob,
  { signal }: UploadOptions = {},
): Promise<{ asset: Asset; revision: number }> {
  const form = new FormData()
  form.append('file', file)
  const res = await apiRaw(`/api/boards/${boardId}/assets`, {
    method: 'POST',
    body: form,
    timeoutMs: Number.POSITIVE_INFINITY,
    ...(signal ? { signal } : {}),
  })
  const body: unknown = await readBody(res, signal)
    .then((t) => JSON.parse(t))
    .catch((e: unknown) => {
      if (signal?.aborted || e instanceof ApiError) throw e
      // An empty or unreadable body: the status alone cannot name the asset.
      throw new ApiError(res.status, `http-${res.status}`)
    })
  return body as { asset: Asset; revision: number }
}
