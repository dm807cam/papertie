import { applyBatch, isId, MOTIFS, NoteRecordSchema, newId } from '@papertie/core'
import { DEMO_IDS, demoBoard } from '../src/dev/demoBoard'
import {
  createOptions,
  designFields,
  NEW_NOTE,
  NOTE_DECORATIONS,
  type NoteDesign,
  newNoteOp,
  PLAIN_DESIGN,
} from '../src/notes/noteDesign'

const NOW = '2026-10-27T00:00:00.000Z'

describe('newNoteOp', () => {
  it('a blank note centred on the point, on top, that applyBatch accepts', () => {
    const state = demoBoard(NOW)
    const topZ = Math.max(...[...state.notes.values()].map((n) => n.z))
    const op = newNoteOp({ x: 1400.4, y: 900.6 }, topZ, NOW)
    expect(NoteRecordSchema.parse(op.note)).toEqual(op.note)
    expect(isId(op.note.id, 'note')).toBe(true)
    expect(op.note).toEqual({
      type: 'note',
      id: op.note.id,
      x: 1280,
      y: 821,
      w: 240,
      h: 160,
      z: topZ + 1,
      paper: 'cream',
      style: 'rustic',
      text: '',
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    // The id is minted from the clock given (the server's, on a server board).
    expect(op.note.id.slice(5, 15)).toBe(newId('note', Date.parse(NOW)).slice(5, 15))
    const next = applyBatch(state, [op], { now: NOW })
    expect(next.notes.get(op.note.id)).toEqual(op.note)
    expect(next.notes.has(DEMO_IDS.hub)).toBe(true)
  })

  it('wears the design it is given, every decoration of it valid', () => {
    for (const decoration of NOTE_DECORATIONS) {
      const design: NoteDesign = { paper: 'indigo', style: 'smooth', decoration, sheet: 'ochre' }
      const op = newNoteOp({ x: 0, y: 0 }, 0, NOW, design)
      expect(NoteRecordSchema.parse(op.note)).toEqual(op.note)
      expect(op.note).toMatchObject({ paper: 'indigo', style: 'smooth' })
    }
    const fold = newNoteOp({ x: 0, y: 0 }, 0, NOW, { ...PLAIN_DESIGN, decoration: 'fold' })
    expect(fold.note.motif).toBe('fold')
  })

  it('keeps the note inside the coordinate limits', () => {
    const op = newNoteOp({ x: 1e9, y: Number.NaN }, 3, NOW)
    expect(NoteRecordSchema.parse(op.note)).toEqual(op.note)
    expect(op.note).toMatchObject({ w: NEW_NOTE.w, h: NEW_NOTE.h, z: 4 })
  })

  it('is committed under its typing key, so writing joins its undo step', () => {
    expect(createOptions('n1')).toEqual({ coalesceKey: 'text:n1', label: 'new note' })
  })
})

describe('designFields', () => {
  it('sets one decoration, and none for none', () => {
    const plain = designFields(PLAIN_DESIGN)
    expect(plain).toEqual({ paper: 'cream', style: 'rustic' })
    for (const motif of MOTIFS) {
      expect(designFields({ ...PLAIN_DESIGN, decoration: motif })).toEqual({ ...plain, motif })
    }
    expect(designFields({ ...PLAIN_DESIGN, decoration: 'stamp' })).toEqual({
      ...plain,
      stamp: true,
    })
    // The sheet's colour is read for a layered sheet only.
    expect(designFields({ ...PLAIN_DESIGN, decoration: 'layered', sheet: 'indigo' })).toEqual({
      ...plain,
      layered: 'indigo',
    })
  })
})
