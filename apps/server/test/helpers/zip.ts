import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  data: Buffer
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/**
 * The entries of a zip, in central-directory order, read through its central directory (sizes
 * there are exact even when the local headers defer them to data descriptors). Stored and deflated
 * entries only; no zip64, which nothing under test is large enough to need.
 */
export function readZip(zip: Buffer): ZipEntry[] {
  let eocd = -1
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('no end of central directory')
  const count = zip.readUInt16LE(eocd + 10)
  let at = zip.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== CENTRAL) throw new Error('bad central directory record')
    const method = zip.readUInt16LE(at + 10)
    const compressed = zip.readUInt32LE(at + 20)
    const nameLen = zip.readUInt16LE(at + 28)
    const extraLen = zip.readUInt16LE(at + 30)
    const commentLen = zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    if (zip.readUInt32LE(local) !== LOCAL) throw new Error('bad local header')
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + compressed)
    if (method !== 0 && method !== 8) throw new Error(`unsupported method ${method}`)
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) })
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

export interface RawZipEntry {
  /** Written byte for byte (any name at all: `../x`, `/abs`, a duplicate). */
  name: string
  data: Buffer
  /** `deflate` (the default) or `store`. */
  method?: 'deflate' | 'store'
  /** Unix mode in the high half of the external attributes (`0o120777` is a symlink). */
  mode?: number
  /** The uncompressed size the headers claim, when it should not be the real one. */
  claimedSize?: number
}

/**
 * A zip of exactly `entries`, in order, built by hand so a test can write what no zip library
 * would: traversal names, absolute names, duplicates, symlinks, lying sizes. No zip64.
 */
export function writeZip(entries: RawZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const method = e.method === 'store' ? 0 : 8
    const body = method === 8 ? deflateRawSync(e.data) : e.data
    const crc = crc32(e.data)
    const size = e.claimedSize ?? e.data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // names are UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL, 0)
    central.writeUInt16LE(0x0314, 4) // made by Unix
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(dir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, eocd])
}
