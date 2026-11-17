import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newId, parseBoard, posKeysBetween, serializeBoard } from '@papertie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { boardDir, createBoard, noteCreate, postOps, tabNow } from './helpers/boards'
import { blockCreate, blockRecord, bookCreate, bookRecord } from './helpers/books'
import type { TestUser } from './helpers/client'
import { FakeClock } from './helpers/clock'
import { startTestServer, type TestServer } from './helpers/harness'
import { png } from './helpers/images'
import { readZip } from './helpers/zip'

const T0 = '2026-10-27T10:00:00.000Z'

let server: TestServer
let user: TestUser
let board: string
let assetId: string

beforeAll(async () => {
  server = await startTestServer({ clock: new FakeClock(T0) })
  user = server.user
  board = await createBoard(user, 'My Board! Ωμ 2026')
  const clientId = tabNow(server)
  const decorated = { ...noteCreate({ at: T0, text: 'decorated' }) }
  decorated.note = { ...decorated.note, motif: 'fold', stamp: true } as typeof decorated.note
  const first = await postOps(user, board, {
    clientId,
    seq: 1,
    baseRevision: 0,
    ops: [noteCreate({ at: T0, text: 'first' }), decorated],
  })
  expect(first.status).toBe(200)
  const second = await postOps(user, board, {
    clientId,
    seq: 2,
    baseRevision: 1,
    ops: [noteCreate({ at: T0, text: 'second' })],
  })
  expect(second.status).toBe(200)

  const form = new FormData()
  form.append('file', new File([new Uint8Array(await png(64, 48))], 'p.png', { type: 'image/png' }))
  const up = await user.request(`/api/boards/${board}/assets`, { method: 'POST', body: form })
  expect(up.status).toBe(201)
  assetId = ((await up.json()) as { asset: { id: string } }).asset.id
})

afterAll(() => server?.close())

const currentText = async () => {
  const res = await user.request(`/api/boards/${board}`)
  return res.text()
}

describe('GET /api/boards/:id/export', () => {
  it('jsonl: serializeBoard of the committed state, as an attachment', async () => {
    const res = await user.request(`/api/boards/${board}/export?format=jsonl`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/x-ndjson/)
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="my-board-2026-20261027.jsonl"',
    )
    const body = await res.text()
    const parsed = parseBoard(body)
    expect(parsed.integrity).toBe('ok')
    expect(parsed.issues).toEqual([])
    const state = parsed.state
    if (!state) throw new Error('export did not parse')
    expect(body).toBe(serializeBoard(state))
    const current = parseBoard(await currentText()).state
    if (!current) throw new Error('board did not parse')
    expect(body).toBe(serializeBoard(current))
    expect(state.notes.size).toBe(3)
    expect(state.board.revision).toBe(current.board.revision)
    // Decorations travel with the note.
    const decorated = [...state.notes.values()].find((n) => n.text === 'decorated')
    expect(decorated?.motif).toBe('fold')
    expect(decorated?.stamp).toBe(true)
  })

  it('papertie: a zip of manifest.json, board.jsonl and one webp per asset', async () => {
    const res = await user.request(`/api/boards/${board}/export?format=papertie`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="my-board-2026-20261027.papertie"',
    )
    const entries = readZip(Buffer.from(await res.arrayBuffer()))
    expect(entries.map((e) => e.name).sort()).toEqual(
      [`assets/${assetId}.webp`, 'board.jsonl', 'manifest.json'].sort(),
    )
    const byName = new Map(entries.map((e) => [e.name, e.data]))

    const jsonl = byName.get('board.jsonl')?.toString('utf8') ?? ''
    const state = parseBoard(jsonl).state
    if (!state) throw new Error('board.jsonl did not parse')
    expect(jsonl).toBe(await currentText())

    const manifest = JSON.parse(byName.get('manifest.json')?.toString('utf8') ?? 'null')
    expect(manifest).toEqual({
      format: 'papertie',
      version: 1,
      exportedAt: T0,
      boardId: board,
      name: 'My Board! Ωμ 2026',
      revision: state.board.revision,
      notes: 3,
      yarns: 0,
      assets: 1,
    })

    const onDisk = readFileSync(
      join(boardDir(server, user.id, board), 'assets', assetId, '2560.webp'),
    )
    expect(byName.get(`assets/${assetId}.webp`)?.equals(onDisk)).toBe(true)
  })

  it('the export manifest counts books and blocks, and board.jsonl carries them whole', async () => {
    const other = await createBoard(user, 'Books')
    const book = bookRecord()
    const keys = posKeysBetween(null, null, 4)
    const res0 = await postOps(user, other, {
      clientId: tabNow(server),
      seq: 1,
      baseRevision: 0,
      ops: [bookCreate(book), ...keys.map((k, i) => blockCreate(blockRecord(book.id, k, `p${i}`)))],
    })
    expect(res0.status).toBe(200)
    const res = await user.request(`/api/boards/${other}/export?format=papertie`)
    const byName = new Map(
      readZip(Buffer.from(await res.arrayBuffer())).map((e) => [e.name, e.data]),
    )
    const manifest = JSON.parse(byName.get('manifest.json')?.toString('utf8') ?? 'null')
    expect(manifest).toMatchObject({ version: 1, notes: 0, books: 1, blocks: 4 })
    const state = parseBoard(byName.get('board.jsonl')?.toString('utf8') ?? '').state
    expect(state?.board.schemaVersion).toBe(6)
    expect(state?.blocks.size).toBe(4)
    expect(state?.books.get(book.id)?.title).toBe(book.title)
  })

  it('the filename slug keeps only [a-z0-9-]', async () => {
    const odd = await createBoard(user, '  Ünïcødé / "quotes"; \\ ..  ')
    const res = await user.request(`/api/boards/${odd}/export?format=jsonl`)
    expect(res.status).toBe(200)
    const disposition = res.headers.get('content-disposition') ?? ''
    const name = /filename="([^"]*)"/.exec(disposition)?.[1] ?? ''
    expect(name).toMatch(/^[a-z0-9-]+-20261027\.jsonl$/)
    // Accents fold to their letter (NFKD); anything else outside [a-z0-9-] is dropped.
    expect(name).toBe('unicde-quotes-20261027.jsonl')
    await res.body?.cancel()

    const blank = await createBoard(user, 'Ωμ')
    const res2 = await user.request(`/api/boards/${blank}/export?format=jsonl`)
    expect(res2.headers.get('content-disposition')).toBe(
      'attachment; filename="board-20261027.jsonl"',
    )
    await res2.body?.cancel()
  })

  it('an unknown or missing format is 400 invalid', async () => {
    for (const q of ['?format=exe', '?format=', '', '?format=JSONL']) {
      const res = await user.request(`/api/boards/${board}/export${q}`)
      expect(res.status, q).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid' })
    }
  })

  it('a missing board is 404', async () => {
    const res = await user.request(`/api/boards/${newId('board')}/export?format=jsonl`)
    expect(res.status).toBe(404)
  })
})
