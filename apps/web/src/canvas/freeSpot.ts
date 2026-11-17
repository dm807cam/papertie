import type { Point, Rect } from './types'

/** Spots `freeSpot` looks at, at most, whatever the area. */
export const FREE_SPOT_MAX = 1200

/**
 * Where a new note of `size` (world px) goes: the point on a grid of `step` around `centre` (the
 * note centred there, its whole rect inside `area`) whose rect `cost` scores lowest, nearest the
 * centre on a tie. Rings of the grid go outward from the centre, each ring's spots nearest first,
 * and the first spot that costs nothing (no paper under it) ends the search; else the cheapest of
 * the spots looked at, each of the few cheapest nudged off the grid toward a cheaper place, is
 * taken. The caller scores covering text or a pin as far more than covering bare paper, so this
 * finds gutter crossings and corners. At most `max` spots are asked about on the grid, and at
 * most `FREE_SPOT_REFINE` more off it. Null only when no spot fits the area. `cost` reads the
 * board's spatial index (never a walk of every note).
 */
export function freeSpot(o: {
  centre: Point
  size: { w: number; h: number }
  area: Rect
  step: number
  /** What placing the note over `r` costs; past `limit` it may stop counting (it lost). */
  cost(r: Rect, limit?: number): number
  max?: number
}): Point | null {
  const { centre, size, area, step } = o
  const max = o.max ?? FREE_SPOT_MAX
  if (!(step > 0) || !Number.isFinite(centre.x) || !Number.isFinite(centre.y)) return null
  const rectAt = (p: Point): Rect => ({
    x: p.x - size.w / 2,
    y: p.y - size.h / 2,
    w: size.w,
    h: size.h,
  })
  const inside = (r: Rect) =>
    r.x >= area.x && r.y >= area.y && r.x + r.w <= area.x + area.w && r.y + r.h <= area.y + area.h
  // Rings out to the farthest corner of the area, no further.
  const reach = Math.ceil(
    Math.max(
      Math.abs(area.x - centre.x),
      Math.abs(area.x + area.w - centre.x),
      Math.abs(area.y - centre.y),
      Math.abs(area.y + area.h - centre.y),
    ) / step,
  )
  let asked = 0
  /** The cheapest spots seen, cheapest first, for a closer look when none is free. */
  const cheap: Array<{ p: Point; cost: number }> = []
  const keep = (p: Point, cost: number) => {
    let i = cheap.length
    while (i > 0 && (cheap[i - 1] as { cost: number }).cost > cost) i--
    if (i >= REFINE_FROM) return
    cheap.splice(i, 0, { p, cost })
    if (cheap.length > REFINE_FROM) cheap.pop()
  }
  /**
   * No free spot: from each of the cheapest, step to a cheaper neighbour at half, then a quarter
   * of the grid (a gutter crossing rarely lies on the grid), and take the cheapest found.
   */
  const refine = (): Point | null => {
    let best = cheap[0] ?? null
    for (const start of cheap) {
      let at = start
      for (const f of [step / 2, step / 4]) {
        for (const [dx, dy] of NEIGHBOURS) {
          const p = { x: at.p.x + dx * f, y: at.p.y + dy * f }
          const r = rectAt(p)
          if (!inside(r)) continue
          const cost = o.cost(r, at.cost)
          if (cost < at.cost) at = { p, cost }
        }
      }
      if (best === null || at.cost < best.cost) best = at
    }
    return best?.p ?? null
  }
  for (let k = 0; k <= reach; k++) {
    const ring: Array<[number, number]> = []
    if (k === 0) ring.push([0, 0])
    for (let i = -k; i <= k && k > 0; i++) {
      ring.push([i, -k], [i, k])
      if (i !== -k && i !== k) ring.push([-k, i], [k, i])
    }
    ring.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]))
    for (const [i, j] of ring) {
      const p = { x: centre.x + i * step, y: centre.y + j * step }
      const r = rectAt(p)
      if (!inside(r)) continue
      if (asked++ >= max) return refine()
      const worst = cheap.length < REFINE_FROM ? undefined : cheap[cheap.length - 1]
      const cost = o.cost(r, worst?.cost)
      if (!(cost > 0)) return p
      keep(p, cost)
    }
  }
  return refine()
}

/** How many of the cheapest spots `freeSpot` looks at more closely when none is free. */
const REFINE_FROM = 8
/** The most spots that closer look asks about: eight neighbours at two distances, from each. */
export const FREE_SPOT_REFINE = REFINE_FROM * 2 * 8
const NEIGHBOURS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const

/** A paper a new note's spot may cover: its rect, its text box and its pin. */
export interface CoverPaper {
  paper: Rect
  text: Rect | null
  pin: Point | null
}

/** The most papers one spot's cost reads; a spot near more is as bad as spots get. */
export const COVER_VISIT_MAX = 48

const overlapArea = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
const meets = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const pointIn = (p: Point, r: Rect): boolean =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

/**
 * The cost of a new note's spot over `papers` (read from the spatial index once, for the whole
 * search): each paper within `gap` costs its overlap (at least 1), its text `textCost` times the
 * overlap, a pin under the spot `pinCost`. The papers go into a grid of `cell` world px, so a
 * spot reads only those near it; at most `COVER_VISIT_MAX` of them (a spot on a deep pile is as
 * bad as spots get), and it stops once it costs more than `limit`. `examined` counts the papers
 * read, for tests.
 */
export function coverCost(
  papers: readonly CoverPaper[],
  o: { gap: number; textCost: number; pinCost: number; cell?: number },
): { of(r: Rect, limit?: number): number; examined(): number } {
  const cell = o.cell ?? 256
  const grid = new Map<string, number[]>()
  const keyOf = (i: number, j: number) => `${i},${j}`
  papers.forEach((p, k) => {
    const r = p.paper
    for (let i = Math.floor(r.x / cell); i <= Math.floor((r.x + r.w) / cell); i++) {
      for (let j = Math.floor(r.y / cell); j <= Math.floor((r.y + r.h) / cell); j++) {
        const key = keyOf(i, j)
        const list = grid.get(key)
        if (list === undefined) grid.set(key, [k])
        else list.push(k)
      }
    }
  })
  const seen = new Uint32Array(papers.length)
  let stamp = 0
  let examined = 0
  return {
    examined: () => examined,
    of(r, limit = Number.POSITIVE_INFINITY) {
      const near = { x: r.x - o.gap, y: r.y - o.gap, w: r.w + 2 * o.gap, h: r.h + 2 * o.gap }
      stamp++
      let c = 0
      let read = 0
      for (let i = Math.floor(near.x / cell); i <= Math.floor((near.x + near.w) / cell); i++) {
        for (let j = Math.floor(near.y / cell); j <= Math.floor((near.y + near.h) / cell); j++) {
          for (const k of grid.get(keyOf(i, j)) ?? []) {
            if (seen[k] === stamp) continue
            seen[k] = stamp
            if (read++ >= COVER_VISIT_MAX) return Number.MAX_VALUE
            examined++
            const p = papers[k] as CoverPaper
            if (!meets(p.paper, near)) continue
            c += Math.max(1, overlapArea(r, p.paper))
            if (p.text !== null) c += o.textCost * overlapArea(r, p.text)
            if (p.pin !== null && pointIn(p.pin, near)) c += o.pinCost
            if (c > limit) return c
          }
        }
      }
      return c
    },
  }
}
