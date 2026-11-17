import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type ApplyCtx,
  applyBatch,
  applyOp,
  BoardParser,
  type BoardState,
  invertOp,
  MOTIFS,
  NoteRecordSchema,
  type Op,
  OpError,
  PALETTE,
  parseBoard,
  serializeBoard,
  stateFromRecords,
  stripTimestamps,
  YarnRecordSchema,
} from '../src/index'
import { fixtureId, makeBoard, makeNote, makeYarn } from './fixtures'

const a = fixtureId('note', 1)
const b = fixtureId('note', 2)
const y1 = fixtureId('yarn', 1)
const ctx: ApplyCtx = { now: '2026-10-27T11:00:00.000Z' }
const undoCtx: ApplyCtx = { now: '2026-10-27T12:00:00.000Z' }

function fixture(): BoardState {
  return stateFromRecords(makeBoard({ revision: 3 }), [
    makeNote({ id: a, z: 0 }),
    makeNote({ id: b, z: 1 }),
    makeYarn([a, b], { id: y1 }),
  ])
}

function expectOpError(fn: () => unknown, code: OpError['code']): OpError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(OpError)
    expect((err as OpError).code).toBe(code)
    return err as OpError
  }
  throw new Error('expected an OpError')
}

const noteOf = (s: BoardState, id = a) => {
  const n = s.notes.get(id)
  if (!n) throw new Error('missing note')
  return n
}

describe('decoration vocabularies', () => {
  it('lists the motifs', () => {
    expect(MOTIFS).toEqual(['fold', 'margin', 'dots', 'perforation'])
  })
})

describe('absent means none: a file without decorations stays byte-identical', () => {
  const golden = readFileSync(
    fileURLToPath(new URL('./fixtures/plain-board.jsonl', import.meta.url)),
    'utf8',
  )

  it('a board without decorations parses and serializes byte-identically', () => {
    const r = parseBoard(golden)
    expect(r.integrity).toBe('ok')
    expect(r.issues).toEqual([])
    expect(r.state).not.toBeNull()
    if (r.state) expect(serializeBoard(r.state)).toBe(golden)
  })

  it('parsed records carry no decoration keys at all', () => {
    const r = parseBoard(golden)
    for (const n of r.state?.notes.values() ?? []) {
      for (const k of ['motif', 'stamp', 'layered']) expect(k in n).toBe(false)
    }
  })

  it('editing other fields of an undecorated record adds no decoration keys', () => {
    const s = applyOp(fixture(), { op: 'note.update', id: a, set: { x: 5 } }, ctx)
    expect(Object.keys(noteOf(s))).toEqual(Object.keys(makeNote()))
  })
})

describe('note decoration fields', () => {
  it('accepts every motif, stamp:true and every palette token as layered', () => {
    for (const motif of MOTIFS) {
      expect(NoteRecordSchema.safeParse(makeNote({ motif })).success).toBe(true)
    }
    expect(NoteRecordSchema.safeParse(makeNote({ stamp: true })).success).toBe(true)
    for (const layered of Object.keys(PALETTE)) {
      expect(NoteRecordSchema.safeParse(makeNote({ layered: layered as 'cream' })).success).toBe(
        true,
      )
    }
  })

  it('stamp:false is rejected: only true or absent is valid', () => {
    expect(NoteRecordSchema.safeParse({ ...makeNote(), stamp: false }).success).toBe(false)
    expectOpError(
      () => applyOp(fixture(), { op: 'note.update', id: a, set: { stamp: false } } as never, ctx),
      'invalid',
    )
  })

  it("layered:'nope' is rejected with OpError('invalid')", () => {
    expect(NoteRecordSchema.safeParse({ ...makeNote(), layered: 'nope' }).success).toBe(false)
    expectOpError(
      () =>
        applyOp(fixture(), { op: 'note.update', id: a, set: { layered: 'nope' } } as never, ctx),
      'invalid',
    )
    expectOpError(
      () =>
        applyOp(
          fixture(),
          {
            op: 'note.create',
            note: { ...makeNote({ id: fixtureId('note', 7) }), motif: 'nope' },
          } as never,
          ctx,
        ),
      'invalid',
    )
  })

  it('serializes the decoration keys after image, in the order motif, stamp, layered', () => {
    // Given in the wrong order: ops parse their records, which puts keys in schema order.
    const note = makeNote({
      id: fixtureId('note', 3),
      layered: 'rose',
      stamp: true,
      motif: 'dots',
    })
    const s = applyOp(fixture(), { op: 'note.create', note }, ctx)
    const line =
      serializeBoard(s)
        .split('\n')
        .find((l) => l.includes(note.id)) ?? ''
    expect(Object.keys(JSON.parse(line))).toEqual([
      'type',
      'id',
      'x',
      'y',
      'w',
      'h',
      'z',
      'paper',
      'style',
      'text',
      'image',
      'motif',
      'stamp',
      'layered',
      'createdAt',
      'updatedAt',
    ])
    const r = parseBoard(serializeBoard(s))
    expect(r.state && serializeBoard(r.state)).toBe(serializeBoard(s))
  })

  it('note.update {motif} then {motif:null} leaves no motif key', () => {
    const s0 = fixture()
    const s1 = applyOp(s0, { op: 'note.update', id: a, set: { motif: 'fold' } }, ctx)
    expect(noteOf(s1).motif).toBe('fold')
    const s2 = applyOp(s1, { op: 'note.update', id: a, set: { motif: null } }, ctx)
    expect('motif' in noteOf(s2)).toBe(false)
    expect(stripTimestamps(s2)).toEqual(stripTimestamps(s0))
    expect(serializeBoard(s2).includes('motif')).toBe(false)
  })

  it('null removes stamp and layered too, and a null on an absent key is a no-op', () => {
    const s1 = applyOp(
      fixture(),
      { op: 'note.update', id: a, set: { stamp: true, layered: 'indigo' } },
      ctx,
    )
    expect(noteOf(s1)).toMatchObject({ stamp: true, layered: 'indigo' })
    const s2 = applyOp(s1, { op: 'note.update', id: a, set: { stamp: null, layered: null } }, ctx)
    expect('stamp' in noteOf(s2)).toBe(false)
    expect('layered' in noteOf(s2)).toBe(false)
    const s3 = applyOp(s2, { op: 'note.update', id: a, set: { motif: null } }, undoCtx)
    expect(s3).toBe(s2)
  })

  it('a patch mixing a set and a null applies both', () => {
    const s1 = applyOp(fixture(), { op: 'note.update', id: a, set: { motif: 'dots' } }, ctx)
    const s2 = applyOp(s1, { op: 'note.update', id: a, set: { motif: null, stamp: true } }, ctx)
    expect('motif' in noteOf(s2)).toBe(false)
    expect(noteOf(s2).stamp).toBe(true)
  })

  it('null is not valid for the required fields', () => {
    expectOpError(
      () => applyOp(fixture(), { op: 'note.update', id: a, set: { paper: null } } as never, ctx),
      'invalid',
    )
  })

  it('invertOp of setting motif on a note without one yields {motif:null}, and undo restores it', () => {
    const s0 = fixture()
    const op: Op = { op: 'note.update', id: a, set: { motif: 'fold' } }
    const inv = invertOp(s0, op)
    expect(inv).toEqual([{ op: 'note.update', id: a, set: { motif: null } }])
    const after = applyBatch(s0, [op], ctx)
    const undone = applyBatch(after, inv, undoCtx)
    expect(stripTimestamps(undone)).toEqual(stripTimestamps(s0))
    expect('motif' in noteOf(undone)).toBe(false)
  })

  it('invertOp of removing a motif restores the previous value', () => {
    const s0 = applyOp(fixture(), { op: 'note.update', id: a, set: { motif: 'perforation' } }, ctx)
    const op: Op = { op: 'note.update', id: a, set: { motif: null } }
    const inv = invertOp(s0, op)
    expect(inv).toEqual([{ op: 'note.update', id: a, set: { motif: 'perforation' } }])
    const undone = applyBatch(applyBatch(s0, [op], ctx), inv, undoCtx)
    expect(stripTimestamps(undone)).toEqual(stripTimestamps(s0))
  })

  it('a decorated note round-trips through note.create, serialize and parse', () => {
    const note = makeNote({
      id: fixtureId('note', 3),
      motif: 'margin',
      stamp: true,
      layered: 'apricot',
    })
    const s = applyOp(fixture(), { op: 'note.create', note }, ctx)
    const r = parseBoard(serializeBoard(s))
    expect(r.issues).toEqual([])
    expect(r.state?.notes.get(note.id)).toEqual(note)
  })
})

describe('a thread carries no ornament', () => {
  const bowed = { ...makeYarn([a, b], { id: y1 }), bow: 'knot' }
  const text = [makeBoard(), makeNote({ id: a }), makeNote({ id: b, z: 1 }), bowed]
    .map((r) => JSON.stringify(r))
    .join('\n')

  it('a thread with a `bow` key is refused as an invalid record', () => {
    expect(YarnRecordSchema.safeParse(bowed).success).toBe(false)
    const r = parseBoard(text)
    expect(r.issues.filter((i) => i.kind === 'invalid-record').map((i) => i.line)).toEqual([4])
    expect(r.state?.yarns.size).toBe(0)
  })

  it('the keys guard sends it to the schema check when records are deferred', () => {
    const parser = new BoardParser(undefined, { deferRecords: true })
    for (const [i, l] of text.split('\n').entries()) parser.line(l, i + 1)
    const out = parser.finish()
    const issues = 'done' in out ? out.done.issues : out.issues
    expect(issues.filter((i) => i.kind === 'invalid-record').map((i) => i.line)).toEqual([4])
  })

  it('a yarn.update cannot set one', () => {
    expectOpError(
      () => applyOp(fixture(), { op: 'yarn.update', id: y1, set: { bow: 'knot' } } as never, ctx),
      'invalid',
    )
  })
})

describe('signed-off palette', () => {
  it('uses the retuned apricot and lilac yarn dyes', () => {
    expect(PALETTE.apricot.yarn).toBe('#B8364A')
    expect(PALETTE.lilac.yarn).toBe('#9B7EC6')
  })
})
