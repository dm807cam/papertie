import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Asset,
  type BoardState,
  emptyBoardState,
  type Note,
  newId,
  serializeBoard,
  stateFromRecords,
} from '@papertie/core'
import { afterEach, describe, expect, it } from 'vitest'
import { serverId } from '../src/ids'
import { ASSET_SIZES } from '../src/limits'
import { createLogger } from '../src/log'
import { backupName } from '../src/store/backups'
import { newImportId, removeImportDirs } from '../src/store/importBoard'
import { JOURNAL_FILE } from '../src/store/journal'
import { createBoard, noteCreate } from './helpers/boards'
import { FakeClock } from './helpers/clock'
import { startTestServer, type TestServer } from './helpers/harness'

/**
 * The startup cleanup of an import cut short after its photo move
 * deletes a moved photo directory only when nothing of the board could be showing it: the board's
 * eof is not the one `moved.json` names, the board file is readable, and neither `board.jsonl`
 * nor `journal.jsonl` names the id. And a successful import leaves no `moved.json` behind.
 */

const T0 = '2026-10-27T10:00:00.000Z'
const roots: string[] = []
let server: TestServer | null = null

afterEach(async () => {
  await server?.close()
  server = null
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

const asset = (id: string): Asset => ({
  type: 'asset',
  id,
  mime: 'image/webp',
  width: 64,
  height: 48,
  bytes: 100,
  sha256: '0'.repeat(64),
  createdAt: T0,
})

function showing(id: string): Note {
  const n = noteCreate({ at: T0 }).note as unknown as Note
  return { ...n, image: { assetId: id, frame: 'print' } }
}

async function photoDir(dir: string, id: string) {
  await mkdir(join(dir, 'assets', id), { recursive: true })
  for (const size of ASSET_SIZES) await writeFile(join(dir, 'assets', id, `${size}.webp`), 'x')
}

/** A board dir on disk with `board.jsonl` as given, the photos `ids`, and a `moved.json` naming them. */
async function layout(boardText: string, ids: string[], movedSha: string) {
  const root = await mkdtemp(join(tmpdir(), 'papertie-leftovers-'))
  roots.push(root)
  const boardId = newId('board')
  const dir = join(root, 'users', serverId('user'), 'boards', boardId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'board.jsonl'), boardText)
  for (const id of ids) await photoDir(dir, id)
  const importDir = join(dir, `import-${newImportId(Date.parse(T0))}`)
  await mkdir(importDir)
  await writeFile(join(importDir, 'moved.json'), JSON.stringify({ ids, sha256: movedSha }))
  return { root, dir, boardId }
}

const boardText = (boardId: string, records: Array<Asset | Note>): string => {
  const empty = emptyBoardState(boardId, 'Board', T0)
  const state: BoardState = stateFromRecords({ ...empty.board, revision: 3 }, records)
  return serializeBoard(state)
}

describe('removeImportDirs at startup', () => {
  it('keeps moved photos the board shows, even when its eof is not the one moved.json names', async () => {
    const [a, b] = [newId('asset'), newId('asset')]
    const { root, dir, boardId } = await layout('', [a, b], 'a'.repeat(64))
    // The committed import, later compacted: another eof, the same records.
    await writeFile(
      join(dir, 'board.jsonl'),
      boardText(boardId, [asset(a as string), asset(b as string), showing(a as string)]),
    )
    expect(await removeImportDirs(root)).toEqual({ dirs: 1, photos: 0 })
    expect((await readdir(join(dir, 'assets'))).sort()).toEqual([a, b].sort())
    expect((await readdir(dir)).filter((n) => n.startsWith('import-'))).toEqual([])
  })

  it('keeps a moved photo only the journal names', async () => {
    const id = newId('asset')
    const { root, dir, boardId } = await layout('', [id], 'a'.repeat(64))
    await writeFile(join(dir, 'board.jsonl'), boardText(boardId, []))
    await writeFile(
      join(dir, JOURNAL_FILE),
      `${JSON.stringify({ rev: 4, ops: [{ op: 'asset.add', asset: asset(id) }] })}\n`,
    )
    expect(await removeImportDirs(root)).toEqual({ dirs: 1, photos: 0 })
    expect(await readdir(join(dir, 'assets'))).toEqual([id])
  })

  it('keeps every moved photo when board.jsonl cannot be read', async () => {
    const id = newId('asset')
    for (const text of [null, '{"type":"board"', '']) {
      const { root, dir } = await layout(text ?? '', [id], 'a'.repeat(64))
      if (text === null) await rm(join(dir, 'board.jsonl'))
      expect(await removeImportDirs(root), String(text)).toEqual({ dirs: 1, photos: 0 })
      expect(existsSync(join(dir, 'assets', id))).toBe(true)
    }
  })

  it('keeps a moved photo only a retained backup names', async () => {
    const id = newId('asset')
    const { root, dir, boardId } = await layout('', [id], 'a'.repeat(64))
    await writeFile(join(dir, 'board.jsonl'), boardText(boardId, []))
    await mkdir(join(dir, 'backups'))
    await writeFile(
      join(dir, 'backups', backupName(new Date(T0), 2)),
      boardText(boardId, [asset(id), showing(id)]),
    )
    expect(await removeImportDirs(root)).toEqual({ dirs: 1, photos: 0 })
    expect(await readdir(join(dir, 'assets'))).toEqual([id])
  })

  it('removes moved photos nothing names when the eof is not the one named (a true leftover)', async () => {
    const [kept, left] = [newId('asset'), newId('asset')]
    const { root, dir, boardId } = await layout('', [left], 'a'.repeat(64))
    await photoDir(dir, kept)
    await writeFile(join(dir, 'board.jsonl'), boardText(boardId, [asset(kept), showing(kept)]))
    expect(await removeImportDirs(root)).toEqual({ dirs: 1, photos: 1 })
    expect(await readdir(join(dir, 'assets'))).toEqual([kept])
  })
})

describe('a leftover that cannot be read', () => {
  it('keeps that import (its photos and its directory), warns by count and goes on', async () => {
    // A journal that is a directory stands in for EIO: reading it fails with EISDIR.
    const id = newId('asset')
    const { root, dir, boardId } = await layout('', [id], 'a'.repeat(64))
    await writeFile(join(dir, 'board.jsonl'), boardText(boardId, []))
    await mkdir(join(dir, JOURNAL_FILE))
    // A second board whose import left a `moved.json` that cannot be read either.
    const other = join(dir, '..', newId('board'))
    const otherImport = join(other, `import-${newImportId(Date.parse(T0))}`)
    await mkdir(join(otherImport, 'moved.json'), { recursive: true })
    // And a third whose leftover is ordinary: it still goes.
    const third = join(dir, '..', newId('board'))
    await mkdir(join(third, `import-${newImportId(Date.parse(T0))}`), { recursive: true })
    const lines: string[] = []
    const log = createLogger((l) => lines.push(l))

    expect(await removeImportDirs(root, log)).toEqual({ dirs: 1, photos: 0 })
    expect(await readdir(join(dir, 'assets'))).toEqual([id])
    expect((await readdir(dir)).filter((n) => n.startsWith('import-'))).toHaveLength(1)
    expect(existsSync(otherImport)).toBe(true)
    expect(await readdir(third)).toEqual([])
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { level: 'warn', msg: 'import leftovers kept', count: 2 },
    ])
  })

  it('a user or board directory that cannot be listed is skipped with the same warning', async () => {
    const { root, dir } = await layout('', [], 'a'.repeat(64))
    // Another board of the same user, listable, with an ordinary leftover: it still goes.
    const other = join(dir, '..', newId('board'))
    await mkdir(join(other, `import-${newImportId(Date.parse(T0))}`), { recursive: true })
    // The first board's directory cannot be listed (EACCES).
    await chmod(dir, 0o000)
    // A second user whose `boards/` cannot be listed.
    const otherUser = join(root, 'users', serverId('user'), 'boards')
    await mkdir(otherUser, { recursive: true })
    await chmod(otherUser, 0o000)
    const lines: string[] = []
    try {
      expect(
        await removeImportDirs(
          root,
          createLogger((l) => lines.push(l)),
        ),
      ).toEqual({
        dirs: 1,
        photos: 0,
      })
    } finally {
      await chmod(dir, 0o700)
      await chmod(otherUser, 0o700)
    }
    expect(await readdir(other)).toEqual([])
    expect((await readdir(dir)).filter((n) => n.startsWith('import-'))).toHaveLength(1)
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { level: 'warn', msg: 'import leftovers kept', count: 2 },
    ])
  })

  it('a server starts over such a leftover', async () => {
    const id = newId('asset')
    const { root, dir, boardId } = await layout('', [id], 'a'.repeat(64))
    await writeFile(join(dir, 'board.jsonl'), boardText(boardId, []))
    await mkdir(join(dir, JOURNAL_FILE))
    server = await startTestServer({ clock: new FakeClock(T0), dataDir: root })
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200)
    expect(server.logs.map((l) => JSON.parse(l))).toContainEqual({
      level: 'warn',
      msg: 'import leftovers kept',
      count: 1,
    })
    expect(existsSync(join(dir, 'assets', id))).toBe(true)
  })
})

describe('a successful import', () => {
  it('leaves no moved.json behind, even when its import directory is never removed', async () => {
    server = await startTestServer({ clock: new FakeClock(T0) })
    const user = server.user
    const board = await createBoard(user)
    const store = server.deps.store
    if (!store) throw new Error('no store')
    const dir = join(server.dataDir, 'users', user.id, 'boards', board)
    const importDir = join(dir, `import-${newImportId(Date.parse(T0))}`)
    const id = newId('asset', Date.parse(T0))
    await photoDir(importDir, id)
    const state = stateFromRecords(emptyBoardState(board, 'Imported', T0).board, [
      asset(id),
      showing(id),
    ])
    await store.replaceBoard(user.id, board, state, join(importDir, 'assets'))
    expect(existsSync(join(importDir, 'moved.json'))).toBe(false)
    expect(existsSync(join(dir, 'assets', id))).toBe(true)
  })
})
