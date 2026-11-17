import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type ApplyCtx,
  applyBatch,
  applyOp,
  type BoardState,
  invertBatch,
  invertOp,
  type Op,
  OpError,
  PIN_KEY_PATTERN,
  parseBoard,
  serializeBoard,
  stateFromRecords,
  stripTimestamps,
  YarnRecordSchema,
} from '../src/index'
import { fixtureId, makeBoard, makeNote, makeYarn } from './fixtures'

const a = fixtureId('note', 1)
const b = fixtureId('note', 2)
const c = fixtureId('note', 3)
const y1 = fixtureId('yarn', 1)
const y2 = fixtureId('yarn', 2)
const ctx: ApplyCtx = { now: '2026-11-02T11:00:00.000Z' }
const undoCtx: ApplyCtx = { now: '2026-11-02T12:00:00.000Z' }

function fixture(pins?: Record<string, string>): BoardState {
  return stateFromRecords(makeBoard({ revision: 3 }), [
    makeNote({ id: a, z: 0 }),
    makeNote({ id: b, z: 1, x: 400 }),
    makeNote({ id: c, z: 2, x: 800 }),
    makeYarn([a, b, c], { id: y1, ...(pins === undefined ? {} : { pins }) }),
  ])
}

function expectOpError(fn: () => unknown, code: OpError['code']): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(OpError)
    expect((err as OpError).code).toBe(code)
    return
  }
  throw new Error('expected an OpError')
}

const yarnOf = (s: BoardState, id = y1) => {
  const y = s.yarns.get(id)
  if (!y) throw new Error('missing yarn')
  return y
}

describe('yarn pins: schema', () => {
  const parses = (over: Record<string, unknown>) =>
    YarnRecordSchema.safeParse({ ...makeYarn([a, b]), ...over }).success

  it("accepts 'hanging' and short group keys for notes on the thread", () => {
    expect(parses({ pins: { [a]: 'hanging' } })).toBe(true)
    expect(parses({ pins: { [a]: 'p1', [b]: 'Ab_-9' } })).toBe(true)
    expect(parses({ pins: { [a]: 'x'.repeat(32) } })).toBe(true)
  })

  it('rejects keys that are not notes on the thread', () => {
    expect(parses({ pins: { [c]: 'p1' } })).toBe(false)
    expect(parses({ pins: { [y1]: 'p1' } })).toBe(false)
    expect(parses({ pins: { 'not-an-id': 'p1' } })).toBe(false)
  })

  it('rejects an empty map, empty or long or odd group keys', () => {
    expect(parses({ pins: {} })).toBe(false)
    expect(parses({ pins: { [a]: '' } })).toBe(false)
    expect(parses({ pins: { [a]: 'x'.repeat(33) } })).toBe(false)
    expect(parses({ pins: { [a]: 'a b' } })).toBe(false)
    expect(parses({ pins: { [a]: 'épingle' } })).toBe(false)
    expect(parses({ pins: { [a]: 1 } })).toBe(false)
    expect(parses({ pins: null })).toBe(false)
  })

  it('exports the key pattern', () => {
    expect(PIN_KEY_PATTERN.test('hanging')).toBe(true)
    expect(PIN_KEY_PATTERN.test('a.b')).toBe(false)
  })

  it('serializes pins after label and round-trips', () => {
    const yarn = { ...makeYarn([a, b], { id: y2 }), pins: { [a]: 'p1' } }
    const s = applyOp(fixture(), { op: 'yarn.create', yarn }, ctx)
    const text = serializeBoard(s)
    const line = text.split('\n').find((l) => l.includes(y2)) ?? ''
    expect(Object.keys(JSON.parse(line))).toEqual([
      'type',
      'id',
      'noteIds',
      'color',
      'label',
      'pins',
      'createdAt',
      'updatedAt',
    ])
    const r = parseBoard(text)
    expect(r.issues).toEqual([])
    expect(r.state?.yarns.get(y2)).toEqual(yarn)
    expect(r.state && serializeBoard(r.state)).toBe(text)
  })

  it('a board without pins round-trips byte-identically and carries no pins key', () => {
    const golden = readFileSync(
      fileURLToPath(new URL('./fixtures/plain-board.jsonl', import.meta.url)),
      'utf8',
    )
    const r = parseBoard(golden)
    expect(r.issues).toEqual([])
    if (r.state) expect(serializeBoard(r.state)).toBe(golden)
    for (const y of r.state?.yarns.values() ?? []) expect('pins' in y).toBe(false)
  })

  it('a yarn.create whose pins name a note off the thread is invalid', () => {
    const yarn = { ...makeYarn([a, b], { id: y2 }), pins: { [c]: 'p1' } }
    expectOpError(() => applyOp(fixture(), { op: 'yarn.create', yarn }, ctx), 'invalid')
  })
})

describe('yarn.update pins', () => {
  it('sets the whole map, replaces it, and null removes it', () => {
    const s1 = applyOp(fixture(), { op: 'yarn.update', id: y1, set: { pins: { [a]: 'p1' } } }, ctx)
    expect(yarnOf(s1).pins).toEqual({ [a]: 'p1' })
    const s2 = applyOp(s1, { op: 'yarn.update', id: y1, set: { pins: { [b]: 'hanging' } } }, ctx)
    expect(yarnOf(s2).pins).toEqual({ [b]: 'hanging' })
    const s3 = applyOp(s2, { op: 'yarn.update', id: y1, set: { pins: null } }, ctx)
    expect('pins' in yarnOf(s3)).toBe(false)
    expect(stripTimestamps(s3)).toEqual(stripTimestamps(fixture()))
  })

  it('the same map in another key order is a no-op', () => {
    const s0 = fixture({ [a]: 'p1', [b]: 'p2' })
    const s1 = applyOp(
      s0,
      { op: 'yarn.update', id: y1, set: { pins: { [b]: 'p2', [a]: 'p1' } } },
      ctx,
    )
    expect(s1).toBe(s0)
  })

  it('drops entries naming a note off the thread, and rejects an empty map', () => {
    const off = fixtureId('note', 9)
    const s0 = fixture()
    expect(applyOp(s0, { op: 'yarn.update', id: y1, set: { pins: { [off]: 'p1' } } }, ctx)).toBe(s0)
    expectOpError(
      () => applyOp(fixture(), { op: 'yarn.update', id: y1, set: { pins: {} } }, ctx),
      'invalid',
    )
  })

  it('inverts to null when there were none, and to the prior map otherwise', () => {
    const s0 = fixture()
    const set: Op = { op: 'yarn.update', id: y1, set: { pins: { [a]: 'p1' } } }
    expect(invertOp(s0, set)).toEqual([{ op: 'yarn.update', id: y1, set: { pins: null } }])
    const s1 = applyBatch(s0, [set], ctx)
    const replace: Op = { op: 'yarn.update', id: y1, set: { pins: { [c]: 'p2' } } }
    expect(invertOp(s1, replace)).toEqual([
      { op: 'yarn.update', id: y1, set: { pins: { [a]: 'p1' } } },
    ])
    const undone = applyBatch(applyBatch(s0, [set], ctx), invertOp(s0, set), undoCtx)
    expect(stripTimestamps(undone)).toEqual(stripTimestamps(s0))
  })
})

describe('taking a note off a thread drops its pin', () => {
  it('yarn.removeNote drops the entry and keeps the others', () => {
    const s0 = fixture({ [a]: 'p1', [b]: 'hanging' })
    const s1 = applyOp(s0, { op: 'yarn.removeNote', id: y1, noteId: b }, ctx)
    expect(yarnOf(s1).noteIds).toEqual([a, c])
    expect(yarnOf(s1).pins).toEqual({ [a]: 'p1' })
  })

  it('yarn.removeNote drops pins altogether when the last entry goes', () => {
    const s1 = applyOp(fixture({ [b]: 'p1' }), { op: 'yarn.removeNote', id: y1, noteId: b }, ctx)
    expect('pins' in yarnOf(s1)).toBe(false)
  })

  it('note.delete drops the entry from every thread it was on', () => {
    const s0 = applyOp(
      fixture({ [b]: 'p1' }),
      {
        op: 'yarn.create',
        yarn: { ...makeYarn([b, c], { id: y2 }), pins: { [b]: 'p1', [c]: 'p2' } },
      },
      ctx,
    )
    const s1 = applyOp(s0, { op: 'note.delete', id: b }, ctx)
    expect('pins' in yarnOf(s1)).toBe(false)
    // y2 is left with one note, so it is deleted.
    expect(s1.yarns.has(y2)).toBe(false)
    const r = parseBoard(serializeBoard(s1))
    expect(r.issues).toEqual([])
  })

  it('undo of removeNote and note.delete restores the pins exactly', () => {
    const s0 = applyOp(
      fixture({ [a]: 'p1', [b]: 'hanging' }),
      {
        op: 'yarn.create',
        yarn: { ...makeYarn([a, b, c], { id: y2 }), pins: { [b]: 'p9' } },
      },
      ctx,
    )
    for (const batch of [
      [{ op: 'yarn.removeNote', id: y1, noteId: b }],
      [{ op: 'yarn.removeNote', id: y2, noteId: b }],
      [{ op: 'note.delete', id: b }],
      [{ op: 'note.delete', id: a }],
      [
        { op: 'yarn.removeNote', id: y1, noteId: a },
        { op: 'yarn.removeNote', id: y1, noteId: b },
      ],
    ] as Op[][]) {
      const inv = invertBatch(s0, batch)
      const undone = applyBatch(applyBatch(s0, batch, ctx), inv, undoCtx)
      expect(stripTimestamps(undone)).toEqual(stripTimestamps(s0))
    }
  })
})

describe('loading repairs pins of missing notes', () => {
  it('a thread that loses a note on load loses its pin too', () => {
    const lines = serializeBoard(fixture({ [a]: 'p1', [c]: 'hanging' })).split('\n')
    // Drop note c's line: the yarn's reference to it dangles.
    const text = lines.filter((l) => !l.includes(`"id":"${c}"`) && !l.includes('"eof"')).join('\n')
    const r = parseBoard(`${text}\n`)
    expect(r.issues.map((i) => i.kind)).toContain('dangling-reference')
    const y = r.state?.yarns.get(y1)
    expect(y?.noteIds).toEqual([a, b])
    expect(y?.pins).toEqual({ [a]: 'p1' })
  })
})

describe('pins after the board changed under an edit (lenient re-apply)', () => {
  const d = fixtureId('note', 4)
  const four = (pins: Record<string, string>) =>
    applyBatch(
      fixture(),
      [
        { op: 'note.create', note: makeNote({ id: d, z: 3, x: 1200 }) },
        { op: 'yarn.insertNote', id: y1, noteId: d, afterNoteId: c },
        { op: 'yarn.update', id: y1, set: { pins } },
      ],
      ctx,
    )

  it('a yarn.update keeps only the entries naming notes still on the thread', () => {
    // c went off the thread before this update was applied.
    const s0 = applyOp(fixture(), { op: 'yarn.removeNote', id: y1, noteId: c }, ctx)
    const s1 = applyOp(
      s0,
      { op: 'yarn.update', id: y1, set: { pins: { [a]: 'p1', [c]: 'p2' } } },
      ctx,
    )
    expect(yarnOf(s1).pins).toEqual({ [a]: 'p1' })
    // Nothing left: no pins at all, and over a thread without pins that changes nothing.
    const s2 = applyOp(s0, { op: 'yarn.update', id: y1, set: { pins: { [c]: 'p2' } } }, ctx)
    expect(s2).toBe(s0)
    const s3 = applyOp(s1, { op: 'yarn.update', id: y1, set: { pins: { [c]: 'p2' } } }, ctx)
    expect('pins' in yarnOf(s3)).toBe(false)
    // A record itself still may not name a note off the thread.
    const yarn = { ...makeYarn([a, b], { id: y2 }), pins: { [c]: 'p1' } }
    expectOpError(() => applyOp(fixture(), { op: 'yarn.create', yarn }, ctx), 'invalid')
  })

  it('undo of a note delete still applies after a pinned sibling was taken off meanwhile', () => {
    const s0 = four({ [a]: 'p1', [b]: 'p2' })
    const batch: Op[] = [{ op: 'note.delete', id: b }]
    const inv = invertBatch(s0, batch)
    const deleted = applyBatch(s0, batch, ctx)
    // Meanwhile a goes off the thread.
    const remote = applyOp(deleted, { op: 'yarn.removeNote', id: y1, noteId: a }, ctx)
    const undone = applyBatch(remote, inv, undoCtx)
    // b's neighbour before it is gone, so it goes back last.
    expect(yarnOf(undone).noteIds).toEqual([c, d, b])
    expect(yarnOf(undone).pins).toEqual({ [b]: 'p2' })
  })

  it('undo of a removeNote still applies after a pinned sibling was taken off meanwhile', () => {
    const s0 = four({ [a]: 'p1', [c]: 'hanging' })
    const batch: Op[] = [{ op: 'yarn.removeNote', id: y1, noteId: c }]
    const inv = invertBatch(s0, batch)
    const remote = applyOp(applyBatch(s0, batch, ctx), { op: 'note.delete', id: a }, ctx)
    const undone = applyBatch(remote, inv, undoCtx)
    expect(yarnOf(undone).noteIds).toEqual([b, c, d])
    expect(yarnOf(undone).pins).toEqual({ [c]: 'hanging' })
  })
})
