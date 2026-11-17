import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import {
  type Board,
  type BoardState,
  batchDigest,
  CLIENT_MARK_TTL_MS,
  type ClientMark,
  commitBatch,
  commitChanges,
  commitSteps,
  digestOfHashes,
  emptyBoardState,
  hashPart,
  introducedViolations,
  LIMITS,
  type Op,
  OpError,
  PART_HASH_STEP,
  partHash,
  pruneClients,
  serializeBoard,
  splitOps,
  stateFromRecords,
} from '../src/index'
import { arbBoardState, arbOpScript, toOps } from './arbitraries'
import { fixtureId, makeAsset, makeBoard, makeNote, T0 } from './fixtures'

const NOW = '2026-10-27T12:00:00.000Z'
const tab = fixtureId('tab', 1)
const otherTab = fixtureId('tab', 2)
const noteA = fixtureId('note', 1)

const ENVELOPE = 512
const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length
const msBefore = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString()

function stateAt(revision: number, clients: Board['clients'] = {}): BoardState {
  return stateFromRecords(makeBoard({ revision, clients }), [makeNote({ id: noteA })])
}

const edit: Op = { op: 'note.update', id: noteA, set: { x: 10 } }

describe('commitBatch', () => {
  it('bumps the revision, records the client mark and stamps updatedAt', () => {
    const next = commitBatch(stateAt(3), [edit], NOW, { clientId: tab, seq: 7 })
    expect(next.board.revision).toBe(4)
    expect(next.board.clients[tab]).toEqual({ lastSeq: 7, lastRevision: 4, seenAt: NOW })
    expect(next.board.updatedAt).toBe(NOW)
    expect(next.notes.get(noteA)?.x).toBe(10)
  })

  it('still yields a new revision and records the mark for a no-op batch', () => {
    const state = stateAt(3)
    const next = commitBatch(state, [{ op: 'note.delete', id: fixtureId('note', 99) }], NOW, {
      clientId: tab,
      seq: 1,
    })
    expect(next).not.toBe(state)
    expect(next.board.revision).toBe(4)
    expect(next.board.updatedAt).toBe(NOW)
    expect(next.board.clients[tab]).toEqual({ lastSeq: 1, lastRevision: 4, seenAt: NOW })
    expect(next.notes).toEqual(state.notes)
  })

  it('with a null mark (server-side asset.add) changes no clients entry', () => {
    const clients = { [tab]: { lastSeq: 2, lastRevision: 3, seenAt: msBefore(NOW, 1000) } }
    const next = commitBatch(
      stateAt(3, clients),
      [{ op: 'asset.add', asset: makeAsset() }],
      NOW,
      null,
    )
    expect(next.board.revision).toBe(4)
    expect(next.board.clients).toEqual(clients)
    expect(next.assets.size).toBe(1)
  })

  it('replaces an existing mark for the same client and keeps other clients', () => {
    const other: ClientMark = { lastSeq: 5, lastRevision: 2, seenAt: msBefore(NOW, 1000) }
    const state = stateAt(3, {
      [tab]: { lastSeq: 1, lastRevision: 1, seenAt: msBefore(NOW, 5000) },
      [otherTab]: other,
    })
    const next = commitBatch(state, [edit], NOW, { clientId: tab, seq: 2 })
    expect(next.board.clients[tab]).toEqual({ lastSeq: 2, lastRevision: 4, seenAt: NOW })
    expect(next.board.clients[otherTab]).toEqual(other)
  })

  it('prunes stale marks at commit time', () => {
    const stale = { lastSeq: 1, lastRevision: 1, seenAt: msBefore(NOW, CLIENT_MARK_TTL_MS + 1) }
    const next = commitBatch(stateAt(3, { [otherTab]: stale }), [edit], NOW, {
      clientId: tab,
      seq: 1,
    })
    expect(Object.keys(next.board.clients)).toEqual([tab])
  })

  it('is deterministic: identical inputs serialize to identical bytes', () => {
    const state = stateAt(3, {
      [otherTab]: { lastSeq: 5, lastRevision: 2, seenAt: msBefore(NOW, 1000) },
    })
    const ops: Op[] = [edit, { op: 'note.create', note: makeNote({ id: fixtureId('note', 2) }) }]
    const mark = { clientId: tab, seq: 9 }
    const a = serializeBoard(commitBatch(state, ops, NOW, mark))
    const b = serializeBoard(commitBatch(state, ops, NOW, mark))
    expect(a).toBe(b)
  })

  it('does not depend on the key order of the incoming clients', () => {
    const m1: ClientMark = { lastSeq: 1, lastRevision: 1, seenAt: msBefore(NOW, 1000) }
    const m2: ClientMark = { lastSeq: 2, lastRevision: 2, seenAt: msBefore(NOW, 2000) }
    const s1 = stateAt(3, { [tab]: m1, [otherTab]: m2 })
    const s2 = stateAt(3, { [otherTab]: m2, [tab]: m1 })
    const mark = { clientId: fixtureId('tab', 3), seq: 1 }
    expect(serializeBoard(commitBatch(s1, [edit], NOW, mark))).toBe(
      serializeBoard(commitBatch(s2, [edit], NOW, mark)),
    )
  })

  it('propagates OpError and leaves the input state untouched', () => {
    const state = stateAt(3)
    const before = serializeBoard(state)
    const bad: Op = { op: 'note.update', id: fixtureId('note', 99), set: { x: 1 } }
    let thrown: unknown
    try {
      commitBatch(state, [edit, bad], NOW, { clientId: tab, seq: 1 })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(OpError)
    expect((thrown as OpError).code).toBe('not-found')
    expect((thrown as OpError).index).toBe(1)
    expect(state.board.revision).toBe(3)
    expect(serializeBoard(state)).toBe(before)
  })

  it('rejects an invalid now', () => {
    expect(() => commitBatch(stateAt(3), [edit], 'yesterday', null)).toThrow(OpError)
  })

  it('starts from a fresh board at revision 0', () => {
    const empty = emptyBoardState(fixtureId('board', 1), 'B', T0)
    const next = commitBatch(empty, [], NOW, { clientId: tab, seq: 1 })
    expect(next.board.revision).toBe(1)
  })
})

describe('pruneClients', () => {
  const mark = (seenAt: string): ClientMark => ({ lastSeq: 1, lastRevision: 1, seenAt })

  it('keeps a mark exactly 90 days old and drops one 1 ms older', () => {
    expect(CLIENT_MARK_TTL_MS).toBe(90 * 86_400_000)
    const out = pruneClients(
      {
        [tab]: mark(msBefore(NOW, CLIENT_MARK_TTL_MS)),
        [otherTab]: mark(msBefore(NOW, CLIENT_MARK_TTL_MS + 1)),
      },
      NOW,
    )
    expect(Object.keys(out)).toEqual([tab])
  })

  it('keeps a mark whose seenAt is in the future', () => {
    const out = pruneClients({ [tab]: mark('2099-01-01T00:00:00.000Z') }, NOW)
    expect(Object.keys(out)).toEqual([tab])
  })

  it('depends only on the supplied now', () => {
    const clients = { [tab]: mark('2026-01-01T00:00:00.000Z') }
    const early = pruneClients(clients, '2026-02-01T00:00:00.000Z')
    const late = pruneClients(clients, '2027-01-01T00:00:00.000Z')
    expect(Object.keys(early)).toEqual([tab])
    expect(late).toEqual({})
    expect(pruneClients(clients, '2027-01-01T00:00:00.000Z')).toEqual(late)
  })

  it('does not mutate its input', () => {
    const clients = { [tab]: mark(msBefore(NOW, CLIENT_MARK_TTL_MS + 1)) }
    pruneClients(clients, NOW)
    expect(Object.keys(clients)).toEqual([tab])
  })
})

describe('splitOps', () => {
  const MB = 1_048_576
  const smallOp = (n: number): Op => ({ op: 'note.delete', id: fixtureId('note', n) })

  it('splits 1,200 small ops into 3 chunks of at most 500, preserving order', () => {
    const ops = Array.from({ length: 1200 }, (_, i) => smallOp(i))
    const chunks = splitOps(ops, MB, LIMITS.maxOpsPerBatch)
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 200])
    expect(chunks.flat()).toEqual(ops)
  })

  it('returns no chunks for no ops', () => {
    expect(splitOps([], MB, 500)).toEqual([])
  })

  it('keeps each chunk within the byte budget plus envelope (multi-byte, max-length texts)', () => {
    const ops: Op[] = Array.from({ length: 30 }, (_, i) => ({
      op: 'note.create',
      note: makeNote({ id: fixtureId('note', i + 1), text: '€'.repeat(LIMITS.maxTextLength) }),
    }))
    const chunks = splitOps(ops, MB, 500)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(bytesOf(chunk) + ENVELOPE).toBeLessThanOrEqual(MB)
    expect(chunks.flat()).toEqual(ops)
  })

  it('packs greedily up to the exact byte boundary', () => {
    const ops = Array.from({ length: 4 }, (_, i) => smallOp(i + 1))
    const two = bytesOf(ops.slice(0, 2)) + ENVELOPE
    expect(splitOps(ops, two, 500).map((c) => c.length)).toEqual([2, 2])
    expect(splitOps(ops, two - 1, 500).map((c) => c.length)).toEqual([1, 1, 1, 1])
    expect(splitOps(ops, two + 100_000, 500).map((c) => c.length)).toEqual([4])
  })

  it('throws limit when a single op exceeds the budget', () => {
    const big: Op = {
      op: 'note.create',
      note: makeNote({ text: 'x'.repeat(LIMITS.maxTextLength) }),
    }
    let thrown: unknown
    try {
      splitOps([smallOp(1), big], 10_000, 500)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(OpError)
    expect((thrown as OpError).code).toBe('limit')
    expect((thrown as OpError).index).toBe(1)
  })

  it('accepts a single op that exactly fills the budget', () => {
    const op = smallOp(1)
    const exact = bytesOf([op]) + ENVELOPE
    expect(splitOps([op], exact, 500)).toEqual([[op]])
    expect(() => splitOps([op], exact - 1, 500)).toThrow(OpError)
  })

  it('throws limit for a non-positive maxOps', () => {
    expect(() => splitOps([smallOp(1)], MB, 0)).toThrow(OpError)
  })
})

describe('batchDigest', () => {
  const smallOp = (n: number): Op => ({ op: 'note.delete', id: fixtureId('note', n) })
  const parts = (n: number) => [[smallOp(n)], [smallOp(n + 1), smallOp(n + 2)]]

  it('is 32 lowercase hex digits, the same for the same parts, another for another batch', () => {
    const d = batchDigest(parts(1))
    expect(d).toMatch(/^[0-9a-f]{32}$/)
    expect(batchDigest(parts(1))).toBe(d)
    expect(batchDigest(parts(4))).not.toBe(d)
    // The same ops cut into other parts are another stage's content too.
    const [a, b] = parts(1)
    expect(batchDigest([[...(a ?? []), ...(b ?? [])]])).not.toBe(d)
  })

  it('a part is hashed in steps of PART_HASH_STEP bytes, to the same hash', () => {
    const big = Array.from(
      { length: 500 },
      (_, i): Op => ({
        op: 'note.update',
        id: fixtureId('note', i + 1),
        set: { text: 'Knot'.repeat(400) },
      }),
    )
    const bytes = new TextEncoder().encode(JSON.stringify(big)).length
    const steps = hashPart(big)
    let pauses = 0
    let r = steps.next()
    while (!r.done) {
      pauses++
      r = steps.next()
    }
    // One pause after the JSON is encoded, then one between each two steps of bytes.
    expect(pauses).toBe(Math.ceil(bytes / PART_HASH_STEP))
    expect(r.value).toBe(partHash(big))
  })

  it('needs no Web Crypto: it is taken with globalThis.crypto undefined', () => {
    const d = batchDigest(parts(1))
    vi.stubGlobal('crypto', undefined)
    try {
      expect(globalThis.crypto).toBeUndefined()
      expect(batchDigest(parts(1))).toBe(d)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("is the digest of its parts' hashes, which can be taken one part at a time", () => {
    const ps = parts(7)
    expect(digestOfHashes(ps.map(partHash))).toBe(batchDigest(ps))
    // SHA-256 of the part's ops as JSON (UTF-8), in hex.
    expect(partHash([])).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
  })
})

describe('commitSteps: a commit a step at a time', () => {
  const now = '2030-01-01T00:00:00.000Z'
  const mark = { clientId: 'tab_01JBPR0T0SAMP1E000000TAB01', seq: 3 }
  const outcome = (run: () => unknown) => {
    try {
      return { ok: serializeBoard(run() as BoardState) }
    } catch (e) {
      return { error: e instanceof OpError ? `${e.code} ${e.message}` : String(e) }
    }
  }
  it('pauses between ops and commits exactly as commitChanges, errors included', () => {
    fc.assert(
      fc.property(
        fc.tuple(arbBoardState(), arbOpScript({ minLength: 2 })),
        fc.boolean(),
        ([s, script], broken) => {
          const ops: unknown[] = toOps(s, script, { now })
          // Now and then an op no commit accepts, partway through.
          if (broken) ops.splice(Math.floor(ops.length / 2), 0, { op: 'note.delete', id: 'nope' })
          const whole = outcome(() => commitChanges(s, ops as Op[], now, mark).state)
          let pauses = 0
          const stepped = outcome(() => {
            const steps = commitSteps(s, ops as Op[], now, mark)
            for (;;) {
              const r = steps.next()
              if (r.done) return r.value.state
              pauses++
            }
          })
          expect(stepped).toEqual(whole)
          if ('ok' in whole) expect(pauses).toBeGreaterThanOrEqual(ops.length)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('the stepped stamp and invariant checks', () => {
  const now = '2030-01-01T00:00:00.000Z'
  it('pause every 64 records and find what the whole-board check finds, in its order', () => {
    // A board of 300 notes, two of them (the 151st and the 190th) showing one photo; a batch of
    // 200 new notes that also removes that photo: only the checks after the ops can see it.
    const asset = makeAsset({ id: fixtureId('asset', 9) })
    const notes = Array.from({ length: 300 }, (_, i) =>
      makeNote({
        id: fixtureId('note', i + 1),
        image: i === 150 || i === 189 ? { assetId: asset.id, frame: 'none' } : null,
      }),
    )
    const base = stateFromRecords(makeBoard(), [asset, ...notes])
    const ops: Op[] = [
      ...Array.from({ length: 200 }, (_, i) => ({
        op: 'note.create' as const,
        note: makeNote({ id: fixtureId('note', 1000 + i) }),
      })),
      { op: 'asset.remove', id: asset.id },
    ]
    const steps = commitSteps(base, ops, now, null)
    let pauses = 0
    let error = ''
    try {
      for (let r = steps.next(); !r.done; r = steps.next()) pauses++
    } catch (e) {
      error = e instanceof OpError ? e.message : String(e)
    }
    // The ops, then the stamp and the checks a few records a step (300 notes scanned for the
    // photo): more pauses than ops.
    expect(pauses).toBeGreaterThan(ops.length + Math.floor(300 / 64))
    // The first violation the whole-board check reports, in its order.
    const after = stateFromRecords(makeBoard(), [
      ...notes,
      ...ops.flatMap((o) => (o.op === 'note.create' ? [o.note] : [])),
    ])
    const first = introducedViolations(base, after)[0]
    expect(first).toEqual({ kind: 'missing-asset', id: fixtureId('note', 151) })
    expect(error).toBe(`batch breaks invariants: ${first?.kind} on ${first?.id}`)
    expect(() => commitChanges(base, ops, now, null)).toThrow(error)
  })

  it('stamp every record the batch wrote, as in one go', () => {
    const base = stateFromRecords(makeBoard(), [])
    const ops = Array.from({ length: 150 }, (_, i) => ({
      op: 'note.create' as const,
      note: makeNote({ id: fixtureId('note', i + 1) }),
    }))
    const r = commitChanges(base, ops, now, null)
    for (const n of r.state.notes.values()) expect(n.rev).toBe(base.board.revision + 1)
    expect(r.state.notes.size).toBe(150)
  })
})
