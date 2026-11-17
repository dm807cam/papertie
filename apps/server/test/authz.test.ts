import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { newId } from '@papertie/core'
import { inspectRoutes } from 'hono/dev'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import {
  boardDir,
  boardFile,
  compactBoard,
  createBoard,
  noteCreate,
  postOps,
  tabNow,
} from './helpers/boards'
import { blockCreate, blockRecord, bookCreate, bookRecord } from './helpers/books'
import type { TestUser } from './helpers/client'
import { FakeClock } from './helpers/clock'
import { startTestServer, type TestServer } from './helpers/harness'
import { png } from './helpers/images'

/**
 * For one user: every route works for the user; every state-changing one is refused
 * cross-origin, "delete all data" included; no forged or traversal id reaches past the route's id
 * checks into the data dir. Board B takes the positive control's writes; board A must come
 * through the whole matrix unchanged.
 */

const T0 = '2026-10-27T10:00:00.000Z'

let server: TestServer
let user: TestUser
let boardA: string
let boardB: string
let assetA: string
let assetB: string
let backupA: string
let backupB: string
let image: Buffer
/** A `.papertie` file (board B exported): what every import row uploads. */
let importFile: Buffer
/** An import staged on board A, which no forged request may reach. */
let importA: string
/** A book on each board. */
let bookA: string
let bookB: string

/** The ids a matrix row puts in its path. */
interface Ids {
  board: string
  asset: string
  /** A backup file name of `board`. */
  backup: string
  /** An import staged for `board`. */
  import: string
  /** A book on `board`. */
  book: string
}

interface MatrixRow {
  method: 'GET' | 'POST' | 'DELETE'
  /** The route template, exactly as Hono lists it in `app.routes`. */
  path: string
  /** A complete, otherwise valid request for this route with `ids` substituted. */
  build(ids: Ids): { url: string; init: RequestInit }
  /** The row consumes a staged import: the owner's run stages a fresh one for it first. */
  stages?: true
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function form(bytes: Uint8Array): FormData {
  const f = new FormData()
  f.append('file', new File([new Uint8Array(bytes)], 'photo.png', { type: 'image/png' }))
  return f
}

function importForm(): FormData {
  const f = new FormData()
  f.append('file', new File([new Uint8Array(importFile)], 'board.papertie'))
  return f
}

/** Stage `importFile` on `who`'s `board`; resolves to the import id. */
async function stageImport(who: TestUser, board: string): Promise<string> {
  const res = await who.request(`/api/boards/${board}/import`, {
    method: 'POST',
    body: importForm(),
  })
  if (res.status !== 200) throw new Error(`import preview: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { importId: string }).importId
}

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
})

/** Every board, asset and data route. `completeness` below fails if the app has one more. */
export const ROUTE_MATRIX: readonly MatrixRow[] = [
  {
    method: 'POST',
    path: '/api/boards',
    build: () => ({ url: '/api/boards', init: { method: 'POST', ...json({ name: 'New' }) } }),
  },
  { method: 'GET', path: '/api/boards', build: () => ({ url: '/api/boards', init: {} }) },
  {
    method: 'GET',
    path: '/api/boards/:id',
    build: (ids) => ({ url: `/api/boards/${ids.board}`, init: {} }),
  },
  {
    method: 'GET',
    path: '/api/boards/:id/meta',
    build: (ids) => ({ url: `/api/boards/${ids.board}/meta`, init: {} }),
  },
  {
    method: 'DELETE',
    path: '/api/boards/:id/recovery',
    build: (ids) => ({ url: `/api/boards/${ids.board}/recovery`, init: { method: 'DELETE' } }),
  },
  {
    method: 'POST',
    path: '/api/boards/:id/ops',
    build: (ids) => ({
      url: `/api/boards/${ids.board}/ops`,
      init: {
        method: 'POST',
        ...json({
          clientId: tabNow(server),
          seq: 1,
          baseRevision: 0,
          ops: [noteCreate({ at: server.clock.now().toISOString(), text: 'from the matrix' })],
        }),
      },
    }),
  },
  {
    method: 'GET',
    path: '/api/boards/:id/ops',
    build: (ids) => ({ url: `/api/boards/${ids.board}/ops?since=0`, init: {} }),
  },
  {
    method: 'GET',
    path: '/api/boards/:id/books/:bookId',
    build: (ids) => ({ url: `/api/boards/${ids.board}/books/${ids.book}`, init: {} }),
  },
  {
    method: 'GET',
    path: '/api/boards/:id/books/:bookId/export',
    build: (ids) => ({
      url: `/api/boards/${ids.board}/books/${ids.book}/export?format=md`,
      init: {},
    }),
  },
  {
    method: 'GET',
    path: '/api/boards/:id/region',
    build: (ids) => ({
      url: `/api/boards/${ids.board}/region?x0=-4096&y0=-4096&x1=4096&y1=4096`,
      init: {},
    }),
  },
  {
    method: 'POST',
    path: '/api/boards/:id/assets',
    build: (ids) => ({
      url: `/api/boards/${ids.board}/assets`,
      init: { method: 'POST', body: form(image) },
    }),
  },
  {
    method: 'GET',
    path: '/api/boards/:id/events',
    build: (ids) => ({
      url: `/api/boards/${ids.board}/events`,
      init: { headers: { Accept: 'text/event-stream' } },
    }),
  },
  {
    method: 'GET',
    path: '/api/boards/:id/export',
    build: (ids) => ({ url: `/api/boards/${ids.board}/export?format=papertie`, init: {} }),
  },
  {
    method: 'GET',
    path: '/api/boards/:id/backups',
    build: (ids) => ({ url: `/api/boards/${ids.board}/backups`, init: {} }),
  },
  {
    method: 'POST',
    path: '/api/boards/:id/backups/:backupId/restore',
    build: (ids) => ({
      url: `/api/boards/${ids.board}/backups/${ids.backup}/restore`,
      init: { method: 'POST', ...json({}) },
    }),
  },
  {
    method: 'POST',
    path: '/api/boards/:id/import',
    build: (ids) => ({
      url: `/api/boards/${ids.board}/import`,
      init: { method: 'POST', body: importForm() },
    }),
  },
  {
    method: 'POST',
    path: '/api/boards/:id/import/:importId/commit',
    stages: true,
    build: (ids) => ({
      url: `/api/boards/${ids.board}/import/${ids.import}/commit`,
      init: { method: 'POST', ...json({}) },
    }),
  },
  {
    method: 'DELETE',
    path: '/api/boards/:id/import/:importId',
    stages: true,
    build: (ids) => ({
      url: `/api/boards/${ids.board}/import/${ids.import}`,
      init: { method: 'DELETE' },
    }),
  },
  {
    method: 'GET',
    path: '/api/assets/:id/:size',
    build: (ids) => ({ url: `/api/assets/${ids.asset}/256`, init: {} }),
  },
  {
    method: 'POST',
    path: '/api/data/delete',
    // With the real confirmation: if the origin check were missing, this would delete everything.
    build: () => ({
      url: '/api/data/delete',
      init: { method: 'POST', ...json({ confirm: 'delete' }) },
    }),
  },
]

/**
 * Rows whose path names a resource. `POST /api/boards`, `GET /api/boards` and
 * `POST /api/data/delete` name none, so they appear only in the cross-origin rows.
 */
const ID_ROWS = ROUTE_MATRIX.filter((r) => r.path.includes('/:'))
const BOARD_ID_ROWS = ID_ROWS.filter((r) => r.path.startsWith('/api/boards/:id'))
const ASSET_ROW = ID_ROWS.find((r) => r.path.startsWith('/api/assets/')) as MatrixRow

const rowName = (r: MatrixRow) => `${r.method} ${r.path}`

/** `fetch` with no Origin header at all (unlike `api`). */
function bare(url: string, init: RequestInit = {}, headers: Record<string, string> = {}) {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  return fetch(`${server.url}${url}`, { redirect: 'manual', ...init, headers: h })
}

interface RawResponse {
  status: number
  headers: Map<string, string>
  body: Buffer
}

/** HTTP/1.1 chunked body → bytes. */
function dechunk(buf: Buffer): Buffer {
  const out: Buffer[] = []
  let at = 0
  for (;;) {
    const eol = buf.indexOf('\r\n', at)
    if (eol < 0) break
    const size = Number.parseInt(buf.subarray(at, eol).toString('latin1'), 16)
    if (!Number.isFinite(size) || size === 0) break
    out.push(buf.subarray(eol + 2, eol + 2 + size))
    at = eol + 2 + size + 2
  }
  return Buffer.concat(out)
}

/** How long a request may take before the test gives up on it (an opened event stream never ends). */
const RESPONSE_TIMEOUT_MS = 3000

/**
 * One request over a plain socket: the request target is sent byte for byte, so nothing on the
 * client side resolves `..` or decodes `%2f`. A response still open after `RESPONSE_TIMEOUT_MS`
 * (an event stream that was wrongly opened) is cut off and returned as far as it got.
 */
async function rawRequest(
  method: string,
  target: string,
  opts: { init?: RequestInit } = {},
): Promise<RawResponse> {
  const headers = new Headers(opts.init?.headers)
  let body = Buffer.alloc(0)
  if (opts.init?.body !== undefined) {
    const r = new Response(opts.init.body)
    body = Buffer.from(await r.arrayBuffer())
    const type = r.headers.get('content-type')
    if (type && !headers.has('content-type')) headers.set('content-type', type)
  }
  const { hostname, port } = new URL(server.url)
  const lines = [
    `${method} ${target} HTTP/1.1`,
    `Host: ${hostname}:${port}`,
    `Origin: ${server.url}`,
    'Connection: close',
  ]
  for (const [k, v] of headers) lines.push(`${k}: ${v}`)
  if (body.length > 0 || MUTATING.has(method)) lines.push(`Content-Length: ${body.length}`)

  const reply = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect(Number(port), hostname)
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(Buffer.concat(chunks))
    }, RESPONSE_TIMEOUT_MS)
    socket.on('data', (d) => chunks.push(d))
    socket.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
    socket.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    socket.write(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), body]))
  })
  const split = reply.indexOf('\r\n\r\n')
  const head = reply.subarray(0, split).toString('latin1').split('\r\n')
  const status = Number((head[0] ?? '').split(' ')[1])
  const map = new Map<string, string>()
  for (const line of head.slice(1)) {
    const colon = line.indexOf(':')
    map.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  const rest = reply.subarray(split + 4)
  return {
    status,
    headers: map,
    body: map.get('transfer-encoding') === 'chunked' ? dechunk(rest) : rest,
  }
}

/** Every file under `dir`, as sorted relative paths. */
function listing(dir: string): string[] {
  if (!existsSync(dir)) return []
  return (readdirSync(dir, { recursive: true }) as string[]).sort()
}

interface Snapshot {
  board: Buffer
  recovery: Buffer | null
  assets: string[]
  revision: number
}

async function snapshotA(): Promise<Snapshot> {
  const dir = boardDir(server, user.id, boardA)
  const recoveryPath = join(dir, 'recovery.json')
  return {
    board: readFileSync(boardFile(server, user.id, boardA)),
    recovery: existsSync(recoveryPath) ? readFileSync(recoveryPath) : null,
    assets: listing(join(dir, 'assets')),
    revision: await revisionOf(user, boardA),
  }
}

async function revisionOf(who: TestUser, board: string): Promise<number> {
  const res = await who.request(`/api/boards/${board}/meta`)
  if (res.status !== 200) throw new Error(`meta: ${res.status}`)
  return ((await res.json()) as { revision: number }).revision
}

async function upload(who: TestUser, board: string): Promise<string> {
  const res = await who.request(`/api/boards/${board}/assets`, {
    method: 'POST',
    body: form(image),
  })
  if (res.status !== 201) throw new Error(`upload: ${res.status}`)
  return ((await res.json()) as { asset: { id: string } }).asset.id
}

let before: Snapshot

/** The newest backup file name of `board` (every board here has at least one). */
function newestBackup(who: TestUser, board: string): string {
  const names = readdirSync(join(boardDir(server, who.id, board), 'backups')).sort()
  const name = names.at(-1)
  if (!name) throw new Error('expected a backup')
  return name
}

const idsOfA = (): Ids => ({
  board: boardA,
  asset: assetA,
  backup: backupA,
  import: importA,
  book: bookA,
})
const idsOfB = (): Ids => ({
  board: boardB,
  asset: assetB,
  backup: backupB,
  import: newId('tab').slice('tab_'.length),
  book: bookB,
})
beforeAll(async () => {
  server = await startTestServer({ clock: new FakeClock(T0) })
  image = await png(64, 48)
  user = server.user
  boardA = await createBoard(user, 'Alice board')
  boardB = await createBoard(user, 'Bob board')

  // A: two notes, a book and an asset, compacted at 10:00 (a backup), then a yarn compacted in the
  // next hour (another backup).
  const notes = [newId('note'), newId('note')]
  const ownBook = bookRecord({ title: 'alice private title' })
  const clientId = tabNow(server)
  const first = await postOps(user, boardA, {
    clientId,
    seq: 1,
    baseRevision: 0,
    ops: [
      ...notes.map((id) => noteCreate({ id, at: T0, text: 'alice private note' })),
      bookCreate(ownBook),
      blockCreate(blockRecord(ownBook.id, 'V', 'alice private sentence')),
    ],
  })
  if (first.status !== 200) throw new Error(`ops: ${first.status}`)
  bookA = ownBook.id
  assetA = await upload(user, boardA)
  await compactBoard(server, user.id, boardA)
  server.clock.advance(3_600_000)
  const at = server.clock.now().toISOString()
  const yarn = {
    type: 'yarn',
    id: newId('yarn'),
    noteIds: notes,
    color: 'apricot',
    label: 'alice',
    createdAt: at,
    updatedAt: at,
  }
  const second = await postOps(user, boardA, {
    clientId,
    seq: 2,
    baseRevision: await revisionOf(user, boardA),
    ops: [{ op: 'yarn.create', yarn }],
  })
  if (second.status !== 200) throw new Error(`ops: ${second.status}`)
  await compactBoard(server, user.id, boardA)
  const backups = readdirSync(join(boardDir(server, user.id, boardA), 'backups'))
  if (backups.length < 2) throw new Error(`expected 2 backups, got ${backups.length}`)

  // A recovery notice for A: a torn last line, picked up at A's next read.
  const file = boardFile(server, user.id, boardA)
  appendFileSync(file, '{"type":"note","id":"note_')
  const meta = await user.request(`/api/boards/${boardA}/meta`)
  if (((await meta.json()) as { recovery: unknown }).recovery === null) {
    throw new Error('expected a recovery notice')
  }
  if (!existsSync(join(boardDir(server, user.id, boardA), 'recovery.json'))) {
    throw new Error('expected recovery.json')
  }

  const theirBook = bookRecord({ title: 'bob private title' })
  const bookOps = await postOps(user, boardB, {
    clientId: tabNow(server),
    seq: 1,
    baseRevision: await revisionOf(user, boardB),
    ops: [bookCreate(theirBook), blockCreate(blockRecord(theirBook.id, 'V', 'bob sentence'))],
  })
  if (bookOps.status !== 200) throw new Error(`ops: ${bookOps.status}`)
  bookB = theirBook.id
  assetB = await upload(user, boardB)
  await compactBoard(server, user.id, boardB)
  backupA = newestBackup(user, boardA)
  backupB = newestBackup(user, boardB)
  const exported = await user.request(`/api/boards/${boardB}/export?format=papertie`)
  if (exported.status !== 200) throw new Error(`export: ${exported.status}`)
  importFile = Buffer.from(await exported.arrayBuffer())
  importA = await stageImport(user, boardA)
  before = await snapshotA()
})

afterAll(() => server?.close())

describe('completeness', () => {
  it('every /api route but health is in ROUTE_MATRIX', () => {
    const app = createApp(server.deps)
    // `use()` registers middleware under method ALL; so does `all()` for a real handler. Hono's own
    // `inspectRoutes` tells them apart (a middleware takes `next`), so ALL entries count only when
    // they are handlers. Every method-specific entry is a route (its middleware shares the path).
    const listed = new Set(
      inspectRoutes(app)
        .filter((r) => r.method !== 'ALL' || !r.isMiddleware)
        .filter((r) => r.path === '*' || r.path === '/*' || r.path.startsWith('/api'))
        .filter((r) => r.path !== '/api/health')
        .map((r) => `${r.method} ${r.path}`),
    )
    expect([...listed].sort()).toEqual(ROUTE_MATRIX.map(rowName).sort())
  })
})

describe('positive control: each id row works for the user', () => {
  it.each(ID_ROWS.map((r) => [rowName(r), r] as const))('%s', async (_name, row) => {
    const ids = idsOfB()
    if (row.stages) ids.import = await stageImport(user, boardB)
    const { url, init } = row.build(ids)
    const res = await user.request(url, init)
    const detail = res.status < 300 ? '' : await res.text()
    expect(res.status, detail).toBeLessThan(300)
    await res.body?.cancel()
  })
})

describe('cross-origin', () => {
  const mutating = ROUTE_MATRIX.filter((r) => MUTATING.has(r.method))
  it.each(mutating.map((r) => [rowName(r), r] as const))(
    '%s without a trusted Origin is 403',
    async (_name, row) => {
      for (const origin of [undefined, 'http://evil.example', 'null', 'papertie://evil']) {
        const { url, init } = row.build(idsOfA())
        const headers: Record<string, string> = {}
        if (origin) headers.Origin = origin
        const res = await bare(url, init, headers)
        expect(res.status, origin ?? 'no origin').toBe(403)
        expect(await res.json()).toEqual({ error: 'forbidden-origin' })
      }
    },
  )
})

describe('forged and traversal ids', () => {
  const ulid = () => newId('board').slice('board_'.length)
  /**
   * `%2f`-encoded ids that, decoded and joined under the user's directory, land exactly on board
   * A's real directory or its asset's. Only the id checks (route `idParam`, path `segment`) stop these, so
   * they are what fails if either check regresses.
   */
  const resolving = {
    // users/<u>/boards/ + ../../<u>/boards/<boardA>
    board: () => `..%2f..%2f${user.id}%2fboards%2f${boardA}`,
    // users/<u>/boards/<boardB>/assets/ + ../../../../<u>/boards/<boardA>/assets/<assetA>
    asset: () => `..%2f..%2f..%2f..%2f${user.id}%2fboards%2f${boardA}%2fassets%2f${assetA}`,
  }

  /** Raw request-target segments, sent byte for byte. */
  const forged = (prefix: 'board' | 'asset') => [
    resolving[prefix](),
    resolving[prefix]().replaceAll('%2f', '%2F'),
    `${prefix}_../../..`,
    '%2e%2e%2f%2e%2e%2flocal-user.json',
    '..%2f..%2flocal-user.json',
    `${prefix}_${'A'.repeat(26)}`,
    `note_${ulid()}`,
    `${prefix}_${ulid().toLowerCase()}`,
    `${prefix}_${ulid()}A`,
    `${prefix}_${ulid()}%00`,
  ]

  /** A's board file, the one thing a traversal would most want: never served by one. */
  const aBoard = () => readFileSync(boardFile(server, user.id, boardA))

  const expectNotFound = (res: RawResponse, label: string) => {
    expect(res.status, label).toBe(404)
    expect(res.body.includes(aBoard()), label).toBe(false)
    expect(res.body.includes('alice private note'), label).toBe(false)
  }

  it.each(BOARD_ID_ROWS.map((r) => [rowName(r), r] as const))(
    '%s: every forged board id is a 404',
    async (_name, row) => {
      for (const id of forged('board')) {
        const { url, init } = row.build({ ...idsOfA(), board: id })
        const res = await rawRequest(init.method ?? 'GET', url, { init })
        expectNotFound(res, id)
        expect(JSON.parse(res.body.toString('utf8')), id).toEqual({ error: 'not-found' })
      }
    },
  )

  it('GET /api/assets/:id/:size: every forged asset id is a 404', async () => {
    for (const id of forged('asset')) {
      const { url } = ASSET_ROW.build({ ...idsOfA(), asset: id })
      const res = await rawRequest('GET', url)
      expectNotFound(res, id)
      expect(JSON.parse(res.body.toString('utf8')), id).toEqual({ error: 'not-found' })
    }
  })

  it('an asset :size of ../../board.jsonl is a 404', async () => {
    for (const asset of [assetA, assetB]) {
      for (const size of ['../../board.jsonl', '..%2f..%2fboard.jsonl', '..%2F..%2Fboard.jsonl']) {
        const res = await rawRequest('GET', `/api/assets/${asset}/${size}`)
        expectNotFound(res, `${asset === assetA ? 'A' : 'B'} ${size}`)
      }
    }
  })

  it('raw-path traversal from /api/assets into A board.jsonl is a 404', async () => {
    const target = `/api/assets/../users/${user.id}/boards/${boardA}/board.jsonl`
    expectNotFound(await rawRequest('GET', target), target)
    const deeper = `/api/assets/${assetB}/../../../users/${user.id}/boards/${boardA}/board.jsonl`
    expectNotFound(await rawRequest('GET', deeper), deeper)
  })
})

describe('A after the whole matrix', () => {
  it("A's board.jsonl, recovery.json, assets and revision are unchanged", async () => {
    const after = await snapshotA()
    expect(after.board.equals(before.board)).toBe(true)
    expect(after.recovery).not.toBeNull()
    expect(after.recovery?.equals(before.recovery as Buffer)).toBe(true)
    expect(before.assets.length).toBeGreaterThan(0)
    expect(after.assets).toEqual(before.assets)
    expect(after.revision).toBe(before.revision)
    // A still exists and can still be read: no "delete all data" got through.
    expect((await user.request(`/api/boards/${boardA}`)).status).toBe(200)
    // No backup of A's was restored or removed.
    expect(newestBackup(user, boardA)).toBe(backupA)
  })
})
