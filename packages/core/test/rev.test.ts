import { describe, expect, it } from 'vitest'
import {
  applyBatch,
  type BoardState,
  commitBatch,
  commitChanges,
  NoteRecordSchema,
  type Op,
  OpError,
  parseBoard,
  serializeBoard,
  stateFromRecords,
  threadsOf,
} from '../src/index'
import { fixtureId, makeAsset, makeBoard, makeNote, makeYarn } from './fixtures'

const NOW = '2026-10-27T12:00:00.000Z'
const tab = fixtureId('tab', 1)
const [n1, n2, n3, n4] = [1, 2, 3, 4].map((i) => fixtureId('note', i)) as [
  string,
  string,
  string,
  string,
]
const [y1, y2] = [1, 2].map((i) => fixtureId('yarn', i)) as [string, string]

/**
 * A board at revision 5: four notes, a three-note thread with a shared pin, a two-note thread.
 * Loaded from its JSONL, so each record's keys are in schema order, as on the server.
 */
function board(): BoardState {
  const built = stateFromRecords(makeBoard({ revision: 5 }), [
    makeNote({ id: n1, rev: 1 }),
    makeNote({ id: n2, rev: 2 }),
    makeNote({ id: n3, rev: 3 }),
    makeNote({ id: n4, rev: 4 }),
    makeYarn([n1, n2, n3], { id: y1, pins: { [n2]: 'p', [n3]: 'p' }, rev: 4 }),
    makeYarn([n3, n4], { id: y2, rev: 5 }),
  ])
  const { state } = parseBoard(serializeBoard(built))
  if (!state) throw new Error('fixture did not load')
  return state
}

const commit = (state: BoardState, ops: Op[], seq = 1) =>
  commitBatch(state, ops, NOW, { clientId: tab, seq })

describe('rev', () => {
  it('rev is stamped on create, update, thread change after note delete', () => {
    const s0 = board()
    const n5 = fixtureId('note', 5)
    const s1 = commit(s0, [{ op: 'note.create', note: makeNote({ id: n5, x: 40 }) }])
    expect(s1.board.revision).toBe(6)
    expect(s1.notes.get(n5)?.rev).toBe(6)

    const s2 = commit(s1, [{ op: 'note.update', id: n1, set: { text: 'changed' } }], 2)
    expect(s2.notes.get(n1)).toMatchObject({ text: 'changed', rev: 7 })

    // Deleting n2 changes y1's noteIds and drops its pin: y1 is stamped; y2 is not touched.
    const s3 = commit(s2, [{ op: 'note.delete', id: n2 }], 3)
    expect(s3.yarns.get(y1)).toMatchObject({ noteIds: [n1, n3], pins: { [n3]: 'p' }, rev: 8 })
    expect(s3.yarns.get(y2)?.rev).toBe(5)

    // Records the batch did not write keep the rev they had.
    expect(s3.notes.get(n3)?.rev).toBe(3)
    expect(s3.notes.get(n4)?.rev).toBe(4)
    expect(s3.notes.get(n5)?.rev).toBe(6)
  })

  it('every yarn op that changes a thread stamps it, pins included', () => {
    const s0 = board()
    const pins = commit(s0, [{ op: 'yarn.update', id: y2, set: { pins: { [n4]: 'q' } } }])
    expect(pins.yarns.get(y2)?.rev).toBe(6)
    const unpinned = commit(s0, [{ op: 'yarn.update', id: y1, set: { pins: null } }])
    expect(unpinned.yarns.get(y1)?.rev).toBe(6)
    const inserted = commit(s0, [{ op: 'yarn.insertNote', id: y2, noteId: n1, afterNoteId: null }])
    expect(inserted.yarns.get(y2)?.rev).toBe(6)
    const removed = commit(s0, [{ op: 'yarn.removeNote', id: y1, noteId: n3 }])
    expect(removed.yarns.get(y1)).toMatchObject({ noteIds: [n1, n2], pins: { [n2]: 'p' }, rev: 6 })
    const y3 = fixtureId('yarn', 3)
    const created = commit(s0, [{ op: 'yarn.create', yarn: makeYarn([n1, n4], { id: y3 }) }])
    expect(created.yarns.get(y3)?.rev).toBe(6)
    const asset = makeAsset()
    const added = commitBatch(s0, [{ op: 'asset.add', asset }], NOW, null)
    expect(added.assets.get(asset.id)?.rev).toBe(6)
  })

  it('a no-op batch stamps nothing; a value the client sent is overwritten', () => {
    const s0 = board()
    const same = commit(s0, [{ op: 'note.update', id: n1, set: { x: makeNote().x } }])
    expect(same.notes.get(n1)).toBe(s0.notes.get(n1))
    const n5 = fixtureId('note', 5)
    const forged = commit(s0, [{ op: 'note.create', note: makeNote({ id: n5, rev: 999 }) }])
    expect(forged.notes.get(n5)?.rev).toBe(6)
  })

  it('a create that repeats a record differing only in rev is the same record, not a conflict', () => {
    const s0 = board()
    const n5 = fixtureId('note', 5)
    const note = makeNote({ id: n5 })
    const s1 = commit(s0, [{ op: 'note.create', note }])
    // The client's copy has no rev (or an older one): applying the create again changes nothing.
    expect(applyBatch(s1, [{ op: 'note.create', note }], { now: NOW })).toBe(s1)
    const again = { op: 'note.create', note: { ...note, rev: 3 } } as Op
    expect(applyBatch(s1, [again], { now: NOW })).toBe(s1)
    // A real difference still is a conflict.
    const other = { op: 'note.create', note: { ...note, text: 'other' } } as Op
    expect(() => applyBatch(s1, [other], { now: NOW })).toThrow(OpError)
    const yarn = s0.yarns.get(y2)
    if (!yarn) throw new Error('fixture')
    const { rev: _rev, ...bare } = yarn
    expect(applyBatch(s0, [{ op: 'yarn.create', yarn: bare }], { now: NOW })).toBe(s0)
  })

  it('applyBatch alone never stamps rev; only the commit does', () => {
    const s0 = board()
    const next = applyBatch(s0, [{ op: 'note.update', id: n1, set: { x: 7 } }], { now: NOW })
    expect(next.notes.get(n1)?.rev).toBe(1)
  })

  it('commitChanges reports every id the batch wrote, deleted ones included', () => {
    const s0 = board()
    const { state, written } = commitChanges(
      s0,
      [
        { op: 'note.delete', id: n4 },
        { op: 'note.update', id: n1, set: { y: 9 } },
      ],
      NOW,
      null,
    )
    expect([...written.notes].sort()).toEqual([n1, n4].sort())
    // y2 lost n4 and, with one note left, was deleted.
    expect([...written.yarns]).toEqual([y2])
    expect(state.yarns.has(y2)).toBe(false)
    expect(state.notes.get(n1)?.rev).toBe(6)
  })

  it('rev survives serialize → parse → serialize byte for byte, last in its line', () => {
    const s1 = commit(board(), [{ op: 'note.update', id: n1, set: { text: '€' } }])
    const text = serializeBoard(s1)
    const parsed = parseBoard(text)
    expect(parsed.integrity).toBe('ok')
    expect(parsed.issues).toEqual([])
    if (!parsed.state) throw new Error('did not load')
    expect(serializeBoard(parsed.state)).toBe(text)
    const line = text.split('\n').find((l) => l.includes(n1)) ?? ''
    expect(line.endsWith(',"rev":6}')).toBe(true)
  })

  it('rev is optional, a non-negative integer', () => {
    const note = makeNote()
    expect(NoteRecordSchema.safeParse(note).success).toBe(true)
    expect(NoteRecordSchema.safeParse({ ...note, rev: 0 }).success).toBe(true)
    for (const rev of [-1, 1.5, '3', null]) {
      expect(NoteRecordSchema.safeParse({ ...note, rev }).success).toBe(false)
    }
  })

  it('threadsOf names the threads through a note from the kept index', () => {
    const s1 = commit(board(), [{ op: 'note.delete', id: n2 }])
    expect(
      threadsOf(s1, n3)
        .map((y) => y.id)
        .sort(),
    ).toEqual([y1, y2].sort())
    expect(threadsOf(s1, n2)).toEqual([])
    expect(threadsOf(s1, n4).map((y) => y.id)).toEqual([y2])
  })
})
