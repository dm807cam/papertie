import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { appendFile, chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BoardState,
  newId,
  type Op,
  parseBoard,
  serializeBoard,
  type Yarn,
} from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverId } from '../src/ids'
import { COMPACT_IDLE_MS, JOURNAL_MAX_BYTES, JOURNAL_MAX_COMMITS } from '../src/limits'
import { createLogger } from '../src/log'
import { backupName, prepareHourlyBackup } from '../src/store/backups'
import { BoardStore, type BoardStoreOptions } from '../src/store/boardStore'
import { recordSlices, serializeSliced, stretchSlices } from '../src/store/compact'
import { type FaultPoint, type Faults, noFaults } from '../src/store/faults'
import { encodeCommit, encodeCommitSteps, parseJournal, replayJournal } from '../src/store/journal'
import { hugeState } from './helpers/boards'
import { FakeClock } from './helpers/clock'
import { PI } from './helpers/turns'

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
    // Compaction only when a test asks for it.
    compactIdleMs: 3_600_000,
    compactEveryHour: false,
    ...over,
  })
}

async function useStore(over: Partial<BoardStoreOptions> = {}): Promise<BoardStore> {
  await store.close()
  store = makeStore(over)
  return store
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'papertie-journal-'))
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
const journalOf = (boardId: string) => join(dirOf(boardId), 'journal.jsonl')
const boardFileOf = (boardId: string) => join(dirOf(boardId), 'board.jsonl')
const text = (path: string) => readFileSync(path, 'utf8')
const lines = (path: string) => text(path).split('\n').filter(Boolean)
const logEntries = () => logs.map((l) => JSON.parse(l) as Record<string, unknown>)

function fileState(boardId: string): BoardState {
  const r = parseBoard(text(boardFileOf(boardId)))
  expect(r.integrity).toBe('ok')
  if (!r.state) throw new Error('board.jsonl did not load')
  return r.state
}

function createOp(id = newId('note'), body = 'hello'): Op {
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
      text: body,
      image: null,
      createdAt: at,
      updatedAt: at,
    },
  }
}

class Boom extends Error {}
const throwAt = (point: FaultPoint): Faults => ({
  hit(p) {
    if (p === point) throw new Boom(p)
  },
})

async function newBoard(): Promise<string> {
  return (await store.createBoard(user, 'Board')).id
}

/** `n` commits from one tab, each creating a note; returns the note ids. */
async function commit(boardId: string, n: number, t = tab(), from = 0): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = newId('note')
    const rev = from + i
    await store.submit(user, boardId, {
      clientId: t,
      seq: rev + 1,
      baseRevision: rev,
      ops: [createOp(id, `note ${rev + 1}`)],
    })
    ids.push(id)
  }
  return ids
}

/** The sha256 in a JSONL text's eof line: what a journal's base line names it by. */
const eofSha = (jsonl: string) =>
  (JSON.parse(jsonl.trimEnd().split('\n').at(-1) as string) as { sha256: string }).sha256

const sha16 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)

describe('journal lines', () => {
  it('a commit line is {rev, ops, now, origin, crc}; crc is 8 bytes of the sha256 without it', () => {
    const ops = [createOp(newId('note'), 'Kết')]
    const origin = { clientId: tab(), seq: 3 }
    const line = encodeCommit({ rev: 7, ops, now: NOW, origin })
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['rev', 'ops', 'now', 'origin', 'crc'])
    expect(parsed).toMatchObject({ rev: 7, ops, now: NOW, origin })
    expect(parsed.crc).toBe(sha16(JSON.stringify({ rev: 7, ops, now: NOW, origin })))
  })
})

describe('journal lines of a rewritten commit', () => {
  it('a rewritten commit line carries sent before crc; every other line is as it was', () => {
    const ops = [createOp(newId('note'), 'x')]
    const origin = { clientId: tab(), seq: 3 }
    const sent = 'ab'.repeat(16)
    const line = encodeCommit({ rev: 7, ops, now: NOW, origin, sent })
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['rev', 'ops', 'now', 'origin', 'sent', 'crc'])
    expect(parsed.crc).toBe(sha16(JSON.stringify({ rev: 7, ops, now: NOW, origin, sent })))
    const entry = parseJournal(Buffer.from(`${line}\n`)).entries[0]
    expect(entry).toMatchObject({ kind: 'commit', rev: 7, sent })
    // Without one, byte for byte the line it always was.
    expect(encodeCommit({ rev: 7, ops, now: NOW, origin })).toBe(
      withCrcOfWhole(JSON.stringify({ rev: 7, ops, now: NOW, origin })),
    )
    // A `sent` that is no digest makes the line unreadable, as any other bad field.
    const bad = withCrcOfWhole(JSON.stringify({ rev: 8, ops, now: NOW, origin, sent: 'x' }))
    expect(parseJournal(Buffer.from(`${bad}\n`)).entries[0]?.kind).toBe('bad')
  })
})

describe('journal lines, a step at a time', () => {
  it("encodeCommitSteps gives encodeCommit's text exactly, pausing every few ops", () => {
    const origin = { clientId: tab(), seq: 3 }
    for (const n of [0, 1, 31, 32, 33, 400]) {
      const ops = Array.from({ length: n }, (_, i) =>
        createOp(newId('note'), `n ${i} Kết "q" \\ 😀`),
      )
      const line = { rev: 7, ops, now: NOW, origin: n % 2 ? origin : null }
      const whole = withCrcOfWhole(JSON.stringify(line))
      const steps = encodeCommitSteps(line)
      let pauses = 0
      let r = steps.next()
      for (; !r.done; r = steps.next()) pauses++
      expect(r.value.line).toBe(whole)
      // The ops' JSON between its brackets, as the commit ring counts it.
      expect(r.value.opsBytes).toBe(Math.max(0, Buffer.byteLength(JSON.stringify(ops)) - 2))
      expect(encodeCommit(line)).toBe(whole)
      expect(pauses).toBe(Math.floor(n / 32))
    }
  })
})

/** What a commit line was before it was built a step at a time: one stringify, one crc. */
function withCrcOfWhole(body: string): string {
  const crc = createHash('sha256').update(body, 'utf8').digest().subarray(0, 8).toString('hex')
  return `${body.slice(0, -1)},"crc":"${crc}"}`
}

describe('commit path', () => {
  it('commit appends one journal line and acks after fsync', async () => {
    const id = await newBoard()
    const snapshot = text(boardFileOf(id))
    const t = tab()
    const ops = [createOp()]
    const ack = await store.submit(user, id, { clientId: t, seq: 1, baseRevision: 0, ops })
    expect(ack).toEqual({ clientId: t, seq: 1, revision: 1, now: NOW, duplicate: false })

    // The snapshot is untouched; the journal holds its base line and the one commit.
    expect(text(boardFileOf(id))).toBe(snapshot)
    const [base, line, ...rest] = lines(journalOf(id))
    expect(rest).toEqual([])
    expect(JSON.parse(base as string)).toMatchObject({ snapshot: 0, sha256: eofSha(snapshot) })
    expect(line).toBe(encodeCommit({ rev: 1, ops, now: NOW, origin: { clientId: t, seq: 1 } }))

    // A fault between the write and the fsync: the batch is not acked.
    await useStore({ faults: throwAt('journal:after-append') })
    const p = store.submit(user, id, {
      clientId: tab(),
      seq: 1,
      baseRevision: 1,
      ops: [createOp()],
    })
    await expect(p).rejects.toMatchObject({ code: 'storage' })
    expect(store.stats.appends).toBe(0)
  })

  it("a group of many small batches commits as a Slicer job too: the threshold is the group's", async () => {
    // No compaction meanwhile: its slices are not the commit's.
    await useStore({ compactEveryHour: false })
    const id = await newBoard()
    await store.read(user, id)
    // 20 tabs, 40 ops each, in one group: 800 ops, though no batch is over INLINE_OPS.
    const batches = Array.from({ length: 20 }, () => ({
      clientId: tab(),
      seq: 1,
      baseRevision: 0,
      ops: Array.from({ length: 40 }, () => createOp(newId('note'), 'x')),
    }))
    recordSlices(true)
    let spans: ReturnType<typeof recordSlices>
    try {
      await Promise.all(batches.map((b) => store.submit(user, id, b)))
    } finally {
      spans = recordSlices(false)
    }
    // One group: one append.
    expect(store.stats.appends).toBe(1)
    expect((await store.read(user, id)).state.notes.size).toBe(800)
    expect(spans.length).toBeGreaterThan(0)
  })

  it('a compaction started while a large group finishes never takes its lines twice', async () => {
    await useStore({ compactEveryHour: false })
    const id = await newBoard()
    await commit(id, 1)
    const handle = () =>
      (
        store as unknown as {
          cache: Map<string, { state: BoardState; journal: { commits: number } | null }>
        }
      ).cache.get(`${user}/${id}`)
    // Four tabs of 500 notes in one group: a Slicer job whose region update yields (stretched).
    // Stretched 20×, beside the parallel suite it runs past the default 20 s: it has two minutes.
    const batches = Array.from({ length: 4 }, () => ({
      clientId: tab(),
      seq: 1,
      baseRevision: 1,
      ops: Array.from({ length: 500 }, () => createOp(newId('note'), 'x')),
    }))
    stretchSlices(20)
    let compaction: Promise<unknown> | null = null
    try {
      const submits = Promise.all(batches.map((b) => store.submit(user, id, b)))
      let settled = false
      void submits.finally(() => {
        settled = true
      })
      // Every turn until the group is acked: as soon as the new state is out, a compaction that a
      // timer or the hour rule starts (outside the mutex) takes it.
      while (!settled && compaction === null) {
        const h = handle()
        if (h && h.state.board.revision === 5) {
          // As the idle timer or the hour rule starts one: outside the mutex.
          const s = store as unknown as {
            compactInBackground(h: unknown): void
            compactions: Map<string, Promise<unknown>>
          }
          s.compactInBackground(h)
          compaction = s.compactions.get(`${user}/${id}`) ?? Promise.resolve()
        }
        await new Promise((r) => setImmediate(r))
      }
      await submits
      await compaction
    } finally {
      stretchSlices(1)
    }
    expect(compaction).not.toBeNull()
    // The rotated journal holds only commits above the snapshot it names, and the store's count
    // of them is the file's.
    const all = lines(journalOf(id)).map(
      (l) => JSON.parse(l) as { rev?: number; snapshot?: number },
    )
    const base = all.findLast((l) => l.snapshot !== undefined)?.snapshot ?? 0
    const commits = all.filter((l) => l.rev !== undefined)
    for (const c of commits) expect(c.rev).toBeGreaterThan(base)
    expect(handle()?.journal?.commits).toBe(commits.length)
    expect((await store.read(user, id)).state.notes.size).toBe(2001)
  }, 120_000)

  it('one fsynced append per commit group', async () => {
    const id = await newBoard()
    await store.read(user, id)
    const acks = await Promise.all(
      [1, 2, 3].map(() =>
        store.submit(user, id, { clientId: tab(), seq: 1, baseRevision: 0, ops: [createOp()] }),
      ),
    )
    expect(acks.map((a) => a.revision)).toEqual([1, 2, 3])
    expect(store.stats.appends).toBe(1)
    expect(store.stats.snapshots).toBe(0)
    expect(lines(journalOf(id)).map((l) => (JSON.parse(l) as { rev?: number }).rev)).toEqual([
      undefined,
      1,
      2,
      3,
    ])
  })
})

describe('replay', () => {
  it('restart replays the journal above the snapshot revision', async () => {
    const id = await newBoard()
    const t = tab()
    const notes = await commit(id, 3, t)
    // A compaction that dies after the snapshot rename leaves revisions 1-3 in both places.
    await useStore({ faults: throwAt('snapshot:after-dir-fsync') })
    await expect(store.compact(user, id)).rejects.toBeInstanceOf(Boom)
    expect(fileState(id).board.revision).toBe(3)
    expect(lines(journalOf(id))).toHaveLength(1 + 3 + 1) // base, 3 commits, snapshot intent

    await useStore()
    notes.push(...(await commit(id, 2, t, 3)))
    expect(fileState(id).board.revision).toBe(3)

    await useStore()
    const view = await store.read(user, id)
    expect(view.revision).toBe(5)
    expect(view.recovery).toBeNull()
    expect([...view.state.notes.keys()].sort()).toEqual([...notes].sort())
    expect(view.state.board.clients[t]).toMatchObject({ lastSeq: 5, lastRevision: 5 })

    const replayed = await replayJournal(dirOf(id), fileState(id))
    expect(replayed).toMatchObject({ applied: 2, tornTail: false, quarantined: 0 })
    expect(serializeBoard(replayed.state)).toBe(view.text)
  })

  it('journal replay and the compacted snapshot reproduce every rev', async () => {
    const id = await newBoard()
    const t = tab()
    const [a, b, c] = await commit(id, 3, t)
    const yarn: Yarn = {
      type: 'yarn',
      id: newId('yarn'),
      noteIds: [a as string, b as string, c as string],
      color: 'apricot',
      label: '',
      pins: { [b as string]: 'p' },
      createdAt: NOW,
      updatedAt: NOW,
    }
    const more: Op[][] = [
      [{ op: 'yarn.create', yarn }],
      [{ op: 'note.update', id: a as string, set: { text: 'again' } }],
      [{ op: 'note.delete', id: b as string }], // the thread changes with it
    ]
    for (const [i, ops] of more.entries()) {
      await store.submit(user, id, { clientId: t, seq: 4 + i, baseRevision: 3 + i, ops })
    }
    const live = await store.read(user, id)
    expect(live.state.notes.get(a as string)?.rev).toBe(5)
    expect(live.state.notes.get(c as string)?.rev).toBe(3)
    expect(live.state.yarns.get(yarn.id)).toMatchObject({ rev: 6, noteIds: [a, c] })
    expect(live.text).toContain('"rev":6}')

    // Replayed from the journal on a restart: the same records, revs and bytes.
    await useStore()
    expect(fileState(id).board.revision).toBe(0)
    expect((await store.read(user, id)).text).toBe(live.text)
    // Folded into the snapshot: the same again, and it loads back to the same.
    await store.compact(user, id)
    expect(text(boardFileOf(id))).toBe(live.text)
    await useStore()
    expect((await store.read(user, id)).text).toBe(live.text)
  })

  it('a torn last line is ignored and cut before the next append', async () => {
    const id = await newBoard()
    const t = tab()
    await commit(id, 2, t)
    await store.close()
    const whole = encodeCommit({
      rev: 3,
      ops: [createOp()],
      now: NOW,
      origin: { clientId: t, seq: 3 },
    })
    await appendFile(journalOf(id), whole.slice(0, Math.floor(whole.length / 2)))

    store = makeStore()
    const view = await store.read(user, id)
    expect(view.revision).toBe(2)
    expect(view.recovery).toBeNull()
    expect(text(journalOf(id)).endsWith('\n')).toBe(true)
    expect(readdirSync(join(dirOf(id), 'quarantine'))).toEqual([])
    expect(logEntries()).toContainEqual(expect.objectContaining({ msg: 'journal torn tail' }))

    // The next commit lands on a line of its own and survives a restart.
    await commit(id, 1, t, 2)
    await useStore()
    expect((await store.read(user, id)).revision).toBe(3)
    expect(lines(journalOf(id))).toHaveLength(4)
  })

  it('a bad middle line is quarantined and logged; the lines after it still apply', async () => {
    const id = await newBoard()
    const t = tab()
    const notes = await commit(id, 4, t)
    await store.close()
    const all = lines(journalOf(id))
    const bad = (all[2] as string).replace('"note 2"', '"note X"') // crc no longer matches
    await writeFile(journalOf(id), `${[all[0], all[1], bad, all[3], all[4]].join('\n')}\n`)

    store = makeStore()
    const view = await store.read(user, id)
    expect(view.recovery).toMatchObject({
      integrity: 'repaired',
      quarantinedLines: 1,
      journalCommits: 1,
    })
    // Above every revision the journal reached, so no replica mistakes it for one it has seen.
    expect(view.revision).toBe(5)
    expect([...view.state.notes.keys()].sort()).toEqual(
      [notes[0], notes[2], notes[3]].sort() as string[],
    )
    const q = join(dirOf(id), 'quarantine')
    const names = await readdir(q)
    const linesFile = names.find((n) => n.endsWith('-journal-lines.jsonl'))
    expect(linesFile).toBeDefined()
    expect(lines(join(q, linesFile as string)).map((l) => JSON.parse(l).raw)).toEqual([bad])
    expect(names.some((n) => n.endsWith('-journal.jsonl'))).toBe(true)
    expect(logEntries()).toContainEqual(
      expect.objectContaining({ msg: 'board recovered', kind: 'repaired' }),
    )

    // The repaired board is the snapshot now and the journal starts over.
    expect(serializeBoard(fileState(id))).toBe(view.text)
    expect(lines(journalOf(id))).toHaveLength(1)
    await useStore()
    const again = await store.read(user, id)
    expect(again.revision).toBe(5)
    expect(again.text).toBe(view.text)
  })

  it('a board.jsonl edited by hand with a journal present loads as restored; the journal goes to quarantine', async () => {
    const id = await newBoard()
    const t = tab()
    await commit(id, 3, t)
    await store.close()
    const journal = text(journalOf(id))
    const edited = text(boardFileOf(id)).replace('"name":"Board"', '"name":"By hand"')
    const s = parseBoard(edited).state as BoardState
    await writeFile(boardFileOf(id), serializeBoard(s)) // clean, but not the journal's base

    store = makeStore()
    const view = await store.read(user, id)
    expect(view.state.board.name).toBe('By hand')
    expect(view.state.notes.size).toBe(0)
    // The notice counts the commits set aside with the journal.
    expect(view.recovery).toMatchObject({ integrity: 'restored', journalCommits: 3 })
    expect(view.revision).toBe(4)
    const q = join(dirOf(id), 'quarantine')
    const kept = (await readdir(q)).filter((n) => n.endsWith('-journal.jsonl'))
    expect(kept.map((n) => text(join(q, n)))).toEqual([journal])
    expect(logEntries()).toContainEqual(expect.objectContaining({ msg: 'journal quarantined' }))
  })
})

describe('replay: damage at the end and recovery re-runs', () => {
  it('a damaged complete last line is set aside with a notice, never cut silently', async () => {
    const id = await newBoard()
    const t = tab()
    const notes = await commit(id, 3, t)
    await store.close()
    // Newline-terminated, so it may have been acked: its bytes must survive, and the user is told.
    const all = lines(journalOf(id))
    const bad = (all[3] as string).replace('"note 3"', '"note X"')
    await writeFile(journalOf(id), `${[...all.slice(0, 3), bad].join('\n')}\n`)

    store = makeStore()
    const view = await store.read(user, id)
    expect(view.recovery).toMatchObject({
      integrity: 'repaired',
      quarantinedLines: 1,
      journalCommits: 1,
    })
    expect(view.revision).toBe(4) // above the 3 the journal reached
    expect([...view.state.notes.keys()].sort()).toEqual([notes[0], notes[1]].sort() as string[])
    const q = join(dirOf(id), 'quarantine')
    const linesFile = (await readdir(q)).find((n) => n.endsWith('-journal-lines.jsonl'))
    expect(lines(join(q, linesFile as string)).map((l) => JSON.parse(l).raw)).toEqual([bad])
    expect(logEntries()).not.toContainEqual(expect.objectContaining({ msg: 'journal torn tail' }))
  })

  it('complete garbage lines at the end (a crash leaving pages out of order) are set aside too', async () => {
    const id = await newBoard()
    const t = tab()
    await commit(id, 2, t)
    await store.close()
    const whole = encodeCommit({
      rev: 3,
      ops: [createOp()],
      now: NOW,
      origin: { clientId: t, seq: 3 },
    })
    const cut = whole.slice(0, 40)
    const zeros = '\u0000'.repeat(30)
    await appendFile(journalOf(id), `${cut}\n${zeros}\n`)

    store = makeStore()
    const view = await store.read(user, id)
    // Possibly a spurious notice, never a silent loss; above any revision those lines could hold.
    expect(view.revision).toBe(5)
    expect(view.recovery).toMatchObject({
      integrity: 'repaired',
      quarantinedLines: 2,
      journalCommits: 2,
    })
    const q = join(dirOf(id), 'quarantine')
    const linesFile = (await readdir(q)).find((n) => n.endsWith('-journal-lines.jsonl'))
    expect(lines(join(q, linesFile as string)).map((l) => JSON.parse(l).raw)).toEqual([cut, zeros])
  })

  it('a crash in a damaged-journal recovery: the re-run keeps a valid journal and the notice', async () => {
    const id = await newBoard()
    const t = tab()
    const notes = await commit(id, 4, t)
    await store.close()
    const all = lines(journalOf(id))
    const bad = (all[2] as string).replace('"note 2"', '"note X"')
    const torn = encodeCommit({
      rev: 5,
      ops: [createOp()],
      now: NOW,
      origin: { clientId: t, seq: 5 },
    })
    await writeFile(
      journalOf(id),
      `${[all[0], all[1], bad, all[3], all[4]].join('\n')}\n${torn.slice(0, 30)}`,
    )

    // The recovery dies once its snapshot is renamed into place, before the journal rotates.
    store = makeStore({ faults: throwAt('snapshot:after-dir-fsync') })
    await expect(store.read(user, id)).rejects.toMatchObject({ code: 'storage' })
    // The snapshot's base line is a line of its own, not glued to the torn tail.
    const after = lines(journalOf(id))
    expect(JSON.parse(after.at(-1) as string)).toMatchObject({ snapshot: 5 })

    clock.advance(1000)
    logs.length = 0
    await useStore()
    const view = await store.read(user, id)
    expect(view.recovery?.integrity).toBe('repaired')
    expect(logEntries()).not.toContainEqual(expect.objectContaining({ msg: 'journal quarantined' }))
    expect([...view.state.notes.keys()].sort()).toEqual(
      [notes[0], notes[2], notes[3]].sort() as string[],
    )
    expect(lines(journalOf(id))).toHaveLength(1)
  })

  it('a crash before a set-aside journal moves keeps the stronger notice on the re-run', async () => {
    const id = await newBoard()
    await commit(id, 2)
    await store.compact(user, id)
    await commit(id, 1, tab())
    await store.close()
    const damaged = text(boardFileOf(id)).replace('"name":"Board"', '"name":"By hand"')
    await writeFile(boardFileOf(id), damaged) // the eof no longer matches

    store = makeStore({ faults: throwAt('snapshot:after-dir-fsync') })
    await expect(store.read(user, id)).rejects.toMatchObject({ code: 'storage' })
    clock.advance(1000)
    await useStore()
    const view = await store.read(user, id)
    expect(view.recovery).toMatchObject({ integrity: 'checksum-mismatch', journalCommits: 1 })
    expect(view.state.board.name).toBe('By hand')
    expect(existsSync(journalOf(id))).toBe(false)
  })

  it('the quarantined journal keeps the exact bytes it had before the recovery', async () => {
    const id = await newBoard()
    const t = tab()
    await commit(id, 4, t)
    await store.close()
    const all = lines(journalOf(id))
    const bad = (all[2] as string).replace('"note 2"', '"note X"')
    const torn = encodeCommit({
      rev: 5,
      ops: [createOp()],
      now: NOW,
      origin: { clientId: t, seq: 5 },
    })
    // A bad middle line and a torn tail: the recovery cuts the tail and rotates the journal.
    const before = `${[all[0], all[1], bad, all[3], all[4]].join('\n')}\n${torn.slice(0, 30)}`
    await writeFile(journalOf(id), before)

    store = makeStore()
    expect((await store.read(user, id)).recovery).toMatchObject({ integrity: 'repaired' })
    const q = join(dirOf(id), 'quarantine')
    const kept = (await readdir(q)).filter((n) => n.endsWith('-journal.jsonl'))
    expect(kept.map((n) => text(join(q, n)))).toEqual([before])
    expect((await stat(join(q, kept[0] as string))).nlink).toBe(1)
  })

  it('a second recovery while the first notice is up: the newer notice wins, the counts add up', async () => {
    const id = await newBoard()
    const t = tab()
    await commit(id, 2, t)
    await store.compact(user, id)
    await commit(id, 1, t, 2) // in the journal only
    await store.close()
    const edited = text(boardFileOf(id)).replace('"name":"Board"', '"name":"By hand"')
    await writeFile(boardFileOf(id), edited) // the eof no longer matches
    store = makeStore()
    const first = (await store.read(user, id)).recovery
    expect(first).toMatchObject({ integrity: 'checksum-mismatch', journalCommits: 1 })
    const rev = (await store.read(user, id)).revision

    // Not dismissed. Later, a different recovery: a damaged line in the new journal.
    clock.advance(60_000)
    await commit(id, 3, tab(), rev)
    await store.close()
    const all = lines(journalOf(id))
    const bad = (all[2] as string).replace(`"note ${rev + 2}"`, '"note X"')
    await writeFile(journalOf(id), `${[all[0], all[1], bad, all[3]].join('\n')}\n`)
    store = makeStore()
    const second = (await store.read(user, id)).recovery
    expect(second).toMatchObject({
      integrity: 'repaired',
      detectedAt: clock.now().toISOString(),
      quarantinedLines: (first?.quarantinedLines ?? 0) + 1,
      repairs: first?.repairs ?? 0,
      journalCommits: 2,
    })
    expect(second?.preservedAs).not.toBe(first?.preservedAs)
    expect(second?.preservedAs).toMatch(/-board-repaired\.jsonl$/)
    // As stored: a restart shows the same notice.
    await useStore()
    expect((await store.read(user, id)).recovery).toEqual(second)
  })

  it('a recovery that died after its last step is closed by the next load, so a later one is not merged into it', async () => {
    const id = await newBoard() // no journal yet
    await store.close()
    const edited = text(boardFileOf(id)).replace('"name":"Board"', '"name":"By hand"')
    await writeFile(boardFileOf(id), edited) // the eof no longer matches
    // The recovery writes its snapshot, then the process dies: the next load is a clean one.
    store = makeStore({ faults: throwAt('snapshot:after-dir-fsync') })
    await expect(store.read(user, id)).rejects.toMatchObject({ code: 'storage' })
    await useStore()
    const first = await store.read(user, id)
    expect(first.recovery).toMatchObject({ integrity: 'checksum-mismatch' })

    clock.advance(60_000)
    await commit(id, 3, tab(), first.revision)
    await store.close()
    const all = lines(journalOf(id))
    const bad = (all[2] as string).replace(`"note ${first.revision + 2}"`, '"note X"')
    await writeFile(journalOf(id), `${[all[0], all[1], bad, all[3]].join('\n')}\n`)
    store = makeStore()
    expect((await store.read(user, id)).recovery).toMatchObject({
      integrity: 'repaired',
      detectedAt: clock.now().toISOString(),
      journalCommits: 1,
    })
  })

  it('stray tmp files in backups/ are removed on load', async () => {
    const id = await newBoard()
    await store.close()
    await writeFile(join(dirOf(id), 'backups', 'board.20261027T100000Z.r3.jsonl.tmp'), 'half')
    store = makeStore()
    await store.read(user, id)
    expect(readdirSync(join(dirOf(id), 'backups'))).toEqual([])
  })
})

describe('compaction', () => {
  it('thresholds are 4 MiB, 2,000 commits and 60 s idle', () => {
    expect(JOURNAL_MAX_BYTES).toBe(4 * 1_048_576)
    expect(JOURNAL_MAX_COMMITS).toBe(2000)
    expect(COMPACT_IDLE_MS).toBe(60_000)
  })

  it('compaction at thresholds produces a snapshot equal to the state and an empty journal', async () => {
    // Commit count.
    await useStore({ journalMaxCommits: 5 })
    const a = await newBoard()
    await commit(a, 5)
    await vi.waitFor(() => expect(fileState(a).board.revision).toBe(5), { timeout: 5000 })
    expect(serializeBoard(fileState(a))).toBe((await store.read(user, a)).text)
    await vi.waitFor(() => expect(lines(journalOf(a))).toHaveLength(1))
    expect(JSON.parse(lines(journalOf(a))[0] as string)).toMatchObject({
      snapshot: 5,
      sha256: eofSha(text(boardFileOf(a))),
    })

    // Journal bytes.
    await useStore({ journalMaxBytes: 2_000 })
    const b = await newBoard()
    await commit(b, 1, tab())
    expect(fileState(b).board.revision).toBe(0)
    await store.submitServer(user, b, [createOp(newId('note'), 'x'.repeat(2_000))])
    await vi.waitFor(() => expect(fileState(b).board.revision).toBe(2), { timeout: 5000 })
    expect(serializeBoard(fileState(b))).toBe((await store.read(user, b)).text)

    // Idle.
    await useStore({ compactIdleMs: 50 })
    const c = await newBoard()
    await commit(c, 2)
    await vi.waitFor(() => expect(fileState(c).board.revision).toBe(2), { timeout: 5000 })
    await vi.waitFor(() => expect(lines(journalOf(c))).toHaveLength(1))
    expect(serializeBoard(fileState(c))).toBe((await store.read(user, c)).text)
  })

  it('commits made while compaction runs stay in the new journal', async () => {
    const id = await newBoard()
    // A board big enough that serialization spans many slices.
    await store.submitServer(
      user,
      id,
      Array.from({ length: 3_000 }, (_, i) =>
        createOp(newId('note'), `bulk ${i} ${'ễ'.repeat(200)}`),
      ),
    )
    const t = tab()
    const order: string[] = []
    const compacting = store.compact(user, id).then((r) => {
      order.push('compacted')
      return r
    })
    const late = await commit(id, 3, t, 0)
    order.push('acked')
    const result = await compacting
    // All three were acked while the compaction ran, after it took its copy at revision 1.
    expect(order).toEqual(['acked', 'compacted'])
    expect(result.rev).toBe(1)
    expect(fileState(id).board.revision).toBe(1)
    const after = lines(journalOf(id)).map((l) => JSON.parse(l) as { rev?: number })
    expect(after.map((l) => l.rev)).toEqual([undefined, 2, 3, 4])

    await useStore()
    const view = await store.read(user, id)
    expect(view.revision).toBe(4)
    for (const n of late) expect(view.state.notes.has(n)).toBe(true)
  })

  it('a failed compaction changes nothing the next load can see', async () => {
    const id = await newBoard()
    await commit(id, 2)
    const before = (await store.read(user, id)).text
    for (const point of ['snapshot:after-tmp-fsync', 'journal:after-append'] as const) {
      await useStore({ faults: throwAt(point) })
      await expect(store.compact(user, id)).rejects.toBeInstanceOf(Boom)
      await useStore()
      const view = await store.read(user, id)
      expect(view.text).toBe(before)
      expect(view.recovery).toBeNull()
      expect((await readdir(dirOf(id))).filter((n) => n.endsWith('.next'))).toEqual([])
    }
  })

  // Replacing the last name of a 43 MB board.jsonl freed its
  // blocks inside the synchronous rename (12.4 ms on a Raspberry Pi's ext4). A second name taken just
  // before it leaves the rename only a name to take off; the unlink after it frees the blocks.
  it('the old snapshot has a second name for the rename only, and an edit after it still stops the install', async () => {
    const id = await newBoard()
    await commit(id, 2)
    const board = boardFileOf(id)
    const prev = join(dirOf(id), 'board.jsonl.prev')
    const seen: Array<{ same: boolean; links: number }> = []
    let edit = false
    const at: Faults = {
      hit(p) {
        if ((p as string) !== 'snapshot:after-link') return
        const a = statSync(board)
        const b = statSync(prev)
        seen.push({ same: a.ino === b.ino, links: a.nlink })
        // An edit by hand in the gap: its new mtime is what the last look before the rename sees.
        if (edit) utimesSync(board, a.atime, new Date(a.mtimeMs + 5_000))
      },
    }
    await useStore({ faults: at })
    const before = text(board)
    edit = true
    await store.compact(user, id)
    expect(seen).toEqual([{ same: true, links: 2 }])
    // Never renamed over: the edited file is the board's, the journal still holds the commits.
    expect(text(board)).toBe(before)
    expect(fileState(id).board.revision).toBe(0)
    expect(existsSync(prev)).toBe(false)
    expect(statSync(board).nlink).toBe(1)

    // Untouched, the install goes ahead, through the same second name, and leaves none.
    edit = false
    await store.read(user, id)
    await store.compact(user, id)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual({ same: true, links: 2 })
    expect(fileState(id).board.revision).toBe(2)
    expect(existsSync(prev)).toBe(false)
    expect(statSync(board).nlink).toBe(1)
    expect((await readdir(dirOf(id))).filter((n) => /\.(prev|next|tmp)$/.test(n))).toEqual([])
  })

  it('sliced serialization is byte-identical to serializeBoard', async () => {
    const s = hugeState(newId('board'), 5_000)
    const out = await serializeSliced(s, 1)
    const whole = serializeBoard(s)
    expect(out.parts.length).toBeGreaterThan(1)
    expect(out.parts.join('')).toBe(whole)
    expect(out.bytes).toBe(Buffer.byteLength(whole))
    expect(out.sha256).toBe(eofSha(whole))
  })

  it('hourly backups come from compacted snapshots', async () => {
    await useStore({ compactEveryHour: true })
    const id = await newBoard()
    const backups = async () => (await readdir(join(dirOf(id), 'backups'))).sort()
    clock.set('2026-10-27T10:05:00.000Z')
    const t = tab()
    // The hour's first commit compacts at once, and the new snapshot is that hour's backup.
    await commit(id, 1, t)
    await store.compact(user, id)
    expect(await backups()).toEqual(['board.20261027T100500Z.r1.jsonl'])
    await commit(id, 2, t, 1)
    await store.compact(user, id) // same hour: no second backup
    expect(await backups()).toEqual(['board.20261027T100500Z.r1.jsonl'])
    expect(fileState(id).board.revision).toBe(3)

    clock.set('2026-10-27T11:01:00.000Z')
    await commit(id, 1, t, 3)
    await vi.waitFor(
      async () =>
        expect(await backups()).toEqual([
          'board.20261027T100500Z.r1.jsonl',
          'board.20261027T110100Z.r4.jsonl',
        ]),
      { timeout: 5000 },
    )
    // The backup holds the new snapshot's bytes (stale by at most one compaction), in a file of
    // its own: never a link to board.jsonl, which an in-place write would change too.
    const b = join(dirOf(id), 'backups', 'board.20261027T110100Z.r4.jsonl')
    await vi.waitFor(() => expect(fileState(id).board.revision).toBe(4))
    expect((await stat(b)).ino).not.toBe((await stat(boardFileOf(id))).ino)
    expect((await stat(b)).nlink).toBe(1)
    expect(text(b)).toBe(text(boardFileOf(id)))
    expect(parseBoard(text(b)).state?.board.revision).toBe(4)
  })

  it('an in-place write over board.jsonl after an hourly compaction leaves its backup as it was', async () => {
    await useStore({ compactEveryHour: true })
    const id = await newBoard()
    clock.set('2026-10-27T10:05:00.000Z')
    await commit(id, 1)
    await store.compact(user, id) // waits for the hour's compaction: board.jsonl is its snapshot
    const name = 'board.20261027T100500Z.r1.jsonl'
    expect(await readdir(join(dirOf(id), 'backups'))).toEqual([name])
    const snapshot = readFileSync(boardFileOf(id))
    const ino = (await stat(boardFileOf(id))).ino

    // Written through the same inode, as an editor saving in place or damage on disk would.
    const damaged = text(boardFileOf(id)).replace('"name":"Board"', '"name":"By hand"')
    await writeFile(boardFileOf(id), damaged)
    expect((await stat(boardFileOf(id))).ino).toBe(ino)

    const view = await store.read(user, id)
    expect(view.recovery).toMatchObject({
      integrity: 'checksum-mismatch',
      latestBackup: { file: name, revision: 1, notes: 1 },
    })
    // The remedy the notice offers is the snapshot from before the edit, byte for byte.
    expect(readFileSync(join(dirOf(id), 'backups', name))).toEqual(snapshot)
    // The damaged bytes are kept too, in a copy of their own.
    const q = join(dirOf(id), 'quarantine')
    const kept = (await readdir(q)).filter((n) => n.endsWith('-board-checksum-mismatch.jsonl'))
    expect(kept.map((n) => text(join(q, n)))).toEqual([damaged])
    await store.restoreBackup(user, id, name)
    expect((await store.read(user, id)).state.board.name).toBe('Board')
  })

  it('a failing compaction is not retried on every commit', async () => {
    let armed = false
    let attempts = 0
    await useStore({
      journalMaxCommits: 2,
      compactEveryHour: true,
      faults: {
        hit(p) {
          if (!armed || p !== 'snapshot:after-tmp-write') return
          attempts++
          throw new Boom(p) // a full disk, say
        },
      },
    })
    const id = await newBoard()
    armed = true
    await commit(id, 6)
    await store.close() // waits for any compaction in flight
    expect(attempts).toBe(1)
    expect(logEntries().filter((l) => l.msg === 'compaction failed')).toHaveLength(1)
  })

  // A failure that persists: compaction is tried once per backoff window, also after the failure
  // evicted the handle (the next commit reloads the board).
  it.each([
    ['writing the snapshot fails (a full disk)', 'snapshot:after-tmp-write'],
    ['the install fails after its rename, evicting the handle', 'snapshot:after-rename'],
  ] as const)('a failing compaction is tried once per backoff window: %s', async (_, point) => {
    let armed = false
    await useStore({
      compactEveryHour: true,
      journalMaxCommits: 1, // every commit asks for a compaction
      faults: {
        hit(p) {
          if (armed && p === point) throw new Boom(p)
        },
      },
    })
    clock.set('2026-10-27T10:05:00.000Z')
    const id = await newBoard()
    const backups = join(dirOf(id), 'backups')
    const failures = () => logEntries().filter((l) => l.msg === 'compaction failed')
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50))
    const t = tab()
    const code = 'Error'
    armed = true
    try {
      await commit(id, 1, t)
      await vi.waitFor(() => expect(failures()).toHaveLength(1))
      expect(failures()[0]).toMatchObject({ code })
      for (let i = 1; i < 5; i++) {
        await commit(id, 1, t, i)
        await pause()
      }
      expect(failures()).toHaveLength(1)

      clock.advance(3_600_000) // the store's compactIdleMs: the backoff window
      await commit(id, 1, t, 5)
      await vi.waitFor(() => expect(failures()).toHaveLength(2))
      for (let i = 6; i < 9; i++) {
        await commit(id, 1, t, i)
        await pause()
      }
      await store.close() // waits for any compaction in flight
      expect(failures()).toHaveLength(2)
    } finally {
      armed = false
    }
    // Nothing acked was lost on the way, and no backup tmp file is left behind.
    await useStore()
    expect((await store.read(user, id)).revision).toBe(9)
    expect(readdirSync(backups).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
  it('a backups/ that cannot be written never blocks compaction; one warning per backoff window', async () => {
    await useStore({ compactEveryHour: true })
    clock.set('2026-10-27T10:05:00.000Z')
    const id = await newBoard()
    const backups = join(dirOf(id), 'backups')
    const warnings = () => logEntries().filter((l) => l.msg === 'backup failed')
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50))
    const t = tab()
    await chmod(backups, 0o500) // EACCES on every write into it
    try {
      // The hour's first commit compacts: it installs without the backup, the journal starts over.
      await commit(id, 1, t)
      await vi.waitFor(() => expect(fileState(id).board.revision).toBe(1))
      await vi.waitFor(() => expect(lines(journalOf(id))).toHaveLength(1))
      expect(warnings()).toEqual([expect.objectContaining({ level: 'warn', code: 'EACCES' })])
      expect(logEntries().filter((l) => l.msg === 'compaction failed')).toEqual([])
      // The hour still has no backup, but within the window the hour rule asks for no compaction.
      for (let i = 1; i < 4; i++) {
        await commit(id, 1, t, i)
        await pause()
      }
      expect(fileState(id).board.revision).toBe(1)
      expect(warnings()).toHaveLength(1)

      clock.advance(3_600_000) // the store's compactIdleMs: the backoff window
      await commit(id, 1, t, 4)
      await vi.waitFor(() => expect(warnings()).toHaveLength(2))
      await vi.waitFor(() => expect(fileState(id).board.revision).toBe(5))
    } finally {
      await chmod(backups, 0o700)
    }
    expect(readdirSync(backups)).toEqual([])
    // Writable again: the next due compaction takes the backup it missed. Its backup is written
    // as `<name>.compact.tmp` first and renamed in place: wait for the final name, not for any
    // one entry (a slow machine shows the tmp file for a while).
    clock.advance(3_600_000)
    await commit(id, 1, t, 5)
    await vi.waitFor(
      () => expect(readdirSync(backups)).toEqual([expect.stringMatching(/\.r6\.jsonl$/)]),
      {
        timeout: 10_000,
      },
    )
    expect(warnings()).toHaveLength(2)
  })

  it('the hourly backup a compaction writes outside the mutex has a tmp name of its own', async () => {
    const id = await newBoard()
    await commit(id, 1)
    const now = clock.now()
    const source = { parts: ['x\n'], bytes: 2 }
    const b = await prepareHourlyBackup(dirOf(id), now, 1, source, noFaults)
    expect(b?.tmp).toBe(join(dirOf(id), 'backups', `${backupName(now, 1)}.compact.tmp`))
    // A leftover one is swept on load like any other tmp file.
    await store.close()
    store = makeStore()
    await store.read(user, id)
    expect(readdirSync(join(dirOf(id), 'backups'))).toEqual([])
  })
})

describe('restore', () => {
  it('a restore with commits in the journal backs up the current board and starts the journal over', async () => {
    const id = await newBoard()
    clock.set('2026-10-27T10:05:00.000Z')
    const t = tab()
    await commit(id, 2, t)
    await store.compact(user, id) // backs up the new snapshot, revision 2
    const notes = await commit(id, 2, t, 2) // revisions 3-4, in the journal only
    const current = (await store.read(user, id)).text

    clock.set('2026-10-27T10:30:00.000Z')
    const r = await store.restoreBackup(user, id, 'board.20261027T100500Z.r2.jsonl')
    expect(r).toEqual({ revision: 5, safetyBackup: 'board.20261027T103000Z.r4.jsonl' })
    // The safety backup is the board at revision 4, journal and all, not the older board.jsonl.
    const safety = text(join(dirOf(id), 'backups', r.safetyBackup))
    expect(safety).toBe(current)
    expect(parseBoard(safety).state?.notes.has(notes[1] as string)).toBe(true)

    expect(fileState(id).board.revision).toBe(5)
    expect(fileState(id).notes.size).toBe(2) // the backup's two notes
    expect(lines(journalOf(id))).toHaveLength(1)
    await useStore()
    const view = await store.read(user, id)
    expect(view.revision).toBe(5)
    expect(view.state.notes.size).toBe(2)
    expect(view.recovery?.integrity).toBe('restored')
  })

  for (const point of ['restore:after-intent', 'journal:after-append'] as const) {
    it(`a restore cut short (${point}) says so: the board as it was, never "restored"`, async () => {
      const id = await newBoard()
      clock.set('2026-10-27T10:05:00.000Z')
      const t = tab()
      await commit(id, 2, t)
      await store.compact(user, id) // backs up revision 2
      await commit(id, 2, t, 2)
      const current = (await store.read(user, id)).state

      // A failed write (ENOSPC, EIO) between the marker and the new snapshot.
      await useStore({ faults: throwAt(point) })
      await expect(
        store.restoreBackup(user, id, 'board.20261027T100500Z.r2.jsonl'),
      ).rejects.toMatchObject({ code: 'storage' })
      expect(existsSync(join(dirOf(id), 'restore.json'))).toBe(true)

      clock.advance(1000)
      await useStore()
      const view = await store.read(user, id)
      expect(view.revision).toBeGreaterThan(4)
      expect(view.recovery).toEqual({
        integrity: 'restore-interrupted',
        detectedAt: clock.now().toISOString(),
        preservedAs: null,
        quarantinedLines: 0,
        repairs: 0,
        latestBackup: null,
      })
      expect([...view.state.notes.keys()].sort()).toEqual([...current.notes.keys()].sort())
      expect(existsSync(join(dirOf(id), 'restore.json'))).toBe(false)

      // Settled: the next start loads it as it is.
      await useStore()
      const again = await store.read(user, id)
      expect(again.revision).toBe(view.revision)
      expect(again.recovery).toEqual(view.recovery)
    })
  }

  it('a restore whose snapshot is in but whose last step fails is restored all the same', async () => {
    const id = await newBoard()
    clock.set('2026-10-27T10:05:00.000Z')
    const t = tab()
    await commit(id, 2, t)
    await store.compact(user, id)
    await commit(id, 2, t, 2)

    clock.set('2026-10-27T10:30:00.000Z')
    await useStore({ faults: throwAt('journal:after-rotate') })
    await expect(
      store.restoreBackup(user, id, 'board.20261027T100500Z.r2.jsonl'),
    ).rejects.toMatchObject({ code: 'storage' })
    await useStore()
    const view = await store.read(user, id)
    expect(view.revision).toBe(5)
    expect(view.state.notes.size).toBe(2)
    expect(view.recovery).toMatchObject({
      integrity: 'restored',
      detectedAt: '2026-10-27T10:30:00.000Z',
      latestBackup: { file: 'board.20261027T103000Z.r4.jsonl', revision: 4, notes: 4 },
    })
    expect(existsSync(join(dirOf(id), 'restore.json'))).toBe(false)
  })

  it('a finished restore leaves no marker, and dismissing its notice keeps it dismissed', async () => {
    const id = await newBoard()
    clock.set('2026-10-27T10:05:00.000Z')
    await commit(id, 2)
    await store.compact(user, id)
    await store.restoreBackup(user, id, 'board.20261027T100500Z.r2.jsonl')
    expect(existsSync(join(dirOf(id), 'restore.json'))).toBe(false)
    expect((await store.read(user, id)).recovery?.integrity).toBe('restored')
    await store.dismissRecovery(user, id)
    await useStore()
    expect((await store.read(user, id)).recovery).toBeNull()
  })
})

// ---- 100,000 notes --------------------------------------------------------------------------
// How long each holds the event loop, here and on a CPU `PI`× slower, is the timing rows'
// (`journal.timing.test.ts`).

describe('compaction at 100,000 notes', () => {
  it('compaction never blocks the event loop for more than 50 ms on a 100,000-note board', async () => {
    const id = await newBoard()
    // 99,999 notes, and the commit in the journal makes 100,000 (the limit).
    await writeFile(boardFileOf(id), serializeBoard(hugeState(id, 99_999)))
    expect((await store.read(user, id)).state.notes.size).toBe(99_999)
    await commit(id, 1)
    const result = await store.compact(user, id)
    expect(result.rev).toBe(1)
    expect(fileState(id).notes.size).toBe(100_000)
  }, 300_000)

  it("large batches committed while a compaction runs (the bench's fill): no iteration over 50 ms on a CPU 8× slower", async () => {
    const id = await newBoard()
    const state = hugeState(id, 99_999)
    await writeFile(boardFileOf(id), serializeBoard(state))
    expect((await store.read(user, id)).state.notes.size).toBe(99_999)
    await commit(id, 1)
    const notes = [...state.notes.keys()]
    const long = 'ễ'.repeat(600)
    const t0 = tab()
    const compaction = store.compact(user, id)
    // Eight batches of 400 notes rewritten, as a seeding run fills the journal: each one
    // commit (validated, applied, journaled and acked as a whole).
    for (let b = 0; b < 8; b++) {
      await store.submit(user, id, {
        clientId: t0,
        seq: b + 1,
        baseRevision: 1 + b,
        ops: notes
          .slice(b * 400, (b + 1) * 400)
          .map((n, i) => ({ op: 'note.update', id: n, set: { text: `${long}${i}` } })),
      })
    }
    expect((await compaction).rev).toBe(1)
    // Every batch is in, live and after a restart (the journal passed 4 MiB with them, so a second
    // compaction may have folded them in by then).
    const check = (view: Awaited<ReturnType<typeof store.read>>) => {
      expect(view.revision).toBe(9)
      for (let i = 0; i < 3200; i++) {
        expect(view.state.notes.get(notes[i] as string)?.text).toBe(`${long}${i % 400}`)
      }
      expect(view.state.notes.get(notes[3200] as string)?.text).not.toContain(long)
    }
    check(await store.read(user, id))
    await useStore()
    check(await store.read(user, id))
  }, 300_000)

  // Stretched, 5×; counted, a Raspberry Pi's 8×.
  for (const [how, stretched, pi] of [
    ['every slice stretched 5×', true, 5],
    ['the rest, slice overruns and every GC pause counted 8×', false, PI],
  ] as const)
    it(`on a slower CPU too (${how}): no iteration over 50 ms`, async () => {
      const id = await newBoard()
      await writeFile(boardFileOf(id), serializeBoard(hugeState(id, 99_999)))
      expect((await store.read(user, id)).state.notes.size).toBe(99_999)
      await commit(id, 1)
      if (stretched) stretchSlices(pi)
      let result: Awaited<ReturnType<typeof store.compact>>
      try {
        result = await store.compact(user, id)
      } finally {
        stretchSlices(1)
      }
      expect(result.rev).toBe(1)
      expect(fileState(id).notes.size).toBe(100_000)
    }, 300_000)
})

describe('the commit ring', () => {
  it('counts an event the same whether it stringifies the ops or is told their size', async () => {
    const { CommitRing } = await import('../src/store/ring')
    const ops = Array.from({ length: 5 }, (_, i) => createOp(newId('note'), `n ${i} Kết 😀`))
    const event = { revision: 3, ops, originClientId: null, seq: null, now: NOW }
    const opsBytes = Buffer.byteLength(JSON.stringify(ops)) - 2
    const whole = Buffer.byteLength(JSON.stringify(event))
    // A ring that holds exactly one such event: a second one (counted either way) drops the first.
    for (const told of [undefined, opsBytes]) {
      const ring = new CommitRing(10, whole)
      ring.push(event, told)
      expect(ring.since(2, 3)).toHaveLength(1)
      ring.push({ ...event, revision: 4 }, told)
      expect(ring.since(3, 4)).toHaveLength(1)
      expect(ring.since(2, 4)).toBeNull()
    }
  })
})
