import { CorkPanel, type PinMark, studyNote } from './CorkPanel'

const W = 960
const H = 220
const ZOOMS = [0.5, 1, 2] as const

const SHEETS = [studyNote(850, { x: 504, y: 28, w: 420, h: 164, text: '' })]

const CORK_XS = [96, 228, 360]
const PAPER_XS = [600, 714, 828]
const PIN_Y = 98

/** Edge pins sit below the hanging pins on the same sheet. */
const EDGE_Y = 150

/** Pin centres in CSS px; the e2e samples them for brass. */
export const PIN_SPECIMENS: ReadonlyArray<
  PinMark & { zoom: number; on: 'cork' | 'paper' | 'edge' }
> = [
  ...ZOOMS.map((zoom, i) => ({ p: { x: CORK_XS[i] ?? 0, y: PIN_Y }, zoom, on: 'cork' as const })),
  ...ZOOMS.map((zoom, i) => ({ p: { x: PAPER_XS[i] ?? 0, y: PIN_Y }, zoom, on: 'paper' as const })),
  ...ZOOMS.map((zoom, i) => ({
    p: { x: (PAPER_XS[i] ?? 0) + 50, y: EDGE_Y },
    zoom,
    kind: 'edge' as const,
    on: 'edge' as const,
  })),
]

/**
 * Glossy brass dome pins at zoom 0.5, 1 and 2: hanging pins on bare cork and on cream fibre paper,
 * and the smaller edge pins that hold yarn ends.
 */
export function PinSpecimen() {
  return (
    <CorkPanel
      width={W}
      height={H}
      notes={SHEETS}
      notePins={false}
      pins={PIN_SPECIMENS}
      testId="pin-specimen"
      canvasTestId="pin-canvas"
    >
      {PIN_SPECIMENS.map(({ p, zoom, on }) => (
        <span
          key={`${on}-${zoom}`}
          className={`pin-label pin-label--${on}`}
          style={{ left: p.x, top: p.y + (on === 'edge' ? 24 : 34) }}
        >
          ×{zoom}
        </span>
      ))}
    </CorkPanel>
  )
}
