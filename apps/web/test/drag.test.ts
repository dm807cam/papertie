import { applyBatch, ClientOpSchema, LIMITS, type Note } from '@papertie/core'
import { DEMO_IDS, demoBoard } from '../src/dev/demoBoard'
import {
  dragOps,
  moveNotes,
  type ResizeHandle,
  resizeOps,
  resizeRect,
} from '../src/interactions/drag'

const NOW = '2026-10-27T00:00:00.000Z'
const LATER = '2026-10-27T01:00:00.000Z'
const board = demoBoard(NOW)
const hub = board.notes.get(DEMO_IDS.hub) as Note
const knot = board.notes.get(DEMO_IDS.knot) as Note
const topZ = Math.max(...[...board.notes.values()].map((n) => n.z))

const box = (x: number, y: number, w: number, h: number): Note => ({ ...hub, x, y, w, h })
const HANDLES: ResizeHandle[] = ['nw', 'ne', 'sw', 'se', 'e', 's']

describe('moveNotes / dragOps', () => {
  it('dragOps with no movement is empty', () => {
    expect(dragOps([hub, knot], new Map(), 10)).toEqual([])
    expect(dragOps([hub], moveNotes([hub], 0, 0), 10)).toEqual([])
  })

  it('moveNotes rounds to integers', () => {
    expect(moveNotes([hub], 10.4, -3.6).get(hub.id)).toEqual({ x: hub.x + 10, y: hub.y - 4 })
    expect(moveNotes([hub], Number.NaN, Number.POSITIVE_INFINITY).get(hub.id)).toEqual({
      x: hub.x,
      y: hub.y,
    })
  })

  it('dragOps produces valid ops that applyBatch accepts on the demo board', () => {
    const before = [knot, hub]
    const ops = dragOps(before, moveNotes(before, 200, -50), topZ)
    expect(ops).toHaveLength(2)
    for (const op of ops) expect(ClientOpSchema.parse(op)).toEqual(op)
    const next = applyBatch(board, ops, { now: LATER })
    const zs = before.map((n) => next.notes.get(n.id)?.z ?? 0)
    // Dragged notes come to the top and keep their relative order.
    expect(Math.min(...zs)).toBe(topZ + 1)
    expect(next.notes.get(hub.id)?.z).toBeLessThan(next.notes.get(knot.id)?.z ?? 0)
    expect(next.notes.get(hub.id)).toMatchObject({ x: hub.x + 200, y: hub.y - 50 })
    for (const n of next.notes.values()) {
      if (n.id !== hub.id && n.id !== knot.id) expect(n.z).toBeLessThan(topZ + 1)
    }
  })

  it('dragging by 2e7 clamps to maxCoord and still applies', () => {
    const far = moveNotes([hub], 2e7, -2e7)
    expect(far.get(hub.id)).toEqual({ x: LIMITS.maxCoord, y: -LIMITS.maxCoord })
    const ops = dragOps([hub], far, topZ)
    const next = applyBatch(board, ops, { now: LATER })
    expect(next.notes.get(hub.id)).toMatchObject({ x: LIMITS.maxCoord, y: -LIMITS.maxCoord })
    const edge = { ...hub, x: LIMITS.maxCoord - 3 }
    expect(moveNotes([edge], 10, 0).get(hub.id)?.x).toBe(LIMITS.maxCoord)
  })
})

describe('resizeRect / resizeOps', () => {
  const n = box(100, 100, 300, 200)

  it('resizeRect se grows; nw moves the origin', () => {
    expect(resizeRect(n, 'se', 60, 40)).toEqual({ x: 100, y: 100, w: 360, h: 240 })
    expect(resizeRect(n, 'nw', -20, -10)).toEqual({ x: 80, y: 90, w: 320, h: 210 })
    expect(resizeRect(n, 'ne', 20, -10)).toEqual({ x: 100, y: 90, w: 320, h: 210 })
    expect(resizeRect(n, 'sw', -20, 10)).toEqual({ x: 80, y: 100, w: 320, h: 210 })
    expect(resizeRect(n, 'e', 20.6, 99)).toEqual({ x: 100, y: 100, w: 321, h: 200 })
    expect(resizeRect(n, 's', 99, -20.4)).toEqual({ x: 100, y: 100, w: 300, h: 180 })
  })

  it('resize below 120×60 clamps and keeps the opposite corner', () => {
    expect(resizeRect(n, 'nw', 500, 500)).toEqual({ x: 280, y: 240, w: 120, h: 60 })
    expect(resizeRect(n, 'se', -500, -500)).toEqual({ x: 100, y: 100, w: 120, h: 60 })
    expect(resizeRect(n, 'ne', -500, 500)).toEqual({ x: 100, y: 240, w: 120, h: 60 })
    expect(resizeRect(n, 'sw', 500, -500)).toEqual({ x: 280, y: 100, w: 120, h: 60 })
  })

  it('keepAspect 1.5 holds for corner handles', () => {
    for (const h of ['nw', 'ne', 'sw', 'se'] as const) {
      for (const [dx, dy] of [
        [90, 10],
        [-40, 70],
        [-130, -130],
        [500, -20],
      ] as const) {
        const r = resizeRect(n, h, dx, dy, 1.5)
        expect(Math.abs(r.w / r.h - 1.5)).toBeLessThan(0.02)
        // The opposite corner stays put.
        const ox = h === 'nw' || h === 'sw' ? r.x + r.w : r.x
        const oy = h === 'nw' || h === 'ne' ? r.y + r.h : r.y
        expect(ox).toBe(h === 'nw' || h === 'sw' ? 400 : 100)
        expect(oy).toBe(h === 'nw' || h === 'ne' ? 300 : 100)
      }
    }
    expect(resizeRect(n, 'se', 90, 0, 1.5)).toEqual({ x: 100, y: 100, w: 390, h: 260 })
  })

  it('grow past 2000×4000 clamps', () => {
    expect(resizeRect(n, 'se', 1e6, 1e6)).toEqual({ x: 100, y: 100, w: 2000, h: 4000 })
    expect(resizeRect(n, 'nw', -1e6, -1e6)).toEqual({ x: -1600, y: -3700, w: 2000, h: 4000 })
    const wide = resizeRect(n, 'se', 1e6, 1e6, 1.5)
    expect(wide).toEqual({ x: 100, y: 100, w: 2000, h: 1333 })
    const tall = resizeRect(n, 'se', 1e6, 1e6, 0.25)
    expect(tall).toEqual({ x: 100, y: 100, w: 1000, h: 4000 })
  })

  it('never produces an op applyBatch rejects, near ±maxCoord and with junk deltas', () => {
    const M = LIMITS.maxCoord
    const edges = [box(-M, -M, 300, 200), box(M, M, 300, 200), box(M - 100, -M + 50, 2000, 60)]
    const deltas = [1e9, -1e9, 0, 7.5, Number.NaN, Number.NEGATIVE_INFINITY]
    for (const e of edges) {
      const set = { x: e.x, y: e.y, w: e.w, h: e.h }
      const s = applyBatch(board, [{ op: 'note.update', id: hub.id, set }], { now: LATER })
      for (const h of HANDLES) {
        for (const dx of deltas) {
          for (const dy of deltas) {
            for (const aspect of [undefined, 1.5, 1e-9]) {
              const r = resizeRect(e, h, dx, dy, aspect)
              for (const v of Object.values(r)) expect(Number.isInteger(v)).toBe(true)
              const ops = resizeOps(e, r)
              for (const op of ops) ClientOpSchema.parse(op)
              expect(() => applyBatch(s, ops, { now: LATER })).not.toThrow()
            }
          }
        }
      }
    }
  })

  it('resizeOps is empty when unchanged and sets only the changed fields', () => {
    expect(resizeOps(n, { x: 100, y: 100, w: 300, h: 200 })).toEqual([])
    expect(resizeOps(n, resizeRect(n, 'e', 40, 0))).toEqual([
      { op: 'note.update', id: n.id, set: { w: 340 } },
    ])
    expect(resizeOps(n, resizeRect(n, 'nw', 10, 0))).toEqual([
      { op: 'note.update', id: n.id, set: { x: 110, w: 290 } },
    ])
  })
})
