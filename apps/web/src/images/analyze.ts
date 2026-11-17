import { toneOfBitmap } from '../lib/imageTone'

/** What a photo needs to be shown at once, from one decode. */
export interface Analysis {
  width: number
  height: number
  /** Its average colour, for the overview's card. */
  tone?: string
  /** A smaller copy to preview from, when the file is large; the file itself otherwise. */
  preview?: Blob
}

/** The preview's long edge: a print at 3x zoom on a plain screen. */
const PREVIEW_EDGE = 1024
/** Files at or under these are previewed as they are. */
const SMALL_BYTES = 1_500_000
const SMALL_EDGE = 1600

/** A smaller copy of `bitmap`, scaled and encoded off the main thread; undefined if it cannot. */
async function previewOf(bitmap: ImageBitmap, source: Blob): Promise<Blob | undefined> {
  const long = Math.max(bitmap.width, bitmap.height)
  if (source.size <= SMALL_BYTES && long <= SMALL_EDGE) return undefined
  const k = PREVIEW_EDGE / long
  const w = Math.max(1, Math.round(bitmap.width * k))
  const h = Math.max(1, Math.round(bitmap.height * k))
  try {
    const small = await createImageBitmap(bitmap, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'medium',
    })
    try {
      // JPEG stays JPEG; the rest may carry transparency, which WebP keeps.
      const type = source.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp'
      let out: Blob | null = null
      if (typeof OffscreenCanvas === 'function') {
        const canvas = new OffscreenCanvas(w, h)
        canvas.getContext('2d')?.drawImage(small, 0, 0)
        out = await canvas.convertToBlob({ type, quality: 0.82 })
      } else if (typeof document !== 'undefined') {
        const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h })
        canvas.getContext('2d')?.drawImage(small, 0, 0)
        out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.82))
      }
      return out !== null && out.size > 0 && out.size < source.size ? out : undefined
    } finally {
      small.close()
    }
  } catch {
    return undefined
  }
}

/** Size and tone from the image element, for a browser without `createImageBitmap`. */
async function analyzeWithElement(blob: Blob): Promise<Analysis | null> {
  if (typeof Image !== 'function' || typeof URL.createObjectURL !== 'function') return null
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { width: img.naturalWidth, height: img.naturalHeight }
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * A photo's size, tone and (for a large file) a small preview, from ONE full decode: the browser
 * decodes `blob` to a bitmap off the main thread, and the tone and the preview are scaled from
 * that bitmap, also off it. The main thread only reads 256 pixels. Null when it is no image.
 */
export async function analyzeImage(blob: Blob): Promise<Analysis | null> {
  if (typeof createImageBitmap !== 'function') return analyzeWithElement(blob)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    return null
  }
  try {
    const [tone, preview] = await Promise.all([toneOfBitmap(bitmap), previewOf(bitmap, blob)])
    const out: Analysis = { width: bitmap.width, height: bitmap.height }
    if (tone !== undefined) out.tone = tone
    if (preview !== undefined) out.preview = preview
    return out
  } finally {
    bitmap.close()
  }
}
