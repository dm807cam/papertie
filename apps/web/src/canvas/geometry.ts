import type { Note } from '@papertie/core'
import { notePinOffsetX } from '../lib/seed'
import type { Point, Rect } from './types'

/** World-pixel pin metrics; `offsetMax` bounds the seeded x-offset. */
export const PIN = { insetY: 14, offsetMax: 12, headRadius: 5.5 } as const

/** Notes this narrow or narrower render as tags hanging from a brass hook. */
export const TAG_MAX_W = 120

/** Whether a note renders as a tag. */
export function isTag(note: Pick<Note, 'w'>): boolean {
  return note.w <= TAG_MAX_W
}

/** A note's pin x-offset from its top centre: seeded, or 0 for a tag's hook. */
export function pinOffsetX(note: Pick<Note, 'id' | 'w'>): number {
  return isTag(note) ? 0 : notePinOffsetX(note.id)
}

/** World position of a note's pin. Notes rotate about the pin, so rotation and height are ignored. */
export function pinPosition(note: Pick<Note, 'id' | 'x' | 'y' | 'w'>): Point {
  return { x: note.x + note.w / 2 + pinOffsetX(note), y: note.y + PIN.insetY }
}

/** World rect of a note, using the larger of its stored and measured height. */
export function noteBounds(note: Pick<Note, 'x' | 'y' | 'w' | 'h'>, measuredH?: number): Rect {
  const measured = measuredH !== undefined && Number.isFinite(measuredH) ? measuredH : 0
  return { x: note.x, y: note.y, w: note.w, h: Math.max(note.h, measured) }
}
