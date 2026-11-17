import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId, type Op, parseBoard } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serverId } from '../../src/ids'
import type { BoardSummary, CommitAck } from '../../src/store/boardStore'
import { noteCreate } from '../helpers/boards'
import { blockCreate, blockRecord, bookCreate, bookRecord, edit, ins } from '../helpers/books'
import { type ReadResult, resultOf, type StoreChild, spawnStore } from './storeChild'

/**
 * A clean-file recovery (here: an older `board.jsonl` copied back while the board is cached at
 * revision 10) bumps the board above every revision it reached. A SIGKILL anywhere between its
 * first step and its last leaves the content put back standing, with its notice. The bump stands
 * too wherever the restart can still tell the board had gone further (its journal is there, or
 * the recovery's snapshot is in): a stream resuming from revision 10 is then sent `reset`. With
 * the journal gone and no snapshot yet, nothing on disk says so, and the file put back loads as
 * it is, at its own revision.
 */

const T0 = '2026-10-27T10:00:00.000Z'
/** The restart's clock: later, as a real one is (a re-run's quarantine copies get new names). */
const T1 = '2026-10-27T10:01:00.000Z'

let root: string
const children: Array<{ kill(): void }> = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'papertie-recovery-crash-'))
})
afterEach(async () => {
  for (const c of children.splice(0)) c.kill()
  await rm(root, { recursive: true, force: true })
})

async function store(dataDir: string, fault?: string, now = T0): Promise<StoreChild> {
  const c = await spawnStore(dataDir, { fault, now })
  children.push(c)
  return c
}

async function stopStore(c: StoreChild): Promise<void> {
  await c.close()
  expect(await c.exited).toBeNull()
}

/** The recovery's steps in order: marked notice, snapshot (tmp, rename), notice. */
const POINTS = [
  'recovery:after-notice',
  'snapshot:partial-tmp',
  'snapshot:after-tmp-write',
  'snapshot:after-tmp-fsync',
  'snapshot:after-rename',
  'snapshot:after-dir-fsync',
  'recovery:after-snapshot',
]

/**
 * A board committed up to revision 10 and compacted (its journal names only the revision-10
 * snapshot), with no backup left. Returns its id, directory and its text at revision 5.
 */
async function setUp(dataDir: string, userId: string) {
  const c = await store(dataDir)
  const { id: boardId } = resultOf<BoardSummary>(await c.send({ cmd: 'create', userId }))
  const clientId = newId('tab', Date.parse(T0))
  let older = ''
  for (let seq = 1; seq <= 10; seq++) {
    const input = {
      clientId,
      seq,
      baseRevision: seq - 1,
      ops: [noteCreate({ text: `note ${seq}`, at: T0 }) as Op],
    }
    const ack = await c.send({ cmd: 'submit', userId, boardId, input })
    expect(resultOf<CommitAck>(ack).revision).toBe(seq)
    if (seq === 5) older = resultOf<ReadResult>(await c.send({ cmd: 'read', userId, boardId })).text
  }
  resultOf(await c.send({ cmd: 'compact', userId, boardId }))
  await stopStore(c)
  const dir = join(dataDir, 'users', userId, 'boards', boardId)
  await rm(join(dir, 'backups'), { recursive: true, force: true })
  return { boardId, dir, older }
}

/** The steps before the recovery's snapshot is the board file. */
const BEFORE_SNAPSHOT = [
  'recovery:after-notice',
  'snapshot:partial-tmp',
  'snapshot:after-tmp-write',
  'snapshot:after-tmp-fsync',
]

describe('a clean-file recovery cut short by SIGKILL ends on the content put back', () => {
  for (const journal of ['kept', 'removed'] as const) {
    it.each(POINTS)(`%s (journal ${journal})`, async (point) => {
      const dataDir = join(root, 'data')
      const userId = serverId('user')
      const { boardId, dir, older } = await setUp(dataDir, userId)

      // Cached at 10, then the revision-5 file is copied back by hand.
      const faulty = await store(dataDir, `${point}@1`)
      const cached = resultOf<ReadResult>(await faulty.send({ cmd: 'read', userId, boardId }))
      expect(cached.revision).toBe(10)
      await writeFile(join(dir, 'board.jsonl'), older, { mode: 0o600 })
      if (journal === 'removed') await rm(join(dir, 'journal.jsonl'))
      await Promise.allSettled([faulty.send({ cmd: 'read', userId, boardId })])
      expect(await faulty.exited).toBe('SIGKILL')

      const fresh = await store(dataDir, undefined, T1)
      const read = resultOf<ReadResult>(await fresh.send({ cmd: 'read', userId, boardId }))
      const bumped = journal === 'kept' || !BEFORE_SNAPSHOT.includes(point)
      expect(read.revision).toBeGreaterThanOrEqual(bumped ? 11 : 5)
      expect(read.recovered).toBe(true)
      // The restored content stands: notes 1-5.
      const parsed = parseBoard(read.text)
      expect(parsed.integrity).toBe('ok')
      expect([...(parsed.state?.notes.values() ?? [])].map((n) => n.text).sort()).toEqual(
        ['note 1', 'note 2', 'note 3', 'note 4', 'note 5'].sort(),
      )
      // A stream that saw revision 10 gets `reset`.
      if (bumped) {
        expect(
          resultOf(await fresh.send({ cmd: 'since', userId, boardId, since: 10 })),
        ).toMatchObject({ revision: read.revision, full: true })
      }
      await stopStore(fresh)

      // Finished: the next start loads it untouched.
      const quarantine = (await readdir(join(dir, 'quarantine'))).sort()
      const last = await store(dataDir, undefined, T1)
      const again = resultOf<ReadResult>(await last.send({ cmd: 'read', userId, boardId }))
      expect(again.revision).toBe(read.revision)
      expect(again.text).toBe(read.text)
      expect((await readdir(join(dir, 'quarantine'))).sort()).toEqual(quarantine)
      expect(JSON.parse(await readFile(join(dir, 'recovery.json'), 'utf8'))).not.toHaveProperty(
        'inProgress',
      )
      await stopStore(last)
    })
  }
})

describe('a restore through the API cut short by SIGKILL never says it restored', () => {
  /** Between its marker and its new snapshot: the board stays as it was. */
  const CUT_SHORT = ['restore:after-intent', 'journal:partial-append', 'journal:after-append']
  /** After its snapshot is in: the restore stands. */
  const PUT_IN = [
    'snapshot:after-rename',
    'snapshot:after-dir-fsync',
    'journal:after-next',
    'journal:after-rotate',
  ]

  it.each([...CUT_SHORT, ...PUT_IN])('%s', async (point) => {
    const dataDir = join(root, 'data')
    const userId = serverId('user')
    const c = await store(dataDir)
    const { id: boardId } = resultOf<BoardSummary>(await c.send({ cmd: 'create', userId }))
    const clientId = newId('tab', Date.parse(T0))
    const submit = async (seq: number) => {
      const input = {
        clientId,
        seq,
        baseRevision: seq - 1,
        ops: [noteCreate({ text: `note ${seq}`, at: T0 }) as Op],
      }
      resultOf(await c.send({ cmd: 'submit', userId, boardId, input }))
    }
    for (let seq = 1; seq <= 3; seq++) await submit(seq)
    resultOf(await c.send({ cmd: 'compact', userId, boardId })) // the backup at revision 3
    for (let seq = 4; seq <= 5; seq++) await submit(seq)
    await stopStore(c)
    const dir = join(dataDir, 'users', userId, 'boards', boardId)
    const [file] = await readdir(join(dir, 'backups'))
    if (!file) throw new Error('no backup')

    const faulty = await store(dataDir, `${point}@1`)
    await Promise.allSettled([faulty.send({ cmd: 'restore', userId, boardId, file })])
    expect(await faulty.exited).toBe('SIGKILL')

    const fresh = await store(dataDir, undefined, T1)
    const read = resultOf<ReadResult>(await fresh.send({ cmd: 'read', userId, boardId }))
    const notes = [...(parseBoard(read.text).state?.notes.values() ?? [])].map((n) => n.text)
    if (CUT_SHORT.includes(point)) {
      expect(read.integrity).toBe('restore-interrupted')
      expect(notes).toHaveLength(5)
    } else {
      expect(read.integrity).toBe('restored')
      expect(notes).toHaveLength(3)
    }
    // Above every revision seen (5).
    expect(read.revision).toBeGreaterThanOrEqual(6)
    expect(resultOf(await fresh.send({ cmd: 'since', userId, boardId, since: 5 }))).toMatchObject({
      revision: read.revision,
      full: true,
    })
    await stopStore(fresh)
    expect(await readdir(dir)).not.toContain('restore.json')

    const last = await store(dataDir, undefined, T1)
    const again = resultOf<ReadResult>(await last.send({ cmd: 'read', userId, boardId }))
    expect(again).toEqual(read)
    await stopStore(last)
  })
})

describe('recovery keeps books', () => {
  it.each(['recovery:after-notice', 'snapshot:after-rename', 'recovery:after-snapshot'])(
    'recovery keeps books: an older file copied back, killed at %s',
    async (point) => {
      const dataDir = join(root, 'data')
      const userId = serverId('user')
      const c = await store(dataDir)
      const { id: boardId } = resultOf<BoardSummary>(await c.send({ cmd: 'create', userId }))
      const clientId = newId('tab', Date.parse(T0))
      const book = { ...bookRecord(), createdAt: T0, updatedAt: T0 }
      const block = blockRecord(book.id, 'V', 'chapter one')
      const inputs = [
        [bookCreate(book), blockCreate(block)],
        [edit(book.id, block.id, [ins(11, ', kept')])],
        [edit(book.id, block.id, [ins(0, 'later: ')])],
      ]
      let older = ''
      for (const [i, ops] of inputs.entries()) {
        const input = { clientId, seq: i + 1, baseRevision: i, ops }
        resultOf<CommitAck>(await c.send({ cmd: 'submit', userId, boardId, input }))
        if (i === 1)
          older = resultOf<ReadResult>(await c.send({ cmd: 'read', userId, boardId })).text
      }
      resultOf(await c.send({ cmd: 'compact', userId, boardId }))
      await stopStore(c)
      const dir = join(dataDir, 'users', userId, 'boards', boardId)
      await rm(join(dir, 'backups'), { recursive: true, force: true })

      const faulty = await store(dataDir, `${point}@1`)
      resultOf<ReadResult>(await faulty.send({ cmd: 'read', userId, boardId }))
      await writeFile(join(dir, 'board.jsonl'), older, { mode: 0o600 })
      await Promise.allSettled([faulty.send({ cmd: 'read', userId, boardId })])
      expect(await faulty.exited).toBe('SIGKILL')

      const fresh = await store(dataDir, undefined, T1)
      const read = resultOf<ReadResult>(await fresh.send({ cmd: 'read', userId, boardId }))
      expect(read.recovered).toBe(true)
      const state = parseBoard(read.text).state
      expect(state?.books.get(book.id)?.title).toBe(book.title)
      expect(state?.blocks.get(block.id)?.text).toBe('chapter one, kept')
      // And a damaged file (a torn last line) is repaired with its books.
      await stopStore(fresh)
      await writeFile(join(dir, 'board.jsonl'), `${read.text}{"type":"block","id":"blo`, {
        mode: 0o600,
      })
      const last = await store(dataDir, undefined, T1)
      const repaired = parseBoard(
        resultOf<ReadResult>(await last.send({ cmd: 'read', userId, boardId })).text,
      ).state
      expect(repaired?.blocks.get(block.id)?.text).toBe('chapter one, kept')
      await stopStore(last)
    },
  )
})
