import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId, parseBoard } from '@papertie/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createHostApp } from '../src/host'
import { boardDir, compactBoard, createBoard, noteCreate, postOps } from './helpers/boards'
import { APP_ORIGIN, startTestServer, type TestServer } from './helpers/harness'
import { png } from './helpers/images'
import { openEvents } from './helpers/sse'

const NOW = '2026-10-27T10:00:00.000Z'

let server: TestServer | null = null
const dirs: string[] = []
afterEach(async () => {
  await server?.close()
  server = null
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'papertie-one-'))
  dirs.push(d)
  return d
}

const batch = (s: TestServer, text = 'hello', seq = 1, baseRevision = 0) => ({
  clientId: newId('tab', s.clock.now().getTime()),
  seq,
  baseRevision,
  ops: [noteCreate({ at: NOW, text })],
})

describe('the server over HTTP', () => {
  it('/api/health says ok, and nothing of a mode', async () => {
    server = await startTestServer()
    const r = await fetch(`${server.url}/api/health`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it('the routes work without a session: boards, ops, reads, meta, export', async () => {
    server = await startTestServer()
    const { user } = server
    expect(user.id).toMatch(/^user_[0-9A-Z]{26}$/)
    expect(await (await user.request('/api/boards')).json()).toEqual([])
    const board = await createBoard(user)
    expect((await postOps(user, board, batch(server))).status).toBe(200)
    const read = await user.request(`/api/boards/${board}`)
    expect(read.status).toBe(200)
    expect(parseBoard(await read.text()).state?.notes.size).toBe(1)
    const meta = await user.request(`/api/boards/${board}/meta`)
    expect(((await meta.json()) as { notes: number }).notes).toBe(1)
    const exported = await user.request(`/api/boards/${board}/export?format=jsonl`)
    expect(exported.status).toBe(200)
    // Stored under the one user.
    expect(existsSync(boardDir(server, user.id, board))).toBe(true)
  })

  it('serves an uploaded photo back', async () => {
    server = await startTestServer()
    const { user } = server
    const board = await createBoard(user)
    const form = new FormData()
    form.append(
      'file',
      new File([new Uint8Array(await png(400, 300))], 'p.png', { type: 'image/png' }),
    )
    const up = await user.request(`/api/boards/${board}/assets`, { method: 'POST', body: form })
    expect(up.status).toBe(201)
    const { id } = ((await up.json()) as { asset: { id: string } }).asset
    expect((await user.request(`/api/assets/${id}/256`)).status).toBe(200)
  })

  it('has no account routes, sets no cookie, and keeps no auth database or mail', async () => {
    server = await startTestServer()
    const gets = [
      '/api/auth/get-session',
      '/api/auth/session',
      '/api/account',
      '/api/account/sessions',
      '/api/session',
      '/api/me',
    ]
    for (const path of gets) {
      const r = await server.user.request(path)
      expect(r.status, path).toBe(404)
      expect(await r.json()).toEqual({ error: 'not-found' })
    }
    const posts = [
      '/api/auth/sign-up/email',
      '/api/auth/sign-in/email',
      '/api/auth/sign-out',
      '/api/auth/request-password-reset',
      '/api/auth/reset-password',
      '/api/auth/send-verification-email',
      '/api/auth/revoke-sessions',
      '/api/account/delete',
    ]
    for (const path of posts) {
      const r = await server.user.request(path, {
        method: 'POST',
        body: JSON.stringify({ email: 'a@example.test', password: 'correct horse battery' }),
      })
      expect(r.status, path).toBe(404)
      expect(r.headers.getSetCookie(), path).toEqual([])
    }
    // The board routes answer with no cookie at all, and set none.
    const list = await server.user.request('/api/boards')
    expect(list.status).toBe(200)
    expect(list.headers.getSetCookie()).toEqual([])
    expect(existsSync(join(server.dataDir, 'auth.db'))).toBe(false)
    expect(existsSync(join(server.dataDir, 'dev-mail'))).toBe(false)
  })

  it('the origin check still holds: the app scheme passes, others and none are refused', async () => {
    server = await startTestServer()
    const post = (origin: string | null) =>
      fetch(`${server?.url}/api/boards`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(origin === null ? {} : { Origin: origin }),
        },
        body: JSON.stringify({ name: 'B' }),
      })
    expect((await post(APP_ORIGIN)).status).toBe(201)
    expect((await post(server.url)).status).toBe(201)
    for (const bad of [null, 'http://evil.test', 'papertie://evil', 'papertie://app.evil']) {
      const r = await post(bad)
      expect(r.status, String(bad)).toBe(403)
      expect(await r.json()).toEqual({ error: 'forbidden-origin' })
    }
  })

  it('keeps the limits: an ops body over its size is refused', async () => {
    server = await startTestServer()
    const board = await createBoard(server.user)
    const big = JSON.stringify({ ...batch(server), pad: 'x'.repeat(2 * 1_048_576) })
    expect((await postOps(server.user, board, big)).status).toBe(413)
  })
})

describe('the event stream', () => {
  it('carries commits, and with no session to recheck it is never hung up', async () => {
    server = await startTestServer({
      config: { sseKeepaliveMs: 20 },
    })
    const board = await createBoard(server.user)
    const stream = await openEvents(server.user, board)
    try {
      let ended = false
      void stream.closed.then(() => {
        ended = true
      })
      // Many keepalives go by.
      await new Promise((r) => setTimeout(r, 200))
      expect(ended).toBe(false)
      expect((await postOps(server.user, board, batch(server))).status).toBe(200)
      expect(await stream.next(2000)).toEqual({ event: 'hello', data: { revision: 0 } })
      const m = await stream.next(2000)
      expect(m.event).toBe('commit')
      expect(m.id).toBe('1')
    } finally {
      stream.close()
    }
  })
})

describe('the one user', () => {
  it('is made once, stored in the data dir, and the same after a restart', async () => {
    const dataDir = await tempDir()
    server = await startTestServer({ dataDir })
    const first = server.user.id
    const board = await createBoard(server.user)
    expect((await postOps(server.user, board, batch(server))).status).toBe(200)
    await server.close()
    server = null
    const stored = JSON.parse(readFileSync(join(dataDir, 'local-user.json'), 'utf8'))
    expect(stored).toEqual({ id: first })

    server = await startTestServer({ dataDir })
    expect(server.user.id).toBe(first)
    const boards = (await (await server.user.request('/api/boards')).json()) as { id: string }[]
    expect(boards.map((b) => b.id)).toEqual([board])
    const read = await server.user.request(`/api/boards/${board}`)
    expect(parseBoard(await read.text()).state?.notes.size).toBe(1)
  })

  it('a damaged user file stops the start rather than making a second user', async () => {
    const dataDir = await tempDir()
    server = await startTestServer({ dataDir })
    await server.close()
    server = null
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dataDir, 'local-user.json'), '{"id":"not-a-user"}')
    await expect(startTestServer({ dataDir })).rejects.toThrow(/user file/)
  })
})

describe('POST /api/data/delete (delete all data)', () => {
  const del = (s: TestServer, confirm: unknown) =>
    s.user.request('/api/data/delete', { method: 'POST', body: JSON.stringify({ confirm }) })

  it('needs the typed confirmation', async () => {
    server = await startTestServer()
    const board = await createBoard(server.user)
    for (const wrong of [undefined, '', 'yes', 'delete everything', 42]) {
      const r = await del(server, wrong)
      expect(r.status, String(wrong)).toBe(400)
      expect(await r.json()).toEqual({ error: 'invalid' })
    }
    const boards = (await (await server.user.request('/api/boards')).json()) as { id: string }[]
    expect(boards.map((b) => b.id)).toEqual([board])
  })

  it('removes the board, its photos and backups, and leaves one empty board', async () => {
    server = await startTestServer()
    const { user } = server
    const board = await createBoard(user, 'Mine')
    expect((await postOps(user, board, batch(server, 'one'))).status).toBe(200)
    const form = new FormData()
    form.append(
      'file',
      new File([new Uint8Array(await png(400, 300))], 'p.png', { type: 'image/png' }),
    )
    const up = await user.request(`/api/boards/${board}/assets`, { method: 'POST', body: form })
    expect(up.status).toBe(201)
    const asset = ((await up.json()) as { asset: { id: string } }).asset.id
    expect((await user.request(`/api/assets/${asset}/256`)).status).toBe(200)
    expect(await server.deps.quota?.usage(user.id)).toBeGreaterThan(0)
    await compactBoard(server, user.id, board)
    const dir = boardDir(server, user.id, board)
    expect(readdirSync(join(dir, 'backups')).length).toBeGreaterThan(0)

    const r = await del(server, ' Delete ')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })

    expect(existsSync(dir)).toBe(false)
    expect(readdirSync(join(server.dataDir, 'trash'))).toEqual([])
    expect((await user.request(`/api/boards/${board}`)).status).toBe(404)
    expect((await user.request(`/api/assets/${asset}/256`)).status).toBe(404)
    const boards = (await (await user.request('/api/boards')).json()) as {
      id: string
      name: string
    }[]
    expect(boards).toHaveLength(1)
    const fresh = boards[0]
    if (!fresh) throw new Error('no board')
    expect(fresh.id).not.toBe(board)
    const read = await user.request(`/api/boards/${fresh.id}`)
    expect(read.status).toBe(200)
    const state = parseBoard(await read.text()).state
    expect(state?.notes.size).toBe(0)
    expect(state?.board.revision).toBe(0)
    // The same user, who can go on writing.
    expect(JSON.parse(readFileSync(join(server.dataDir, 'local-user.json'), 'utf8'))).toEqual({
      id: user.id,
    })
    expect((await postOps(user, fresh.id, batch(server, 'two'))).status).toBe(200)
    // The photo count starts again from nothing.
    expect(await server.deps.quota?.usage(user.id)).toBe(0)
  })

  it('a deletion cut short is finished at the next start', async () => {
    const dataDir = await tempDir()
    server = await startTestServer({ dataDir })
    const board = await createBoard(server.user)
    const id = server.user.id
    await server.close()
    server = null
    // As if the process died right after moving the user's directory into trash/.
    const { renameSync } = await import('node:fs')
    renameSync(join(dataDir, 'users', id), join(dataDir, 'trash', id))
    server = await startTestServer({ dataDir })
    expect(readdirSync(join(dataDir, 'trash'))).toEqual([])
    const boards = (await (await server.user.request('/api/boards')).json()) as { id: string }[]
    expect(boards.map((b) => b.id)).not.toContain(board)
  })
})

describe('createHostApp (the desktop host)', () => {
  it('answers Requests through app.fetch with no port, and closes', async () => {
    const dataDir = await tempDir()
    const host = await createHostApp({ dataDir, webDist: null, logSink: () => {} })
    try {
      const health = await host.app.fetch(new Request(`${APP_ORIGIN}/api/health`))
      expect(await health.json()).toEqual({ ok: true })
      const made = await host.app.fetch(
        new Request(`${APP_ORIGIN}/api/boards`, {
          method: 'POST',
          headers: { Origin: APP_ORIGIN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Desk' }),
        }),
      )
      expect(made.status).toBe(201)
      const forged = await host.app.fetch(
        new Request(`${APP_ORIGIN}/api/boards`, {
          method: 'POST',
          headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Desk' }),
        }),
      )
      // Only the app's own origin is trusted.
      expect(forged.status).toBe(403)
      const list = await host.app.fetch(new Request(`${APP_ORIGIN}/api/boards`))
      expect(await list.json()).toHaveLength(1)
    } finally {
      await host.close()
    }
    const again = await createHostApp({ dataDir, webDist: null, logSink: () => {} })
    try {
      const list = await again.app.fetch(new Request(`${APP_ORIGIN}/api/boards`))
      expect(((await list.json()) as unknown[]).length).toBe(1)
    } finally {
      await again.close()
    }
  })
})
