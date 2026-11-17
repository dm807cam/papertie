import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type BoardState, batchDigest, newId, type Op, parseBoard } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOG_KEYS } from '../../src/log'
import type { CommitAck } from '../../src/store/boardStore'
import { noteCreate } from '../helpers/boards'
import { png } from '../helpers/images'
import {
  boardDirOf,
  call,
  createBoard,
  createUser,
  getBoard,
  postOps,
  type ServerChild,
  spawnServer,
  walk,
} from './serverChild'

let root: string
const children: Array<{ kill(): void }> = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'papertie-crash-'))
})
afterEach(async () => {
  for (const c of children.splice(0)) c.kill()
  await rm(root, { recursive: true, force: true })
})

async function server(dataDir: string, fault?: string) {
  const s = await spawnServer(dataDir, { fault })
  children.push(s)
  return s
}

const tmpFiles = async (dir: string) => (await walk(dir)).filter((p) => p.endsWith('.tmp'))
const listDir = async (dir: string) => {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

function stateOf(text: string): BoardState {
  const r = parseBoard(text)
  expect(r.integrity).toBe('ok')
  expect(r.issues).toEqual([])
  if (!r.state) throw new Error('board did not load')
  return r.state
}

// The store-child fault-point matrix (journal appends, compaction, backups, snapshots) lives in
// journal.crash.test.ts: commits append to the journal, and snapshots are written by compaction.

// ---- server child: uploads, staged parts, external SIGKILL soak --------------------------------

const logEntries = (s: ServerChild) => s.logs.map((l) => JSON.parse(l) as Record<string, unknown>)

const revisionOf = (res: Response) => Number(res.headers.get('X-Papertie-Revision'))

async function upload(s: ServerChild, boardId: string): Promise<Response> {
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(await png(64, 48))], { type: 'image/png' }), 'x.png')
  return call(s, `/api/boards/${boardId}/assets`, { method: 'POST', body: form })
}

interface Delivery {
  body: { clientId: string; seq: number; baseRevision: number; ops: unknown[] }
  noteId: string
  maybeApplied: boolean
}

describe('server child crashes', () => {
  it('asset:after-files: revision unchanged, orphan dir kept and logged, retry gets a new id', async () => {
    const dataDir = join(root, 'data')
    const s1 = await server(dataDir, 'asset:after-files@1')
    const user = await createUser(s1)
    const boardId = await createBoard(s1, user)
    const at = new Date().toISOString()
    expect(
      (
        await postOps(s1, user, boardId, {
          clientId: newId('tab'),
          seq: 1,
          baseRevision: 0,
          ops: [noteCreate({ at })],
        })
      ).status,
    ).toBe(200)

    await expect(upload(s1, boardId)).rejects.toThrow()
    expect(await s1.exited).toBe('SIGKILL')
    const dir = boardDirOf(dataDir, user, boardId)
    const orphans = await listDir(join(dir, 'assets'))
    expect(orphans).toHaveLength(1)
    const orphan = orphans[0] as string
    expect(await listDir(join(dir, 'assets', orphan))).toEqual([
      '1024.webp',
      '256.webp',
      '2560.webp',
    ])

    const s2 = await server(dataDir)
    const res = await getBoard(s2, user, boardId)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Papertie-Recovered')).toBeNull()
    expect(revisionOf(res)).toBe(1)
    const state = stateOf(await res.text())
    expect(state.assets.size).toBe(0)
    // The orphan stays (the asset sweep takes it only after 30 days), reported by count only.
    expect(await listDir(join(dir, 'assets'))).toEqual([orphan])
    const orphanLines = logEntries(s2).filter((l) => l.kind === 'orphan-asset')
    expect(orphanLines).toEqual([
      { level: 'warn', msg: 'orphan assets', kind: 'orphan-asset', count: 1 },
    ])
    for (const entry of logEntries(s2)) {
      for (const k of Object.keys(entry)) expect(['level', 'msg', ...LOG_KEYS]).toContain(k)
    }
    expect(s2.logs.join('\n')).not.toContain(orphan)

    const retry = await upload(s2, boardId)
    expect(retry.status).toBe(201)
    const body = (await retry.json()) as { asset: { id: string }; revision: number }
    expect(body.asset.id).not.toBe(orphan)
    expect(body.revision).toBe(2)
    expect((await listDir(join(dir, 'assets'))).sort()).toEqual([body.asset.id, orphan].sort())
    await s2.stop()
  })

  it('staged:after-part: the stage is gone after restart; resending all parts commits once', async () => {
    const dataDir = join(root, 'data')
    const s1 = await server(dataDir, 'staged:after-part@3')
    const user = await createUser(s1)
    const boardId = await createBoard(s1, user)
    const at = new Date().toISOString()
    const clientId = newId('tab')
    const ops = [0, 1, 2].map((index) => [noteCreate({ at, text: `part ${index}` })])
    const digest = batchDigest(ops as Op[][])
    const parts = ops.map((o, index) => ({
      clientId,
      seq: 1,
      baseRevision: 0,
      ops: o,
      part: { index, count: 3, digest },
    }))
    for (const [i, p] of parts.slice(0, 2).entries()) {
      const res = await postOps(s1, user, boardId, p)
      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({
        staged: true,
        received: [0, 1].slice(0, i + 1),
        count: 3,
      })
    }
    await expect(postOps(s1, user, boardId, parts[2])).rejects.toThrow()
    expect(await s1.exited).toBe('SIGKILL')

    const s2 = await server(dataDir)
    expect(revisionOf(await getBoard(s2, user, boardId))).toBe(0)
    const last = await postOps(s2, user, boardId, parts[2])
    expect(last.status).toBe(202)
    expect(await last.json()).toEqual({ staged: true, received: [2], count: 3 })

    const answers = []
    for (const p of parts) {
      const res = await postOps(s2, user, boardId, p)
      answers.push({ status: res.status, body: (await res.json()) as Record<string, unknown> })
    }
    expect(answers[0]).toEqual({
      status: 202,
      body: { staged: true, received: [0, 2], count: 3 },
    })
    expect(answers[1]).toMatchObject({ status: 200, body: { revision: 1, duplicate: false } })
    expect(answers[2]).toMatchObject({ status: 200, body: { revision: 1, duplicate: true } })
    const res = await getBoard(s2, user, boardId)
    expect(revisionOf(res)).toBe(1)
    expect(stateOf(await res.text()).notes.size).toBe(3)
    await s2.stop()
  })

  it('external SIGKILL soak: 15 rounds of back-to-back batches, killed at 5-200 ms', async () => {
    const dataDir = join(root, 'data')
    let s = await server(dataDir)
    const user = await createUser(s)
    const boardId = await createBoard(s, user)
    const dir = boardDirOf(dataDir, user, boardId)
    const clientId = newId('tab')
    let seq = 0
    let lastAcked = 0
    const ackedNotes: string[] = []
    /** The batch being delivered; `maybeApplied` once a request for it went unanswered. */
    const delivery: { current: Delivery | null } = { current: null }

    const nextBatch = (): Delivery => {
      const noteId = newId('note')
      seq++
      return {
        noteId,
        maybeApplied: false,
        body: {
          clientId,
          seq,
          baseRevision: lastAcked,
          ops: [noteCreate({ id: noteId, at: new Date().toISOString() })],
        },
      }
    }
    const acked = (noteId: string, ack: CommitAck) => {
      lastAcked = Math.max(lastAcked, ack.revision)
      ackedNotes.push(noteId)
      delivery.current = null
    }

    // Each round's restarted server (after its checks) serves the next round's batches.
    for (let round = 1; round <= 15; round++) {
      let killed = false
      const client = (async () => {
        while (!killed) {
          delivery.current ??= nextBatch()
          const batch = delivery.current
          let res: Response
          let ack: CommitAck
          try {
            batch.maybeApplied = true
            res = await postOps(s, user, boardId, batch.body)
            if (res.status === 429) {
              // Refused before the store: this request was not applied. Resend after the window.
              batch.maybeApplied = false
              await sleep(Number(res.headers.get('Retry-After') ?? 1) * 1000)
              continue
            }
            expect(res.status).toBe(200)
            ack = (await res.json()) as CommitAck
          } catch (e) {
            if (killed) return
            throw e
          }
          expect(ack).toMatchObject({ seq: batch.body.seq, duplicate: false })
          expect(ack.revision).toBe(lastAcked + 1)
          acked(batch.noteId, ack)
        }
      })()
      await sleep(5 + Math.random() * 195)
      killed = true
      s.kill()
      expect(await s.exited).toBe('SIGKILL')
      await client

      s = await server(dataDir)
      const res = await getBoard(s, user, boardId)
      expect(res.status).toBe(200)
      expect(res.headers.get('X-Papertie-Recovered')).toBeNull()
      const revision = revisionOf(res)
      const inFlight = delivery.current?.maybeApplied ? 1 : 0
      expect(revision).toBeGreaterThanOrEqual(lastAcked)
      expect(revision).toBeLessThanOrEqual(lastAcked + inFlight)
      const state = stateOf(await res.text())
      for (const id of ackedNotes) expect(state.notes.has(id)).toBe(true)

      // Retry the unacked batch: a duplicate if it was durable, applied otherwise.
      const pendingBatch = delivery.current
      if (pendingBatch) {
        const retry = await postOps(s, user, boardId, pendingBatch.body)
        expect(retry.status).toBe(200)
        const ack = (await retry.json()) as CommitAck
        if (ack.duplicate) {
          expect(revision).toBe(lastAcked + 1)
          expect(ack.revision).toBe(revision)
        } else {
          expect(ack.revision).toBe(revision + 1)
        }
        acked(pendingBatch.noteId, ack)
      }

      const after = await getBoard(s, user, boardId)
      expect(revisionOf(after)).toBe(lastAcked)
      const text = await after.text()
      const noteLines = text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type: string; id?: string })
        .filter((r) => r.type === 'note')
      expect(noteLines.map((n) => n.id).sort()).toEqual([...ackedNotes].sort())
      expect(stateOf(text).notes.size).toBe(seq)
      // No tmp file is left behind. One may be on its way: the restarted server's first commit
      // starts the hour's compaction when the killed one never placed its backup, and that
      // backup is `<name>.compact.tmp` until its rename (seen under load). A
      // stray one would stay, and still fail here.
      await expect.poll(() => tmpFiles(dir), { timeout: 15_000 }).toEqual([])
      expect(await listDir(join(dir, 'quarantine'))).toEqual([])
      stateOf(await readFile(join(dir, 'board.jsonl'), 'utf8'))
    }
    expect(lastAcked).toBe(seq)
    await s.stop()
  }, 600_000)
})
