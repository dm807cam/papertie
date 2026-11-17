import { assetUrl } from './assets'

/** Pixels the tone is sampled from: the 256 px file drawn down to this square. */
const SAMPLE_PX = 16

const hex2 = (v: number) => Math.round(v).toString(16).padStart(2, '0')

/** The alpha-weighted mean of RGBA pixels as `#rrggbb`; undefined when none is opaque at all. */
export function averageColor(rgba: Uint8ClampedArray): string | undefined {
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  for (let k = 0; k + 3 < rgba.length; k += 4) {
    const w = rgba[k + 3] as number
    r += (rgba[k] as number) * w
    g += (rgba[k + 1] as number) * w
    b += (rgba[k + 2] as number) * w
    a += w
  }
  return a > 0 ? `#${hex2(r / a)}${hex2(g / a)}${hex2(b / a)}` : undefined
}

/**
 * The average colour of a decoded image, drawn down to a tiny square; undefined without a DOM,
 * or when no pixel is opaque.
 */
export function toneOfImage(img: CanvasImageSource): string | undefined {
  if (typeof document === 'undefined') return undefined
  const c = document.createElement('canvas')
  c.width = SAMPLE_PX
  c.height = SAMPLE_PX
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (ctx === null) return undefined
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, SAMPLE_PX, SAMPLE_PX)
  return averageColor(ctx.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX).data)
}

/**
 * The average colour of a decoded bitmap, scaled to the tiny square by the browser off the main
 * thread (`createImageBitmap` with a resize), so only 256 pixels are read here. Undefined where
 * there is no canvas, or anything fails.
 */
export async function toneOfBitmap(bitmap: ImageBitmap): Promise<string | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined
  let small: ImageBitmap
  try {
    small = await createImageBitmap(bitmap, {
      resizeWidth: SAMPLE_PX,
      resizeHeight: SAMPLE_PX,
      resizeQuality: 'high',
    })
  } catch {
    return undefined
  }
  try {
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(SAMPLE_PX, SAMPLE_PX)
        : typeof document === 'undefined'
          ? null
          : Object.assign(document.createElement('canvas'), { width: SAMPLE_PX, height: SAMPLE_PX })
    const ctx = canvas?.getContext('2d', { willReadFrequently: true }) ?? null
    if (ctx === null) return undefined
    ctx.drawImage(small, 0, 0)
    return averageColor(ctx.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX).data)
  } catch {
    return undefined
  } finally {
    small.close()
  }
}

/** Tones measured elsewhere, by asset id: a photo just uploaded was seen as a preview. */
const primed = new Map<string, string>()

/**
 * Give an asset's tone before anyone asks (the preview of a photo being uploaded), so the
 * overview's card has its colour from the first frame and fetches nothing to get it.
 */
export function primeTone(assetId: string, tone: string): void {
  primed.set(assetId, tone)
}

/** A print's tone by asset id: asked for (measured once), or only looked up (`peek`). */
export interface ToneCache {
  (assetId: string): string | undefined
  /** The tone if known, without fetching the file to measure it. */
  peek(assetId: string): string | undefined
}

/**
 * A print's image tone for the overview's cards: the average colour of its asset's 256 px file.
 * Each file is decoded once, the first time a card asks; until then (and without a DOM, or if
 * it fails) the answer is undefined, and `onTone` runs with the asset when its tone is known.
 */
export function createToneCache(onTone: (assetId: string) => void): ToneCache {
  const tones = new Map<string, string | null>()
  const peek = (assetId: string) =>
    primed.get(assetId) ?? tones.get(assetUrl(assetId, 256)) ?? undefined
  const ask = (assetId: string) => {
    const url = assetUrl(assetId, 256)
    const seen = primed.get(assetId)
    if (seen !== undefined) return seen
    const known = tones.get(url)
    if (known !== undefined) return known ?? undefined
    tones.set(url, null)
    if (typeof Image !== 'function' || typeof document === 'undefined') return undefined
    const img = new Image()
    img.src = url
    img
      .decode()
      .then(() => {
        const tone = toneOfImage(img)
        if (tone === undefined) return
        tones.set(url, tone)
        onTone(assetId)
      })
      .catch(() => {
        // Not decodable: the card keeps the neutral tone.
      })
    return undefined
  }
  return Object.assign(ask, { peek })
}
