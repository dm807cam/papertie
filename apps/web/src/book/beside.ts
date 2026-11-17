import type { Camera } from '../canvas/Camera'
import type { SeamDrop } from '../canvas/seamDrop'
import type { Point } from '../canvas/types'

/**
 * What the open book asks of the board's runtime beside it (`beside`'s): the seam's
 * drop target, and the board's side of a card made from the book and of a pin.
 * The board's own runtime has all of it; a test's stub may give only the drop target,
 * and the book then offers nothing that needs the rest.
 */
export interface BesideRuntime {
  setSeamDrop(t: SeamDrop | null): void
  /** The seam's drag: the board's canvases keep their size until the release (`null`). */
  holdSize?(reach: number | null): void
  els?: { root: HTMLElement }
  toViewport?(clientX: number, clientY: number): Point
  drawnCamera?(): Camera
  placeNear?(size: { w: number; h: number }): Point
  selectNote?(id: string | null): void
  focusNote?(noteId: string, zoom: number): boolean
}

/** The board's runtime with all a card made from the book needs. */
export type BoardBeside = Required<BesideRuntime>

/** Whether `rt` is the board's whole runtime (not a test's drop-target stub). */
export const wholeBoard = (rt: BesideRuntime | null | undefined): rt is BoardBeside =>
  rt != null &&
  rt.els !== undefined &&
  rt.toViewport !== undefined &&
  rt.drawnCamera !== undefined &&
  rt.placeNear !== undefined &&
  rt.selectNote !== undefined &&
  rt.focusNote !== undefined
