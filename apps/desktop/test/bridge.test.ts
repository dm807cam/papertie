import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@papertie/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createHostApp, type HostApp, APP_ORIGIN as SERVER_ORIGIN } from '../../server/src/host'
import { noteCreate } from '../../server/test/helpers/boards'
import { readZip } from '../../server/test/helpers/zip'
import { APP_ORIGIN, createBridge, type Fetcher } from '../src/bridge'
import { OpenedFiles } from '../src/openedFiles'

const NOW = '2026-11-14T10:00:00.000Z'
const MB = 1_048_576

const dirs: string[] = []
const hosts: HostApp[] = []
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'papertie-desktop-'))
  dirs.push(d)
  return d
}

/** A built web app of a few files, with a secret beside it (outside the root). */
async function webDist(): Promise<string> {
  const root = await tempDir()
  const dist = join(root, 'dist')
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Papertie</title>')
  await writeFile(join(dist, 'assets', 'app-1a2b.js'), 'export const x = 1')
  await writeFile(join(dist, 'assets', 'app-1a2b.css'), 'html{}')
  await writeFile(join(dist, 'assets', 'face-3c4d.woff2'), new Uint8Array([0x77, 0x4f, 0x46, 0x32]))
  await writeFile(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeFile(join(dist, 'stage.css'), 'html{background:#8b6b47}')
  await writeFile(join(root, 'secret.txt'), 'not for the page')
  return dist
}

/** The bridge over the real app, on a fresh data dir. */
async function realBridge(opts: { opened?: OpenedFiles } = {}) {
  const host = await createHostApp({
    dataDir: await tempDir(),
    webDist: await webDist(),
    logSink: () => {},
  })
  hosts.push(host)
  return { host, handle: createBridge({ app: host.app, opened: opts.opened }) }
}

const url = (path: string) => `${APP_ORIGIN}${path}`
const writeHeaders = { Origin: APP_ORIGIN, 'Content-Type': 'application/json' }

/** A batch of one new note, from a tab of its own. */
const noteBatch = (text: string) =>
  JSON.stringify({
    clientId: newId('tab', Date.now()),
    seq: 1,
    baseRevision: 0,
    ops: [noteCreate({ at: NOW, text })],
  })

async function onlyBoard(handle: (r: Request) => Promise<Response>): Promise<string> {
  const res = await handle(new Request(url('/api/boards')))
  const list = (await res.json()) as Array<{ id: string }>
  if (list.length > 0) return (list[0] as { id: string }).id
  const made = await handle(
    new Request(url('/api/boards'), {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ name: 'Board' }),
    }),
  )
  expect(made.status).toBe(201)
  return ((await made.json()) as { id: string }).id
}

/** A body of `bytes` bytes, in 64 KB chunks, sent as a stream. */
function streamOf(bytes: number): { body: ReadableStream<Uint8Array>; sha: string } {
  const hash = createHash('sha256')
  const chunk = 65_536
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= bytes) return c.close()
      const n = Math.min(chunk, bytes - sent)
      const part = new Uint8Array(n)
      for (let i = 0; i < n; i++) part[i] = (sent + i) % 251
      sent += n
      c.enqueue(part)
    },
  })
  const all = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) all[i] = i % 251
  hash.update(all)
  return { body, sha: hash.digest('hex') }
}

describe('the protocol bridge: requests and responses', () => {
  it('gives an /api request to the app with its method, headers and body, and its answer back', async () => {
    const seen: Array<{ method: string; url: string; headers: Headers; body: string }> = []
    const fake: Fetcher = {
      async fetch(req) {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: await req.text(),
        })
        return new Response('{"ok":true}', {
          status: 207,
          headers: { 'Content-Type': 'application/json', 'X-Papertie-Revision': '12' },
        })
      },
    }
    const handle = createBridge({ app: fake })
    const res = await handle(
      new Request(url('/api/boards/b1/ops?since=3'), {
        method: 'PUT',
        headers: { ...writeHeaders, 'X-Custom': 'kept' },
        body: '{"a":1}',
      }),
    )
    expect(res.status).toBe(207)
    expect(res.headers.get('X-Papertie-Revision')).toBe('12')
    expect(await res.json()).toEqual({ ok: true })
    expect(seen).toHaveLength(1)
    const [r] = seen
    expect(r?.method).toBe('PUT')
    expect(r?.url).toBe(url('/api/boards/b1/ops?since=3'))
    expect(r?.headers.get('Origin')).toBe(APP_ORIGIN)
    expect(r?.headers.get('X-Custom')).toBe('kept')
    expect(r?.body).toBe('{"a":1}')
  })

  it('waits for the app while the data opens', async () => {
    let open: (f: Fetcher) => void = () => {}
    const app = new Promise<Fetcher>((r) => {
      open = r
    })
    const handle = createBridge({ app })
    const answer = handle(new Request(url('/api/health')))
    open({ fetch: () => new Response('later') })
    expect(await (await answer).text()).toBe('later')
  })

  it('streams an upload of 25 MB to the app as it comes, whole', async () => {
    let got = ''
    let chunks = 0
    const fake: Fetcher = {
      async fetch(req) {
        const hash = createHash('sha256')
        const reader = (req.body as ReadableStream<Uint8Array>).getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks++
          hash.update(value)
        }
        got = hash.digest('hex')
        return new Response(null, { status: 204 })
      },
    }
    const { body, sha } = streamOf(25 * MB)
    const res = await createBridge({ app: fake })(
      new Request(url('/api/boards/b1/assets'), {
        method: 'POST',
        headers: { Origin: APP_ORIGIN },
        body,
        duplex: 'half',
      } as RequestInit),
    )
    expect(res.status).toBe(204)
    expect(got).toBe(sha)
    expect(chunks).toBeGreaterThan(1)
  })

  it('streams a response body as the app writes it, not once it ends', async () => {
    let finish: () => void = () => {}
    const fake: Fetcher = {
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('first\n'))
              finish = () => {
                c.enqueue(new TextEncoder().encode('second\n'))
                c.close()
              }
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    }
    const res = await createBridge({ app: fake })(new Request(url('/api/boards/b1/events')))
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('first\n')
    finish()
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toBe('second\n')
    expect((await reader.read()).done).toBe(true)
  })

  it('a failure in the app is a 500, never a thrown handler', async () => {
    const fake: Fetcher = {
      fetch: () => {
        throw new Error('boom')
      },
    }
    const res = await createBridge({ app: fake })(new Request(url('/api/health')))
    expect(res.status).toBe(500)
  })

  it('answers only papertie://app: another host is a 404 the app never sees', async () => {
    let asked = 0
    const fake: Fetcher = {
      fetch: () => {
        asked++
        return new Response('app')
      },
    }
    const handle = createBridge({ app: fake })
    expect((await handle(new Request('papertie://other/api/health'))).status).toBe(404)
    expect((await handle(new Request('papertie://app.evil/index.html'))).status).toBe(404)
    expect(asked).toBe(0)
  })
})

describe('the protocol bridge over the app', () => {
  it("the page's origin is the one the server trusts", () => {
    expect(APP_ORIGIN).toBe(SERVER_ORIGIN)
  })

  it('health, with the strict CSP on every answer', async () => {
    const { handle } = await realBridge()
    const res = await handle(new Request(url('/api/health')))
    expect(await res.json()).toEqual({ ok: true })
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    const page = await handle(new Request(url('/')))
    expect(page.headers.get('Content-Security-Policy')).toBe(csp)
  })

  it('a write from papertie://app is trusted; from anywhere else it is refused', async () => {
    const { handle } = await realBridge()
    const boardId = await onlyBoard(handle)
    const ops = (origin: string) =>
      handle(
        new Request(url(`/api/boards/${boardId}/ops`), {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: noteBatch('From the bridge'),
        }),
      )
    expect((await ops('http://localhost:5173')).status).toBe(403)
    expect((await ops('null')).status).toBe(403)
    const ok = await ops(APP_ORIGIN)
    expect(ok.status, await ok.clone().text()).toBe(200)
  })

  it("a write with no Origin (Chromium sends none on this scheme) is the page's own", async () => {
    const { handle } = await realBridge()
    const boardId = await onlyBoard(handle)
    const res = await handle(
      new Request(url(`/api/boards/${boardId}/ops`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: noteBatch('From the page'),
      }),
    )
    expect(res.status, await res.clone().text()).toBe(200)
    // A board made the same way.
    const made = await handle(
      new Request(url('/api/boards'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Second' }),
      }),
    )
    expect(made.status).toBe(201)
  })

  it('a streamed upload with no Origin reaches the app whole, with the Origin set', async () => {
    let got = ''
    let origin: string | null = null
    const fake: Fetcher = {
      async fetch(req) {
        origin = req.headers.get('Origin')
        got = createHash('sha256')
          .update(new Uint8Array(await req.arrayBuffer()))
          .digest('hex')
        return new Response(null, { status: 204 })
      },
    }
    const { body, sha } = streamOf(3 * MB)
    await createBridge({ app: fake })(
      new Request(url('/api/boards/b1/assets'), {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body,
        duplex: 'half',
      } as RequestInit),
    )
    expect(origin).toBe(APP_ORIGIN)
    expect(got).toBe(sha)
  })

  it('the board loads as NDJSON, streamed', async () => {
    const { handle } = await realBridge()
    const boardId = await onlyBoard(handle)
    const res = await handle(new Request(url(`/api/boards/${boardId}`)))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/^application\/x-ndjson/)
    const lines = (await res.text()).trim().split('\n')
    expect(JSON.parse(lines[0] as string)).toMatchObject({ type: 'board', id: boardId })
  })

  it('the event stream answers at once and keeps going; a hang-up ends it', async () => {
    const { handle } = await realBridge()
    const boardId = await onlyBoard(handle)
    const res = await handle(new Request(url(`/api/boards/${boardId}/events`)))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/^text\/event-stream/)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    let text = ''
    while (!text.includes('retry:')) {
      const { value, done } = await reader.read()
      if (done) throw new Error('stream ended')
      text += new TextDecoder().decode(value)
    }
    // A commit made meanwhile arrives on the open stream.
    await handle(
      new Request(url(`/api/boards/${boardId}/ops`), {
        method: 'POST',
        headers: writeHeaders,
        body: noteBatch('Live'),
      }),
    )
    while (!text.includes('event: commit')) {
      const { value, done } = await reader.read()
      if (done) throw new Error('stream ended')
      text += new TextDecoder().decode(value)
    }
    await reader.cancel()
  })

  it('the .papertie export streams a zip; it comes back in through an upload and is staged', async () => {
    const { handle } = await realBridge()
    const boardId = await onlyBoard(handle)
    await handle(
      new Request(url(`/api/boards/${boardId}/ops`), {
        method: 'POST',
        headers: writeHeaders,
        body: noteBatch('Exported'),
      }),
    )
    const res = await handle(new Request(url(`/api/boards/${boardId}/export?format=papertie`)))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/zip')
    const zip = Buffer.from(await res.arrayBuffer())
    expect(readZip(zip).map((e) => e.name)).toContain('board.jsonl')

    const form = new FormData()
    form.append('file', new File([zip], 'board.papertie', { type: 'application/zip' }))
    const staged = await handle(
      new Request(url(`/api/boards/${boardId}/import`), {
        method: 'POST',
        headers: { Origin: APP_ORIGIN },
        body: form,
      }),
    )
    expect(staged.status, await staged.clone().text()).toBe(200)
    expect(await staged.json()).toMatchObject({ preview: { notes: 1 } })
  })
})

describe('the protocol bridge: the web app', () => {
  it('serves files with their content types', async () => {
    const { handle } = await realBridge()
    const types: Record<string, RegExp> = {
      '/': /^text\/html/,
      '/index.html': /^text\/html/,
      '/assets/app-1a2b.js': /^text\/javascript/,
      '/assets/app-1a2b.css': /^text\/css/,
      '/assets/face-3c4d.woff2': /^font\/woff2$/,
      '/favicon.svg': /^image\/svg\+xml/,
      '/stage.css': /^text\/css/,
    }
    for (const [path, type] of Object.entries(types)) {
      const res = await handle(new Request(url(path)))
      expect(res.status, path).toBe(200)
      expect(res.headers.get('Content-Type'), path).toMatch(type)
      expect(res.headers.get('X-Content-Type-Options'), path).toBe('nosniff')
    }
    expect(await (await handle(new Request(url('/assets/app-1a2b.js')))).text()).toBe(
      'export const x = 1',
    )
  })

  it("an app route is the SPA's index.html; a missing /api path is the API's 404", async () => {
    const { handle } = await realBridge()
    for (const path of ['/settings/export', '/book/book_01JBX0000000000000000000AA', '/shelf']) {
      const res = await handle(new Request(url(path)))
      expect(res.status, path).toBe(200)
      expect(res.headers.get('Content-Type'), path).toMatch(/^text\/html/)
      expect(await res.text(), path).toContain('<title>Papertie</title>')
    }
    const api = await handle(new Request(url('/api/nothing-here')))
    expect(api.status).toBe(404)
    expect(await api.json()).toEqual({ error: 'not-found' })
  })

  it('a path out of the web app is refused: nothing outside it is ever served', async () => {
    const { handle } = await realBridge()
    const forged = [
      '/..%2fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/%2e%2e%2fsecret.txt',
      '/..%5csecret.txt',
      '/assets%5c..%5c..%5csecret.txt',
      '/index.html%00.js',
    ]
    for (const path of forged) {
      const res = await handle(new Request(url(path)))
      expect(res.status, path).toBe(404)
      expect(await res.text(), path).not.toContain('not for the page')
    }
    // Dot segments the URL itself resolves stay inside the root: the SPA, never the secret.
    for (const path of ['/../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt']) {
      const res = await handle(new Request(url(path)))
      expect(await res.text(), path).not.toContain('not for the page')
    }
  })
})

describe('the protocol bridge: files the system opened', () => {
  it('serves an opened file once, by its token, and nothing else under the prefix', async () => {
    const opened = new OpenedFiles()
    const { handle } = await realBridge({ opened })
    const dir = await tempDir()
    const path = join(dir, 'My board.papertie')
    await writeFile(path, Buffer.from('PK\u0003\u0004 a board'))
    const at = opened.add(path)
    expect(at.startsWith(`${APP_ORIGIN}/_opened/`)).toBe(true)
    const res = await handle(new Request(at))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PK\u0003\u0004 a board')
    // Once: the token is spent.
    expect((await handle(new Request(at))).status).toBe(404)
    expect((await handle(new Request(url('/_opened/not-a-token')))).status).toBe(404)
    expect((await handle(new Request(url('/_opened/')))).status).toBe(404)
    // Only a GET.
    const again = opened.add(path)
    const post = await handle(
      new Request(again, { method: 'POST', headers: { Origin: APP_ORIGIN } }),
    )
    expect(post.status).toBe(404)
  })

  it('a file gone since it was opened is a 404', async () => {
    const opened = new OpenedFiles()
    const { handle } = await realBridge({ opened })
    const at = opened.add(join(await tempDir(), 'gone.papertie'))
    expect((await handle(new Request(at))).status).toBe(404)
  })
})
