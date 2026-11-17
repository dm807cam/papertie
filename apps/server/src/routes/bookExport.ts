import type { Handler } from 'hono'
import type { Clock } from '../clock'
import { exportBook } from '../export/bookExport'
import type { AppEnv } from '../http/env'
import { ApiError } from '../http/errors'
import type { Logger } from '../log'
import type { BoardStore } from '../store/boardStore'
import { zipBody } from './export'

export interface BookExportRouteDeps {
  dataDir: string
  clock: Clock
  store: BoardStore
  log: Logger
}

/**
 * `GET /api/boards/:id/books/:bookId/export?format=md|docx` (after auth and ownership, as the
 * `.papertie` export: another user's board is the owner check's 404), as a download:
 * - `md`: `application/zip`, `<slug>.zip`, holding `<slug>.md` and `images/<assetId>.webp`;
 * - `docx`: the WordprocessingML type, `<slug>.docx`.
 * The slug is `exportSlug` of the book's title (`book` when nothing is left). A book the board
 * does not have, or one in the trash, is 404. Read from the board as it stood when asked (the
 * store's held state, one revision), in slices (`exportBook`); the zip streams as it is read.
 */
export function bookExportHandler(deps: BookExportRouteDeps): Handler<AppEnv> {
  const { dataDir, clock, store, log } = deps
  return async (c) => {
    const format = c.req.query('format')
    if (format !== 'md' && format !== 'docx') throw new ApiError(400, 'invalid')
    const userId = c.var.user.id
    const boardId = c.req.param('id') ?? ''
    const { state } = await store.peek(userId, boardId)
    const now = clock.now()
    const r = await exportBook(state, c.req.param('bookId') ?? '', format, {
      dataDir,
      userId,
      boardId,
      log,
      now,
    })
    if (r === null) throw new ApiError(404, 'not-found')
    return c.body(zipBody(r.entries, now, log), 200, {
      'Content-Type': r.contentType,
      'Content-Disposition': `attachment; filename="${r.filename}"`,
    })
  }
}
