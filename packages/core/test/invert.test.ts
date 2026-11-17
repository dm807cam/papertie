import fc from 'fast-check'
import {
  type ApplyCtx,
  applyBatch,
  applyLenient,
  applyOp,
  type BoardState,
  invertBatch,
  invertOp,
  type Op,
  OpError,
  stateFromRecords,
  stripTimestamps,
  validateInvariants,
} from '../src/index'
import { fixtureId, makeAsset, makeBoard, makeNote, makeYarn, T0 } from './fixtures'

const a = fixtureId('note', 1)
const b = fixtureId('note', 2)
const c = fixtureId('note', 3)
const d = fixtureId('note', 4)
const e = fixtureId('note', 5)
const ghost = fixtureId('note', 99)
const y1 = fixtureId('yarn', 1)
const y2 = fixtureId('yarn', 2)
const y3 = fixtureId('yarn', 3)
const assetId = fixtureId('asset', 1)

const T1 = '2026-10-27T11:00:00.000Z'
const T2 = '2026-10-27T12:00:00.000Z'
const T3 = '2026-10-27T13:00:00.000Z'
const ctx: ApplyCtx = { now: T1 }
const undoCtx: ApplyCtx = { now: T2 }

/** Board with notes a–d, one asset, y1 = [a,b,c] (coloured, labelled) and y2 = [c,d]. */
function fixture(): BoardState {
  return stateFromRecords(makeBoard({ revision: 3 }), [
    makeAsset({ id: assetId }),
    makeNote({ id: a, z: 0, text: 'a', image: { assetId, frame: 'print' } }),
    makeNote({ id: b, z: 1, text: 'b' }),
    makeNote({ id: c, z: 2, text: 'c' }),
    makeNote({ id: d, z: 3, text: 'd' }),
    makeYarn([a, b, c], { id: y1, color: 'indigo', label: 'plot' }),
    makeYarn([c, d], { id: y2 }),
  ])
}

const noteIdsOf = (s: BoardState, id: string) => s.yarns.get(id)?.noteIds

/** Apply `op`, then its inverse; both as atomic batches. */
function roundTrip(s: BoardState, op: Op): { after: BoardState; undone: BoardState; inv: Op[] } {
  const inv = invertOp(s, op)
  const after = applyBatch(s, [op], ctx)
  const undone = applyBatch(after, inv, undoCtx)
  return { after, undone, inv }
}

describe('stripTimestamps', () => {
  it('drops updatedAt everywhere but keeps createdAt and everything else', () => {
    const s = fixture()
    const stripped = stripTimestamps(s) as {
      board: Record<string, unknown>
      notes: Record<string, unknown>[]
      yarns: Record<string, unknown>[]
      assets: Record<string, unknown>[]
    }
    expect(stripped.board).not.toHaveProperty('updatedAt')
    expect(stripped.board).toHaveProperty('createdAt', T0)
    expect(stripped.board).toHaveProperty('revision', 3)
    for (const r of [...stripped.notes, ...stripped.yarns, ...stripped.assets]) {
      expect(r).not.toHaveProperty('updatedAt')
      expect(r).toHaveProperty('createdAt', T0)
    }
    expect(stripped.notes.map((n) => n.id)).toEqual([a, b, c, d])
  })

  it('is insensitive to updatedAt and map insertion order, sensitive to content', () => {
    const s = fixture()
    const reordered = stateFromRecords(
      { ...s.board, updatedAt: T3 },
      [...s.yarns.values(), ...[...s.notes.values()].reverse(), ...s.assets.values()].map((r) =>
        r.type === 'asset' ? r : { ...r, updatedAt: T3 },
      ),
    )
    expect(stripTimestamps(reordered)).toEqual(stripTimestamps(s))
    const changed = applyOp(s, { op: 'note.update', id: a, set: { x: 5 } }, ctx)
    expect(stripTimestamps(changed)).not.toEqual(stripTimestamps(s))
  })

  it('does not mutate the state', () => {
    const s = fixture()
    const before = structuredClone({ board: s.board, notes: [...s.notes.values()] })
    stripTimestamps(s)
    expect({ board: s.board, notes: [...s.notes.values()] }).toEqual(before)
  })
})

describe('invertOp: every row of the inverse table round-trips', () => {
  const cases: Array<[string, Op]> = [
    ['note.create', { op: 'note.create', note: makeNote({ id: e, text: 'e', z: 9 }) }],
    ['note.update', { op: 'note.update', id: a, set: { x: 40, text: 'moved', image: null } }],
    ['note.delete (thread closes up)', { op: 'note.delete', id: b }],
    ['note.delete (one thread closes up, one is deleted)', { op: 'note.delete', id: c }],
    ['note.delete (first note of a thread)', { op: 'note.delete', id: a }],
    ['yarn.create', { op: 'yarn.create', yarn: makeYarn([d, a], { id: y3, color: 'lilac' }) }],
    ['yarn.update', { op: 'yarn.update', id: y1, set: { color: 'lilac', label: 'new' } }],
    ['yarn.insertNote', { op: 'yarn.insertNote', id: y1, noteId: d, afterNoteId: a }],
    ['yarn.insertNote (prepend)', { op: 'yarn.insertNote', id: y2, noteId: a, afterNoteId: null }],
    ['yarn.removeNote (middle)', { op: 'yarn.removeNote', id: y1, noteId: b }],
    ['yarn.removeNote (first)', { op: 'yarn.removeNote', id: y1, noteId: a }],
    ['yarn.removeNote (yarn deleted)', { op: 'yarn.removeNote', id: y2, noteId: d }],
    ['yarn.delete', { op: 'yarn.delete', id: y1 }],
    ['board.update', { op: 'board.update', set: { name: 'Renamed' } }],
  ]

  it.each(cases)('%s', (_name, op) => {
    const s = fixture()
    const { after, undone, inv } = roundTrip(s, op)
    expect(after).not.toBe(s)
    expect(inv.length).toBeGreaterThan(0)
    expect(stripTimestamps(undone)).toEqual(stripTimestamps(s))
    expect(validateInvariants(undone)).toEqual([])
  })

  it('asset.add inverts to [] (assets are garbage-collected, not undone)', () => {
    const s = fixture()
    const asset = makeAsset({ id: fixtureId('asset', 2), sha256: 'b'.repeat(64) })
    expect(invertOp(s, { op: 'asset.add', asset })).toEqual([])
  })

  it('uses exactly the inverse ops from the table', () => {
    const s = fixture()
    expect(invertOp(s, { op: 'note.create', note: makeNote({ id: e }) })).toEqual([
      { op: 'note.delete', id: e },
    ])
    expect(invertOp(s, { op: 'note.update', id: a, set: { x: 40, image: null } })).toEqual([
      { op: 'note.update', id: a, set: { x: 0, image: { assetId, frame: 'print' } } },
    ])
    expect(invertOp(s, { op: 'note.delete', id: c })).toEqual([
      { op: 'note.create', note: s.notes.get(c) },
      { op: 'yarn.insertNote', id: y1, noteId: c, afterNoteId: b },
      { op: 'yarn.create', yarn: s.yarns.get(y2) },
    ])
    expect(invertOp(s, { op: 'note.delete', id: a })).toEqual([
      { op: 'note.create', note: s.notes.get(a) },
      { op: 'yarn.insertNote', id: y1, noteId: a, afterNoteId: null },
    ])
    expect(invertOp(s, { op: 'yarn.create', yarn: makeYarn([a, d], { id: y3 }) })).toEqual([
      { op: 'yarn.delete', id: y3 },
    ])
    expect(invertOp(s, { op: 'yarn.update', id: y1, set: { label: 'x' } })).toEqual([
      { op: 'yarn.update', id: y1, set: { label: 'plot' } },
    ])
    expect(invertOp(s, { op: 'yarn.insertNote', id: y1, noteId: d, afterNoteId: null })).toEqual([
      { op: 'yarn.removeNote', id: y1, noteId: d },
    ])
    expect(invertOp(s, { op: 'yarn.removeNote', id: y1, noteId: c })).toEqual([
      { op: 'yarn.insertNote', id: y1, noteId: c, afterNoteId: b },
    ])
    expect(invertOp(s, { op: 'yarn.removeNote', id: y2, noteId: c })).toEqual([
      { op: 'yarn.create', yarn: s.yarns.get(y2) },
    ])
    expect(invertOp(s, { op: 'yarn.delete', id: y1 })).toEqual([
      { op: 'yarn.create', yarn: s.yarns.get(y1) },
    ])
    expect(invertOp(s, { op: 'board.update', set: { name: 'Renamed' } })).toEqual([
      { op: 'board.update', set: { name: 'Test board' } },
    ])
  })
})

describe('invertOp: ops that would be no-ops invert to []', () => {
  const noops: Array<[string, Op]> = [
    [
      'note.create of an identical note',
      { op: 'note.create', note: makeNote({ id: b, z: 1, text: 'b' }) },
    ],
    ['note.update to equal values', { op: 'note.update', id: b, set: { text: 'b', z: 1 } }],
    ['note.delete of a missing note', { op: 'note.delete', id: ghost }],
    ['yarn.create of an identical yarn', { op: 'yarn.create', yarn: makeYarn([c, d], { id: y2 }) }],
    ['yarn.update to equal values', { op: 'yarn.update', id: y1, set: { label: 'plot' } }],
    [
      'yarn.insertNote already on the thread',
      { op: 'yarn.insertNote', id: y1, noteId: b, afterNoteId: null },
    ],
    ['yarn.removeNote not on the thread', { op: 'yarn.removeNote', id: y1, noteId: d }],
    ['yarn.removeNote on a missing yarn', { op: 'yarn.removeNote', id: y3, noteId: a }],
    ['yarn.delete of a missing yarn', { op: 'yarn.delete', id: y3 }],
    ['board.update to the same name', { op: 'board.update', set: { name: 'Test board' } }],
    ['asset.add of an identical asset', { op: 'asset.add', asset: makeAsset({ id: assetId }) }],
  ]

  it.each(noops)('%s', (_name, op) => {
    const s = fixture()
    expect(applyOp(s, op, ctx)).toBe(s)
    expect(invertOp(s, op)).toEqual([])
  })

  it('an op that cannot apply throws the same OpError as applyOp', () => {
    const s = fixture()
    expect(() => invertOp(s, { op: 'note.update', id: ghost, set: { x: 1 } })).toThrow(OpError)
    expect(() =>
      invertOp(s, { op: 'yarn.insertNote', id: y3, noteId: a, afterNoteId: null }),
    ).toThrow(OpError)
  })

  it('does not mutate the before state', () => {
    const s = fixture()
    const snapshot = stripTimestamps(s)
    const boardRef = s.board
    invertOp(s, { op: 'note.delete', id: c })
    expect(s.board).toBe(boardRef)
    expect(stripTimestamps(s)).toEqual(snapshot)
    expect(s.notes.has(c)).toBe(true)
  })
})

describe('deleting notes from a thread and undoing', () => {
  it('deleting the middle note of [a,b,c] and undoing restores [a,b,c] in order', () => {
    const s = stateFromRecords(makeBoard(), [
      makeNote({ id: a }),
      makeNote({ id: b }),
      makeNote({ id: c }),
      makeYarn([a, b, c], { id: y1 }),
    ])
    const inv = invertOp(s, { op: 'note.delete', id: b })
    const after = applyBatch(s, [{ op: 'note.delete', id: b }], ctx)
    expect(noteIdsOf(after, y1)).toEqual([a, c])
    const undone = applyBatch(after, inv, undoCtx)
    expect(noteIdsOf(undone, y1)).toEqual([a, b, c])
    expect(undone.notes.get(b)).toEqual(s.notes.get(b))
  })

  it('deleting a from [a,b] and undoing restores the yarn with its id, colour and label', () => {
    const original = makeYarn([a, b], { id: y2, color: 'lilac', label: 'motive' })
    const s = stateFromRecords(makeBoard(), [makeNote({ id: a }), makeNote({ id: b }), original])
    const inv = invertOp(s, { op: 'note.delete', id: a })
    const after = applyBatch(s, [{ op: 'note.delete', id: a }], ctx)
    expect(after.yarns.has(y2)).toBe(false)
    const undone = applyBatch(after, inv, undoCtx)
    expect(undone.yarns.get(y2)).toEqual(original)
    expect(undone.notes.get(a)).toEqual(s.notes.get(a))
  })
})

describe('invertBatch', () => {
  it('returns the per-op inverses concatenated in reverse order', () => {
    const s = fixture()
    const ops: Op[] = [
      { op: 'note.create', note: makeNote({ id: e }) },
      { op: 'yarn.insertNote', id: y2, noteId: e, afterNoteId: c },
    ]
    expect(invertBatch(s, ops)).toEqual([
      { op: 'yarn.removeNote', id: y2, noteId: e },
      { op: 'note.delete', id: e },
    ])
  })

  it('computes each inverse against the intermediate state', () => {
    const s = fixture()
    // Deleting b then c: c's inverse must see the thread as [a,c] (y1) and [c,d] (y2).
    const ops: Op[] = [
      { op: 'note.delete', id: b },
      { op: 'note.delete', id: c },
    ]
    const inv = invertBatch(s, ops)
    const after = applyBatch(s, ops, ctx)
    expect(after.yarns.size).toBe(0)
    const undone = applyBatch(after, inv, undoCtx)
    expect(stripTimestamps(undone)).toEqual(stripTimestamps(s))
    expect(noteIdsOf(undone, y1)).toEqual([a, b, c])
  })

  it('round-trips a mixed batch, skipping no-ops', () => {
    const s = fixture()
    const ops: Op[] = [
      { op: 'note.create', note: makeNote({ id: e, text: 'e' }) },
      { op: 'yarn.create', yarn: makeYarn([e, d], { id: y3 }) },
      { op: 'note.update', id: e, set: { x: 10 } },
      { op: 'note.update', id: e, set: { x: 10 } },
      { op: 'yarn.insertNote', id: y1, noteId: e, afterNoteId: b },
      { op: 'yarn.removeNote', id: y1, noteId: a },
      { op: 'note.delete', id: d },
      { op: 'board.update', set: { name: 'Renamed' } },
    ]
    const inv = invertBatch(s, ops)
    const after = applyBatch(s, ops, ctx)
    const undone = applyBatch(after, inv, undoCtx)
    expect(stripTimestamps(undone)).toEqual(stripTimestamps(s))
  })

  it('returns [] for an empty batch and throws like applyBatch on a bad op', () => {
    const s = fixture()
    expect(invertBatch(s, [])).toEqual([])
    expect(() =>
      invertBatch(s, [
        { op: 'note.delete', id: a },
        { op: 'note.update', id: a, set: { x: 1 } },
      ]),
    ).toThrow(OpError)
  })
})

describe('undo after a remote change (applyLenient)', () => {
  it('restores b and appends it when its previous neighbour was deleted remotely', () => {
    const s = stateFromRecords(makeBoard(), [
      makeNote({ id: a }),
      makeNote({ id: b }),
      makeNote({ id: c }),
      makeNote({ id: d }),
      makeYarn([a, b, c, d], { id: y1 }),
    ])
    // 1. Delete b locally and capture the inverse.
    const local: Op[] = [{ op: 'note.delete', id: b }]
    const inverse = invertBatch(s, local)
    expect(inverse).toEqual([
      { op: 'note.create', note: s.notes.get(b) },
      { op: 'yarn.insertNote', id: y1, noteId: b, afterNoteId: a },
    ])
    let current = applyBatch(s, local, ctx)
    expect(noteIdsOf(current, y1)).toEqual([a, c, d])
    // 2. A remote op deletes a.
    current = applyBatch(current, [{ op: 'note.delete', id: a }], { now: T2 })
    expect(noteIdsOf(current, y1)).toEqual([c, d])
    // 3. Undo leniently: b comes back, and insertNote falls back to appending.
    const { state, skipped } = applyLenient(current, inverse, { now: T3 })
    expect(skipped).toEqual([])
    expect(state.notes.get(b)).toEqual(s.notes.get(b))
    expect(noteIdsOf(state, y1)).toEqual([c, d, b])
    // 4. Invariants hold.
    expect(validateInvariants(state)).toEqual([])
  })

  it('skips a yarn.create that can no longer apply because a note was deleted remotely', () => {
    const s = stateFromRecords(makeBoard(), [
      makeNote({ id: a }),
      makeNote({ id: b }),
      makeNote({ id: c }),
      makeYarn([a, b, c], { id: y1 }),
    ])
    const inverse = invertOp(s, { op: 'yarn.delete', id: y1 })
    expect(inverse).toEqual([{ op: 'yarn.create', yarn: s.yarns.get(y1) }])
    let current = applyBatch(s, [{ op: 'yarn.delete', id: y1 }], ctx)
    current = applyBatch(current, [{ op: 'note.delete', id: a }], { now: T2 })
    const { state, skipped } = applyLenient(current, inverse, { now: T3 })
    expect(skipped.length).toBe(1)
    expect(state.yarns.has(y1)).toBe(false)
    expect(validateInvariants(state)).toEqual([])
  })
})

describe('property: invertBatch undoes any applicable batch', () => {
  const noteIds = [1, 2, 3, 4, 5, 6].map((i) => fixtureId('note', i))
  const yarnIds = [1, 2, 3].map((i) => fixtureId('yarn', i))
  const noteId = fc.constantFrom(...noteIds)
  const yarnId = fc.constantFrom(...yarnIds)

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    noteId.map((id): Op => ({ op: 'note.create', note: makeNote({ id }) })),
    fc
      .tuple(noteId, fc.integer({ min: -100, max: 100 }))
      .map(([id, x]): Op => ({ op: 'note.update', id, set: { x } })),
    noteId.map((id): Op => ({ op: 'note.delete', id })),
    fc
      .tuple(yarnId, fc.uniqueArray(noteId, { minLength: 2, maxLength: 4 }))
      .map(([id, ids]): Op => ({ op: 'yarn.create', yarn: makeYarn(ids, { id }) })),
    fc
      .tuple(yarnId, fc.constantFrom(...(['lilac', 'indigo'] as const)))
      .map(([id, color]): Op => ({ op: 'yarn.update', id, set: { color } })),
    fc
      .tuple(yarnId, noteId, fc.option(noteId, { nil: null }))
      .map(([id, n, after]): Op => ({ op: 'yarn.insertNote', id, noteId: n, afterNoteId: after })),
    fc.tuple(yarnId, noteId).map(([id, n]): Op => ({ op: 'yarn.removeNote', id, noteId: n })),
    yarnId.map((id): Op => ({ op: 'yarn.delete', id })),
    fc.constantFrom('A', 'B').map((name): Op => ({ op: 'board.update', set: { name } })),
  )

  it('applying the batch then its inverse restores the state (minus updatedAt)', () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 20 }),
        fc.array(opArb, { maxLength: 20 }),
        (setup, raw) => {
          // Build a random start state, then keep only the ops of `raw` that apply in sequence.
          const start = applyLenient(stateFromRecords(makeBoard(), []), setup, ctx).state
          let walk = start
          const batch: Op[] = []
          for (const op of raw) {
            try {
              walk = applyOp(walk, op, ctx)
              batch.push(op)
            } catch (err) {
              if (!(err instanceof OpError)) throw err
            }
          }
          const inv = invertBatch(start, batch)
          const after = applyBatch(start, batch, ctx)
          const undone = applyBatch(after, inv, undoCtx)
          expect(stripTimestamps(undone)).toEqual(stripTimestamps(start))
        },
      ),
    )
  })
})
