import type { RgbaImage } from '../image'
import { latticeHash } from '../rng'
import { clamp01, fbmPeriodic, hex, mixRgb, ramp, smoothstep, worleyPeriodic } from './noise'

/** Granule body, darkest to lightest, 0xRRGGBB: warm brown, not orange. */
export const CORK_FINE_RAMP = { dark: 0x925f39, mid: 0xad7446, light: 0xd2a06d } as const
const GRANULE_DARK = hex(CORK_FINE_RAMP.dark)
const GRANULE_MID = hex(CORK_FINE_RAMP.mid)
const GRANULE_LIGHT = hex(CORK_FINE_RAMP.light)
/** The crevices between granules that do not touch, and the pores in a granule. */
const CREVICE = hex(0x4a2e1a)
const PORE = hex(0x3e2614)
const SPECK = hex(0xdcb07f)
const WHITE = hex(0xffffff)
const MOTTLE = hex(0xe2be9a)

/** Light direction for the granule relief (from the upper left), normalised. */
const LIGHT = (() => {
  const v = [-0.55, -0.62, 0.56]
  const n = Math.hypot(...v)
  return v.map((c) => c / n) as [number, number, number]
})()

function wrap(i: number, p: number): number {
  const r = i % p
  return r < 0 ? r + p : r
}

/** Per-cell feature points of the granule noise: jitter, orientation and elongation. */
interface GranuleField {
  cells: number
  jx: Float64Array
  jy: Float64Array
  cos: Float64Array
  sin: Float64Array
  stretch: Float64Array
}

function granuleField(cells: number, seed: number, stretch: number): GranuleField {
  const n = cells * cells
  const f = {
    cells,
    jx: new Float64Array(n),
    jy: new Float64Array(n),
    cos: new Float64Array(n),
    sin: new Float64Array(n),
    stretch: new Float64Array(n),
  }
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const k = i + j * cells
      const theta = latticeHash(i, j, seed + 31) * Math.PI
      f.jx[k] = latticeHash(i, j, seed)
      f.jy[k] = latticeHash(i, j, seed + 7919)
      f.cos[k] = Math.cos(theta)
      f.sin[k] = Math.sin(theta)
      f.stretch[k] = 1 + stretch * latticeHash(i, j, seed + 57)
    }
  }
  return f
}

/**
 * Tileable cellular noise with an elongated, rotated metric per feature point, so cells read as
 * rice-like granules lying every which way. Returns the nearest two distances (cell units) and
 * the nearest cell.
 */
function granules(u: number, v: number, f: GranuleField) {
  const { cells } = f
  const cu = u * cells
  const cv = v * cells
  const ci = Math.floor(cu)
  const cj = Math.floor(cv)
  let d1 = Number.POSITIVE_INFINITY
  let d2 = Number.POSITIVE_INFINITY
  let cellId = 0
  for (let dj = -2; dj <= 2; dj++) {
    const nj = cj + dj
    const row = wrap(nj, cells) * cells
    for (let di = -2; di <= 2; di++) {
      const ni = ci + di
      const k = wrap(ni, cells) + row
      const dx = ni + (f.jx[k] as number) - cu
      const dy = nj + (f.jy[k] as number) - cv
      const c = f.cos[k] as number
      const s = f.sin[k] as number
      const st = f.stretch[k] as number
      const a = (dx * c + dy * s) / st
      const b = (dy * c - dx * s) * st * 0.85
      const d = Math.sqrt(a * a + b * b)
      if (d < d1) {
        d2 = d1
        d1 = d
        cellId = k
      } else if (d < d2) {
        d2 = d
      }
    }
  }
  return { f1: d1, f2: d2, cellId }
}

/** A 3 × 3 box blur with wrapped edges, which rounds the facets of the cell-distance relief. */
function blurWrapped(src: Float32Array, size: number): Float32Array {
  const out = new Float32Array(src.length)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0
      for (let dy = -1; dy <= 1; dy++) {
        const row = wrap(y + dy, size) * size
        for (let dx = -1; dx <= 1; dx++) sum += src[row + wrap(x + dx, size)] as number
      }
      out[y * size + x] = sum / 9
    }
  }
  return out
}

/** The look of the fine cork tile; see `generateCorkFine`. */
export const CORK_FINE = {
  /** Granules across the tile: 12.8 px each at 1024, 6.4 screen px at zoom 1 (shown at 512). */
  cells: 80,
  /** Domain warp, in granule widths: how far outlines wander from straight Voronoi edges. */
  warp: 0.75,
  /** Elongation of a granule: 1 to 1 + this, so some are round and some are worm-like. */
  stretch: 1.1,
  /** Lambert shade is `ambient + diffuse * lambert`. */
  ambient: 0.79,
  diffuse: 0.45,
  /** Self-shadow: how far up-left (granule widths) a higher neighbour shades, and how hard. */
  shadowReach: 0.22,
  shadowStrength: 1.2,
  /** Share of granule borders left open as dark crevices, and their darkening. */
  openShare: 0.45,
  crevice: 0.72,
  /** Where granules touch, the seam sinks to this share of a dome's height (a crevice: 0). */
  seamDepth: 0.55,
} as const

/**
 * Seamless agglomerated cork: irregular, domed granules of varying tone pressed together, lit
 * from the upper left with a soft self-shadow on their lower right, dark crevices where they do
 * not touch, dark pores and a few pale flecks. The relief comes from a wrapped height field, so
 * the lighting tiles too.
 */
export function generateCorkFine(opts: { size?: number; seed: number; cells?: number }): RgbaImage {
  const size = opts.size ?? 1024
  const cells = opts.cells ?? CORK_FINE.cells
  const { seed } = opts
  const k = CORK_FINE
  const warp = Math.max(1, Math.round(cells / 4))
  const field = granuleField(cells, seed, k.stretch)
  const n = size * size
  const height = new Float32Array(n)
  const border = new Float32Array(n)
  const tone = new Float32Array(n)
  const speck = new Float32Array(n)
  const open = new Float32Array(n)
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      // Warp the lookup so granule outlines are irregular rather than straight Voronoi edges.
      const wu = u + (k.warp / cells) * fbmPeriodic(u, v, warp, 3, seed + 11)
      const wv = v + (k.warp / cells) * fbmPeriodic(u, v, warp, 3, seed + 13)
      const g = granules(wu, wv, field)
      const d = g.f2 - g.f1
      const lift = latticeHash(g.cellId, 3, seed + 202)
      // Most granules press against their neighbours; some leave an open crevice.
      const gape = smoothstep(
        1 - k.openShare - 0.15,
        1 - k.openShare + 0.15,
        fbmPeriodic(u, v, warp * 2, 2, seed + 17) * 0.5 + 0.5,
      )
      // A granule is a low dome, flat-topped, falling off over its outer third: into a crevice
      // where it gapes, only to a shallow seam where it presses against its neighbour.
      const floor = k.seamDepth * (1 - gape)
      const dome = floor + (1 - floor) * smoothstep(0, 0.42, d) ** 0.7
      const grain = fbmPeriodic(u, v, cells * 4, 2, seed + 404)
      const i = y * size + x
      height[i] = dome * (0.6 + 0.4 * lift) + 0.2 * grain
      border[i] = d
      open[i] = gape
      // Per granule, a broad drift across the tile and the cork's own fine porous grain.
      tone[i] =
        0.5 * latticeHash(g.cellId, 0, seed + 202) ** 1.4 +
        0.25 * (fbmPeriodic(u, v, 6, 4, seed + 101) * 0.5 + 0.5) +
        0.25 * (fbmPeriodic(u, v, cells * 6, 2, seed + 505) * 0.5 + 0.5)
      // On the warped lookup, so specks are ragged too, each its own size.
      const specks = cells * 1.5
      const s = worleyPeriodic(wu, wv, specks, seed + 909)
      const kind = latticeHash(s.cellId, 2, seed + 909)
      const r = 0.15 + 0.3 * latticeHash(s.cellId, 4, seed + 909)
      const spot = 1 - smoothstep(r * 0.5, r, s.f1 * specks)
      // Positive: a pale fleck of bark; negative: a dark pore.
      speck[i] = kind < 0.07 ? spot : kind > 0.9 ? -spot : 0
    }
  }

  const relief0 = blurWrapped(blurWrapped(blurWrapped(height, size), size), size)
  const data = new Uint8ClampedArray(n * 4)
  const px = size / cells
  // Height is in units of the granule radius: `relief` scales it to pixels for the normal.
  const relief = px * 0.4
  // Self-shadow: the height a few px towards the light, against this pixel's.
  const reach = Math.max(1, Math.round(px * k.shadowReach))
  const lx = Math.round(-reach * 0.7)
  const ly = Math.round(-reach * 0.8)
  for (let y = 0; y < size; y++) {
    const up = wrap(y - 1, size) * size
    const down = wrap(y + 1, size) * size
    const toward = wrap(y + ly, size) * size
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const left = wrap(x - 1, size)
      const right = wrap(x + 1, size)
      const h = relief0[i] as number
      const hx = ((relief0[y * size + right] as number) - (relief0[y * size + left] as number)) / 2
      const hy = ((relief0[down + x] as number) - (relief0[up + x] as number)) / 2
      const nx = -hx * relief
      const ny = -hy * relief
      const nl = Math.hypot(nx, ny, 1)
      const lambert = (nx * LIGHT[0] + ny * LIGHT[1] + LIGHT[2]) / nl
      const occluder = relief0[toward + wrap(x + lx, size)] as number
      const shadow = clamp01((occluder - h) * k.shadowStrength)
      const shade = (k.ambient + k.diffuse * clamp01(lambert)) * (1 - 0.3 * shadow)
      const base = ramp([GRANULE_DARK, GRANULE_MID, GRANULE_LIGHT], tone[i] as number)
      let c = mixRgb([0, 0, 0], base, Math.min(1.3, shade))
      const gap = 1 - smoothstep(0.01, 0.075, border[i] as number)
      c = mixRgb(c, CREVICE, gap * k.crevice * (0.08 + 0.92 * (open[i] as number)))
      const sp = speck[i] as number
      c = sp > 0 ? mixRgb(c, SPECK, sp * 0.55) : mixRgb(c, PORE, -sp * 0.65)
      const o = i * 4
      data[o] = c[0]
      data[o + 1] = c[1]
      data[o + 2] = c[2]
      data[o + 3] = 255
    }
  }
  return { width: size, height: size, data }
}

/** Seamless low-frequency mottling, white to tan, intended for multiply blending. */
export function generateCorkMottle(opts: { size?: number; seed: number }): RgbaImage {
  const size = opts.size ?? 1597
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size
    for (let x = 0; x < size; x++) {
      const m = fbmPeriodic((x + 0.5) / size, v, 3, 5, opts.seed + 303) * 0.5 + 0.5
      const c = mixRgb(WHITE, MOTTLE, smoothstep(0.35, 0.75, m))
      const o = (y * size + x) * 4
      data[o] = c[0]
      data[o + 1] = c[1]
      data[o + 2] = c[2]
      data[o + 3] = 255
    }
  }
  return { width: size, height: size, data }
}
