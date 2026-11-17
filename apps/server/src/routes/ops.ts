import type { Handler, MiddlewareHandler } from 'hono'
import type { Clock } from '../clock'
import type { AppEnv } from '../http/env'
import { ApiError } from '../http/errors'
import { readJsonSized } from '../http/json'
import { bodyLimit } from '../middleware/limits'
import type { BoardStore } from '../store/boardStore'
import { StoreError } from '../store/errors'
import { type Faults, noFaults } from '../store/faults'
import { PostOpsBodySchema, type StagingArea } from '../store/staging'
import { parseRevision } from './events'

export { toHttpError } from '../http/errors'

export interface OpsDeps {
  store: BoardStore
  bodyBytes: number
  staging: StagingArea
  faults?: Faults
}

/**
 * The chain behind `POST /api/boards/:id/ops` (after ownership): body limit, JSON parse, schema,
 * then `store.submit`. Schema failures never echo the input.
 *
 * A body with `part` is one part of a staged transaction (ADR-0005): parts wait in `staging` and
 * the last one to arrive commits all of them as one revision. An already-committed `seq` answers
 * with the duplicate ack without staging anything.
 */
export function opsHandlers(deps: OpsDeps): [MiddlewareHandler<AppEnv>, Handler<AppEnv>] {
  const faults = deps.faults ?? noFaults
  return [
    bodyLimit(deps.bodyBytes),
    async (c) => {
      const { body, bytes } = await readJsonSized(c)
      const parsed = PostOpsBodySchema.safeParse(body)
      if (!parsed.success) throw new ApiError(400, 'invalid')
      const userId = c.var.user.id
      const boardId = c.req.param('id') ?? ''
      const input = parsed.data
      if (!('part' in input)) return c.json(await deps.store.submit(userId, boardId, input))

      const { clientId, seq } = input
      const mark = await deps.store.clientMark(userId, boardId, clientId)
      if (mark && seq <= mark.lastSeq) {
        return c.json({ clientId, seq, revision: mark.lastRevision, now: null, duplicate: true })
      }
      const boardKey = `${userId}/${boardId}`
      const staged = deps.staging.stage(boardKey, input, bytes)
      faults.hit('staged:after-part')
      if (staged.kind === 'partial') {
        return c.json({ staged: true, received: staged.received, count: staged.count }, 202)
      }
      try {
        const ack = await deps.store.submit(userId, boardId, {
          clientId,
          seq,
          baseRevision: staged.baseRevision,
          ops: staged.ops,
        })
        deps.staging.drop(boardKey, clientId, seq)
        return c.json(ack)
      } catch (e) {
        // A rejected transaction is final; a transient failure (busy, storage) keeps the stage so
        // the client's resend of the last part retries the commit.
        if (e instanceof StoreError && e.code === 'rejected')
          deps.staging.drop(boardKey, clientId, seq)
        throw e
      }
    },
  ]
}

/**
 * `GET /api/boards/:id/ops?since=<revision>` (after auth and ownership): the commits after `since`,
 * or `{full: true}` when the ring cannot supply them. `X-Papertie-Now` and `X-Papertie-Recovered` are
 * as on a board load: a page catching up may load nothing else.
 */
export function sinceHandler(store: Pick<BoardStore, 'since'>, clock: Clock): Handler<AppEnv> {
  return async (c) => {
    const rev = parseRevision(c.req.query('since'))
    const { recovered, ...answer } = await store.since(c.var.user.id, c.req.param('id') ?? '', rev)
    c.header('X-Papertie-Now', clock.now().toISOString())
    if (recovered) c.header('X-Papertie-Recovered', '1')
    return c.json(answer)
  }
}
