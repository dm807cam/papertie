import { crc32, deflateSync } from 'node:zlib'
import sharp from 'sharp'

/** Test images, generated with sharp/zlib at test time (nothing is downloaded). */

const GPS_DATUM = 'GPS-SENTINEL-DATUM'
/** A byte string that is in every `jpegWithExif({ gps: true })` file, to prove it is gone later. */
export const GPS_MARKER = GPS_DATUM

/** A JPEG with EXIF (copyright, optional orientation) and, optionally, GPS tags. */
export function jpegWithExif(opts: {
  w: number
  h: number
  orientation?: number
  gps?: boolean
}): Promise<Buffer> {
  const exif: Record<string, Record<string, string>> = { IFD0: { Copyright: 'SENTINEL-COPYRIGHT' } }
  if (opts.gps) {
    exif.IFD3 = {
      GPSMapDatum: GPS_DATUM,
      GPSLatitudeRef: 'N',
      GPSLatitude: '52/1 30/1 0/1',
      GPSLongitudeRef: 'E',
      GPSLongitude: '13/1 24/1 0/1',
    }
  }
  let img = sharp({
    create: { width: opts.w, height: opts.h, channels: 3, background: '#c33' },
  })
    .jpeg()
    .withExif(exif)
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation })
  return img.toBuffer()
}

export function png(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#36c' } })
    .png()
    .toBuffer()
}

/** A PNG of random pixels: it barely compresses, so its WebP variants are large. */
export function noisePng(w: number, h: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3)
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2_654_435_761 + (i >> 3) * 40_503) & 0xff
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer()
}

/** An animated GIF of `frames` solid-colour frames. */
export function gif(w: number, h: number, frames: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3 * frames)
  for (let f = 0; f < frames; f++) {
    const off = f * w * h * 3
    for (let i = 0; i < w * h; i++) {
      raw[off + i * 3] = (f * 60) % 256
      raw[off + i * 3 + 1] = 200
      raw[off + i * 3 + 2] = 50
    }
  }
  return sharp(raw, { raw: { width: w, height: h * frames, channels: 3, pageHeight: h } })
    .gif({ loop: 0, delay: new Array<number>(frames).fill(100) })
    .toBuffer()
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A PNG with an `acTL` (animation control) chunk before its IDAT: file-type calls it `image/apng`. */
export async function apng(w: number, h: number): Promise<Buffer> {
  const plain = await png(w, h)
  const idat = plain.indexOf('IDAT') - 4
  const actl = Buffer.alloc(8)
  actl.writeUInt32BE(1, 0) // one frame
  return Buffer.concat([plain.subarray(0, idat), pngChunk('acTL', actl), plain.subarray(idat)])
}

/** A PNG whose IHDR declares `w`x`h` with a tiny IDAT: header-valid, nothing like that many pixels. */
export function pngHeaderBomb(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(16))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** `buf` followed by `payload`: a file that is an image and also something else. */
export function withAppended(buf: Uint8Array, payload: string): Buffer {
  return Buffer.concat([buf, Buffer.from(payload, 'utf8')])
}

/** The start of a HEIC file: an `ftyp` box with the `heic` brand. */
export function fakeHeic(): Buffer {
  const box = Buffer.alloc(24)
  box.writeUInt32BE(24, 0)
  box.write('ftypheic', 4, 'ascii')
  box.write('mif1heic', 16, 'ascii')
  return Buffer.concat([box, Buffer.alloc(64)])
}

export const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>'

export const html = '<!doctype html><html><body><script>alert(1)</script></body></html>'

export const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'ascii')
