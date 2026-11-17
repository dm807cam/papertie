import type { Note } from '@papertie/core'
import { ORIGIN } from '../canvas/Camera'
import { isTag, PIN, pinOffsetX } from '../canvas/geometry'
import type { Point } from '../canvas/types'
import { hash32, noteRotationDeg, noteVisual } from '../lib/seed'

type BoxNote = Pick<Note, 'id' | 'x' | 'y' | 'w' | 'h' | 'style'>

/** The geometry styles of a note's `article` (and its paper's min height), as CSS strings. */
export interface NoteBoxStyle {
  width: string
  transform: string
  transformOrigin: string
  minHeight: string
}

/**
 * A note's box styles: placed at x, y relative to the world layer's `anchor` (the floating
 * origin) and rotated (when `rotation` is on) about its pin.
 */
export function noteStyle(n: BoxNote, rotation: boolean, anchor: Point = ORIGIN): NoteBoxStyle {
  const deg = rotation ? noteRotationDeg(n) : 0
  return {
    width: `${n.w}px`,
    transform: `translate(${n.x - anchor.x}px, ${n.y - anchor.y}px) rotate(${deg}deg)`,
    transformOrigin: `${n.w / 2 + pinOffsetX(n)}px ${PIN.insetY}px`,
    minHeight: `${n.h}px`,
  }
}

/**
 * The layered backing sheet, relative to its note: how far it shows past each edge and its tilt.
 */
export interface SheetStyle {
  /** CSS `inset` (negative: the sheet is larger than the note). */
  inset: string
  /** Rotation about the sheet's centre, on top of the note's own. */
  transform: string
  /** Its own deckle mask, never the note's. */
  maskIndex: number
}

const unit = (s: string) => hash32(s) / 0x100000000

/**
 * The backing sheet of a layered note: larger, showing most at the right and bottom, and turned
 * 0.6-1.3° against the note. It is a child of the note's `article`, so it moves,
 * rotates and resizes with the note on every path that writes `noteStyle`.
 */
export function sheetStyle(id: string): SheetStyle {
  // The torn edge bites up to 8 px, so the sheet reaches 4-7 px past that at the top and left
  // and 10-16 px past it at the right and bottom.
  const top = 12 + 3 * unit(`${id}:sheet:t`)
  const right = 18 + 6 * unit(`${id}:sheet:r`)
  const bottom = 18 + 6 * unit(`${id}:sheet:b`)
  const left = 12 + 4 * unit(`${id}:sheet:l`)
  const turn = 0.6 + 0.7 * unit(`${id}:sheet:deg`)
  const deg = noteVisual(id).rotationDeg < 0 ? turn : -turn
  const px = (v: number) => `${-Math.round(v * 10) / 10}px`
  return {
    inset: `${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`,
    transform: `rotate(${Math.round(deg * 100) / 100}deg)`,
    maskIndex: ((noteVisual(id).maskIndex + 2) % 8) + 1,
  }
}

/**
 * The z-index of a lifted note: far above every rank (`--stack`, the note's place in z order
 * among the mounted ones), plus its own rank, so lifted notes keep their order among themselves.
 */
export const LIFTED_Z_INDEX = 'calc(var(--stack, 0) + 1073741824)'

/**
 * Write `noteStyle` straight onto a mounted note, as React would, for gestures that move it
 * outside React. `lifted` raises it above the other notes. The tag class follows the live
 * width too, so a resize across `TAG_MAX_W` switches the tag look with the hook.
 */
export function writeNoteStyle(
  el: HTMLElement,
  n: BoxNote,
  rotation: boolean,
  lifted: boolean,
  anchor: Point = ORIGIN,
): void {
  const s = noteStyle(n, rotation, anchor)
  el.style.width = s.width
  el.style.transform = s.transform
  el.style.transformOrigin = s.transformOrigin
  el.style.zIndex = lifted ? LIFTED_Z_INDEX : ''
  el.classList.toggle('note--tag', isTag(n))
  const paper = el.querySelector<HTMLElement>('.note-paper')
  if (paper) paper.style.minHeight = s.minHeight
}
