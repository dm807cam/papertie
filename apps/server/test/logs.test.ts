import { request as httpRequest } from 'node:http'
import { newId, parseBoard, serializeBoard, stateFromRecords } from '@papertie/core'
import { describe, expect, it } from 'vitest'
import { LOG_KEYS } from '../src/log'
import type { BoardStore } from '../src/store/boardStore'
import { purgeBooks } from '../src/store/bookPurge'
import { compactBoard, noteCreate, postOps, tabNow } from './helpers/boards'
import { blockCreate, blockRecord, bookCreate, bookRecord, edit, ins } from './helpers/books'
import { startTestServer } from './helpers/harness'
import { png } from './helpers/images'
import { openEvents } from './helpers/sse'
import { readZip, writeZip } from './helpers/zip'

const SENTINELS = [
  'SENTINEL-NAME-12',
  'SENTINEL-TEXT-34',
  'SENTINEL-LABEL-56',
  'SENTINEL-FILE-78',
  // What an imported file carries (its board name, a note, the upload's name,
  // its entries' names) and an export's file name.
  'SENTINEL-IMPORTED-NAME-90',
  'SENTINEL-IMPORTED-TEXT-91',
  'SENTINEL-IMPORT-FILE-92',
  'SENTINEL-ENTRY-93',
  'SENTINEL-TRAVERSAL-94',
  'SENTINEL-LINE-95',
]
const DAY_MS = 86_400_000
const T = '2026-10-27T10:00:00.000Z'

/** `jsonl` with `line` put in before its last (`eof`) line. */
function withLine(jsonl: string, line: string): string {
  const lines = jsonl.trimEnd().split('\n')
  lines.splice(-1, 0, line)
  return `${lines.join('\n')}\n`
}

/**
 * POSTs an oversized JSON `body` over a fresh connection (no pooling); resolves to the status.
 * Its `Content-Length` is the whole body's, but only its start is sent: the server answers 413
 * from the header, at once, and a client still writing the rest would meet the closed socket
 * (EPIPE, ECONNRESET) before it read the answer.
 */
function postOwnConnection(
  base: string,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}${path}`,
      {
        method: 'POST',
        agent: false,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          Connection: 'close',
        },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
        res.on('end', () => req.destroy())
      },
    )
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') reject(e)
    })
    req.write(body.slice(0, 65_536))
  })
}
const ID_IN_TEXT = /[a-z]+_[0-9A-HJKMNP-TV-Z]{26}/
/** `level` and `msg` are the logger's own envelope; every other key must be allowlisted. */
const ALLOWED_KEYS = new Set<string>([...LOG_KEYS, 'level', 'msg'])

describe('log content', () => {
  it('a full flow logs only allowlisted keys: no sentinel, id or user id', async () => {
    const server = await startTestServer()
    let userId = ''
    try {
      // 1–2. The one user (there are no accounts).
      const user = server.user
      const request = (path: string, init?: RequestInit) => user.request(path, init)
      userId = user.id
      expect(userId).toMatch(/^user_/)

      // 3. A board with a sentinel name.
      const created = await request('/api/boards', {
        method: 'POST',
        body: JSON.stringify({ name: 'SENTINEL-NAME-12' }),
      })
      expect(created.status).toBe(201)
      const boardId = ((await created.json()) as { id: string }).id
      const events = await openEvents(user, boardId)

      // 4. A note with sentinel text and a yarn with a sentinel label.
      const at = server.clock.now().toISOString()
      const notes = [newId('note'), newId('note')]
      const clientId = tabNow(server)
      const ops = await postOps(user, boardId, {
        clientId,
        seq: 1,
        baseRevision: 0,
        ops: [
          noteCreate({ id: notes[0], at, text: 'SENTINEL-TEXT-34' }),
          noteCreate({ id: notes[1], at }),
          {
            op: 'yarn.create',
            yarn: {
              type: 'yarn',
              id: newId('yarn'),
              noteIds: notes,
              color: 'apricot',
              label: 'SENTINEL-LABEL-56',
              createdAt: at,
              updatedAt: at,
            },
          },
        ],
      })
      expect(ops.status).toBe(200)
      expect((await events.next()).event).toBe('hello')
      expect((await events.next()).event).toBe('commit')
      events.close()

      // 5. An upload whose claimed filename is a sentinel.
      const form = new FormData()
      form.append(
        'file',
        new File([new Uint8Array(await png(32, 32))], 'SENTINEL-FILE-78.png', {
          type: 'image/png',
        }),
      )
      const uploaded = await request(`/api/boards/${boardId}/assets`, {
        method: 'POST',
        body: form,
      })
      expect(uploaded.status).toBe(201)
      const assetId = ((await uploaded.json()) as { asset: { id: string } }).asset.id
      expect((await request(`/api/assets/${assetId}/256`)).status).toBe(200)
      expect((await request(`/api/boards/${boardId}`)).status).toBe(200)
      // A path no route handles, with ids in it.
      expect((await request(`/api/boards/${boardId}/nope/${assetId}`)).status).toBe(404)

      // 7. A 422 (rejected op) and a 413 (oversized ops body).
      const rejected = await postOps(user, boardId, {
        clientId,
        seq: 2,
        baseRevision: 1,
        ops: [{ op: 'note.update', id: newId('note'), set: { text: 'SENTINEL-TEXT-34' } }],
      })
      expect(rejected.status).toBe(422)
      // On a connection of its own: the server closes it after the 413, which a pooled `fetch`
      // would meet as ECONNRESET on its next request.
      const tooLarge = await postOwnConnection(
        server.url,
        `/api/boards/${boardId}/ops`,
        { Origin: server.url },
        `"SENTINEL-TEXT-34${'x'.repeat(1_048_576)}"`,
      )
      expect(tooLarge).toBe(413)

      // 8. Export, both formats (the `.papertie` holds the photo's entry under its id).
      const jsonlExport = await request(`/api/boards/${boardId}/export?format=jsonl`)
      expect(jsonlExport.status).toBe(200)
      const exported = await request(`/api/boards/${boardId}/export?format=papertie`)
      expect(exported.status).toBe(200)
      const zip = readZip(Buffer.from(await exported.arrayBuffer()))

      // 9. Import. A file whose board name and note text are sentinels, uploaded under a sentinel
      // file name: previewed and cancelled, previewed again and committed.
      const exportedState = parseBoard(await jsonlExport.text()).state
      if (!exportedState) throw new Error('the export does not parse')
      const exportedNotes = [...exportedState.notes.values()]
      const first = exportedNotes[0]
      if (!first) throw new Error('no note in the export')
      const imported = stateFromRecords(
        { ...exportedState.board, name: 'SENTINEL-IMPORTED-NAME-90' },
        [
          ...exportedState.assets.values(),
          { ...first, text: 'SENTINEL-IMPORTED-TEXT-91' },
          ...exportedNotes.slice(1),
          ...exportedState.yarns.values(),
        ],
      )
      const archive = (entries: { name: string; data: Buffer }[]) =>
        writeZip(entries.map((e) => ({ name: e.name, data: e.data })))
      const goodZip = archive(
        zip.map((e) =>
          e.name === 'board.jsonl' ? { ...e, data: Buffer.from(serializeBoard(imported)) } : e,
        ),
      )
      const upload = (bytes: Buffer, name = 'SENTINEL-IMPORT-FILE-92.papertie') => {
        const f = new FormData()
        f.append('file', new File([new Uint8Array(bytes)], name))
        return request(`/api/boards/${boardId}/import`, { method: 'POST', body: f })
      }
      const staged = async () => {
        const res = await upload(goodZip)
        expect(res.status, await res.clone().text()).toBe(200)
        return ((await res.json()) as { importId: string }).importId
      }
      const cancelled = await staged()
      expect(
        (await request(`/api/boards/${boardId}/import/${cancelled}`, { method: 'DELETE' })).status,
      ).toBeLessThan(300)
      const kept = await staged()
      const committed = await request(`/api/boards/${boardId}/import/${kept}/commit`, {
        method: 'POST',
        body: '{}',
      })
      expect(committed.status, await committed.clone().text()).toBe(200)
      const { safetyBackup } = (await committed.json()) as { safetyBackup: string }
      // Hostile files: an entry no archive has, a traversal name, a board line that is no record.
      for (const bad of [
        archive([...zip, { name: 'SENTINEL-ENTRY-93.txt', data: Buffer.from('x') }]),
        archive([...zip, { name: '../SENTINEL-TRAVERSAL-94', data: Buffer.from('x') }]),
        archive(
          zip.map((e) =>
            e.name === 'board.jsonl'
              ? { ...e, data: Buffer.from(withLine(e.data.toString(), '{"SENTINEL-LINE-95":')) }
              : e,
          ),
        ),
      ]) {
        const res = await upload(bad)
        expect(res.status, await res.clone().text()).toBe(422)
      }
      const plain = await upload(
        Buffer.from('{"type":"board","name":"SENTINEL-LINE-95"}\n'),
        'SENTINEL-IMPORT-FILE-92.jsonl',
      )
      expect(plain.status).toBe(422)

      // 10. History: a compaction's backup is listed, and the safety backup restored.
      await compactBoard(server, userId, boardId)
      expect((await request(`/api/boards/${boardId}/backups`)).status).toBe(200)
      const restored = await request(
        `/api/boards/${boardId}/backups/${encodeURIComponent(safetyBackup)}/restore`,
        { method: 'POST', body: '{}' },
      )
      expect(restored.status, await restored.clone().text()).toBe(200)

      // 11. The asset sweep, a month on: the photo no note shows is collected (counts only).
      server.clock.advance(31 * DAY_MS)
      await server.assets.settled()
      const swept = await server.assets.sweep(userId, boardId)
      expect(swept).not.toBeNull()

      // 12. Delete all data, after its typed confirmation.
      const deleted = await request('/api/data/delete', {
        method: 'POST',
        body: JSON.stringify({ confirm: 'delete' }),
      })
      expect(deleted.status, await deleted.clone().text()).toBe(200)
    } finally {
      await server.close()
    }

    const lines = server.logs
    expect(lines.length).toBeGreaterThan(10)
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    for (const [i, line] of lines.entries()) {
      const entry = parsed[i] as Record<string, unknown>
      for (const [k, v] of Object.entries(entry)) {
        expect(ALLOWED_KEYS.has(k), `${k} in ${line}`).toBe(true)
        expect(['string', 'number', 'boolean'], line).toContain(typeof v)
      }
      for (const s of SENTINELS) expect(line.toLowerCase(), line).not.toContain(s.toLowerCase())
      expect(line, line).not.toContain('@')
      expect(line, line).not.toMatch(ID_IN_TEXT)
      expect(line, line).not.toContain(userId)
    }
    // The flow really was logged, by route template.
    const requests = parsed.filter((e) => e.msg === 'request')
    expect(requests).toContainEqual(
      expect.objectContaining({ route: '/api/boards/:id/ops', status: 422 }),
    )
    expect(requests).toContainEqual(
      expect.objectContaining({ route: '/api/boards/:id/ops', status: 413 }),
    )
    expect(requests).toContainEqual(
      expect.objectContaining({ route: '/api/boards/:id/assets', status: 201 }),
    )
    expect(requests).toContainEqual(expect.objectContaining({ route: '(unmatched)', status: 404 }))
    for (const [route, status] of [
      ['/api/boards/:id/export', 200],
      ['/api/boards/:id/import', 200],
      ['/api/boards/:id/import', 422],
      ['/api/boards/:id/import/:importId', 204],
      ['/api/boards/:id/import/:importId/commit', 200],
      ['/api/boards/:id/backups/:backupId/restore', 200],
      ['/api/data/delete', 200],
    ] as const) {
      expect(requests, `${route} ${status}`).toContainEqual(
        expect.objectContaining({ route, status }),
      )
    }
    expect(parsed.map((e) => e.msg)).toContain('board imported')
  })
})

describe('book text in the logs', () => {
  it('book text and titles never appear in logs', async () => {
    const server = await startTestServer()
    const TITLE = 'SENTINEL-BOOK-TITLE-81'
    const TEXT = 'SENTINEL-BOOK-TEXT-82'
    try {
      const user = server.user
      const res = await user.request('/api/boards', {
        method: 'POST',
        body: JSON.stringify({ name: 'B' }),
      })
      const board = ((await res.json()) as { id: string }).id
      const book = bookRecord({ title: TITLE })
      const block = blockRecord(book.id, 'V', `${TEXT} first`)
      const clientId = tabNow(server)
      const post = (seq: number, baseRevision: number, ops: unknown[]) =>
        postOps(user, board, { clientId, seq, baseRevision, ops })
      expect((await post(1, 0, [bookCreate(book), blockCreate(block)])).status).toBe(200)
      // An edit, a stale one (the block changed after its base) and a rejected one (no such block).
      expect((await post(2, 1, [edit(book.id, block.id, [ins(0, `${TEXT} a `)])])).status).toBe(200)
      expect((await post(3, 1, [edit(book.id, block.id, [ins(0, `${TEXT} b `)])])).status).toBe(409)
      const gone = newId('block')
      expect((await post(4, 2, [edit(book.id, gone, [ins(0, `${TEXT} gone `)])])).status).toBe(422)
      // The book read, an export, the board read, a compaction, the purge.
      expect((await user.request(`/api/boards/${board}/books/${book.id}`)).status).toBe(200)
      expect((await user.request(`/api/boards/${board}/export?format=papertie`)).status).toBe(200)
      expect((await user.request(`/api/boards/${board}`)).status).toBe(200)
      await compactBoard(server, user.id, board)
      expect(
        (await post(5, 2, [{ op: 'book.update', id: book.id, set: { trashedAt: T } }])).status,
      ).toBe(200)
      server.clock.advance(31 * DAY_MS)
      const purged = await purgeBooks(server.deps.store as BoardStore, user.id, board, server.clock)
      expect(purged).toMatchObject({ books: 1 })
    } finally {
      await server.close()
    }
    expect(server.logs.length).toBeGreaterThan(5)
    for (const line of server.logs) {
      expect(line, line).not.toContain('SENTINEL-BOOK')
      for (const k of Object.keys(JSON.parse(line) as Record<string, unknown>)) {
        expect(ALLOWED_KEYS.has(k), `${k} in ${line}`).toBe(true)
      }
      expect(line, line).not.toMatch(ID_IN_TEXT)
    }
  })
})

describe('refs in the logs', () => {
  it('a note.update with a ref is never logged: accepted, refused or exported', async () => {
    const server = await startTestServer()
    const ref = 'SENTINEL-REF-71, Walden,\nhttps://sentinel-ref-url-74.example/walden, 1854'
    try {
      const user = server.user
      const res = await user.request('/api/boards', {
        method: 'POST',
        body: JSON.stringify({ name: 'B' }),
      })
      const board = ((await res.json()) as { id: string }).id
      const at = server.clock.now().toISOString()
      const card = newId('note')
      const a = tabNow(server)
      const post = (seq: number, baseRevision: number, ops: unknown[]) =>
        postOps(user, board, { clientId: a, seq, baseRevision, ops })
      expect((await post(1, 0, [noteCreate({ id: card, at })])).status).toBe(200)
      // Accepted: a ref.
      const ok = await post(2, 1, [{ op: 'note.update', id: card, set: { ref } }])
      expect(ok.status, await ok.clone().text()).toBe(200)
      // Refused: a ref too long, and a ref on a note that does not exist.
      const long = await post(3, 2, [
        { op: 'note.update', id: card, set: { ref: `SENTINEL-REF-75 ${'x'.repeat(2_000)}` } },
      ])
      expect(long.status).toBeGreaterThanOrEqual(400)
      const missing = await post(3, 2, [{ op: 'note.update', id: newId('note'), set: { ref } }])
      expect(missing.status).toBeGreaterThanOrEqual(400)
      // Read back, exported, compacted, removed (`ref: null`).
      expect((await user.request(`/api/boards/${board}`)).status).toBe(200)
      expect((await user.request(`/api/boards/${board}/export?format=papertie`)).status).toBe(200)
      await compactBoard(server, user.id, board)
      const cleared = await post(3, 2, [{ op: 'note.update', id: card, set: { ref: null } }])
      expect(cleared.status, await cleared.clone().text()).toBe(200)
    } finally {
      await server.close()
    }
    expect(server.logs.length).toBeGreaterThan(5)
    for (const line of server.logs) {
      expect(line.toLowerCase(), line).not.toContain('sentinel-ref')
      expect(line, line).not.toContain('1854')
      for (const k of Object.keys(JSON.parse(line) as Record<string, unknown>)) {
        expect(ALLOWED_KEYS.has(k), `${k} in ${line}`).toBe(true)
      }
      expect(line, line).not.toMatch(ID_IN_TEXT)
    }
  })
})
