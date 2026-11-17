import type { Note, PaletteToken, PaperStyle } from '@papertie/core'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPinSprites, drawStrand, type PinKind } from '../canvas/drawYarn'
import { isTag, pinPosition } from '../canvas/geometry'
import { mountCork } from '../canvas/mountCork'
import type { Point } from '../canvas/types'
import { noteVisual } from '../lib/seed'
import { NoteView } from '../notes/NoteView'

/** Notes switch to lite rendering below this zoom. */
export const LITE_ZOOM = 0.35

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const STAMP = '2026-10-27T00:00:00.000Z'

/** A valid, deterministic id for study fixtures. */
export function studyId(prefix: 'note' | 'asset', n: number): string {
  let tail = ''
  let rest = Math.floor(Math.abs(n))
  for (let i = 0; i < 20; i++) {
    tail = CROCKFORD[rest % 32] + tail
    rest = Math.floor(rest / 32)
  }
  return `${prefix}_01JBST${tail}`
}

/** A note record for the study page. */
export function studyNote(
  n: number,
  o: { x: number; y: number; w: number; h: number; paper?: PaletteToken; style?: PaperStyle } & {
    text?: string
    image?: Note['image']
  } & Pick<Note, 'motif' | 'stamp' | 'layered'>,
): Note {
  return {
    type: 'note',
    id: studyId('note', n),
    x: o.x,
    y: o.y,
    w: o.w,
    h: o.h,
    z: n,
    paper: o.paper ?? 'cream',
    style: o.style ?? 'rustic',
    text: o.text ?? '',
    image: o.image ?? null,
    // Only what is set: absent means none.
    ...(o.motif === undefined ? {} : { motif: o.motif }),
    ...(o.stamp === undefined ? {} : { stamp: o.stamp }),
    ...(o.layered === undefined ? {} : { layered: o.layered }),
    createdAt: STAMP,
    updatedAt: STAMP,
  }
}

/** The first study id from `from` whose seeded deckle mask is `mask`. */
export function studyIdForMask(mask: number, from: number): number {
  let n = from
  while (noteVisual(studyId('note', n)).maskIndex !== mask) n++
  return n
}

/** A bare pin in world space; `zoom` overrides the size the panel zoom would give it. */
export interface PinMark {
  p: Point
  zoom?: number
  /** Head size: a hanging pin (default) or an edge pin. */
  kind?: PinKind
}

/** A strand as a world-space polyline. */
export interface StrandMark {
  points: readonly Point[]
  color: string
}

export interface CorkPanelProps {
  width: number
  /** Fixed height; when omitted the panel grows to fit its notes plus `padBottom`. */
  height?: number
  zoom?: number
  /** World point at the panel's top-left. */
  camera?: Point
  notes?: readonly Note[]
  notePins?: boolean
  pins?: readonly PinMark[]
  strands?: readonly StrandMark[]
  padBottom?: number
  testId?: string
  canvasTestId?: string
  children?: ReactNode
}

const ORIGIN: Point = { x: 0, y: 0 }
const NONE: readonly never[] = []

/**
 * A window onto the board: cork (screen space), notes in a scaled world layer, then one
 * DPR-aware canvas with strands and pins on top. A study stand-in for the real canvas stack.
 */
export function CorkPanel({
  width,
  height,
  zoom = 1,
  camera = ORIGIN,
  notes = NONE,
  notePins = true,
  pins = NONE,
  strands = NONE,
  padBottom = 40,
  testId,
  canvasTestId,
  children,
}: CorkPanelProps) {
  const corkRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cork = useRef<ReturnType<typeof mountCork> | null>(null)
  const els = useRef(new Map<string, HTMLElement>())
  const [fitH, setFitH] = useState(0)
  const lite = zoom < LITE_ZOOM
  const h = height ?? fitH

  const toScreen = useCallback(
    (p: Point): Point => ({ x: (p.x - camera.x) * zoom, y: (p.y - camera.y) * zoom }),
    [camera.x, camera.y, zoom],
  )

  const measure = useCallback(() => {
    if (height !== undefined) return
    let bottom = 0
    for (const note of notes) {
      const el = els.current.get(note.id)
      const noteH = Math.max(note.h, el?.offsetHeight ?? 0)
      bottom = Math.max(bottom, (note.y - camera.y + noteH) * zoom)
    }
    setFitH(Math.ceil(bottom + padBottom))
  }, [height, notes, camera.y, zoom, padBottom])

  const observer = useMemo(
    () => (typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure())),
    [measure],
  )
  useEffect(() => {
    if (observer === null) return
    for (const el of els.current.values()) observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [observer, measure])

  const registerEl = useCallback(
    (id: string, el: HTMLElement | null) => {
      const prev = els.current.get(id)
      if (prev !== undefined) observer?.unobserve(prev)
      if (el === null) els.current.delete(id)
      else {
        els.current.set(id, el)
        observer?.observe(el)
      }
    },
    [observer],
  )

  useLayoutEffect(() => {
    const el = corkRef.current
    if (el === null) return
    cork.current = mountCork(el)
    return () => {
      cork.current?.dispose()
      cork.current = null
    }
  }, [])

  useLayoutEffect(() => {
    cork.current?.update(zoom, -camera.x * zoom, -camera.y * zoom, { width, height: h })
  }, [zoom, camera.x, camera.y, width, h])

  const sprites = useMemo(
    () => createPinSprites(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1),
    [],
  )

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || h <= 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, h)
    for (const s of strands) drawStrand(ctx, s.points.map(toScreen), { color: s.color, zoom, lite })
    const drawn: Array<Point & { hook?: true }> = []
    const pin = (p: Point, z: number, hook = false, kind?: PinKind) => {
      const sp = toScreen(p)
      sprites.draw(ctx, sp, z, { lite: z < LITE_ZOOM, hook, kind })
      const at = { x: Math.round(sp.x * 100) / 100, y: Math.round(sp.y * 100) / 100 }
      drawn.push(hook ? { ...at, hook } : at)
    }
    if (notePins) for (const note of notes) pin(pinPosition(note), zoom, isTag(note))
    for (const m of pins) pin(m.p, m.zoom ?? zoom, false, m.kind)
    canvas.dataset.pins = JSON.stringify(drawn)
  }, [width, h, zoom, lite, notes, notePins, pins, strands, toScreen, sprites])

  return (
    <div className="cork-panel" style={{ width, height: h }} data-testid={testId}>
      <div className="cork" ref={corkRef} />
      <div
        className="world"
        style={{
          transform: `translate(${-camera.x * zoom}px, ${-camera.y * zoom}px) scale(${zoom})`,
        }}
      >
        {notes.map((note) => (
          <NoteView
            key={note.id}
            note={note}
            lod={lite ? 'lite' : 'full'}
            rotation
            registerEl={registerEl}
          />
        ))}
      </div>
      <canvas
        ref={canvasRef}
        className="pin-layer"
        style={{ width, height: h }}
        data-testid={canvasTestId}
      />
      {children}
    </div>
  )
}

const CORK_NOTE = studyNote(1, {
  x: 0,
  y: 0,
  w: 200,
  h: 140,
  text: 'Tie ideas together.\nThought to thought, by thread.',
})
const CORK_PIN = pinPosition(CORK_NOTE)
const CORK_NOTES = [CORK_NOTE]
const PANEL = { width: 360, height: 240 } as const

/** Zoom, the world point centred in the panel, and what to look for there. */
const CORK_ZOOMS: ReadonlyArray<{ zoom: number; focus: Point; caption: string }> = [
  { zoom: 0.2, focus: { x: 100, y: 70 }, caption: 'Lite: paper colour, greeked lines, flat pin' },
  { zoom: 0.35, focus: { x: 100, y: 70 }, caption: 'Full detail returns at the LOD threshold' },
  { zoom: 1, focus: { x: 100, y: 70 }, caption: 'Actual size: 16 px text, 10 px yarn' },
  { zoom: 2, focus: { x: CORK_PIN.x, y: 52 }, caption: 'Rustic and the deckled edge' },
  { zoom: 4, focus: { x: CORK_PIN.x, y: 22 }, caption: 'Cork granules, brass head, paper tooth' },
]

/** One cream fibre note on cork at the five reference zooms. */
export function CorkSection() {
  return (
    <div className="cork-zooms">
      {CORK_ZOOMS.map(({ zoom, focus, caption }) => (
        <figure key={zoom} className="study-figure" data-zoom={zoom}>
          <CorkPanel
            width={PANEL.width}
            height={PANEL.height}
            zoom={zoom}
            camera={{
              x: focus.x - PANEL.width / 2 / zoom,
              y: focus.y - PANEL.height / 2 / zoom,
            }}
            notes={CORK_NOTES}
            testId={`cork-${zoom}`}
          />
          <figcaption>
            <span className="study-figure-num">×{zoom}</span>
            <span>{caption}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  )
}
