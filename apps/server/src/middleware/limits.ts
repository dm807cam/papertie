import type { MiddlewareHandler } from 'hono'
import { bodyLimit as honoBodyLimit } from 'hono/body-limit'
import type { AppEnv } from '../http/env'
import { ApiError } from '../http/errors'

/** Rejects a request body over `bytes` (Content-Length or streamed) with 413 `too-large`. */
export function bodyLimit(bytes: number): MiddlewareHandler<AppEnv> {
  return honoBodyLimit({
    maxSize: bytes,
    onError: () => {
      throw new ApiError(413, 'too-large')
    },
  })
}
