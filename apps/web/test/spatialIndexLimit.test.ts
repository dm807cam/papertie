import { type Board, type Note, stateFromRecords } from '@papertie/core'
import { SpatialIndex } from '../src/canvas/spatialIndex'

const T0 = '2026-11-07T10:00:00.000Z'
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
  id: `note_${String(n).padStart(26, '0')}`,
  x,
  y,
  w: 220,
  h: 160,
  z: n,
  paper: 'cream',
  style: 'rustic',
  text: '',
  image: null,
  createdAt: T0,
  updatedAt: T0,
})

describe('SpatialIndex.notesInUpTo (a pin on a deep pile)', () => {
  it('gives at most `limit` of the notes meeting a rect, all of them when fewer', () => {
    const pile = Array.from({ length: 2000 }, (_, i) =>
      note(i + 1, (i % 40) * 3, Math.floor(i / 40) * 3),
    )
    const apart = note(5000, 5000, 5000)
    const index = new SpatialIndex()
    index.rebuild(stateFromRecords(BOARD, [...pile, apart]), new Map())
    const at = { x: 110, y: 14, w: 0, h: 0 }
    const some = index.notesInUpTo(at, 48)
    expect(some).toHaveLength(48)
    const all = new Set(index.notesIn(at))
    for (const id of some) expect(all.has(id)).toBe(true)
    expect(index.notesInUpTo({ x: 5100, y: 5050, w: 0, h: 0 }, 48)).toEqual([apart.id])
    expect(index.notesInUpTo({ x: -9000, y: -9000, w: 1, h: 1 }, 48)).toEqual([])
  })
})

describe('the rbush tree notesInUpTo walks', () => {
  it('has the node shape it reads: a root `data` of boxes with `leaf` and `children`', () => {
    const index = new SpatialIndex()
    index.rebuild(
      stateFromRecords(
        BOARD,
        Array.from({ length: 50 }, (_, i) => note(i + 1, i * 300, 0)),
      ),
      new Map(),
    )
    const root = (index as unknown as { notes: { data: unknown } }).notes.data as {
      leaf: unknown
      children: unknown
      minX: unknown
      maxX: unknown
      minY: unknown
      maxY: unknown
    }
    expect(typeof root.leaf).toBe('boolean')
    expect(Array.isArray(root.children)).toBe(true)
    for (const k of ['minX', 'maxX', 'minY', 'maxY'] as const) expect(typeof root[k]).toBe('number')
    // And what the walk finds is what a full search finds, when under the limit.
    const r = { x: 0, y: 0, w: 3000, h: 100 }
    expect(new Set(index.notesInUpTo(r, 1000))).toEqual(new Set(index.notesIn(r)))
  })
})
