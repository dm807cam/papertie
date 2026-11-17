/** Whether `file` is a HEIC/HEIF photo (an iPhone's), by type or, when the type is empty, name. */
export function isHeic(file: Pick<File, 'type' | 'name'>): boolean {
  const type = file.type.toLowerCase()
  if (type === 'image/heic' || type === 'image/heif') return true
  return type === '' && /\.hei[cf]$/i.test(file.name)
}

const JPEG_QUALITY = 0.92

async function encodeJpeg(bitmap: ImageBitmap): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (ctx === null) return null
    ctx.drawImage(bitmap, 0, 0)
    return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
  }
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  ctx.drawImage(bitmap, 0, 0)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
}

/**
 * A HEIC photo as a JPEG, through the browser's own decoder (`createImageBitmap`, which decodes
 * off the main thread) and a canvas. Null when the browser cannot decode HEIC (most but
 * Safari), or anything goes wrong: the caller then says so and leaves the file alone.
 */
export async function heicToJpeg(file: File): Promise<File | null> {
  if (typeof createImageBitmap !== 'function') return null
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }
  try {
    const blob = await encodeJpeg(bitmap)
    if (blob === null || blob.size === 0) return null
    const name = `${file.name.replace(/\.hei[cf]$/i, '') || 'photo'}.jpg`
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified })
  } catch {
    return null
  } finally {
    bitmap.close()
  }
}
