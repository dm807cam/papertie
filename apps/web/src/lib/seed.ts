/**
 * FNV-1a over UTF-16 code units; returns an unsigned 32-bit integer. `then` is hashed on after `s`,
 * as `s + then` would be, without making that string (a board's notes each take their seeds as
 * they come: 100,000 of them).
 */
export function hash32(s: string, then = ''): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  for (let i = 0; i < then.length; i++) {
    h ^= then.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Uniform in [-1, 1) from a uint32. */
const signed = (h: number) => (h / 0x100000000) * 2 - 1

export interface NoteVisual {
  rotationDeg: number
  pinOffsetX: number
  maskIndex: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
}

/** Seeded look of a note: rotation in [-1, 1] deg, pin x-offset in [-12, 12] px, deckle mask 1-8. */
export function noteVisual(noteId: string): NoteVisual {
  return {
    rotationDeg: signed(hash32(noteId)),
    pinOffsetX: notePinOffsetX(noteId),
    maskIndex: ((hash32(noteId, ':mask') % 8) + 1) as NoteVisual['maskIndex'],
  }
}

/** `noteVisual(noteId).pinOffsetX`, alone. */
export function notePinOffsetX(noteId: string): number {
  return signed(hash32(noteId, ':pin')) * 12
}

/** Prints tilt further than paper: 2.5-5° either way. */
const PRINT_TILT = { min: 2.5, max: 5 } as const

/** The largest tilt any note is drawn at, degrees. */
export const MAX_TILT_DEG = PRINT_TILT.max

/**
 * A note's drawn tilt in degrees, the single source for the DOM, the selection frame, the
 * over-fix erase shapes and hit-testing: the seeded ±1° of `noteVisual`, or 2.5-5° (same sign)
 * for prints.
 */
export function noteRotationDeg(n: { id: string; style: string }): number {
  const base = signed(hash32(n.id)) // noteVisual's rotationDeg
  if (n.style !== 'print') return base
  const t = hash32(n.id, ':tilt') / 0x100000000
  return (base < 0 ? -1 : 1) * (PRINT_TILT.min + (PRINT_TILT.max - PRINT_TILT.min) * t)
}
