import { newId } from '@papertie/core'

/** Crockford base32 (no I, L, O, U), as in core's `newId`. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Milliseconds encoded in an id's ULID: the 10 base32 chars after `_`. NaN when malformed. */
export function ulidTimeMs(id: string): number {
  const at = id.indexOf('_')
  const time = at < 0 ? '' : id.slice(at + 1, at + 11)
  if (time.length !== 10) return Number.NaN
  let ms = 0
  for (const ch of time) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) return Number.NaN
    ms = ms * 32 + v
  }
  return ms
}

/** A fresh `<prefix>_<ULID>` id for prefixes core's `newId` does not know (e.g. `user`). */
export function serverId(prefix: string): string {
  if (!/^[a-z]+$/.test(prefix)) throw new Error('id prefix must be lowercase letters')
  return `${prefix}_${newId('tab').slice('tab_'.length)}`
}
