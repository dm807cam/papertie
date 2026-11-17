import sharp from 'sharp'

/**
 * The design gallery's images (`e2e/app/gallery.spec.ts`): the lossless PNG kept locally, and
 * the WebP committed in its place.
 */

/**
 * A PNG encoded again at zlib's highest effort, its pixels untouched: no palette, no quantising,
 * no resize.
 */
export async function pngLossless(png: Buffer): Promise<Buffer> {
  const out = await sharp(png)
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false, effort: 10 })
    .toBuffer()
  return out.length < png.length ? out : png
}

/** A lossy WebP of `png` at `quality` (1–100), at libwebp's slowest, smallest effort. */
export function webpFrom(png: Buffer, quality: number): Promise<Buffer> {
  return sharp(png).webp({ quality, effort: 6 }).toBuffer()
}
