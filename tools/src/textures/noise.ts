import { latticeHash } from '../rng'

export type Rgb = readonly [number, number, number]

/** Colour from a 0xRRGGBB literal. */
export function hex(c: number): Rgb {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255]
}

export function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t))
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** Piecewise-linear colour ramp over evenly spaced stops, t in [0, 1]. */
export function ramp(stops: readonly Rgb[], t: number): Rgb {
  const x = clamp01(t) * (stops.length - 1)
  const i = Math.min(Math.floor(x), stops.length - 2)
  return mixRgb(stops[i] as Rgb, stops[i + 1] as Rgb, x - i)
}

function wrap(i: number, p: number): number {
  const r = i % p
  return r < 0 ? r + p : r
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

/** Value noise in [-1, 1], in lattice units, exactly periodic in both axes. */
export function periodicNoise2D(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = fade(x - x0)
  const ty = fade(y - y0)
  const i0 = wrap(x0, period)
  const i1 = wrap(x0 + 1, period)
  const j0 = wrap(y0, period)
  const j1 = wrap(y0 + 1, period)
  const c00 = latticeHash(i0, j0, seed)
  const c10 = latticeHash(i1, j0, seed)
  const c01 = latticeHash(i0, j1, seed)
  const c11 = latticeHash(i1, j1, seed)
  const top = c00 + (c10 - c00) * tx
  const bottom = c01 + (c11 - c01) * tx
  return (top + (bottom - top) * ty) * 2 - 1
}

/** Fractal sum of periodic noise; u, v in tile units, tiles over the unit square. */
export function fbmPeriodic(
  u: number,
  v: number,
  basePeriod: number,
  octaves: number,
  seed: number,
): number {
  let sum = 0
  let norm = 0
  let amp = 1
  let period = basePeriod
  for (let o = 0; o < octaves; o++) {
    sum += amp * periodicNoise2D(u * period, v * period, period, seed + o)
    norm += amp
    amp *= 0.5
    period *= 2
  }
  return sum / norm
}

/** One-dimensional fbm in [-1, 1] with period 1 in u. */
export function fbm1D(u: number, basePeriod: number, octaves: number, seed: number): number {
  return fbmPeriodic(u, 0.5, basePeriod, octaves, seed)
}

/** Tileable cellular noise: nearest two feature distances (tile units) and the nearest cell. */
export function worleyPeriodic(
  u: number,
  v: number,
  cells: number,
  seed: number,
): { f1: number; f2: number; cellId: number } {
  const cu = u * cells
  const cv = v * cells
  const ci = Math.floor(cu)
  const cj = Math.floor(cv)
  let d1 = Number.POSITIVE_INFINITY
  let d2 = Number.POSITIVE_INFINITY
  let cellId = 0
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const ni = ci + di
      const nj = cj + dj
      const wi = wrap(ni, cells)
      const wj = wrap(nj, cells)
      const dx = ni + latticeHash(wi, wj, seed) - cu
      const dy = nj + latticeHash(wi, wj, seed + 7919) - cv
      const d = dx * dx + dy * dy
      if (d < d1) {
        d2 = d1
        d1 = d
        cellId = wi + wj * cells
      } else if (d < d2) {
        d2 = d
      }
    }
  }
  return { f1: Math.sqrt(d1) / cells, f2: Math.sqrt(d2) / cells, cellId }
}
