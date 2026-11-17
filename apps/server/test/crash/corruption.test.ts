import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type BoardState, newId, parseBoard, serializeBoard } from '@papertie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { noteCreate, storedBoard } from '../helpers/boards'
import {
  boardDirOf,
  createBoard,
  createUser,
  getBoard,
  postOps,
  type ServerChild,
  spawnServer,
  type User,
} from './serverChild'

/**
 * Damaged boards on disk, loaded by a real server child and checked over HTTP as their owner.
 * One board per case; every board is damaged while the server is stopped.
 */

const CASES = ['truncated', 'garbage', 'dangling', 'unsupported', 'strayTmp'] as const
type Case = (typeof CASES)[number]

const GARBAGE = ['not json', '{"type":"sticker"}', '{"type":"note","id":"bad"}']

let root: string
let dataDir: string
let server: ServerChild
let user: User
const boards = {} as Record<Case, { id: string; dir: string; original: string; damaged: string }>
let droppedNoteId: string

const read = (path: string) => readFile(path, 'utf8')
const listDir = async (dir: string) => {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}
const jsonLines = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)

/** The board as user A gets it over HTTP. */
async function load(c: Case) {
  const res = await getBoard(server, user, boards[c].id)
  const text = await res.text()
  return { res, text }
}

function stateOf(text: string): BoardState {
  const r = parseBoard(text)
  if (!r.state) throw new Error('served board does not parse')
  expect(r.integrity).toBe('ok')
  expect(r.issues).toEqual([])
  return r.state
}

/** Raw texts in `quarantine/*-lines.jsonl` (the whole-file copies are not counted). */
async function quarantinedRaws(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const name of await listDir(join(dir, 'quarantine'))) {
    if (!name.endsWith('-lines.jsonl')) continue
    for (const entry of jsonLines(await read(join(dir, 'quarantine', name)))) {
      out.push(entry.raw as string)
    }
  }
  return out
}

async function repairRaws(dir: string): Promise<string[]> {
  try {
    return jsonLines(await read(join(dir, 'repairs.jsonl'))).map((e) => e.raw as string)
  } catch {
    return []
  }
}

/** Damage `original` (4 notes and a 3-note yarn) as each case needs. */
function damage(c: Case, original: string): string {
  const lines = original.split('\n')
  switch (c) {
    case 'truncated': {
      // board + 2 complete notes + half of the third; no eof.
      const third = lines[3] as string
      return [...lines.slice(0, 3), third.slice(0, Math.floor(third.length / 2))].join('\n')
    }
    case 'garbage':
      return [...lines.slice(0, 3), ...GARBAGE, ...lines.slice(3)].join('\n')
    case 'dangling': {
      // A consistent file (valid eof) whose yarn names a note that is not there.
      const state = parseBoard(original).state as BoardState
      const yarn = [...state.yarns.values()][0]
      droppedNoteId = yarn?.noteIds[1] as string
      const notes = new Map(state.notes)
      notes.delete(droppedNoteId)
      return serializeBoard({ ...state, notes })
    }
    case 'unsupported':
      return original.replace('"schemaVersion":6', '"schemaVersion":7')
    case 'strayTmp':
      return original
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'papertie-corrupt-'))
  dataDir = join(root, 'data')
  server = await spawnServer(dataDir)
  user = await createUser(server)
  const at = new Date().toISOString()
  for (const c of CASES) {
    const id = await createBoard(server, user, `Board ${c}`)
    const noteIds = [newId('note'), newId('note'), newId('note'), newId('note')]
    const res = await postOps(server, user, id, {
      clientId: newId('tab'),
      seq: 1,
      baseRevision: 0,
      ops: [
        ...noteIds.map((nid, i) => noteCreate({ id: nid, text: `note ${i}`, at })),
        {
          op: 'yarn.create',
          yarn: {
            type: 'yarn',
            id: newId('yarn'),
            noteIds: noteIds.slice(0, 3),
            color: 'apricot',
            label: 'thread',
            createdAt: at,
            updatedAt: at,
          },
        },
      ],
    })
    expect(res.status).toBe(200)
    boards[c] = { id, dir: boardDirOf(dataDir, user, id), original: '', damaged: '' }
  }
  await server.stop()
  // These cases damage a snapshot: fold each journal into board.jsonl first (a board with no
  // journal, as one loads after a compaction, or from before the journal existed).
  for (const c of CASES) {
    const b = boards[c]
    b.original = storedBoard(b.dir).toString('utf8')
    await writeFile(join(b.dir, 'board.jsonl'), b.original, { mode: 0o600 })
    await rm(join(b.dir, 'journal.jsonl'))
  }

  for (const c of CASES) {
    const b = boards[c]
    b.damaged = damage(c, b.original)
    await writeFile(join(b.dir, 'board.jsonl'), b.damaged, { mode: 0o600 })
  }
  await writeFile(join(boards.strayTmp.dir, 'board.jsonl.tmp'), '{"type":"board","na', {
    mode: 0o600,
  })
  server = await spawnServer(dataDir)
}, 60_000)

afterAll(async () => {
  await server?.stop()
  await rm(root, { recursive: true, force: true })
})

describe('corrupted boards over HTTP', () => {
  it('truncated mid-line: recovered, partial line and whole file quarantined', async () => {
    const b = boards.truncated
    const { res, text } = await load('truncated')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Papertie-Recovered')).toBe('1')

    const partial = b.damaged.split('\n').at(-1) as string
    expect(await quarantinedRaws(b.dir)).toEqual([partial])
    const copies = (await listDir(join(b.dir, 'quarantine'))).filter((n) =>
      n.endsWith('-board-missing-eof.jsonl'),
    )
    expect(copies).toHaveLength(1)
    expect(await readFile(join(b.dir, 'quarantine', copies[0] as string))).toEqual(
      Buffer.from(b.damaged),
    )
    const completeNotes = b.damaged
      .split('\n')
      .slice(0, -1)
      .filter((l) => l.includes('"type":"note"')).length
    expect(completeNotes).toBe(2)
    expect(stateOf(text).notes.size).toBe(completeNotes)
  })

  it('garbage lines: each raw line quarantined, the valid records load', async () => {
    const b = boards.garbage
    const { res, text } = await load('garbage')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Papertie-Recovered')).toBe('1')
    expect((await quarantinedRaws(b.dir)).sort()).toEqual([...GARBAGE].sort())
    const loaded = stateOf(text)
    const original = parseBoard(b.original).state as BoardState
    expect([...loaded.notes.values()]).toEqual([...original.notes.values()])
    expect([...loaded.yarns.values()]).toEqual([...original.yarns.values()])
  })

  it('dangling yarn: the original yarn is in repairs.jsonl and the thread is repaired', async () => {
    const b = boards.dangling
    const { res, text } = await load('dangling')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Papertie-Recovered')).toBe('1')
    const originalYarn = [...(parseBoard(b.original).state as BoardState).yarns.values()][0]
    const repairs = await repairRaws(b.dir)
    expect(repairs.map((r) => JSON.parse(r))).toEqual([originalYarn])
    const yarns = [...stateOf(text).yarns.values()]
    expect(yarns).toHaveLength(1)
    expect(yarns[0]?.noteIds).toEqual(originalYarn?.noteIds.filter((id) => id !== droppedNoteId))
  })

  it('unsupported version: 409, and the bytes survive a restart and a POST untouched', async () => {
    const b = boards.unsupported
    const before = await listDir(b.dir)
    const res = await getBoard(server, user, b.id)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'board-unreadable', reason: 'unsupported-version' })
    expect(await readFile(join(b.dir, 'board.jsonl'))).toEqual(Buffer.from(b.damaged))

    await server.stop()
    server = await spawnServer(dataDir)
    const post = await postOps(server, user, b.id, {
      clientId: newId('tab'),
      seq: 1,
      baseRevision: 0,
      ops: [noteCreate({ at: new Date().toISOString() })],
    })
    expect(post.status).toBe(409)
    expect(await post.json()).toEqual({ error: 'board-unreadable', reason: 'unsupported-version' })
    expect(await readFile(join(b.dir, 'board.jsonl'))).toEqual(Buffer.from(b.damaged))
    expect(await listDir(b.dir)).toEqual(before)
    expect(await listDir(join(b.dir, 'quarantine'))).toEqual([])
  })

  it('stray tmp: removed on load, the board loads clean', async () => {
    const b = boards.strayTmp
    const { res, text } = await load('strayTmp')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Papertie-Recovered')).toBeNull()
    expect(await listDir(b.dir)).not.toContain('board.jsonl.tmp')
    expect(await listDir(join(b.dir, 'quarantine'))).toEqual([])
    expect(text).toBe(b.original)
  })

  it('never silently dropped: every damaged line is loaded, quarantined or in repairs', async () => {
    for (const c of ['truncated', 'garbage', 'dangling', 'strayTmp'] as const) {
      const b = boards[c]
      const { res, text } = await load(c)
      expect(res.status).toBe(200)
      const state = stateOf(text)
      const kept = new Set([...(await quarantinedRaws(b.dir)), ...(await repairRaws(b.dir))])
      const records = [...state.assets.values(), ...state.notes.values(), ...state.yarns.values()]
      for (const line of b.damaged.split('\n')) {
        if (line.trim() === '' || kept.has(line)) continue
        const rec = JSON.parse(line) as Record<string, unknown>
        if (rec.type === 'eof') continue // a checksum over the lines, not content
        if (rec.type === 'board') {
          // Recovery only moves the revision (and updatedAt) forward.
          const { revision: _r, updatedAt: _u, ...rest } = rec
          const { revision: _r2, updatedAt: _u2, ...loaded } = state.board
          expect(loaded, `${c}: board line`).toEqual(rest)
          continue
        }
        expect(
          records.some((r) => isDeepStrictEqual(r, rec)),
          `${c}: line neither loaded nor kept: ${line}`,
        ).toBe(true)
      }
    }
    // The unreadable board kept every byte.
    expect(await read(join(boards.unsupported.dir, 'board.jsonl'))).toBe(boards.unsupported.damaged)
  })
})
