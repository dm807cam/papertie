import { type Board, type Note, stateFromRecords, type Yarn } from '@papertie/core'
import { createBoardStore } from '../../src/store/boardStore'
import { EdgeSides, pinSides } from '../../src/yarn/edgeSides'

const T0 = '2026-11-07T10:00:00.000Z'
const nid = (n: number) => `note_${String(n).padStart(26, '0')}`
const yid = (n: number) => `yarn_${String(n).padStart(26, '0')}`
const BOARD: Board = {
  type: 'board',
  schemaVersion: 6,
  id: `board_${'0'.repeat(25)}1`,
  name: 'Test',
  revision: 0,
  clients: {},
  createdAt: T0,
  updatedAt: T0,
}
const note = (n: number, x: number, y: number): Note => ({
  type: 'note',
  id: nid(n),
  x,
  y,
  w: 220,
  h: 160,
  z: n,
  paper: 'cream',
  style: 'rustic',
  text: `N${n}`,
  image: null,
  createdAt: T0,
  updatedAt: T0,
})
const yarn = (n: number, notes: number[], pins?: Record<string, string>): Yarn => ({
  type: 'yarn',
  id: yid(n),
  noteIds: notes.map(nid),
  color: 'indigo',
  label: '',
  ...(pins === undefined ? {} : { pins }),
  createdAt: T0,
  updatedAt: T0,
})

describe('pinSides', () => {
  it('names the sides a note carries an edge pin on: facing each thread neighbour, left or right', () => {
    const s = stateFromRecords(BOARD, [
      note(1, 0, 0),
      note(2, 400, 0),
      note(3, 0, -400),
      note(4, -400, 20),
      yarn(1, [1, 2]),
      yarn(2, [1, 3]),
    ])
    expect(pinSides(s, nid(1))).toBe('right')
    expect(pinSides(s, nid(2))).toBe('left')
    // Above: a top edge pin, beside no title line.
    expect(pinSides(s, nid(3))).toBe('')
    expect(pinSides(s, nid(4))).toBe('')
    const both = stateFromRecords(BOARD, [
      note(1, 0, 0),
      note(2, 400, 0),
      note(4, -400, 20),
      yarn(1, [4, 1, 2]),
    ])
    expect(pinSides(both, nid(1))).toBe('left right')
  })

  it('leaves out an end tied at the hanging pin', () => {
    const s = stateFromRecords(BOARD, [
      note(1, 0, 0),
      note(2, 400, 0),
      yarn(1, [1, 2], { [nid(1)]: 'hanging' }),
    ])
    expect(pinSides(s, nid(1))).toBe('')
    expect(pinSides(s, nid(2))).toBe('left')
  })
})

describe('EdgeSides', () => {
  it('tells a mounted note when a neighbour moves to its other side, and not for a text edit', () => {
    const store = createBoardStore(
      stateFromRecords(BOARD, [note(1, 0, 0), note(2, 400, 0), yarn(1, [1, 2])]),
      undefined,
      () => T0,
    )
    const sides = new EdgeSides(store)
    let told = 0
    sides.subscribe(nid(1), () => told++)
    expect(sides.get(nid(1))).toBe('right')
    store.commit([{ op: 'note.update', id: nid(2), set: { text: 'renamed' } }])
    expect(told).toBe(0)
    store.commit([{ op: 'note.update', id: nid(2), set: { x: -400 } }])
    expect(told).toBe(1)
    expect(sides.get(nid(1))).toBe('left')
  })
})
