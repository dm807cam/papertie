import type { RgbaImage } from '../image'
import { latticeHash } from '../rng'
import { clamp01, fbm1D, fbmPeriodic, hex, mixRgb, type Rgb, ramp, smoothstep } from './noise'

interface Opts {
  width: number
  height: number
  seed: number
}

type Paint = readonly [Rgb, number] | undefined

/**
 * A float RGB canvas painted in layers. Coordinates are resolution-free: y runs 0-1 down the
 * image and x 0-aspect across it, so the 256 and 1024 variants show the same picture.
 */
class Canvas {
  readonly rgb: Float32Array
  readonly aspect: number
  /** One pixel in canvas units. */
  readonly px: number

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgb = new Float32Array(width * height * 3)
    this.aspect = width / height
    this.px = 1 / height
  }

  /** Blends `fn`'s colour over every pixel by its coverage (undefined or 0 leaves it). */
  paint(fn: (x: number, y: number) => Paint): void {
    const { width, height, rgb } = this
    for (let py = 0; py < height; py++) {
      const y = (py + 0.5) / height
      for (let px = 0; px < width; px++) {
        const p = fn((px + 0.5) / height, y)
        if (p === undefined || p[1] <= 0) continue
        const a = Math.min(1, p[1])
        const o = (py * width + px) * 3
        rgb[o] = (rgb[o] as number) + (p[0][0] - (rgb[o] as number)) * a
        rgb[o + 1] = (rgb[o + 1] as number) + (p[0][1] - (rgb[o + 1] as number)) * a
        rgb[o + 2] = (rgb[o + 2] as number) + (p[0][2] - (rgb[o + 2] as number)) * a
      }
    }
  }

  /** The painting with a fine paper grain of `grain` levels, opaque. */
  image(seed: number, grain: number): RgbaImage {
    const { width, height, rgb } = this
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      const p = i / 3
      const g = (latticeHash(p % width, Math.floor(p / width), seed) - 0.5) * grain
      data[j] = (rgb[i] as number) + g
      data[j + 1] = (rgb[i + 1] as number) + g
      data[j + 2] = (rgb[i + 2] as number) + g
      data[j + 3] = 255
    }
    return { width, height, data }
  }

  /** Coverage of a shape at signed distance `d` (negative inside), softened over `soft`. */
  cover(d: number, soft = 0): number {
    return clamp01(0.5 - d / Math.max(soft, 1.25 * this.px))
  }
}

/** Distance from (x, y) to a polyline and how far along it (0-1) the nearest point lies. */
function polylineDistance(
  x: number,
  y: number,
  pts: ReadonlyArray<readonly [number, number]>,
): { d: number; t: number } {
  let best = Number.POSITIVE_INFINITY
  let bestT = 0
  let run = 0
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as readonly [number, number]
    const b = pts[i] as readonly [number, number]
    total += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1] as readonly [number, number]
    const [bx, by] = pts[i] as readonly [number, number]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const len = Math.sqrt(len2)
    const s = len2 === 0 ? 0 : clamp01(((x - ax) * dx + (y - ay) * dy) / len2)
    const d = Math.hypot(x - (ax + s * dx), y - (ay + s * dy))
    if (d < best) {
      best = d
      bestT = (run + s * len) / (total || 1)
    }
    run += len
  }
  return { d: best, t: bestT }
}

/** (x, y) in the frame of a box centred at (cx, cy) and turned by `deg`. */
function local(x: number, y: number, cx: number, cy: number, deg: number): [number, number] {
  const r = (-deg * Math.PI) / 180
  const dx = x - cx
  const dy = y - cy
  return [dx * Math.cos(r) - dy * Math.sin(r), dx * Math.sin(r) + dy * Math.cos(r)]
}

/** Signed distance to a rounded box of half-size (hx, hy) and corner radius `r`, centred at 0. */
function boxDistance(x: number, y: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(x) - hx + r
  const qy = Math.abs(y) - hy + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

const LAKE = {
  skyTop: hex(0xa9bfd6),
  skyHaze: hex(0xf2e6d8),
  cloud: hex(0xf8f1ea),
  far: [hex(0xa4adc0), hex(0xc9cdd8)] as const,
  mid: [hex(0x7f9088), hex(0xa7b2a6)] as const,
  near: [hex(0x55705c), hex(0x86978a)] as const,
  water: [hex(0xc9d6de), hex(0x6f8ea6)] as const,
  glint: hex(0xf6f1e6),
  shore: [hex(0x3f5644), hex(0x6f8a5c)] as const,
  trunk: hex(0x43352c),
  crown: [hex(0x2f4a3a), hex(0x5d7d54), hex(0x8fa873)] as const,
  hull: hex(0x7a3b30),
  hullDark: hex(0x3d2623),
}

/** The tree's crown: soft masses (x as a fraction of the width, y, radii, weight). */
const CROWN = [
  [0.16, 0.3, 0.17, 0.2, 1],
  [0.07, 0.42, 0.13, 0.14, 0.9],
  [0.25, 0.44, 0.12, 0.12, 0.9],
  [0.17, 0.16, 0.1, 0.1, 0.85],
] as const

const BOUGHS: ReadonlyArray<{ w: number; pts: ReadonlyArray<readonly [number, number]> }> = [
  {
    w: 0.02,
    pts: [
      [0.15, 0.93],
      [0.155, 0.7],
      [0.165, 0.5],
      [0.16, 0.3],
    ],
  },
  {
    w: 0.01,
    pts: [
      [0.16, 0.56],
      [0.1, 0.47],
      [0.07, 0.4],
    ],
  },
  {
    w: 0.01,
    pts: [
      [0.165, 0.5],
      [0.22, 0.45],
      [0.26, 0.42],
    ],
  },
]

/**
 * A lake among hills: a hazy sky, three ridges, still water that mirrors them under streaks of
 * light, a rowing boat, and a tree on the grassy near shore. Painterly by layered noise,
 * deterministic per seed.
 */
export function generateLakeLandscape({ width, height, seed }: Opts): RgbaImage {
  const c = new Canvas(width, height)
  const A = c.aspect
  const n = (x: number, y: number, period: number, oct: number, s: number) =>
    fbmPeriodic(x / A, y, period, oct, seed + s)
  const L = LAKE
  const waterline = 0.6

  c.paint((x, y) => {
    let col = mixRgb(L.skyTop, L.skyHaze, smoothstep(0, 0.55, y))
    const cloud = smoothstep(0.05, 0.55, n(x, y * 1.6, 3, 5, 1))
    col = mixRgb(col, L.cloud, 0.45 * cloud * (1 - smoothstep(0.2, 0.5, y)))
    return [col, 1]
  })

  const ridges = [
    { base: 0.4, amp: 0.09, period: 3, s: 10, c: L.far },
    { base: 0.48, amp: 0.07, period: 4, s: 20, c: L.mid },
    { base: 0.55, amp: 0.04, period: 6, s: 30, c: L.near },
  ] as const
  const ridgeEdge = (r: (typeof ridges)[number], x: number) =>
    r.base + r.amp * fbm1D(x / A, r.period, 4, seed + r.s)
  for (const r of ridges) {
    c.paint((x, y) => {
      const edge = ridgeEdge(r, x)
      if (y < edge - 2 * c.px || y > waterline + 2 * c.px) return undefined
      const t = smoothstep(edge, edge + 0.3, y)
      const brush = 0.5 + 0.5 * n(x, y, 12, 3, r.s + 1)
      return [mixRgb(r.c[1], r.c[0], t * 0.7 + brush * 0.3), c.cover(edge - y, 0.004)]
    })
  }

  // The water: the sky's light, the ridges mirrored and broken by ripples.
  c.paint((x, y) => {
    if (y < waterline - 2 * c.px) return undefined
    const depth = (y - waterline) / (1 - waterline)
    let col = mixRgb(L.water[0], L.water[1], smoothstep(0, 1, depth))
    const ripple = 0.012 * n(x * 0.4, y * 9, 24, 3, 50) * (0.4 + depth)
    const my = 2 * waterline - y + ripple
    for (const r of ridges) {
      const edge = ridgeEdge(r, x + ripple * 2)
      const k = c.cover(edge - my, 0.01) * (1 - smoothstep(0, 0.55, depth))
      col = mixRgb(col, mixRgb(r.c[0], L.water[1], 0.35), 0.75 * k)
    }
    const streak = smoothstep(0.55, 0.8, 0.5 + 0.5 * n(x * 0.15, y * 14, 40, 3, 51))
    col = mixRgb(col, L.glint, 0.5 * streak * (1 - 0.6 * depth))
    return [col, c.cover(waterline - y)]
  })

  // A rowing boat out on the water, a little hazed by distance, over its reflection.
  const bx = 0.66 * A
  const by = 0.69
  c.paint((x, y) => {
    const d = boxDistance(x - bx, y - by - 0.022, 0.085, 0.006, 0.006)
    return [L.hullDark, 0.35 * c.cover(d, 0.012)]
  })
  c.paint((x, y) => {
    const u = (x - bx) / 0.09
    if (Math.abs(u) > 1.05) return undefined
    // The sheer rises to bow and stern; the keel is a shallow arc.
    const top = by - 0.01 - 0.007 * u * u
    const bottom = by + 0.02 * Math.max(0, 1 - u * u) ** 0.5
    const d = Math.max(top - y, y - bottom, (Math.abs(u) - 1) * 0.09)
    if (d > 2 * c.px) return undefined
    const rail = smoothstep(top + 0.006, top, y)
    return [mixRgb(mixRgb(L.hull, L.hullDark, 1 - rail), L.skyHaze, 0.1), c.cover(d)]
  })

  // The near shore, then the tree that stands on it.
  const shoreEdge = (x: number) =>
    0.9 - 0.1 * smoothstep(0.5 * A, 0, x) + 0.02 * fbm1D(x / A, 5, 3, seed + 60)
  c.paint((x, y) => {
    const edge = shoreEdge(x)
    if (y < edge - 0.03) return undefined
    // Grass: the edge is broken into blades.
    const blade = 0.022 * latticeHash(Math.floor(x * 260), 0, seed + 61)
    const t = 0.5 + 0.5 * n(x, y, 18, 4, 62)
    return [
      mixRgb(L.shore[0], L.shore[1], t * (1 - smoothstep(edge, 1, y))),
      c.cover(edge - blade - y),
    ]
  })
  c.paint((x, y) => {
    let cov = 0
    for (const b of BOUGHS) {
      const { d, t } = polylineDistance(
        x,
        y,
        b.pts.map(([px, py]) => [px * A, py] as const),
      )
      cov = Math.max(cov, c.cover(d - b.w * (1 - 0.6 * t), 0.003))
    }
    return cov > 0 ? [L.trunk, cov] : undefined
  })
  c.paint((x, y) => {
    let dens = Number.NEGATIVE_INFINITY
    for (const [ux, uy, rx, ry, w] of CROWN) {
      const e = ((x - ux * A) / (rx * A)) ** 2 + ((y - uy) / ry) ** 2
      dens = Math.max(dens, w * (1 - e))
    }
    // Lumpy edges near a mass, with gaps of sky; open sky stays open.
    dens += 0.45 * n(x, y, 9, 5, 40) * smoothstep(-0.7, 0, dens)
    if (dens < -0.02) return undefined
    const leaf = n(x, y, 40, 3, 41)
    const light = clamp01(
      0.35 + 0.4 * n(x, y, 14, 4, 42) + 0.25 * leaf + 0.4 * dens - 0.9 * (y - 0.3),
    )
    return [ramp(L.crown, light), smoothstep(0, 0.05, dens)]
  })
  return c.image(seed + 99, 5)
}

const DESK = {
  wall: [hex(0x3b2a22), hex(0x6a4b36)] as const,
  glow: hex(0xf0d3a8),
  desk: [hex(0xb99470), hex(0xe0c7a3)] as const,
  paper: hex(0xf6eddf),
  paperUnder: hex(0xece0cb),
  shadow: hex(0x3a2618),
  glass: hex(0x1b1619),
  glassLit: hex(0x8d7d70),
  glassWarm: hex(0xb7804f),
  cap: hex(0x231d1d),
  penBody: hex(0x161214),
  penLit: hex(0x5d5355),
  gold: hex(0xd2a64d),
  goldDark: hex(0x8b6726),
  eraser: [hex(0xd98a7a), hex(0x4f6a90)] as const,
  tin: [hex(0x8b6726), hex(0xe6c477)] as const,
}

/**
 * A writing desk in warm light: sheets of paper on a wooden desk, a square ink bottle, a
 * black-and-gold fountain pen, an eraser and a round brass tin of pins.
 */
export function generateDeskScene({ width, height, seed }: Opts): RgbaImage {
  const c = new Canvas(width, height)
  const A = c.aspect
  const n = (x: number, y: number, period: number, oct: number, s: number) =>
    fbmPeriodic(x / A, y, period, oct, seed + s)
  const D = DESK
  const horizon = 0.3

  c.paint((x, y) => {
    const grain = 0.5 + 0.5 * n(x * 0.25, y * 3, 8, 4, 1)
    let col =
      y < horizon
        ? mixRgb(D.wall[0], D.wall[1], 0.35 * grain + 0.4 * (y / horizon))
        : mixRgb(D.desk[0], D.desk[1], 0.55 * smoothstep(horizon, 1, y) + 0.3 * grain)
    const glow = 1 - smoothstep(0, 0.95, Math.hypot(x - 0.2 * A, (y - 0.05) * 1.3))
    col = mixRgb(col, D.glow, 0.6 * glow)
    return [col, 1]
  })

  const sheet =
    (cx: number, cy: number, hx: number, hy: number, deg: number) => (x: number, y: number) => {
      const [u, v] = local(x, y, cx, cy, deg)
      return boxDistance(u, v, hx, hy, 0.004)
    }
  const under = sheet(0.6 * A, 0.7, 0.62, 0.34, -5)
  const top = sheet(0.5 * A, 0.68, 0.6, 0.33, -12)
  for (const [shape, col] of [
    [under, D.paperUnder],
    [top, D.paper],
  ] as const) {
    c.paint((x, y) => {
      const d = shape(x - 0.014, y - 0.024)
      return [D.shadow, 0.32 * c.cover(d, 0.05)]
    })
    c.paint((x, y) => {
      const d = shape(x, y)
      if (d > 2 * c.px) return undefined
      const fibre = n(x, y * 4, 20, 3, 5)
      const lit = 1 - smoothstep(0, 1.2, Math.hypot(x - 0.25 * A, y - 0.3))
      return [mixRgb(mixRgb(col, D.glow, 0.35 * lit), D.paperUnder, 0.25 * fibre), c.cover(d)]
    })
  }

  // The ink bottle, top right, with its shadow.
  const bx = 1.08
  c.paint((x, y) => {
    const lift = clamp01((y - 0.36) / 0.13)
    const d = boxDistance(x - bx - 0.055 * lift - 0.02, y - 0.38, 0.105, 0.11, 0.03)
    return [D.shadow, 0.5 * lift * c.cover(d, 0.04)]
  })
  c.paint((x, y) => {
    const body = boxDistance(x - bx, y - 0.36, 0.105, 0.125, 0.02)
    const neck = boxDistance(x - bx, y - 0.215, 0.045, 0.03, 0.008)
    const cap = boxDistance(x - bx, y - 0.165, 0.055, 0.04, 0.01)
    const d = Math.min(body, neck, cap)
    if (d > 2 * c.px) return undefined
    let col = cap < Math.min(body, neck) ? D.cap : D.glass
    if (body <= 0) {
      const stripe = 1 - smoothstep(0.004, 0.012, Math.abs(x - (bx - 0.06)))
      const warm = smoothstep(0.03, 0.1, x - bx)
      col = mixRgb(mixRgb(col, D.glassLit, 0.65 * stripe), D.glassWarm, 0.35 * warm)
    }
    if (cap <= 0 && Math.abs(y - 0.19) < 0.006) col = D.goldDark
    return [col, c.cover(d)]
  })

  // The pen, lying across the paper toward the bottle.
  const p0: readonly [number, number] = [0.1 * A, 0.9]
  const p1: readonly [number, number] = [0.74 * A, 0.62]
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
  const ux = (p1[0] - p0[0]) / len
  const uy = (p1[1] - p0[1]) / len
  const along = (x: number, y: number) => {
    const t = ((x - p0[0]) * ux + (y - p0[1]) * uy) / len
    const s = -(x - p0[0]) * uy + (y - p0[1]) * ux
    return { t, s }
  }
  const radius = (t: number) => {
    if (t < 0 || t > 1) return -1
    if (t < 0.72) return 0.024 * (t < 0.04 ? 0.6 + 10 * t : 1)
    if (t < 0.82) return 0.019
    return 0.021 * (1 - (t - 0.82) / 0.18) ** 0.75
  }
  c.paint((x, y) => {
    const { t, s } = along(x - 0.012, y - 0.02)
    const r = radius(t)
    if (r <= 0) return undefined
    return [D.shadow, 0.35 * c.cover(Math.abs(s) - r, 0.02)]
  })
  c.paint((x, y) => {
    const { t, s } = along(x, y)
    const r = radius(t)
    if (r <= 0) return undefined
    const d = Math.abs(s) - r
    if (d > 2 * c.px) return undefined
    const nib = t >= 0.82
    let col = nib ? D.gold : D.penBody
    const band = Math.abs(t - 0.3) < 0.009 || Math.abs(t - 0.71) < 0.007
    if (band) col = D.gold
    if (nib && Math.abs(s) < 0.0016 && t > 0.88) col = D.goldDark
    if (nib && Math.hypot((t - 0.875) * len, s) < 0.0045) col = D.goldDark
    const lit = 1 - smoothstep(0, 0.6 * r, Math.abs(s + 0.45 * r))
    col = mixRgb(col, nib || band ? D.glow : D.penLit, 0.6 * lit)
    return [col, c.cover(d)]
  })

  // An eraser and a round tin, bottom right, each over its shadow.
  const eraser = (x: number, y: number) => {
    const [u, v] = local(x, y, 0.98, 0.93, -28)
    return { u, d: boxDistance(u, v, 0.07, 0.03, 0.008) }
  }
  const tin = (x: number, y: number) => Math.hypot(x - 1.17, y - 0.82) - 0.062
  c.paint((x, y) => {
    const d = Math.min(eraser(x - 0.01, y - 0.016).d, tin(x - 0.012, y - 0.02))
    return [D.shadow, 0.38 * c.cover(d, 0.025)]
  })
  c.paint((x, y) => {
    const { u, d } = eraser(x, y)
    if (d > 2 * c.px) return undefined
    const t = 0.5 + 0.5 * n(x, y, 30, 3, 60)
    const col = u < -0.012 ? D.eraser[1] : mixRgb(D.eraser[0], D.glow, 0.25 * t)
    return [col, c.cover(d)]
  })
  c.paint((x, y) => {
    const d = tin(x, y)
    if (d > 2 * c.px) return undefined
    // A turned lid: a lit rim, a darker groove, a brushed face.
    const rim = smoothstep(-0.014, -0.004, d)
    const groove = 1 - smoothstep(0.002, 0.005, Math.abs(d + 0.018))
    const lit = clamp01(0.55 - 3.5 * (x - 1.17) - 3.5 * (y - 0.82))
    let col = mixRgb(D.tin[0], D.tin[1], 0.25 + 0.6 * lit + 0.15 * rim)
    col = mixRgb(col, D.goldDark, 0.6 * groove)
    return [col, c.cover(d)]
  })
  return c.image(seed + 98, 5)
}

const FIELD = {
  skyTop: hex(0x9fb9d4),
  skyLow: hex(0xf3e9d6),
  cloud: hex(0xfaf5ec),
  cloudShade: hex(0xcfd6de),
  hills: [hex(0x8fa1b4), hex(0x6f8a7e)] as const,
  hedge: hex(0x3d5440),
  crop: [hex(0xb98f3c), hex(0xe3c56f), hex(0xf2e2a4)] as const,
  furrow: hex(0x8a6a34),
  trunk: hex(0x3f3028),
  crown: [hex(0x2c4636), hex(0x55764c), hex(0x86a268)] as const,
}

/**
 * A field under a wide sky, portrait: heaped clouds, two lines of far hills, a hedge with one
 * tree at the horizon, and rows of ripe crop running to a vanishing point.
 */
export function generateFieldLandscape({ width, height, seed }: Opts): RgbaImage {
  const c = new Canvas(width, height)
  const A = c.aspect
  const n = (x: number, y: number, period: number, oct: number, s: number) =>
    fbmPeriodic(x / A, y, period, oct, seed + s)
  const F = FIELD
  const horizon = 0.56
  const vx = 0.42 * A

  c.paint((x, y) => {
    let col = mixRgb(F.skyTop, F.skyLow, smoothstep(0, horizon, y))
    // Heaped clouds: a lit top, a shaded flat base.
    const mass = n(x * 0.8, y * 2.2, 3, 5, 1) + 0.35 * n(x, y * 2, 9, 3, 2)
    const cloud = smoothstep(0.02, 0.3, mass) * (1 - smoothstep(horizon - 0.2, horizon - 0.04, y))
    const base = smoothstep(-0.1, 0.25, n(x * 0.8, (y - 0.035) * 2.2, 3, 5, 1) - mass + 0.12)
    col = mixRgb(col, mixRgb(F.cloud, F.cloudShade, 0.7 * base), 0.9 * cloud)
    return [col, 1]
  })

  for (const [base, amp, period, s, col] of [
    [horizon - 0.05, 0.05, 2, 10, F.hills[0]],
    [horizon - 0.015, 0.03, 3, 20, F.hills[1]],
  ] as const) {
    c.paint((x, y) => {
      const edge = base + amp * fbm1D(x / A, period, 4, seed + s)
      if (y < edge - 2 * c.px || y > horizon + 2 * c.px) return undefined
      return [mixRgb(col, F.skyLow, 0.25), c.cover(edge - y, 0.003)]
    })
  }

  // The crop: rows fan out from the vanishing point, lighter where the wind lays them over.
  c.paint((x, y) => {
    if (y < horizon - 2 * c.px) return undefined
    const depth = (y - horizon) / (1 - horizon)
    const row = (x - vx) / (0.02 + depth)
    const f = row * 3.2 - Math.floor(row * 3.2)
    const wind = 0.5 + 0.5 * n(x * 0.5, y * 3, 6, 4, 30)
    let col = ramp(F.crop, clamp01(0.15 + 0.55 * wind + 0.3 * (1 - depth)))
    const cut = (1 - smoothstep(0.08, 0.2, Math.abs(f - 0.5))) * smoothstep(0.03, 0.3, depth)
    col = mixRgb(col, F.furrow, 0.55 * cut)
    const ears = latticeHash(Math.floor(x * 300), Math.floor(y * 300), seed + 31)
    col = mixRgb(col, F.crop[2], 0.25 * ears * depth)
    return [col, c.cover(horizon - y)]
  })

  // The hedge along the horizon and the tree that stands in it.
  c.paint((x, y) => {
    const top = horizon - 0.012 - 0.008 * fbm1D(x / A, 14, 3, seed + 40)
    const d = Math.max(top - y, y - horizon - 0.004)
    return d < 2 * c.px ? [F.hedge, c.cover(d)] : undefined
  })
  const tx = 0.7 * A
  c.paint((x, y) => {
    const d = boxDistance(x - tx, y - (horizon - 0.04), 0.006, 0.045, 0.003)
    return d < 2 * c.px ? [F.trunk, c.cover(d)] : undefined
  })
  c.paint((x, y) => {
    const e = ((x - tx) / 0.085) ** 2 + ((y - (horizon - 0.13)) / 0.075) ** 2
    const dens = 1 - e + 0.4 * n(x, y, 12, 4, 41)
    if (dens < -0.02) return undefined
    const light = clamp01(0.4 + 0.45 * n(x, y, 20, 3, 42) - 4 * (y - (horizon - 0.13)))
    return [ramp(F.crown, light), smoothstep(0, 0.08, dens)]
  })
  return c.image(seed + 97, 4)
}
