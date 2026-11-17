import fc from 'fast-check'
import { type Camera, visibleWorldRect } from '../src/canvas/Camera'
import { CULL, cullRect, inPaintOrder, needsRecull } from '../src/canvas/cull'

const viewport = { width: 1000, height: 600 }
const c: Camera = { x: 200, y: -100, zoom: 2 }

describe('culling', () => {
  it('uses the planned constants', () => {
    expect(CULL).toEqual({ marginFrac: 0.5, recullMoveFrac: 0.25, recullZoomRatio: 1.1 })
  })

  it('cullRect adds half the larger viewport side as margin', () => {
    expect(cullRect(c, viewport)).toEqual(visibleWorldRect(c, viewport, 500))
    expect(cullRect(c, { width: 400, height: 900 })).toEqual(
      visibleWorldRect(c, { width: 400, height: 900 }, 450),
    )
    expect(cullRect(c, viewport)).toEqual({ x: -50, y: -350, w: 1000, h: 800 })
  })

  it('needsRecull: 0.2 viewport pan no, 0.3 yes; zoom ×1.05 no, ×1.2 yes; resize yes; null yes', () => {
    const last = { c, viewport }
    const pan = (fx: number, fy: number): Camera => ({
      ...c,
      x: c.x + (fx * viewport.width) / c.zoom,
      y: c.y + (fy * viewport.height) / c.zoom,
    })
    expect(needsRecull(last, c, viewport)).toBe(false)
    expect(needsRecull(last, pan(0.2, 0), viewport)).toBe(false)
    expect(needsRecull(last, pan(0, -0.2), viewport)).toBe(false)
    expect(needsRecull(last, pan(0.3, 0), viewport)).toBe(true)
    expect(needsRecull(last, pan(0, -0.3), viewport)).toBe(true)
    expect(needsRecull(last, { ...c, zoom: c.zoom * 1.05 }, viewport)).toBe(false)
    expect(needsRecull(last, { ...c, zoom: c.zoom / 1.05 }, viewport)).toBe(false)
    expect(needsRecull(last, { ...c, zoom: c.zoom * 1.2 }, viewport)).toBe(true)
    expect(needsRecull(last, { ...c, zoom: c.zoom / 1.2 }, viewport)).toBe(true)
    expect(needsRecull(last, c, { width: 1001, height: 600 })).toBe(true)
    expect(needsRecull(null, c, viewport)).toBe(true)
  })

  it('inPaintOrder sorts ids by z, then id, as the comparator over the board would', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 60 }),
        fc.array(fc.integer({ min: -3, max: 3 }), { minLength: 60, maxLength: 60 }),
        (ids, zs) => {
          const notes = new Map(ids.map((id, k) => [id, { z: zs[k] ?? 0 }]))
          // An id with no note sorts as z 0.
          const all = [...ids, 'gone']
          const want = [...all].sort((a, b) => {
            const dz = (notes.get(a)?.z ?? 0) - (notes.get(b)?.z ?? 0)
            return dz !== 0 ? dz : a < b ? -1 : 1
          })
          expect(inPaintOrder(all, notes)).toEqual(want)
        },
      ),
    )
  })
})
