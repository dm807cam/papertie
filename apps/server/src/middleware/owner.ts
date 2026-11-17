import { type IdPrefix, isId } from '@papertie/core'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../http/env'
import { ApiError } from '../http/errors'
import type { BoardStore } from '../store/boardStore'

/** A path parameter that is not an id of `prefix` is a 404, the same as a missing resource. */
export function idParam(name: string, prefix: IdPrefix): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!isId(c.req.param(name), prefix)) throw new ApiError(404, 'not-found')
    await next()
  }
}

/**
 * After `asUser`: the `:id` parameter must be a board of the user's. Malformed ids and missing
 * boards are the same 404.
 */
export function requireBoardOwner(store: Pick<BoardStore, 'owns'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const id = c.req.param('id') ?? ''
    if (!(await store.owns(c.var.user.id, id))) throw new ApiError(404, 'not-found')
    await next()
  }
}
