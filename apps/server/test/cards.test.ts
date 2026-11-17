import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Asset,
  type Block,
  batchDigest,
  cardMarkT,
  newId,
  type Op,
  posKeysBetween,
  primeOpSchemas,
  serializeBoard,
  stateFromRecords,
} from '@papertie/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { serverId } from '../src/ids'
import { createLogger } from '../src/log'
import { listBackups } from '../src/store/backups'
import { type BoardEvent, BoardStore, type BoardStoreOptions } from '../src/store/boardStore'
import { noFaults } from '../src/store/faults'
import { readBoardLines } from '../src/store/importLines'
import { blockCreate, blockRecord, bookCreate, bookRecord, edit, ins } from './helpers/books'
import { FakeClock } from './helpers/clock'

const NOW = '2026-11-13T10:00:00.000Z'
const HOUR = 3_600_000

let dataDir: string
let clock: FakeClock
let logs: string[]
let store: BoardStore
let user: string

const options = (): BoardStoreOptions => ({
  dataDir,
  clock,
  log: createLogger((l) => logs.push(l)),
  faults: noFaults,
  cacheSize: 32,
  idleEvictMs: 600_000,
  ringCommits: 512,
  ringBytes: 16_777_216,
  maxBoardsPerUser: 50,
  compactEveryHour: false,
})

beforeAll(() => {
  primeOpSchemas()
})
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'papertie-cards-'))
  clock = new FakeClock(NOW)
  logs = []
  user = serverId('user')
  store = new BoardStore(options())
})
afterEach(async () => {
  await store.close()
  await rm(dataDir, { recursive: true, force: true })
})

const tab = () => newId('tab', clock.now().getTime())
const dirOf = (boardId: string) => join(dataDir, 'users', user, 'boards', boardId)
const stateOf = async (boardId: string) => (await store.peek(user, boardId)).state

function client() {
  const clientId = tab()
  let seq = 0
  return (boardId: string, baseRevision: number, ops: Op[]) =>
    store.submit(user, boardId, { clientId, seq: ++seq, baseRevision, ops })
}

const NOTE_A = newId('note')
const NOTE_B = newId('note')
const A = cardMarkT(NOTE_A)

/** A board with one book of a plain paragraph. */
async function withBook(text = 'The book begins.', title = 'A private title') {
  const boardId = (await store.createBoard(user, 'Board')).id
  const book = bookRecord({ title })
  const [k1, k2] = posKeysBetween(null, null, 2) as [string, string]
  const first = blockRecord(book.id, k1, text)
  const send = client()
  const ack = await send(boardId, 0, [bookCreate(book), blockCreate(first)])
  return { boardId, book, first, k2, send, revision: ack.revision }
}

/** A card's text dropped into `bookId` as a paragraph, pinned to the card. */
const dropped = (bookId: string, pos: string, noteId: string, text = 'A card’s words'): Block =>
  blockRecord(bookId, pos, text, { marks: [{ t: cardMarkT(noteId), from: 0, to: text.length }] })

describe('card stamps', () => {
  it('a drop’s commit stamps the book’s cards in the same revision, and the ack carries the ops', async () => {
    const { boardId, book, k2, send, revision } = await withBook()
    const events: BoardEvent[] = []
    await store.subscribe(user, boardId, (e) => events.push(e))
    const block = dropped(book.id, k2, NOTE_A)
    const posted = [blockCreate(block)]
    const ack = await send(boardId, revision, posted)
    const stamp: Op = { op: 'book.cards', id: book.id, add: [NOTE_A] }
    expect(ack.revision).toBe(revision + 1)
    expect(ack.ops).toEqual([...posted, stamp])
    const s = await stateOf(boardId)
    expect(s.books.get(book.id)).toMatchObject({ cards: [NOTE_A], rev: ack.revision })
    // The commit says what the page sent, so the page knows it by digest.
    const commit = events.flatMap((e) => (e.type === 'commit' ? [e.commit] : []))[0]
    expect(commit).toMatchObject({ revision: ack.revision, ops: [...posted, stamp] })
    expect(commit?.sent).toBe(batchDigest([posted]))
    // The journal line carries the stamp and `sent`.
    const lines = (await readFile(join(dirOf(boardId), 'journal.jsonl'), 'utf8')).trim().split('\n')
    const line = JSON.parse(lines.at(-1) as string) as { ops: Op[]; sent?: string; rev: number }
    expect(line).toMatchObject({ rev: ack.revision, ops: [...posted, stamp], sent: commit?.sent })
  })

  it('a keystroke’s commit inside pinned text stamps nothing and writes the journal line as before', async () => {
    const { boardId, book, k2, send, revision } = await withBook()
    const block = dropped(book.id, k2, NOTE_A)
    const r1 = await send(boardId, revision, [blockCreate(block)])
    const cards = (await stateOf(boardId)).books.get(book.id)?.cards
    const posted: Op[] = [
      { op: 'block.edit', bookId: book.id, id: block.id, splices: [ins(3, 'x')], takes: [[A]] },
    ]
    const ack = await send(boardId, r1.revision, posted)
    expect(ack.ops).toBeUndefined()
    // The very same cards array: nothing re-read it.
    expect((await stateOf(boardId)).books.get(book.id)?.cards).toBe(cards)
    // A line without `sent`: the posted ops, no `sent`.
    const lines = (await readFile(join(dirOf(boardId), 'journal.jsonl'), 'utf8')).trim().split('\n')
    const line = JSON.parse(lines.at(-1) as string) as Record<string, unknown>
    expect(Object.keys(line).sort()).toEqual(['crc', 'now', 'ops', 'origin', 'rev'])
    expect(line.ops).toEqual(posted)
  })

  it('deleting the last passage from a card unstamps it; two books using one card both list it', async () => {
    const { boardId, book, first, k2, send, revision } = await withBook()
    const other = bookRecord({ title: 'Another title', shelfPos: 'W' })
    const one = dropped(book.id, k2, NOTE_A)
    const two = dropped(other.id, 'V', NOTE_A)
    const r1 = await send(boardId, revision, [
      blockCreate(one),
      edit(book.id, first.id, [], { addMarks: [{ t: A, from: 0, to: 3 }] }),
      bookCreate(other),
      blockCreate(two),
    ])
    let s = await stateOf(boardId)
    expect(s.books.get(book.id)?.cards).toEqual([NOTE_A])
    expect(s.books.get(other.id)?.cards).toEqual([NOTE_A])
    // One of the book's two passages from the card goes: still used.
    const r2 = await send(boardId, r1.revision, [
      { op: 'block.delete', bookId: book.id, id: one.id },
    ])
    expect(r2.ops).toBeUndefined()
    // The last one's text all deleted: the card is no longer used there, and only there.
    const r3 = await send(boardId, r2.revision, [
      edit(book.id, first.id, [{ at: 0, del: 3, ins: '' }]),
    ])
    expect(r3.ops?.at(-1)).toEqual({ op: 'book.cards', id: book.id, remove: [NOTE_A] })
    s = await stateOf(boardId)
    expect('cards' in (s.books.get(book.id) as object)).toBe(false)
    expect(s.books.get(other.id)?.cards).toEqual([NOTE_A])
  })

  it('the journal replays to the same cards', async () => {
    const { boardId, book, k2, send, revision } = await withBook()
    await send(boardId, revision, [blockCreate(dropped(book.id, k2, NOTE_B))])
    const before = (await stateOf(boardId)).books.get(book.id)
    expect(before?.cards).toEqual([NOTE_B])
    await store.close()
    store = new BoardStore(options())
    expect((await stateOf(boardId)).books.get(book.id)).toEqual(before)
  })

  it('a restored backup brings back the cards of that hour', async () => {
    const { boardId, book, k2, send, revision } = await withBook()
    const r1 = await send(boardId, revision, [blockCreate(dropped(book.id, k2, NOTE_A))])
    await store.compact(user, boardId)
    const hourOld = (await listBackups(dirOf(boardId)))[0]
    if (!hourOld) throw new Error('no backup')
    clock.advance(HOUR)
    const [, , k3] = posKeysBetween(null, null, 3) as [string, string, string]
    await send(boardId, r1.revision, [blockCreate(dropped(book.id, `${k3}z`, NOTE_B))])
    expect((await stateOf(boardId)).books.get(book.id)?.cards).toEqual([NOTE_A, NOTE_B].sort())
    await store.restoreBackup(user, boardId, hourOld.file)
    expect((await stateOf(boardId)).books.get(book.id)?.cards).toEqual([NOTE_A])
  })

  it('book text, titles and card ids never appear in logs', async () => {
    const { boardId, book, k2, send, revision } = await withBook(
      'Secret prose here',
      'Secret title',
    )
    await send(boardId, revision, [blockCreate(dropped(book.id, k2, NOTE_A, 'Secret card words'))])
    await store.compact(user, boardId)
    await store.close()
    store = new BoardStore(options())
    await stateOf(boardId)
    const all = logs.join('\n')
    for (const secret of ['Secret prose', 'Secret title', 'Secret card', NOTE_A]) {
      expect(all).not.toContain(secret)
    }
  })
})

// ── Import ───────────────────────────────────────────────────────────────────────────────────

async function* chunks(text: string) {
  yield Buffer.from(text)
}

const asset = (): Asset => ({
  type: 'asset',
  id: newId('asset'),
  mime: 'image/webp',
  width: 10,
  height: 10,
  bytes: 100,
  sha256: 'a'.repeat(64),
  createdAt: NOW,
})

function fileOf(records: Parameters<typeof stateFromRecords>[1]) {
  const board = {
    type: 'board' as const,
    schemaVersion: 6 as const,
    id: newId('board'),
    name: 'Imported',
    revision: 4,
    clients: {},
    createdAt: NOW,
    updatedAt: NOW,
  }
  return serializeBoard(stateFromRecords(board, records))
}

describe('import of cards', () => {
  it('an import with forged cards gets them recomputed', async () => {
    const book = bookRecord({ cards: [NOTE_B].sort() })
    const bare = bookRecord({ cards: [NOTE_A], shelfPos: 'W' })
    const pic = asset()
    const text = fileOf([
      pic,
      book,
      bare,
      dropped(book.id, 'V', NOTE_A),
      blockRecord(book.id, 'W', '', {
        kind: 'figure',
        image: { assetId: pic.id, card: NOTE_A },
      }),
      blockRecord(bare.id, 'V', 'Nothing pinned'),
    ])
    const read = await readBoardLines(chunks(text))
    const byId = new Map(read.books.map((b) => [b.id, b]))
    expect(byId.get(book.id)?.cards).toEqual([NOTE_A])
    expect('cards' in (byId.get(bare.id) as object)).toBe(false)
  })

  it('an import with a figure of a missing asset keeps it as its caption', async () => {
    const book = bookRecord()
    const pic = asset()
    const lines = fileOf([
      pic,
      book,
      blockRecord(book.id, 'V', 'A caption', {
        kind: 'figure',
        image: { assetId: pic.id, card: NOTE_A },
      }),
    ])
      .trimEnd()
      .split('\n')
    // The asset's line taken out (and the eof made to match): the figure names nothing.
    const body = lines.slice(0, -1).filter((l) => !l.includes('"type":"asset"'))
    const { computeEof } = await import('@papertie/core')
    const text = `${[...body, JSON.stringify(computeEof(body, 4))].join('\n')}\n`
    const read = await readBoardLines(chunks(text))
    // The file is read; `build` (no photo for it) keeps the figure as its caption.
    expect(read.blocks).toHaveLength(1)
    expect(read.books[0]?.cards).toEqual([NOTE_A])
  })
})
