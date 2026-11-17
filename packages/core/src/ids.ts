export type IdPrefix = 'board' | 'note' | 'yarn' | 'asset' | 'tab' | 'book' | 'block'

/** Crockford base32 (no I, L, O, U). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MAX_TIME = 2 ** 48 - 1

export const ID_PATTERN = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/

const PREFIXES: ReadonlySet<string> = new Set([
  'board',
  'note',
  'yarn',
  'asset',
  'tab',
  'book',
  'block',
])

/** 48-bit big-endian timestamp as 10 base32 chars. */
function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError(`newId: timestamp out of range: ${ms}`)
  }
  let out = ''
  let rest = ms
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[rest % 32] + out
    rest = Math.floor(rest / 32)
  }
  return out
}

/** Where ids' random bits come from: crypto, unless a test replays a run ({@link setIdRandomness}). */
let fillRandom: ((bytes: Uint8Array) => void) | null = null

/**
 * For a test that must replay exactly: each new id's 80 random bits are `fill`'s from
 * now on, ten bytes an id; `null` gives them back to crypto. The app never calls it.
 */
export function setIdRandomness(fill: ((bytes: Uint8Array) => void) | null): void {
  fillRandom = fill
}

/** 80 random bits as 16 base32 chars. */
function encodeRandom(): string {
  const bytes = new Uint8Array(10)
  if (fillRandom === null) globalThis.crypto.getRandomValues(bytes)
  else fillRandom(bytes)
  let out = ''
  let acc = 0
  let bits = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(acc >> bits) & 31]
    }
    acc &= (1 << bits) - 1
  }
  return out
}

export function newId(prefix: IdPrefix, nowMs: number = Date.now()): string {
  return `${prefix}_${encodeTime(nowMs)}${encodeRandom()}`
}

export function isId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) return false
  const p = value.slice(0, value.indexOf('_'))
  return prefix === undefined ? PREFIXES.has(p) : p === prefix
}
