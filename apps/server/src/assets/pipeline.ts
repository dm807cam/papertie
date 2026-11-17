import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import { ASSET_SIZES, type AssetSize, SERVER_LIMITS } from '../limits'

export type SniffedMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif' | 'image/gif'

const ACCEPTED: ReadonlySet<string> = new Set<SniffedMime>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
])

/** What libvips reports for the formats above (`heif` is AVIF; HEIC is refused by the sniff). */
const ACCEPTED_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp', 'heif', 'gif'])

/**
 * The image type from the file's magic bytes alone. Anything that is not one of the five accepted
 * raster formats, APNG counting as PNG (SVG/XML, HTML, HEIC, PDF, ZIP, text, ...) is `null`.
 */
export async function sniffImage(buf: Uint8Array): Promise<SniffedMime | null> {
  const found = await fileTypeFromBuffer(buf)
  // An animated PNG is still a PNG; decoding is limited to its first frame (`animated: false`).
  const mime = found?.mime === 'image/apng' ? 'image/png' : found?.mime
  return mime && ACCEPTED.has(mime) ? (mime as SniffedMime) : null
}

export class ImageError extends Error {
  constructor(readonly code: 'unsupported-format' | 'undecodable-image' | 'too-many-pixels') {
    super(code)
    this.name = 'ImageError'
  }
}

export interface ProcessedImage {
  width: number
  height: number
  variants: Record<AssetSize, Uint8Array>
}

/** Counting semaphore: at most `limit` tasks run at once, the rest wait in order. */
class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.active++
    try {
      return await fn()
    } finally {
      // Hand the slot straight to the next waiter, or free it.
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}

const pipelines = new Semaphore(SERVER_LIMITS.imageConcurrency)

const decodeOptions = {
  limitInputPixels: SERVER_LIMITS.imageMaxInputPixels,
  failOn: 'error',
  animated: false,
} as const

async function encode(buf: Uint8Array, size: AssetSize) {
  return sharp(buf, decodeOptions)
    .autoOrient()
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: SERVER_LIMITS.imageQuality })
    .toBuffer({ resolveWithObject: true })
}

/**
 * Decodes `buf` (first frame only), applies EXIF orientation and re-encodes it as one WebP per
 * `ASSET_SIZES` entry. Nothing of the input survives but pixels: sharp writes no EXIF, ICC or XMP
 * unless asked to. `width`/`height` are those of the largest variant. Pipelines run at most
 * `imageConcurrency` at a time, process-wide.
 */
export function processImage(buf: Uint8Array): Promise<ProcessedImage> {
  return pipelines.run(async () => {
    try {
      const meta = await sharp(buf, decodeOptions).metadata()
      if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
        throw new ImageError('unsupported-format')
      }
      if ((meta.width ?? 0) * (meta.height ?? 0) > SERVER_LIMITS.imageMaxInputPixels) {
        throw new ImageError('too-many-pixels')
      }
      const variants = {} as Record<AssetSize, Uint8Array>
      let width = 0
      let height = 0
      for (const size of ASSET_SIZES) {
        const { data, info } = await encode(buf, size)
        variants[size] = data
        if (size === ASSET_SIZES[0]) {
          width = info.width
          height = info.height
        }
      }
      return { width, height, variants }
    } catch (e) {
      if (e instanceof ImageError) throw e
      throw new ImageError('undecodable-image')
    }
  })
}
