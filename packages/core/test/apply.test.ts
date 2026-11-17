import fc from 'fast-check'
import {
  type ApplyCtx,
  applyBatch,
  applyLenient,
  applyOp,
  type BoardState,
  ClientOpSchema,
  jsonEqual,
  LIMITS,
  type Note,
  type Op,
  OpBatchSchema,
  OpError,
  OpSchema,
  parseBoard,
  serializeBoard,
  stateFromRecords,
  validateInvariants,
} from '../src/index'
import { fixtureId, makeAsset, makeBoard, makeNote, makeYarn, T0 } from './fixtures'

const a = fixtureId('note', 1)
const b = fixtureId('note', 2)
const c = fixtureId('note', 3)
const d = fixtureId('note', 4)
const ghost = fixtureId('note', 99)
const y1 = fixtureId('yarn', 1)
const y2 = fixtureId('yarn', 2)
const assetId = fixtureId('asset', 1)
const tab = fixtureId('tab', 1)

const T1 = '2026-10-27T11:00:00.000Z'
const ctx: ApplyCtx = { now: T1 }

/** Board with notes a, b, c, d, one asset, and no yarns unless given. */
function fixture(yarns: ReturnType<typeof makeYarn>[] = []): BoardState {
  return stateFromRecords(makeBoard({ revision: 7 }), [
    makeAsset({ id: assetId }),
    makeNote({ id: a, z: 0, text: 'a' }),
    makeNote({ id: b, z: 1, text: 'b' }),
    makeNote({ id: c, z: 2, text: 'c' }),
    makeNote({ id: d, z: 3, text: 'd' }),
    ...yarns,
  ])
}

/** Assert `fn` throws an OpError with `code`, and return it. */
function expectOpError(fn: () => unknown, code: OpError['code']): OpError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(OpError)
    expect((err as OpError).code).toBe(code)
    return err as OpError
  }
  throw new Error(`expected OpError(${code}), nothing was thrown`)
}

/** Deep snapshot of a state's contents, for "unchanged contents" checks. */
function contents(s: BoardState) {
  return {
    board: structuredClone(s.board),
    assets: [...s.assets.entries()].map(([k, v]) => [k, structuredClone(v)]),
    notes: [...s.notes.entries()].map(([k, v]) => [k, structuredClone(v)]),
    yarns: [...s.yarns.entries()].map(([k, v]) => [k, structuredClone(v)]),
  }
}

const noteIdsOf = (s: BoardState, id: string) => s.yarns.get(id)?.noteIds

describe('note.create', () => {
  const e = fixtureId('note', 5)
  const fresh = makeNote({ id: e, text: 'e', createdAt: T0, updatedAt: T0 })

  it('adds the note with its timestamps as given and stamps the board', () => {
    const s = fixture()
    const next = applyOp(s, { op: 'note.create', note: fresh }, ctx)
    expect(next.notes.get(e)).toEqual(fresh)
    expect(next.notes.get(e)?.createdAt).toBe(T0)
    expect(next.notes.get(e)?.updatedAt).toBe(T0)
    expect(next.board.updatedAt).toBe(T1)
    expect(next.board.revision).toBe(7)
    expect(s.notes.has(e)).toBe(false)
  })

  it('an identical re-create is a no-op returning the same state', () => {
    const s = applyOp(fixture(), { op: 'note.create', note: fresh }, ctx)
    expect(applyOp(s, { op: 'note.create', note: { ...fresh } }, ctx)).toBe(s)
  })

  it('a different note with the same id throws conflict', () => {
    const s = fixture()
    expectOpError(
      () => applyOp(s, { op: 'note.create', note: makeNote({ id: a, text: 'other' }) }, ctx),
      'conflict',
    )
  })

  it('the 5001st note throws limit', () => {
    const notes: Note[] = []
    for (let i = 1; i <= LIMITS.maxNotes; i++) notes.push(makeNote({ id: fixtureId('note', i) }))
    const full = stateFromRecords(makeBoard(), notes)
    expect(full.notes.size).toBe(LIMITS.maxNotes)
    const extra = makeNote({ id: fixtureId('note', LIMITS.maxNotes + 1) })
    expectOpError(() => applyOp(full, { op: 'note.create', note: extra }, ctx), 'limit')
  })

  it('an image pointing at a missing asset throws invalid', () => {
    const note = makeNote({ id: e, image: { assetId: fixtureId('asset', 9), frame: 'print' } })
    expectOpError(() => applyOp(fixture(), { op: 'note.create', note }, ctx), 'invalid')
  })

  it('a schema-invalid note throws invalid', () => {
    const note = makeNote({ id: e, w: -5 })
    expectOpError(() => applyOp(fixture(), { op: 'note.create', note }, ctx), 'invalid')
  })
})

describe('note.update', () => {
  it('sets only the given fields and stamps updatedAt', () => {
    const s = fixture()
    const next = applyOp(s, { op: 'note.update', id: b, set: { x: 50, text: 'B' } }, ctx)
    expect(next.notes.get(b)).toEqual({ ...s.notes.get(b), x: 50, text: 'B', updatedAt: T1 })
    expect(next.notes.get(a)).toBe(s.notes.get(a))
    expect(next.board.updatedAt).toBe(T1)
    expect(s.notes.get(b)?.text).toBe('b')
  })

  it('can set an image backed by an existing asset', () => {
    const next = applyOp(
      fixture(),
      { op: 'note.update', id: a, set: { image: { assetId, frame: 'none' } } },
      ctx,
    )
    expect(next.notes.get(a)?.image).toEqual({ assetId, frame: 'none' })
  })

  it('a missing id throws not-found', () => {
    expectOpError(
      () => applyOp(fixture(), { op: 'note.update', id: ghost, set: { x: 1 } }, ctx),
      'not-found',
    )
  })

  it('an image asset not in the state throws invalid', () => {
    const image = { assetId: fixtureId('asset', 9), frame: 'print' } as const
    expectOpError(
      () => applyOp(fixture(), { op: 'note.update', id: a, set: { image } }, ctx),
      'invalid',
    )
  })

  it('a patch producing an invalid record throws invalid', () => {
    const s = fixture()
    expectOpError(() => applyOp(s, { op: 'note.update', id: a, set: { w: -5 } }, ctx), 'invalid')
    const big = 'x'.repeat(LIMITS.maxTextLength + 1)
    expectOpError(
      () => applyOp(s, { op: 'note.update', id: a, set: { text: big } }, ctx),
      'invalid',
    )
  })

  it('a patch with a non-patchable key throws invalid', () => {
    const op = { op: 'note.update', id: a, set: { id: b } } as unknown as Op
    expectOpError(() => applyOp(fixture(), op, ctx), 'invalid')
  })

  it('an update that changes nothing is a no-op', () => {
    const s = fixture()
    expect(applyOp(s, { op: 'note.update', id: a, set: { text: 'a' } }, ctx)).toBe(s)
  })
})

describe('negative zero', () => {
  const e = fixtureId('note', 5)
  const isPlusZero = (v: number | undefined) => Object.is(v, 0)

  it('note.create stores -0 in x, y and z as 0 and keeps negative values', () => {
    const note = makeNote({ id: e, x: -0, y: -0, z: -0 })
    const next = applyOp(fixture(), { op: 'note.create', note }, ctx)
    const stored = next.notes.get(e)
    expect(isPlusZero(stored?.x)).toBe(true)
    expect(isPlusZero(stored?.y)).toBe(true)
    expect(isPlusZero(stored?.z)).toBe(true)
    const below = applyOp(fixture(), { op: 'note.create', note: { ...note, z: -3, x: -1.5 } }, ctx)
    expect(below.notes.get(e)?.z).toBe(-3)
    expect(below.notes.get(e)?.x).toBe(-1.5)
  })

  it('note.update stores -0 as 0', () => {
    const s = applyOp(fixture(), { op: 'note.update', id: a, set: { x: 5, z: -2 } }, ctx)
    const next = applyOp(s, { op: 'note.update', id: a, set: { x: -0, y: -0, z: -0 } }, ctx)
    const stored = next.notes.get(a)
    expect(isPlusZero(stored?.x)).toBe(true)
    expect(isPlusZero(stored?.y)).toBe(true)
    expect(isPlusZero(stored?.z)).toBe(true)
  })

  it('a note created with -0 round-trips through JSONL unchanged', () => {
    const note = makeNote({ id: e, x: -0, z: -0 })
    const next = applyOp(fixture(), { op: 'note.create', note }, ctx)
    expect(parseBoard(serializeBoard(next)).state).toEqual(next)
  })
})

describe('note.delete', () => {
  it('closes up a thread: [a,b,c] minus b is [a,c]', () => {
    const s = fixture([makeYarn([a, b, c], { id: y1 })])
    const next = applyOp(s, { op: 'note.delete', id: b }, ctx)
    expect(next.notes.has(b)).toBe(false)
    expect(noteIdsOf(next, y1)).toEqual([a, c])
    expect(next.yarns.get(y1)?.updatedAt).toBe(T1)
    expect(next.board.updatedAt).toBe(T1)
    expect(noteIdsOf(s, y1)).toEqual([a, b, c])
  })

  it('deletes a thread left with fewer than 2 notes', () => {
    const s = fixture([makeYarn([a, b], { id: y1 }), makeYarn([b, c, d], { id: y2 })])
    const next = applyOp(s, { op: 'note.delete', id: b }, ctx)
    expect(next.yarns.has(y1)).toBe(false)
    expect(noteIdsOf(next, y2)).toEqual([c, d])
    expect(validateInvariants(next)).toEqual([])
  })

  it('deleting a missing note is a no-op', () => {
    const s = fixture()
    expect(applyOp(s, { op: 'note.delete', id: ghost }, ctx)).toBe(s)
  })
})

describe('yarn.create', () => {
  it('adds the yarn', () => {
    const yarn = makeYarn([a, b, c], { id: y1 })
    const next = applyOp(fixture(), { op: 'yarn.create', yarn }, ctx)
    expect(next.yarns.get(y1)).toEqual(yarn)
    expect(next.board.updatedAt).toBe(T1)
  })

  it('a missing note throws not-found', () => {
    const yarn = makeYarn([a, ghost], { id: y1 })
    expectOpError(() => applyOp(fixture(), { op: 'yarn.create', yarn }, ctx), 'not-found')
  })

  it('an identical re-create is a no-op; a different one throws conflict', () => {
    const s = fixture([makeYarn([a, b], { id: y1 })])
    expect(applyOp(s, { op: 'yarn.create', yarn: makeYarn([a, b], { id: y1 }) }, ctx)).toBe(s)
    expectOpError(
      () => applyOp(s, { op: 'yarn.create', yarn: makeYarn([a, c], { id: y1 }) }, ctx),
      'conflict',
    )
  })

  it('a thread with duplicate or too few notes throws invalid', () => {
    const s = fixture()
    expectOpError(
      () => applyOp(s, { op: 'yarn.create', yarn: makeYarn([a, a], { id: y1 }) }, ctx),
      'invalid',
    )
    expectOpError(
      () => applyOp(s, { op: 'yarn.create', yarn: makeYarn([a], { id: y1 }) }, ctx),
      'invalid',
    )
  })
})

describe('yarn.update', () => {
  it('sets colour and label and stamps updatedAt', () => {
    const s = fixture([makeYarn([a, b], { id: y1 })])
    const next = applyOp(s, { op: 'yarn.update', id: y1, set: { label: 'supports' } }, ctx)
    expect(next.yarns.get(y1)).toEqual({ ...s.yarns.get(y1), label: 'supports', updatedAt: T1 })
  })

  it('a missing yarn throws not-found; an over-long label throws invalid', () => {
    const s = fixture([makeYarn([a, b], { id: y1 })])
    expectOpError(
      () => applyOp(s, { op: 'yarn.update', id: y2, set: { color: 'indigo' } }, ctx),
      'not-found',
    )
    const label = 'x'.repeat(LIMITS.maxLabelLength + 1)
    expectOpError(() => applyOp(s, { op: 'yarn.update', id: y1, set: { label } }, ctx), 'invalid')
  })
})

describe('yarn.insertNote (Review Focus 4)', () => {
  const base = () => fixture([makeYarn([a, b], { id: y1 })])
  const insert = (s: BoardState, noteId: string, afterNoteId: string | null) =>
    applyOp(s, { op: 'yarn.insertNote', id: y1, noteId, afterNoteId }, ctx)

  it('afterNoteId null prepends', () => {
    const next = insert(base(), c, null)
    expect(noteIdsOf(next, y1)).toEqual([c, a, b])
    expect(next.yarns.get(y1)?.updatedAt).toBe(T1)
    expect(next.board.updatedAt).toBe(T1)
  })

  it('afterNoteId a inserts after a', () => {
    expect(noteIdsOf(insert(base(), c, a), y1)).toEqual([a, c, b])
  })

  it('afterNoteId no longer on the thread appends at the end', () => {
    expect(noteIdsOf(insert(base(), c, d), y1)).toEqual([a, b, c])
    expect(noteIdsOf(insert(base(), c, ghost), y1)).toEqual([a, b, c])
  })

  it('a note already on the thread is a no-op', () => {
    const s = base()
    expect(insert(s, b, null)).toBe(s)
  })

  it('a missing note throws not-found', () => {
    expectOpError(() => insert(base(), ghost, a), 'not-found')
  })

  it('a missing yarn throws not-found', () => {
    const s = fixture()
    expectOpError(
      () => applyOp(s, { op: 'yarn.insertNote', id: y2, noteId: c, afterNoteId: null }, ctx),
      'not-found',
    )
  })

  it('a thread already at maxThreadNotes throws limit', () => {
    const records: Array<Note | ReturnType<typeof makeYarn>> = []
    const ids: string[] = []
    for (let i = 1; i <= LIMITS.maxThreadNotes + 1; i++) {
      const id = fixtureId('note', i)
      records.push(makeNote({ id }))
      ids.push(id)
    }
    const last = ids.pop() as string
    records.push(makeYarn(ids, { id: y1 }))
    const s = stateFromRecords(makeBoard(), records)
    expectOpError(() => insert(s, last, null), 'limit')
  })
})

describe('yarn.removeNote (Review Focus 4)', () => {
  it('[a,b,c] minus b is [a,c]', () => {
    const s = fixture([makeYarn([a, b, c], { id: y1 })])
    const next = applyOp(s, { op: 'yarn.removeNote', id: y1, noteId: b }, ctx)
    expect(noteIdsOf(next, y1)).toEqual([a, c])
    expect(next.notes.has(b)).toBe(true)
    expect(next.yarns.get(y1)?.updatedAt).toBe(T1)
  })

  it('[a,b] minus a deletes the yarn', () => {
    const s = fixture([makeYarn([a, b], { id: y1 })])
    const next = applyOp(s, { op: 'yarn.removeNote', id: y1, noteId: a }, ctx)
    expect(next.yarns.has(y1)).toBe(false)
    expect(next.board.updatedAt).toBe(T1)
  })

  it('a note not on the thread is a no-op', () => {
    const s = fixture([makeYarn([a, b], { id: y1 })])
    expect(applyOp(s, { op: 'yarn.removeNote', id: y1, noteId: c }, ctx)).toBe(s)
  })

  it('removing from a missing yarn is a no-op', () => {
    const s = fixture()
    expect(applyOp(s, { op: 'yarn.removeNote', id: y1, noteId: a }, ctx)).toBe(s)
  })
})

describe('updates to deleted entities (Review Focus 4)', () => {
  it('note.update on a deleted note throws not-found and rejects the whole batch', () => {
    const s = fixture()
    const deleted = applyOp(s, { op: 'note.delete', id: c }, ctx)
    expectOpError(
      () => applyOp(deleted, { op: 'note.update', id: c, set: { x: 1 } }, ctx),
      'not-found',
    )
    const err = expectOpError(
      () =>
        applyBatch(
          deleted,
          [
            { op: 'note.update', id: a, set: { x: 1 } },
            { op: 'note.update', id: c, set: { x: 1 } },
          ],
          ctx,
        ),
      'not-found',
    )
    expect(err.index).toBe(1)
  })

  it('yarn.delete on a missing yarn is a no-op', () => {
    const s = fixture()
    expect(applyOp(s, { op: 'yarn.delete', id: y1 }, ctx)).toBe(s)
  })

  it('yarn.delete removes an existing yarn', () => {
    const s = fixture([makeYarn([a, b], { id: y1 })])
    const next = applyOp(s, { op: 'yarn.delete', id: y1 }, ctx)
    expect(next.yarns.has(y1)).toBe(false)
    expect(next.board.updatedAt).toBe(T1)
  })
})

describe('board.update and asset.add', () => {
  it('board.update renames and stamps updatedAt without touching revision', () => {
    const s = fixture()
    const next = applyOp(s, { op: 'board.update', set: { name: 'Renamed' } }, ctx)
    expect(next.board).toEqual({ ...s.board, name: 'Renamed', updatedAt: T1 })
    expect(next.board.revision).toBe(7)
  })

  it('board.update with an empty name throws invalid', () => {
    expectOpError(
      () => applyOp(fixture(), { op: 'board.update', set: { name: '' } }, ctx),
      'invalid',
    )
  })

  it('asset.add adds the asset; identical is a no-op; different throws conflict', () => {
    const asset = makeAsset({ id: fixtureId('asset', 2) })
    const s = applyOp(fixture(), { op: 'asset.add', asset }, ctx)
    expect(s.assets.get(asset.id)).toEqual(asset)
    expect(applyOp(s, { op: 'asset.add', asset: { ...asset } }, ctx)).toBe(s)
    expectOpError(
      () => applyOp(s, { op: 'asset.add', asset: { ...asset, bytes: 1 } }, ctx),
      'conflict',
    )
  })
})

describe('applyBatch', () => {
  const batch: Op[] = [
    { op: 'note.update', id: a, set: { x: 10 } },
    { op: 'note.update', id: ghost, set: { x: 10 } },
  ]

  it('is all-or-nothing: the input state is untouched on failure', () => {
    const s = fixture([makeYarn([a, b, c], { id: y1 })])
    const before = contents(s)
    const notesMap = s.notes
    const err = expectOpError(() => applyBatch(s, batch, ctx), 'not-found')
    expect(err.index).toBe(1)
    expect(s.notes).toBe(notesMap)
    expect(contents(s)).toEqual(before)
  })

  it('applies every op in order when all succeed', () => {
    const s = fixture()
    const next = applyBatch(
      s,
      [
        { op: 'yarn.create', yarn: makeYarn([a, b], { id: y1 }) },
        { op: 'yarn.insertNote', id: y1, noteId: c, afterNoteId: a },
        { op: 'note.delete', id: a },
      ],
      ctx,
    )
    expect(noteIdsOf(next, y1)).toEqual([c, b])
    expect(validateInvariants(next)).toEqual([])
  })

  it('a rethrown op error keeps the original as its cause', () => {
    const err = expectOpError(() => applyBatch(fixture(), batch, ctx), 'not-found')
    expect(err.index).toBe(1)
    expect(err.message).toMatch(/^op 1: /)
    expect(err.cause).toBeInstanceOf(OpError)
    expect((err.cause as OpError).code).toBe('not-found')
    expect((err.cause as OpError).index).toBeUndefined()
  })

  it('tolerates invariant violations already present in the input', () => {
    // A dangling yarn the input already had is not this batch's fault.
    const broken = stateFromRecords(makeBoard(), [
      makeNote({ id: a }),
      makeYarn([a, ghost], { id: y1 }),
    ])
    const next = applyBatch(broken, [{ op: 'board.update', set: { name: 'x' } }], ctx)
    expect(next.board.name).toBe('x')
    expect(validateInvariants(next)).toEqual(validateInvariants(broken))
  })

  it('throws invalid when the batch introduces a new violation (safety net)', () => {
    // Per-op checks keep a sound state sound, so the safety net is reachable only from a state
    // that is already broken in another way: here the yarn map key differs from the record id
    // (an id-prefix violation). Deleting `a` rewrites the thread under the record id and leaves
    // the stale entry under the key pointing at a missing note: a new missing-note violation.
    const keyed = fixtureId('yarn', 7)
    const base = fixture()
    const broken: BoardState = {
      ...base,
      yarns: new Map([[keyed, makeYarn([a, b, c], { id: y1 })]]),
    }
    expect(validateInvariants(broken)).toEqual([{ kind: 'id-prefix', id: keyed }])
    const err = expectOpError(
      () => applyBatch(broken, [{ op: 'note.delete', id: a }], ctx),
      'invalid',
    )
    expect(err.message).toContain(`missing-note on ${keyed}`)
  })
})

describe('a loaded board over the note limit', () => {
  const notes: Note[] = []
  for (let i = 1; i <= LIMITS.maxNotes + 1; i++) {
    notes.push(makeNote({ id: fixtureId('note', i), z: i }))
  }
  const loaded = parseBoard(serializeBoard(stateFromRecords(makeBoard(), notes))).state
  if (!loaded) throw new Error('fixture did not load')

  it('loads with a too-many-notes violation', () => {
    expect(loaded.notes.size).toBe(LIMITS.maxNotes + 1)
    expect(validateInvariants(loaded)).toEqual([{ kind: 'too-many-notes', id: loaded.board.id }])
  })

  it('accepts board.update and note.update batches', () => {
    expect(
      applyBatch(loaded, [{ op: 'board.update', set: { name: 'Renamed' } }], ctx).board.name,
    ).toBe('Renamed')
    const moved = applyBatch(loaded, [{ op: 'note.update', id: a, set: { x: 5 } }], ctx)
    expect(moved.notes.get(a)?.x).toBe(5)
  })

  it('accepts a note.delete, which brings it back under the limit', () => {
    const next = applyBatch(loaded, [{ op: 'note.delete', id: a }], ctx)
    expect(next.notes.size).toBe(LIMITS.maxNotes)
    expect(validateInvariants(next)).toEqual([])
  })

  it('still rejects creating another note', () => {
    const extra = makeNote({ id: fixtureId('note', LIMITS.maxNotes + 2) })
    const err = expectOpError(
      () => applyBatch(loaded, [{ op: 'note.create', note: extra }], ctx),
      'limit',
    )
    expect(err.index).toBe(0)
  })
})

describe('ctx.now validation', () => {
  const bad = [
    'yesterday',
    '2026-10-27T11:00:00.000+02:00',
    '2026-10-27',
    '',
    123 as unknown as string,
    undefined as unknown as string,
  ]
  const op: Op = { op: 'note.delete', id: b }

  it.each(bad)('applyOp, applyBatch and applyLenient reject now = %j untouched', (now) => {
    const s = fixture([makeYarn([a, b, c], { id: y1 })])
    const before = contents(s)
    expectOpError(() => applyOp(s, op, { now }), 'invalid')
    expectOpError(() => applyBatch(s, [op], { now }), 'invalid')
    expectOpError(() => applyLenient(s, [op], { now }), 'invalid')
    expect(contents(s)).toEqual(before)
  })

  it('is checked even when the op would be a no-op', () => {
    const noop: Op = { op: 'note.delete', id: ghost }
    expectOpError(() => applyOp(fixture(), noop, { now: 'yesterday' }), 'invalid')
    expectOpError(() => applyBatch(fixture(), [], { now: 'yesterday' }), 'invalid')
    expectOpError(() => applyLenient(fixture(), [], { now: 'yesterday' }), 'invalid')
  })

  it('a state stamped with a valid now still reloads', () => {
    const next = applyOp(fixture([makeYarn([a, b, c], { id: y1 })]), op, ctx)
    expect(parseBoard(serializeBoard(next)).state).toEqual(next)
  })
})

describe('applyLenient', () => {
  it('applies the ops that succeed and returns the rest in skipped', () => {
    const s = fixture()
    const ops: Op[] = [
      { op: 'note.update', id: a, set: { x: 10 } },
      { op: 'note.update', id: ghost, set: { x: 10 } },
    ]
    const { state, skipped } = applyLenient(s, ops, ctx)
    expect(state.notes.get(a)?.x).toBe(10)
    expect(skipped).toEqual([ops[1]])
    expect(s.notes.get(a)?.x).toBe(0)
  })
})

describe('schemas', () => {
  const asset = makeAsset()

  it('OpSchema accepts asset.add; ClientOpSchema rejects it', () => {
    expect(OpSchema.safeParse({ op: 'asset.add', asset }).success).toBe(true)
    expect(ClientOpSchema.safeParse({ op: 'asset.add', asset }).success).toBe(false)
  })

  it('patches need at least one key and reject unknown keys', () => {
    expect(OpSchema.safeParse({ op: 'note.update', id: a, set: {} }).success).toBe(false)
    expect(OpSchema.safeParse({ op: 'note.update', id: a, set: { id: b } }).success).toBe(false)
    expect(OpSchema.safeParse({ op: 'yarn.update', id: y1, set: {} }).success).toBe(false)
    expect(
      OpSchema.safeParse({ op: 'yarn.update', id: y1, set: { noteIds: [a, b] } }).success,
    ).toBe(false)
    expect(
      OpSchema.safeParse({ op: 'yarn.update', id: y1, set: { color: 'indigo' } }).success,
    ).toBe(true)
  })

  it('rejects ids with the wrong prefix', () => {
    expect(OpSchema.safeParse({ op: 'note.delete', id: y1 }).success).toBe(false)
    expect(
      OpSchema.safeParse({ op: 'yarn.insertNote', id: y1, noteId: a, afterNoteId: y2 }).success,
    ).toBe(false)
  })

  const update = { op: 'note.update', id: a, set: { x: 1 } }
  const okBatch = { clientId: tab, seq: 1, baseRevision: 0, ops: [update] }

  it('OpBatchSchema accepts a valid batch', () => {
    expect(OpBatchSchema.safeParse(okBatch).success).toBe(true)
    const max = Array.from({ length: LIMITS.maxOpsPerBatch }, () => update)
    expect(OpBatchSchema.safeParse({ ...okBatch, ops: max }).success).toBe(true)
  })

  it('OpBatchSchema rejects 501 ops, seq 0, no ops, asset.add and a non-tab clientId', () => {
    const tooMany = Array.from({ length: LIMITS.maxOpsPerBatch + 1 }, () => update)
    expect(OpBatchSchema.safeParse({ ...okBatch, ops: tooMany }).success).toBe(false)
    expect(OpBatchSchema.safeParse({ ...okBatch, seq: 0 }).success).toBe(false)
    expect(OpBatchSchema.safeParse({ ...okBatch, baseRevision: -1 }).success).toBe(false)
    expect(OpBatchSchema.safeParse({ ...okBatch, ops: [] }).success).toBe(false)
    expect(OpBatchSchema.safeParse({ ...okBatch, ops: [{ op: 'asset.add', asset }] }).success).toBe(
      false,
    )
    expect(OpBatchSchema.safeParse({ ...okBatch, clientId: a }).success).toBe(false)
  })
})

describe('property: every op keeps the invariants', () => {
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
      .tuple(yarnId, noteId, fc.option(noteId, { nil: null }))
      .map(([id, n, after]): Op => ({ op: 'yarn.insertNote', id, noteId: n, afterNoteId: after })),
    fc.tuple(yarnId, noteId).map(([id, n]): Op => ({ op: 'yarn.removeNote', id, noteId: n })),
    yarnId.map((id): Op => ({ op: 'yarn.delete', id })),
  )

  it('applyLenient over random op sequences never breaks the invariants', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        let s = stateFromRecords(makeBoard(), [])
        for (const op of ops) {
          s = applyLenient(s, [op], ctx).state
          expect(validateInvariants(s)).toEqual([])
        }
      }),
    )
  })
})

describe('jsonEqual', () => {
  it('reads values as their JSON would: a key holding undefined is no key at all', () => {
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true)
    expect(jsonEqual({ a: { c: undefined } }, { a: {} })).toBe(true)
    expect(jsonEqual({ b: 1 }, { a: 1 })).toBe(false)
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1, c: 2 })).toBe(false)
    expect(jsonEqual([1, 2], { 0: 1, 1: 2 })).toBe(false)
    expect(jsonEqual({ a: null }, {})).toBe(false)
  })
})
