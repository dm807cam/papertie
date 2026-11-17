import {
  applyBatch,
  type BoardState,
  type ClientOp,
  emptyBoardState,
  type Note,
} from '@papertie/core'
import { TransientOverrides } from '../../src/canvas/transient'
import type { Point } from '../../src/canvas/types'
import { createSelectTool, type ToolPointer } from '../../src/interactions/selectTool'
import {
  movedCopy,
  nextSelection,
  noteLabel,
  nudgeOps,
  selectedCopy,
} from '../../src/selection/selection'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const A = idOf('note', 1)
const B = idOf('note', 2)
const C = idOf('note', 3)

/** A, B and C side by side (z 1, 2, 3), 200 × 120 each. */
function board(): BoardState {
  const ops: ClientOp[] = [A, B, C].map((id, i) => ({
    op: 'note.create',
    note: note(id, { x: i * 300, z: i + 1 }),
  }))
  return applyBatch(emptyBoardState(BOARD_ID, 'Test', T0), ops, { now: T0 })
}

function setup(initial: readonly string[] = []) {
  let state = board()
  let selection: ReadonlySet<string> = new Set(initial)
  const overrides = new TransientOverrides()
  const commits: Array<{ ops: ClientOp[]; label?: string }> = []
  const tool = createSelectTool({
    getNote: (id) => state.notes.get(id),
    overrides,
    commit: (ops, o) => {
      commits.push({ ops: [...ops], ...(o?.label === undefined ? {} : { label: o.label }) })
      state = applyBatch(state, ops, { now: T0 })
    },
    select: (id) => {
      selection = new Set(id === null ? [] : [id])
    },
    selection: () => selection,
    selectNotes: (ids, mode) => {
      selection = nextSelection(selection, ids, mode)
    },
    topZ: () => Math.max(...[...state.notes.values()].map((n) => n.z)),
    zoom: () => 1,
    aspectOf: () => undefined,
  })
  const at = (
    screen: Point,
    noteId: string | undefined,
    extra: Partial<ToolPointer> = {},
  ): ToolPointer => ({
    screen,
    world: screen,
    button: 0,
    shiftKey: false,
    target: noteId === undefined ? {} : { noteId },
    ...extra,
  })
  return {
    tool,
    overrides,
    commits,
    at,
    selection: () => [...selection],
    note: (id: string) => state.notes.get(id) as Note,
  }
}

describe('nextSelection', () => {
  it('replaces, adds and toggles', () => {
    const cur = new Set([A, B])
    expect([...nextSelection(cur, [C], 'replace')]).toEqual([C])
    expect([...nextSelection(cur, [B, C], 'add')]).toEqual([A, B, C])
    expect([...nextSelection(cur, [B, C], 'toggle')]).toEqual([A, C])
    expect([...nextSelection(cur, [], 'replace')]).toEqual([])
  })

  it('never mutates the set it is given', () => {
    const cur = new Set([A])
    nextSelection(cur, [B], 'add')
    expect([...cur]).toEqual([A])
  })
})

describe('copy', () => {
  it('names a note by its first line, or Empty note', () => {
    expect(noteLabel('Spring trip\nthree days')).toBe('Spring trip')
    expect(noteLabel('\n\n  - first bullet\nrest')).toBe('first bullet')
    expect(noteLabel('   \n ')).toBe('Empty note')
    expect(noteLabel('')).toBe('Empty note')
    expect(noteLabel('x'.repeat(200)).length).toBeLessThanOrEqual(81)
  })

  it('says how many notes were selected and moved', () => {
    expect(selectedCopy(3)).toBe('Selected 3 notes')
    expect(movedCopy(4)).toBe('Moved 4 notes')
    expect(movedCopy(1)).toBe('Moved 1 note')
  })
})

describe('nudgeOps', () => {
  it('moves each note, keeps it inside the coordinate limits and skips what does not move', () => {
    const s = board()
    const ops = nudgeOps(s.notes, [A, B], 10, 0)
    expect(ops).toEqual([
      { op: 'note.update', id: A, set: { x: 10, y: 0 } },
      { op: 'note.update', id: B, set: { x: 310, y: 0 } },
    ])
    const edge = applyBatch(s, [{ op: 'note.update', id: A, set: { x: 10_000_000 - 200 } }], {
      now: T0,
    })
    expect(nudgeOps(edge.notes, [A], 1, 0)).toEqual([])
  })
})

describe('select tool, many notes', () => {
  it('shift-click toggles membership', () => {
    const { tool, selection, commits, at } = setup([A])
    tool.pointerDown(at({ x: 310, y: 10 }, B, { shiftKey: true }))
    tool.pointerUp(at({ x: 310, y: 10 }, B, { shiftKey: true }))
    expect(selection()).toEqual([A, B])
    tool.pointerDown(at({ x: 10, y: 10 }, A, { shiftKey: true }))
    tool.pointerUp(at({ x: 10, y: 10 }, A, { shiftKey: true }))
    expect(selection()).toEqual([B])
    // A shift-click on cork leaves the selection alone.
    tool.pointerDown(at({ x: 900, y: 500 }, undefined, { shiftKey: true }))
    tool.pointerUp(at({ x: 900, y: 500 }, undefined, { shiftKey: true }))
    expect(selection()).toEqual([B])
    expect(commits).toEqual([])
  })

  it('a click on a member keeps the group until the release, then selects just that note', () => {
    const { tool, selection, at } = setup([A, B])
    tool.pointerDown(at({ x: 10, y: 10 }, A))
    expect(selection()).toEqual([A, B])
    tool.pointerUp(at({ x: 10, y: 10 }, A))
    expect(selection()).toEqual([A])
  })

  it('group drag commits one batch, moved notes keep their order on top', () => {
    const { tool, overrides, commits, at, selection, note: get } = setup([A, C])
    tool.pointerDown(at({ x: 10, y: 10 }, C))
    tool.pointerMove(at({ x: 50, y: 40 }, C))
    // Both ride along through one shared move; nothing committed yet.
    expect(overrides.group?.ids).toEqual(new Set([A, C]))
    expect(overrides.ids()).toEqual([])
    expect(commits).toEqual([])
    tool.pointerUp(at({ x: 50, y: 40 }, C))
    expect(selection()).toEqual([A, C])
    expect(commits).toHaveLength(1)
    expect(commits[0]?.label).toBe('move')
    expect(commits[0]?.ops).toEqual([
      { op: 'note.update', id: A, set: { x: 40, y: 30, z: 4 } },
      { op: 'note.update', id: C, set: { x: 640, y: 30, z: 5 } },
    ])
    expect(get(B)).toMatchObject({ x: 300, z: 2 })
    expect(overrides.size).toBe(0)
  })

  it('dragging an unselected note selects it alone and moves only it', () => {
    const { tool, commits, at, selection } = setup([A, B])
    tool.pointerDown(at({ x: 610, y: 10 }, C))
    tool.pointerMove(at({ x: 650, y: 10 }, C))
    tool.pointerUp(at({ x: 650, y: 10 }, C))
    expect(selection()).toEqual([C])
    expect(commits[0]?.ops.map((o) => (o as { id: string }).id)).toEqual([C])
  })

  it('holds every note of a group drag', () => {
    const { tool, at } = setup([A, B])
    tool.pointerDown(at({ x: 10, y: 10 }, A))
    tool.pointerMove(at({ x: 40, y: 10 }, A))
    expect(tool.holds?.(A)).toBe(true)
    expect(tool.holds?.(B)).toBe(true)
    expect(tool.holds?.(C)).toBe(false)
  })
})
