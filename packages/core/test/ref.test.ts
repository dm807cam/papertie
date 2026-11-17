import {
  applyBatch,
  ClientOpSchema,
  computeEof,
  invertBatch,
  LIMITS,
  NoteRecordSchema,
  type Op,
  parseBoard,
  searchNotes,
  stateFromRecords,
  stripTimestamps,
} from '../src/index'
import { fixtureId, makeBoard, makeNote } from './fixtures'

/** A note's reference: a free-text `ref` at the note's bottom. */

const ctx = { now: '2026-11-13T12:00:00.000Z' }
const N1 = fixtureId('note', 1)
const N2 = fixtureId('note', 2)
const N3 = fixtureId('note', 3)

/** A file of these lines (the board first), with a matching eof. */
function file(lines: object[], revision = 0): string {
  const body = lines.map((l) => JSON.stringify(l))
  return `${[...body, JSON.stringify(computeEof(body, revision))].join('\n')}\n`
}

describe('a note’s ref', () => {
  it('ref is free text: trimmed, 1..2,000, line breaks allowed; absent is none', () => {
    const ok = (over: object) => NoteRecordSchema.safeParse({ ...makeNote(), ...over }).success
    expect(LIMITS.maxNoteRef).toBe(2_000)
    expect(ok({})).toBe(true)
    expect(ok({ ref: 'Thoreau, Walden, 1854' })).toBe(true)
    expect(ok({ ref: 'Smith J. (2020).\nNature 12(3), 45–67.\ndoi:10.1000/x' })).toBe(true)
    expect(ok({ ref: 'x'.repeat(2_000) })).toBe(true)
    expect(ok({ ref: 'x'.repeat(2_001) })).toBe(false)
    for (const bad of ['', ' ', ' Walden', 'Walden ', '\nWalden', 'Walden\n']) {
      expect(ok({ ref: bad })).toBe(false)
    }
    // No source cards any more: their keys are refused.
    expect(ok({ source: { title: 'Walden' } })).toBe(false)
    expect(ok({ page: '12' })).toBe(false)
  })

  it('note.update ref inverts exactly; null removes it', () => {
    const before = stateFromRecords(makeBoard({ revision: 1 }), [
      makeNote({ id: N1, text: 'Simplify, simplify.' }),
      makeNote({ id: N2, ref: 'Old ref' }),
    ])
    const roundTrip = (ops: Op[]) => {
      for (const op of ops) expect(ClientOpSchema.safeParse(op).success).toBe(true)
      const after = applyBatch(before, ops, ctx)
      const back = applyBatch(after, invertBatch(before, ops), ctx)
      expect(stripTimestamps(back)).toEqual(stripTimestamps(before))
      return after
    }
    const set = roundTrip([{ op: 'note.update', id: N1, set: { ref: 'Thoreau, Walden' } }])
    expect(set.notes.get(N1)).toMatchObject({ ref: 'Thoreau, Walden', text: 'Simplify, simplify.' })
    const gone = roundTrip([{ op: 'note.update', id: N2, set: { ref: null } }])
    expect(Object.keys(gone.notes.get(N2) as object)).not.toContain('ref')
    roundTrip([{ op: 'note.update', id: N2, set: { ref: 'New ref', text: 'With text' } }])
    // A bad ref, and the old keys, are refused by the op schema.
    for (const set of [{ ref: ' x' }, { ref: '' }, { source: { title: 'T' } }, { page: '1' }]) {
      expect(ClientOpSchema.safeParse({ op: 'note.update', id: N1, set }).success).toBe(false)
    }
  })

  it('a note’s ref is searchable', () => {
    const s = stateFromRecords(makeBoard({ revision: 1 }), [
      makeNote({ id: N1, text: 'Simplify, simplify.', ref: 'Thoreau, Walden, 1854' }),
      makeNote({ id: N2, text: 'Nothing here' }),
      makeNote({ id: N3, text: '', ref: 'Emerson, Nature' }),
    ])
    expect(searchNotes(s, 'walden').map((h) => h.id)).toEqual([N1])
    expect(searchNotes(s, 'walden')[0]?.snippet).toContain('Walden')
    expect(searchNotes(s, 'emerson').map((h) => h.id)).toEqual([N3])
    expect(searchNotes(s, 'simplify').map((h) => h.id)).toEqual([N1])
  })
})

describe('a note holds no source', () => {
  it('a note with a source key is refused, line by line', () => {
    const bad = { ...makeNote({ id: N1 }), source: { title: 'Walden' } }
    const r = parseBoard(file([makeBoard(), bad]))
    expect(r.issues.map((i) => i.kind)).toEqual(['invalid-record'])
    expect(r.state?.notes.has(N1)).toBe(false)
  })
})
