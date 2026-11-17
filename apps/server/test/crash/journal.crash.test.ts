import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BoardState, newId, type Op, parseBoard } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serverId } from '../../src/ids'
import type { BoardSummary, CommitAck, SubmitInput } from '../../src/store/boardStore'
import { noteCreate } from '../helpers/boards'
import {
  type Command,
  type ReadResult,
  type Reply,
  resultOf,
  type StoreChild,
  spawnStore,
} from './storeChild'

/**
 * Review Focus 1: a SIGKILL at any journal or compaction fault point. After the restart the board
 * holds every acked batch exactly once; an unacked batch is either there (its retry is answered as
 * a duplicate at the revision it got) or not (its retry applies it), never twice.
 */

const T0 = '2026-10-27T10:00:00.000Z'

let root: string
const children: Array<{ kill(): void }> = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'papertie-journal-crash-'))
})
afterEach(async () => {
  for (const c of children.splice(0)) c.kill()
  await rm(root, { recursive: true, force: true })
})

async function store(dataDir: string, fault?: string): Promise<StoreChild> {
  const c = await spawnStore(dataDir, { fault, now: T0 })
  children.push(c)
  return c
}

async function stopStore(c: StoreChild): Promise<void> {
  await c.close()
  expect(await c.exited).toBeNull()
}

const listDir = async (dir: string) => {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

/**
 * `state` comparable across two runs of the same batches: `updatedAt` (wall-clock) and the
 * board's id go, and each record's `rev` stays, so a revision applied twice or out of order after
 * a SIGKILL shows as a difference.
 */
function comparable(state: BoardState): unknown {
  const records = <R extends { id: string; updatedAt?: string }>(m: ReadonlyMap<string, R>) =>
    [...m.values()]
      .map(({ updatedAt: _, ...rest }) => rest)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const { updatedAt: _, ...board } = state.board
  return {
    board: { ...board, id: 'board' },
    assets: records(state.assets),
    notes: records(state.notes),
    yarns: records(state.yarns),
  }
}

function stateOf(text: string): BoardState {
  const r = parseBoard(text)
  expect(r.integrity).toBe('ok')
  expect(r.issues).toEqual([])
  if (!r.state) throw new Error('board did not load')
  return r.state
}

const submit = (userId: string, boardId: string, input: SubmitInput): Command => ({
  cmd: 'submit',
  userId,
  boardId,
  input,
})

/**
 * `before` batches acked before the crash run, and up to 3 sent during it (from 3 tabs: one
 * group). The first in-flight batch continues tab a's sequence.
 */
function batches(before: number, bulk: number) {
  const tabMs = Date.parse(T0)
  const [a, b, c] = [newId('tab', tabMs), newId('tab', tabMs), newId('tab', tabMs)] as [
    string,
    string,
    string,
  ]
  const note = (i: number) => noteCreate({ id: newId('note'), text: `note ${i}`, at: T0 }) as Op
  const acked: SubmitInput[] = Array.from({ length: before }, (_, i) => ({
    clientId: a,
    seq: i + 1,
    baseRevision: i,
    ops: [note(i + 1)],
  }))
  // A bigger board, so a compaction takes long enough for a commit group to land inside it.
  if (acked[0]) {
    const pad = Array.from({ length: bulk }, (_, i) =>
      noteCreate({ id: newId('note'), text: `bulk ${i} ${'€'.repeat(100)}`, at: T0 }),
    ) as Op[]
    acked[0] = { ...acked[0], ops: [...acked[0].ops, ...pad] }
  }
  const inFlight: SubmitInput[] = [
    { clientId: a, seq: before + 1, baseRevision: before, ops: [note(before + 1)] },
    { clientId: b, seq: 1, baseRevision: before, ops: [note(before + 2)] },
    { clientId: c, seq: 1, baseRevision: before, ops: [note(before + 3)] },
  ]
  return { acked, inFlight }
}

interface Row {
  point: string
  /** `commit`: the batches alone. `compact`: a compaction and the batches in the same turn. */
  during: 'commit' | 'compact'
  /** Batches acked before the crash run: 0 is a board with no journal yet. */
  before: 0 | 3
  /** Batches sent in the crash run. */
  group: 0 | 1 | 2 | 3
}

const COMMIT_POINTS = ['journal:partial-append', 'journal:after-append']
const COMPACT_POINTS = [
  'snapshot:partial-tmp',
  'snapshot:after-tmp-write',
  'snapshot:after-tmp-fsync',
  'journal:partial-append',
  'journal:after-append',
  'backup:after-write',
  // The old snapshot's second name taken, the rename not yet made.
  'snapshot:after-link',
  'snapshot:after-rename',
  'snapshot:after-dir-fsync',
  'journal:after-next',
  'journal:after-rotate',
]
/** Notes added to the first acked batch of compaction rows. */
const BULK = 2000
const AFTER_RENAME = [
  'snapshot:after-rename',
  'snapshot:after-dir-fsync',
  'journal:after-next',
  'journal:after-rotate',
]

const MATRIX: Row[] = [
  ...COMMIT_POINTS.flatMap((point) => [
    { point, during: 'commit' as const, before: 3 as const, group: 1 as const },
    { point, during: 'commit' as const, before: 3 as const, group: 3 as const },
  ]),
  // A board's first commit creates its journal (journal.next, rename, directory fsync).
  ...['journal:after-next', 'journal:after-rotate', 'journal:partial-append'].map((point) => ({
    point,
    during: 'commit' as const,
    before: 0 as const,
    group: 1 as const,
  })),
  // The compaction alone (its own append is the first), and racing a commit group.
  ...COMPACT_POINTS.flatMap((point) => [
    { point, during: 'compact' as const, before: 3 as const, group: 0 as const },
    { point, during: 'compact' as const, before: 3 as const, group: 2 as const },
  ]),
]

/** Create the board and commit the acked batches; returns the board id. */
async function setUp(dataDir: string, userId: string, acked: SubmitInput[]): Promise<string> {
  const c = await store(dataDir)
  const board = resultOf<BoardSummary>(await c.send({ cmd: 'create', userId }))
  for (const [i, input] of acked.entries()) {
    expect(resultOf<CommitAck>(await c.send(submit(userId, board.id, input)))).toMatchObject({
      revision: i + 1,
      duplicate: false,
    })
  }
  await stopStore(c)
  return board.id
}

function crashCommands(row: Row, userId: string, boardId: string, inFlight: SubmitInput[]) {
  const cmds = inFlight.map((b) => submit(userId, boardId, b))
  return row.during === 'compact' ? [{ cmd: 'compact', userId, boardId } as Command, ...cmds] : cmds
}

/** The same run without a fault: the final board text. */
async function reference(row: Row, acked: SubmitInput[], inFlight: SubmitInput[]) {
  const dataDir = join(root, 'reference')
  const userId = serverId('user')
  const boardId = await setUp(dataDir, userId, acked)
  const c = await store(dataDir)
  const replies = await Promise.all(c.sendAll(crashCommands(row, userId, boardId, inFlight)))
  for (const r of replies) resultOf(r)
  const view = resultOf<ReadResult>(await c.send({ cmd: 'read', userId, boardId }))
  await stopStore(c)
  return view.text
}

/** Commit revisions in `journal.jsonl`, in file order. */
async function journalRevs(dir: string): Promise<number[]> {
  const text = await readFile(join(dir, 'journal.jsonl'), 'utf8')
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { rev?: number }).rev)
    .filter((r): r is number => r !== undefined)
}

describe('journal survives SIGKILL at every fault point', () => {
  it.each(MATRIX)('$point during $during ($before acked, then $group)', async (row) => {
    const dataDir = join(root, 'data')
    const userId = serverId('user')
    const base = row.before
    const bulk = row.during === 'compact' ? BULK : 0
    const { acked, inFlight: all } = batches(base, bulk)
    const inFlight = all.slice(0, row.group)
    const refText = await reference(row, acked, inFlight)

    // 1. A board with 3 acked batches.
    const boardId = await setUp(dataDir, userId, acked)
    const dir = join(dataDir, 'users', userId, 'boards', boardId)

    // 2. Restart with the fault armed; send the crash run's commands in one write.
    const faulty = await store(dataDir, `${row.point}@1`)
    const sent = faulty.sendAll(crashCommands(row, userId, boardId, inFlight))
    await Promise.allSettled(sent)
    expect(await faulty.exited).toBe('SIGKILL')
    const ackedNow = new Map<string, number>()
    for (const r of faulty.replies as Reply[]) {
      const ack = resultOf<CommitAck>(r)
      ackedNow.set(`${ack.clientId}:${ack.seq}`, ack.revision)
    }
    if (row.during === 'commit') expect(ackedNow.size).toBe(0)
    // Killed after the rename: the commit group really landed during the compaction (acked, and
    // carried into the new journal or replayed from the old one).
    if (row.during === 'compact' && row.group > 0 && AFTER_RENAME.includes(row.point)) {
      expect(ackedNow.size).toBeGreaterThan(0)
    }

    // 3. Restart without a fault: no recovery, nothing quarantined, no leftovers.
    const fresh = await store(dataDir)
    const read = resultOf<ReadResult>(await fresh.send({ cmd: 'read', userId, boardId }))
    expect(read.recovered).toBe(false)
    expect(await listDir(join(dir, 'quarantine'))).toEqual([])
    // ...nor the old snapshot's second name, which a compaction killed mid-install leaves.
    expect(
      (await listDir(dir)).filter(
        (n) => n.endsWith('.tmp') || n.endsWith('.next') || n.endsWith('.prev'),
      ),
    ).toEqual([])
    const afterCrash = stateOf(read.text)
    expect(read.revision).toBeGreaterThanOrEqual(base + ackedNow.size)
    expect(read.revision).toBeLessThanOrEqual(base + inFlight.length)
    // Every acked batch is there.
    for (const [key] of ackedNow) {
      const [clientId, seq] = key.split(':') as [string, string]
      expect(afterCrash.board.clients[clientId]?.lastSeq).toBeGreaterThanOrEqual(Number(seq))
    }

    // 4. Retry every in-flight batch: duplicates keep their revision, the rest are applied.
    const retried = (
      await Promise.all(fresh.sendAll(inFlight.map((b) => submit(userId, boardId, b))))
    ).map((r) => resultOf<CommitAck>(r))
    for (const [i, ack] of retried.entries()) {
      expect(ack.revision).toBe(base + 1 + i)
      const key = `${ack.clientId}:${ack.seq}`
      if (ackedNow.has(key)) {
        expect(ack.duplicate).toBe(true)
        expect(ack.revision).toBe(ackedNow.get(key))
      }
      expect(ack.duplicate).toBe(ack.revision <= read.revision)
    }
    const final = resultOf<ReadResult>(await fresh.send({ cmd: 'read', userId, boardId }))
    expect(final.revision).toBe(base + inFlight.length)
    expect(comparable(stateOf(final.text))).toEqual(comparable(stateOf(refText)))
    expect(stateOf(final.text).notes.size).toBe(bulk + base + inFlight.length)
    // Nothing doubled on disk either: the journal's revisions climb one at a time.
    const revs = await journalRevs(dir)
    expect(revs).toEqual(revs.map((_, i) => (revs[0] ?? 0) + i))

    // 5. A compaction after the crash, and a restart, give the same board.
    resultOf(await fresh.send({ cmd: 'compact', userId, boardId }))
    await stopStore(fresh)
    const snapshot = stateOf(await readFile(join(dir, 'board.jsonl'), 'utf8'))
    expect(comparable(snapshot)).toEqual(comparable(stateOf(final.text)))
    expect(await journalRevs(dir)).toEqual([])
    const last = await store(dataDir)
    const again = resultOf<ReadResult>(await last.send({ cmd: 'read', userId, boardId }))
    expect(again.text).toBe(final.text)
    expect(again.recovered).toBe(false)
    await stopStore(last)
  })
})

describe('deletions survive SIGKILL', () => {
  it.each(['journal:partial-append', 'journal:after-append'])(
    'a deleted note is gone exactly when its commit survived (%s)',
    async (point) => {
      const dataDir = join(root, 'data')
      const userId = serverId('user')
      const { acked } = batches(3, 0)
      const boardId = await setUp(dataDir, userId, acked)
      const first = acked[0]?.ops[0] as Op & { op: 'note.create' }
      const victim = first.note.id
      const del: SubmitInput = {
        clientId: acked[0]?.clientId as string,
        seq: 4,
        baseRevision: 3,
        ops: [{ op: 'note.delete', id: victim }],
      }

      const faulty = await store(dataDir, `${point}@1`)
      await Promise.allSettled([faulty.send(submit(userId, boardId, del))])
      expect(await faulty.exited).toBe('SIGKILL')

      const fresh = await store(dataDir)
      const read = resultOf<ReadResult>(await fresh.send({ cmd: 'read', userId, boardId }))
      expect(read.recovered).toBe(false)
      const deleted = !stateOf(read.text).notes.has(victim)
      expect(read.revision).toBe(deleted ? 4 : 3)

      // The retry lands (or is a duplicate) at revision 4; the note is gone once.
      const ack = resultOf<CommitAck>(await fresh.send(submit(userId, boardId, del)))
      expect(ack).toMatchObject({ revision: 4, duplicate: deleted })
      await stopStore(fresh)
      const last = await store(dataDir)
      const again = resultOf<ReadResult>(await last.send({ cmd: 'read', userId, boardId }))
      expect(again.revision).toBe(4)
      expect(stateOf(again.text).notes.has(victim)).toBe(false)
      await stopStore(last)
    },
  )
})
