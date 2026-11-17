import { readdirSync, writeFileSync } from 'node:fs'
import { parseBoard, serializeBoard } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  boardDir,
  boardFile,
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

let server: TestServer
let user: TestUser

beforeEach(async () => {
  server = await startTestServer()
  user = server.user
})
afterEach(async () => {
  await server.close()
})

const createRaw = (u: TestUser, body: string) => u.request('/api/boards', { method: 'POST', body })

describe('create and list', () => {
  it('creates a board at revision 0 on disk and lists it', async () => {
    const res = await createRaw(user, JSON.stringify({ name: 'My board' }))
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const board = (await res.json()) as { id: string; name: string; revision: number }
    expect(board).toMatchObject({ name: 'My board', revision: 0, recovered: false })
    expect(boardFile(server, user.id, board.id)).toBe(
      `${server.dataDir}/users/${user.id}/boards/${board.id}/board.jsonl`,
    )
    expect(readBoardFile(server, user.id, board.id).length).toBeGreaterThan(0)

    const list = await user.request('/api/boards')
    expect(list.status).toBe(200)
    expect(((await list.json()) as { id: string }[]).map((b) => b.id)).toEqual([board.id])
  })

  it('two first-board creates at once make one board: one makes it, the other is given it', async () => {
    // A fresh data folder opened by two boots at once (a reload during the first's create).
    const body = JSON.stringify({ name: 'My board', first: true })
    const [a, b] = await Promise.all([createRaw(user, body), createRaw(user, body)])
    const ja = (await a.json()) as { id: string; created: boolean }
    const jb = (await b.json()) as { id: string; created: boolean }
    expect(ja.id).toBe(jb.id)
    expect([ja.created, jb.created].sort()).toEqual([false, true])
    expect([a.status, b.status].sort()).toEqual([200, 201])
    const list = (await (await user.request('/api/boards')).json()) as { id: string }[]
    expect(list.map((x) => x.id)).toEqual([ja.id])
  })

  it('a first-board create where a board exists is given that board, and makes none', async () => {
    const kept = await createBoard(user, 'Kept')
    const res = await createRaw(user, JSON.stringify({ name: 'My board', first: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: kept, name: 'Kept', created: false })
    const list = (await (await user.request('/api/boards')).json()) as { id: string }[]
    expect(list).toHaveLength(1)
  })

  it('a bad name is 400 invalid, and nothing is created', async () => {
    for (const name of ['', 'x'.repeat(121), 5, null, undefined]) {
      const res = await createRaw(user, JSON.stringify({ name }))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid' })
    }
    for (const raw of ['not json', '[]', '"x"']) {
      const res = await createRaw(user, raw)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid' })
    }
    expect(await (await user.request('/api/boards')).json()).toEqual([])
    const ok = await createRaw(user, JSON.stringify({ name: 'x'.repeat(120) }))
    expect(ok.status).toBe(201)
  })

  it('a body over 64 KB is 413 too-large', async () => {
    const res = await createRaw(user, JSON.stringify({ name: 'x'.repeat(65_536) }))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'too-large' })
  })

  it('maxBoardsPerUser reached is 409 board-limit', async () => {
    await server.close()
    server = await startTestServer({ config: { limits: { maxBoardsPerUser: 2 } } })
    user = server.user
    await createBoard(user)
    await createBoard(user)
    const res = await createRaw(user, JSON.stringify({ name: 'third' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'board-limit' })
    expect(await (await user.request('/api/boards')).json()).toHaveLength(2)
  })
})

describe('GET /api/boards/:id (NDJSON)', () => {
  it('streams the file bytes with the sync headers', async () => {
    const id = await createBoard(user, 'Stream')
    const ops = await postOps(user, id, {
      clientId: tabNow(server),
      seq: 1,
      baseRevision: 0,
      ops: [noteCreate({ text: 'Grüße', at: NOW })],
    })
    expect(ops.status).toBe(200)

    const res = await user.request(`/api/boards/${id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/x-ndjson; charset=utf-8$/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-papertie-revision')).toBe('1')
    expect(res.headers.get('x-papertie-now')).toBe(server.clock.now().toISOString())
    expect(res.headers.get('x-papertie-recovered')).toBeNull()
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(readBoardFile(server, user.id, id))).toBe(true)
    const parsed = parseBoard(body.toString('utf8'))
    expect(parsed.state).not.toBeNull()
    if (parsed.state) expect(serializeBoard(parsed.state)).toBe(body.toString('utf8'))
  })

  it('X-Papertie-Now follows the injected clock', async () => {
    const id = await createBoard(user)
    server.clock.set('2030-01-02T03:04:05.678Z')
    const res = await user.request(`/api/boards/${id}`)
    expect(res.headers.get('x-papertie-now')).toBe('2030-01-02T03:04:05.678Z')
  })

  it('streams a board larger than one 64 KB chunk intact', async () => {
    const id = await createBoard(user)
    const text = '€'.repeat(20_000)
    for (let seq = 1; seq <= 3; seq++) {
      const res = await postOps(user, id, {
        clientId: tabNow(server),
        seq: 1,
        baseRevision: seq - 1,
        ops: [noteCreate({ text, at: NOW })],
      })
      expect(res.status).toBe(200)
    }
    const file = readBoardFile(server, user.id, id)
    expect(file.length).toBeGreaterThan(65_536 * 2)
    const res = await user.request(`/api/boards/${id}`)
    expect(Buffer.from(await res.arrayBuffer()).equals(file)).toBe(true)
  })

  it('an unreadable board is 409 board-unreadable and the file is untouched', async () => {
    const id = await createBoard(user)
    const file = boardFile(server, user.id, id)
    const text = readBoardFile(server, user.id, id)
      .toString('utf8')
      .replace('"schemaVersion":6', '"schemaVersion":7')
    expect(text).toContain('"schemaVersion":7')
    writeFileSync(file, text)

    const get = await user.request(`/api/boards/${id}`)
    expect(get.status).toBe(409)
    expect(await get.json()).toEqual({ error: 'board-unreadable', reason: 'unsupported-version' })
    const post = await postOps(user, id, {
      clientId: tabNow(server),
      seq: 1,
      baseRevision: 0,
      ops: [noteCreate({ at: NOW })],
    })
    expect(post.status).toBe(409)
    expect(await post.json()).toEqual({ error: 'board-unreadable', reason: 'unsupported-version' })
    expect(readBoardFile(server, user.id, id).toString('utf8')).toBe(text)
  })
})

describe('meta and recovery', () => {
  it('meta returns id, name, revision and no recovery for a healthy board', async () => {
    const id = await createBoard(user, 'Meta')
    const res = await user.request(`/api/boards/${id}/meta`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id,
      name: 'Meta',
      revision: 0,
      recovery: null,
      notes: 0,
      extent: null,
    })
  })

  // With no camera remembered, the page opens the board fitted, from the view
  // that fits it (`GET /region`), not by loading it whole first.
  it('meta says how many notes the board has and the rect that holds them all', async () => {
    const id = await createBoard(user, 'Extent')
    const at = (x: number, y: number) => ({ ...noteCreate({ at: NOW }).note, x, y })
    const res = await postOps(user, id, {
      clientId: tabNow(server),
      seq: 1,
      baseRevision: 0,
      ops: [
        { op: 'note.create', note: at(-500, 40) },
        { op: 'note.create', note: at(900, -300) },
        { op: 'note.create', note: at(100, 700) },
      ],
    })
    expect(res.status).toBe(200)
    const meta = (await (await user.request(`/api/boards/${id}/meta`)).json()) as {
      notes: number
      extent: unknown
    }
    // Each note is 240 × 160.
    expect(meta.notes).toBe(3)
    expect(meta.extent).toEqual({ x0: -500, y0: -300, x1: 1140, y1: 860 })
  })

  it('a truncated file is recovered, flagged, and the notice can be dismissed', async () => {
    const id = await createBoard(user)
    for (const seq of [1, 2]) {
      const res = await postOps(user, id, {
        clientId: tabNow(server),
        seq: 1,
        baseRevision: seq - 1,
        ops: [noteCreate({ text: `note ${seq}`, at: NOW })],
      })
      expect(res.status).toBe(200)
    }
    // Cut the last note line mid-way (no trailing newline, no end record).
    await compactBoard(server, user.id, id)
    const file = boardFile(server, user.id, id)
    const text = readBoardFile(server, user.id, id).toString('utf8')
    const lines = text.split('\n')
    const last = lines.findIndex((l) => l.includes('note 2'))
    const cut = [...lines.slice(0, last), (lines[last] as string).slice(0, 40)].join('\n')
    writeFileSync(file, cut)

    const res = await user.request(`/api/boards/${id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-papertie-recovered')).toBe('1')
    await res.arrayBuffer()
    const meta = (await (await user.request(`/api/boards/${id}/meta`)).json()) as {
      recovery: { integrity: string } | null
    }
    expect(meta.recovery?.integrity).toBe('missing-eof')

    const del = await user.request(`/api/boards/${id}/recovery`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    expect(await del.text()).toBe('')
    const after = await user.request(`/api/boards/${id}/meta`)
    expect(((await after.json()) as { recovery: unknown }).recovery).toBeNull()
    const again = await user.request(`/api/boards/${id}`)
    expect(again.headers.get('x-papertie-recovered')).toBeNull()
    await again.arrayBuffer()
    expect(readdirSync(`${boardDir(server, user.id, id)}/quarantine`).length).toBeGreaterThan(0)
  })
})

describe('ids and ownership', () => {
  it('malformed and unknown board ids are the same 404', async () => {
    const unknown = `board_${'0'.repeat(26)}`
    for (const id of ['nope', unknown]) {
      for (const [method, suffix] of [
        ['GET', ''],
        ['GET', '/meta'],
        ['DELETE', '/recovery'],
        ['POST', '/ops'],
      ] as const) {
        const res = await user.request(`/api/boards/${id}${suffix}`, {
          method,
          body: method === 'POST' ? '{}' : undefined,
        })
        expect(res.status, `${method} ${suffix}`).toBe(404)
        expect(await res.json()).toEqual({ error: 'not-found' })
      }
    }
  })
})
