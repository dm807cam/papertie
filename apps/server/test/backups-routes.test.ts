import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Block, newId, parseBoard, posBetween, posKeysBetween } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupName, pruneBackups } from '../src/store/backups'
import { boardDir, compactBoard, createBoard, noteCreate, postOps, tabNow } from './helpers/boards'
import { blockCreate, blockRecord, bookCreate, bookRecord, edit, ins } from './helpers/books'
import type { TestUser } from './helpers/client'
import { FakeClock } from './helpers/clock'
import { startTestServer, type TestServer } from './helpers/harness'
import { type EventStream, openEvents } from './helpers/sse'

const T10 = '2026-10-27T10:00:00.000Z'
const T11 = '2026-10-27T11:00:00.000Z'

interface BackupRow {
  id: string
  revision: number
  takenAt: string
  notes: number
  yarns: number
  books: number
  words: number
  damaged: boolean
  bytes: number
}

let server: TestServer
let user: TestUser
let board: string
let clientId: string
let seq: number
const streams: EventStream[] = []

beforeEach(async () => {
  server = await startTestServer({
    clock: new FakeClock(T10),
    config: {
      // Backups come from the compactions these tests make, so their names are known.
      store: { compactEveryHour: false },
    },
  })
  user = server.user
  board = await createBoard(user)
  clientId = tabNow(server)
  seq = 0
})

afterEach(async () => {
  for (const s of streams.splice(0)) s.close()
  await server.close()
})

const revisionOf = async () => {
  const res = await user.request(`/api/boards/${board}/meta`)
  return ((await res.json()) as { revision: number }).revision
}

/** One commit of `ops` (default: one note) from the test tab; returns the new revision. */
async function commit(ops: unknown[] = [noteCreate({ at: server.clock.now().toISOString() })]) {
  const res = await postOps(user, board, {
    clientId,
    seq: ++seq,
    baseRevision: await revisionOf(),
    ops,
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { revision: number }).revision
}

const backupsDir = () => join(boardDir(server, user.id, board), 'backups')

/** Fold the journal into board.jsonl now (the first compaction of an hour takes a backup). */
const compact = () => compactBoard(server, user.id, board)

/**
 * 10:00: two notes (r1, r2), compacted (the snapshot is the hour's backup, r2). 11:00: a third
 * note and a yarn (r3, r4), compacted (backup r4).
 */
async function history(): Promise<{ latest: string; older: string }> {
  const n1 = newId('note')
  const n2 = newId('note')
  await commit([noteCreate({ id: n1, at: T10 })])
  await commit([noteCreate({ id: n2, at: T10 })])
  await compact()
  server.clock.set(T11)
  await commit()
  await commit([
    {
      op: 'yarn.create',
      yarn: {
        type: 'yarn',
        id: newId('yarn'),
        noteIds: [n1, n2],
        color: 'apricot',
        label: '',
        createdAt: T11,
        updatedAt: T11,
      },
    },
  ])
  await compact()
  return { latest: backupName(new Date(T11), 4), older: backupName(new Date(T10), 2) }
}

/**
 * A damaged copy of backup `of`, as `board.<09:00>.r1.jsonl`: its eof is gone (torn), a torn line
 * is appended, and its second note points at an image asset the file does not have (a dangling
 * reference the parser repairs).
 */
function damagedCopy(of: string): { name: string; text: string; torn: string } {
  const lines = readFileSync(join(backupsDir(), of), 'utf8').trimEnd().split('\n')
  const body = lines.slice(0, -1) // without eof
  const last = JSON.parse(body.at(-1) as string)
  last.image = { assetId: newId('asset'), frame: 'none' }
  body[body.length - 1] = JSON.stringify(last)
  const torn = '{"type":"note","id":"note_'
  const text = `${[...body, torn].join('\n')}\n`
  const name = backupName(new Date('2026-10-27T09:00:00.000Z'), 1)
  writeFileSync(join(backupsDir(), name), text)
  return { name, text, torn }
}

const list = async () => {
  const res = await user.request(`/api/boards/${board}/backups`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { backups: BackupRow[] }).backups
}

const restore = (id: string) =>
  user.request(`/api/boards/${board}/backups/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    body: '{}',
  })

describe('GET /api/boards/:id/backups', () => {
  it('lists backups newest first, with their counts and sizes', async () => {
    const { latest, older } = await history()
    const rows = await list()
    expect(rows.map((r) => r.id)).toEqual([latest, older])
    expect(rows[0]).toEqual({
      id: latest,
      revision: 4,
      takenAt: T11,
      notes: 3,
      yarns: 1,
      books: 0,
      words: 0,
      damaged: false,
      bytes: readFileSync(join(backupsDir(), latest)).byteLength,
    })
    expect(rows[1]).toMatchObject({
      id: older,
      revision: 2,
      takenAt: T10,
      notes: 2,
      yarns: 0,
      damaged: false,
    })
  })

  it('an unreadable backup is listed with -1 counts', async () => {
    await history()
    const bad = backupName(new Date('2026-10-27T09:00:00.000Z'), 0)
    writeFileSync(join(backupsDir(), bad), 'not a board\n')
    const rows = await list()
    expect(rows.at(-1)).toEqual({
      id: bad,
      revision: 0,
      takenAt: '2026-10-27T09:00:00.000Z',
      notes: -1,
      yarns: -1,
      books: -1,
      words: -1,
      damaged: true,
      bytes: 12,
    })
  })

  it.each([5, 7])(
    'a backup of schema version %i is listed with -1 counts and not restored',
    async (v) => {
      const { older } = await history()
      const text = readFileSync(join(backupsDir(), older), 'utf8')
      const name = backupName(new Date('2026-10-27T08:00:00.000Z'), 2)
      writeFileSync(
        join(backupsDir(), name),
        text.replace('"schemaVersion":6', `"schemaVersion":${v}`),
      )
      const row = (await list()).find((r) => r.id === name)
      expect(row).toMatchObject({ notes: -1, yarns: -1, books: -1, words: -1, damaged: true })
      const res = await restore(name)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'board-unreadable', reason: 'unsupported-version' })
      expect(await revisionOf()).toBe(4)
    },
  )

  it('a damaged backup is flagged, with the counts its restore would keep', async () => {
    const { older } = await history()
    const { name } = damagedCopy(older)
    const row = (await list()).find((r) => r.id === name)
    // The torn line starts like a note but is not one: two notes, as the parser keeps them.
    expect(row).toMatchObject({ id: name, notes: 2, yarns: 0, damaged: true })
  })

  it('a backup whose checksum does not match is damaged', async () => {
    const { older } = await history()
    const text = readFileSync(join(backupsDir(), older), 'utf8')
    const name = backupName(new Date('2026-10-27T08:00:00.000Z'), 2)
    writeFileSync(join(backupsDir(), name), text.replace('"hello"', '"hellO"'))
    const row = (await list()).find((r) => r.id === name)
    expect(row).toMatchObject({ notes: 2, yarns: 0, damaged: true })
  })

  it('a board without backups lists none', async () => {
    expect(await list()).toEqual([])
  })
})

describe('POST /api/boards/:id/backups/:backupId/restore', () => {
  it('restores an older backup above the current revision and tells streams to reset', async () => {
    const { older } = await history()
    const before = await revisionOf()
    expect(before).toBe(4)
    const stream = await openEvents(user, board)
    streams.push(stream)
    expect((await stream.next()).event).toBe('hello')

    const res = await restore(older)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { revision: number; safetyBackup: string }
    expect(body.revision).toBeGreaterThan(before)
    expect(body.revision).toBe(5)

    const reset = await stream.next()
    expect(reset).toMatchObject({ event: 'reset', data: { revision: body.revision } })

    // The board now holds the backup's notes and yarns, at the new revision.
    const view = await user.request(`/api/boards/${board}`)
    expect(view.headers.get('x-papertie-revision')).toBe(String(body.revision))
    const now = parseBoard(await view.text()).state
    const then = parseBoard(readFileSync(join(backupsDir(), older), 'utf8')).state
    if (!now || !then) throw new Error('did not parse')
    expect(now.board.revision).toBe(body.revision)
    expect([...now.notes.values()]).toEqual([...then.notes.values()])
    expect([...now.yarns.values()]).toEqual([...then.yarns.values()])
    expect(now.notes.size).toBe(2)

    // The recovery notice says what happened and where the pre-restore board went.
    const meta = (await (await user.request(`/api/boards/${board}/meta`)).json()) as {
      recovery: { integrity: string; latestBackup: { file: string; revision: number } | null }
    }
    expect(meta.recovery.integrity).toBe('restored')
    expect(meta.recovery.latestBackup).toMatchObject({ file: body.safetyBackup, revision: before })
  })

  it('forces a safety backup of the pre-restore board, whatever the hour', async () => {
    const { latest, older } = await history()
    const before = await revisionOf()
    // This hour already has a backup (r4): the hourly rule alone would take none.
    expect(readdirSync(backupsDir())).toContain(latest)

    const res = await restore(older)
    const { safetyBackup } = (await res.json()) as { safetyBackup: string }
    expect(safetyBackup).toBe(backupName(new Date(T11), before))
    const path = join(backupsDir(), safetyBackup)
    expect(existsSync(path)).toBe(true)
    const saved = parseBoard(readFileSync(path, 'utf8')).state
    expect(saved?.board.revision).toBe(before)
    expect(saved?.notes.size).toBe(3)
    expect(saved?.yarns.size).toBe(1)

    // Restoring the safety backup undoes the restore, still moving the revision forward.
    const undo = await restore(safetyBackup)
    expect(undo.status).toBe(200)
    const { revision } = (await undo.json()) as { revision: number }
    expect(revision).toBe(before + 2)
    const back = parseBoard(await (await user.request(`/api/boards/${board}`)).text()).state
    expect(back?.notes.size).toBe(3)
    expect(back?.yarns.size).toBe(1)
  })

  it('keeps the safety backup through retention for 30 days, past later backups of its day', async () => {
    const { older } = await history()
    const res = await restore(older)
    const { safetyBackup } = (await res.json()) as { safetyBackup: string }
    // Later that day the board moves on and its hour's backup is taken; three days later too.
    server.clock.set('2026-10-27T15:00:00.000Z')
    await commit()
    await compact()
    server.clock.set('2026-10-30T12:00:00.000Z')
    await commit()
    await compact()
    await pruneBackups(boardDir(server, user.id, board), server.clock.now())
    expect((await list()).map((b) => b.id)).toContain(safetyBackup)
    expect((await restore(safetyBackup)).status).toBe(200)
  })

  it('the board keeps working after a restore: duplicates stay duplicates, new seqs commit', async () => {
    const { older } = await history()
    const res = await restore(older)
    const { revision } = (await res.json()) as { revision: number }
    // seq 4 was committed before the restore: still recognised.
    const dup = await postOps(user, board, {
      clientId,
      seq,
      baseRevision: revision,
      ops: [noteCreate({ at: T11 })],
    })
    expect(((await dup.json()) as { duplicate: boolean }).duplicate).toBe(true)
    expect(await commit()).toBe(revision + 1)
  })

  it('restoring a damaged backup keeps what the repair dropped, and the notice counts it', async () => {
    const { older } = await history()
    const { name, text, torn } = damagedCopy(older)
    const res = await restore(name)
    expect(res.status).toBe(200)
    const { revision } = (await res.json()) as { revision: number }
    expect(revision).toBe(5)

    // The board is the parser's repair: two notes, the dangling image cleared.
    const now = parseBoard(await (await user.request(`/api/boards/${board}`)).text()).state
    expect(now?.notes.size).toBe(2)
    expect([...(now?.notes.values() ?? [])].every((n) => n.image === null)).toBe(true)

    const meta = (await (await user.request(`/api/boards/${board}/meta`)).json()) as {
      recovery: {
        integrity: string
        preservedAs: string
        quarantinedLines: number
        repairs: number
      }
    }
    expect(meta.recovery).toMatchObject({ integrity: 'restored', quarantinedLines: 1, repairs: 1 })

    // The damaged backup byte for byte, its rejected line with raw text, the repair: all kept.
    const dir = boardDir(server, user.id, board)
    const quarantine = readdirSync(join(dir, 'quarantine'))
    expect(meta.recovery.preservedAs).toMatch(/-backup-missing-eof\.jsonl$/)
    expect(quarantine).toContain(meta.recovery.preservedAs)
    expect(readFileSync(join(dir, 'quarantine', meta.recovery.preservedAs), 'utf8')).toBe(text)
    const linesFile = quarantine.find((f) => f.endsWith('-lines.jsonl')) as string
    const rejected = readFileSync(join(dir, 'quarantine', linesFile), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { raw: string })
    expect(rejected.map((r) => r.raw)).toEqual([torn])
    const repairs = readFileSync(join(dir, 'repairs.jsonl'), 'utf8').trim().split('\n')
    expect(repairs).toHaveLength(1)
  })

  it('restoring a clean backup quarantines nothing', async () => {
    const { older } = await history()
    expect((await restore(older)).status).toBe(200)
    const dir = boardDir(server, user.id, board)
    expect(readdirSync(join(dir, 'quarantine'))).toEqual([])
    expect(existsSync(join(dir, 'repairs.jsonl'))).toBe(false)
  })

  it('discards the board open stages', async () => {
    const { older } = await history()
    const part = (index: number) =>
      postOps(user, board, {
        clientId,
        seq: seq + 1,
        baseRevision: 4,
        ops: [noteCreate({ at: T11 })],
        part: { index, count: 2, digest: 'a'.repeat(32) },
      })
    const first = await part(0)
    expect(first.status).toBe(202)

    expect((await restore(older)).status).toBe(200)

    // Part 0 is gone: the second part starts a new stage instead of completing the old one.
    const second = await part(1)
    expect(second.status).toBe(202)
    expect(await second.json()).toEqual({ staged: true, received: [1], count: 2 })
  })

  it('a backup id that is not a backup name is 404', async () => {
    await history()
    for (const id of [
      '../board.jsonl',
      'board.jsonl',
      'board.x.jsonl',
      '..%2fboard.jsonl',
      `../backups/${backupName(new Date(T11), 2)}`,
      backupName(new Date(T11), 99), // well-formed, but not on disk
    ]) {
      const res = await restore(id)
      expect(res.status, id).toBe(404)
      expect(await res.json()).toEqual({ error: 'not-found' })
    }
    expect(await revisionOf()).toBe(4)
  })
})

describe('the books in a backup (the board and its books are one unit)', () => {
  /**
   * 10:00: a book of two paragraphs and a note, compacted (backup r2). 11:00: the book's text is
   * edited and a paragraph added, compacted (backup r4). The 10:00 backup holds the book as it was.
   */
  async function bookHistory() {
    const book = bookRecord({ createdAt: T10, updatedAt: T10 })
    const keys = posKeysBetween(null, null, 2)
    const a = blockRecord(book.id, keys[0] as string, 'The river at morning.')
    const b = blockRecord(book.id, keys[1] as string, 'A letter, folded twice.')
    await commit([bookCreate(book), blockCreate(a), blockCreate(b)])
    await commit()
    await compact()
    server.clock.set(T11)
    await commit([edit(book.id, a.id, [ins(9, ' Thames')])])
    await commit([blockCreate(blockRecord(book.id, posBetween(keys[1] as string, null), 'Later.'))])
    await compact()
    return { book, older: backupName(new Date(T10), 2), latest: backupName(new Date(T11), 4) }
  }

  const bookNow = async (bookId: string) => {
    const res = await user.request(`/api/boards/${board}/books/${bookId}`)
    expect(res.status).toBe(200)
    // The book's stream: its record, its blocks, an eof.
    const blocks = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Block)
      .filter((r) => r.type === 'block' && r.bookId === bookId)
    return blocks.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0)).map((b) => b.text)
  }

  it('restoring a backup brings the book’s text back exactly as it was then', async () => {
    const { book, older } = await bookHistory()
    expect(await bookNow(book.id)).toEqual([
      'The river Thames at morning.',
      'A letter, folded twice.',
      'Later.',
    ])
    expect((await restore(older)).status).toBe(200)
    expect(await bookNow(book.id)).toEqual(['The river at morning.', 'A letter, folded twice.'])
  })

  it('the listing counts each backup’s books and their words', async () => {
    const { older, latest } = await bookHistory()
    const rows = await list()
    expect(rows.find((r) => r.id === latest)).toMatchObject({ notes: 1, books: 1, words: 10 })
    expect(rows.find((r) => r.id === older)).toMatchObject({ notes: 1, books: 1, words: 8 })
  })

  it('a damaged backup counts the books and words its restore would keep', async () => {
    const { older } = await bookHistory()
    const text = readFileSync(join(backupsDir(), older), 'utf8')
    const name = backupName(new Date('2026-10-27T08:00:00.000Z'), 2)
    writeFileSync(join(backupsDir(), name), text.replace('folded twice', 'folded once'))
    expect((await list()).find((r) => r.id === name)).toMatchObject({
      books: 1,
      words: 8,
      damaged: true,
    })
  })
})
