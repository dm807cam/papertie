import { newId } from '@papertie/core'
import { Hono } from 'hono'
import type { AppEnv } from '../src/http/env'
import { onError } from '../src/http/errors'
import { serverId } from '../src/ids'
import { createLogger, LOG_KEYS } from '../src/log'
import { requestLog } from '../src/middleware/logging'
import { idParam, requireBoardOwner } from '../src/middleware/owner'
import { api, postJson } from './helpers/client'
import { startTestServer, type TestServer } from './helpers/harness'

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CSP,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
}

function expectSecurityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(res.headers.get(name), name).toBe(value)
  }
}

let servers: TestServer[] = []
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer(opts)
  servers.push(s)
  return s
}
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()))
  servers = []
})

describe('security headers', () => {
  it('are on 200, 404, 400, 403 and error responses', async () => {
    const s = await server()
    const responses = [
      await api(s, '/api/health'),
      await api(s, '/api/boards'),
      await api(s, '/api/nope'),
      await fetch(`${s.url}/not-api`),
      await postJson(s, '/api/data/delete', 'not an object'),
      await api(s, '/api/data/delete', { method: 'POST', body: '{nope' }),
      await fetch(`${s.url}/api/data/delete`, { method: 'POST' }),
    ]
    expect(responses.map((r) => r.status)).toEqual([200, 200, 404, 404, 400, 400, 403])
    for (const r of responses) {
      if (new URL(r.url).pathname.startsWith('/api/')) {
        expect(r.headers.get('cache-control'), r.url).toBe('no-store')
      }
      expectSecurityHeaders(r)
    }
  })
})

describe('unknown routes and error mapping', () => {
  it('unknown /api/* routes give 404 not-found', async () => {
    const s = await server()
    for (const path of ['/api/nope', '/api/data/nope']) {
      const res = await api(s, path)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not-found' })
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('malformed JSON where a route parses it gives 400 invalid', async () => {
    const s = await server()
    const res = await api(s, '/api/data/delete', { method: 'POST', body: '{"confirm":' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid' })
  })
})

describe('csrf origin check', () => {
  // A confirmation that is not the word: a 400 once through, and nothing is deleted.
  const body = JSON.stringify({ confirm: 'not the word' })
  const post = (s: TestServer, headers: Record<string, string>) =>
    fetch(`${s.url}/api/data/delete`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', ...headers },
    })

  it('rejects state-changing requests with no or an untrusted Origin', async () => {
    const s = await server()
    const untrusted: Record<string, string>[] = [
      {},
      { Origin: 'https://evil.example' },
      { Origin: 'null' },
    ]
    for (const headers of untrusted) {
      const res = await post(s, headers)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden-origin' })
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${s.url}/api/anything`, { method, body: '{}' })
      expect(res.status).toBe(403)
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('lets trusted origins through', async () => {
    const s = await server()
    expect((await post(s, { Origin: s.url })).status).toBe(400)
    expect((await post(s, { Origin: 'papertie://app' })).status).toBe(400)
  })

  it('does not check GET or HEAD', async () => {
    const s = await server()
    expect((await fetch(`${s.url}/api/health`)).status).toBe(200)
    expect((await fetch(`${s.url}/api/health`, { method: 'HEAD' })).status).toBe(200)
  })
})

describe('body limits', () => {
  it('JSON bodies over 64 KB give 413 too-large', async () => {
    const s = await server()
    const pad = (n: number) => `{"confirm":"${'x'.repeat(n)}"}`
    const base = pad(0).length
    const over = await api(s, '/api/data/delete', {
      method: 'POST',
      body: pad(65_537 - base),
    })
    expect(over.status).toBe(413)
    expect(await over.json()).toEqual({ error: 'too-large' })
    expect(over.headers.get('cache-control')).toBe('no-store')
    expectSecurityHeaders(over)

    const exact = await api(s, '/api/data/delete', {
      method: 'POST',
      body: pad(65_536 - base),
    })
    expect(exact.status).toBe(400)
  })

  it('a chunked body with no Content-Length over the limit gives 413', async () => {
    const s = await server()
    const chunk = new TextEncoder().encode('x'.repeat(4_096))
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 17) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const res = await fetch(`${s.url}/api/data/delete`, {
      method: 'POST',
      headers: { Origin: s.url, 'Content-Type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'too-large' })
  })
})

describe('request log', () => {
  it('logs the route template and only allowlisted keys', async () => {
    const s = await server()
    const u = s.user
    s.logs.length = 0
    expect((await u.request('/api/boards')).status).toBe(200)
    await api(s, '/api/zz-secret-path-123')
    const lines = s.logs.map((l) => JSON.parse(l) as Record<string, unknown>)
    const me = lines.find((l) => l.msg === 'request' && l.route === '/api/boards')
    expect(me).toMatchObject({ method: 'GET', route: '/api/boards', status: 200 })
    expect(typeof me?.ms).toBe('number')
    const allowed = new Set<string>([...LOG_KEYS, 'level', 'msg'])
    for (const line of lines) {
      for (const k of Object.keys(line)) expect(allowed.has(k), k).toBe(true)
    }
    const unmatched = lines.find((l) => l.msg === 'request' && l.status === 404)
    expect(unmatched?.route).toBe('(unmatched)')
    expect(s.logs.join('\n')).not.toContain('zz-secret-path-123')
  })

  it('logs templates for parameterised routes, never the raw path', async () => {
    const lines: Record<string, unknown>[] = []
    const app = new Hono<AppEnv>()
    app.use('*', requestLog(createLogger((l) => lines.push(JSON.parse(l)))))
    app.get('/api/boards/:id', (c) => c.json({}))
    await app.request('/api/boards/board_SECRET')
    expect(lines[0]).toMatchObject({ route: '/api/boards/:id', status: 200 })
    expect(JSON.stringify(lines)).not.toContain('SECRET')
  })
})

describe('idParam and requireBoardOwner', () => {
  it('idParam: 404 unless the parameter is an id of the prefix', async () => {
    const app = new Hono<AppEnv>()
    app.onError(onError)
    app.get('/notes/:noteId', idParam('noteId', 'note'), (c) =>
      c.json({ id: c.req.param('noteId') }),
    )
    const good = newId('note')
    expect((await app.request(`/notes/${good}`)).status).toBe(200)
    for (const bad of [newId('board'), 'note_short', 'x', good.toLowerCase(), `${good}0`]) {
      const res = await app.request(`/notes/${bad}`)
      expect(res.status, bad).toBe(404)
      expect(await res.json()).toEqual({ error: 'not-found' })
    }
  })

  it('requireBoardOwner: 404 for malformed, unknown and other users’ boards', async () => {
    const s = await server()
    const store = s.deps.store
    if (!store) throw new Error('store not wired')
    const owner = serverId('user')
    const other = serverId('user')
    const board = await store.createBoard(owner, 'Mine')

    let current = owner
    const app = new Hono<AppEnv>()
    app.onError(onError)
    app.use('*', async (c, next) => {
      c.set('user', { id: current })
      await next()
    })
    app.get('/boards/:id', requireBoardOwner(store), (c) => c.json({ ok: true }))

    expect((await app.request(`/boards/${board.id}`)).status).toBe(200)
    for (const id of ['board_nope', 'board_%2E%2E', newId('board')]) {
      const res = await app.request(`/boards/${id}`)
      expect(res.status, id).toBe(404)
      expect(await res.json()).toEqual({ error: 'not-found' })
    }
    current = other
    const res = await app.request(`/boards/${board.id}`)
    expect(res.status).toBe(404)
  })
})
