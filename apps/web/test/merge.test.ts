import { applyBatch, type BoardState, type ClientOp, emptyBoardState, LIMITS } from '@papertie/core'
import { UndoStack } from '../src/history/UndoStack'
import {
  facing,
  MERGE,
  mergeable,
  mergedCopy,
  mergedText,
  mergeOps,
  mergeText,
  pickTarget,
  retieOps,
} from '../src/interactions/merge'
import { BOARD_ID, idOf, note, T0 } from './helpers/fakeServer'

const LATER = '2026-10-30T10:00:00.000Z'

/** The target: 200 × 120 at the origin. */
const T = { x: 0, y: 0, w: 200, h: 120 }

describe('facing', () => {
  it('finds the dragged note on each side within the gap', () => {
    expect(facing({ x: 210, y: 10, w: 200, h: 120 }, T, 1)).toEqual({
      side: 'right',
      gap: 10,
      lo: 10,
      hi: 120,
    })
    expect(facing({ x: -210, y: 0, w: 200, h: 120 }, T, 1)).toMatchObject({
      side: 'left',
      gap: 10,
    })
    expect(facing({ x: 20, y: 130, w: 200, h: 120 }, T, 1)).toEqual({
      side: 'below',
      gap: 10,
      lo: 20,
      hi: 200,
    })
    expect(facing({ x: 0, y: -125, w: 200, h: 120 }, T, 1)).toMatchObject({
      side: 'above',
      gap: 5,
    })
  })

  it('measures the gap in screen px: the world gap allowed grows as the camera zooms out', () => {
    const at = (gap: number) => ({ x: 200 + gap, y: 0, w: 200, h: 120 })
    expect(facing(at(MERGE.gapPx), T, 1)).not.toBeNull()
    expect(facing(at(MERGE.gapPx + 1), T, 1)).toBeNull()
    expect(facing(at(MERGE.gapPx * 2), T, 0.5)).not.toBeNull()
    expect(facing(at(MERGE.gapPx * 2 + 2), T, 0.5)).toBeNull()
    expect(facing(at(MERGE.gapPx / 2 + 1), T, 2)).toBeNull()
  })

  it('rejects overlapping notes (beyond a 2 px touch), however much they overlap', () => {
    expect(facing({ x: 200 - MERGE.touchPx, y: 0, w: 200, h: 120 }, T, 1)).toMatchObject({
      side: 'right',
      gap: -MERGE.touchPx,
    })
    expect(facing({ x: 197, y: 0, w: 200, h: 120 }, T, 1)).toBeNull()
    expect(facing({ x: 100, y: 40, w: 200, h: 120 }, T, 1)).toBeNull()
    expect(facing({ x: 50, y: 30, w: 60, h: 60 }, T, 1)).toBeNull()
  })

  it('needs the notes side by side over 40% of the shorter one', () => {
    // 120 high both: 48 px of shared height is 40%.
    expect(facing({ x: 210, y: 72, w: 200, h: 120 }, T, 1)).toMatchObject({ lo: 72, hi: 120 })
    expect(facing({ x: 210, y: 73, w: 200, h: 120 }, T, 1)).toBeNull()
    // A short note beside a tall one: its own height is the measure.
    expect(facing({ x: 210, y: 90, w: 200, h: 60 }, T, 1)).toMatchObject({ lo: 90, hi: 120 })
    expect(facing({ x: 210, y: 97, w: 200, h: 60 }, T, 1)).toBeNull()
    // Corner to corner is not side by side.
    expect(facing({ x: 205, y: 125, w: 200, h: 120 }, T, 1)).toBeNull()
  })
})

describe('pickTarget', () => {
  it('takes the smallest gap, then the longest shared edge', () => {
    const dragged = { x: 210, y: 0, w: 200, h: 120 }
    const near = { id: 'a', rect: { x: 0, y: 0, w: 205, h: 120 } }
    const far = { id: 'b', rect: T }
    expect(pickTarget(dragged, [far, near], 1)?.id).toBe('a')
    const half = { id: 'c', rect: { x: 0, y: 60, w: 200, h: 120 } }
    expect(pickTarget(dragged, [half, far], 1)?.id).toBe('b')
    // A touch (a little overlap) counts as no gap, not less than none.
    const touch = { id: 'd', rect: { x: 0, y: 60, w: 212, h: 120 } }
    const flush = { id: 'e', rect: { x: 0, y: 0, w: 210, h: 120 } }
    expect(pickTarget(dragged, [touch, flush], 1)?.id).toBe('e')
  })

  it('leaves out what `accept` refuses, and itself', () => {
    const dragged = { x: 210, y: 0, w: 200, h: 120 }
    const cands = [
      { id: 'a', rect: { x: 0, y: 0, w: 205, h: 120 } },
      { id: 'b', rect: T },
    ]
    expect(pickTarget(dragged, cands, 1, (id) => id !== 'a')?.id).toBe('b')
    expect(pickTarget(dragged, cands, 1, () => false)).toBeNull()
  })
})

describe('mergeable', () => {
  const asset = { assetId: `asset_${'0'.repeat(25)}1`, frame: 'print' as const }
  it('refuses photos either way, and a note with itself', () => {
    const a = note(idOf('note', 1))
    const b = note(idOf('note', 2))
    expect(mergeable(a, b)).toBe(true)
    expect(mergeable({ ...a, image: asset }, b)).toBe(false)
    expect(mergeable(a, { ...b, image: asset })).toBe(false)
    expect(mergeable(a, a)).toBe(false)
  })
})

describe('mergedText', () => {
  it('joins with exactly one blank line, trimming blank lines at the seam only', () => {
    expect(mergedText('A', 'B')).toBe('A\n\nB')
    expect(mergedText('A\n\n\n  \n', '\n \nB\nC\n\n')).toBe('A\n\nB\nC\n\n')
    expect(mergedText('\n\nA\nend  ', 'B')).toBe('\n\nA\nend  \n\nB')
  })

  it('takes the other text as it is when one is blank', () => {
    expect(mergedText('', 'B\n')).toBe('B\n')
    expect(mergedText('A', ' \n ')).toBe('A')
    expect(mergedText('', '')).toBe('')
  })

  it('orders by side: right of or below the target goes after', () => {
    const t = note(idOf('note', 1), { text: 'target' })
    const d = note(idOf('note', 2), { text: 'moved' })
    expect(mergeText(d, t, 'right')).toBe('target\n\nmoved')
    expect(mergeText(d, t, 'below')).toBe('target\n\nmoved')
    expect(mergeText(d, t, 'left')).toBe('moved\n\ntarget')
    expect(mergeText(d, t, 'above')).toBe('moved\n\ntarget')
  })
})

describe('mergedCopy', () => {
  it('names the merged note by its first line', () => {
    expect(mergedCopy('\n  Trip plans \nday 1')).toBe('Merged into “Trip plans”')
    expect(mergedCopy('x'.repeat(60))).toBe(`Merged into “${'x'.repeat(40)}…”`)
    expect(mergedCopy(' \n')).toBe('Merged the notes')
  })
})

const N = (n: number) => idOf('note', n)
const Y = (n: number) => idOf('yarn', n)

function board(
  notes: number,
  yarns: Array<[number, number[], Record<number, string>?]>,
  text = (n: number) => `n${n}`,
) {
  const ops: ClientOp[] = []
  for (let i = 1; i <= notes; i++) {
    ops.push({ op: 'note.create', note: note(N(i), { x: i * 300, text: text(i), z: i }) })
  }
  for (const [y, ids, pins] of yarns) {
    ops.push({
      op: 'yarn.create',
      yarn: {
        type: 'yarn',
        id: Y(y),
        noteIds: ids.map(N),
        color: 'apricot',
        label: '',
        ...(pins && { pins: Object.fromEntries(Object.entries(pins).map(([n, k]) => [N(+n), k])) }),
        createdAt: T0,
        updatedAt: T0,
      },
    })
  }
  return applyBatch(emptyBoardState(BOARD_ID, 'T', T0), ops, { now: T0 })
}

const yarnIds = (s: BoardState, y: number) => s.yarns.get(Y(y))?.noteIds

describe('retieOps', () => {
  it('puts the target in the dragged note’s place', () => {
    const s = board(5, [[1, [3, 1, 4]]])
    const after = applyBatch(s, retieOps(s.yarns.get(Y(1)) as never, N(1), N(2)), { now: LATER })
    expect(yarnIds(after, 1)).toEqual([N(3), N(2), N(4)])
  })

  it('keeps a two-note thread alive and in order, either end', () => {
    for (const [ids, want] of [
      [
        [1, 3],
        [2, 3],
      ],
      [
        [3, 1],
        [3, 2],
      ],
    ] as const) {
      const s = board(3, [[1, [...ids]]])
      const after = applyBatch(s, retieOps(s.yarns.get(Y(1)) as never, N(1), N(2)), {
        now: LATER,
      })
      expect(yarnIds(after, 1)).toEqual(want.map(N))
    }
  })

  it('works on a full thread', () => {
    const count = LIMITS.maxThreadNotes
    const ids = Array.from({ length: count }, (_, i) => i + 2)
    const s = board(count + 1, [[1, ids]])
    const ops = retieOps(s.yarns.get(Y(1)) as never, N(2), N(1))
    const after = applyBatch(s, ops, { now: LATER })
    expect(yarnIds(after, 1)?.[0]).toBe(N(1))
    expect(yarnIds(after, 1)).toHaveLength(count)
  })

  it('unties the dragged note from a thread that holds the target too', () => {
    const s = board(4, [
      [1, [1, 3, 2]],
      [2, [1, 2]],
    ])
    let after = applyBatch(s, retieOps(s.yarns.get(Y(1)) as never, N(1), N(2)), { now: LATER })
    after = applyBatch(after, retieOps(after.yarns.get(Y(2)) as never, N(1), N(2)), { now: LATER })
    expect(yarnIds(after, 1)).toEqual([N(3), N(2)])
    expect(after.yarns.has(Y(2))).toBe(false)
  })

  it('leaves threads without the dragged note alone', () => {
    const s = board(3, [[1, [2, 3]]])
    expect(retieOps(s.yarns.get(Y(1)) as never, N(1), N(2))).toEqual([])
  })
})

describe('mergeOps', () => {
  it('is one batch: the text, the threads re-tied, the dragged note gone; one undo restores all', () => {
    const s = board(5, [
      [1, [3, 1, 4]],
      [2, [1, 2]],
      [3, [2, 5, 1]],
    ])
    const ops = mergeOps(s, N(1), N(2), 'left')
    const after = applyBatch(s, ops, { now: LATER })
    expect(after.notes.has(N(1))).toBe(false)
    const t = after.notes.get(N(2))
    expect(t?.text).toBe('n1\n\nn2')
    expect({ x: t?.x, y: t?.y, w: t?.w, h: t?.h, z: t?.z }).toEqual({
      x: 600,
      y: 0,
      w: 200,
      h: 120,
      z: 2,
    })
    expect(yarnIds(after, 1)).toEqual([N(3), N(2), N(4)])
    expect(after.yarns.has(Y(2))).toBe(false)
    expect(yarnIds(after, 3)).toEqual([N(2), N(5)])

    const undo = new UndoStack()
    undo.record(s, ops, 'merge')
    const step = undo.undo(after)
    expect(step?.skipped).toBe(0)
    const back = applyBatch(after, step?.ops ?? [], { now: LATER })
    expect([...back.notes.keys()].sort()).toEqual([...s.notes.keys()].sort())
    expect(back.notes.get(N(1))?.text).toBe('n1')
    expect(back.notes.get(N(2))?.text).toBe('n2')
    for (const y of [1, 2, 3]) expect(yarnIds(back, y)).toEqual(yarnIds(s, y))
  })

  it('carries shared pins over: threads sharing a pin on the dragged note share it on the target', () => {
    const s = board(5, [
      // Y1 and Y2 share one pin on N1; Y3 is tied at N1's hanging pin; Y4 holds N1 and N2 both.
      [1, [3, 1], { 1: 'shared' }],
      [2, [4, 1, 5], { 1: 'shared', 4: 'hanging' }],
      [3, [1, 5], { 1: 'hanging' }],
      [4, [1, 2], { 1: 'shared' }],
    ])
    const ops = mergeOps(s, N(1), N(2), 'right')
    const after = applyBatch(s, ops, { now: LATER })
    expect(after.yarns.get(Y(1))?.pins).toEqual({ [N(2)]: 'shared' })
    expect(after.yarns.get(Y(2))?.pins).toEqual({ [N(4)]: 'hanging', [N(2)]: 'shared' })
    expect(after.yarns.get(Y(3))?.pins).toEqual({ [N(2)]: 'hanging' })
    expect(after.yarns.has(Y(4))).toBe(false)

    const undo = new UndoStack()
    undo.record(s, ops, 'merge')
    const step = undo.undo(after)
    expect(step?.skipped).toBe(0)
    const back = applyBatch(after, step?.ops ?? [], { now: LATER })
    // Undo is a new edit: only the time it was made differs.
    const same = (st: BoardState, y: number) => ({ ...st.yarns.get(Y(y)), updatedAt: '' })
    for (const y of [1, 2, 3, 4]) expect(same(back, y)).toEqual(same(s, y))
  })

  it('sends no text update when the merged text is the target’s own', () => {
    const s = board(2, [], (n) => (n === 1 ? '' : 'kept'))
    expect(mergeOps(s, N(1), N(2), 'right')).toEqual([{ op: 'note.delete', id: N(1) }])
  })
})
