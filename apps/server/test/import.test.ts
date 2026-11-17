import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BoardState,
  computeEof,
  LIMITS,
  type Note,
  newId,
  parseBoard,
  posKeysBetween,
  serializeBoard,
  validateInvariants,
} from '@papertie/core'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { ASSET_SIZES } from '../src/limits'
import { sweepAssets } from '../src/store/assetSweep'
import type { BoardStore } from '../src/store/boardStore'
import { purgeBooks } from '../src/store/bookPurge'
import type { FaultPoint } from '../src/store/faults'
import { ImportInvalid } from '../src/store/importErrors'
import { IMPORT_CAPS, readBoardLines } from '../src/store/importLines'
import { assetDir } from '../src/store/paths'
import {
  boardDir,
  createBoard,
  hugeState,
  noteCreate,
  postOps,
  readBoardFile,
  tabNow,
} from './helpers/boards'
import { blockCreate, blockRecord, bookCreate, bookRecord } from './helpers/books'
import type { TestUser } from './helpers/client'
import { FakeClock } from './helpers/clock'
import { startTestServer, type TestServer } from './helpers/harness'
import { png } from './helpers/images'
import { type EventStream, openEvents } from './helpers/sse'
import { type RawZipEntry, readZip, writeZip } from './helpers/zip'

/**
 * A `.papertie` (or plain `.jsonl`) file replaces the board. The preview stages and
 * validates it and commits nothing; the commit backs the board up, moves the re-encoded photos in
 * and installs the file's records at the next revision, all or nothing; a hostile file is turned
 * away with the board, its photos and the quota untouched.
 */

const T0 = '2026-10-27T10:00:00.000Z'
const DAY_MS = 86_400_000
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

const jsonlOf = (zip: Buffer) => {
  const entry = readZip(zip).find((e) => e.name === 'board.jsonl')
  if (!entry) throw new Error('no board.jsonl')
  return entry.data.toString('utf8')
}

/** A record as it means on any board: without the revision it last changed at. */
const bare = <R extends { rev?: number }>(r: R) => {
  const { rev: _rev, ...rest } = r
  return rest
}

const dirOf = (a: Account) => boardDir(server, a.user.id, a.board)

const listing = (dir: string): string[] =>
  existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : []

const importDirs = (a: Account) => readdirSync(dirOf(a)).filter((n) => n.startsWith('import-'))

async function usage(a: Account): Promise<number> {
  const quota = server.deps.quota
  if (!quota) throw new Error('no quota')
  return quota.usage(a.user.id)
}

/** What a turned-away import must leave exactly as it was. */
async function untouched(a: Account) {
  return {
    board: readBoardFile(server, a.user.id, a.board).toString('base64'),
    assets: listing(join(dirOf(a), 'assets')),
    usage: await usage(a),
    imports: importDirs(a),
  }
}

describe('export then import', () => {
  it('export then import round-trips: the board takes the file back, photos re-encoded under new ids', async () => {
    await start()
    const a = await account('alice')
    const { notes, photo } = await seed(a)
    const zip = await exportOf(a)
    const exported = parseBoard(jsonlOf(zip)).state
    if (!exported) throw new Error('export did not parse')

    // The board moves on: a third note, and the first note's words change.
    await commit(a, [noteCreate({ text: 'written after the export', at: T0 })])
    await commit(a, [{ op: 'note.update', id: notes[0], set: { text: 'changed' } }])
    const before = await revisionOf(a)
    const stream = await openEvents(a.user, a.board)
    streams.push(stream)
    const usedBefore = await usage(a)

    const { preview: p, importId } = await previewOk(a, zip)
    expect(p).toMatchObject({
      name: 'alice board',
      notes: 2,
      yarns: 1,
      assets: 1,
      skippedRecords: 0,
    })
    // Every stored variant of the photo: exactly what the import reserved of the quota.
    expect(p.bytes).toBeGreaterThan(0)
    expect(await usage(a)).toBe(usedBefore + p.bytes)
    // Nothing is committed by the preview.
    expect(await revisionOf(a)).toBe(before)
    expect(stateOf(a).notes.size).toBe(3)

    const res = await commitImport(a, importId)
    expect(res.status, await res.clone().text()).toBe(200)
    const done = (await res.json()) as { revision: number; safetyBackup: string }
    expect(done.revision).toBe(before + 1)
    expect(existsSync(join(dirOf(a), 'backups', done.safetyBackup))).toBe(true)
    // The safety backup is the board as it was just before.
    const safety = parseBoard(readFileSync(join(dirOf(a), 'backups', done.safetyBackup), 'utf8'))
    expect(safety.state?.notes.size).toBe(3)
    let event = await stream.next()
    while (event.event === 'hello') event = await stream.next()
    expect(event).toMatchObject({ event: 'reset', data: { revision: done.revision } })

    const state = stateOf(a)
    expect(state.board.id).toBe(a.board)
    expect(state.board.name).toBe('alice board')
    expect(state.board.revision).toBe(done.revision)
    expect([...state.yarns.values()].map(bare)).toEqual([...exported.yarns.values()].map(bare))
    const imageless = (n: Note) => ({ ...bare(n), image: n.image ? n.image.frame : null })
    expect([...state.notes.values()].map(imageless).sort(byId)).toEqual(
      [...exported.notes.values()].map(imageless).sort(byId),
    )
    // The photo came back under a new id, and serves in every size.
    const shown = state.notes.get(notes[1] as string)?.image?.assetId
    expect(shown).toBeDefined()
    expect(shown).not.toBe(photo)
    expect([...state.assets.keys()]).toEqual([shown])
    for (const size of ASSET_SIZES) {
      const img = await a.user.request(`/api/assets/${shown}/${size}`)
      expect(img.status).toBe(200)
      expect(img.headers.get('content-type')).toBe('image/webp')
      await img.body?.cancel()
    }
    expect(importDirs(a)).toEqual([])
    // The import is a restore of sorts: the page reads the board again, and the notice names the
    // safety backup.
    const meta = (await (await a.user.request(`/api/boards/${a.board}/meta`)).json()) as {
      recovery: { integrity: string; latestBackup: { file: string } }
    }
    expect(meta.recovery).toMatchObject({
      integrity: 'imported',
      latestBackup: { file: done.safetyBackup },
    })
    // A commit after it goes on from there.
    expect(await commit(a, [noteCreate({ at: T0 })])).toBe(done.revision + 1)
  })

  it("board A's export imports into board B, which keeps its id and takes A's name", async () => {
    await start()
    const a = await account('alice')
    const b = await account('bob')
    const { notes, photo } = await seed(a)
    await seed(b, 'bob was here')
    const zip = await exportOf(a)
    const before = await revisionOf(b)

    const { importId } = await previewOk(b, zip)
    const res = await commitImport(b, importId)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { revision: number }).revision).toBe(before + 1)

    const state = stateOf(b)
    expect(state.board.id).toBe(b.board)
    expect(state.board.name).toBe('alice board')
    expect([...state.notes.keys()].sort()).toEqual([...notes].sort())
    const shown = state.notes.get(notes[1] as string)?.image?.assetId as string
    expect(shown).not.toBe(photo)
    expect((await b.user.request(`/api/assets/${shown}/256`)).status).toBe(200)
    // A's photo stays on A: B's board holds the copy under the id it gave it.
    expect(existsSync(assetDir(server.dataDir, b.user.id, b.board, photo))).toBe(false)
  })

  it('a sweep right after an import keeps every imported photo', async () => {
    await start()
    const a = await account()
    const { notes } = await seed(a)
    const zip = await exportOf(a)
    const { importId } = await previewOk(a, zip)
    expect((await commitImport(a, importId)).status).toBe(200)
    const shown = stateOf(a).notes.get(notes[1] as string)?.image?.assetId as string

    const { store, quota, log } = server.deps
    if (!store || !quota) throw new Error('no store')
    const sweep = () =>
      sweepAssets(server.dataDir, a.user.id, a.board, server.clock.now(), store, log, { quota })
    await server.assets.settled()
    expect(await sweep()).toEqual({ removed: [], freedBytes: 0 })
    server.clock.advance(31 * DAY_MS)
    expect((await sweep()).removed).toEqual([])
    expect(listing(join(dirOf(a), 'assets', shown))).toEqual(['1024.webp', '256.webp', '2560.webp'])
    expect((await a.user.request(`/api/assets/${shown}/2560`)).status).toBe(200)
    expect(stateOf(a).assets.has(shown)).toBe(true)
  })

  it('cancel discards the staged import; a commit after it is 404', async () => {
    await start()
    const a = await account()
    await seed(a)
    const zip = await exportOf(a)
    const before = await untouched(a)
    const { importId } = await previewOk(a, zip)
    expect(importDirs(a)).toHaveLength(1)
    const res = await a.user.request(`/api/boards/${a.board}/import/${importId}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(204)
    expect(await untouched(a)).toEqual(before)
    expect((await commitImport(a, importId)).status).toBe(404)
  })

  it('a staged import expires after 15 minutes', async () => {
    await start()
    const a = await account()
    await seed(a)
    const zip = await exportOf(a)
    const before = await untouched(a)
    const { importId } = await previewOk(a, zip)
    server.clock.advance(15 * 60_000 + 1)
    expect((await commitImport(a, importId)).status).toBe(404)
    expect(await untouched(a)).toEqual(before)
  })

  it('a board holding an asset record whose files are gone exports, and its import drops the record', async () => {
    await start()
    const a = await account()
    const { notes, photo } = await seed(a)
    rmSync(join(dirOf(a), 'assets', photo), { recursive: true })

    // The export skips the record's file (the zip writer never trips on it).
    const zip = await exportOf(a)
    const names = readZip(zip).map((e) => e.name)
    expect(names.sort()).toEqual(['board.jsonl', 'manifest.json'])
    expect(parseBoard(jsonlOf(zip)).state?.assets.has(photo)).toBe(true)

    const { preview: p, importId } = await previewOk(a, zip)
    expect(p).toMatchObject({ notes: 2, assets: 0 })
    expect((await commitImport(a, importId)).status).toBe(200)
    const state = stateOf(a)
    expect(state.assets.size).toBe(0)
    expect(state.notes.get(notes[1] as string)?.image).toBeNull()
    const repairs = readFileSync(join(dirOf(a), 'repairs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(JSON.parse(l).raw).type)
    expect(repairs).toEqual(['asset', 'note'])
  })

  it('a figure whose photo files are gone imports as its caption', async () => {
    await start()
    const a = await account()
    const { notes, photo } = await seed(a)
    const book = bookRecord({ createdAt: T0, updatedAt: T0 })
    const figure = blockRecord(book.id, 'V', 'The harbour', {
      kind: 'figure',
      image: { assetId: photo, card: notes[1] as string },
    })
    await commit(a, [bookCreate(book), blockCreate(figure)])
    rmSync(join(dirOf(a), 'assets', photo), { recursive: true })

    const zip = await exportOf(a)
    const { preview: p, importId } = await previewOk(a, zip)
    expect(p).toMatchObject({ notes: 2, assets: 0, books: 1, blocks: 1 })
    expect((await commitImport(a, importId)).status).toBe(200)
    const state = stateOf(a)
    expect(state.blocks.get(figure.id)).toMatchObject({
      kind: 'p',
      text: 'The harbour',
      marks: [{ t: `c:${notes[1]}`, from: 0, to: 11 }],
    })
    expect(state.blocks.get(figure.id)?.image).toBeUndefined()
    expect(state.books.get(book.id)?.cards).toEqual([notes[1]])
    expect(validateInvariants(state)).toEqual([])
    const repairs = readFileSync(join(dirOf(a), 'repairs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(JSON.parse(l).raw).type)
    expect(repairs).toEqual(['asset', 'note', 'block'])
  })
})

describe('plain jsonl', () => {
  it('jsonl without assets imports; jsonl with an image note is import-invalid', async () => {
    await start()
    const a = await account()
    const noteId = newId('note')
    await commit(a, [noteCreate({ id: noteId, text: 'words only', at: T0 })])
    const plain = await exportOf(a, 'jsonl')
    await commit(a, [{ op: 'note.delete', id: noteId }])

    const { preview: p, importId } = await previewOk(a, plain, 'board.jsonl')
    expect(p).toMatchObject({ notes: 1, yarns: 0, assets: 0, bytes: 0 })
    expect((await commitImport(a, importId)).status).toBe(200)
    expect(stateOf(a).notes.get(noteId)?.text).toBe('words only')

    // With a photo, the plain text cannot carry it.
    await seed(a)
    const withPhoto = await exportOf(a, 'jsonl')
    const before = await untouched(a)
    const res = await preview(a, withPhoto, 'board.jsonl')
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'import-invalid' })
    expect(await untouched(a)).toEqual(before)

    // Cut off before its eof: damaged just past its last line.
    const lines = plain.toString('utf8').trimEnd().split('\n')
    const cut = await preview(a, Buffer.from(`${lines.slice(0, -1).join('\n')}\n`), 'b.jsonl')
    expect(cut.status).toBe(422)
    expect(await cut.json()).toMatchObject({ reason: 'missing-eof', line: lines.length })
  })

  it('an unknown record type is skipped and counted', async () => {
    await start()
    const a = await account()
    await commit(a, [noteCreate({ text: 'kept', at: T0 })])
    const text = (await exportOf(a, 'jsonl')).toString('utf8')
    const lines = text.trimEnd().split('\n')
    const body = [...lines.slice(0, -1), JSON.stringify({ type: 'sticker', id: 'x' })]
    const revision = (JSON.parse(lines.at(-1) as string) as { revision: number }).revision
    const file = `${[...body, JSON.stringify(computeEof(body, revision))].join('\n')}\n`
    const { preview: p } = await previewOk(a, Buffer.from(file), 'board.jsonl')
    expect(p).toMatchObject({ notes: 1, skippedRecords: 1 })
  })
})

/** The zip's entries as `writeZip` takes them, each changed by `edit`. */
function entriesOf(zip: Buffer): RawZipEntry[] {
  return readZip(zip).map((e) => ({ name: e.name, data: e.data }))
}

const replaceEntry = (entries: RawZipEntry[], name: string, data: Buffer) =>
  entries.map((e) => (e.name === name ? { ...e, data } : e))

describe('hostile archives', () => {
  type Case = {
    name: string
    build(zip: Buffer, a: Account): Buffer | Promise<Buffer>
    status?: number
    line?: boolean
    reason?: string
  }
  const cases: Case[] = [
    {
      name: 'a zip bomb (an entry over 100:1)',
      build: (zip) =>
        writeZip([
          ...entriesOf(zip).filter((e) => e.name !== 'board.jsonl'),
          { name: 'board.jsonl', data: Buffer.alloc(20 * MIB, 0x20) },
        ]),
    },
    {
      name: 'an entry that inflates past the size it claims',
      build: (zip) =>
        writeZip([
          ...entriesOf(zip).filter((e) => e.name !== 'board.jsonl'),
          { name: 'board.jsonl', data: Buffer.alloc(4 * MIB, 0x20), claimedSize: 60_000 },
        ]),
    },
    {
      name: 'a ../ entry name',
      build: (zip) =>
        writeZip([...entriesOf(zip), { name: '../escape.jsonl', data: Buffer.from('x') }]),
    },
    {
      name: 'an asset name with ../ in it',
      build: (zip) =>
        writeZip([
          ...entriesOf(zip),
          { name: `assets/../../${newId('asset')}.webp`, data: Buffer.from('x') },
        ]),
    },
    {
      name: 'an absolute entry name',
      build: (zip) =>
        writeZip([...entriesOf(zip), { name: '/etc/papertie.jsonl', data: Buffer.from('x') }]),
    },
    {
      name: 'a symlink entry',
      build: (zip) =>
        writeZip(
          entriesOf(zip).map((e) =>
            e.name.startsWith('assets/')
              ? { ...e, data: Buffer.from('../../../auth.db'), mode: 0o120777, method: 'store' }
              : e,
          ),
        ),
    },
    {
      name: 'a directory entry',
      build: (zip) =>
        writeZip([
          { name: 'assets/', data: Buffer.alloc(0), mode: 0o40755, method: 'store' },
          ...entriesOf(zip),
        ]),
    },
    {
      name: 'a duplicate entry',
      build: (zip) => {
        const entries = entriesOf(zip)
        const jsonl = entries.find((e) => e.name === 'board.jsonl') as RawZipEntry
        return writeZip([...entries, jsonl])
      },
    },
    {
      name: 'an entry of any other name',
      build: (zip) => writeZip([...entriesOf(zip), { name: 'notes.txt', data: Buffer.from('hi') }]),
    },
    {
      name: 'an asset over 25 MB',
      build: (zip) =>
        writeZip(
          entriesOf(zip).map((e) =>
            e.name.startsWith('assets/')
              ? { ...e, data: Buffer.alloc(25 * MIB + 1, 7), method: 'store' }
              : e,
          ),
        ),
    },
    {
      name: 'a bad eof checksum',
      line: true,
      build: (zip) => {
        const entries = entriesOf(zip)
        const text = jsonlOf(zip)
        const lines = text.trimEnd().split('\n')
        const eof = JSON.parse(lines.at(-1) as string) as { sha256: string }
        eof.sha256 = '0'.repeat(64)
        const bad = `${[...lines.slice(0, -1), JSON.stringify(eof)].join('\n')}\n`
        return writeZip(replaceEntry(entries, 'board.jsonl', Buffer.from(bad)))
      },
    },
    {
      name: 'a manifest with version 2',
      build: (zip) => {
        const entries = entriesOf(zip)
        const m = entries.find((e) => e.name === 'manifest.json') as RawZipEntry
        const manifest = { ...JSON.parse(m.data.toString('utf8')), version: 2 }
        return writeZip(
          replaceEntry(entries, 'manifest.json', Buffer.from(JSON.stringify(manifest))),
        )
      },
    },
    ...[5, 7].map(
      (v): Case => ({
        name: `a board of schema version ${v}`,
        line: true,
        reason: 'unsupported-version',
        build: (zip) => {
          const lines = jsonlOf(zip).trimEnd().split('\n')
          const body = lines.slice(0, -1)
          body[0] = (body[0] as string).replace('"schemaVersion":6', `"schemaVersion":${v}`)
          const { revision } = JSON.parse(lines.at(-1) as string) as { revision: number }
          const text = `${[...body, JSON.stringify(computeEof(body, revision))].join('\n')}\n`
          return writeZip(replaceEntry(entriesOf(zip), 'board.jsonl', Buffer.from(text)))
        },
      }),
    ),
    {
      name: 'a photo that is not an image',
      build: (zip) =>
        writeZip(
          entriesOf(zip).map((e) =>
            e.name.startsWith('assets/') ? { ...e, data: Buffer.from('<svg onload=alert(1)>') } : e,
          ),
        ),
    },
    {
      name: 'something that is not a board at all',
      build: () => Buffer.from('%PDF-1.4\n'),
    },
  ]

  it('import rejects hostile archives without touching the board', async () => {
    await start()
    const a = await account()
    await seed(a)
    const zip = await exportOf(a)
    for (const c of cases) {
      const before = await untouched(a)
      const res = await preview(a, await c.build(zip, a))
      const body = (await res.json()) as { error: string; line?: number; reason?: string }
      expect(res.status, `${c.name}: ${JSON.stringify(body)}`).toBe(c.status ?? 422)
      expect(body.error, c.name).toBe('import-invalid')
      expect(typeof body.reason, c.name).toBe('string')
      if (c.reason) expect(body.reason, c.name).toBe(c.reason)
      if (c.line) expect(body.line, c.name).toBeGreaterThan(0)
      else expect(body.line, c.name).toBeUndefined()
      expect(await untouched(a), c.name).toEqual(before)
    }
    // Nothing of what the files said reached the log: no names, no entry names.
    const logs = server.logs.join('\n')
    for (const secret of ['escape', 'papertie.jsonl', 'notes.txt', 'auth.db', 'first note']) {
      expect(logs, secret).not.toContain(secret)
    }
  }, 120_000)

  it('quota is checked before any asset is written (507)', async () => {
    await start({ limits: { quotaBytes: MIB } })
    const a = await account()
    const photo = await upload(a, await png(64, 48))
    await commit(a, [noteShowing(photo)])
    // The file's photo is larger than what is left of the quota.
    const big = await sharp(randomBytes(800 * 800 * 3), {
      raw: { width: 800, height: 800, channels: 3 },
    })
      .png()
      .toBuffer()
    expect(big.length).toBeGreaterThan(MIB)
    const zip = writeZip(
      entriesOf(await exportOf(a)).map((e) =>
        e.name.startsWith('assets/') ? { ...e, data: big, method: 'store' } : e,
      ),
    )
    const before = await untouched(a)
    const res = await preview(a, zip)
    expect(res.status).toBe(507)
    expect(await res.json()).toEqual({
      error: 'quota',
      needMb: Math.ceil(big.length / MIB),
      freeMb: Math.floor((MIB - before.usage) / MIB),
    })
    expect(await untouched(a)).toEqual(before)
  })

  it('a file over the remaining quota plus 1 GB for the board text is 413 too-large', async () => {
    await start({ limits: { quotaBytes: 1024 } })
    const a = await account()
    // Announced, never sent: the answer comes before any of it is read.
    const { hostname, port } = new URL(server.url)
    const head = [
      `POST /api/boards/${a.board}/import HTTP/1.1`,
      `Host: ${hostname}:${port}`,
      `Origin: ${server.url}`,
      'Content-Type: multipart/form-data; boundary=x',
      `Content-Length: ${1024 ** 3 + 2 * MIB}`,
      'Connection: close',
    ]
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), hostname)
      let out = ''
      socket.setEncoding('utf8')
      socket.on('data', (d) => {
        out += d
      })
      socket.on('end', () => resolve(out))
      socket.on('close', () => resolve(out))
      socket.on('error', reject)
      socket.write(`${head.join('\r\n')}\r\n\r\n--x\r\n`)
    })
    expect(reply.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 413 /)
    expect(reply).toContain('"error":"too-large"')
    expect(importDirs(a)).toEqual([])
  })
})

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
  it('a second preview of the board stops the first in flight: one import dir, the quota counts one', async () => {
    await start()
    const a = await account()
    await seed(a)
    const zip = await exportOf(a)
    const before = await untouched(a)
    let release = () => {}
    const go = new Promise<void>((r) => {
      release = r
    })
    const first = slowUpload(a, zip, 100, go)
    await until(() => importDirs(a).length === 1)
    const firstDir = importDirs(a)[0]

    const second = await previewOk(a, zip)
    const res = await first
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'superseded' })
    release()
    // Only the second is staged; the first's directory is gone.
    expect(importDirs(a)).toHaveLength(1)
    expect(importDirs(a)).not.toContain(firstDir)
    expect(await usage(a)).toBe(before.usage + second.preview.bytes)
    expect((await commitImport(a, second.importId)).status).toBe(200)

    // And a preview while one is staged discards it before it starts.
    const third = await previewOk(a, zip)
    const fourth = await previewOk(a, zip)
    expect((await commitImport(a, third.importId)).status).toBe(404)
    expect(importDirs(a)).toHaveLength(1)
    const used = await usage(a)
    const cancel = await a.user.request(`/api/boards/${a.board}/import/${fourth.importId}`, {
      method: 'DELETE',
    })
    expect(cancel.status).toBe(204)
    expect(await usage(a)).toBe(used - fourth.preview.bytes)
    expect(importDirs(a)).toEqual([])
  })

  it('past the server-wide staging room: 507 staging-full, with the board, its photos and the quota untouched', async () => {
    await start({ limits: { importStagingBytes: 64 * 1024 } })
    const a = await account()
    await seed(a)
    const big = await sharp(randomBytes(200 * 200 * 3), {
      raw: { width: 200, height: 200, channels: 3 },
    })
      .png()
      .toBuffer()
    const zip = writeZip(
      entriesOf(await exportOf(a)).map((e) =>
        e.name.startsWith('assets/') ? { ...e, data: big, method: 'store' } : e,
      ),
    )
    expect(zip.length).toBeGreaterThan(64 * 1024)
    const before = await untouched(a)
    const res = await preview(a, zip)
    expect(res.status).toBe(507)
    expect(await res.json()).toEqual({ error: 'staging-full' })
    expect(await untouched(a)).toEqual(before)
    // The room is given back: a small file still fits.
    const small = await exportOf(a)
    expect(small.length).toBeLessThan(32 * 1024)
    expect((await preview(a, small)).status).toBe(200)
  })

  it('a deletion of all data is not held by a slow upload', async () => {
    await start()
    const a = await account()
    await seed(a)
    const zip = await exportOf(a)
    const first = slowUpload(a, zip, 100, new Promise(() => {}))
    await until(() => importDirs(a).length === 1)
    // Within 5 s is a timing row's (`import.timing.test.ts`).
    const del = await a.user.request('/api/data/delete', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'delete' }),
    })
    expect(del.status, await del.clone().text()).toBeLessThan(300)
    expect((await first).status).toBe(409)
  })
})

describe('a deletion of all data and an import commit', () => {
  /** The zip every import here uploads, its size and the staged photos' bytes (`preview.bytes`). */
  async function measured(): Promise<{ zip: Buffer; upload: number; photos: number }> {
    await start()
    const a = await account('measure')
    await seed(a)
    const zip = await exportOf(a)
    const { preview: p } = await previewOk(a, zip)
    await server.close()
    expect(p.bytes).toBeGreaterThan(1)
    // The staging room counts the request body as it streams in: the file and its framing.
    const form = new FormData()
    form.append('file', new File([new Uint8Array(zip)], 'board.papertie'))
    const upload = (await new Response(form).arrayBuffer()).byteLength
    return { zip, upload, photos: p.bytes }
  }

  const deleteAll = (a: Account) =>
    a.user.request('/api/data/delete', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'delete' }),
    })

  it('either order ends clean: nothing staged is left, the staging room is given back', async () => {
    const { zip, upload, photos } = await measured()
    // Room for one import (its upload, then its photos) and half its photos more: a staging room
    // the commit kept would turn the next preview away with 507.
    await start({ limits: { importStagingBytes: upload + photos + Math.floor(photos / 2) } })
    for (let round = 0; round < 3; round++) {
      const a = await account(`gone${round}`)
      const { importId } = await previewOk(a, zip)
      const [committed, deleted] = await Promise.all([commitImport(a, importId), deleteAll(a)])
      expect(deleted.status, await deleted.clone().text()).toBe(200)
      // Committed before the deletion took the board, or refused once it had begun.
      expect([200, 404], await committed.clone().text()).toContain(committed.status)
      expect(existsSync(join(server.dataDir, 'users', a.user.id, 'boards', a.board))).toBe(false)
      expect(readdirSync(join(server.dataDir, 'trash'))).toEqual([])
    }
    // The room is all there: another import still fits, and commits.
    const c = await account('after')
    const { importId } = await previewOk(c, zip)
    expect((await commitImport(c, importId)).status).toBe(200)
  })

  it('a deletion begun before the commit: 404, the board, its photos and the quota as they were', async () => {
    const { zip, upload, photos } = await measured()
    await start({ limits: { importStagingBytes: upload + photos + Math.floor(photos / 2) } })
    const a = await account()
    await seed(a)
    const { importId } = await previewOk(a, zip)
    const store = server.deps.store
    if (!store) throw new Error('no store')
    // The deletion's first step, which a commit can meet: no board write from here on.
    await store.beginDeletion(a.user.id)
    const res = await commitImport(a, importId)
    expect(res.status).toBe(404)
    // The deletion fails after all (say a disk error): the user's data goes on.
    store.cancelDeletion(a.user.id)
    const board = readBoardFile(server, a.user.id, a.board).toString('base64')
    // The deletion discarded the staged import (its directory goes in the background).
    await until(() => importDirs(a).length === 0)
    // What the import reserved is no longer counted: the quota is what the disk holds.
    const counted = await usage(a)
    server.deps.quota?.forget(a.user.id)
    expect(await usage(a)).toBe(counted)
    // And the staging room is free again: the same import fits once more, and commits.
    const again = await previewOk(a, zip)
    expect((await commitImport(a, again.importId)).status).toBe(200)
    expect(readBoardFile(server, a.user.id, a.board).toString('base64')).not.toBe(board)
  })
})

describe('a commit that fails after its photos moved in', () => {
  /** Throws once at `import:after-asset-move`, after running `before` (when armed). */
  function faultAfterMove() {
    const f = {
      armed: false,
      before: () => {},
      hit(point: FaultPoint) {
        if (!f.armed || point !== 'import:after-asset-move') return
        f.armed = false
        f.before()
        throw Object.assign(new Error('EIO'), { code: 'EIO' })
      },
    }
    return f
  }

  /** A second board of `a`'s user, holding one photo of another size than `seed`'s. */
  async function secondBoard(a: Account): Promise<Account> {
    const b: Account = { ...a, board: await createBoard(a.user, 'second'), seq: 0 }
    const photo = await upload(b, await png(300, 200))
    await commit(b, [noteShowing(photo)])
    return b
  }

  const photoDirs = (a: Account) => {
    const dir = join(dirOf(a), 'assets')
    return existsSync(dir) ? readdirSync(dir).sort() : []
  }

  it('the photos go back out at once, and only its own quota is given back: the other staged import keeps its reservation', async () => {
    const faults = faultAfterMove()
    server = await startTestServer({ clock: new FakeClock(T0), faults })
    const a = await account()
    await seed(a)
    const b = await secondBoard(a)
    const zipA = await exportOf(a)
    const zipB = await exportOf(b)
    const before = await untouched(a)
    const pa = await previewOk(a, zipA)
    const pb = await previewOk(b, zipB)
    expect(pa.preview.bytes).not.toBe(pb.preview.bytes)
    expect(await usage(a)).toBe(before.usage + pa.preview.bytes + pb.preview.bytes)

    faults.armed = true
    const res = await commitImport(a, pa.importId)
    expect(res.status).toBe(503)
    // The board, its photo directories and its import directories as they were: nothing moved
    // in is left without a record.
    expect(await untouched(a)).toEqual({ ...before, usage: before.usage + pb.preview.bytes })
    expect(photoDirs(a)).toEqual(before.assets.filter((n) => !n.includes('/')))

    // The other board's import still holds its reservation: committed, the count is the disk's.
    expect((await commitImport(b, pb.importId)).status).toBe(200)
    expect(await usage(a)).toBe(before.usage + pb.preview.bytes)
    server.deps.quota?.forget(a.user.id)
    expect(await usage(a)).toBe(before.usage + pb.preview.bytes)
  })

  it('a failure after the rename, then a restore queued first: its safety backup keeps the photos', async () => {
    // The import's snapshot is renamed in and then the install fails (the directory fsync, say);
    // a restore already waiting on the board runs before the rollback, and its safety backup is
    // of the imported board, naming the imported photo.
    let restoring: Promise<unknown> = Promise.resolve()
    let armed = false
    const faults = {
      hit(point: FaultPoint) {
        if (!armed || point !== 'snapshot:after-rename') return
        armed = false
        const store = server.deps.store
        if (!store) throw new Error('no store')
        const older = readdirSync(join(dirOf(a), 'backups')).find((n) => n.endsWith('.jsonl'))
        restoring = store.restoreBackup(a.user.id, a.board, older as string).catch((e) => e)
        throw Object.assign(new Error('EIO'), { code: 'EIO' })
      },
    }
    server = await startTestServer({ clock: new FakeClock(T0), faults })
    const a = await account()
    await seed(a)
    const zip = await exportOf(a)
    const before = photoDirs(a)
    const { importId } = await previewOk(a, zip)
    armed = true
    expect((await commitImport(a, importId)).status).toBe(503)
    const restored = (await restoring) as { safetyBackup?: string }
    expect(restored.safetyBackup).toBeDefined()
    // The restore's safety backup is the imported board: its photo is there, files and all.
    const safety = parseBoard(
      readFileSync(join(dirOf(a), 'backups', restored.safetyBackup as string), 'utf8'),
    ).state
    const shown = [...(safety?.notes.values() ?? [])].flatMap((n) =>
      n.image ? [n.image.assetId] : [],
    )
    const imported = shown.filter((id) => !before.includes(id))
    expect(imported).toHaveLength(1)
    for (const id of imported) {
      for (const size of ASSET_SIZES) {
        expect(existsSync(join(dirOf(a), 'assets', id, `${size}.webp`)), `${id} ${size}`).toBe(true)
      }
    }
    // Restoring it brings the imported board back with its photo.
    const res = await a.user.request(
      `/api/boards/${a.board}/backups/${encodeURIComponent(restored.safetyBackup as string)}/restore`,
      { method: 'POST', body: '{}' },
    )
    expect(res.status).toBe(200)
    expect(stateOf(a).notes.size).toBe(safety?.notes.size)
    expect([...stateOf(a).notes.values()].filter((n) => n.image).length).toBe(shown.length)
  })

  it('a rollback that cannot finish keeps moved.json, and the next start removes the photos', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'papertie-import-fail-'))
    dataDirs.push(dataDir)
    const faults = faultAfterMove()
    server = await startTestServer({ clock: new FakeClock(T0), faults, dataDir })
    const a = await account()
    await seed(a)
    const zip = await exportOf(a)
    const before = await untouched(a)
    const { importId, preview: p } = await previewOk(a, zip)
    // The board cannot be read just then (EACCES): no photo may be judged a leftover.
    const file = join(dirOf(a), 'board.jsonl')
    faults.before = () => chmodSync(file, 0o000)
    faults.armed = true
    try {
      expect((await commitImport(a, importId)).status).toBe(503)
    } finally {
      chmodSync(file, 0o600)
    }
    // Left for the next start, with the list naming them; their bytes still counted.
    const [left] = importDirs(a)
    expect(left).toBeDefined()
    expect(existsSync(join(dirOf(a), left as string, 'moved.json'))).toBe(true)
    const moved = photoDirs(a).filter((id) => !before.assets.includes(id))
    expect(moved).toHaveLength(1)
    expect(await usage(a)).toBe(before.usage + p.bytes)
    await server.close()

    server = await startTestServer({ clock: new FakeClock(T0), dataDir })
    expect(importDirs(a)).toEqual([])
    expect(photoDirs(a)).toEqual(before.assets.filter((n) => !n.includes('/')))
    expect(await usage(a)).toBe(before.usage)
  })
})

describe('logs', () => {
  it('an import logs ids, counts and sizes only', async () => {
    await start()
    const a = await account('secretive')
    await seed(a, 'a private thought')
    const zip = await exportOf(a)
    const { importId } = await previewOk(a, zip)
    expect((await commitImport(a, importId)).status).toBe(200)
    const logs = server.logs.join('\n')
    expect(logs).toContain('board imported')
    for (const secret of ['secretive board', 'a private thought', 'manifest.json', 'board.jsonl']) {
      expect(logs).not.toContain(secret)
    }
  })
})

describe('at 100,000 notes', () => {
  it('the preview and the commit of a 100,000-note board go through', async () => {
    // The file is built before the server has a connection to keep alive: building it holds this
    // process (the server's too) for seconds, and a kept-alive socket whose timeout ran out under
    // that block can be reset under the next request (ECONNRESET in a loaded gate run). Another
    // board's file imports as any export does.
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

    // How long each holds the event loop is a timing row's (`import.timing.test.ts`).
    const staged = await previewOk(a, zip)
    expect(staged.preview).toMatchObject({ notes: 100_000, yarns: huge.yarns.size })
    expect((await commitImport(a, staged.importId)).status).toBe(200)
    expect(stateOf(a).notes.size).toBe(100_000)
  }, 300_000)
})

const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)

describe('the caps on threads and photo records', () => {
  /** A board file that carries `count` records made by `record`, no eof: the cap stops it first. */
  async function reasonFor(count: number, record: (i: number) => unknown): Promise<unknown> {
    const head = serializeBoard(hugeState('board_01JCAPSCAPSCAPSCAPSCAPSCAP', 0)).split('\n')[0]
    async function* chunks() {
      yield Buffer.from(`${head}\n`)
      for (let i = 0; i < count; i += 10_000) {
        const lines: string[] = []
        for (let j = i; j < Math.min(count, i + 10_000); j++) lines.push(JSON.stringify(record(j)))
        yield Buffer.from(`${lines.join('\n')}\n`)
      }
    }
    return readBoardLines(chunks()).then(
      () => 'accepted',
      (e: unknown) => (e instanceof ImportInvalid ? e.reason : e),
    )
  }
  const at = '2026-10-27T10:00:00.000Z'

  it('an import with more notes than maxNotes is refused as too-many-notes', async () => {
    await start()
    const note = (i: number) => ({
      type: 'note',
      id: newId('note'),
      x: i,
      y: 0,
      w: 220,
      h: 160,
      z: i + 1,
      paper: 'cream',
      style: 'smooth',
      text: '',
      image: null,
      createdAt: at,
      updatedAt: at,
    })
    expect(await reasonFor(LIMITS.maxNotes + 1, note)).toBe('too-many-notes')
  }, 120_000)

  it('an import with more threads than 4 × maxNotes is refused as too-many-threads', async () => {
    await start()
    expect(IMPORT_CAPS.yarns).toBe(4 * LIMITS.maxNotes)
    const yarn = (i: number) => ({
      type: 'yarn',
      id: newId('yarn'),
      noteIds: [newId('note'), newId('note')],
      color: 'apricot',
      label: `${i}`,
      createdAt: at,
      updatedAt: at,
    })
    expect(await reasonFor(IMPORT_CAPS.yarns + 1, yarn)).toBe('too-many-threads')
  }, 120_000)

  it('an import with more asset records than maxNotes is refused as too-many-assets', async () => {
    await start()
    expect(IMPORT_CAPS.assets).toBe(LIMITS.maxNotes)
    const asset = () => ({
      type: 'asset',
      id: newId('asset'),
      mime: 'image/webp',
      width: 1,
      height: 1,
      bytes: 1,
      sha256: '0'.repeat(64),
      createdAt: at,
    })
    expect(await reasonFor(IMPORT_CAPS.assets + 1, asset)).toBe('too-many-assets')
  }, 120_000)
})

describe('books in an import (the board and its books are one unit)', () => {
  const at = '2026-10-27T10:00:00.000Z'
  const head = () =>
    serializeBoard(hugeState('board_01JCAPSCAPSCAPSCAPSCAPSCAP', 0)).split('\n')[0] as string
  /** A file of the board line, the lines `records` make and an eof that checks out. */
  async function reasonOf(records: Iterable<unknown>): Promise<unknown> {
    const body = [head(), ...[...records].map((r) => JSON.stringify(r))]
    const eof = computeEof(body, 0)
    async function* chunks() {
      for (let i = 0; i < body.length; i += 10_000) {
        yield Buffer.from(`${body.slice(i, i + 10_000).join('\n')}\n`)
      }
      yield Buffer.from(`${JSON.stringify(eof)}\n`)
    }
    return readBoardLines(chunks()).then(
      () => 'accepted',
      (e: unknown) => (e instanceof ImportInvalid ? e.reason : e),
    )
  }
  const bookLine = (i = 0) => bookRecord({ title: `b${i}`, createdAt: at, updatedAt: at })
  const keys = posKeysBetween(null, null, LIMITS.maxBlocksPerBook + 1)
  const blockLine = (bookId: string, i: number) => blockRecord(bookId, keys[i] as string, `p ${i}`)

  it('the import preview counts books; an import replaces board and books together', async () => {
    await start()
    const a = await account('a')
    await seed(a)
    const book = bookRecord({ createdAt: at, updatedAt: at })
    const keys = ['V', 'W', 'X']
    await commit(a, [
      bookCreate(book),
      ...keys.map((k, i) => blockCreate(blockRecord(book.id, k, `paragraph ${i}`))),
    ])
    const file = await exportOf(a)
    // The other board has a book of its own, which the import takes away with the rest.
    const b = await account('b')
    const own = bookRecord({ createdAt: at, updatedAt: at })
    await commit(b, [bookCreate(own), blockCreate(blockRecord(own.id, 'V', 'mine'))])
    const body = await previewOk(b, file)
    expect(body.preview).toMatchObject({ notes: 2, yarns: 1, books: 1, blocks: 3 })
    const res = await commitImport(b, body.importId)
    expect(res.status, await res.clone().text()).toBe(200)
    const s = stateOf(b)
    expect([...s.books.keys()]).toEqual([book.id])
    expect([...s.blocks.values()].map((x) => x.text).sort()).toEqual([
      'paragraph 0',
      'paragraph 1',
      'paragraph 2',
    ])
    // The safety backup holds the board and its book as they were.
    const backups = readdirSync(join(dirOf(b), 'backups')).filter((n) => n.endsWith('.jsonl'))
    const kept = backups.map(
      (n) => parseBoard(readFileSync(join(dirOf(b), 'backups', n), 'utf8')).state,
    )
    expect(kept.some((k) => k?.books.has(own.id) && k.blocks.size === 1)).toBe(true)
  })

  it('an import with a block of a missing book is refused as missing-book', async () => {
    await start()
    const book = bookLine()
    expect(await reasonOf([book, blockLine(newId('book'), 0)])).toBe('missing-book')
    // Its own book, wherever in the file, is no trouble.
    const other = bookLine(1)
    expect(await reasonOf([blockLine(other.id, 0), other])).toBe('accepted')
  })

  it('an import with more than maxBooks books is refused as too-many-books', async () => {
    await start()
    expect(IMPORT_CAPS.books).toBe(LIMITS.maxBooks)
    const books = Array.from({ length: LIMITS.maxBooks + 1 }, (_, i) => bookLine(i))
    expect(await reasonOf(books)).toBe('too-many-books')
    expect(await reasonOf(books.slice(0, LIMITS.maxBooks))).toBe('accepted')
  })

  it('an import with more than maxBlocksPerBook blocks in one book is refused as too-many-blocks', async () => {
    await start()
    expect(IMPORT_CAPS.blocksPerBook).toBe(LIMITS.maxBlocksPerBook)
    const book = bookLine()
    function* lines(n: number) {
      yield book
      for (let i = 0; i < n; i++) yield blockLine(book.id, i)
    }
    expect(await reasonOf(lines(LIMITS.maxBlocksPerBook + 1))).toBe('too-many-blocks')
    expect(await reasonOf(lines(LIMITS.maxBlocksPerBook))).toBe('accepted')
  }, 120_000)

  it('an import with a book longer than maxBookChars is refused as book-too-long', async () => {
    await start()
    const book = bookLine()
    const text = 'x'.repeat(LIMITS.maxBlockText)
    const n = LIMITS.maxBookChars / LIMITS.maxBlockText
    function* lines(blocks: number, extra: number) {
      yield book
      for (let i = 0; i < blocks; i++) yield { ...blockLine(book.id, i), text }
      if (extra > 0) yield { ...blockLine(book.id, blocks), text: 'y'.repeat(extra) }
    }
    expect(await reasonOf(lines(n, 1))).toBe('book-too-long')
    // At the limit exactly, and two books each below it, are no trouble.
    expect(await reasonOf(lines(n, 0))).toBe('accepted')
    const other = bookLine(2)
    const half = n / 2
    function* two() {
      yield* lines(half, 0)
      yield other
      for (let i = 0; i < half + 1; i++) yield { ...blockLine(other.id, half + 1 + i), text }
    }
    expect(await reasonOf(two())).toBe('accepted')
  }, 120_000)

  it('a trashed book in the file is dated by the import, so the purge counts its 30 days from now', async () => {
    await start()
    const a = await account('a')
    const old = bookRecord({ trashedAt: '2001-01-01T00:00:00.000Z', createdAt: at, updatedAt: at })
    const live = bookRecord({ title: 'live', createdAt: at, updatedAt: at })
    const body = [
      head(),
      JSON.stringify(old),
      JSON.stringify(live),
      JSON.stringify(blockRecord(old.id, 'V', 'still here')),
    ]
    const file = `${[...body, JSON.stringify(computeEof(body, 0))].join('\n')}\n`
    const staged = await previewOk(a, Buffer.from(file), 'board.jsonl')
    expect(staged.preview.books).toBe(2)
    expect((await commitImport(a, staged.importId)).status).toBe(200)
    const s = stateOf(a)
    const now = server.clock.now().toISOString()
    expect(s.books.get(old.id)?.trashedAt).toBe(now)
    expect(s.books.get(live.id)?.trashedAt).toBeNull()
    const store = server.deps.store as BoardStore
    const r = await purgeBooks(store, a.user.id, a.board, server.clock)
    expect(r).toMatchObject({ books: 0 })
    expect(stateOf(a).blocks.size).toBe(1)
  })

  it('a block whose marks are not sound is refused with its line', async () => {
    await start()
    const book = bookLine()
    const bad = { ...blockLine(book.id, 0), marks: [{ t: 'b', from: 0, to: 99 }] }
    expect(await reasonOf([book, bad])).toBe('invalid-record')
  })
})
