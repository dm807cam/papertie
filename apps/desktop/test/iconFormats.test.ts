import { dib, icns, ico } from '../scripts/iconFormats.mjs'

/** A stand-in PNG: the signature, then a marker so each entry can be told apart. */
const png = (size: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`${size}`),
  ])

describe('the app icon files', () => {
  it('writes an .icns of PNG entries, each under its Apple type', () => {
    const pngs = new Map([16, 32, 64, 128, 256, 512, 1024].map((s) => [s, png(s)]))
    const out = icns(pngs)
    expect(out.subarray(0, 4).toString('latin1')).toBe('icns')
    expect(out.readUInt32BE(4)).toBe(out.length)

    const entries = new Map<string, Buffer>()
    for (let at = 8; at < out.length; ) {
      const type = out.subarray(at, at + 4).toString('latin1')
      const len = out.readUInt32BE(at + 4)
      entries.set(type, out.subarray(at + 8, at + len))
      at += len
    }
    // 1x and 2x of 16, 32, 128, 256 and 512 (iconutil's iconset).
    expect(new Map([...entries].map(([t, b]) => [t, b.toString('latin1').slice(8)]))).toEqual(
      new Map([
        ['ic11', '32'],
        ['ic12', '64'],
        ['ic07', '128'],
        ['ic13', '256'],
        ['ic08', '256'],
        ['ic14', '512'],
        ['ic09', '512'],
        ['ic10', '1024'],
      ]),
    )
  })

  it('writes an .ico: a directory of entries and their images, 256 as 0', () => {
    const images = [
      { size: 16, data: Buffer.alloc(40, 1) },
      { size: 256, data: png(256) },
    ]
    const out = ico(images)
    expect([out.readUInt16LE(0), out.readUInt16LE(2), out.readUInt16LE(4)]).toEqual([0, 1, 2])

    let offset = 6 + 16 * images.length
    images.forEach(({ size, data }, i) => {
      const e = 6 + 16 * i
      expect(out[e]).toBe(size === 256 ? 0 : size)
      expect(out[e + 1]).toBe(size === 256 ? 0 : size)
      expect(out.readUInt16LE(e + 4)).toBe(1)
      expect(out.readUInt16LE(e + 6)).toBe(32)
      expect(out.readUInt32LE(e + 8)).toBe(data.length)
      expect(out.readUInt32LE(e + 12)).toBe(offset)
      expect(out.subarray(offset, offset + data.length).equals(data)).toBe(true)
      offset += data.length
    })
    expect(out.length).toBe(offset)
  })
})

describe('an .ico entry as a DIB', () => {
  it('is a 32-bit bitmap of twice the height, bottom row first in BGRA, then the mask', () => {
    // 2 × 2: red, green on top; blue, half-clear white below.
    const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128])
    const out = dib(rgba, 2)
    expect([out.readUInt32LE(0), out.readInt32LE(4), out.readInt32LE(8)]).toEqual([40, 2, 4])
    expect(out.readUInt16LE(14)).toBe(32)
    // The bottom row (blue, white), then the top (red, green).
    expect([...out.subarray(40, 56)]).toEqual([
      255, 0, 0, 255, 255, 255, 255, 128, 0, 0, 255, 255, 0, 255, 0, 255,
    ])
    // The mask: 2 rows, each padded to 4 bytes.
    expect(out.length).toBe(40 + 16 + 8)
  })
})
