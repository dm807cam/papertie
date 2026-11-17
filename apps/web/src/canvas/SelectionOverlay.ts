import type { Note } from '@papertie/core'
import type { ResizeHandle } from '../interactions/drag'
import { noteRotationDeg } from '../lib/seed'
import { type Camera, ORIGIN, screenMapper } from './Camera'
import { PIN, pinOffsetX } from './geometry'
import type { Point, Rect } from './types'

const HANDLES: readonly ResizeHandle[] = ['nw', 'ne', 'sw', 'se', 'e', 's']

/** The armed marquee's corner cue, CSS px square. */
const ARMED_CORNER_PX = 14

/** Where the selection frame sits, in viewport CSS px, rotated with the note about its pin. */
export interface OverlayFrame {
  noteId: string
  x: number
  y: number
  w: number
  h: number
  deg: number
  originX: number
  originY: number
}

/**
 * The frame for note `n` (already with any overrides applied) at camera `c`. It uses the same
 * anchored, device-snapped mapping as the world layer and the pins, so it sits exactly on the
 * paper.
 */
export function overlayFrame(
  n: Note,
  measuredH: number | undefined,
  c: Camera,
  dpr: number,
  rotation: boolean,
  anchor: Point = ORIGIN,
): OverlayFrame {
  const tl = screenMapper(c, dpr, anchor)({ x: n.x, y: n.y })
  const h = Math.max(n.h, measuredH !== undefined && Number.isFinite(measuredH) ? measuredH : 0)
  return {
    noteId: n.id,
    x: tl.x,
    y: tl.y,
    w: n.w * c.zoom,
    h: h * c.zoom,
    deg: rotation ? noteRotationDeg(n) : 0,
    originX: (n.w / 2 + pinOffsetX(n)) * c.zoom,
    originY: PIN.insetY * c.zoom,
  }
}

/**
 * Imperative DOM handles inside `.overlay`: a frame for the one selected note, with corner and
 * right/bottom edge handles (`data-handle`), and the marquee's rubber band. The runtime positions
 * them every frame; writes are skipped when nothing moved. Several selected notes get no frame
 * here (that would grow with the selection): the pin layer frames the culled ones.
 */
export class SelectionOverlay {
  readonly el: HTMLDivElement
  /** The rubber band of a marquee drag, in viewport CSS px. */
  readonly band: HTMLDivElement
  private last = ''
  private lastBand = ''

  constructor(parent: HTMLElement) {
    const doc = parent.ownerDocument
    this.el = doc.createElement('div')
    this.el.className = 'selection'
    this.el.hidden = true
    for (const h of HANDLES) {
      const handle = doc.createElement('div')
      handle.className = 'selection-handle'
      handle.dataset.handle = h
      this.el.append(handle)
    }
    parent.append(this.el)
    this.band = doc.createElement('div')
    this.band.className = 'marquee'
    this.band.hidden = true
    parent.append(this.band)
  }

  /** Show the marquee's rubber band over a viewport rect, or hide it for null. */
  setBand(r: Rect | null): void {
    const key = r === null ? '' : `${r.x} ${r.y} ${r.w} ${r.h}`
    if (key === this.lastBand) return
    this.lastBand = key
    delete this.band.dataset.armed
    if (r === null) {
      this.band.hidden = true
      return
    }
    const s = this.band.style
    this.band.hidden = false
    s.width = `${r.w}px`
    s.height = `${r.h}px`
    s.transform = `translate(${r.x}px, ${r.y}px)`
  }

  /**
   * The cue of a marquee armed by a long press: the band's corner at viewport point `at`, from
   * which the drag will draw it. Null takes the cue away (never a band being drawn).
   */
  armBand(at: Point | null): void {
    if (at === null) {
      if (this.band.dataset.armed !== undefined) this.setBand(null)
      return
    }
    this.lastBand = 'armed'
    const s = this.band.style
    this.band.hidden = false
    this.band.dataset.armed = ''
    s.width = `${ARMED_CORNER_PX}px`
    s.height = `${ARMED_CORNER_PX}px`
    s.transform = `translate(${at.x}px, ${at.y}px)`
  }

  /** Show the frame, or hide it for null. */
  update(f: OverlayFrame | null): void {
    const key =
      f === null ? '' : `${f.noteId} ${f.x} ${f.y} ${f.w} ${f.h} ${f.deg} ${f.originX} ${f.originY}`
    if (key === this.last) return
    this.last = key
    if (f === null) {
      this.el.hidden = true
      delete this.el.dataset.noteId
      return
    }
    const s = this.el.style
    this.el.hidden = false
    this.el.dataset.noteId = f.noteId
    s.width = `${f.w}px`
    s.height = `${f.h}px`
    s.transformOrigin = `${f.originX}px ${f.originY}px`
    s.transform = `translate(${f.x}px, ${f.y}px) rotate(${f.deg}deg)`
  }

  /**
   * Draw the frame in the focus ink: the selected note has the keyboard (it is being written on,
   * or focused from the keyboard). The frame is then its focus ring.
   */
  setFocus(on: boolean): void {
    if (on === (this.el.dataset.focus !== undefined)) return
    if (on) this.el.dataset.focus = ''
    else delete this.el.dataset.focus
  }

  dispose(): void {
    this.el.remove()
    this.band.remove()
  }
}
