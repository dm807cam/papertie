import type { RgbaImage } from '../image'

/**
 * The fibre overlay as it lies on a sheet of one paper colour (`paper`, #RRGGBB): the fibre at
 * `opacity`, multiplied (light papers) or screened (ink) over the paper, flattened to one opaque
 * image, so the paper needs no blended layer of its own.
 */
export function bakeFibre(
  fibre: RgbaImage,
  paper: string,
  blend: 'multiply' | 'screen',
  opacity: number,
): RgbaImage {
  const m = /^#([0-9a-f]{6})$/i.exec(paper)
  if (!m) throw new TypeError(`Invalid hex colour: ${paper}`)
  const n = Number.parseInt(m[1] as string, 16)
  const p = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255)
  const out = new Uint8ClampedArray(fibre.width * fibre.height * 4)
  const d = fibre.data
  for (let i = 0; i < d.length; i += 4) {
    const a = ((d[i + 3] as number) / 255) * opacity
    for (let c = 0; c < 3; c++) {
      const cb = p[c] as number
      const cs = (d[i + c] as number) / 255
      const mixed = blend === 'multiply' ? cb * cs : cb + cs - cb * cs
      out[i + c] = Math.round(((1 - a) * cb + a * mixed) * 255)
    }
    out[i + 3] = 255
  }
  return { width: fibre.width, height: fibre.height, data: out }
}
