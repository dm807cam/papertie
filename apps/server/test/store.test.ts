import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { chmod, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId, type Op, parseBoard, serializeBoard } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverId, ulidTimeMs } from '../src/ids'
import { createLogger } from '../src/log'
import { type BoardEvent, BoardStore, type BoardStoreOptions } from '../src/store/boardStore'
import { StoreError } from '../src/store/errors'
import { noFaults } from '../src/store/faults'
import { EventHub } from '../src/store/hub'
import { type CommitEvent, CommitRing } from '../src/store/ring'
import { hugeState, storedBoard } from './helpers/boards'
import { FakeClock } from './helpers/clock'

const NOW = '2026-10-27T10:00:00.000Z'
const DAY_MS = 86_400_000

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
    ...over,
  })
}

/** Replace the store under test (the old one is closed). */
async function useStore(over: Partial<BoardStoreOptions> = {}): Promise<BoardStore> {
  await store.close()
  store = makeStore(over)
  return store
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'papertie-store-'))
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
const dirOf = (boardId: string, u = user) => join(dataDir, 'users', u, 'boards', boardId)
const fileOf = (boardId: string) => join(dirOf(boardId), 'board.jsonl')
/** The board as stored: the snapshot with the journal replayed. */
const stored = (boardId: string) => storedBoard(dirOf(boardId))
const parseFile = (boardId: string) => parseBoard(stored(boardId).toString('utf8'))

function createOp(id = newId('note'), text = 'hello'): Op {
  const at = clock.now().toISOString()
  return {
    op: 'note.create',
    note: {
      type: 'note',
      id,
      x: 0,
      y: 0,
      w: 240,
      h: 160,
      z: 0,
      paper: 'cream',
      style: 'rustic',
      text,
      image: null,
      createdAt: at,
      updatedAt: at,
    },
  }
}

const updateOp = (id: string, set: Record<string, unknown>): Op =>
  ({ op: 'note.update', id, set }) as Op

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError)
    return (e as StoreError).code
  }
  throw new Error('expected a StoreError')
}

async function newBoard(name = 'Board'): Promise<string> {
  return (await store.createBoard(user, name)).id
}

describe('ids', () => {
  it('ulidTimeMs decodes the time newId encoded; serverId mints a valid id', () => {
    const ms = Date.parse(NOW) - 91 * DAY_MS
    expect(ulidTimeMs(newId('tab', ms))).toBe(ms)
    expect(ulidTimeMs(newId('tab', 0))).toBe(0)
    expect(ulidTimeMs('nonsense')).toBeNaN()
    expect(serverId('user')).toMatch(/^user_[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})

describe('CommitRing and EventHub', () => {
  const ev = (revision: number, text = ''): CommitEvent => ({
    revision,
    ops: text ? [createOp(newId('note'), text)] : [],
    originClientId: null,
    seq: null,
    now: NOW,
  })

  it('keeps at most maxCommits and maxBytes, and reports gaps as null', () => {
    const ring = new CommitRing(3, 1_000_000)
    for (let r = 1; r <= 5; r++) ring.push(ev(r))
    expect(ring.since(2, 5)?.map((e) => e.revision)).toEqual([3, 4, 5])
    expect(ring.since(5, 5)).toEqual([])
    expect(ring.since(1, 5)).toBeNull()
    expect(ring.since(6, 5)).toBeNull()
    ring.clear()
    expect(ring.since(4, 5)).toBeNull()

    const small = new CommitRing(100, 2_000)
    for (let r = 1; r <= 3; r++) small.push(ev(r, 'x'.repeat(800)))
    expect(small.since(1, 3)).toBeNull()
    expect(small.since(2, 3)?.map((e) => e.revision)).toEqual([3])
  })

  it('subscribe/unsubscribe and per-user counts', () => {
    const hub = new EventHub()
    const got: BoardEvent[] = []
    const off = hub.subscribe('u1/b1', (e) => got.push(e))
    hub.subscribe('u1/b2', () => {})
    hub.subscribe('u10/b1', () => {})
    expect(hub.count('u1/b1')).toBe(1)
    expect(hub.countUser('u1')).toBe(2)
    hub.publish('u1/b1', { type: 'reset', revision: 3 })
    off()
    off()
    hub.publish('u1/b1', { type: 'closed' })
    expect(got).toEqual([{ type: 'reset', revision: 3 }])
    expect(hub.count('u1/b1')).toBe(0)
  })
})

describe('createBoard', () => {
  it('creates a durable board at revision 0 with the clock time', async () => {
    const b = await store.createBoard(user, 'First')
    expect(b).toMatchObject({ name: 'First', revision: 0, createdAt: NOW, recovered: false })
    const parsed = parseFile(b.id)
    expect(parsed.integrity).toBe('ok')
    expect(parsed.state?.board.revision).toBe(0)
    expect(parsed.state?.board.createdAt).toBe(NOW)
    for (const sub of ['assets', 'backups', 'quarantine']) {
      expect((await stat(join(dirOf(b.id), sub))).mode & 0o777).toBe(0o700)
    }
    expect((await stat(dirOf(b.id))).mode & 0o777).toBe(0o700)
    expect(await store.owns(user, b.id)).toBe(true)
    expect(await store.listBoards(user)).toEqual([b])
  })

  it('carry-forward 3: an unrepresentable clock time throws and creates no dir', async () => {
    clock = new FakeClock(new Date(8.64e15).toISOString())
    await useStore()
    await expect(store.createBoard(user, 'Far future')).rejects.toBeInstanceOf(StoreError)
    const boards = join(dataDir, 'users', user, 'boards')
    expect(await readdir(boards).catch(() => [])).toEqual([])
  })

  it('rejects an empty or 121-char name', async () => {
    await expect(store.createBoard(user, '')).rejects.toBeInstanceOf(StoreError)
    await expect(store.createBoard(user, 'n'.repeat(121))).rejects.toBeInstanceOf(StoreError)
    expect(await store.listBoards(user)).toEqual([])
  })

  it('the 51st board gives board-limit', async () => {
    for (let i = 0; i < 50; i++) await store.createBoard(user, `B${i}`)
    expect(await codeOf(store.createBoard(user, 'one too many'))).toBe('board-limit')
    expect((await store.listBoards(user)).length).toBe(50)
  })

  it('owns is false for malformed ids, other users and missing boards', async () => {
    const id = await newBoard()
    expect(await store.owns(user, 'board_nope')).toBe(false)
    expect(await store.owns('../x', id)).toBe(false)
    expect(await store.owns(serverId('user'), id)).toBe(false)
    expect(await store.owns(user, newId('board'))).toBe(false)
    expect(await codeOf(store.read(user, newId('board')))).toBe('not-found')
    expect(await codeOf(store.read(user, 'board_nope'))).toBe('not-found')
  })
})

describe('submit', () => {
  it('acks only after the journal line is on disk', async () => {
    const id = await newBoard()
    const t = tab()
    const ack = await store.submit(user, id, {
      clientId: t,
      seq: 1,
      baseRevision: 0,
      ops: [createOp()],
    })
    expect(ack).toEqual({ clientId: t, seq: 1, revision: 1, now: NOW, duplicate: false })
    const parsed = parseFile(id)
    expect(parsed.integrity).toBe('ok')
    expect(parsed.state?.board.revision).toBe(1)
    expect(parsed.state?.board.clients[t]).toEqual({ lastSeq: 1, lastRevision: 1, seenAt: NOW })
  })

  it('answers a resubmitted seq as a duplicate without writing', async () => {
    const id = await newBoard()
    const t = tab()
    const batch = { clientId: t, seq: 1, baseRevision: 0, ops: [createOp()] }
    await store.submit(user, id, batch)
    const bytes = stored(id)
    const appends = store.stats.appends
    const again = await store.submit(user, id, batch)
    expect(again).toEqual({ clientId: t, seq: 1, revision: 1, now: null, duplicate: true })
    expect(stored(id).equals(bytes)).toBe(true)
    expect(store.stats.appends).toBe(appends)
  })

  it('group commit: 50 tabs at once get revisions 1..50 in fewer than 50 appends', async () => {
    const id = await newBoard()
    const noteIds = Array.from({ length: 50 }, () => newId('note'))
    const acks = await Promise.all(
      noteIds.map((n) =>
        store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp(n)] }),
      ),
    )
    expect(acks.map((a) => a.revision).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    )
    const state = parseFile(id).state
    expect(state?.board.revision).toBe(50)
    for (const n of noteIds) expect(state?.notes.has(n)).toBe(true)
    expect(store.stats.appends).toBeLessThan(50)
  })

  it('batches submitted in the same turn share one append', async () => {
    const id = await newBoard()
    await store.read(user, id)
    const acks = await Promise.all(
      [1, 2, 3].map(() =>
        store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp()] }),
      ),
    )
    expect(acks.map((a) => a.revision)).toEqual([1, 2, 3])
    expect(store.stats.appends).toBe(1)
  })

  it('Review Focus 1: two clients edit one note from the same revision; no field is lost', async () => {
    const id = await newBoard()
    const n = newId('note')
    const setup = tab()
    await store.submit(user, id, { clientId: setup, seq: 1, baseRevision: 0, ops: [createOp(n)] })
    const a = tab()
    const b = tab()
    const [ackA, ackB] = await Promise.all([
      store.submit(user, id, {
        clientId: a,
        seq: 1,
        baseRevision: 1,
        ops: [updateOp(n, { text: 'from A' })],
      }),
      store.submit(user, id, {
        clientId: b,
        seq: 1,
        baseRevision: 1,
        ops: [updateOp(n, { x: 500 })],
      }),
    ])
    expect([ackA.revision, ackB.revision].sort()).toEqual([2, 3])
    const note = parseFile(id).state?.notes.get(n)
    expect(note?.text).toBe('from A')
    expect(note?.x).toBe(500)
  })

  it('Review Focus 1: a tab racing its own seq 2 and 3 gets client-busy, never a duplicate', async () => {
    const id = await newBoard()
    const t = tab()
    await store.submit(user, id, { clientId: t, seq: 1, baseRevision: 0, ops: [createOp()] })
    const seq3 = { clientId: t, seq: 3, baseRevision: 1, ops: [createOp()] }
    const p2 = store.submit(user, id, { clientId: t, seq: 2, baseRevision: 1, ops: [createOp()] })
    const p3 = store.submit(user, id, seq3)
    const [r2, r3] = await Promise.allSettled([p2, p3])
    expect(r2.status === 'fulfilled' && r2.value).toMatchObject({ revision: 2, duplicate: false })
    expect(r3.status === 'rejected' && (r3.reason as StoreError).code).toBe('client-busy')
    const again = await store.submit(user, id, seq3)
    expect(again).toMatchObject({ revision: 3, duplicate: false })
    expect(parseFile(id).state?.board.clients[t]?.lastSeq).toBe(3)
  })

  it('one rejected batch in a group does not stop the others', async () => {
    const id = await newBoard()
    const good1 = newId('note')
    const good2 = newId('note')
    const results = await Promise.allSettled([
      store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp(good1)] }),
      store.submit(user, id, {
        clientId: tab(),
        seq: 1,
        baseRevision: 0,
        ops: [updateOp(newId('note'), { x: 1 })],
      }),
      store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp(good2)] }),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    const err = (results[1] as PromiseRejectedResult).reason as StoreError
    expect(err.code).toBe('rejected')
    expect(err.opError?.code).toBe('not-found')
    const state = parseFile(id).state
    expect(state?.board.revision).toBe(2)
    expect(state?.notes.has(good1) && state.notes.has(good2)).toBe(true)
  })

  it('a baseRevision ahead of the board gives revision-ahead', async () => {
    const id = await newBoard()
    await store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp()] })
    const p = store.submit(user, id, {
      clientId: tab(),
      seq: 1,
      baseRevision: 99,
      ops: [createOp()],
    })
    expect(await codeOf(p)).toBe('revision-ahead')
  })

  it('a malformed client id is rejected before anything is written', async () => {
    const id = await newBoard()
    const p = store.submit(user, id, {
      clientId: 'tab_x',
      seq: 1,
      baseRevision: 0,
      ops: [createOp()],
    })
    expect(await codeOf(p)).toBe('rejected')
    expect(parseFile(id).state?.board.revision).toBe(0)
  })

  it('submitServer commits with no mark and no origin client', async () => {
    const id = await newBoard()
    const events: BoardEvent[] = []
    await store.subscribe(user, id, (e) => events.push(e))
    const ack = await store.submitServer(user, id, [createOp()])
    expect(ack).toEqual({ clientId: null, seq: null, revision: 1, now: NOW, duplicate: false })
    expect(parseFile(id).state?.board.clients).toEqual({})
    expect(events).toMatchObject([
      { type: 'commit', commit: { revision: 1, originClientId: null, seq: null, now: NOW } },
    ])
  })
})

describe('Review Focus 2: replay after the mark is gone', () => {
  it('an old tab id without a mark is client-expired and nothing is written', async () => {
    const id = await newBoard()
    const old = newId('tab', Date.parse(NOW) - 91 * DAY_MS)
    const bytes = stored(id)
    const p = store.submit(user, id, { clientId: old, seq: 1, baseRevision: 0, ops: [createOp()] })
    expect(await codeOf(p)).toBe('client-expired')
    expect(stored(id).equals(bytes)).toBe(true)
  })

  it('the same old id is accepted while its mark exists', async () => {
    clock.set(new Date(Date.parse(NOW) - 91 * DAY_MS).toISOString())
    const id = await newBoard()
    const old = tab()
    clock.set(new Date(Date.parse(NOW) - 80 * DAY_MS).toISOString())
    await store.submit(user, id, { clientId: old, seq: 1, baseRevision: 0, ops: [createOp()] })
    clock.set(NOW)
    const ack = await store.submit(user, id, {
      clientId: old,
      seq: 2,
      baseRevision: 1,
      ops: [createOp()],
    })
    expect(ack).toMatchObject({ revision: 2, duplicate: false })
  })

  it('a tab whose mark was pruned cannot replay seq 1', async () => {
    const id = await newBoard()
    const idle = tab()
    const batch = { clientId: idle, seq: 1, baseRevision: 0, ops: [createOp()] }
    await store.submit(user, id, batch)
    clock.advance(91 * DAY_MS)
    await store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 1, ops: [createOp()] })
    expect(parseFile(id).state?.board.clients[idle]).toBeUndefined()
    const bytes = stored(id)
    expect(await codeOf(store.submit(user, id, batch))).toBe('client-expired')
    expect(stored(id).equals(bytes)).toBe(true)
  })
})

describe('storage', () => {
  it('a failed append rejects with storage, keeps the old state, and the retry acks', async () => {
    const id = await newBoard()
    await store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp()] })
    const t = tab()
    const batch = { clientId: t, seq: 1, baseRevision: 1, ops: [createOp()] }
    const journal = join(dirOf(id), 'journal.jsonl')
    await chmod(journal, 0o400)
    try {
      expect(await codeOf(store.submit(user, id, batch))).toBe('storage')
      expect((await store.read(user, id)).revision).toBe(1)
    } finally {
      await chmod(journal, 0o600)
    }
    expect(await store.submit(user, id, batch)).toMatchObject({ revision: 2, duplicate: false })
    expect(parseFile(id).state?.board.revision).toBe(2)
    expect(logs.join('\n')).not.toContain(id)
  })

  it('an unreadable board is reported each time and never cached', async () => {
    const id = await newBoard()
    const text = readFileSync(fileOf(id), 'utf8').replace('"schemaVersion":6', '"schemaVersion":7')
    await writeFile(fileOf(id), text)
    const err = await store.read(user, id).catch((e: StoreError) => e)
    expect(err).toMatchObject({ code: 'board-unreadable', reason: 'unsupported-version' })
    expect(store.stats.cached).toBe(0)
    const p = store.submit(user, id, {
      clientId: tab(),
      seq: 1,
      baseRevision: 0,
      ops: [createOp()],
    })
    expect(await codeOf(p)).toBe('board-unreadable')
    expect(readFileSync(fileOf(id), 'utf8')).toBe(text)
  })
})

describe('Review Focus 4: board.jsonl edited by hand while cached', () => {
  it('a background compaction never renames over a hand edit made after its last look', async () => {
    await useStore({ compactIdleMs: 300, compactEveryHour: false })
    const id = await newBoard()
    await store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp()] })
    const events: BoardEvent[] = []
    await store.subscribe(user, id, (e) => events.push(e))
    // Edited right after the commit; the idle compaction starts later, without any request.
    const s = parseFile(id).state
    if (!s) throw new Error('board did not load')
    const edited = serializeBoard({ ...s, board: { ...s.board, name: 'By hand', revision: 0 } })
    await writeFile(fileOf(id), edited)

    await vi.waitFor(() => expect(existsSync(join(dirOf(id), 'recovery.json'))).toBe(true), {
      timeout: 5000,
    })
    const view = await store.read(user, id)
    expect(view.state.board.name).toBe('By hand')
    expect(view.recovery).toMatchObject({ integrity: 'restored', journalCommits: 1 })
    expect(events).toEqual([{ type: 'reset', revision: view.revision }])
    const quarantined = readdirSync(join(dirOf(id), 'quarantine')).map((f) =>
      readFileSync(join(dirOf(id), 'quarantine', f), 'utf8'),
    )
    expect(quarantined).toContain(edited)
  })

  it('reloads through recovery, keeps the edit, quarantines the bytes and resets subscribers', async () => {
    const id = await newBoard()
    const n = newId('note')
    await store.submit(user, id, {
      clientId: tab(),
      seq: 1,
      baseRevision: 0,
      ops: [createOp(n, 'original')],
    })
    await store.compact(user, id)
    const events: BoardEvent[] = []
    await store.subscribe(user, id, (e) => events.push(e))

    const edited = readFileSync(fileOf(id), 'utf8').replace('"original"', '"edited by hand!"')
    await writeFile(fileOf(id), edited)

    const view = await store.read(user, id)
    expect(view.state.notes.get(n)?.text).toBe('edited by hand!')
    expect(view.recovery?.integrity).toBe('checksum-mismatch')
    const quarantined = readdirSync(join(dirOf(id), 'quarantine')).map((f) =>
      readFileSync(join(dirOf(id), 'quarantine', f), 'utf8'),
    )
    expect(quarantined).toContain(edited)
    expect(events).toEqual([{ type: 'reset', revision: view.revision }])
    expect((await store.listBoards(user))[0]?.recovered).toBe(true)

    const ack = await store.submit(user, id, {
      clientId: tab(),
      seq: 1,
      baseRevision: view.revision,
      ops: [updateOp(n, { x: 42 })],
    })
    expect(ack.revision).toBe(view.revision + 1)
    const note = parseFile(id).state?.notes.get(n)
    expect(note).toMatchObject({ text: 'edited by hand!', x: 42 })

    await store.dismissRecovery(user, id)
    expect((await store.read(user, id)).recovery).toBeNull()
  })

  it('a clean older copy put back while cached never moves the revision backwards', async () => {
    const id = await newBoard()
    const t = tab()
    let seq = 0
    const commit = async (text: string, baseRevision: number) =>
      store.submit(user, id, {
        clientId: t,
        seq: ++seq,
        baseRevision,
        ops: [createOp(newId('note'), text)],
      })
    await commit('a', 0)
    await commit('b', 1)
    await store.compact(user, id)
    const older = readFileSync(fileOf(id), 'utf8') // a clean revision-2 copy
    await commit('c', 2)
    await commit('d', 3)
    await store.compact(user, id)
    const events: BoardEvent[] = []
    await store.subscribe(user, id, (e) => events.push(e))

    await writeFile(fileOf(id), older)
    const view = await store.read(user, id)
    expect(view.revision).toBe(5)
    expect(view.recovery?.integrity).toBe('restored')
    expect([...view.state.notes.values()].map((n) => n.text).sort()).toEqual(['a', 'b'])
    expect(events).toEqual([{ type: 'reset', revision: 5 }])
    const quarantined = readdirSync(join(dirOf(id), 'quarantine')).map((f) =>
      readFileSync(join(dirOf(id), 'quarantine', f), 'utf8'),
    )
    expect(quarantined).toContain(older)
    expect(parseFile(id).state?.board.revision).toBe(5)

    // A replica that saw revisions 3 and 4 before the restore must refetch, never get [].
    expect((await commit('X', 5)).revision).toBe(6)
    expect((await commit('Y', 6)).revision).toBe(7)
    // (The restore's notice stands, so the answer says so: `X-Papertie-Recovered`.)
    for (const rev of [2, 3, 4]) {
      expect(await store.since(user, id, rev)).toEqual({ revision: 7, full: true, recovered: true })
    }
  })

  it('a clean rewrite while cached is an external edit; identical bytes are no change', async () => {
    const id = await newBoard()
    await store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp()] })
    await store.compact(user, id)
    const events: BoardEvent[] = []
    await store.subscribe(user, id, (e) => events.push(e))

    // Same bytes, new inode and mtime: nothing to recover.
    const same = readFileSync(fileOf(id), 'utf8')
    await rm(fileOf(id))
    await writeFile(fileOf(id), same)
    const untouched = await store.read(user, id)
    expect(untouched.revision).toBe(1)
    expect(untouched.recovery).toBeNull()
    expect(events).toEqual([])

    const state = parseFile(id).state
    if (!state) throw new Error('board did not load')
    const renamed = serializeBoard({ ...state, board: { ...state.board, name: 'Renamed' } })
    await writeFile(fileOf(id), renamed)
    const view = await store.read(user, id)
    expect(view.revision).toBe(2)
    expect(view.state.board.name).toBe('Renamed')
    expect(view.recovery?.integrity).toBe('external-edit')
    expect(events).toEqual([{ type: 'reset', revision: 2 }])
  })
})

describe('cache', () => {
  it('keeps at most cacheSize handles, never evicting a subscribed board', async () => {
    await useStore({ cacheSize: 2 })
    const ids = [await newBoard('1'), await newBoard('2'), await newBoard('3'), await newBoard('4')]
    const [b1, b2, b3, b4] = ids as [string, string, string, string]
    const first = await store.read(user, b1)
    await store.read(user, b2)
    await store.read(user, b3)
    expect(store.stats.cached).toBe(2)
    expect((await store.read(user, b1)).state).toEqual(first.state)

    // b1 is subscribed and has a commit in its ring; reading three others must not evict it.
    const off = await store.subscribe(user, b1, () => {})
    await store.submit(user, b1, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp()] })
    await store.compact(user, b1) // the hour's first commit compacts; a running one is never evicted
    for (const b of [b2, b3, b4]) await store.read(user, b)
    expect(await store.since(user, b1, 0)).toMatchObject({
      revision: 1,
      commits: [{ revision: 1 }],
    })
    off()
    for (const b of [b2, b3, b4]) await store.read(user, b)
    expect(await store.since(user, b1, 0)).toEqual({ revision: 1, full: true })
  })

  it('evicts a handle left idle for idleEvictMs', async () => {
    await useStore({ idleEvictMs: 20 })
    const id = await newBoard()
    await store.read(user, id)
    expect(store.stats.cached).toBe(1)
    await vi.waitFor(() => expect(store.stats.cached).toBe(0), { timeout: 2000 })
  })
})

describe('listing a board that is not cached', () => {
  /** `fn`'s result, its wall time and the board loads (whole-board parses) it made. */
  async function measured<T>(
    fn: () => Promise<T>,
  ): Promise<{ value: T; ms: number; loads: number }> {
    const loads = store.stats.loads
    const t0 = performance.now()
    const value = await fn()
    return { value, ms: performance.now() - t0, loads: store.stats.loads - loads }
  }

  it('lists an evicted 100,000-note board without parsing it; the read after parses once', async () => {
    const id = await newBoard('Lifetime')
    // 99,999 notes, and the commit below makes 100,000 (the limit).
    await writeFile(fileOf(id), serializeBoard(hugeState(id, 99_999)))

    // Not written by this server, so the listing loads it, and keeps it for the read.
    await useStore()
    const list1 = await measured(() => store.listBoards(user))
    const read1 = await measured(() => store.read(user, id))
    expect(list1.loads + read1.loads).toBe(1)
    expect(read1.value.state.notes.size).toBe(99_999)
    await store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp()] })

    // The server stopped (or dropped its handle) cleanly: the next listing parses nothing.
    await useStore()
    const list2 = await measured(() => store.listBoards(user))
    const read2 = await measured(() => store.read(user, id))
    expect(list2.loads).toBe(0)
    expect(read2.loads).toBe(1)
    expect(list2.value).toEqual([
      {
        id,
        name: 'Lifetime',
        revision: 1,
        createdAt: read2.value.state.board.createdAt,
        updatedAt: read2.value.state.board.updatedAt,
        recovered: false,
      },
    ])
    console.info(
      `cold list of a 100,000-note board: ${list1.ms.toFixed(0)} ms loading it ` +
        `(read after ${read1.ms.toFixed(0)} ms), ${list2.ms.toFixed(1)} ms from its summary ` +
        `(read after ${read2.ms.toFixed(0)} ms)`,
    )
  }, 120_000)

  it('a summary the board has moved past is not used', async () => {
    const id = await newBoard()
    await store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp()] })
    await useStore() // keeps the summary at revision 1
    // A server killed before it could keep one: its commit is on disk, its summary is not.
    const killed = makeStore()
    await killed.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 1, ops: [createOp()] })
    await useStore()
    const listed = await store.listBoards(user)
    expect(listed.map((b) => b.revision)).toEqual([2])
    expect(store.stats.loads).toBe(1)
    expect(store.stats.cached).toBe(1) // kept for the read that follows

    // Edited by hand while the server was stopped: listed as the file says.
    await useStore()
    const text = stored(id).toString('utf8').replace('"name":"Board"', '"name":"Renamed"')
    await rm(join(dirOf(id), 'journal.jsonl'), { force: true })
    await writeFile(fileOf(id), text)
    expect((await store.listBoards(user)).map((b) => b.name)).toEqual(['Renamed'])
  })

  it('a listing never evicts another board to keep the one it loaded', async () => {
    await useStore({ cacheSize: 1 })
    const [a, b] = [await newBoard('a'), await newBoard('b')]
    await rm(join(dirOf(a), 'summary.json'), { force: true })
    await rm(join(dirOf(b), 'summary.json'), { force: true })
    await useStore({ cacheSize: 1 })
    await store.read(user, b)
    expect((await store.listBoards(user)).map((x) => x.name).sort()).toEqual(['a', 'b'])
    expect(store.stats.cached).toBe(1)
    const loads = store.stats.loads
    await store.read(user, b)
    expect(store.stats.loads).toBe(loads)
  })
})

describe('since', () => {
  it('replays ring commits, and reports gaps and future revisions as full', async () => {
    const id = await newBoard()
    const acks = []
    for (let i = 0; i < 5; i++) {
      clock.advance(1000)
      acks.push(
        await store.submit(user, id, {
          clientId: tab(),
          seq: 1,
          baseRevision: i,
          ops: [createOp()],
        }),
      )
    }
    const r = await store.since(user, id, 2)
    expect('commits' in r && r.commits.map((c) => [c.revision, c.now])).toEqual(
      acks.slice(2).map((a) => [a.revision, a.now]),
    )
    expect(await store.since(user, id, 5)).toEqual({ revision: 5, commits: [] })
    expect(await store.since(user, id, 9)).toEqual({ revision: 5, full: true })

    await useStore({ ringCommits: 2 })
    for (let i = 5; i < 8; i++) {
      await store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: i, ops: [createOp()] })
    }
    expect(await store.since(user, id, 1)).toEqual({ revision: 8, full: true })
    expect(await store.since(user, id, 6)).toMatchObject({
      revision: 8,
      commits: [{ revision: 7 }, { revision: 8 }],
    })
  })
})

describe('closeUser', () => {
  it('publishes closed, drops subscribers and evicts the user’s boards', async () => {
    const id = await newBoard()
    const events: BoardEvent[] = []
    await store.subscribe(user, id, (e) => events.push(e))
    const pending = store.submit(user, id, {
      clientId: tab(),
      seq: 1,
      baseRevision: 0,
      ops: [createOp()],
    })
    await store.closeUser(user)
    expect(await pending).toMatchObject({ revision: 1 })
    expect(events.map((e) => e.type)).toEqual(['commit', 'closed'])
    expect(store.stats.cached).toBe(0)
  })
})

describe('account deletion tombstone', () => {
  it('beginDeletion waits for a create in flight, then refuses every write and load', async () => {
    const id = await newBoard()
    const events: BoardEvent[] = []
    await store.subscribe(user, id, (e) => events.push(e))
    let settled = false
    const racing = store.createBoard(user, 'racing')
    racing.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await store.beginDeletion(user)
    expect(settled).toBe(true)
    expect(events.map((e) => e.type)).toEqual(['closed'])

    const refused = [
      store.createBoard(user, 'late'),
      store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp()] }),
      store.submitServer(user, id, [createOp()]),
      store.read(user, id),
      store.since(user, id, 0),
      store.whileLive(user, async () => 'never runs'),
    ]
    for (const p of refused) expect(await codeOf(p)).toBe('not-found')
    expect(await store.listBoards(user)).toEqual([])

    // What the deletion hook does next: the directory leaves, and nothing brings it back.
    const home = join(dataDir, 'users', user)
    const moved = join(dataDir, 'moved')
    await rename(home, moved)
    expect(await codeOf(store.createBoard(user, 'later still'))).toBe('not-found')
    expect(existsSync(home)).toBe(false)

    // Other users are unaffected.
    expect((await store.createBoard(serverId('user'), 'other')).name).toBe('other')

    // A failed deletion lifts the tombstone once the directory is back.
    await rename(moved, home)
    store.cancelDeletion(user)
    expect((await store.read(user, id)).revision).toBe(0)
    expect((await store.createBoard(user, 'after')).name).toBe('after')
  })
})
