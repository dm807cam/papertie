import { Hono } from 'hono'
import type { QuotaTracker } from '../assets/quota'
import type { Clock } from '../clock'
import type { ServerConfig } from '../config'
import type { AppEnv } from '../http/env'
import { ApiError } from '../http/errors'
import { readJson } from '../http/json'
import type { Logger } from '../log'
import { bodyLimit } from '../middleware/limits'
import { idParam, requireBoardOwner } from '../middleware/owner'
import type { BoardStore } from '../store/boardStore'
import type { Faults } from '../store/faults'
import { type RegionRect, regionFits } from '../store/region'
import { jsonlStream } from '../store/servedText'
import type { StagingArea } from '../store/staging'
import { asUser } from '../user'
import { uploadHandlers } from './assets'
import { backupHandlers } from './backups'
import { bookExportHandler } from './bookExport'
import { eventsHandler } from './events'
import { exportHandler } from './export'
import { importHandlers } from './import'
import { opsHandlers, sinceHandler } from './ops'

export interface BoardRouteDeps {
  config: ServerConfig
  clock: Clock
  log: Logger
  /** The one user's id (`user.ts`). */
  userId: string
  store: BoardStore
  staging: StagingArea
  /** Uploads are mounted only when a quota tracker is provided. */
  quota?: QuotaTracker
  faults?: Faults
}

const NAME_MAX = 120
const CHUNK_BYTES = 65_536
const encoder = new TextEncoder()

/** `text` (a region's answer: at most a few MB) as a stream of 64 KB chunks. */
function ndjsonStream(text: string): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text)
  let at = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close()
      controller.enqueue(bytes.subarray(at, at + CHUNK_BYTES))
      at += CHUNK_BYTES
    },
  })
}

const ndjsonHeaders = (revision: number): Record<string, string> => ({
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Papertie-Revision': String(revision),
})

/** A plain decimal (up to 15 digits, 8 decimals): no exponent, no hex, no `Infinity`. */
const COORD = /^-?\d{1,15}(\.\d{1,8})?$/

/**
 * `x0, y0, x1, y1` of `GET /region` as a rect with `x0 <= x1`, `y0 <= y1`, spanning at most
 * `REGION_MAX_TILES` tiles (`regionFits`). Anything else is 400 `invalid`.
 */
function parseRegion(q: Record<string, string>): RegionRect {
  const v = (k: string) => {
    const raw = q[k]
    if (raw === undefined || !COORD.test(raw)) throw new ApiError(400, 'invalid')
    return Number(raw)
  }
  const r = { x0: v('x0'), y0: v('y0'), x1: v('x1'), y1: v('y1') }
  if (!(r.x0 <= r.x1 && r.y0 <= r.y1) || !regionFits(r)) throw new ApiError(400, 'invalid')
  return r
}

/**
 * Board create/list/load/meta/recovery, ops, regions, uploads, events, export, import and
 * backup history, mounted at `/api/boards`.
 */
export function boardRoutes(deps: BoardRouteDeps): Hono<AppEnv> {
  const { store, clock, config, log } = deps
  const app = new Hono<AppEnv>()
  const owned = [idParam('id', 'board'), requireBoardOwner(store)] as const

  app.use('*', asUser(deps.userId))

  app.post('/', bodyLimit(config.limits.jsonBodyBytes), async (c) => {
    const { name, first } = await readJson(c)
    if (typeof name !== 'string' || name.length < 1 || name.length > NAME_MAX) {
      throw new ApiError(400, 'invalid')
    }
    if (first !== undefined && typeof first !== 'boolean') throw new ApiError(400, 'invalid')
    // `first`: the board to open on a first run, made only if the user has none (201), else the
    // one they have (200). Two boots at once share it.
    if (first) {
      const { board, created } = await store.firstBoard(c.var.user.id, name)
      return c.json({ ...board, created }, created ? 201 : 200)
    }
    const board = await store.createBoard(c.var.user.id, name)
    return c.json(board, 201)
  })

  app.get('/', async (c) => c.json(await store.listBoards(c.var.user.id)))

  app.get('/:id', ...owned, async (c) => {
    const view = await store.read(c.var.user.id, c.req.param('id'))
    const headers: Record<string, string> = {
      ...ndjsonHeaders(view.revision),
      'Content-Length': String(view.served.bytes),
      'X-Papertie-Now': clock.now().toISOString(),
    }
    if (view.recovery) headers['X-Papertie-Recovered'] = '1'
    return c.body(jsonlStream(view.served), 200, headers)
  })

  app.get('/:id/meta', ...owned, async (c) => {
    // Without the board's text: a meta read never serializes the board.
    const view = await store.peek(c.var.user.id, c.req.param('id'))
    const { board } = view.state
    return c.json({
      id: board.id,
      name: board.name,
      revision: board.revision,
      recovery: view.recovery,
      // With no camera remembered, the page opens a large board fitted, from that view.
      notes: view.state.notes.size,
      extent: view.extent,
    })
  })

  app.delete('/:id/recovery', ...owned, async (c) => {
    await store.dismissRecovery(c.var.user.id, c.req.param('id'))
    return c.body(null, 204)
  })

  app.post(
    '/:id/ops',
    ...owned,
    ...opsHandlers({
      store,
      bodyBytes: config.limits.opsBodyBytes,
      staging: deps.staging,
      faults: deps.faults,
    }),
  )

  app.get('/:id/ops', ...owned, sinceHandler(store, clock))

  // One book, opened: its record, its blocks and an eof over them, all of one revision.
  // Whole-board reads carry no blocks (ADR-0001). Another user's board is the owner check's 404,
  // a missing book this one's.
  app.get('/:id/books/:bookId', ...owned, idParam('bookId', 'book'), async (c) => {
    const r = await store.book(c.var.user.id, c.req.param('id'), c.req.param('bookId'))
    return c.body(jsonlStream(r.jsonl), 200, {
      ...ndjsonHeaders(r.revision),
      'Content-Length': String(r.jsonl.bytes),
      'Papertie-Revision': String(r.revision),
    })
  })

  // A board's first paint: one viewport's notes and what they need.
  app.get('/:id/region', ...owned, async (c) => {
    const rect = parseRegion(c.req.query())
    const r = await store.region(c.var.user.id, c.req.param('id'), rect)
    return c.body(ndjsonStream(r.text), 200, ndjsonHeaders(r.revision))
  })

  const { quota } = deps
  if (quota) {
    app.post('/:id/assets', ...owned, ...uploadHandlers({ ...deps, quota }))
    // The upload's own reader caps its body (the quota left plus 1 GB): no `bodyLimit` here.
    const imports = importHandlers({ ...deps, quota })
    app.post('/:id/import', ...owned, imports.preview)
    app.post(
      '/:id/import/:importId/commit',
      ...owned,
      bodyLimit(config.limits.jsonBodyBytes),
      imports.commit,
    )
    app.delete('/:id/import/:importId', ...owned, imports.cancel)
  }

  app.get('/:id/events', ...owned, eventsHandler({ store, keepaliveMs: config.sseKeepaliveMs }))

  app.get('/:id/export', ...owned, exportHandler({ dataDir: config.dataDir, clock, store, log }))

  // A book as Markdown or Word: owner-only like the board's export.
  app.get(
    '/:id/books/:bookId/export',
    ...owned,
    idParam('bookId', 'book'),
    bookExportHandler({ dataDir: config.dataDir, clock, store, log }),
  )

  const backups = backupHandlers({ dataDir: config.dataDir, store, staging: deps.staging, log })
  app.get('/:id/backups', ...owned, backups.list)
  app.post(
    '/:id/backups/:backupId/restore',
    ...owned,
    bodyLimit(config.limits.jsonBodyBytes),
    backups.restore,
  )

  return app
}
