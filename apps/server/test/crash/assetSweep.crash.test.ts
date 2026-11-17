import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Asset, newId, type Op, parseBoard } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serverId } from '../../src/ids'
import { ASSET_SIZES } from '../../src/limits'
import type { AssetSweepResult } from '../../src/store/assetSweep'
import type { BoardSummary, CommitAck } from '../../src/store/boardStore'
import { noteCreate } from '../helpers/boards'
import { type ReadResult, resultOf, type StoreChild, spawnStore } from './storeChild'

/**
 * Review Focus 4: the asset sweep deletes no file in the run that commits: the files of a record
 * it took off stay until a later run finds them without a record, so a SIGKILL right after the
 * commit loses nothing and leaves nothing the next run cannot collect.
 */

const T_UP = '2026-09-01T10:00:00.000Z'
const T_SWEEP = new Date(Date.parse(T_UP) + 31 * 86_400_000).toISOString()

let root: string
const children: StoreChild[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'papertie-sweep-crash-'))
})
afterEach(async () => {
  for (const c of children.splice(0)) c.kill()
  await rm(root, { recursive: true, force: true })
})

async function store(dataDir: string, now: string, fault?: string): Promise<StoreChild> {
  const c = await spawnStore(dataDir, { now, fault })
  children.push(c)
  return c
}

const listDir = async (dir: string) => {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

/** An uploaded photo as the upload route leaves it: three variants on disk, then `asset.add`. */
async function photo(
  c: StoreChild,
  userId: string,
  boardId: string,
  dir: string,
): Promise<{ id: string; bytes: number }> {
  const id = newId('asset', Date.parse(T_UP))
  await mkdir(join(dir, 'assets', id), { recursive: true })
  let bytes = 0
  for (const size of ASSET_SIZES) {
    const body = Buffer.alloc(size / 8, size % 251)
    await writeFile(join(dir, 'assets', id, `${size}.webp`), body)
    bytes += body.byteLength
  }
  const asset: Asset = {
    type: 'asset',
    id,
    mime: 'image/webp',
    width: 64,
    height: 48,
    bytes: 2560 / 8,
    sha256: '0'.repeat(64),
    createdAt: T_UP,
  }
  resultOf<CommitAck>(
    await c.send({ cmd: 'server', userId, boardId, ops: [{ op: 'asset.add', asset }] }),
  )
  return { id, bytes }
}

describe('asset sweep crash', () => {
  it('a crash between the commit and the file delete leaves only orphan files, removed by the next sweep', async () => {
    const dataDir = join(root, 'data')
    const userId = serverId('user')
    const c1 = await store(dataDir, T_UP)
    const boardId = resultOf<BoardSummary>(await c1.send({ cmd: 'create', userId })).id
    const dir = join(dataDir, 'users', userId, 'boards', boardId)
    const doomed = await photo(c1, userId, boardId, dir)
    const kept = await photo(c1, userId, boardId, dir)
    const op = noteCreate({ at: T_UP })
    const shows = { ...op, note: { ...op.note, image: { assetId: kept.id, frame: 'print' } } } as Op
    const before = resultOf<CommitAck>(
      await c1.send({
        cmd: 'submit',
        userId,
        boardId,
        input: { clientId: newId('tab', Date.parse(T_UP)), seq: 1, baseRevision: 2, ops: [shows] },
      }),
    ).revision
    await c1.close()

    // Killed right after the asset.remove commit is acked. The sweep runs only on a loaded board.
    const c2 = await store(dataDir, T_SWEEP, 'asset-sweep:after-commit@1')
    resultOf<ReadResult>(await c2.send({ cmd: 'read', userId, boardId }))
    await expect(c2.send({ cmd: 'sweepAssets', userId, boardId })).rejects.toThrow()
    expect(await c2.exited).toBe('SIGKILL')
    expect(await listDir(join(dir, 'assets'))).toEqual([doomed.id, kept.id].sort())
    expect(await listDir(join(dir, 'assets', doomed.id))).toEqual([
      '1024.webp',
      '256.webp',
      '2560.webp',
    ])

    // The commit is durable: the record is gone; the files are orphans.
    const c3 = await store(dataDir, T_SWEEP)
    const read = resultOf<ReadResult>(await c3.send({ cmd: 'read', userId, boardId }))
    expect(read.revision).toBe(before + 1)
    expect(read.recovered).toBe(false)
    const state = parseBoard(read.text).state
    expect([...(state?.assets.keys() ?? [])]).toEqual([kept.id])

    // The next sweep deletes the record-less files (no commit), and nothing else.
    const swept = resultOf<AssetSweepResult>(await c3.send({ cmd: 'sweepAssets', userId, boardId }))
    expect(swept).toEqual({ removed: [], freedBytes: doomed.bytes })
    expect(resultOf<ReadResult>(await c3.send({ cmd: 'read', userId, boardId })).revision).toBe(
      before + 1,
    )
    expect(await listDir(join(dir, 'assets'))).toEqual([kept.id])
    expect(await listDir(join(dir, 'assets', kept.id))).toHaveLength(3)
    expect(
      resultOf<AssetSweepResult>(await c3.send({ cmd: 'sweepAssets', userId, boardId })),
    ).toEqual({ removed: [], freedBytes: 0 })
    await c3.close()
    expect(await c3.exited).toBeNull()
  })
})
