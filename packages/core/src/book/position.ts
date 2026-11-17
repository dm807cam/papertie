/**
 * Position keys: where a block sits in its book, and a book on the shelf. A key is a base-62
 * fraction (`0-9A-Za-z`, digits in code-unit order) without a trailing `0`, so keys compare as
 * plain strings (code units, the same on every platform) and any two keys have keys between them.
 */
import { LIMITS } from '../limits'

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = 62
const TOP = BASE - 1

/** A valid key: base-62 digits, at least one, the last not `0`. */
export const POS_PATTERN = /^[0-9A-Za-z]*[1-9A-Za-z]$/

const digit = (c: string | undefined): number => (c === undefined ? 0 : DIGITS.indexOf(c))

function checked(key: string | null, name: string): void {
  if (key !== null && !POS_PATTERN.test(key)) {
    throw new RangeError(`position: ${name} ${JSON.stringify(key)} is not a position key`)
  }
}

/** `s` without its trailing zeros. */
function trimmed(s: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === '0') end--
  return s.slice(0, end)
}

/** The two digits of `n` (0 ≤ n < 62²). */
const two = (n: number): string => (DIGITS[Math.floor(n / BASE)] as string) + DIGITS[n % BASE]

/**
 * A key after `a`. Past the leading `z`s, the next two digits count up by one: 3,782 keys a
 * length (one character more per 62 appends at the very most), so a book typed paragraph after
 * paragraph never runs its keys long.
 */
function after(a: string): string {
  let k = 0
  while (a[k] === 'z') k++
  const n = digit(a[k]) * BASE + digit(a[k + 1])
  return trimmed(a.slice(0, k) + two(n + 1))
}

/** A key before `b`: the mirror of {@link after}, counting down past the leading `0`s. */
function before(b: string): string {
  let k = 0
  while (b[k] === '0') k++
  // `b[k]` is not `0` (a key ends in another digit), so n ≥ 62 and n − 1 is not zero.
  const n = digit(b[k]) * BASE + digit(b[k + 1])
  return trimmed(b.slice(0, k) + two(n - 1))
}

/** The shortest-ish key strictly between `a` and `b` (a < b, both trimmed; `a` may be ''). */
function midpoint(a: string, b: string): string {
  let n = 0
  while ((a[n] ?? '0') === b[n]) n++
  if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  const da = digit(a[0])
  const db = digit(b[0])
  if (db - da > 1) return DIGITS[Math.floor((da + db) / 2)] as string
  // Adjacent first digits: `b`'s first alone is between when `b` goes on past it.
  if (b.length > 1) return b[0] as string
  // Otherwise `a`'s first digit, then a key above the rest of `a`.
  return (DIGITS[da] as string) + midpointToTop(a.slice(1))
}

/** A key strictly between `a` (may be '') and 1. */
function midpointToTop(a: string): string {
  const da = digit(a[0])
  if (da < TOP) return DIGITS[Math.floor((da + BASE) / 2)] as string
  return (DIGITS[TOP] as string) + midpointToTop(a.slice(1))
}

/**
 * A key strictly between `a` and `b`; `null` is the open end (before every key, after every key).
 * Appending (`b` null) and prepending (`a` null) step rather than halve, so a run of them grows
 * the key by one character per 3,782 at most; between two keys it halves the gap, so a run of
 * inserts at one place grows it about a character per 6 (re-space with {@link posKeysBetween}).
 * The key is not cut to `maxPosLength`: the caller checks it. Throws `RangeError` for a bound
 * that is not a key, or `a` ≥ `b`.
 */
export function posBetween(a: string | null, b: string | null): string {
  checked(a, 'lower bound')
  checked(b, 'upper bound')
  if (a !== null && b !== null && !(a < b)) {
    throw new RangeError(`position: ${JSON.stringify(a)} is not before ${JSON.stringify(b)}`)
  }
  if (a === null && b === null) return 'V'
  if (b === null) return after(a as string)
  if (a === null) return before(b)
  return midpoint(a, b)
}

const BIG_BASE = BigInt(BASE)

/** `key` as an integer at `length` digits (`length` ≥ its length). */
function toInt(key: string, length: number): bigint {
  let v = 0n
  for (let i = 0; i < length; i++) v = v * BIG_BASE + BigInt(digit(key[i]))
  return v
}

/** `v` (< 62^length) as `length` digits, trailing zeros trimmed. */
function fromInt(v: bigint, length: number): string {
  const out: string[] = new Array(length)
  let rest = v
  for (let i = length - 1; i >= 0; i--) {
    out[i] = DIGITS[Number(rest % BIG_BASE)] as string
    rest /= BIG_BASE
  }
  return trimmed(out.join(''))
}

/**
 * `n` strictly increasing keys between `a` and `b` (`null`: the open end), spread evenly over the
 * gap at the fewest digits that give them room, never a run of bisections: re-spacing a book's
 * keys, or placing a chapter's blocks where it moves. Throws `RangeError` when a bound is not a
 * key, `a` ≥ `b`, `n` is negative, or the keys would need more than `maxPosLength` digits.
 */
export function posKeysBetween(a: string | null, b: string | null, n: number): string[] {
  checked(a, 'lower bound')
  checked(b, 'upper bound')
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`position: bad count ${n}`)
  if (a !== null && b !== null && !(a < b)) {
    throw new RangeError(`position: ${JSON.stringify(a)} is not before ${JSON.stringify(b)}`)
  }
  if (n === 0) return []
  const need = BigInt(n) + 1n
  for (let length = Math.max(a?.length ?? 0, b?.length ?? 0, 1); ; length++) {
    if (length > LIMITS.maxPosLength) {
      throw new RangeError(`position: no room for ${n} keys within ${LIMITS.maxPosLength} digits`)
    }
    const lo = a === null ? 0n : toInt(a, length)
    const hi = b === null ? BIG_BASE ** BigInt(length) : toInt(b, length)
    const gap = hi - lo
    if (gap < need) continue
    const out: string[] = new Array(n)
    for (let i = 1; i <= n; i++) out[i - 1] = fromInt(lo + (gap * BigInt(i)) / need, length)
    return out
  }
}
