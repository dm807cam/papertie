import { FREE_SPOT_REFINE, freeSpot } from '../src/canvas/freeSpot'
import type { Rect } from '../src/canvas/types'

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

/** Papers, each with its text box and pin: the cost of a spot as the runtime counts it. */
const board = (papers: Array<{ paper: Rect; text: Rect; pin: { x: number; y: number } }>) => {
  let asked = 0
  return {
    cost: (r: Rect) => {
      asked++
      let c = 0
      for (const p of papers) {
        c += overlap(r, p.paper) + 8 * overlap(r, p.text)
        const { x, y } = p.pin
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) c += 1e6
      }
      return c
    },
    asked: () => asked,
  }
}
const note = (x: number, y: number) => ({
  paper: { x, y, w: 220, h: 160 },
  text: { x: x + 26, y: y + 18, w: 168, h: 120 },
  pin: { x: x + 110, y: y + 14 },
})

const AREA = { x: 0, y: 0, w: 1200, h: 800 }
const SIZE = { w: 220, h: 160 }
const CENTRE = { x: 600, y: 400 }
const at = (b: ReturnType<typeof board>, area = AREA, max?: number) =>
  freeSpot({
    centre: CENTRE,
    size: SIZE,
    area,
    step: 24,
    cost: b.cost,
    ...(max === undefined ? {} : { max }),
  })
const rectAt = (p: { x: number; y: number } | null) => ({
  x: (p?.x ?? 0) - 110,
  y: (p?.y ?? 0) - 80,
  w: 220,
  h: 160,
})

describe('freeSpot', () => {
  it('keeps the view centre when nothing is there', () => {
    expect(at(board([]))).toEqual(CENTRE)
  })

  it('moves out on the grid to the nearest spot with no paper under it', () => {
    const covering = {
      paper: { x: 450, y: 280, w: 300, h: 240 },
      text: { x: 0, y: 0, w: 0, h: 0 },
      pin: { x: -1, y: -1 },
    }
    const p = at(board([covering]))
    expect(overlap(rectAt(p), covering.paper)).toBe(0)
    expect(Math.abs(((p?.x ?? 0) - 600) % 24)).toBe(0)
    expect(Math.abs(((p?.y ?? 0) - 400) % 24)).toBe(0)
    // Straight up or down clears it in 9 steps (216 px): nothing farther is taken.
    expect(Math.hypot((p?.x ?? 0) - 600, (p?.y ?? 0) - 400)).toBeLessThanOrEqual(216)
  })

  it('with no free spot, takes the one that covers least: gutters and corners, never text or pins', () => {
    // A dense grid: 340 × 300 cells of 220 × 160 notes, over the whole area.
    const papers: ReturnType<typeof note>[] = []
    for (let x = -100; x < 1300; x += 340)
      for (let y = -100; y < 900; y += 300) papers.push(note(x, y))
    const b = board(papers)
    const p = at(b)
    expect(p).not.toBeNull()
    const r = rectAt(p)
    // No pin under it, and far less text covered than at the middle.
    for (const n of papers) {
      const { x, y } = n.pin
      expect(x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h).toBe(false)
    }
    const text = (q: Rect) => papers.reduce((s, n) => s + overlap(q, n.text), 0)
    expect(text(r)).toBeLessThan(text(rectAt(CENTRE)))
  })

  it('stays inside the area: null only when no spot fits it', () => {
    expect(at(board([]), { x: 0, y: 0, w: 100, h: 100 })).toBeNull()
  })

  it('looks at a bounded number of spots, however large the area', () => {
    const b = board([
      {
        paper: { x: -1e6, y: -1e6, w: 2e6, h: 2e6 },
        text: { x: 0, y: 0, w: 0, h: 0 },
        pin: { x: 1e7, y: 0 },
      },
    ])
    const huge = { x: -50_000, y: -50_000, w: 100_000, h: 100_000 }
    expect(at(b, huge, 900)).not.toBeNull()
    // The grid's 900, and the bounded closer look at the cheapest few when none is free.
    expect(b.asked()).toBeLessThanOrEqual(900 + FREE_SPOT_REFINE)
  })
})

describe('the cost of a spot on a deep stack (bounded per spot)', () => {
  it('examines a bounded number of papers per spot, however many are piled in view', async () => {
    const { coverCost, COVER_VISIT_MAX } = await import('../src/canvas/freeSpot')
    // 2,000 notes piled at the middle of the view, each 2 px from the last.
    const papers = Array.from({ length: 2000 }, (_, i) => note(500 + (i % 40) * 2, 300 + i * 0.1))
    const cost = coverCost(papers, { gap: 12, textCost: 8, pinCost: 1e9 })
    const p = freeSpot({ centre: CENTRE, size: SIZE, area: AREA, step: 24, cost: cost.of })
    expect(p).not.toBeNull()
    expect(cost.examined()).toBeLessThanOrEqual((1200 + FREE_SPOT_REFINE) * COVER_VISIT_MAX)
    // Free cork beside the pile is still found.
    const r = rectAt(p)
    expect(papers.every((n) => overlap(r, n.paper) === 0)).toBe(true)
  })

  it('stops counting a spot once it costs more than the best so far', async () => {
    const { coverCost } = await import('../src/canvas/freeSpot')
    const papers = Array.from({ length: 50 }, () => note(500, 320))
    const cost = coverCost(papers, { gap: 12, textCost: 8, pinCost: 1e9 })
    const r = { x: 500, y: 320, w: 220, h: 160 }
    const whole = cost.of(r)
    const before = cost.examined()
    expect(cost.of(r, 1)).toBeGreaterThan(1)
    expect(cost.examined() - before).toBeLessThan(5)
    expect(whole).toBeGreaterThan(1e9)
  })
})
