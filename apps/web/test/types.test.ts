import { expandRect, rectContainsPoint, rectsIntersect, unionRects } from '../src/canvas/types'

describe('rect helpers', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 }

  it('rects touching at an edge intersect; disjoint ones do not', () => {
    expect(rectsIntersect(a, { x: 10, y: 0, w: 5, h: 5 })).toBe(true)
    expect(rectsIntersect(a, { x: 10.01, y: 0, w: 5, h: 5 })).toBe(false)
    expect(rectsIntersect(a, { x: 0, y: -6, w: 5, h: 5 })).toBe(false)
  })

  it('contains points on the boundary', () => {
    expect(rectContainsPoint(a, { x: 10, y: 10 })).toBe(true)
    expect(rectContainsPoint(a, { x: 10.1, y: 5 })).toBe(false)
  })

  it('expands on every side', () => {
    expect(expandRect(a, 2)).toEqual({ x: -2, y: -2, w: 14, h: 14 })
  })

  it('unions rects', () => {
    expect(unionRects([a, { x: 20, y: -5, w: 5, h: 5 }])).toEqual({ x: 0, y: -5, w: 25, h: 15 })
  })

  it('unionRects of nothing is null', () => {
    expect(unionRects([])).toBeNull()
  })
})
