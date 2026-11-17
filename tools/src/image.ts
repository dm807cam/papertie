import { createHash } from 'node:crypto'

export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** SHA-256 over the dimensions and raw RGBA bytes, as hex. */
export function rawSha256(img: RgbaImage): string {
  const h = createHash('sha256')
  h.update(`${img.width}x${img.height}:`)
  h.update(img.data)
  return h.digest('hex')
}

/** SHA-256 of a UTF-8 string, as hex. */
export function textSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Luma (0-255) of pixel `i`, composited over white. */
function luma(data: Uint8ClampedArray, i: number): number {
  const a = (data[i * 4 + 3] as number) / 255
  const y =
    0.299 * (data[i * 4] as number) +
    0.587 * (data[i * 4 + 1] as number) +
    0.114 * (data[i * 4 + 2] as number)
  return y * a + 255 * (1 - a)
}

/**
 * Mean absolute luma differences: wrapX compares the last column with the first, wrapY the last
 * row with the first, interior averages every adjacent pair inside the image.
 */
export function seamScore(img: RgbaImage): { wrapX: number; wrapY: number; interior: number } {
  const { width: w, height: h, data } = img
  let wrapX = 0
  let wrapY = 0
  let interior = 0
  let pairs = 0
  for (let y = 0; y < h; y++) {
    wrapX += Math.abs(luma(data, y * w + w - 1) - luma(data, y * w))
    for (let x = 0; x < w; x++) {
      const l = luma(data, y * w + x)
      if (x + 1 < w) {
        interior += Math.abs(l - luma(data, y * w + x + 1))
        pairs++
      }
      if (y + 1 < h) {
        interior += Math.abs(l - luma(data, (y + 1) * w + x))
        pairs++
      }
    }
  }
  for (let x = 0; x < w; x++) wrapY += Math.abs(luma(data, (h - 1) * w + x) - luma(data, x))
  return { wrapX: wrapX / h, wrapY: wrapY / w, interior: pairs ? interior / pairs : 0 }
}
