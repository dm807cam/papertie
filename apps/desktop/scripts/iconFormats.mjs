// The app icon's .icns (macOS) and .ico (Windows), from the PNGs, so no
// Mac or Windows tool is needed to make them: `make-icons.mjs` writes both into `build/`.

/** Apple's icon types holding PNG data, by pixel size: each size's 1x and the 2x it doubles as. */
const ICNS_TYPES = [
  ['ic11', 32], // 16 @2x
  ['ic12', 64], // 32 @2x
  ['ic07', 128],
  ['ic13', 256], // 128 @2x
  ['ic08', 256],
  ['ic14', 512], // 256 @2x
  ['ic09', 512],
  ['ic10', 1024], // 512 @2x
]

/** An .icns of the PNGs in `pngBySize` (pixel size → PNG bytes); 32 to 1024 px are needed. */
export function icns(pngBySize) {
  const parts = []
  for (const [type, size] of ICNS_TYPES) {
    const data = pngBySize.get(size)
    if (!data) throw new Error(`.icns needs a ${size} px PNG`)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'latin1')
    head.writeUInt32BE(8 + data.length, 4)
    parts.push(head, data)
  }
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'latin1')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

/**
 * An .ico of `images` ({size, data}): `data` is an entry's image as the file holds it, a PNG or
 * a DIB (`dib`). Windows reads PNG entries from Vista on; the small sizes are DIBs, which every
 * reader (NSIS's among them) takes.
 */
export function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2) // an icon
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i
    head[e] = size >= 256 ? 0 : size
    head[e + 1] = size >= 256 ? 0 : size
    head[e + 2] = 0 // no palette
    head[e + 3] = 0
    head.writeUInt16LE(1, e + 4) // planes
    head.writeUInt16LE(32, e + 6) // bits per pixel
    head.writeUInt32LE(data.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...images.map((i) => i.data)])
}

/**
 * An .ico entry's DIB from `rgba` (size × size pixels, RGBA, top row first): a 32-bit
 * BITMAPINFOHEADER bitmap, bottom row first in BGRA, with an empty AND mask (the alpha is used).
 */
export function dib(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // the colour bitmap and the mask
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = ((size - 1 - y) * size + x) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
    }
  }
  const mask = Buffer.alloc(size * Math.ceil(size / 32) * 4)
  header.writeUInt32LE(pixels.length + mask.length, 20)
  return Buffer.concat([header, pixels, mask])
}
