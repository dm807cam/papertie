import type { RgbaImage } from '../image'
import { latticeHash } from '../rng'
import { fbmPeriodic, hex, mixRgb, type Rgb, smoothstep } from './noise'

const SKY_TOP = hex(0xcfdce6)
const SKY_BOTTOM = hex(0xf3ebdd)
const SUN = hex(0xfff1cf)

interface Ridge {
  base: number
  amp: number
  freq: number
  top: Rgb
  bottom: Rgb
}

const RIDGES: readonly Ridge[] = [
  { base: 0.5, amp: 0.1, freq: 3, top: hex(0x8d9bb5), bottom: hex(0xb7c0cf) },
  { base: 0.62, amp: 0.09, freq: 5, top: hex(0x6f8a74), bottom: hex(0xa0b29c) },
  { base: 0.78, amp: 0.08, freq: 8, top: hex(0x435f4a), bottom: hex(0x6d8670) },
]

/** Muted landscape: sky gradient, soft sun and three ridge bands, with fine deterministic grain. */
export function generateSamplePhoto(opts: {
  width: number
  height: number
  seed: number
}): RgbaImage {
  const { width, height, seed } = opts
  const data = new Uint8ClampedArray(width * height * 4)
  const sunX = 0.68
  const sunY = 0.34
  const ridgeY = RIDGES.map((r, k) => (u: number) => {
    const n = fbmPeriodic(u * 0.5, 0.25 + k * 0.1, r.freq, 4, seed + 11 * k) * 0.5 + 0.5
    return r.base + (n - 0.5) * 2 * r.amp
  })
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width
      let c = mixRgb(SKY_TOP, SKY_BOTTOM, smoothstep(0, 0.65, v))
      const d = Math.hypot((u - sunX) * (width / height), v - sunY)
      c = mixRgb(c, SUN, 0.85 * (1 - smoothstep(0.04, 0.22, d)))
      for (let k = 0; k < RIDGES.length; k++) {
        const r = RIDGES[k] as Ridge
        const edge = (ridgeY[k] as (u: number) => number)(u)
        const cover = smoothstep(edge, edge + 0.004, v)
        if (cover <= 0) continue
        const body = mixRgb(r.top, r.bottom, 1 - smoothstep(edge, 1, v) * 0.6)
        c = mixRgb(c, body, cover)
      }
      const grain = (latticeHash(x, y, seed + 77) - 0.5) * 6
      const o = (y * width + x) * 4
      data[o] = c[0] + grain
      data[o + 1] = c[1] + grain
      data[o + 2] = c[2] + grain
      data[o + 3] = 255
    }
  }
  return { width, height, data }
}
