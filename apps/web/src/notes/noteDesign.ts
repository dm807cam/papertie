import { type ClientOp, MOTIFS, type Motif, type Note, type PaletteToken } from '@papertie/core'
import type { Point } from '../canvas/types'
import type { CommitOptions } from '../store/boardStore'
import { clampCoord, LABELS, noteIdAt, textKey } from './noteCommands'

/** The paper styles a new note can be made in; print is a photo's, made by the Photo tool. */
export const NOTE_STYLES = ['rustic', 'smooth'] as const
export type NoteStyle = (typeof NOTE_STYLES)[number]

/** One decoration per new note: none, a motif, the stamp or a layered backing sheet. */
export const NOTE_DECORATIONS = ['none', ...MOTIFS, 'stamp', 'layered'] as const
export type NoteDecoration = (typeof NOTE_DECORATIONS)[number]

/**
 * How a new note looks, chosen in the "+" picker and fixed once it is pinned: its paper colour
 * and style, its decoration, and the colour of the layered sheet (read only for `layered`).
 */
export interface NoteDesign {
  paper: PaletteToken
  style: NoteStyle
  decoration: NoteDecoration
  sheet: PaletteToken
}

/** The design of a note nobody has chosen one for: plain cream fibre paper. */
export const PLAIN_DESIGN: Readonly<NoteDesign> = {
  paper: 'cream',
  style: 'rustic',
  decoration: 'none',
  sheet: 'rose',
}

/**
 * The design last pinned (what the "+" picker opens on, and what a card made from
 * the book is), from its prefs (`prefsStore.getState()`; passed in, since the prefs read
 * this module's lists as they load).
 */
export function pinnedDesign(p: {
  noteColor: PaletteToken
  noteStyle: NoteStyle
  noteDecoration: NoteDecoration
  noteSheet: PaletteToken
}): NoteDesign {
  return {
    paper: p.noteColor,
    style: p.noteStyle,
    decoration: p.noteDecoration,
    sheet: p.noteSheet,
  }
}

/** The size of a freshly created note: blank, ready to be written on. */
export const NEW_NOTE = { w: 240, h: 160, text: '' } as const satisfies Partial<Note>

const isMotif = (d: NoteDecoration): d is Motif => (MOTIFS as readonly string[]).includes(d)

/**
 * The yarn whose dye rules a paper's margin: its own, but crimson on cream (whose yarn is undyed)
 * and ochre on ink (whose yarn is as dark as it is). note.css says the same as `--note-dye`.
 */
export const ruleDye = (paper: PaletteToken): PaletteToken =>
  paper === 'cream' ? 'apricot' : paper === 'ink' ? 'ochre' : paper

/** The note fields a design sets; a decoration of none sets none of `motif`, `stamp`, `layered`. */
export function designFields(
  d: NoteDesign,
): Pick<Note, 'paper' | 'style'> & Partial<Pick<Note, 'motif' | 'stamp' | 'layered'>> {
  const base = { paper: d.paper, style: d.style }
  if (isMotif(d.decoration)) return { ...base, motif: d.decoration }
  if (d.decoration === 'stamp') return { ...base, stamp: true }
  if (d.decoration === 'layered') return { ...base, layered: d.sheet }
  return base
}

const place = (v: number, size: number) =>
  clampCoord(Number.isFinite(v) ? Math.round(v - size / 2) : 0, size)

/**
 * How a new note's create is committed: under its typing's coalesce key, so the writing that
 * follows sends with it and undoes with it as one step (and an empty note leaving takes it back).
 */
export const createOptions = (noteId: string): CommitOptions => ({
  coalesceKey: textKey(noteId),
  label: LABELS.create,
})

/**
 * One `note.create` for a new note of `design` centred on world point `at`, on top of everything
 * (`topZ + 1`), stamped and its id minted at `now`.
 */
export function newNoteOp(
  at: Point,
  topZ: number,
  now: string,
  design: NoteDesign = PLAIN_DESIGN,
): Extract<ClientOp, { op: 'note.create' }> {
  return {
    op: 'note.create',
    note: {
      type: 'note',
      id: noteIdAt(now),
      x: place(at.x, NEW_NOTE.w),
      y: place(at.y, NEW_NOTE.h),
      w: NEW_NOTE.w,
      h: NEW_NOTE.h,
      z: Number.isInteger(topZ) ? topZ + 1 : 1,
      ...designFields(design),
      text: NEW_NOTE.text,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
  }
}
