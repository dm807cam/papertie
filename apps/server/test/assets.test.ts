import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseBoard } from '@papertie/core'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ASSET_SIZES } from '../src/limits'
import { createBoard, readBoardFile } from './helpers/boards'
import type { TestUser } from './helpers/client'
import { startTestServer, type TestServer } from './helpers/harness'
import {
  apng,
  fakeHeic,
  GPS_MARKER,
  gif,
  html,
  jpegWithExif,
  noisePng,
  pdf,
  png,
  pngHeaderBomb,
  svg,
  withAppended,
} from './helpers/images'
import { openEvents } from './helpers/sse'

let server: TestServer
let user: TestUser
let board: string

async function start(config: Parameters<typeof startTestServer>[0] = {}) {
  server = await startTestServer(config)
  user = server.user
  board = await createBoard(user)
}
beforeEach(() => start())
afterEach(() => server.close())

/** Multipart upload of `bytes`; `name` and `type` are what a browser would claim. */
function upload(
  who: TestUser,
  boardId: string,
  bytes: Uint8Array,
  claim: { name?: string; type?: string } = {},
) {
  const form = new FormData()
  form.append(
    'file',
    new File([new Uint8Array(bytes)], claim.name ?? 'photo.png', {
      type: claim.type ?? 'image/png',
    }),
  )
  return who.request(`/api/boards/${boardId}/assets`, { method: 'POST', body: form })
}

const assetsRoot = (who = user, boardId = board) =>
  join(server.dataDir, 'users', who.id, 'boards', boardId, 'assets')
const variantPath = (assetId: string, size: number | string, who = user, boardId = board) =>
  join(assetsRoot(who, boardId), assetId, `${size}.webp`)
const variant = (assetId: string, size: number) => readFileSync(variantPath(assetId, size))
const stateOf = () => {
  const { state } = parseBoard(readBoardFile(server, user.id, board).toString('utf8'))
  if (!state) throw new Error('board does not parse')
  return state
}

interface Uploaded {
  asset: {
    id: string
    mime: string
    width: number
    height: number
    bytes: number
    sha256: string
    createdAt: string
  }
  revision: number
}
async function uploadOk(bytes: Uint8Array, claim?: { name?: string; type?: string }) {
  const res = await upload(user, board, bytes, claim)
  expect(res.status).toBe(201)
  return (await res.json()) as Uploaded
}

/** Every file under `dir`, recursively, as `[path, bytes]`. */
function walk(dir: string): Array<[string, Buffer]> {
  const out: Array<[string, Buffer]> = []
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = join(e.parentPath, e.name)
    if (e.isFile()) out.push([p, readFileSync(p)])
  }
  return out
}
const leftovers = (dir: string) => (existsSync(dir) ? readdirSync(dir, { recursive: true }) : [])

describe('upload: happy path', () => {
  it('3000x2000 PNG becomes three WebP variants, one revision, one asset.add commit', async () => {
    const events = await openEvents(user, board)
    const before = stateOf().board.revision
    const { asset, revision } = await uploadOk(await png(3000, 2000))

    const dims = async (size: number) => {
      const m = await sharp(variant(asset.id, size)).metadata()
      return [m.format, m.width, m.height]
    }
    expect(await dims(2560)).toEqual(['webp', 2560, 1707])
    expect(await dims(1024)).toEqual(['webp', 1024, 683])
    expect(await dims(256)).toEqual(['webp', 256, 171])

    const big = variant(asset.id, 2560)
    expect(asset).toMatchObject({
      mime: 'image/webp',
      width: 2560,
      height: 1707,
      bytes: big.byteLength,
      sha256: createHash('sha256').update(big).digest('hex'),
    })
    expect(revision).toBe(before + 1)
    expect(stateOf().board.revision).toBe(before + 1)
    // Stored as answered, stamped with the commit's revision.
    expect(stateOf().assets.get(asset.id)).toEqual({ ...asset, rev: revision })
    expect(readBoardFile(server, user.id, board).toString('utf8')).toContain(
      `"type":"asset","id":"${asset.id}"`,
    )

    let msg = await events.next(3000)
    while (msg.event !== 'commit') msg = await events.next(3000)
    expect(msg.data).toMatchObject({
      revision,
      originClientId: null,
      ops: [{ op: 'asset.add', asset }],
    })
    events.close()
  })

  it('does not enlarge: 800x600 keeps 800x600 for 2560 and 1024, 256x192 for 256', async () => {
    const { asset } = await uploadOk(await png(800, 600))
    const dims = async (size: number) => {
      const m = await sharp(variant(asset.id, size)).metadata()
      return [m.width, m.height]
    }
    expect(await dims(2560)).toEqual([800, 600])
    expect(await dims(1024)).toEqual([800, 600])
    expect(await dims(256)).toEqual([256, 192])
    expect(asset).toMatchObject({ width: 800, height: 600 })
  })

  it('creates the asset dir 0700 and files 0600', async () => {
    const { asset } = await uploadOk(await png(40, 30))
    expect(statSync(join(assetsRoot(), asset.id)).mode & 0o777).toBe(0o700)
    for (const size of ASSET_SIZES) {
      expect(statSync(variantPath(asset.id, size)).mode & 0o777).toBe(0o600)
    }
  })
})

describe('upload: metadata and polyglots', () => {
  it('applies EXIF orientation and strips EXIF, GPS, ICC and XMP', async () => {
    const input = await jpegWithExif({ w: 400, h: 200, orientation: 6, gps: true })
    expect(input.includes('Exif')).toBe(true)
    expect(input.includes(GPS_MARKER)).toBe(true)
    const { asset } = await uploadOk(input, { name: 'a.jpg', type: 'image/jpeg' })
    expect(asset).toMatchObject({ width: 200, height: 400 })
    for (const size of ASSET_SIZES) {
      const out = variant(asset.id, size)
      const meta = await sharp(out).metadata()
      expect(meta.exif).toBeUndefined()
      expect(meta.icc).toBeUndefined()
      expect(meta.xmp).toBeUndefined()
      for (const needle of ['GPS', 'Exif', 'SENTINEL-COPYRIGHT']) {
        expect(out.includes(needle)).toBe(false)
      }
    }
    const m = await sharp(variant(asset.id, 2560)).metadata()
    expect([m.width, m.height]).toEqual([200, 400])
  })

  it('a JPEG with <script><html> appended is re-encoded without the payload', async () => {
    const poly = withAppended(
      await jpegWithExif({ w: 64, h: 64 }),
      '<script>alert(1)</script><html>',
    )
    const { asset } = await uploadOk(poly, { name: 'a.jpg', type: 'image/jpeg' })
    for (const size of ASSET_SIZES) {
      const out = variant(asset.id, size)
      expect(out.includes('<script')).toBe(false)
      expect(out.includes('<html')).toBe(false)
    }
  })

  it('a GIF with a JS payload after its trailer becomes a first-frame WebP without it', async () => {
    const animated = await gif(32, 24, 3)
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(3)
    const poly = withAppended(animated, '/*<script>alert(1)</script>*/alert(2)')
    const { asset } = await uploadOk(poly, { name: 'a.gif', type: 'image/gif' })
    for (const size of ASSET_SIZES) {
      const out = variant(asset.id, size)
      expect(out.includes('<script')).toBe(false)
      expect(out.includes('alert(')).toBe(false)
      const meta = await sharp(out, { animated: true }).metadata()
      expect(meta.format).toBe('webp')
      expect(meta.pages ?? 1).toBe(1)
    }
    expect(asset).toMatchObject({ width: 32, height: 24 })
  })

  it('an APNG (acTL before IDAT) is accepted as a PNG and stored as a single-frame WebP', async () => {
    const input = await apng(64, 48)
    expect(input.includes('acTL')).toBe(true)
    const { asset } = await uploadOk(input, { name: 'a.png', type: 'image/png' })
    expect(asset).toMatchObject({ width: 64, height: 48 })
    const meta = await sharp(variant(asset.id, 2560), { animated: true }).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.pages ?? 1).toBe(1)
  })

  it('accepts a WebP upload', async () => {
    const webp = await sharp({ create: { width: 90, height: 60, channels: 3, background: '#0a0' } })
      .webp()
      .toBuffer()
    const { asset } = await uploadOk(webp)
    expect(asset).toMatchObject({ width: 90, height: 60 })
  })
})

describe('upload: rejected input', () => {
  const rejected = async (bytes: Uint8Array, claim?: { name?: string; type?: string }) => {
    const res = await upload(user, board, bytes, claim)
    expect(leftovers(assetsRoot())).toEqual([])
    return res
  }

  it('an HTML document is 415', async () => {
    const res = await rejected(Buffer.from(html), { name: 'a.html', type: 'text/html' })
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'unsupported-format' })
  })

  it('SVG is 415 even when claimed to be image/png named a.png', async () => {
    const res = await rejected(Buffer.from(svg), { name: 'a.png', type: 'image/png' })
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'unsupported-format' })
  })

  it('HEIC is 415', async () => {
    expect((await rejected(fakeHeic(), { name: 'a.heic', type: 'image/heic' })).status).toBe(415)
  })

  it('PDF is 415', async () => {
    expect((await rejected(pdf, { name: 'a.pdf', type: 'application/pdf' })).status).toBe(415)
  })

  it('an empty file is 415', async () => {
    expect((await rejected(new Uint8Array(0))).status).toBe(415)
  })

  it('a PNG header declaring 50000x50000 is 422 undecodable-image, fast, leaving nothing', async () => {
    // How fast is a timing row's (`assets.timing.test.ts`).
    const res = await rejected(pngHeaderBomb(50_000, 50_000))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'undecodable-image' })
  })

  it('a header-valid PNG within the pixel limit but with no real data is 422', async () => {
    const res = await rejected(pngHeaderBomb(4000, 4000))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'undecodable-image' })
  })

  it('a truncated PNG is 422', async () => {
    const whole = await png(300, 300)
    const res = await rejected(whole.subarray(0, Math.floor(whole.length / 2)))
    expect(res.status).toBe(422)
  })

  it('a request without a file field is 400 invalid', async () => {
    const form = new FormData()
    form.append('other', 'x')
    const res = await user.request(`/api/boards/${board}/assets`, { method: 'POST', body: form })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid' })
  })

  it('a malformed multipart body is 400 invalid', async () => {
    const res = await user.request(`/api/boards/${board}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=xyz' },
      body: '--xyz\r\nbroken',
    })
    expect(res.status).toBe(400)
  })
})

describe('upload: client-supplied name and type', () => {
  it('PNG bytes claimed as image/jpeg named x.jpg are accepted; no filename is stored anywhere', async () => {
    const { asset } = await uploadOk(await png(50, 50), {
      name: 'SENTINEL-FILE-77.jpg',
      type: 'image/jpeg',
    })
    expect(Object.keys(asset).sort()).toEqual(
      ['bytes', 'createdAt', 'height', 'id', 'mime', 'sha256', 'type', 'width'].sort(),
    )
    expect(asset.mime).toBe('image/webp')
    const needle = Buffer.from('SENTINEL-FILE-77')
    for (const [path, bytes] of walk(server.dataDir)) {
      expect(path.includes('SENTINEL-FILE-77'), path).toBe(false)
      expect(bytes.includes(needle), path).toBe(false)
    }
    expect(server.logs.join('\n').includes('SENTINEL-FILE-77')).toBe(false)
    expect(server.logs.length).toBeGreaterThan(0)
  })
})

describe('upload: limits', () => {
  it('a file of 26,214,401 bytes is 413 too-large and nothing is stored', async () => {
    const res = await upload(user, board, new Uint8Array(26_214_401))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'too-large' })
    expect(leftovers(assetsRoot())).toEqual([])
  })

  it('a request body over 25 MB + 64 KB is 413 too-large', async () => {
    const res = await upload(user, board, new Uint8Array(26_214_400 + 65_536 + 1))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'too-large' })
  })
})

describe('upload: quota', () => {
  it('uploads succeed until the next would exceed the quota, which is 413 quota and changes nothing', async () => {
    await server.close()
    // One noise image's three variants add up to roughly 126 KB; 300 KB fits two of them.
    await start({ config: { limits: { quotaBytes: 300_000 } } })
    const img = await noisePng(250, 250)
    const sizeOf = (id: string) => ASSET_SIZES.reduce((n, s) => n + variant(id, s).byteLength, 0)

    const first = await uploadOk(img)
    const second = await uploadOk(img)
    const used = sizeOf(first.asset.id) + sizeOf(second.asset.id)
    expect(used).toBeLessThanOrEqual(300_000)
    expect(await server.deps.quota?.usage(user.id)).toBe(used)

    const revision = stateOf().board.revision
    const res = await upload(user, board, img)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'quota' })
    expect(await server.deps.quota?.usage(user.id)).toBe(used)
    expect(readdirSync(assetsRoot()).sort()).toEqual([first.asset.id, second.asset.id].sort())
    expect(stateOf().board.revision).toBe(revision)
  })

  it('a user already at the quota is refused before any decoding', async () => {
    await server.close()
    await start({ config: { limits: { quotaBytes: 1000 } } })
    expect(await server.deps.quota?.tryAdd(user.id, 1000, 1000)).toBe(true)
    // Not even an undecodable file gets as far as being looked at.
    const res = await upload(user, board, Buffer.from(html))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'quota' })
  })

  it('counts existing files on first use (after a restart-equivalent scan)', async () => {
    const { asset } = await uploadOk(await png(300, 200))
    const { QuotaTracker } = await import('../src/assets/quota')
    const fresh = new QuotaTracker(server.dataDir)
    const expected = ASSET_SIZES.reduce((n, s) => n + variant(asset.id, s).byteLength, 0)
    expect(await fresh.usage(user.id)).toBe(expected)
    expect(await fresh.usage('user_00000000000000000000000000')).toBe(0)
  })

  it('a failure after the files exist releases the quota and removes the asset dir', async () => {
    const before = await server.deps.quota?.usage(user.id)
    const store = server.deps.store
    if (!store) throw new Error('no store')
    const orig = store.submitServer.bind(store)
    store.submitServer = () => Promise.reject(new Error('boom'))
    try {
      const res = await upload(user, board, await png(100, 100))
      expect(res.status).toBe(500)
    } finally {
      store.submitServer = orig
    }
    expect(leftovers(assetsRoot())).toEqual([])
    expect(await server.deps.quota?.usage(user.id)).toBe(before)
  })
})

describe('GET /api/assets/:id/:size', () => {
  it('serves the file with the exact headers and the stored bytes', async () => {
    const { asset } = await uploadOk(await png(1500, 1000))
    for (const size of ASSET_SIZES) {
      const res = await user.request(`/api/assets/${asset.id}/${size}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/webp')
      expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('content-disposition')).toBe('inline')
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      const body = Buffer.from(await res.arrayBuffer())
      expect(body.equals(variant(asset.id, size))).toBe(true)
      expect(Number(res.headers.get('content-length'))).toBe(body.byteLength)
    }
  })

  it('HEAD requests on a large variant leak nothing and the server keeps serving', async () => {
    const { asset } = await uploadOk(await noisePng(1500, 1500))
    const file = variant(asset.id, 2560)
    expect(file.byteLength).toBeGreaterThan(65_536)
    for (let i = 0; i < 20; i++) {
      const head = await user.request(`/api/assets/${asset.id}/2560`, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('content-length')).toBe(String(file.byteLength))
      expect((await head.arrayBuffer()).byteLength).toBe(0)
    }
    // An unreferenced stream would be closed by GC, which kills the process on current Node.
    // vitest.config.ts runs the workers with --expose-gc, so this regression test can fail.
    const gc = globalThis.gc
    expect(typeof gc).toBe('function')
    for (let i = 0; i < 3; i++) {
      gc?.()
      await new Promise((r) => setTimeout(r, 50))
    }
    const res = await user.request(`/api/assets/${asset.id}/2560`)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(file)).toBe(true)
  })

  it('unknown sizes, malformed ids and unknown assets are 404', async () => {
    const { asset } = await uploadOk(await png(100, 100))
    for (const path of [
      `/api/assets/${asset.id}/999`,
      `/api/assets/${asset.id}/01024`,
      `/api/assets/${asset.id}/1024.webp`,
      `/api/assets/${asset.id}/..`,
      `/api/assets/not-an-id/1024`,
      `/api/assets/note_${asset.id.slice(6)}/1024`,
      '/api/assets/asset_00000000000000000000000000/1024',
    ]) {
      const res = await user.request(path)
      expect(res.status, path).toBe(404)
      expect(await res.json()).toEqual({ error: 'not-found' })
    }
  })

  it('finds an asset on any board of the user', async () => {
    const second = await createBoard(user, 'Second')
    const res = await upload(user, second, await png(60, 40))
    const { asset } = (await res.json()) as Uploaded
    expect((await user.request(`/api/assets/${asset.id}/256`)).status).toBe(200)
  })
})
