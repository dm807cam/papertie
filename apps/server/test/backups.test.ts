import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyBoardState, newId, type Op, parseBoard, serializeBoard } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { serverId } from '../src/ids'
import { createLogger } from '../src/log'
import {
  type BackupInfo,
  backupIfNewHour,
  backupName,
  forceBackup,
  latestReadableBackup,
  listBackups,
  parseBackupName,
  pruneBackups,
  selectBackupsToDelete,
  sweepBackups,
} from '../src/store/backups'
import { BoardStore, type BoardStoreOptions } from '../src/store/boardStore'
import { type FaultPoint, noFaults } from '../src/store/faults'
import { noteCreate } from './helpers/boards'
import { blockCreate, blockRecord, bookCreate, bookRecord, edit, ins } from './helpers/books'
import { FakeClock } from './helpers/clock'
import { startServer } from './helpers/httpServer'

const USER = `user_${'0'.repeat(26)}`
const BOARD = `board_${'Z'.repeat(26)}`
const HOUR = 3_600_000
const DAY = 24 * HOUR

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'papertie-backups-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const boardText = (revision: number) => {
  const s = emptyBoardState(BOARD, 'b', '2026-10-27T10:00:00.000Z')
  return serializeBoard({ ...s, board: { ...s.board, revision } })
}

describe('backup names', () => {
  it('round-trips and rejects foreign or impossible names', () => {
    const t = new Date('2026-10-27T10:05:09.000Z')
    expect(backupName(t, 42)).toBe('board.20261027T100509Z.r42.jsonl')
    expect(parseBackupName(backupName(t, 42))).toEqual({
      file: 'board.20261027T100509Z.r42.jsonl',
      time: t,
      revision: 42,
    })
    for (const bad of [
      'notes.txt',
      'board.jsonl',
      'board.jsonl.tmp',
      'board.20261027T100509Z.r42.jsonl.tmp',
      'board.20261327T100509Z.r1.jsonl',
      'board.20260230T100509Z.r1.jsonl',
      'board.20261027T100509Z.r01.jsonl',
    ]) {
      expect(parseBackupName(bad)).toBeNull()
    }
  })
})

describe('backupIfNewHour', () => {
  it('copies the board once per UTC hour, into a file of its own', async () => {
    await writeFile(join(dir, 'board.jsonl'), boardText(7), { mode: 0o600 })
    const ino = (await stat(join(dir, 'board.jsonl'))).ino

    const name = await backupIfNewHour(dir, new Date('2026-10-27T10:05:00Z'), 7, noFaults)
    expect(name).toBe('board.20261027T100500Z.r7.jsonl')
    const copy = await stat(join(dir, 'backups', name as string))
    expect(copy.ino).not.toBe(ino)
    expect(copy.nlink).toBe(1)
    expect(copy.mode & 0o777).toBe(0o600)
    expect(await readFile(join(dir, 'backups', name as string), 'utf8')).toBe(boardText(7))
    // An in-place write to the board leaves the backup alone.
    await writeFile(join(dir, 'board.jsonl'), 'scribbled over')
    expect(await readFile(join(dir, 'backups', name as string), 'utf8')).toBe(boardText(7))
    expect((await stat(join(dir, 'backups'))).mode & 0o777).toBe(0o700)

    expect(await backupIfNewHour(dir, new Date('2026-10-27T10:40:00Z'), 8, noFaults)).toBeNull()
    expect(await readdir(join(dir, 'backups'))).toHaveLength(1)

    const second = await backupIfNewHour(dir, new Date('2026-10-27T11:00:00Z'), 9, noFaults)
    expect(second).toBe('board.20261027T110000Z.r9.jsonl')
    expect(await readdir(join(dir, 'backups'))).toHaveLength(2)
  })

  it('judges the hour from backup names, not mtimes', async () => {
    await writeFile(join(dir, 'board.jsonl'), boardText(1))
    await mkdir(join(dir, 'backups'))
    // Named for an earlier hour but freshly written (mtime = now): it does not count.
    await writeFile(join(dir, 'backups', backupName(new Date('2026-10-27T09:59:59Z'), 1)), 'x')
    expect(await backupIfNewHour(dir, new Date('2026-10-27T10:00:00Z'), 1, noFaults)).not.toBeNull()
  })

  it('returns null without a board file and creates nothing', async () => {
    expect(await backupIfNewHour(dir, new Date('2026-10-27T10:05:00Z'), 0, noFaults)).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  it('fires backup:after-write once the whole copy is in place', async () => {
    await writeFile(join(dir, 'board.jsonl'), boardText(1))
    const seen: FaultPoint[] = []
    const faults = {
      hit(point: FaultPoint) {
        seen.push(point)
        // Synchronous check that the complete copy is on disk under its name when the fault fires.
        expect(readdirSync(join(dir, 'backups'))).toEqual(['board.20261027T100500Z.r1.jsonl'])
        expect(readFileSync(join(dir, 'backups', 'board.20261027T100500Z.r1.jsonl'), 'utf8')).toBe(
          boardText(1),
        )
      },
    }
    await backupIfNewHour(dir, new Date('2026-10-27T10:05:00Z'), 1, faults)
    expect(seen).toEqual(['backup:after-write'])
  })

  it('writes given parts instead of copying the board', async () => {
    const text = boardText(4)
    const parts = [text.slice(0, 10), text.slice(10)]
    const name = await backupIfNewHour(dir, new Date('2026-10-27T10:05:00Z'), 4, noFaults, {
      parts,
    })
    expect(name).toBe('board.20261027T100500Z.r4.jsonl')
    expect(await readFile(join(dir, 'backups', name as string), 'utf8')).toBe(text)
    expect(await readdir(join(dir, 'backups'))).toEqual([name])
  })
})

describe('selectBackupsToDelete', () => {
  const now = new Date('2026-10-27T12:00:00Z')
  const hourly = (days: number): BackupInfo[] =>
    Array.from({ length: days * 24 + 1 }, (_, i) => {
      const time = new Date(now.getTime() - i * HOUR)
      return { file: backupName(time, i), time, revision: i }
    })
  const survivors = (all: BackupInfo[]) => {
    const doomed = new Set(selectBackupsToDelete(all, now))
    return all.filter((b) => !doomed.has(b.file))
  }
  const age = (b: BackupInfo) => now.getTime() - b.time.getTime()

  it('applies the 48h / 30d / 183d table to 200 days of hourly backups', () => {
    const all = hourly(200)
    const kept = survivors(all)

    // Everything within 48 h.
    const recent = all.filter((b) => age(b) <= 48 * HOUR)
    expect(recent).toHaveLength(49)
    for (const b of recent) expect(kept).toContain(b)

    // Newest of each UTC day between 48 h and 30 d, one each.
    const daily = all.filter((b) => age(b) > 48 * HOUR && age(b) <= 30 * DAY)
    const keptDaily = kept.filter((b) => daily.includes(b))
    const dayOf = (b: BackupInfo) => b.time.toISOString().slice(0, 10)
    const days = new Set(daily.map(dayOf))
    expect(keptDaily).toHaveLength(days.size)
    expect(new Set(keptDaily.map(dayOf))).toEqual(days)
    for (const b of keptDaily) {
      const newestOfDay = daily.find((d) => dayOf(d) === dayOf(b)) // all is newest-first
      expect(b).toBe(newestOfDay)
    }

    // One per ISO week between 30 d and 183 d: the newest in each week.
    const weekly = all.filter((b) => age(b) > 30 * DAY && age(b) <= 183 * DAY)
    const keptWeekly = kept.filter((b) => weekly.includes(b))
    // Monday-based week start, computed independently of the implementation.
    const weekStart = (b: BackupInfo) => {
      const d = new Date(
        Date.UTC(b.time.getUTCFullYear(), b.time.getUTCMonth(), b.time.getUTCDate()),
      )
      return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY
    }
    const weeks = new Set(weekly.map(weekStart))
    expect(keptWeekly).toHaveLength(weeks.size)
    expect(new Set(keptWeekly.map(weekStart))).toEqual(weeks)
    for (const b of keptWeekly) expect(b).toBe(weekly.find((w) => weekStart(w) === weekStart(b)))

    // Nothing older than 183 d.
    expect(kept.filter((b) => age(b) > 183 * DAY)).toEqual([])
    expect(kept).toHaveLength(49 + days.size + weeks.size)
  })

  it('counts ISO weeks across the year boundary', () => {
    // 2025-12-29 .. 2026-01-04 is ISO week 2026-W01; 2025-12-22 .. 12-28 is 2025-W52.
    const at = (iso: string): BackupInfo => {
      const time = new Date(iso)
      return { file: backupName(time, 1), time, revision: 1 }
    }
    const later = new Date('2026-06-15T12:00:00Z')
    const w1New = at('2026-01-04T23:00:00Z')
    const w1Old = at('2025-12-29T00:00:00Z')
    const w52New = at('2025-12-28T23:00:00Z')
    const w52Old = at('2025-12-22T00:00:00Z')
    const w51 = at('2025-12-15T00:00:00Z') // 182.5 d old: still inside the window
    const tooOld = at('2025-12-08T00:00:00Z')
    const newest = { file: backupName(later, 9), time: later, revision: 9 }
    const doomed = selectBackupsToDelete([newest, w1New, w1Old, w52New, w52Old, w51, tooOld], later)
    expect(doomed.sort()).toEqual([w1Old.file, w52Old.file, tooOld.file].sort())
  })

  it('never deletes the newest backup, however old', () => {
    const time = new Date(now.getTime() - 400 * DAY)
    const only = { file: backupName(time, 1), time, revision: 1 }
    expect(selectBackupsToDelete([only], now)).toEqual([])
    const older = new Date(time.getTime() - DAY)
    const two = [only, { file: backupName(older, 1), time: older, revision: 1 }]
    expect(selectBackupsToDelete(two, now)).toEqual([backupName(older, 1)])
    expect(selectBackupsToDelete([], now)).toEqual([])
  })
})

describe('pruneBackups', () => {
  it('deletes exactly the selected files and returns their names', async () => {
    const now = new Date('2026-10-27T12:00:00Z')
    const bdir = join(dir, 'backups')
    await mkdir(bdir)
    const times = [
      '2026-10-27T11:00:00Z', // recent
      '2026-10-20T20:00:00Z', // newest of its day
      '2026-10-20T08:00:00Z', // same day, older: doomed
      '2026-03-01T00:00:00Z', // older than 183 d: doomed
    ]
    const infos = times.map((t, i) => ({ name: backupName(new Date(t), i), t }))
    for (const { name } of infos) await writeFile(join(bdir, name), name)
    await writeFile(join(bdir, 'notes.txt'), 'foreign')

    const deleted = await pruneBackups(dir, now)
    expect(deleted.sort()).toEqual([infos[2]?.name, infos[3]?.name].sort())
    expect((await readdir(bdir)).sort()).toEqual(
      [infos[0]?.name, infos[1]?.name, 'notes.txt'].sort(),
    )
    expect(await pruneBackups(dir, now)).toEqual([])
  })

  it('is a no-op without a backups directory', async () => {
    expect(await pruneBackups(dir, new Date())).toEqual([])
    expect(await listBackups(dir)).toEqual([])
  })
})

describe('safety backups', () => {
  const now = new Date('2026-10-27T12:00:00Z') // a Tuesday
  const at = (iso: string, revision = 1): BackupInfo => {
    const time = new Date(iso)
    return { file: backupName(time, revision), time, revision }
  }
  const newest = at('2026-10-27T12:00:00Z', 99)

  it('a safety backup is kept for 30 days, though a later backup of its day is too', () => {
    // 10 and 29 days old, each followed by an ordinary backup the same UTC day.
    const s10 = at('2026-10-17T10:00:00Z', 10)
    const later10 = at('2026-10-17T11:00:00Z', 11)
    const s29 = at('2026-09-28T10:00:00Z', 20)
    const later29 = at('2026-09-28T11:00:00Z', 21)
    const all = [newest, later10, s10, later29, s29]
    expect(selectBackupsToDelete(all, now).sort()).toEqual([s10.file, s29.file].sort())
    expect(selectBackupsToDelete(all, now, new Set([s10.file, s29.file]))).toEqual([])
  })

  it('past 30 days the newest safety backup is still kept, however old; older ones follow the table', () => {
    // Each is followed by an ordinary backup later in its ISO week (Tuesday, then Wednesday).
    const sNew = at('2026-09-01T10:00:00Z', 30)
    const weekNew = at('2026-09-02T10:00:00Z', 31)
    const sOld = at('2026-08-04T10:00:00Z', 20)
    const weekOld = at('2026-08-05T10:00:00Z', 21)
    const all = [newest, weekNew, sNew, weekOld, sOld]
    const safety = new Set([sNew.file, sOld.file])
    expect(selectBackupsToDelete(all, now).sort()).toEqual([sNew.file, sOld.file].sort())
    expect(selectBackupsToDelete(all, now, safety)).toEqual([sOld.file])
    // Older than the weekly window too: the newest safety backup stays all the same.
    const ancient = at('2025-12-01T10:00:00Z', 5)
    expect(selectBackupsToDelete([newest, ancient], now, new Set([ancient.file]))).toEqual([])
  })

  it('pruneBackups honours the markers, and takes a marker away with its backup or alone', async () => {
    const bdir = join(dir, 'backups')
    await mkdir(bdir)
    const s10 = at('2026-10-17T10:00:00Z', 10)
    const later10 = at('2026-10-17T11:00:00Z', 11)
    const doomedOld = at('2026-03-01T00:00:00Z', 2) // past 183 d, once a safety backup
    const sNewer = at('2026-10-20T10:00:00Z', 15) // a newer safety backup than doomedOld
    for (const b of [newest, s10, later10, doomedOld, sNewer]) {
      await writeFile(join(bdir, b.file), b.file)
    }
    for (const b of [s10, doomedOld, sNewer]) await writeFile(join(bdir, `${b.file}.safety`), '')
    const orphan = `${backupName(new Date('2026-10-01T00:00:00Z'), 3)}.safety`
    await writeFile(join(bdir, orphan), '')
    // An orphan is older than the prune's listing (a fresh marker is never taken for one).
    const hourAgo = new Date(Date.now() - 3_600_000)
    await utimes(join(bdir, orphan), hourAgo, hourAgo)

    expect(await pruneBackups(dir, now)).toEqual([doomedOld.file])
    expect((await readdir(bdir)).sort()).toEqual(
      [
        newest.file,
        s10.file,
        `${s10.file}.safety`,
        later10.file,
        sNewer.file,
        `${sNewer.file}.safety`,
      ].sort(),
    )
  })

  it('forceBackup marks its backup, also when the backup was there already', async () => {
    await writeFile(join(dir, 'board.jsonl'), boardText(4))
    const name = await forceBackup(dir, now, 4, noFaults)
    expect(readdirSync(join(dir, 'backups')).sort()).toEqual([name, `${name}.safety`].sort())
    await rm(join(dir, 'backups', `${name}.safety`))
    expect(await forceBackup(dir, now, 4, noFaults)).toBe(name)
    expect(readdirSync(join(dir, 'backups')).sort()).toEqual([name, `${name}.safety`].sort())
  })
})

describe('latestReadableBackup', () => {
  it('skips a garbage newest backup and returns the next one', async () => {
    const bdir = join(dir, 'backups')
    await mkdir(bdir)
    await writeFile(join(bdir, backupName(new Date('2026-10-27T09:00:00Z'), 3)), boardText(3))
    await writeFile(join(bdir, backupName(new Date('2026-10-27T08:00:00Z'), 2)), boardText(2))
    await writeFile(join(bdir, backupName(new Date('2026-10-27T10:00:00Z'), 4)), 'not a board\n')
    const found = await latestReadableBackup(dir)
    expect(found?.info.revision).toBe(3)
    expect(found?.state.board.revision).toBe(3)
  })

  it('returns null when nothing is loadable', async () => {
    expect(await latestReadableBackup(dir)).toBeNull()
    await mkdir(join(dir, 'backups'))
    await writeFile(join(dir, 'backups', backupName(new Date('2026-10-27T10:00:00Z'), 1)), '')
    expect(await latestReadableBackup(dir)).toBeNull()
  })
})

describe('sweepBackups', () => {
  const NOW = new Date('2026-10-27T12:00:00Z')
  const seed = async (user: string, board: string) => {
    const bdir = join(dir, 'users', user, 'boards', board, 'backups')
    await mkdir(bdir, { recursive: true })
    await writeFile(join(bdir, backupName(new Date('2026-10-27T11:00:00Z'), 2)), 'new')
    await writeFile(join(bdir, backupName(new Date('2026-03-01T00:00:00Z'), 1)), 'old')
    return bdir
  }
  const capture = () => {
    const lines: string[] = []
    return { lines, log: createLogger((l) => lines.push(l)) }
  }

  it('prunes every board, skips non-id names and logs only a count', async () => {
    const other = `user_${'1'.repeat(26)}`
    const a = await seed(USER, BOARD)
    const b = await seed(other, `board_${'2'.repeat(26)}`)
    const bogus = await seed('not-a-user', BOARD)
    const bogusBoard = await seed(USER, 'board_lowercase')
    const { lines, log } = capture()

    await sweepBackups(dir, NOW, log)

    expect(await readdir(a)).toHaveLength(1)
    expect(await readdir(b)).toHaveLength(1)
    expect(await readdir(bogus)).toHaveLength(2)
    expect(await readdir(bogusBoard)).toHaveLength(2)
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { level: 'info', msg: 'backup sweep', count: 2 },
    ])
  })

  it('continues past a board that fails, logging only the error kind', async () => {
    const bad = await seed(USER, `board_${'3'.repeat(26)}`)
    const good = await seed(USER, `board_${'4'.repeat(26)}`)
    // backups/ is a file in one board: readdir fails with ENOTDIR.
    await rm(bad, { recursive: true })
    await writeFile(bad, 'not a directory')
    const { lines, log } = capture()

    await sweepBackups(dir, NOW, log)

    expect(await readdir(good)).toHaveLength(1)
    const logged = lines.map((l) => JSON.parse(l))
    expect(logged).toContainEqual({ level: 'warn', msg: 'backup sweep failed', kind: 'Error' })
    expect(logged).toContainEqual({ level: 'info', msg: 'backup sweep', count: 1 })
    expect(lines.join('')).not.toContain(dir)
  })

  it('tolerates a data dir with no users', async () => {
    const { lines, log } = capture()
    await sweepBackups(dir, NOW, log)
    expect(lines).toEqual([])
  })
})

describe('startServer wiring', () => {
  it('sweeps in the background after listen and close() waits for it', async () => {
    const bdir = join(dir, 'users', USER, 'boards', BOARD, 'backups')
    await mkdir(bdir, { recursive: true })
    await writeFile(join(bdir, backupName(new Date('2026-10-27T11:00:00Z'), 2)), 'new')
    await writeFile(join(bdir, backupName(new Date('2026-03-01T00:00:00Z'), 1)), 'old')
    const logs: string[] = []
    const config = loadConfig(dir)
    const server = await startServer(config, {
      clock: new FakeClock('2026-10-27T12:00:00.000Z'),
      logSink: (l) => logs.push(l),
    })
    await server.close()
    expect(await readdir(bdir)).toHaveLength(1)
    expect(logs.map((l) => JSON.parse(l))).toContainEqual({
      level: 'info',
      msg: 'backup sweep',
      count: 1,
    })
  })
})

describe('History restore with books (one unit)', () => {
  let dir: string
  let store: BoardStore
  const clock = new FakeClock('2026-10-27T10:00:00.000Z')
  const user = serverId('user')
  const opts = (): BoardStoreOptions => ({
    dataDir: dir,
    clock,
    log: createLogger(() => {}),
    faults: noFaults,
    cacheSize: 8,
    idleEvictMs: 600_000,
    ringCommits: 512,
    ringBytes: 16_777_216,
    maxBoardsPerUser: 5,
    compactEveryHour: false,
  })
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'papertie-restore-books-'))
    store = new BoardStore(opts())
  })
  afterEach(async () => {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('restore and import carry books: restoring a backup brings back the board and books of that hour together', async () => {
    const boardId = (await store.createBoard(user, 'B')).id
    const tab = newId('tab', clock.now().getTime())
    const book = bookRecord()
    const block = blockRecord(book.id, 'V', 'as it was at ten')
    const r1 = await store.submit(user, boardId, {
      clientId: tab,
      seq: 1,
      baseRevision: 0,
      ops: [
        bookCreate(book),
        blockCreate(block),
        noteCreate({ at: '2026-10-27T10:00:00.000Z' }) as Op,
      ],
    })
    await store.compact(user, boardId)
    const hourOld = (await listBackups(join(dir, 'users', user, 'boards', boardId)))[0]
    if (!hourOld) throw new Error('no backup')
    clock.advance(HOUR)
    const later = bookRecord({ title: 'Written at eleven' })
    await store.submit(user, boardId, {
      clientId: tab,
      seq: 2,
      baseRevision: r1.revision,
      ops: [
        edit(book.id, block.id, [ins(16, ', and since')]),
        bookCreate(later),
        blockCreate(blockRecord(later.id, 'V', 'new')),
      ],
    })
    const restored = await store.restoreBackup(user, boardId, hourOld.file)
    const s = (await store.peek(user, boardId)).state
    expect([...s.books.keys()]).toEqual([book.id])
    expect(s.blocks.get(block.id)?.text).toBe('as it was at ten')
    expect(s.notes.size).toBe(1)
    // The safety backup holds the board and both books as they stood before.
    const safety = parseBoard(
      await readFile(
        join(dir, 'users', user, 'boards', boardId, 'backups', restored.safetyBackup),
        'utf8',
      ),
    ).state
    expect(safety?.books.size).toBe(2)
    expect(safety?.blocks.get(block.id)?.text).toBe('as it was at ten, and since')
    // A restart loads the same.
    await store.close()
    store = new BoardStore(opts())
    const again = (await store.peek(user, boardId)).state
    expect(again.blocks.get(block.id)?.text).toBe('as it was at ten')
    expect(again.books.has(later.id)).toBe(false)
  })
})
