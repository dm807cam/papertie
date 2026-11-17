import {
  type BoardState,
  batchDigest,
  invertBatch,
  newId,
  type Op,
  parseBoard,
  splitOps,
  stripTimestamps,
} from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBoard, noteCreate, postOps, readBoardFile, tabNow } from './helpers/boards'
import type { TestUser } from './helpers/client'
import { startTestServer, type TestServer } from './helpers/harness'

const NOW = '2026-10-27T10:00:00.000Z'
const MIB = 1_048_576

let server: TestServer
let user: TestUser
let board: string

async function start(config: Parameters<typeof startTestServer>[0] = {}) {
  server = await startTestServer({
    config: {
      ...config?.config,
    },
  })
  user = server.user
  board = await createBoard(user)
}

beforeEach(() => start())
afterEach(() => server.close())

const stateOf = (): BoardState => {
  const { state } = parseBoard(readBoardFile(server, user.id, board).toString('utf8'))
  if (!state) throw new Error('board does not parse')
  return state
}

/** Two batch digests (32 hex digits: the first 16 bytes of a SHA-256). */
const MINE = 'a'.repeat(32)
const THEIRS = 'b'.repeat(32)

const part = (
  clientId: string,
  seq: number,
  index: number,
  count: number,
  ops: unknown[],
  baseRevision = 0,
  digest: string = MINE,
) => ({
  clientId,
  seq,
  baseRevision,
  ops,
  part: { index, count, digest },
})

const smallOps = () => [noteCreate({ at: NOW })]

describe('staged transactions', () => {
  it('commits a large undo as one revision', async () => {
    const clientId = tabNow(server)
    const ids: string[] = []
    let seq = 0
    // 600 notes of 20,000 chars, 50 per batch: each body is just under the 1 MiB limit.
    for (let b = 0; b < 12; b++) {
      const ops = Array.from({ length: 50 }, () => {
        const id = newId('note')
        ids.push(id)
        return noteCreate({ id, text: 'x'.repeat(20_000), at: NOW })
      })
      seq++
      const res = await postOps(user, board, { clientId, seq, baseRevision: seq - 1, ops })
      expect(res.status, `create batch ${b}`).toBe(200)
    }
    const before = stateOf()
    expect(before.board.revision).toBe(12)

    // One gesture deletes all 600 in two forward batches of at most 500 ids.
    const deletes: Op[] = ids.map((id) => ({ op: 'note.delete', id }))
    for (const chunk of [deletes.slice(0, 500), deletes.slice(500)]) {
      seq++
      const res = await postOps(user, board, {
        clientId,
        seq,
        baseRevision: seq - 1,
        ops: chunk,
      })
      expect(res.status).toBe(200)
    }
    expect(stateOf().notes.size).toBe(0)
    const revisionBeforeUndo = stateOf().board.revision
    expect(revisionBeforeUndo).toBe(14)

    const inverse = invertBatch(before, deletes)
    expect(Buffer.byteLength(JSON.stringify(inverse))).toBeGreaterThan(MIB)
    const parts = splitOps(inverse, MIB, 500)
    expect(parts.length).toBeGreaterThanOrEqual(12)
    expect(parts.length).toBeLessThanOrEqual(64)

    seq++
    for (const [index, ops] of parts.slice(0, -1).entries()) {
      const res = await postOps(
        user,
        board,
        part(clientId, seq, index, parts.length, ops, revisionBeforeUndo),
      )
      expect(res.status, `part ${index}`).toBe(202)
      expect(await res.json()).toEqual({
        staged: true,
        received: Array.from({ length: index + 1 }, (_, i) => i),
        count: parts.length,
      })
    }
    expect(stateOf().board.revision).toBe(revisionBeforeUndo)

    const last = parts.length - 1
    const done = await postOps(
      user,
      board,
      part(clientId, seq, last, parts.length, parts[last] ?? [], revisionBeforeUndo),
    )
    expect(done.status).toBe(200)
    expect(await done.json()).toMatchObject({
      revision: revisionBeforeUndo + 1,
      duplicate: false,
      clientId,
      seq,
    })

    const after = stateOf()
    expect(after.board.revision).toBe(revisionBeforeUndo + 1)
    // The board header carries revision and client marks, which legitimately differ.
    const strip = (s: BoardState) => ({ ...(stripTimestamps(s) as object), board: null })
    expect(strip(after)).toEqual(strip(before))
  })

  it('commits parts that arrive out of order', async () => {
    const clientId = tabNow(server)
    const parts = [0, 1, 2].map((i) => part(clientId, 1, i, 3, smallOps()))
    const bodies: unknown[] = []
    for (const i of [2, 0]) bodies.push(await (await postOps(user, board, parts[i])).json())
    expect(bodies).toEqual([
      { staged: true, received: [2], count: 3 },
      { staged: true, received: [0, 2], count: 3 },
    ])
    const res = await postOps(user, board, parts[1])
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ revision: 1, duplicate: false })
    expect(stateOf().notes.size).toBe(3)
  })

  it('commits the ops in index order', async () => {
    const clientId = tabNow(server)
    const create = noteCreate({ at: NOW })
    const move = { op: 'note.update', id: create.note.id, set: { x: 5 } }
    // The update only applies after the create, which is part 0 but arrives last.
    expect((await postOps(user, board, part(clientId, 1, 1, 2, [move]))).status).toBe(202)
    expect((await postOps(user, board, part(clientId, 1, 0, 2, [create]))).status).toBe(200)
    expect(stateOf().notes.get(create.note.id)?.x).toBe(5)
  })

  it('a resent part is idempotent', async () => {
    const clientId = tabNow(server)
    const p0 = part(clientId, 1, 0, 3, smallOps())
    for (let i = 0; i < 2; i++) {
      const res = await postOps(user, board, p0)
      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({ staged: true, received: [0], count: 3 })
    }
    expect((await postOps(user, board, part(clientId, 1, 1, 3, smallOps()))).status).toBe(202)
    const res = await postOps(user, board, part(clientId, 1, 2, 3, smallOps()))
    expect(res.status).toBe(200)
    expect(stateOf().notes.size).toBe(3)
  })

  it('replaying any part after the commit is a duplicate', async () => {
    const clientId = tabNow(server)
    const parts = [0, 1, 2].map((i) => part(clientId, 1, i, 3, smallOps()))
    for (const p of parts) await postOps(user, board, p)
    expect(stateOf().board.revision).toBe(1)
    for (const p of parts) {
      const res = await postOps(user, board, p)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ revision: 1, duplicate: true, now: null })
    }
    expect(stateOf().board.revision).toBe(1)
    expect(stateOf().notes.size).toBe(3)
  })

  it('rejects the whole transaction when the combined batch is invalid', async () => {
    const clientId = tabNow(server)
    const bad = { op: 'note.update', id: newId('note'), set: { x: 5 } }
    const before = readBoardFile(server, user.id, board)
    expect((await postOps(user, board, part(clientId, 1, 0, 3, smallOps()))).status).toBe(202)
    expect((await postOps(user, board, part(clientId, 1, 1, 3, smallOps()))).status).toBe(202)
    const res = await postOps(user, board, part(clientId, 1, 2, 3, [bad]))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'rejected', code: 'not-found', index: 2 })
    expect(readBoardFile(server, user.id, board).equals(before)).toBe(true)

    // The stage is gone: part 0 starts a fresh one.
    const fresh = await postOps(user, board, part(clientId, 1, 0, 3, smallOps()))
    expect(fresh.status).toBe(202)
    expect(await fresh.json()).toEqual({ staged: true, received: [0], count: 3 })
  })

  it('a part whose count differs is 409 stage-mismatch and discards the stage', async () => {
    const clientId = tabNow(server)
    expect((await postOps(user, board, part(clientId, 1, 0, 3, smallOps()))).status).toBe(202)
    const res = await postOps(user, board, part(clientId, 1, 1, 4, smallOps()))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'stage-mismatch' })
    const fresh = await postOps(user, board, part(clientId, 1, 1, 4, smallOps()))
    expect(await fresh.json()).toEqual({ staged: true, received: [1], count: 4 })
  })

  it('a part whose baseRevision differs is 409 stage-mismatch', async () => {
    const clientId = tabNow(server)
    expect((await postOps(user, board, part(clientId, 1, 0, 2, smallOps(), 0))).status).toBe(202)
    const res = await postOps(user, board, part(clientId, 1, 1, 2, smallOps(), 1))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'stage-mismatch' })
  })

  it('an idle stage expires after 5 minutes', async () => {
    const clientId = tabNow(server)
    const parts = [0, 1, 2].map((i) => part(clientId, 1, i, 3, smallOps()))
    for (const p of parts.slice(0, 2)) expect((await postOps(user, board, p)).status).toBe(202)
    server.clock.advance(300_001)
    expect(server.deps.staging?.sweep()).toBe(1)
    const res = await postOps(user, board, parts[2])
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ staged: true, received: [2], count: 3 })
    expect(stateOf().board.revision).toBe(0)
  })

  it('an idle stage is also swept by the next staged request', async () => {
    const clientId = tabNow(server)
    expect((await postOps(user, board, part(clientId, 1, 0, 2, smallOps()))).status).toBe(202)
    server.clock.advance(300_001)
    const res = await postOps(user, board, part(clientId, 1, 1, 2, smallOps()))
    expect(await res.json()).toEqual({ staged: true, received: [1], count: 2 })
  })
})

describe('staging limits', () => {
  it('over the per-board byte cap is 503 stage-full', async () => {
    await server.close()
    await start({ config: { limits: { stageBytesPerBoard: 2_000_000 } } })
    const clientId = tabNow(server)
    // About 975,000 bytes per part: two fit in 2,000,000, the third does not.
    const bigPart = (index: number) =>
      part(
        clientId,
        1,
        index,
        4,
        Array.from({ length: 48 }, () => noteCreate({ text: 'x'.repeat(20_000), at: NOW })),
      )
    expect((await postOps(user, board, bigPart(0))).status).toBe(202)
    expect((await postOps(user, board, bigPart(1))).status).toBe(202)
    const res = await postOps(user, board, bigPart(2))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'stage-full' })
    // Resending a part that is already staged replaces it and stays within the cap.
    const again = await postOps(user, board, bigPart(1))
    expect(again.status).toBe(202)
  })

  it('a single part of 1,048,577 bytes is 413 too-large', async () => {
    const res = await postOps(user, board, 'x'.repeat(1_048_577))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'too-large' })
  })

  it("a part whose digest differs from the stage's is 409 stage-mismatch and discards the stage", async () => {
    const clientId = tabNow(server)
    // Another page's batch under the same seq, base and part count: all its parts but one.
    for (const i of [1, 2]) {
      const res = await postOps(user, board, part(clientId, 1, i, 3, smallOps(), 0, THEIRS))
      expect(res.status).toBe(202)
    }
    // This page's parts, named as the client names them (core's `batchDigest`).
    const ops = [0, 1, 2].map(() => smallOps())
    const digest = batchDigest(ops as Op[][])
    const mine = ops.map((o, i) => part(clientId, 1, i, 3, o, 0, digest))
    const clash = await postOps(user, board, mine[0])
    expect(clash.status).toBe(409)
    expect(await clash.json()).toEqual({ error: 'stage-mismatch' })
    expect(stateOf().board.revision).toBe(0)
    // Its parts are gone: this page's go into a fresh stage and commit alone.
    expect(await (await postOps(user, board, mine[0])).json()).toEqual({
      staged: true,
      received: [0],
      count: 3,
    })
    await postOps(user, board, mine[1])
    const res = await postOps(user, board, mine[2])
    expect(res.status).toBe(200)
    const ids = mine.map((p) => (p.ops[0] as { note: { id: string } }).note.id)
    expect([...stateOf().notes.keys()].sort()).toEqual(ids.sort())
  })

  it('a part with the same digest goes on with the stage, from whichever page sends it', async () => {
    const clientId = tabNow(server)
    const parts = [0, 1, 2].map((i) => part(clientId, 1, i, 3, smallOps(), 0, MINE))
    await postOps(user, board, parts[0])
    await postOps(user, board, parts[1])
    // A new page of the tab, with the same batch: it sends the last part and the stage commits.
    const res = await postOps(user, board, parts[2])
    expect(res.status).toBe(200)
    expect(stateOf().notes.size).toBe(3)
  })

  it('a digest that is not 32 lowercase hex digits, or none, is 400', async () => {
    const clientId = tabNow(server)
    const { part: p, ...batch } = part(clientId, 1, 0, 3, smallOps())
    const bare = await postOps(user, board, { ...batch, part: { index: p.index, count: p.count } })
    expect(bare.status).toBe(400)
    for (const digest of ['', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(65)]) {
      const res = await postOps(user, board, part(clientId, 1, 0, 3, smallOps(), 0, digest))
      expect(res.status, JSON.stringify(digest)).toBe(400)
    }
  })

  it('part index at or past count, or count over 64, is 400', async () => {
    const clientId = tabNow(server)
    for (const [index, count] of [
      [3, 3],
      [0, 65],
      [0, 1],
    ] as const) {
      const res = await postOps(user, board, part(clientId, 1, index, count, smallOps()))
      expect(res.status, `${index}/${count}`).toBe(400)
    }
  })
})
