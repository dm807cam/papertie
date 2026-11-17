import { inflateRawSync } from 'node:zlib'

/** The entries of a zip by name, read through its central directory (stored or deflated). */
export function unzip(zip: Buffer): Map<string, Buffer> {
  let eocd = -1
  for (let i = zip.length - 22; i >= 0; i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new Error('no end of central directory')
  const out = new Map<string, Buffer>()
  let at = zip.readUInt32LE(eocd + 16)
  for (let n = zip.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = zip.readUInt16LE(at + 10)
    const size = zip.readUInt32LE(at + 20)
    const nameLen = zip.readUInt16LE(at + 28)
    const skip = nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + size)
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw))
    at += 46 + skip
  }
  return out
}
