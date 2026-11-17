import type { Point, Rect } from './types'

/**
 * The liquid bridge between two papers held side by side, in world px. `axis` is the one the gap
 * runs along ('x': the papers lie left and right of each other). `from` is where it leaves the
 * target's paper and `to` the dragged one's, on that axis; `mid` is the middle of the stretch the
 * papers share along their edges and `half` half its length.
 */
export interface BridgeGeom {
  axis: 'x' | 'y'
  from: number
  to: number
  mid: number
  half: number
  /** The waist's half-width as a share of `half`: 0 a thread, 1 the whole shared stretch. */
  waist: number
  /** Where the feet meet the papers, as a share of `half` (never less than the waist). */
  foot: number
  /** World px the bridge reaches further under each paper. */
  inset: number
}

/** One path command; `C` holds two control points and the end. */
export type PathCmd = { kind: 'M' | 'L'; p: Point } | { kind: 'C'; c1: Point; c2: Point; p: Point }

/**
 * How far along the edge (share of the flare) and across the gap (share of half of it) the
 * fillet's handles reach.
 */
const HANDLE = { edge: 0.6, gap: 0.55 } as const

/**
 * The bridge's outline: under each paper (`inset` past where it leaves it) a foot as wide as
 * where the bridge meets it, then on either side a fillet from the paper, leaving it along its
 * edge as a meniscus leaves a wall, into the waist halfway across the gap. With waist and feet 1
 * it is a straight band across the whole shared stretch: a full join. World px, closed.
 */
export function bridgeOutline(g: BridgeGeom): PathCmd[] {
  const s = g.to >= g.from ? 1 : -1
  const half = Math.max(0, g.half)
  const waist = Math.max(0, Math.min(1.25, g.waist)) * half
  // The feet never reach past the shared stretch, nor inside the waist.
  const foot = Math.max(waist, Math.min(half, Math.max(0, g.foot) * half))
  const along = foot - (foot - waist) * HANDLE.edge
  const centre = (g.from + g.to) / 2
  const d = (centre - g.from) * HANDLE.gap
  const P = (u: number, v: number): Point =>
    g.axis === 'x' ? { x: u, y: g.mid + v } : { x: g.mid + v, y: u }
  // One side of the bridge (`v` -1 or 1), from foot `a` through the waist to foot `b`.
  const side = (v: number, a: number, b: number): PathCmd[] => {
    const toward = b > a ? 1 : b < a ? -1 : s
    const handle = Math.abs(d) * toward
    return [
      { kind: 'L', p: P(a, v * foot) },
      {
        kind: 'C',
        c1: P(a, v * along),
        c2: P(centre - handle, v * waist),
        p: P(centre, v * waist),
      },
      { kind: 'C', c1: P(centre + handle, v * waist), c2: P(b, v * along), p: P(b, v * foot) },
    ]
  }
  const inTarget = g.from - s * g.inset
  const inDragged = g.to + s * g.inset
  return [
    { kind: 'M', p: P(inTarget, -foot) },
    ...side(-1, g.from, g.to),
    { kind: 'L', p: P(inDragged, -foot) },
    { kind: 'L', p: P(inDragged, foot) },
    ...side(1, g.to, g.from),
    { kind: 'L', p: P(inTarget, foot) },
  ]
}

/** Every point of an outline (ends and handles), for its bounds. */
export function outlinePoints(cmds: readonly PathCmd[]): Point[] {
  const pts: Point[] = []
  for (const c of cmds) {
    if (c.kind === 'C') pts.push(c.c1, c.c2)
    pts.push(c.p)
  }
  return pts
}

/** Trace `cmds` on `ctx` through `map` (world to the context's px); closes the path. */
export function tracePath(
  ctx: CanvasRenderingContext2D,
  cmds: readonly PathCmd[],
  map: (p: Point) => Point,
): void {
  ctx.beginPath()
  for (const c of cmds) {
    const p = map(c.p)
    if (c.kind === 'C') {
      const a = map(c.c1)
      const b = map(c.c2)
      ctx.bezierCurveTo(a.x, a.y, b.x, b.y, p.x, p.y)
    } else if (c.kind === 'M') ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  }
  ctx.closePath()
}

/** How a bridge is painted, besides its outline. */
export interface BridgePaint {
  geom: BridgeGeom
  /** World to the context's viewport px. */
  map: (p: Point) => Point
  zoom: number
  dpr: number
  /** The viewport rect the canvas covers. */
  box: Rect
  alpha: number
  /** CSS colours of the target's paper and the dragged one's. */
  fromColour: string
  toColour: string
  /** World px inside each paper's edge where the bridge leaves it; the shadow keeps off them. */
  bite: number
  /** Share of `inset` over which the bridge fades in under each paper. */
  fadeIn: number
  shadow: { color: string; blur: number; y: number }
  /** Lays the paper's fibre over `box` (the outline is the clip), if it has one. */
  fibre: ((ctx: CanvasRenderingContext2D, box: Rect) => void) | null
  /** A viewport rect left unpainted (the absorbing paper, which lies above), if any. */
  exclude?: Rect | null
}

/**
 * Paint the bridge `cmds` (its `bridgeOutline`) on `ctx`, which draws in device px with the
 * canvas's top-left at `box`. Across the gap the colour runs from one paper to the other; under
 * each torn edge the bridge fades in from the deepest bite, so it meets the paper without a seam.
 * The paper, its fibre and the fade are clipped to the outline; the shadow goes behind it and
 * falls on the cork in the gap only, never on the papers.
 */
export function paintBridge(
  ctx: CanvasRenderingContext2D,
  cmds: readonly PathCmd[],
  p: BridgePaint,
): void {
  const { geom: g, map, box, dpr, alpha } = p
  ctx.setTransform(dpr, 0, 0, dpr, -box.x * dpr, -box.y * dpr)
  const a = map(g.axis === 'x' ? { x: g.from, y: g.mid } : { x: g.mid, y: g.from })
  const b = map(g.axis === 'x' ? { x: g.to, y: g.mid } : { x: g.mid, y: g.to })
  const sgn = g.to >= g.from ? 1 : -1
  const reach = g.inset * p.zoom
  const ux = g.axis === 'x' ? sgn : 0
  const uy = g.axis === 'y' ? sgn : 0
  const start = { x: a.x - ux * reach, y: a.y - uy * reach }
  const end = { x: b.x + ux * reach, y: b.y + uy * reach }
  const span = Math.hypot(end.x - start.x, end.y - start.y) || 1
  const lead = Math.min(0.5, (reach * p.fadeIn) / span)
  const edge = Math.min(0.5, Math.max(lead, reach / span))
  const colour = ctx.createLinearGradient(start.x, start.y, end.x, end.y)
  colour.addColorStop(edge, p.fromColour)
  colour.addColorStop(1 - edge, p.toColour)
  const fade = ctx.createLinearGradient(start.x, start.y, end.x, end.y)
  fade.addColorStop(0, 'rgb(0 0 0 / 0)')
  fade.addColorStop(lead, `rgb(0 0 0 / ${alpha})`)
  fade.addColorStop(1 - lead, `rgb(0 0 0 / ${alpha})`)
  fade.addColorStop(1, 'rgb(0 0 0 / 0)')
  // Everything below keeps out of `exclude`: the canvas less that rect.
  ctx.save()
  const hole = p.exclude
  if (hole) {
    ctx.beginPath()
    ctx.rect(box.x, box.y, box.w, box.h)
    ctx.rect(hole.x, hole.y, hole.w, hole.h)
    ctx.clip('evenodd')
  }
  ctx.save()
  tracePath(ctx, cmds, map)
  ctx.clip()
  ctx.fillStyle = colour
  ctx.fillRect(box.x, box.y, box.w, box.h)
  p.fibre?.(ctx, box)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.fillStyle = fade
  ctx.fillRect(box.x, box.y, box.w, box.h)
  ctx.restore()
  ctx.save()
  ctx.beginPath()
  const bite = p.bite * p.zoom
  const across = Math.max(
    0,
    (g.axis === 'x' ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)) - 2 * bite,
  )
  if (g.axis === 'x') ctx.rect(Math.min(a.x, b.x) + bite, box.y, across, box.h)
  else ctx.rect(box.x, Math.min(a.y, b.y) + bite, box.w, across)
  ctx.clip()
  ctx.globalCompositeOperation = 'destination-over'
  ctx.globalAlpha = alpha
  ctx.shadowColor = p.shadow.color
  ctx.shadowBlur = p.shadow.blur * dpr
  ctx.shadowOffsetY = p.shadow.y * dpr
  tracePath(ctx, cmds, map)
  ctx.fillStyle = colour
  ctx.fill()
  ctx.restore()
  ctx.restore()
}
