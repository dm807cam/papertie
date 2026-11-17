import { chmodSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Asset,
  type Note,
  newId,
  parseBoard,
  serializeBoard,
  stateFromRecords,
  validateInvariants,
} from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QuotaTracker } from '../src/assets/quota'
import { ASSET_GRACE_MS, ASSET_SIZES } from '../src/limits'
import { LOG_KEYS } from '../src/log'
import { retentionPass } from '../src/store/assetSweeper'
import { backupName } from '../src/store/backups'
import {
  boardDir,
  boardFile,
  compactBoard,
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

const T0 = '2026-10-01T10:00:00.000Z'
const DAY_MS = 86_400_000

let server: TestServer
let user: TestUser
let board: string
let tab: string
let seq: number
/** Data dirs a test made itself (`startTestServer` removes only its own). */
const owned: string[] = []

async function start(dataDir?: string, at = T0) {
  server = await startTestServer({
    clock: new FakeClock(at),
    // Backups come only from the compactions these tests make.
    config: { store: { compactEveryHour: false } },
    ...(dataDir ? { dataDir } : {}),
  })
}

beforeEach(async () => {
  await start()
  user = server.user
  board = await createBoard(user)
  tab = tabNow(server)
  seq = 0
})
afterEach(async () => {
  await server.close()
  for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true })
})

const deps = () => {
  const { store, quota, log } = server.deps
  if (!store || !quota) throw new Error('the server has no store or quota')
  return { store, quota, log }
}

/** The board's asset sweep through the server's sweeper, after any run a load or compaction began. */
const sweep = async (boardId = board) => {
  await server.assets.settled()
  return server.assets.sweep(user.id, boardId)
}

const assetDirOf = (id: string, boardId = board) =>
  join(boardDir(server, user.id, boardId), 'assets', id)

async function upload(boardId = board): Promise<string> {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(await png(64, 48))], 'p.png', { type: 'image/png' }))
  const res = await user.request(`/api/boards/${boardId}/assets`, { method: 'POST', body: form })
  expect(res.status).toBe(201)
  return ((await res.json()) as { asset: { id: string } }).asset.id
}

const revisionOf = async (boardId = board) => {
  const res = await user.request(`/api/boards/${boardId}/meta`)
  return ((await res.json()) as { revision: number }).revision
}

async function commit(ops: unknown[], boardId = board): Promise<number> {
  const res = await postOps(user, boardId, {
    clientId: tab,
    seq: ++seq,
    baseRevision: await revisionOf(boardId),
    ops,
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { revision: number }).revision
}

/** A note showing `assetId`. */
function noteShowing(assetId: string, id = newId('note')) {
  const op = noteCreate({ id, at: server.clock.now().toISOString() })
  return { ...op, note: { ...op.note, image: { assetId, frame: 'print' } } }
}

const stateOf = (boardId = board) => {
  const { state } = parseBoard(readBoardFile(server, user.id, boardId).toString('utf8'))
  if (!state) throw new Error('board does not parse')
  return state
}

const logLines = () => server.logs.map((l) => JSON.parse(l) as Record<string, unknown>)

describe('ASSET_GRACE_MS', () => {
  it('is 30 days', () => {
    expect(ASSET_GRACE_MS).toBe(30 * 24 * 3600 * 1000)
  })
})

describe('sweep never collects what a backup or a fresh upload needs', () => {
  it('an asset referenced only by a retained backup survives, and restoring that backup serves it', async () => {
    const asset = await upload()
    const noteId = newId('note')
    await commit([noteShowing(asset, noteId)])
    await compactBoard(server, user.id, board) // this hour's backup shows the photo
    const backup = backupName(server.clock.now(), await revisionOf())
    await commit([{ op: 'note.delete', id: noteId }])
    await compactBoard(server, user.id, board) // same hour: no second backup
    expect([...stateOf().notes.keys()]).toEqual([])

    server.clock.advance(31 * DAY_MS)
    expect(await sweep()).toEqual({ removed: [], freedBytes: 0 })
    expect(stateOf().assets.has(asset)).toBe(true)
    expect(existsSync(assetDirOf(asset))).toBe(true)

    const res = await user.request(
      `/api/boards/${board}/backups/${encodeURIComponent(backup)}/restore`,
      { method: 'POST', body: '{}' },
    )
    expect(res.status).toBe(200)
    expect(stateOf().notes.get(noteId)?.image?.assetId).toBe(asset)
    expect((await user.request(`/api/assets/${asset}/256`)).status).toBe(200)
  })

  it('an asset with createdAt 1 day old and no reference survives', async () => {
    const asset = await upload()
    const before = await deps().quota.usage(user.id)
    server.clock.advance(DAY_MS)
    expect(await sweep()).toEqual({ removed: [], freedBytes: 0 })
    expect(stateOf().assets.has(asset)).toBe(true)
    expect(existsSync(assetDirOf(asset))).toBe(true)
    expect(await deps().quota.usage(user.id)).toBe(before)
  })

  it('an asset whose id is 31 days old but whose createdAt is 1 day old survives', async () => {
    // Loaded first, so the sweep its load starts is over before the files exist.
    await deps().store.since(user.id, board, 0)
    await server.assets.settled()
    const at = server.clock.now().getTime()
    const id = newId('asset', at - 30 * DAY_MS)
    await mkdir(assetDirOf(id))
    for (const size of ASSET_SIZES) await writeFile(join(assetDirOf(id), `${size}.webp`), 'x')
    const asset: Asset = {
      type: 'asset',
      id,
      mime: 'image/webp',
      width: 1,
      height: 1,
      bytes: 1,
      sha256: '0'.repeat(64),
      createdAt: new Date(at).toISOString(),
    }
    await deps().store.submitServer(user.id, board, [{ op: 'asset.add', asset }])
    // A day on: the id says 31 days, the record 1 day.
    server.clock.advance(DAY_MS)
    expect(await sweep()).toEqual({ removed: [], freedBytes: 0 })
    expect(stateOf().assets.has(id)).toBe(true)
    // Compacted into board.jsonl, the record says the same.
    await compactBoard(server, user.id, board)
    server.clock.advance(DAY_MS)
    expect(await sweep()).toEqual({ removed: [], freedBytes: 0 })
    expect(existsSync(assetDirOf(id))).toBe(true)
  })

  it('an asset 31 days old, referenced by nothing, is removed from the board, from disk and from the quota', async () => {
    const kept = await upload()
    const doomed = await upload()
    await commit([noteShowing(kept)])
    // A backup holding the record but no note showing it does not keep it.
    await compactBoard(server, user.id, board)
    const files = ASSET_SIZES.map((s) => join(assetDirOf(doomed), `${s}.webp`))
    const bytes = files.reduce((sum, f) => sum + readFileSync(f).byteLength, 0)
    const before = await deps().quota.usage(user.id)
    const revision = await revisionOf()

    // First run: the record goes (one commit); the files stay, and so does the quota.
    server.clock.advance(31 * DAY_MS)
    expect(await sweep()).toEqual({ removed: [doomed], freedBytes: 0 })
    const state = stateOf()
    expect(state.assets.has(doomed)).toBe(false)
    expect(state.assets.has(kept)).toBe(true)
    expect(state.board.revision).toBe(revision + 1)
    expect(existsSync(assetDirOf(doomed))).toBe(true)
    expect(await deps().quota.usage(user.id)).toBe(before)

    // A run inside the day does nothing.
    server.clock.advance(3_600_000)
    expect(await sweep()).toBeNull()

    // The next day's run: the record-less files go, credited once, with no commit.
    server.clock.advance(DAY_MS)
    expect(await sweep()).toEqual({ removed: [], freedBytes: bytes })
    expect(existsSync(assetDirOf(doomed))).toBe(false)
    expect(existsSync(assetDirOf(kept))).toBe(true)
    expect(await deps().quota.usage(user.id)).toBe(before - bytes)
    expect((await user.request(`/api/assets/${doomed}/256`)).status).toBe(404)
    expect(stateOf().board.revision).toBe(revision + 1)

    // Logged by count and size only.
    expect(logLines().filter((l) => String(l.msg).startsWith('asset '))).toEqual([
      { level: 'info', msg: 'asset records removed', count: 1 },
      { level: 'info', msg: 'asset files deleted', count: 1, bytes },
    ])
    expect(server.logs.join('\n')).not.toContain(doomed)
    for (const line of logLines()) {
      for (const k of Object.keys(line)) expect(['level', 'msg', ...LOG_KEYS]).toContain(k)
    }

    // Nothing left to do.
    server.clock.advance(DAY_MS)
    expect(await sweep()).toEqual({ removed: [], freedBytes: 0 })
    expect(stateOf().board.revision).toBe(revision + 1)
  })
})

describe('figures', () => {
  it('the asset sweep keeps an asset only a figure shows', async () => {
    const asset = await upload()
    const noteId = newId('note')
    const bookId = newId('book')
    const at = server.clock.now().toISOString()
    await commit([
      noteShowing(asset, noteId),
      {
        op: 'book.create',
        book: {
          type: 'book',
          id: bookId,
          title: 'A book',
          lang: 'en',
          shelfPos: 'V',
          cover: { seed: 1, ink: 'indigo', motif: 'overprint' },
          trashedAt: null,
          createdAt: at,
          updatedAt: at,
        },
      },
      {
        op: 'block.create',
        block: {
          type: 'block',
          id: newId('block'),
          bookId,
          pos: 'V',
          kind: 'figure',
          text: '',
          marks: [],
          image: { assetId: asset, card: noteId },
        },
      },
    ])
    // The card goes; the figure made from it stays, and keeps its photo.
    await commit([{ op: 'note.delete', id: noteId }])
    server.clock.advance(31 * DAY_MS)
    expect(await sweep()).toEqual({ removed: [], freedBytes: 0 })
    expect(stateOf().assets.has(asset)).toBe(true)
    expect(existsSync(assetDirOf(asset))).toBe(true)
  })
})

describe('the run that commits deletes no files', () => {
  it('a backup installed after the commit keeps the files while it shows the photo', async () => {
    const asset = await upload()
    const bytes = ASSET_SIZES.reduce(
      (sum, s) => sum + readFileSync(join(assetDirOf(asset), `${s}.webp`)).byteLength,
      0,
    )
    const before = await deps().quota.usage(user.id)
    // What a compaction that took its base while a note showed the photo installs late.
    const late = stateFromRecords(stateOf().board, [
      ...stateOf().assets.values(),
      { ...noteShowing(asset).note, image: { assetId: asset, frame: 'print' } } as Note,
    ])

    server.clock.advance(31 * DAY_MS)
    expect(await sweep()).toEqual({ removed: [asset], freedBytes: 0 })
    expect(stateOf().assets.has(asset)).toBe(false)
    expect(existsSync(assetDirOf(asset))).toBe(true)
    const backups = join(boardDir(server, user.id, board), 'backups')
    const name = backupName(server.clock.now(), 1)
    await writeFile(join(backups, name), serializeBoard(late))

    server.clock.advance(DAY_MS)
    expect(await sweep()).toEqual({ removed: [], freedBytes: 0 })
    expect(existsSync(assetDirOf(asset))).toBe(true)
    expect(await deps().quota.usage(user.id)).toBe(before)

    // Once retention drops that backup, the next run takes the files, crediting them once.
    rmSync(join(backups, name))
    server.clock.advance(DAY_MS)
    expect(await sweep()).toEqual({ removed: [], freedBytes: bytes })
    expect(existsSync(assetDirOf(asset))).toBe(false)
    expect(await deps().quota.usage(user.id)).toBe(before - bytes)
  })
})

describe('QuotaTracker.credit', () => {
  it('takes the bytes freed off a loaded count, and an unloaded one counts what is left', async () => {
    const asset = await upload()
    const bytes = ASSET_SIZES.reduce(
      (sum, s) => sum + readFileSync(join(assetDirOf(asset), `${s}.webp`)).byteLength,
      0,
    )
    const loaded = new QuotaTracker(server.dataDir)
    expect(await loaded.usage(user.id)).toBe(bytes)
    const fresh = new QuotaTracker(server.dataDir)
    const free = async () => {
      rmSync(assetDirOf(asset), { recursive: true })
      return bytes
    }
    expect(await loaded.credit(user.id, free)).toBe(bytes)
    expect(await loaded.usage(user.id)).toBe(0)
    // Never loaded: its first scan sees the files gone, and nothing is taken off twice.
    expect(await fresh.credit(user.id, async () => bytes)).toBe(bytes)
    expect(await fresh.usage(user.id)).toBe(0)
  })
})

describe('the retention pass', () => {
  it('never loads a board: it defers the ones not loaded, sweeps them after their load, and one failing never stops the rest', async () => {
    // On a data dir of its own, so the servers here can stop and start on it.
    await server.close()
    const dataDir = await mkdtemp(join(tmpdir(), 'papertie-sweep-'))
    owned.push(dataDir)
    await start(dataDir)
    user = server.user
    board = await createBoard(user)
    const other = await createBoard(user, 'Other')
    const stuck = await upload()
    const doomed = await upload(other)
    // The first board's backup cannot be read, so its sweep fails; the other one's goes on.
    await compactBoard(server, user.id, board)
    const backups = join(boardDir(server, user.id, board), 'backups')
    const [backup] = readdirSync(backups)
    await server.close()

    // The startup pass: nothing is loaded yet, so both boards wait for their load.
    await start(dataDir, new Date(Date.parse(T0) + 31 * DAY_MS).toISOString())
    await server.close()
    expect(server.deps.store?.stats.loads).toBe(0)
    expect(logLines().filter((l) => l.msg === 'asset sweep deferred')).toEqual([
      { level: 'info', msg: 'asset sweep deferred', count: 2 },
    ])
    expect(existsSync(assetDirOf(doomed, other))).toBe(true)

    chmodSync(join(backups, backup as string), 0o000)
    try {
      await start(dataDir, new Date(Date.parse(T0) + 31 * DAY_MS).toISOString())
      const { store, log } = deps()
      // Loading a board starts its sweep (off the request path).
      for (const b of [board, other]) await store.since(user.id, b, 0)
      await server.assets.settled()
      expect(store.isCached(user.id, other)).toBe(true)
      expect(logLines().filter((l) => l.msg === 'asset records removed')).toHaveLength(1)
      expect(logLines().filter((l) => l.msg === 'asset sweep failed')).toHaveLength(1)

      // The next day's pass sweeps the loaded boards: the other one's files go.
      server.clock.advance(DAY_MS)
      await retentionPass(dataDir, server.clock.now(), log, server.assets)
      expect(existsSync(assetDirOf(doomed, other))).toBe(false)
      expect(existsSync(assetDirOf(stuck))).toBe(true)
      expect(logLines().filter((l) => l.msg === 'asset sweep failed')).toHaveLength(2)
      expect(logLines().filter((l) => l.msg === 'asset files deleted')).toHaveLength(1)
    } finally {
      chmodSync(join(backups, backup as string), 0o600)
    }
  })
})

describe('restore', () => {
  it('restore drops asset records whose files are missing and logs a repair', async () => {
    const asset = await upload()
    const noteId = newId('note')
    await commit([noteShowing(asset, noteId)])
    await compactBoard(server, user.id, board)
    const backup = backupName(server.clock.now(), await revisionOf())
    await commit([{ op: 'note.delete', id: noteId }])
    // The photo's files are gone (lost, or taken by hand).
    rmSync(assetDirOf(asset), { recursive: true })

    const res = await user.request(
      `/api/boards/${board}/backups/${encodeURIComponent(backup)}/restore`,
      { method: 'POST', body: '{}' },
    )
    expect(res.status).toBe(200)
    const state = stateOf()
    expect(state.assets.has(asset)).toBe(false)
    expect(state.notes.get(noteId)?.image).toBeNull()

    const meta = (await (await user.request(`/api/boards/${board}/meta`)).json()) as {
      recovery: { integrity: string; repairs: number; quarantinedLines: number }
    }
    expect(meta.recovery).toMatchObject({ integrity: 'restored', repairs: 2, quarantinedLines: 0 })
    const repairs = readFileSync(join(boardDir(server, user.id, board), 'repairs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { message: string; raw: string })
    expect(repairs.map((r) => JSON.parse(r.raw).type)).toEqual(['asset', 'note'])
    expect(repairs[0]?.message).toContain('files are missing')
    expect(logLines().filter((l) => l.msg === 'restore dropped assets')).toEqual([
      { level: 'warn', msg: 'restore dropped assets', count: 1 },
    ])
  })
})

describe('a figure whose photo is gone', () => {
  it('a restore keeps it as its caption, and the board then exports and imports whole', async () => {
    const asset = await upload()
    const noteId = newId('note')
    const bookId = newId('book')
    const figure = newId('block')
    const at = server.clock.now().toISOString()
    await commit([
      noteShowing(asset, noteId),
      {
        op: 'book.create',
        book: {
          type: 'book',
          id: bookId,
          title: 'A book',
          lang: 'en',
          shelfPos: 'V',
          cover: { seed: 1, ink: 'indigo', motif: 'overprint' },
          trashedAt: null,
          createdAt: at,
          updatedAt: at,
        },
      },
      {
        op: 'block.create',
        block: {
          type: 'block',
          id: figure,
          bookId,
          pos: 'V',
          kind: 'figure',
          text: 'The harbour',
          marks: [],
          image: { assetId: asset, card: noteId },
        },
      },
    ])
    await compactBoard(server, user.id, board)
    const backup = backupName(server.clock.now(), await revisionOf())
    // The figure and the card deleted, the sweep took the photo's files.
    await commit([
      { op: 'block.delete', bookId, id: figure },
      { op: 'note.delete', id: noteId },
    ])
    rmSync(assetDirOf(asset), { recursive: true })

    const res = await user.request(
      `/api/boards/${board}/backups/${encodeURIComponent(backup)}/restore`,
      { method: 'POST', body: '{}' },
    )
    expect(res.status).toBe(200)
    const state = stateOf()
    expect(state.assets.has(asset)).toBe(false)
    expect(state.blocks.get(figure)).toMatchObject({
      kind: 'p',
      text: 'The harbour',
      marks: [{ t: `c:${noteId}`, from: 0, to: 11 }],
    })
    expect(state.blocks.get(figure)?.image).toBeUndefined()
    expect(state.books.get(bookId)?.cards).toEqual([noteId])
    expect(validateInvariants(state)).toEqual([])

    // The escape hatch: the restored board's export imports.
    const file = await user.request(`/api/boards/${board}/export?format=papertie`)
    expect(file.status).toBe(200)
    const form = new FormData()
    form.append('file', new File([new Uint8Array(await file.arrayBuffer())], 'board.papertie'))
    const preview = await user.request(`/api/boards/${board}/import`, {
      method: 'POST',
      body: form,
    })
    expect(preview.status, await preview.clone().text()).toBe(200)
  })
})

/** A 100,000-note board on disk, unloaded: 5,000 notes show 12 photos, and `extra` are shown by none. */
async function hugeBoardOnDisk(extra: number) {
  const at = server.clock.now().toISOString()
  const photo = (): Asset => ({
    type: 'asset',
    id: newId('asset', server.clock.now().getTime()),
    mime: 'image/webp',
    width: 64,
    height: 48,
    bytes: 100,
    sha256: '0'.repeat(64),
    createdAt: at,
  })
  const shown = Array.from({ length: 12 }, photo)
  const loose = Array.from({ length: extra }, photo)
  const huge = hugeState(board, 100_000, at)
  const notes = [...huge.notes.values()].map(
    (n, i): Note =>
      i % 20 === 0
        ? { ...n, image: { assetId: (shown[(i / 20) % 12] as Asset).id, frame: 'print' } }
        : n,
  )
  const records = [...shown, ...loose]
  const text = serializeBoard(
    stateFromRecords(huge.board, [...records, ...notes, ...huge.yarns.values()]),
  )
  const dir = boardDir(server, user.id, board)
  await writeFile(boardFile(server, user.id, board), text)
  for (const a of records) {
    await mkdir(join(dir, 'assets', a.id))
    for (const size of ASSET_SIZES) {
      await writeFile(join(dir, 'assets', a.id, `${size}.webp`), Buffer.alloc(100))
    }
  }
  return { dir, text, notes, records, huge, loose }
}

describe('the sweep at 100,000 notes', () => {
  it('sweeping a loaded 100,000-note board (loaded before the run) holds the event loop ≤ 50 ms, with three full backups read', async () => {
    // One more photo shown only by the oldest backup, one shown by nothing, and one directory
    // with no record: every backup is read to its end.
    const { dir, text: live, notes, records, huge, loose } = await hugeBoardOnDisk(2)
    const [old, doomed] = loose as [Asset, Asset]
    const first = notes[1] as Note
    const then = serializeBoard(
      stateFromRecords(huge.board, [
        ...records,
        { ...first, image: { assetId: old.id, frame: 'print' } },
        ...notes.filter((n) => n.id !== first.id),
        ...huge.yarns.values(),
      ]),
    )
    for (const [i, text] of [then, live, live].entries()) {
      const t = new Date(server.clock.now().getTime() - (3 - i) * 3_600_000)
      await writeFile(join(dir, 'backups', backupName(t, 0)), text)
    }
    const orphan = newId('asset', server.clock.now().getTime())
    await mkdir(join(dir, 'assets', orphan))
    await writeFile(join(dir, 'assets', orphan, '256.webp'), Buffer.alloc(300))
    // Measured on a loaded board: an unloaded one is never swept (the next test).
    expect((await deps().store.read(user.id, board)).state.notes.size).toBe(100_000)
    await server.assets.settled()
    server.clock.advance(31 * DAY_MS)

    // Its hold on the event loop is a timing row's (`assetSweep.timing.test.ts`).
    expect(await sweep()).toEqual({ removed: [doomed.id], freedBytes: 300 })
    expect(existsSync(join(dir, 'assets', old.id))).toBe(true)
  }, 300_000)

  it('an unloaded 100,000-note board is not loaded by the sweep, and is swept after its next load', async () => {
    const { dir, loose } = await hugeBoardOnDisk(1)
    const [doomed] = loose as [Asset]
    const { store } = deps()
    expect(store.isCached(user.id, board)).toBe(false)
    server.clock.advance(31 * DAY_MS)

    const loads = store.stats.loads
    const rss = process.memoryUsage().rss
    const result = await sweep()
    const grew = (process.memoryUsage().rss - rss) / 1_048_576
    expect(result).toEqual({ removed: [], freedBytes: 0, deferred: true })
    expect(store.stats.loads).toBe(loads)
    expect(store.isCached(user.id, board)).toBe(false)
    // Nothing read: a load would take hundreds of MB (and hundreds of ms: the timing row's).
    expect(grew).toBeLessThan(50)

    // Its next load (a user opening it) starts the sweep, off the request path.
    await store.since(user.id, board, 0)
    expect(store.stats.loads).toBe(loads + 1)
    await new Promise((resolve) => setImmediate(resolve))
    await server.assets.settled()
    expect((await store.read(user.id, board)).state.assets.has(doomed.id)).toBe(false)
    expect(existsSync(join(dir, 'assets', doomed.id))).toBe(true)
  }, 300_000)
})
