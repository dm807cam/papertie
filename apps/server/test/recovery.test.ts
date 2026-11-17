import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BoardState,
  newId,
  parseBoard,
  serializeBoard,
  stateFromRecords,
} from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serverId } from '../src/ids'
import { createLogger } from '../src/log'
import { backupName } from '../src/store/backups'
import {
  clearRecovery,
  loadBoardDir,
  readRecovery,
  snapshotRefOf,
  writeSnapshot,
} from '../src/store/boardFile'
import { BoardStore } from '../src/store/boardStore'
import { StoreError } from '../src/store/errors'
import { type Faults, noFaults } from '../src/store/faults'
import { FakeClock } from './helpers/clock'

const T = '2026-10-27T09:00:00.000Z'
const NOW = '2026-10-27T10:00:00.000Z'
const TS = '20261027T100000000Z'

let dir: string
let clock: FakeClock
let logs: string[]
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'papertie-recovery-'))
  clock = new FakeClock(NOW)
  logs = []
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const deps = (faults: Faults = noFaults) => ({
  clock,
  log: createLogger((l) => logs.push(l)),
  faults,
})

interface Fixture {
  state: BoardState
  text: string
  noteIds: string[]
  yarnId: string
  assetId: string
}

/** 3 notes (the first with an image), 1 asset, a 3-note yarn, revision 7. */
function fixture(): Fixture {
  const boardId = newId('board')
  const assetId = newId('asset')
  const noteIds = [newId('note'), newId('note'), newId('note')]
  const yarnId = newId('yarn')
  const note = (id: string, i: number) => ({
    type: 'note' as const,
    id,
    x: i * 300,
    y: 0,
    w: 240,
    h: 160,
    z: i,
    paper: 'cream' as const,
    style: 'rustic' as const,
    text: `note number ${i} with some text`,
    image: i === 0 ? { assetId, frame: 'none' as const } : null,
    createdAt: T,
    updatedAt: T,
  })
  const state = stateFromRecords(
    {
      type: 'board',
      schemaVersion: 6,
      id: boardId,
      name: 'Fixture board',
      revision: 7,
      clients: {},
      createdAt: T,
      updatedAt: T,
    },
    [
      {
        type: 'asset',
        id: assetId,
        mime: 'image/webp',
        width: 800,
        height: 600,
        bytes: 1234,
        sha256: 'a'.repeat(64),
        createdAt: T,
      },
      ...noteIds.map(note),
      {
        type: 'yarn',
        id: yarnId,
        noteIds,
        color: 'apricot',
        label: 'thread',
        createdAt: T,
        updatedAt: T,
      },
    ],
  )
  return { state, text: serializeBoard(state), noteIds, yarnId, assetId }
}

const boardPath = () => join(dir, 'board.jsonl')
const put = (name: string, data: string) => writeFile(join(dir, name), data, { mode: 0o600 })

async function putBackup(state: BoardState, when = '2026-10-27T08:00:00Z'): Promise<string> {
  await mkdir(join(dir, 'backups'), { recursive: true })
  const name = backupName(new Date(when), state.board.revision)
  await writeFile(join(dir, 'backups', name), serializeBoard(state))
  return name
}

/** Recursive listing of names and sizes, sorted. */
async function listing(root: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      out.push(`${p}/`, ...(await listing(root, p)))
    } else {
      out.push(`${p} ${(await stat(join(root, p))).size}`)
    }
  }
  return out.sort()
}

const quarantined = async () => {
  try {
    return (await readdir(join(dir, 'quarantine'))).sort()
  } catch {
    return []
  }
}
const jsonLines = (text: string) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

function ok(o: Awaited<ReturnType<typeof loadBoardDir>>) {
  if (o.kind !== 'ok') throw new Error(`expected ok, got ${o.kind}`)
  return o
}

describe('clean boards', () => {
  it('loads untouched: no quarantine, no recovery.json, bytes unchanged', async () => {
    const f = fixture()
    await put('board.jsonl', f.text)
    const before = await listing(dir)

    const o = ok(await loadBoardDir(dir, deps()))
    expect(o.recovery).toBeNull()
    expect(o.recoveredNow).toBe(false)
    expect(serializeBoard(o.state)).toBe(f.text)
    expect(o.snapshot).toMatchObject({ ...snapshotRefOf(f.text), revision: 7 })
    expect(o.journal).toBeNull()
    expect(o.state.board.revision).toBe(7)
    expect(o.state.notes.size).toBe(3)
    expect(o.snapshot.stamp.size).toBe(Buffer.byteLength(f.text))
    expect(await quarantined()).toEqual([])
    expect(await listing(dir)).toEqual(before)
    expect(await readFile(boardPath(), 'utf8')).toBe(f.text)
  })

  it('removes stray tmp files and logs only a count', async () => {
    const f = fixture()
    await put('board.jsonl', f.text)
    await put('board.jsonl.tmp', 'half a snapshot')
    const adir = join(dir, 'assets', f.assetId)
    await mkdir(adir, { recursive: true })
    await writeFile(join(adir, '1024.webp.tmp'), 'half an image')
    await writeFile(join(adir, '2560.webp'), 'a finished image')

    ok(await loadBoardDir(dir, deps()))
    expect(await listing(dir)).toEqual([
      'assets/',
      `assets/${f.assetId}/`,
      `assets/${f.assetId}/2560.webp 16`,
      `board.jsonl ${Buffer.byteLength(f.text)}`,
    ])
    const line = logs.find((l) => l.includes('stray'))
    expect(JSON.parse(line as string)).toEqual({
      level: 'info',
      msg: 'removed stray tmp files',
      count: 2,
    })
  })

  // A compaction names the snapshot it replaces board.jsonl.prev
  // (a hard link) for its rename; killed before it takes that name off again, the next load does.
  it('removes the second name a compaction killed mid-install left on the old snapshot', async () => {
    const f = fixture()
    await put('board.jsonl', f.text)
    await link(boardPath(), join(dir, 'board.jsonl.prev'))
    ok(await loadBoardDir(dir, deps()))
    expect(await listing(dir)).toEqual([`board.jsonl ${Buffer.byteLength(f.text)}`])
    expect((await stat(boardPath())).nlink).toBe(1)
    expect(await readFile(boardPath(), 'utf8')).toBe(f.text)
    const line = logs.find((l) => l.includes('stray'))
    expect(JSON.parse(line as string)).toEqual({
      level: 'info',
      msg: 'removed stray tmp files',
      count: 1,
    })
  })

  it('logs unreferenced asset dirs as orphan-asset by count only and deletes nothing', async () => {
    const f = fixture()
    await put('board.jsonl', f.text)
    const orphans = [newId('asset'), newId('asset')]
    for (const id of [f.assetId, ...orphans]) {
      await mkdir(join(dir, 'assets', id), { recursive: true })
      await writeFile(join(dir, 'assets', id, '256.webp'), 'image')
    }
    const before = await listing(dir)

    ok(await loadBoardDir(dir, deps()))
    expect(await listing(dir)).toEqual(before)
    const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.filter((l) => l.kind === 'orphan-asset')).toEqual([
      { level: 'warn', msg: 'orphan assets', kind: 'orphan-asset', count: 2 },
    ])
    expect(logs.join('\n')).not.toContain('asset_')
  })

  it('logs no orphan-asset line when every asset dir is referenced', async () => {
    const f = fixture()
    await put('board.jsonl', f.text)
    await mkdir(join(dir, 'assets', f.assetId), { recursive: true })
    ok(await loadBoardDir(dir, deps()))
    expect(logs.join('\n')).not.toContain('orphan')
  })

  it('reports absent for a missing dir and for an empty dir, creating nothing', async () => {
    expect(await loadBoardDir(join(dir, 'nope'), deps())).toEqual({ kind: 'absent' })
    expect(await loadBoardDir(dir, deps())).toEqual({ kind: 'absent' })
    expect(await readdir(dir)).toEqual([])
  })
})

describe('recovery', () => {
  it('truncated mid third note: preserves the file, quarantines the partial line, bumps the revision', async () => {
    const f = fixture()
    const lines = f.text.split('\n')
    const third = lines.findIndex((l) => l.includes(f.noteIds[2] as string))
    const cut = (lines[third] as string).slice(0, 40)
    const damaged = [...lines.slice(0, third), cut].join('\n')
    await put('board.jsonl', damaged)

    const o = ok(await loadBoardDir(dir, deps()))
    expect(o.recoveredNow).toBe(true)
    expect(o.recovery).toMatchObject({
      integrity: 'missing-eof',
      detectedAt: NOW,
      preservedAs: `${TS}-board-missing-eof.jsonl`,
      quarantinedLines: 1,
      repairs: 0,
      latestBackup: null,
    })

    expect(await quarantined()).toEqual([`${TS}-board-missing-eof.jsonl`, `${TS}-lines.jsonl`])
    expect(await readFile(join(dir, 'quarantine', `${TS}-board-missing-eof.jsonl`), 'utf8')).toBe(
      damaged,
    )
    const [issue] = jsonLines(await readFile(join(dir, 'quarantine', `${TS}-lines.jsonl`), 'utf8'))
    expect(issue).toMatchObject({ line: third + 1, kind: 'invalid-json', raw: cut })

    const reparsed = parseBoard(await readFile(boardPath(), 'utf8'))
    expect(reparsed.integrity).toBe('ok')
    expect(reparsed.issues).toEqual([])
    expect(reparsed.state?.board.revision).toBe(8)
    expect([...(reparsed.state?.notes.keys() ?? [])].sort()).toEqual(
      [f.noteIds[0], f.noteIds[1]].sort(),
    )
    expect(serializeBoard(o.state)).toBe(await readFile(boardPath(), 'utf8'))
    expect(await readRecovery(dir)).toEqual(o.recovery)
  })

  it('garbage line inserted: quarantined as invalid-json with the integrity parseBoard reports', async () => {
    const f = fixture()
    const lines = f.text.split('\n')
    lines.splice(2, 0, 'this is not json {')
    const damaged = lines.join('\n')
    await put('board.jsonl', damaged)
    const expected = parseBoard(damaged).integrity
    expect(['checksum-mismatch', 'count-mismatch']).toContain(expected)

    const o = ok(await loadBoardDir(dir, deps()))
    expect(o.recovery?.integrity).toBe(expected)
    expect(o.recovery?.quarantinedLines).toBe(1)
    expect(o.state.notes.size).toBe(3)
    expect(o.state.yarns.size).toBe(1)
    const [issue] = jsonLines(await readFile(join(dir, 'quarantine', `${TS}-lines.jsonl`), 'utf8'))
    expect(issue).toMatchObject({ line: 3, kind: 'invalid-json', raw: 'this is not json {' })
    expect(await readFile(join(dir, 'quarantine', `${TS}-board-${expected}.jsonl`), 'utf8')).toBe(
      damaged,
    )
  })

  it('dangling yarn reference: logged in repairs.jsonl with the original yarn, loaded without it', async () => {
    const f = fixture()
    const [a, b] = f.noteIds as [string, string]
    const ghost = newId('note')
    const yarn = f.state.yarns.get(f.yarnId)
    if (!yarn) throw new Error('fixture yarn')
    const original = { ...yarn, noteIds: [a, b, ghost] }
    const withGhost: BoardState = {
      ...f.state,
      yarns: new Map([[f.yarnId, original]]),
    }
    await put('board.jsonl', serializeBoard(withGhost))

    const o = ok(await loadBoardDir(dir, deps()))
    expect(o.recovery).toMatchObject({
      integrity: 'repaired',
      quarantinedLines: 0,
      repairs: 1,
    })
    expect(o.state.yarns.get(f.yarnId)?.noteIds).toEqual([a, b])

    const repairs = jsonLines(await readFile(join(dir, 'repairs.jsonl'), 'utf8'))
    expect(repairs).toHaveLength(1)
    expect(repairs[0]?.at).toBe(NOW)
    expect(repairs[0]?.raw).toBe(JSON.stringify(original))
    expect(JSON.parse(repairs[0]?.raw as string).noteIds).toEqual([a, b, ghost])
    // No lines were rejected, so there is no lines file; the original is still preserved whole.
    expect(await quarantined()).toEqual([`${TS}-board-repaired.jsonl`])
    expect(await readFile(join(dir, 'quarantine', `${TS}-board-repaired.jsonl`), 'utf8')).toBe(
      serializeBoard(withGhost),
    )
  })

  it('missing board line with a backup: loads under the backup board record', async () => {
    const f = fixture()
    const old: BoardState = { ...f.state, board: { ...f.state.board, revision: 5 } }
    const backup = await putBackup(old)
    const damaged = f.text
      .split('\n')
      .filter((l) => !l.startsWith('{"type":"board"'))
      .join('\n')
    await put('board.jsonl', damaged)

    const o = ok(await loadBoardDir(dir, deps()))
    expect(o.state.board.id).toBe(f.state.board.id)
    expect(o.state.board.name).toBe('Fixture board')
    // the damaged file's eof says revision 7 was reached; the backup's 5 must not win
    expect(o.state.board.revision).toBe(8)
    expect(o.state.notes.size).toBe(3)
    expect(o.recovery).toMatchObject({
      integrity: expect.stringMatching(/^(missing-eof|checksum-mismatch|count-mismatch)$/),
      latestBackup: { file: backup, revision: 5, notes: 3, yarns: 1 },
    })
    expect(await readFile(join(dir, 'quarantine', o.recovery?.preservedAs as string), 'utf8')).toBe(
      damaged,
    )
    expect(parseBoard(await readFile(boardPath(), 'utf8')).integrity).toBe('ok')
  })

  it('board.jsonl missing with backups: loads the newest backup as missing-file', async () => {
    const f = fixture()
    const r = (n: number): BoardState => ({ ...f.state, board: { ...f.state.board, revision: n } })
    await putBackup(r(3), '2026-10-27T06:00:00Z')
    const newest = await putBackup(r(5), '2026-10-27T08:00:00Z')

    const o = ok(await loadBoardDir(dir, deps()))
    expect(o.recoveredNow).toBe(true)
    expect(o.state.board.revision).toBe(6)
    expect(o.recovery).toMatchObject({
      integrity: 'missing-file',
      preservedAs: null,
      quarantinedLines: 0,
      repairs: 0,
      latestBackup: { file: newest, revision: 5, notes: 3, yarns: 1 },
    })
    expect(await quarantined()).toEqual([])
    expect(parseBoard(await readFile(boardPath(), 'utf8')).state?.board.revision).toBe(6)
  })

  it('board.jsonl missing: a backup named for a higher revision than its content raises the revision', async () => {
    const f = fixture()
    await mkdir(join(dir, 'backups'), { recursive: true })
    await writeFile(
      join(dir, 'backups', backupName(new Date('2026-10-27T08:00:00Z'), 5)),
      serializeBoard(f.state),
    )
    await writeFile(
      join(dir, 'backups', backupName(new Date('2026-10-27T07:00:00Z'), 11)),
      serializeBoard(f.state),
    )
    const o = ok(await loadBoardDir(dir, deps()))
    expect(o.state.board.revision).toBe(12)
    expect(parseBoard(await readFile(boardPath(), 'utf8')).state?.board.revision).toBe(12)
  })

  it('board.jsonl missing, newest backup damaged: its lines, repairs and bytes are preserved', async () => {
    const f = fixture()
    const [a, b] = f.noteIds as [string, string]
    const ghost = newId('note')
    const yarn = f.state.yarns.get(f.yarnId)
    if (!yarn) throw new Error('fixture yarn')
    const original = { ...yarn, noteIds: [a, b, ghost] }
    const lines = serializeBoard({ ...f.state, yarns: new Map([[f.yarnId, original]]) }).split('\n')
    lines.splice(2, 0, 'backup garbage {')
    const damaged = lines.join('\n')
    await mkdir(join(dir, 'backups'))
    const name = backupName(new Date('2026-10-27T08:00:00Z'), 7)
    await writeFile(join(dir, 'backups', name), damaged)
    const expected = parseBoard(damaged).integrity
    expect(expected).not.toBe('ok')

    const o = ok(await loadBoardDir(dir, deps()))
    expect(o.recovery).toMatchObject({
      integrity: 'missing-file',
      preservedAs: `${TS}-backup-${expected}.jsonl`,
      quarantinedLines: 1,
      repairs: 1,
      latestBackup: { file: name, revision: 7 },
    })
    expect(o.state.board.revision).toBe(8)
    expect(o.state.yarns.get(f.yarnId)?.noteIds).toEqual([a, b])

    expect(await quarantined()).toEqual([`${TS}-backup-${expected}.jsonl`, `${TS}-lines.jsonl`])
    expect(await readFile(join(dir, 'quarantine', `${TS}-backup-${expected}.jsonl`), 'utf8')).toBe(
      damaged,
    )
    const [issue] = jsonLines(await readFile(join(dir, 'quarantine', `${TS}-lines.jsonl`), 'utf8'))
    expect(issue).toMatchObject({ line: 3, kind: 'invalid-json', raw: 'backup garbage {' })
    const repairs = jsonLines(await readFile(join(dir, 'repairs.jsonl'), 'utf8'))
    expect(repairs).toHaveLength(1)
    expect(repairs[0]?.raw).toBe(JSON.stringify(original))
    // the backup itself is untouched
    expect(await readFile(join(dir, 'backups', name), 'utf8')).toBe(damaged)
  })

  it('is idempotent: a second load is ok, persisted recovery stays, nothing new is written', async () => {
    const f = fixture()
    await put('board.jsonl', f.text.split('\n').slice(0, 4).join('\n'))
    const first = ok(await loadBoardDir(dir, deps()))
    expect(first.recoveredNow).toBe(true)
    const before = await listing(dir)

    clock.advance(60_000)
    const second = ok(await loadBoardDir(dir, deps()))
    expect(second.recoveredNow).toBe(false)
    expect(second.recovery).toEqual(first.recovery)
    expect(second.state.board.revision).toBe(first.state.board.revision)
    expect(serializeBoard(second.state)).toBe(serializeBoard(first.state))
    expect(await listing(dir)).toEqual(before)

    await clearRecovery(dir)
    expect(await readRecovery(dir)).toBeNull()
    expect(ok(await loadBoardDir(dir, deps())).recovery).toBeNull()
    await clearRecovery(dir) // no recovery.json: not an error
  })

  it('treats an unreadable recovery.json as no notice', async () => {
    const f = fixture()
    await put('board.jsonl', f.text)
    await put('recovery.json', '{"integrity": "bogus"')
    expect(ok(await loadBoardDir(dir, deps())).recovery).toBeNull()
  })

  it('creates files 0600 and directories 0700 and logs no paths or content', async () => {
    const f = fixture()
    const lines = f.text.split('\n')
    lines.splice(2, 0, 'SECRET-garbage')
    await put('board.jsonl', lines.join('\n'))
    ok(await loadBoardDir(dir, deps()))

    expect((await stat(join(dir, 'quarantine'))).mode & 0o777).toBe(0o700)
    for (const f of ['board.jsonl', 'recovery.json']) {
      expect((await stat(join(dir, f))).mode & 0o777).toBe(0o600)
    }
    for (const name of await quarantined()) {
      expect((await stat(join(dir, 'quarantine', name))).mode & 0o777).toBe(0o600)
    }
    const all = logs.join('\n')
    expect(all).not.toContain('SECRET')
    expect(all).not.toContain(dir)
    expect(all).not.toContain('board_')
    expect(all).not.toContain('quarantine')
  })

  it('survives a crash mid-recovery: the damaged file is intact and the next load recovers', async () => {
    const f = fixture()
    const damaged = f.text.split('\n').slice(0, 4).join('\n')
    await put('board.jsonl', damaged)
    const crash: Faults = {
      hit(p) {
        if (p === 'snapshot:after-tmp-fsync') throw new Error('boom')
      },
    }
    await expect(loadBoardDir(dir, deps(crash))).rejects.toThrow('boom')
    expect(await readFile(boardPath(), 'utf8')).toBe(damaged)

    clock.advance(1000)
    const o = ok(await loadBoardDir(dir, deps()))
    expect(o.recoveredNow).toBe(true)
    // Both attempts preserved the damaged file; nothing was lost.
    const boards = (await quarantined()).filter((n) => n.includes('-board-'))
    expect(boards).toHaveLength(2)
    for (const n of boards) {
      expect(await readFile(join(dir, 'quarantine', n), 'utf8')).toBe(damaged)
    }
    expect(await readdir(dir)).not.toContain('board.jsonl.tmp')
  })

  it('a re-run that finds stronger damage keeps the larger counts of the run it finishes', async () => {
    const f = fixture()
    await put('board.jsonl', f.text.split('\n').slice(0, 4).join('\n'))
    // The unfinished run's notice: weaker, but it had set more aside.
    await put(
      'recovery.json',
      `${JSON.stringify({
        integrity: 'external-edit',
        detectedAt: T,
        preservedAs: 'earlier-board-external-edit.jsonl',
        quarantinedLines: 5,
        repairs: 2,
        journalCommits: 4,
        latestBackup: null,
        inProgress: true,
      })}\n`,
    )
    const o = ok(await loadBoardDir(dir, deps()))
    expect(o.recovery).toMatchObject({
      integrity: 'missing-eof',
      detectedAt: NOW,
      preservedAs: `${TS}-board-missing-eof.jsonl`,
      quarantinedLines: 5,
      repairs: 2,
      journalCommits: 4,
    })
  })
})

describe('restored and externally changed boards', () => {
  const at = (s: BoardState, revision: number): BoardState => ({
    ...s,
    board: { ...s.board, revision },
  })

  it('a clean board.jsonl older than a backup is a restore: preserved, notice, revision above all', async () => {
    const f = fixture()
    await putBackup(at(f.state, 3), '2026-10-27T06:00:00Z')
    const newest = await putBackup(at(f.state, 9), '2026-10-27T08:00:00Z')
    await put('board.jsonl', f.text) // revision 7, put back by hand

    const o = ok(await loadBoardDir(dir, deps()))
    expect(o.recoveredNow).toBe(true)
    expect(o.state.board.revision).toBe(10)
    expect(o.recovery).toEqual({
      integrity: 'restored',
      detectedAt: NOW,
      preservedAs: `${TS}-board-restored.jsonl`,
      quarantinedLines: 0,
      repairs: 0,
      latestBackup: { file: newest, revision: 9, notes: 3, yarns: 1 },
    })
    expect(await quarantined()).toEqual([`${TS}-board-restored.jsonl`])
    expect(await readFile(join(dir, 'quarantine', `${TS}-board-restored.jsonl`), 'utf8')).toBe(
      f.text,
    )
    const reparsed = parseBoard(await readFile(boardPath(), 'utf8'))
    expect(reparsed.integrity).toBe('ok')
    expect(reparsed.state?.board.revision).toBe(10)
    expect(reparsed.state?.notes.size).toBe(3)
    expect(await readRecovery(dir)).toEqual(o.recovery)

    // Idempotent: the bumped board is no longer below any backup.
    const before = await listing(dir)
    const again = ok(await loadBoardDir(dir, deps()))
    expect(again.recoveredNow).toBe(false)
    expect(again.state.board.revision).toBe(10)
    expect(await listing(dir)).toEqual(before)
  })

  it('a clean board.jsonl at or above every backup revision loads untouched', async () => {
    const f = fixture()
    await putBackup(at(f.state, 5), '2026-10-27T06:00:00Z')
    await putBackup(f.state, '2026-10-27T08:00:00Z') // revision 7, as a backup link would be
    await put('board.jsonl', f.text)
    const before = await listing(dir)

    const o = ok(await loadBoardDir(dir, deps()))
    expect(o.recoveredNow).toBe(false)
    expect(o.recovery).toBeNull()
    expect(o.state.board.revision).toBe(7)
    expect(await listing(dir)).toEqual(before)
  })

  it('cachedRevision: a clean file below the cached revision is a restore above it', async () => {
    const f = fixture()
    await put('board.jsonl', f.text)
    const o = ok(await loadBoardDir(dir, deps(), { cachedRevision: 12 }))
    expect(o.recoveredNow).toBe(true)
    expect(o.state.board.revision).toBe(13)
    expect(o.recovery).toMatchObject({
      integrity: 'restored',
      preservedAs: `${TS}-board-restored.jsonl`,
    })
    expect(await readFile(join(dir, 'quarantine', `${TS}-board-restored.jsonl`), 'utf8')).toBe(
      f.text,
    )
  })

  it('cachedRevision: any other clean change is an external edit with a new revision', async () => {
    const f = fixture()
    const edited = serializeBoard({ ...f.state, board: { ...f.state.board, name: 'Renamed' } })
    await put('board.jsonl', edited)
    const o = ok(await loadBoardDir(dir, deps(), { cachedRevision: 7 }))
    expect(o.recoveredNow).toBe(true)
    expect(o.state.board.revision).toBe(8)
    expect(o.state.board.name).toBe('Renamed')
    expect(o.recovery).toMatchObject({
      integrity: 'external-edit',
      preservedAs: `${TS}-board-external-edit.jsonl`,
      quarantinedLines: 0,
      repairs: 0,
    })
    expect(await readFile(join(dir, 'quarantine', `${TS}-board-external-edit.jsonl`), 'utf8')).toBe(
      edited,
    )
  })

  it('cachedRevision: a damaged file keeps its integrity and still lands above the cached revision', async () => {
    const f = fixture()
    await put('board.jsonl', f.text.split('\n').slice(0, 4).join('\n'))
    const o = ok(await loadBoardDir(dir, deps(), { cachedRevision: 20 }))
    expect(o.recovery?.integrity).toBe('missing-eof')
    expect(o.state.board.revision).toBe(21)
  })
})

describe('unreadable boards are never touched', () => {
  it('missing board line and no backup: unreadable, listing and bytes identical', async () => {
    const f = fixture()
    const damaged = f.text
      .split('\n')
      .filter((l) => !l.startsWith('{"type":"board"'))
      .join('\n')
    await put('board.jsonl', damaged)
    const listBefore = await listing(dir)
    const bytesBefore = await readFile(boardPath())

    expect(await loadBoardDir(dir, deps())).toEqual({ kind: 'unreadable', reason: 'missing-board' })
    expect(await listing(dir)).toEqual(listBefore)
    expect((await readFile(boardPath())).equals(bytesBefore)).toBe(true)
  })

  it('missing board line and only unreadable backups: still unreadable and untouched', async () => {
    const f = fixture()
    await mkdir(join(dir, 'backups'))
    await writeFile(join(dir, 'backups', backupName(new Date(NOW), 1)), 'not a board')
    await put('board.jsonl', f.text.split('\n').slice(1).join('\n'))
    const listBefore = await listing(dir)
    expect(await loadBoardDir(dir, deps())).toEqual({ kind: 'unreadable', reason: 'missing-board' })
    expect(await listing(dir)).toEqual(listBefore)
  })

  it.each([5, 7])(
    'schemaVersion %i: unsupported-version, bytes and listing unchanged after two loads',
    async (v) => {
      const f = fixture()
      const lines = f.text.split('\n')
      lines[0] = (lines[0] as string).replace('"schemaVersion":6', `"schemaVersion":${v}`)
      expect(lines[0]).toContain(`"schemaVersion":${v}`)
      await put('board.jsonl', lines.join('\n'))
      await putBackup(f.state) // a readable backup must not be substituted for a file of another version
      const listBefore = await listing(dir)
      const bytesBefore = await readFile(boardPath())

      for (let i = 0; i < 2; i++) {
        expect(await loadBoardDir(dir, deps())).toEqual({
          kind: 'unreadable',
          reason: 'unsupported-version',
        })
        expect(await listing(dir)).toEqual(listBefore)
        expect((await readFile(boardPath())).equals(bytesBefore)).toBe(true)
      }
    },
  )
})

describe('writeSnapshot and StoreError', () => {
  it('writes board.jsonl durably with mode 0600 and returns its stamp', async () => {
    const f = fixture()
    const stamp = await writeSnapshot(dir, f.text, noFaults)
    expect(stamp.size).toBe(Buffer.byteLength(f.text))
    expect(await readFile(boardPath(), 'utf8')).toBe(f.text)
    expect((await stat(boardPath())).mode & 0o777).toBe(0o600)
  })

  it('carries a code, an optional reason and no message beyond the code', () => {
    const e = new StoreError('board-unreadable', { reason: 'missing-board' })
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('board-unreadable')
    expect(e.reason).toBe('missing-board')
    expect(e.opError).toBeUndefined()
    expect(e.message).toBe('board-unreadable')
  })
})

describe('a board restored by hand above the revisions it reached', () => {
  const _at = (s: BoardState, revision: number): BoardState => ({
    ...s,
    board: { ...s.board, revision },
  })

  it('an evicted board hand-restored to an older file loads above its high-water mark', async () => {
    const user = serverId('user')
    const store = new BoardStore({
      dataDir: dir,
      clock,
      log: createLogger((l) => logs.push(l)),
      faults: noFaults,
      cacheSize: 1,
      idleEvictMs: 600_000,
      ringCommits: 512,
      ringBytes: 16_777_216,
      maxBoardsPerUser: 50,
      compactIdleMs: 3_600_000,
    })
    try {
      const { id } = await store.createBoard(user, 'Lifetime')
      const bdir = join(dir, 'users', user, 'boards', id)
      const clientId = newId('tab', clock.now().getTime())
      for (let seq = 1; seq <= 10; seq++) {
        const noteId = newId('note')
        await store.submit(user, id, {
          clientId,
          seq,
          baseRevision: seq - 1,
          ops: [
            {
              op: 'note.create',
              note: {
                type: 'note',
                id: noteId,
                x: seq * 300,
                y: 0,
                w: 240,
                h: 160,
                z: seq,
                paper: 'cream',
                style: 'rustic',
                text: `note ${seq}`,
                image: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            },
          ],
        })
      }
      await store.compact(user, id)
      // Evicted: the one cache slot goes to another board.
      const other = await store.createBoard(user, 'Other')
      await store.read(user, other.id)
      expect(store.stats.cached).toBe(1)

      // An older clean backup copied over board.jsonl by hand (no newer backup left beside it).
      const older = (await readdir(join(bdir, 'backups'))).sort()[0]
      if (!older) throw new Error('no backup')
      const olderText = await readFile(join(bdir, 'backups', older), 'utf8')
      expect(parseBoard(olderText).state?.board.revision).toBeLessThan(10)
      await writeFile(join(bdir, 'board.jsonl'), olderText, { mode: 0o600 })
      for (const name of await readdir(join(bdir, 'backups'))) {
        if (name !== older) await rm(join(bdir, 'backups', name))
      }

      const view = await store.read(user, id)
      expect(view.revision).toBe(11)
      expect(view.recovery?.integrity).toBe('restored')
      // A stream resuming from revision 10 is told to reset (the events route sends `reset`).
      expect(await store.since(user, id, 10)).toMatchObject({ revision: 11, full: true })
    } finally {
      await store.close()
    }
  })
})
