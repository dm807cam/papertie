import type { ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { StoreError } from '../store/errors'
import type { AppEnv } from './env'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

/**
 * The HTTP form of a store failure, per the Global Constraints table. Bodies carry only codes
 * (and an op index), never request content.
 */
export function toHttpError(e: StoreError): ApiError {
  switch (e.code) {
    case 'not-found':
      return new ApiError(404, 'not-found')
    case 'board-unreadable':
      return new ApiError(409, 'board-unreadable', { reason: e.reason })
    case 'client-busy':
    case 'client-expired':
    case 'revision-ahead':
    case 'board-limit':
      return new ApiError(409, e.code)
    case 'block-stale':
      return new ApiError(409, 'block-stale', { blockId: e.blockId })
    case 'rejected':
      return new ApiError(422, 'rejected', {
        code: e.opError?.code ?? 'invalid',
        index: e.opError?.index,
      })
    case 'storage':
      return new ApiError(503, 'storage')
  }
}

/** Status codes of Hono's own HTTPException (body parsing, body limits) and the code they become. */
const HTTP_EXCEPTION_CODES: Record<number, string> = {
  400: 'invalid',
  404: 'not-found',
  413: 'too-large',
}

/**
 * ApiError becomes `{error: code, ...extra}`; a StoreError is mapped through `toHttpError` the same way, so no route needs to wrap its store calls. A JSON `SyntaxError` (a route parsed a malformed
 * body) is 400 `invalid`, and Hono's HTTPException maps 400/404/413 the same way. Anything else
 * is a 500 that logs only the error's name. Error bodies never echo request content.
 */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof ApiError) {
    return c.json({ ...err.extra, error: err.code }, err.status as ContentfulStatusCode)
  }
  if (err instanceof StoreError) {
    const { status, code, extra } = toHttpError(err)
    return c.json({ ...extra, error: code }, status as ContentfulStatusCode)
  }
  if (err instanceof SyntaxError) return c.json({ error: 'invalid' }, 400)
  if (err instanceof HTTPException) {
    const code = HTTP_EXCEPTION_CODES[err.status]
    if (code) return c.json({ error: code }, err.status as ContentfulStatusCode)
  }
  c.get('log')?.error('unhandled', { kind: err instanceof Error ? err.name : 'unknown' })
  return c.json({ error: 'internal' }, 500)
}
