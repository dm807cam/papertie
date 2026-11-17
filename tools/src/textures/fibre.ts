import type { RgbaImage } from '../image'
import { mulberry32 } from '../rng'
import { fbmPeriodic, hex, mixRgb } from './noise'

const WHITE = hex(0xffffff)
const FIBRE_BROWN = hex(0x8a6a45)

/**
 * Seamless fibre fibre overlay: a faint formation cloud plus curved fibres stamped with wrapped
 * coordinates, composited "over" in premultiplied floats.
 */
export function generateFibre(opts: { size?: number; seed: number; fibres?: number }): RgbaImage {
  const size = opts.size ?? 512
  const fibres = opts.fibres ?? 900
  const n = size * size
  const pr = new Float32Array(n)
  const pg = new Float32Array(n)
  const pb = new Float32Array(n)
  const pa = new Float32Array(n)
  const cloud = FIBRE_BROWN
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a =
        (10 * (fbmPeriodic((x + 0.5) / size, (y + 0.5) / size, 6, 4, opts.seed) * 0.5 + 0.5)) / 255
      const i = y * size + x
      pr[i] = (cloud[0] / 255) * a
      pg[i] = (cloud[1] / 255) * a
      pb[i] = (cloud[2] / 255) * a
      pa[i] = a
    }
  }

  const rand = mulberry32(opts.seed + 404)
  const step = 0.5
  for (let f = 0; f < fibres; f++) {
    const x0 = rand() * size
    const y0 = rand() * size
    const theta = rand() * Math.PI * 2
    const len = 20 + rand() * 100
    const bend = (rand() * 2 - 1) * 0.3
    const width = 0.6 + rand() * 0.8
    const alpha = 0.05 + rand() * 0.13
    const col = mixRgb(WHITE, FIBRE_BROWN, rand() * 0.5)
    const x2 = x0 + Math.cos(theta) * len
    const y2 = y0 + Math.sin(theta) * len
    const cx = x0 + Math.cos(theta + bend) * len * 0.5
    const cy = y0 + Math.sin(theta + bend) * len * 0.5
    // Each pixel is hit by about width / step stamps, so spread the target alpha across them.
    const stampAlpha = 1 - (1 - alpha) ** (step / width)
    const radius = width / 2
    const stamps = Math.max(2, Math.ceil(len / step))
    for (let s = 0; s <= stamps; s++) {
      const t = s / stamps
      const k = 1 - t
      const px = k * k * x0 + 2 * k * t * cx + t * t * x2
      const py = k * k * y0 + 2 * k * t * cy + t * t * y2
      const ix0 = Math.floor(px - radius - 1)
      const iy0 = Math.floor(py - radius - 1)
      const ix1 = Math.ceil(px + radius + 1)
      const iy1 = Math.ceil(py + radius + 1)
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const d = Math.hypot(ix + 0.5 - px, iy + 0.5 - py)
          const cover = Math.min(1, Math.max(0, radius + 0.5 - d))
          if (cover <= 0) continue
          const a = stampAlpha * cover
          const wx = ((ix % size) + size) % size
          const wy = ((iy % size) + size) % size
          const i = wy * size + wx
          const inv = 1 - a
          pr[i] = (col[0] / 255) * a + (pr[i] as number) * inv
          pg[i] = (col[1] / 255) * a + (pg[i] as number) * inv
          pb[i] = (col[2] / 255) * a + (pb[i] as number) * inv
          pa[i] = a + (pa[i] as number) * inv
        }
      }
    }
  }

  const data = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const a = pa[i] as number
    if (a <= 0) continue
    data[i * 4] = Math.round(((pr[i] as number) / a) * 255)
    data[i * 4 + 1] = Math.round(((pg[i] as number) / a) * 255)
    data[i * 4 + 2] = Math.round(((pb[i] as number) / a) * 255)
    data[i * 4 + 3] = Math.round(a * 255)
  }
  return { width: size, height: size, data }
}
