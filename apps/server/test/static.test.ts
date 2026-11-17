import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api } from './helpers/client'
import { startTestServer, type TestServer } from './helpers/harness'

const INDEX = '<!doctype html><html><head><title>Papertie</title></head><body></body></html>\n'
const SCRIPT = 'console.log("x")\n'

let server: TestServer
let webDist: string
let outside: string

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'papertie-web-'))
  webDist = join(root, 'dist')
  outside = join(root, 'secret.txt')
  await mkdir(join(webDist, 'assets'), { recursive: true })
  await writeFile(join(webDist, 'index.html'), INDEX)
  await writeFile(join(webDist, 'assets', 'x.js'), SCRIPT)
  await writeFile(join(webDist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  // Next to the dist directory, never inside it.
  await writeFile(outside, 'outside the web root')
  server = await startTestServer({ config: { webDist } })
})

afterAll(async () => {
  await server?.close()
  await rm(join(webDist, '..'), { recursive: true, force: true })
})

/** One request over a plain socket, so the request target reaches the server byte for byte. */
function raw(target: string): Promise<{ status: number; text: string }> {
  const { hostname, port } = new URL(server.url)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname)
    const chunks: Buffer[] = []
    socket.on('data', (d) => chunks.push(d))
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      resolve({ status: Number(text.split(' ')[1]), text })
    })
    socket.on('error', reject)
    socket.write(`GET ${target} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`)
  })
}

describe('SPA serving from config.webDist', () => {
  it('/ is index.html, not cached, with the same CSP as the API', async () => {
    const res = await api(server, '/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toBe(INDEX)
    const csp = res.headers.get('content-security-policy')
    expect(csp).toContain("script-src 'self'")
    const health = await api(server, '/api/health')
    expect(csp).toBe(health.headers.get('content-security-policy'))
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  it('an app route falls back to index.html', async () => {
    for (const path of ['/settings/history', '/sign-in', '/index.html']) {
      const res = await api(server, path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('cache-control'), path).toBe('no-cache')
      expect(res.headers.get('content-security-policy'), path).toContain("default-src 'self'")
      expect(await res.text(), path).toBe(INDEX)
    }
  })

  it('/assets/* is served with immutable caching', async () => {
    const res = await api(server, '/assets/x.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await res.text()).toBe(SCRIPT)
  })

  it('other files are served as they are, revalidated', async () => {
    const res = await api(server, '/favicon.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^image\/svg\+xml/)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    await res.body?.cancel()
  })

  it('HEAD answers like GET, without a body', async () => {
    const res = await api(server, '/assets/x.js', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await res.text()).toBe('')
  })

  it('traversal out of the web root is a 404', async () => {
    for (const target of [
      '/../../etc/passwd',
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/..%2Fsecret.txt',
      '/assets/..%5c..%5csecret.txt',
      '/x%00.js',
    ]) {
      const res = await raw(target)
      expect(res.status, target).toBe(404)
      expect(res.text.includes('outside the web root'), target).toBe(false)
      expect(res.text.includes('root:'), target).toBe(false)
    }
  })

  it('a query is never taken for a forged path', async () => {
    for (const target of ['/sign-in?next=%2Fsettings%2Fhistory', '/reset-password?x=..%2f..']) {
      const res = await raw(target)
      expect(res.status, target).toBe(200)
      expect(res.text.endsWith(INDEX), target).toBe(true)
    }
  })

  it('/api/* is never the SPA: an unknown API route stays the JSON 404', async () => {
    for (const path of ['/api/nope', '/api', '/api/assets/x.js']) {
      const res = await api(server, path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type'), path).toMatch(/^application\/json/)
      expect(await res.json(), path).toEqual({ error: 'not-found' })
    }
  })

  it('other methods are not served', async () => {
    const res = await api(server, '/settings', { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })
})

describe('without config.webDist', () => {
  it('/ is the plain 404', async () => {
    const plain = await startTestServer()
    try {
      const res = await api(plain, '/')
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('Not Found')
    } finally {
      await plain.close()
    }
  })
})
