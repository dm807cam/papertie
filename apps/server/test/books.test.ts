import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Asset,
  batchDigest,
  computeEof,
  newId,
  type Op,
  parseBoard,
  posBetween,
  posKeysBetween,
  primeOpSchemas,
  type Yarn,
} from '@papertie/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { serverId } from '../src/ids'
import { BOOK_TRASH_MS } from '../src/limits'
import { createLogger } from '../src/log'
import { listBackups } from '../src/store/backups'
import {
  type BoardEvent,
  BoardStore,
  type BoardStoreOptions,
  type CommitEvent,
} from '../src/store/boardStore'
import { purgeBooks } from '../src/store/bookPurge'
import { StoreError } from '../src/store/errors'
import { noFaults } from '../src/store/faults'
import { parseJournal } from '../src/store/journal'
import { compactBoard, createBoard, noteCreate, postOps, tabNow } from './helpers/boards'
import {
  blockCreate,
  blockRecord,
  bookCreate,
  bookRecord,
  bookText,
  edit,
  ins,
  split,
} from './helpers/books'
import type { TestUser } from './helpers/client'
import { FakeClock } from './helpers/clock'
import { startTestServer, type TestServer } from './helpers/harness'

const NOW = '2026-10-27T10:00:00.000Z'

let dataDir: string
let clock: FakeClock
let logs: string[]
let store: BoardStore
let user: string

function makeStore(over: Partial<BoardStoreOptions> = {}): BoardStore {
  return new BoardStore({
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
    ...over,
  })
}

// As the app does when it opens (`openApp`).
beforeAll(() => {
  primeOpSchemas()
})

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'papertie-books-'))
  clock = new FakeClock(NOW)
  logs = []
  user = serverId('user')
  store = makeStore()
})
afterEach(async () => {
  await store.close()
  await rm(dataDir, { recursive: true, force: true })
})

const tab = () => newId('tab', clock.now().getTime())
const dirOf = (boardId: string) => join(dataDir, 'users', user, 'boards', boardId)

/** A board with one book of the given paragraphs; the book, its block ids and the revision. */
async function withBook(paragraphs: string[]) {
  const boardId = (await store.createBoard(user, 'Board')).id
  const book = bookRecord()
  const keys = posKeysBetween(null, null, paragraphs.length)
  const blocks = paragraphs.map((t, i) => blockRecord(book.id, keys[i] as string, t))
  const ack = await store.submit(user, boardId, {
    clientId: tab(),
    seq: 1,
    baseRevision: 0,
    ops: [bookCreate(book), ...blocks.map(blockCreate)],
  })
  return { boardId, book, ids: blocks.map((b) => b.id), keys, revision: ack.revision }
}

async function stateOf(boardId: string) {
  return (await store.peek(user, boardId)).state
}

/** The page: its client id and next seq. */
function client() {
  const clientId = tab()
  let seq = 0
  return (boardId: string, baseRevision: number, ops: Op[]) =>
    store.submit(user, boardId, { clientId, seq: ++seq, baseRevision, ops })
}

const rejection = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(StoreError)
  return e as StoreError
}

/** A photo's record, as an upload commits it (`asset.add`, the store's own commit). */
function assetRecord(): Asset {
  return {
    type: 'asset',
    id: newId('asset', clock.now().getTime()),
    mime: 'image/webp',
    width: 1,
    height: 1,
    bytes: 1,
    sha256: '0'.repeat(64),
    createdAt: clock.now().toISOString(),
  }
}

/** The store commits on its own (here an upload's record): the head moves past the page's base. */
const storeCommit = (boardId: string) =>
  store.submitServer(user, boardId, [{ op: 'asset.add', asset: assetRecord() }])

async function readJournalText(boardId: string): Promise<string> {
  return readFile(join(dirOf(boardId), 'journal.jsonl'), 'utf8')
}

describe('a block batch behind the head', () => {
  it('commits as posted when no block it names changed after its base', async () => {
    const { boardId, book, ids, keys, revision } = await withBook(['one two', 'three'])
    const page = client()
    const events: BoardEvent[] = []
    await store.subscribe(user, boardId, (e) => events.push(e))
    const upload = await storeCommit(boardId)
    expect(upload.revision).toBe(revision + 1)
    const posted = [
      edit(book.id, ids[0] as string, [ins(7, '!')]),
      split(book.id, ids[1] as string, 2, posBetween(keys[1] as string, null)),
    ]
    const ack = await page(boardId, revision, posted)
    expect(ack.revision).toBe(revision + 2)
    expect(ack.ops).toBeUndefined()
    expect(bookText(await stateOf(boardId), book.id)).toEqual(['one two!', 'th', 'ree'])
    // The commit is the batch itself, in the feed and in the journal.
    const commit = events.flatMap((e) => (e.type === 'commit' ? [e.commit] : [])).at(-1)
    expect(commit?.ops).toEqual(posted)
    expect(commit?.sent).toBeUndefined()
    const journal = parseJournal(Buffer.from(await readJournalText(boardId)))
    const line = journal.entries.flatMap((e) => (e.kind === 'commit' ? [e] : [])).at(-1)
    expect(line).toMatchObject({ rev: ack.revision, ops: posted })
    expect(line?.sent).toBeUndefined()
  })

  it('commits when another block, a note or the book’s shelf entry changed after its base', async () => {
    const { boardId, book, ids, revision } = await withBook(['x', 'y'])
    const page = client()
    await page(boardId, revision, [
      edit(book.id, ids[0] as string, [ins(1, '1')]),
      noteCreate({ text: 'a card', at: NOW }) as Op,
      { op: 'book.update', id: book.id, set: { title: 'Renamed' } },
    ])
    const ack = await page(boardId, revision, [edit(book.id, ids[1] as string, [ins(1, '2')])])
    expect(ack.ops).toBeUndefined()
    expect(bookText(await stateOf(boardId), book.id)).toEqual(['x1', 'y2'])
  })

  it('is block-stale, naming the block, when a block it names changed after its base; nothing of it is applied', async () => {
    const { boardId, book, ids, revision } = await withBook(['x', 'y'])
    const page = client()
    const r1 = await page(boardId, revision, [edit(book.id, ids[0] as string, [ins(0, 'a')])])
    const before = await stateOf(boardId)
    const batch = [
      edit(book.id, ids[1] as string, [ins(1, ' kept?')]),
      edit(book.id, ids[0] as string, [ins(0, 'b')]),
    ]
    const e = await rejection(page(boardId, revision, batch))
    expect(e.code).toBe('block-stale')
    expect(e.blockId).toBe(ids[0])
    const after = await stateOf(boardId)
    expect(after.board.revision).toBe(r1.revision)
    expect(after.blocks).toBe(before.blocks)
    // Made on the block as it is now, the same batch commits.
    await page(boardId, r1.revision, batch)
    expect(bookText(await stateOf(boardId), book.id)).toEqual(['bax', 'y kept?'])
  })

  it('every op that names a changed block is block-stale: a delete, a split, a merge, a move, a create after it', async () => {
    const { boardId, book, ids, keys, revision } = await withBook(['abc', 'def'])
    const [first, second] = ids as [string, string]
    const page = client()
    const r1 = await page(boardId, revision, [edit(book.id, first, [ins(3, '!')])])
    const mid = posBetween(keys[0] as string, keys[1] as string)
    const stale: Op[] = [
      { op: 'block.delete', bookId: book.id, id: first },
      split(book.id, first, 1, mid),
      { op: 'block.merge', bookId: book.id, from: second, into: first, at: 3 },
      { op: 'block.set', bookId: book.id, id: first, set: { kind: 'h1' } },
      { op: 'block.create', block: blockRecord(book.id, mid, 'new'), after: first },
    ]
    for (const op of stale) {
      const e = await rejection(page(boardId, revision, [op]))
      expect(e.code, op.op).toBe('block-stale')
      expect(e.blockId, op.op).toBe(first)
    }
    expect((await stateOf(boardId)).board.revision).toBe(r1.revision)
  })

  it('a block the batch itself makes is never stale: a paragraph created and split in one batch', async () => {
    const { boardId, book, keys, revision } = await withBook(['abc'])
    const page = client()
    await storeCommit(boardId)
    const made = blockRecord(book.id, posBetween(keys[0] as string, null), 'new text')
    const cut = split(book.id, made.id, 3, posBetween(made.pos, null))
    await page(boardId, revision, [blockCreate(made), cut, edit(book.id, cut.newId, [ins(5, '!')])])
    expect(bookText(await stateOf(boardId), book.id)).toEqual(['abc', 'new', ' text!'])
  })

  it('the block’s change is known after the app opens again, compacted or not', async () => {
    for (const compact of [false, true]) {
      const { boardId, book, ids, revision } = await withBook(['x', 'y'])
      const r1 = await client()(boardId, revision, [edit(book.id, ids[0] as string, [ins(1, '1')])])
      if (compact) await store.compact(user, boardId)
      await store.close()
      store = makeStore()
      const page = client()
      const e = await rejection(
        page(boardId, revision, [edit(book.id, ids[0] as string, [ins(0, 'z')])]),
      )
      expect(e.code).toBe('block-stale')
      expect(e.blockId).toBe(ids[0])
      const ok = await page(boardId, revision, [edit(book.id, ids[1] as string, [ins(0, 'z')])])
      expect(ok.revision).toBe(r1.revision + 1)
    }
  })

  it('an edit of a block deleted after its base is rejected whole (not-found), and nothing is re-created', async () => {
    const { boardId, book, ids, revision } = await withBook(['a', 'b'])
    const page = client()
    await page(boardId, revision, [{ op: 'block.delete', bookId: book.id, id: ids[0] as string }])
    const e = await rejection(
      page(boardId, revision, [
        edit(book.id, ids[1] as string, [ins(1, '!')]),
        edit(book.id, ids[0] as string, [ins(1, 'x')]),
      ]),
    )
    expect(e.code).toBe('rejected')
    expect(e.opError?.code).toBe('not-found')
    expect(bookText(await stateOf(boardId), book.id)).toEqual(['b'])
  })
})

describe('deleted books', () => {
  it('a book’s deletion is dated by the store’s clock, never the page’s', async () => {
    const { boardId, book, revision } = await withBook(['a'])
    const page = client()
    const events: BoardEvent[] = []
    await store.subscribe(user, boardId, (e) => events.push(e))
    clock.advance(3_600_000)
    const posted: Op[] = [
      { op: 'book.update', id: book.id, set: { trashedAt: '2001-01-01T00:00:00.000Z' } },
    ]
    const ack = await page(boardId, revision, posted)
    const now = clock.now().toISOString()
    expect((await stateOf(boardId)).books.get(book.id)?.trashedAt).toBe(now)
    // The ack carries the ops as committed; the commit says which batch it was (`sent`).
    expect(ack.ops).toEqual([{ op: 'book.update', id: book.id, set: { trashedAt: now } }])
    const commit = events.flatMap((e) => (e.type === 'commit' ? [e.commit] : [])).at(-1)
    expect(commit?.ops).toEqual(ack.ops)
    expect(commit?.sent).toBe(batchDigest([posted]))
    const journal = parseJournal(Buffer.from(await readJournalText(boardId)))
    const line = journal.entries.flatMap((e) => (e.kind === 'commit' ? [e] : [])).at(-1)
    expect(line?.sent).toBe(batchDigest([posted]))
    // Putting it back is the page's null, kept as is.
    const back = await page(boardId, ack.revision, [
      { op: 'book.update', id: book.id, set: { trashedAt: null } },
    ])
    expect(back.ops).toBeUndefined()
  })

  it('edits to a deleted book are kept', async () => {
    const { boardId, book, ids, revision } = await withBook(['typing'])
    const page = client()
    await page(boardId, revision, [{ op: 'book.update', id: book.id, set: { trashedAt: NOW } }])
    // Typed before the deletion was confirmed: behind the head, its block unchanged.
    await page(boardId, revision, [edit(book.id, ids[0] as string, [ins(6, ' on')])])
    const s = await stateOf(boardId)
    expect(s.books.get(book.id)?.trashedAt).not.toBeNull()
    expect(s.blocks.get(ids[0] as string)?.text).toBe('typing on')
    // And on disk, when the app opens again.
    await store.close()
    store = makeStore()
    expect((await stateOf(boardId)).blocks.get(ids[0] as string)?.text).toBe('typing on')
  })
})

describe('the purge of deleted books', () => {
  it('the purge commits at most 500 blocks per commit, with a pause between, then the book', async () => {
    const n = 2_300
    const { boardId, book, ids, revision } = await withBook(
      Array.from({ length: n }, (_, i) => `paragraph ${i}`),
    )
    await client()(boardId, revision, [{ op: 'book.update', id: book.id, set: { trashedAt: NOW } }])
    const commits: CommitEvent[] = []
    let iteration = 0
    const ticks: number[] = []
    const tick = setInterval(() => iteration++, 0)
    await store.subscribe(user, boardId, (e) => {
      if (e.type === 'commit') {
        commits.push(e.commit)
        ticks.push(iteration)
      }
    })
    try {
      // Not due yet: nothing happens.
      clock.advance(BOOK_TRASH_MS - 1)
      expect(await purgeBooks(store, user, boardId, clock)).toEqual({
        deferred: false,
        books: 0,
        blocks: 0,
      })
      clock.advance(2)
      // Its iterations on a Raspberry Pi are a timing row's (`books.timing.test.ts`).
      expect(await purgeBooks(store, user, boardId, clock)).toEqual({
        deferred: false,
        books: 1,
        blocks: n,
      })
    } finally {
      clearInterval(tick)
    }
    const sizes = commits.map((c) =>
      c.ops.map((op) => (op.op === 'block.purge' ? op.ids.length : op.op)).join(','),
    )
    expect(sizes).toEqual(['500', '500', '500', '500', 'book.purge'])
    // Each commit in an iteration of its own.
    expect(new Set(ticks).size).toBe(ticks.length)
    const s = await stateOf(boardId)
    expect(s.books.has(book.id)).toBe(false)
    expect([...s.blocks.values()].some((b) => b.bookId === book.id)).toBe(false)
    expect(ids.length).toBe(n)
  })

  it('an edit after the purge is rejected whole', async () => {
    const { boardId, book, ids, revision } = await withBook(['kept?', 'other'])
    const page = client()
    await page(boardId, revision, [{ op: 'book.update', id: book.id, set: { trashedAt: NOW } }])
    clock.advance(BOOK_TRASH_MS + 1)
    expect(await purgeBooks(store, user, boardId, clock)).toMatchObject({ books: 1 })
    const before = await stateOf(boardId)
    const e = await rejection(
      page(boardId, revision, [
        edit(book.id, ids[0] as string, [ins(5, ' yes')]),
        edit(book.id, ids[1] as string, [ins(0, '>')]),
      ]),
    )
    expect(e.code).toBe('rejected')
    expect(e.opError?.code).toBe('not-found')
    expect((await stateOf(boardId)).board.revision).toBe(before.board.revision)
  })

  it('a book put back while the purge runs is refused whole: never a book missing its purged paragraphs', async () => {
    const { boardId, book, revision } = await withBook(
      Array.from({ length: 1_200 }, (_, i) => `p${i}`),
    )
    const a = client()
    const r = await a(boardId, revision, [
      { op: 'book.update', id: book.id, set: { trashedAt: NOW } },
    ])
    clock.advance(BOOK_TRASH_MS + 1)
    // The first purge commit is queued; the put back lands right after it.
    let putBack: Promise<unknown> | null = null
    await store.subscribe(user, boardId, (e) => {
      if (e.type === 'commit' && e.commit.ops[0]?.op === 'block.purge' && !putBack) {
        // (Its refusal held until it is looked at, below.)
        const sent = a(boardId, r.revision, [
          { op: 'book.update', id: book.id, set: { trashedAt: null } },
        ])
        sent.catch(() => {})
        putBack = sent
      }
    })
    const res = await purgeBooks(store, user, boardId, clock)
    const e = await rejection(putBack as unknown as Promise<unknown>)
    expect(e.code).toBe('rejected')
    expect(e.opError?.code).toBe('conflict')
    // The purge went on to the end: the book is gone whole, none of it put back.
    expect(res).toMatchObject({ books: 1, blocks: 1_200 })
    const s = await stateOf(boardId)
    expect(s.books.has(book.id)).toBe(false)
    expect([...s.blocks.values()].some((b) => b.bookId === book.id)).toBe(false)
  })

  it('the purge never loads a board', async () => {
    const { boardId } = await withBook(['a'])
    await store.close()
    store = makeStore()
    expect(await purgeBooks(store, user, boardId, clock)).toEqual({ deferred: true })
    expect(store.isCached(user, boardId)).toBe(false)
  })
})

describe('the book route and whole-board reads (HTTP)', () => {
  let server: TestServer
  let owner: TestUser
  beforeEach(async () => {
    server = await startTestServer({ clock: new FakeClock(NOW) })
    owner = server.user
  })
  afterEach(async () => {
    await server.close()
  })

  /** A board with one book of `n` paragraphs, through the API. */
  async function bookOnBoard(n: number) {
    const board = await createBoard(owner)
    const book = bookRecord()
    const keys = posKeysBetween(null, null, n)
    const blocks = keys.map((k, i) => blockRecord(book.id, k, `paragraph ${i} ễ é`))
    const res = await postOps(owner, board, {
      clientId: tabNow(server),
      seq: 1,
      baseRevision: 0,
      ops: [bookCreate(book), ...blocks.map(blockCreate)],
    })
    expect(res.status, await res.clone().text()).toBe(200)
    return { board, book, blocks }
  }

  it('GET /:id serves no block lines and its eof checks out', async () => {
    const { board, book } = await bookOnBoard(3)
    for (const compact of [false, true]) {
      if (compact) await compactBoard(server, owner.id, board)
      const res = await owner.request(`/api/boards/${board}`)
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(text, 'utf8'))
      const lines = text.trimEnd().split('\n')
      const types = lines.map((l) => (JSON.parse(l) as { type: string }).type)
      expect(types).toEqual(['board', 'book', 'eof'])
      // The eof is over exactly the lines served.
      const eof = JSON.parse(lines.at(-1) as string)
      expect(eof).toEqual(computeEof(lines.slice(0, -1), 1))
      // The client's whole-board read: the book, none of its blocks held.
      const parsed = parseBoard(text, { blocksHeld: 'none' })
      expect(parsed.integrity).toBe('ok')
      expect(parsed.state?.books.has(book.id)).toBe(true)
      expect(parsed.state?.blocks.size).toBe(0)
    }
    // The file itself, as exported, holds the blocks.
    const exported = await owner.request(`/api/boards/${board}/export?format=jsonl`)
    const file = await exported.text()
    expect(file.split('\n').filter((l) => l.includes('"type":"block"'))).toHaveLength(3)
    expect(parseBoard(file).integrity).toBe('ok')
  })

  it('the book stream is read at one revision and names it', async () => {
    const { board, book, blocks } = await bookOnBoard(300)
    const res = await owner.request(`/api/boards/${board}/books/${book.id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('papertie-revision')).toBe('1')
    const text = await res.text()
    expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(text, 'utf8'))
    const lines = text.trimEnd().split('\n')
    const records = lines.map((l) => JSON.parse(l) as { type: string; id?: string })
    expect(records[0]).toMatchObject({ type: 'book', id: book.id })
    // In `(pos, id)` order, then an eof over the lines before it.
    expect(records.slice(1, -1).map((r) => r.id)).toEqual(blocks.map((b) => b.id))
    expect(records.at(-1)).toEqual(computeEof(lines.slice(0, -1), 1))

    // Read from one state: a commit landing while it is built does not show in it.
    const store = server.deps.store as BoardStore
    const reading = store.book(owner.id, board, book.id)
    const ack = await postOps(owner, board, {
      clientId: tabNow(server),
      seq: 2,
      baseRevision: 1,
      ops: [edit(book.id, blocks[0]?.id as string, [ins(0, 'NEW ')])],
    })
    expect(ack.status).toBe(200)
    const read = await reading
    expect(read.revision).toBe(1)
    const body = Buffer.concat(read.jsonl.parts).toString('utf8')
    expect(body).not.toContain('NEW ')
    expect((await store.book(owner.id, board, book.id)).revision).toBe(2)
    // A book the board does not have is 404.
    const missing = await owner.request(`/api/boards/${board}/books/${newId('book')}`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not-found' })
  })

  it('a batch whose block changed after its base is 409 block-stale naming the block; a gone block is the rejected path', async () => {
    const { board, book, blocks } = await bookOnBoard(2)
    const id = blocks[0]?.id as string
    const clientId = tabNow(server)
    const post = (seq: number, baseRevision: number, ops: Op[]) =>
      postOps(owner, board, { clientId, seq, baseRevision, ops })
    const first = await post(1, 1, [edit(book.id, id, [ins(0, 'a')])])
    const head = ((await first.json()) as { revision: number }).revision
    const stale = await post(2, 1, [edit(book.id, id, [ins(0, 'b')])])
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'block-stale', blockId: id })
    const gone = await post(3, head, [edit(book.id, newId('block'), [ins(0, 'b')])])
    expect(gone.status).toBe(422)
    expect(await gone.json()).toMatchObject({ error: 'rejected', code: 'not-found' })
    const read = await owner.request(`/api/boards/${board}/books/${book.id}`)
    expect(read.headers.get('papertie-revision')).toBe(String(head))
  })

  it('an edit whose `takes` says more or fewer splices than it has is refused whole', async () => {
    const { board, book, blocks } = await bookOnBoard(1)
    const id = blocks[0]?.id as string
    const clientId = tabNow(server)
    let seq = 0
    for (const takes of [[[], []], []]) {
      const res = await postOps(owner, board, {
        clientId,
        seq: ++seq,
        baseRevision: 1,
        ops: [{ ...edit(book.id, id, [ins(1, 'QQZ')]), takes } as Op],
      })
      expect(res.status, `${takes.length} takes`).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid' })
    }
    const read = await owner.request(`/api/boards/${board}/books/${book.id}`)
    expect(await read.text()).not.toContain('QQZ')
  })
})

describe('a batch from before a restore', () => {
  /** A board whose one paragraph changed after its backup; the backup, and the head's revision. */
  async function changedSinceBackup() {
    const { boardId, book, ids, revision } = await withBook(['as backed up'])
    await store.compact(user, boardId)
    const backup = (await listBackups(dirOf(boardId)))[0]
    if (!backup) throw new Error('no backup')
    const page = client()
    const later = await page(boardId, revision, [
      edit(book.id, ids[0] as string, [ins(12, ' and changed later')]),
    ])
    return { boardId, book, id: ids[0] as string, backup, page, head: later.revision }
  }

  it('a block edit made before a restore is block-stale, never applied over the restored text', async () => {
    const { boardId, book, id, backup, page, head } = await changedSinceBackup()
    await store.restoreBackup(user, boardId, backup.file)
    // Typed at the end of the text as it was before the restore.
    const e = await rejection(page(boardId, head, [edit(book.id, id, [ins(30, '!')])]))
    expect(e.code).toBe('block-stale')
    expect(e.blockId).toBe(id)
    expect((await stateOf(boardId)).blocks.get(id)?.text).toBe('as backed up')
  })

  it('it is block-stale still when the store loads the restored board again', async () => {
    const { boardId, book, id, backup, page, head } = await changedSinceBackup()
    await store.restoreBackup(user, boardId, backup.file)
    await store.close()
    store = makeStore()
    const e = await rejection(page(boardId, head, [edit(book.id, id, [ins(30, '!')])]))
    expect(e.code).toBe('block-stale')
    expect((await stateOf(boardId)).blocks.get(id)?.text).toBe('as backed up')
  })

  it('a batch of that board with no block op, and a block edit made on the restored board, commit', async () => {
    const { boardId, book, id, backup, page, head } = await changedSinceBackup()
    const restored = await store.restoreBackup(user, boardId, backup.file)
    await page(boardId, head, [noteCreate({ text: 'a card', at: NOW }) as Op])
    await page(boardId, restored.revision, [edit(book.id, id, [ins(12, '!')])])
    expect((await stateOf(boardId)).blocks.get(id)?.text).toBe('as backed up!')
  })
})

describe('a move never drops a newer change of the card', () => {
  /** A book of one paragraph and two cards, all committed; the cards, and the revision after. */
  async function withCard() {
    const { boardId, book, keys, revision } = await withBook(['before'])
    const card = newId('note')
    const other = newId('note')
    const ack = await store.submit(user, boardId, {
      clientId: tab(),
      seq: 1,
      baseRevision: revision,
      ops: [
        noteCreate({ id: card, text: 'as moved', at: NOW }) as Op,
        noteCreate({ id: other, text: 'another card', at: NOW }) as Op,
      ],
    })
    /** The move of `card` into the book: its text as a block after the first, the card deleted. */
    const move: Op[] = [
      blockCreate(blockRecord(book.id, posBetween(keys[0] as string, null), 'as moved')),
      { op: 'note.delete', id: card },
    ]
    return { boardId, book, card, other, move, revision: ack.revision }
  }

  it('a move made before the card was rewritten is refused whole (conflict); the card keeps the rewrite', async () => {
    const { boardId, book, card, move, revision } = await withCard()
    const page = client()
    const r1 = await page(boardId, revision, [
      { op: 'note.update', id: card, set: { text: 'rewritten' } },
    ])
    const e = await rejection(page(boardId, revision, move))
    expect(e.code).toBe('rejected')
    expect(e.opError?.code).toBe('conflict')
    const s = await stateOf(boardId)
    expect(s.board.revision).toBe(r1.revision)
    expect(s.notes.get(card)?.text).toBe('rewritten')
    expect(bookText(s, book.id)).toEqual(['before'])
  })

  it('the card’s change is known after the app opens again', async () => {
    const { boardId, card, move, revision } = await withCard()
    await client()(boardId, revision, [{ op: 'note.update', id: card, set: { x: 40, y: 40 } }])
    await store.compact(user, boardId)
    await store.close()
    store = makeStore()
    const e = await rejection(client()(boardId, revision, move))
    expect(e.opError?.code).toBe('conflict')
    expect((await stateOf(boardId)).notes.has(card)).toBe(true)
  })

  it('a move made before a thread was tied to the card, or before its thread changed, is refused whole (conflict)', async () => {
    const { boardId, book, card, other, move, revision } = await withCard()
    const page = client()
    const yarn: Yarn = {
      type: 'yarn',
      id: newId('yarn'),
      noteIds: [card, other],
      color: 'apricot',
      label: '',
      createdAt: NOW,
      updatedAt: NOW,
    }
    const tied = await page(boardId, revision, [{ op: 'yarn.create', yarn }])
    const made = await rejection(page(boardId, revision, move))
    expect(made.opError?.code).toBe('conflict')
    const relabelled = await page(boardId, tied.revision, [
      { op: 'yarn.update', id: yarn.id, set: { label: 'named' } },
    ])
    const changed = await rejection(page(boardId, tied.revision, move))
    expect(changed.opError?.code).toBe('conflict')
    const s = await stateOf(boardId)
    expect(s.board.revision).toBe(relabelled.revision)
    expect(s.notes.has(card)).toBe(true)
    expect(s.yarns.get(yarn.id)?.noteIds).toEqual([card, other])
    expect(bookText(s, book.id)).toEqual(['before'])
  })

  it('a move behind the head commits when neither the card nor a thread on it changed after its base', async () => {
    const { boardId, book, card, other, move, revision } = await withCard()
    const page = client()
    // The store's own commit and a change of another card: the head is two past the move's base.
    await storeCommit(boardId)
    await page(boardId, revision, [{ op: 'note.update', id: other, set: { text: 'rewritten' } }])
    await page(boardId, revision, move)
    const s = await stateOf(boardId)
    expect(s.notes.has(card)).toBe(false)
    expect(bookText(s, book.id)).toEqual(['before', 'as moved'])
  })

  it('a plain delete made before the card was rewritten still commits (History keeps the card)', async () => {
    const { boardId, card, revision } = await withCard()
    const page = client()
    await page(boardId, revision, [{ op: 'note.update', id: card, set: { text: 'rewritten' } }])
    await page(boardId, revision, [{ op: 'note.delete', id: card }])
    expect((await stateOf(boardId)).notes.has(card)).toBe(false)
  })
})
