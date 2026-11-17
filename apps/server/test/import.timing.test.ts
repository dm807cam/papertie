/**
 * The import's timed rows: the event loop held by a 100,000-note preview and commit, and an
 * deletion of all data beside a slow upload within 5 s (`import.test.ts` keeps their untimed proofs:
 * the counts, the deletion going through): the timing project runs them, a file at a time
 * (`vitest.config.ts`).
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { loadavg } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { type BoardState, newId, parseBoard, serializeBoard } from '@papertie/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  boardDir,
  createBoard,
  hugeState,
  noteCreate,
  postOps,
  readBoardFile,
  tabNow,
} from './helpers/boards'
import type { TestUser } from './helpers/client'
import { FakeClock } from './helpers/clock'
import { startTestServer, type TestServer } from './helpers/harness'
import { png } from './helpers/images'
import type { EventStream } from './helpers/sse'
import { writeZip } from './helpers/zip'

/**
 * A `.papertie` (or plain `.jsonl`) file replaces the board. The preview stages and
 * validates it and commits nothing; the commit backs the board up, moves the re-encoded photos in
 * and installs the file's records at the next revision, all or nothing; a hostile file is turned
 * away with the board, its photos and the quota untouched.
 */

const T0 = '2026-10-27T10:00:00.000Z'
const MIB = 1_048_576

let server: TestServer
const streams: EventStream[] = []

/** Data directories a test made itself (to restart on), removed once its server is closed. */
const dataDirs: string[] = []

afterEach(async () => {
  for (const s of streams.splice(0)) s.close()
  await server?.close()
  for (const d of dataDirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function start(config: NonNullable<Parameters<typeof startTestServer>[0]>['config'] = {}) {
  server = await startTestServer({ clock: new FakeClock(T0), config })
}

interface Account {
  user: TestUser
  board: string
  tab: string
  seq: number
}

async function account(label = 'user'): Promise<Account> {
  const user = server.user
  const board = await createBoard(user, `${label} board`)
  return { user, board, tab: tabNow(server), seq: 0 }
}

const revisionOf = async (a: Account) => {
  const res = await a.user.request(`/api/boards/${a.board}/meta`)
  return ((await res.json()) as { revision: number }).revision
}

async function commit(a: Account, ops: unknown[]): Promise<number> {
  const res = await postOps(a.user, a.board, {
    clientId: a.tab,
    seq: ++a.seq,
    baseRevision: await revisionOf(a),
    ops,
  })
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { revision: number }).revision
}

async function upload(a: Account, image?: Buffer): Promise<string> {
  const form = new FormData()
  const bytes = image ?? (await png(64, 48))
  form.append('file', new File([new Uint8Array(bytes)], 'p.png', { type: 'image/png' }))
  const res = await a.user.request(`/api/boards/${a.board}/assets`, { method: 'POST', body: form })
  expect(res.status).toBe(201)
  return ((await res.json()) as { asset: { id: string } }).asset.id
}

function noteShowing(assetId: string, id = newId('note'), text = 'with a photo') {
  const op = noteCreate({ id, text, at: server.clock.now().toISOString() })
  return { ...op, note: { ...op.note, image: { assetId, frame: 'print' } } }
}

function yarnCreate(noteIds: string[]) {
  const at = server.clock.now().toISOString()
  return {
    op: 'yarn.create',
    yarn: {
      type: 'yarn',
      id: newId('yarn'),
      noteIds,
      color: 'apricot',
      label: '',
      createdAt: at,
      updatedAt: at,
    },
  }
}

/** Two notes (one showing a photo) and a thread between them. */
async function seed(a: Account, text = 'first note'): Promise<{ notes: string[]; photo: string }> {
  const photo = await upload(a)
  const notes = [newId('note'), newId('note')]
  await commit(a, [noteCreate({ id: notes[0], text, at: T0 }), noteShowing(photo, notes[1])])
  await commit(a, [yarnCreate(notes)])
  return { notes, photo }
}

async function exportOf(a: Account, format: 'papertie' | 'jsonl' = 'papertie'): Promise<Buffer> {
  const res = await a.user.request(`/api/boards/${a.board}/export?format=${format}`)
  expect(res.status).toBe(200)
  return Buffer.from(await res.arrayBuffer())
}

function preview(a: Account, bytes: Buffer, filename = 'board.papertie') {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(bytes)], filename))
  return a.user.request(`/api/boards/${a.board}/import`, { method: 'POST', body: form })
}

interface PreviewBody {
  preview: {
    name: string
    notes: number
    yarns: number
    assets: number
    bytes: number
    skippedRecords: number
    books?: number
    blocks?: number
  }
  importId: string
}

async function previewOk(a: Account, bytes: Buffer, filename?: string): Promise<PreviewBody> {
  const res = await preview(a, bytes, filename)
  const text = await res.text()
  expect(res.status, text).toBe(200)
  return JSON.parse(text) as PreviewBody
}

function commitImport(a: Account, importId: string) {
  return a.user.request(`/api/boards/${a.board}/import/${importId}/commit`, {
    method: 'POST',
    body: '{}',
  })
}

const stateOf = (a: Account): BoardState => {
  const { state } = parseBoard(readBoardFile(server, a.user.id, a.board).toString('utf8'))
  if (!state) throw new Error('board does not parse')
  return state
}

const dirOf = (a: Account) => boardDir(server, a.user.id, a.board)

const importDirs = (a: Account) => readdirSync(dirOf(a)).filter((n) => n.startsWith('import-'))

/**
 * A multipart upload of `file` whose body sends `first` bytes of it, then waits for `go` before
 * sending the rest: an upload still in flight.
 */
function slowUpload(a: Account, file: Buffer, first: number, go: Promise<void>) {
  const head = Buffer.from(
    '--slow\r\nContent-Disposition: form-data; name="file"; filename="board.papertie"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n',
  )
  const tail = Buffer.from('\r\n--slow--\r\n')
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new Uint8Array(Buffer.concat([head, file.subarray(0, first)])))
      await go
      try {
        controller.enqueue(new Uint8Array(Buffer.concat([file.subarray(first), tail])))
        controller.close()
      } catch {
        // the server has let the upload go
      }
    },
  })
  return a.user.request(`/api/boards/${a.board}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=slow' },
    body,
    duplex: 'half',
  } as RequestInit)
}

/** Resolves once `cond` holds, polling every 10 ms (at most 10 s). */
async function until(cond: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out')
}

describe('one import at a time', () => {
  it('a deletion of all data is not held by a slow upload', async () => {
    await start()
    const a = await account()
    await seed(a)
    const zip = await exportOf(a)
    const first = slowUpload(a, zip, 100, new Promise(() => {}))
    await until(() => importDirs(a).length === 1)
    const t0 = performance.now()
    const del = await a.user.request('/api/data/delete', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'delete' }),
    })
    expect(del.status, await del.clone().text()).toBeLessThan(300)
    expect(performance.now() - t0).toBeLessThan(5000)
    expect((await first).status).toBe(409)
  })
})

/** On AC power (always true off macOS, where the gate is load only). */
function onAC(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    return execFileSync('pmset', ['-g', 'ps'], { encoding: 'utf8' }).includes("'AC Power'")
  } catch {
    return false
  }
}

/** How long the event loop is held while `fn` runs: wall (event-loop delay) and CPU per turn. */
async function holding<T>(fn: () => Promise<T>) {
  const delay = monitorEventLoopDelay({ resolution: 1 })
  let maxCpuMs = 0
  let lastCpu = process.threadCpuUsage()
  const tick = setInterval(() => {
    const cpu = process.threadCpuUsage()
    const ms = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000
    if (ms > maxCpuMs) maxCpuMs = ms
    lastCpu = cpu
  }, 1)
  const loadBefore = loadavg()[0] ?? 0
  delay.enable()
  const t0 = performance.now()
  const result = await fn()
  const ms = performance.now() - t0
  delay.disable()
  clearInterval(tick)
  const load1 = Math.max(loadBefore, loadavg()[0] ?? 0)
  return { result, ms, wallMaxMs: delay.max / 1e6, maxCpuMs, load1, quiet: load1 < 4 && onAC() }
}

describe('at 100,000 notes', () => {
  it('the preview and the commit of a 100,000-note board hold the event loop ≤ 50 ms', async () => {
    // Built before the server has a connection to keep alive (`import.test.ts` says why).
    const huge = hugeState('board_01JBPR0T0SAMP1E000000BRD01', 100_000)
    const text = Buffer.from(serializeBoard(huge))
    const zip = writeZip([
      {
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify({ format: 'papertie', version: 1 })),
      },
      { name: 'board.jsonl', data: text },
    ])
    await start()
    const a = await account()

    const run = await holding(() => previewOk(a, zip))
    console.info(
      `import preview at 100,000 notes (${(text.length / MIB).toFixed(0)} MB of JSONL): ` +
        `${run.ms.toFixed(0)} ms, loop block max ${run.wallMaxMs.toFixed(1)} ms wall, ` +
        `${run.maxCpuMs.toFixed(1)} ms CPU; load1 ${run.load1.toFixed(2)}, ` +
        `${onAC() ? 'AC' : 'battery'}${run.quiet ? '' : ' (not a quiet run: wall time is reported, not asserted)'}`,
    )
    expect(run.result.preview).toMatchObject({ notes: 100_000, yarns: huge.yarns.size })
    expect(run.maxCpuMs).toBeLessThanOrEqual(50)
    if (run.quiet) expect(run.wallMaxMs).toBeLessThanOrEqual(50)

    const swap = await holding(async () => {
      const res = await commitImport(a, run.result.importId)
      expect(res.status).toBe(200)
      return res.json()
    })
    console.info(
      `import commit at 100,000 notes: ${swap.ms.toFixed(0)} ms, loop block max ` +
        `${swap.wallMaxMs.toFixed(1)} ms wall, ${swap.maxCpuMs.toFixed(1)} ms CPU; load1 ${swap.load1.toFixed(2)}`,
    )
    expect(swap.maxCpuMs).toBeLessThanOrEqual(50)
    if (swap.quiet) expect(swap.wallMaxMs).toBeLessThanOrEqual(50)
    expect(stateOf(a).notes.size).toBe(100_000)
  }, 300_000)
})
