import { readdirSync, readFileSync } from 'node:fs'
import { newId, OpError, parseBoard } from '@papertie/core'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../src/http/env'
import { onError } from '../src/http/errors'
import { StoreError, type StoreErrorCode } from '../src/store/errors'
import {
  boardDir,
  compactBoard,
  createBoard,
  noteCreate,
  postOps,
  readBoardFile,
  tabNow,
} from './helpers/boards'
import type { TestUser } from './helpers/client'
import { startTestServer, type TestServer } from './helpers/harness'

const NOW = '2026-10-27T10:00:00.000Z'
const DAY_MS = 86_400_000

let server: TestServer
let user: TestUser
let board: string

beforeEach(async () => {
  server = await startTestServer()
  user = server.user
  board = await createBoard(user)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await server.close()
})

const batch = (over: Record<string, unknown> = {}) => ({
  clientId: tabNow(server),
  seq: 1,
  baseRevision: 0,
  ops: [noteCreate({ at: NOW })],
  ...over,
})
const stateOf = (boardId = board) => {
  const { state } = parseBoard(readBoardFile(server, user.id, boardId).toString('utf8'))
  if (!state) throw new Error('board does not parse')
  return state
}

describe('POST /api/boards/:id/ops', () => {
  it('acks a batch, and the same request again is a duplicate', async () => {
    const body = batch()
    const res = await postOps(user, board, body)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      revision: 1,
      duplicate: false,
      now: NOW,
      clientId: body.clientId,
      seq: 1,
    })
    const again = await postOps(user, board, body)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ revision: 1, duplicate: true, now: null })
    expect(stateOf().board.revision).toBe(1)
  })

  it('malformed JSON is 400 invalid', async () => {
    const res = await postOps(user, board, '{"clientId":')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid' })
  })
})

describe('limits', () => {
  it('a body of 1,048,577 bytes is 413 too-large and the file is unchanged', async () => {
    const before = readBoardFile(server, user.id, board)
    const res = await postOps(user, board, 'x'.repeat(1_048_577))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'too-large' })
    expect(readBoardFile(server, user.id, board).equals(before)).toBe(true)
  })

  it('501 ops is 400 invalid', async () => {
    const ops = Array.from({ length: 501 }, () => noteCreate({ at: NOW }))
    const res = await postOps(user, board, batch({ ops }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid' })
    expect(stateOf().board.revision).toBe(0)
  })

  it('an asset.add op from a client is 400', async () => {
    const asset = {
      op: 'asset.add',
      asset: {
        type: 'asset',
        id: newId('asset'),
        mime: 'image/webp',
        width: 1,
        height: 1,
        bytes: 1,
        sha256: '0'.repeat(64),
        createdAt: NOW,
      },
    }
    const res = await postOps(user, board, batch({ ops: [asset] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid' })
    expect(stateOf().board.revision).toBe(0)
  })

  it('/ops with asset.remove from a client is 400', async () => {
    const res = await postOps(
      user,
      board,
      batch({ ops: [{ op: 'asset.remove', id: newId('asset') }] }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid' })
    expect(stateOf().board.revision).toBe(0)
  })

  it('a schema failure does not echo the input', async () => {
    const op = noteCreate({ text: 'SENTINEL-TEXT-91', at: NOW })
    const res = await postOps(user, board, batch({ ops: [{ ...op, extra: 'SENTINEL-TEXT-91' }] }))
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toContain('SENTINEL')
    expect(JSON.parse(text)).toEqual({ error: 'invalid' })
    expect(server.logs.join('\n')).not.toContain('SENTINEL')
  })
})

describe('rejection', () => {
  it('note.update of a missing note is 422 rejected not-found at index 0', async () => {
    const op = { op: 'note.update', id: newId('note'), set: { x: 5 } }
    const res = await postOps(user, board, batch({ ops: [op] }))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'rejected', code: 'not-found', index: 0 })
    expect(stateOf().board.revision).toBe(0)
  })

  it("an image of another board's asset is 422 rejected invalid", async () => {
    const other = await createBoard(user, 'Other')
    const assetId = newId('asset')
    await server.deps.store?.submitServer(user.id, other, [
      {
        op: 'asset.add',
        asset: {
          type: 'asset',
          id: assetId,
          mime: 'image/webp',
          width: 1,
          height: 1,
          bytes: 1,
          sha256: '0'.repeat(64),
          createdAt: NOW,
        },
      },
    ])
    const op = noteCreate({ at: NOW })
    op.note.image = { assetId, frame: 'none' } as never
    const res = await postOps(user, board, batch({ ops: [op] }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'rejected', code: 'invalid', index: 0 })
    expect(stateOf().board.revision).toBe(0)
  })
})

describe('route mapping', () => {
  it('client-busy: a tab racing its own seq 2 and 3 gets 409 for one of them', async () => {
    const t = tabNow(server)
    expect((await postOps(user, board, batch({ clientId: t }))).status).toBe(200)
    // Hold both requests at the store until each has arrived, then submit them back to back,
    // so the second always finds the first in flight.
    const store = server.deps.store
    if (!store) throw new Error('no store')
    const original = store.submit.bind(store)
    const held: (() => void)[] = []
    vi.spyOn(store, 'submit').mockImplementation(
      (...args) =>
        new Promise((resolve, reject) => {
          held.push(() => original(...args).then(resolve, reject))
          if (held.length === 2) for (const go of held.splice(0)) go()
        }),
    )
    const [a, b] = await Promise.all([
      postOps(user, board, batch({ clientId: t, seq: 2, baseRevision: 1 })),
      postOps(user, board, batch({ clientId: t, seq: 3, baseRevision: 1 })),
    ])
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409])
    const busy = a.status === 409 ? a : b
    expect(await busy.json()).toEqual({ error: 'client-busy' })
    expect(stateOf().board.revision).toBe(2)
  })

  it('client-expired: a tab id older than 90 days without a mark is 409', async () => {
    const old = newId('tab', Date.parse(NOW) - 91 * DAY_MS)
    const before = readBoardFile(server, user.id, board)
    const res = await postOps(user, board, batch({ clientId: old }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'client-expired' })
    expect(readBoardFile(server, user.id, board).equals(before)).toBe(true)
  })

  it('revision-ahead: a baseRevision beyond the board is 409', async () => {
    const res = await postOps(user, board, batch({ baseRevision: 99 }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'revision-ahead' })
    expect(stateOf().board.revision).toBe(0)
  })
})

describe('Review Focus 5: client clock skew', () => {
  it('a 2099 client timestamp never reaches the board, marks or backups', async () => {
    const FUTURE = '2099-01-01T00:00:00.000Z'
    // Tab B committed 89 days ago by the server clock.
    server.clock.set(new Date(Date.parse(NOW) - 89 * DAY_MS).toISOString())
    const old = await createBoard(user, 'Skew')
    const tabB = tabNow(server)
    const resB = await postOps(user, old, {
      clientId: tabB,
      seq: 1,
      baseRevision: 0,
      ops: [noteCreate({ text: 'from B', at: server.clock.now().toISOString() })],
    })
    expect(resB.status).toBe(200)

    server.clock.set(NOW)
    const tabA = tabNow(server)
    const noteId = newId('note')
    const resA = await postOps(user, old, {
      clientId: tabA,
      seq: 1,
      baseRevision: 1,
      ops: [noteCreate({ id: noteId, text: 'from A', at: FUTURE })],
    })
    expect(resA.status).toBe(200)
    expect(await resA.json()).toMatchObject({ revision: 2, now: NOW })
    // A compaction: its snapshot and backup names come from the server clock too.
    await compactBoard(server, user.id, old)

    const state = stateOf(old)
    expect(state.board.updatedAt).toBe(NOW)
    expect(state.board.clients[tabA]?.seenAt).toBe(NOW)
    expect(state.board.clients[tabB]).toMatchObject({ lastSeq: 1, lastRevision: 1 })
    expect(state.notes.get(noteId)).toMatchObject({ createdAt: FUTURE, updatedAt: FUTURE })
    const dir = boardDir(server, user.id, old)
    const names = ['backups', 'quarantine'].flatMap((d) => readdirSync(`${dir}/${d}`))
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) expect(name).not.toContain('2099')
    expect(readFileSync(`${dir}/board.jsonl`, 'utf8')).toContain(FUTURE)
  })
})

describe('StoreError mapping in onError', () => {
  const thrown = (e: unknown) => {
    const app = new Hono<AppEnv>()
    app.onError(onError)
    app.get('/x', () => {
      throw e
    })
    return app.request('/x')
  }

  it('maps every store code to its status and body, with no message echoed', async () => {
    const plain: [StoreErrorCode, number][] = [
      ['not-found', 404],
      ['client-busy', 409],
      ['client-expired', 409],
      ['revision-ahead', 409],
      ['board-limit', 409],
      ['storage', 503],
    ]
    for (const [code, status] of plain) {
      const res = await thrown(new StoreError(code))
      expect(res.status, code).toBe(status)
      expect(await res.json()).toEqual({ error: code })
    }
    const unreadable = await thrown(new StoreError('board-unreadable', { reason: 'missing-board' }))
    expect(unreadable.status).toBe(409)
    expect(await unreadable.json()).toEqual({ error: 'board-unreadable', reason: 'missing-board' })
    const rejected = await thrown(
      new StoreError('rejected', {
        opError: new OpError('not-found', 'SECRET detail', { index: 3 }),
      }),
    )
    expect(rejected.status).toBe(422)
    expect(await rejected.json()).toEqual({ error: 'rejected', code: 'not-found', index: 3 })
  })

  it('unknown errors are still a 500', async () => {
    const res = await thrown(new Error('boom'))
    expect(res.status).toBe(500)
  })
})
