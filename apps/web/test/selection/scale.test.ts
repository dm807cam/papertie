import {
  applyBatch,
  type BoardState,
  type ClientOp,
  emptyBoardState,
  type Note,
} from '@papertie/core'
import { SpatialIndex } from '../../src/canvas/spatialIndex'
import { TransientOverrides } from '../../src/canvas/transient'
import type { Point } from '../../src/canvas/types'
import { createSelectTool, type ToolPointer } from '../../src/interactions/selectTool'
import { nearestInDirection } from '../../src/selection/keyboardNav'
import { createMarqueeTool } from '../../src/selection/marquee'
import { nextSelection } from '../../src/selection/selection'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const nid = (n: number) => idOf('note', n)
const stateOf = (ops: ClientOp[]): BoardState =>
  applyBatch(emptyBoardState(BOARD_ID, 'T', T0), ops, { now: T0 })

describe('TransientOverrides, a group', () => {
  const a = note(nid(1), { x: 10, y: 20, z: 3 })
  const b = note(nid(2), { x: 100, y: 200, z: 7 })
  const other = note(nid(3), { x: 5, y: 5, z: 1 })

  it('moves every member by one shared delta, without an entry per note', () => {
    const o = new TransientOverrides()
    const v0 = o.version
    o.setGroup(new Set([a.id, b.id]), { dx: 4, dy: -6, dz: 100 })
    expect(o.version).toBeGreaterThan(v0)
    expect(o.effective(a)).toEqual({ ...a, x: 14, y: 14, z: 103 })
    expect(o.effective(b)).toEqual({ ...b, x: 104, y: 194, z: 107 })
    expect(o.effective(other)).toBe(other)
    expect(o.ids()).toEqual([])
    expect(o.has(a.id)).toBe(true)
    expect(o.has(other.id)).toBe(false)
    expect(o.size).toBe(2)
  })

  it('an own override sits on top of the group, and clear() drops both', () => {
    const o = new TransientOverrides()
    o.setGroup(new Set([a.id]), { dx: 1, dy: 1, dz: 0 })
    o.set(a.id, { w: 300 })
    expect(o.effective(a)).toEqual({ ...a, x: 11, y: 21, w: 300 })
    o.clear()
    expect(o.effective(a)).toBe(a)
    expect(o.group).toBeNull()
    expect(o.has(a.id)).toBe(false)
  })
})

describe('a group drag costs the same for 5,000 selected notes as for 2', () => {
  const COUNT = 5000
  const ops: ClientOp[] = Array.from({ length: COUNT }, (_, i) => ({
    op: 'note.create' as const,
    note: note(nid(i + 1), { x: (i % 100) * 250, y: Math.floor(i / 100) * 200, z: i + 1 }),
  }))

  function setup(selected: readonly string[]) {
    let state = stateOf(ops)
    const overrides = new TransientOverrides()
    const set = vi.spyOn(overrides, 'set')
    const setGroup = vi.spyOn(overrides, 'setGroup')
    let reads = 0
    const commits: ClientOp[][] = []
    const members: ReadonlySet<string> = new Set(selected)
    const tool = createSelectTool({
      getNote: (id) => {
        reads++
        return state.notes.get(id)
      },
      overrides,
      commit: (o) => {
        commits.push([...o])
        state = applyBatch(state, o, { now: T0 })
      },
      select: () => {},
      selection: () => members,
      selectNotes: () => {},
      topZ: () => COUNT,
      zoom: () => 1,
      aspectOf: () => undefined,
    })
    const at = (p: Point, noteId?: string): ToolPointer => ({
      screen: p,
      world: p,
      button: 0,
      shiftKey: false,
      target: noteId === undefined ? {} : { noteId },
    })
    return { tool, set, setGroup, commits, at, reads: () => reads, overrides }
  }

  it('moves through one shared delta: no per-note entry, no per-note read, per pointer move', () => {
    const all = Array.from({ length: COUNT }, (_, i) => nid(i + 1))
    const { tool, set, setGroup, at, reads, overrides, commits } = setup(all)
    tool.pointerDown(at({ x: 10, y: 10 }, nid(1)))
    tool.pointerMove(at({ x: 20, y: 10 }, nid(1)))
    const afterBegin = reads()
    for (let i = 0; i < 50; i++) tool.pointerMove(at({ x: 30 + i, y: 10 + i }, nid(1)))
    expect(reads()).toBe(afterBegin)
    expect(set).not.toHaveBeenCalled()
    expect(setGroup).toHaveBeenCalledTimes(51)
    expect(overrides.ids()).toEqual([])
    tool.pointerUp(at({ x: 79, y: 59 }, nid(1)))
    // One batch with every moved note, the lift in the notes' own order.
    expect(commits).toHaveLength(1)
    expect(commits[0]).toHaveLength(COUNT)
    expect(commits[0]?.[0]).toEqual({
      op: 'note.update',
      id: nid(1),
      set: { x: 69, y: 49, z: COUNT + 1 },
    })
    expect(overrides.group).toBeNull()
  })

  it('keeps the whole group inside the coordinate limits with one clamp', () => {
    const { tool, at, commits } = setup([nid(1), nid(2)])
    tool.pointerDown(at({ x: 10, y: 10 }, nid(1)))
    tool.pointerMove(at({ x: 20, y: 10 }, nid(1)))
    tool.pointerUp(at({ x: 50_000_000, y: 10 }, nid(1)))
    const moved = (commits[0] ?? []) as Array<{ set: { x: number } }>
    expect(Math.max(...moved.map((o) => o.set.x))).toBe(10_000_000)
    // They moved together: the gap between them is the one they had.
    expect(moved[1]?.set.x).toBeDefined()
    expect((moved[1]?.set.x ?? 0) - (moved[0]?.set.x ?? 0)).toBe(250)
  })
})

describe('marquee with a big selection', () => {
  it('does not touch the selection while the notes under the band stay the same', () => {
    const before = new Set(Array.from({ length: 2000 }, (_, i) => `n${i}`))
    let hits = ['a', 'b']
    let selection: ReadonlySet<string> = before
    const setSelection = vi.fn((ids: Iterable<string>) => {
      selection = nextSelection(selection, ids, 'replace')
    })
    const tool = createMarqueeTool({
      hits: () => [...hits],
      selection: () => selection,
      setSelection,
      show: () => {},
      done: () => {},
    })
    const p = (x: number, shiftKey: boolean): ToolPointer => ({
      screen: { x, y: 0 },
      world: { x, y: 0 },
      button: 0,
      shiftKey,
      target: {},
    })
    tool.pointerDown(p(0, true))
    tool.pointerMove(p(20, true))
    expect(setSelection).toHaveBeenCalledTimes(1)
    expect(selection.size).toBe(2002)
    for (let x = 21; x < 40; x++) tool.pointerMove(p(x, true))
    // Same two notes under the band all along: nothing set again.
    expect(setSelection).toHaveBeenCalledTimes(1)
    hits = ['a', 'b', 'c']
    tool.pointerMove(p(41, true))
    expect(setSelection).toHaveBeenCalledTimes(2)
    expect(selection.size).toBe(2003)
    // The old selection is still the base: shrinking the band gives some of it back.
    hits = ['a']
    tool.pointerMove(p(42, true))
    expect(selection.size).toBe(2001)
    tool.cancel()
    expect(selection.size).toBe(2000)
  })
})

describe('nearestInDirection stays bounded', () => {
  it('a board crowded beside the cone answers null after a few small queries', () => {
    // A column of 600 notes straight above and below the first note, none of it to its right.
    const ops: ClientOp[] = [{ op: 'note.create', note: note(nid(1), { x: 0, y: 0 }) }]
    for (let i = 1; i <= 600; i++) {
      ops.push({
        op: 'note.create',
        note: note(nid(i + 1), { x: 0, y: (i % 2 === 0 ? 1 : -1) * 300 * Math.ceil(i / 2) }),
      })
    }
    const s = stateOf(ops)
    const idx = new SpatialIndex()
    idx.rebuild(s, new Map())
    const spy = vi.spyOn(idx, 'notesIn')
    expect(nearestInDirection(s, nid(1), 'right', idx)).toBeNull()
    const returned = spy.mock.results.reduce((n, r) => n + (r.value as string[]).length, 0)
    expect(spy.mock.calls.length).toBeLessThanOrEqual(24)
    expect(returned).toBeLessThan(30)
  })

  it('still finds a far note on the axis, and the nearer of two in the cone', () => {
    const s = stateOf([
      { op: 'note.create', note: note(nid(1), { x: 0, y: 0 }) },
      { op: 'note.create', note: note(nid(2), { x: 5_000_000, y: 40 }) },
      { op: 'note.create', note: note(nid(3), { x: 3_000_000, y: 100 }) },
    ])
    const idx = new SpatialIndex()
    idx.rebuild(s, new Map())
    expect(nearestInDirection(s, nid(1), 'right', idx)).toBe(nid(3))
  })

  it('every direction has its own cone', () => {
    const s = stateOf([
      { op: 'note.create', note: note(nid(1), { x: 0, y: 0 }) },
      { op: 'note.create', note: note(nid(2), { x: 400, y: 0 }) },
      { op: 'note.create', note: note(nid(3), { x: -400, y: 0 }) },
      { op: 'note.create', note: note(nid(4), { x: 0, y: 400 }) },
      { op: 'note.create', note: note(nid(5), { x: 0, y: -400 }) },
    ])
    const idx = new SpatialIndex()
    idx.rebuild(s, new Map())
    const go = (d: 'up' | 'down' | 'left' | 'right') => nearestInDirection(s, nid(1), d, idx)
    expect([go('right'), go('left'), go('down'), go('up')]).toEqual([
      nid(2),
      nid(3),
      nid(4),
      nid(5),
    ])
  })
})

// Keeps the `Note` type import honest for the fixtures above.
export type _Fixture = Note
