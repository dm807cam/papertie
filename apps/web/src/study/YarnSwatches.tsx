import { PALETTE_TOKENS, type PaletteEntry, type PaletteToken } from '@papertie/core'
import { useMemo } from 'react'
import type { Point } from '../canvas/types'
import { flattenBezier, restSagPoint, segmentBezier } from '../canvas/yarnGeometry'
import { CorkPanel, type PinMark, type StrandMark, studyNote } from './CorkPanel'

const W = 960
const H = 440
const LEFT_X = 168
const RIGHT_X = 900
const TOP_Y = 34
const PITCH = 30

const NOTES = [
  studyNote(800, { x: 330, y: 22, w: 190, h: 316, paper: 'cream', text: 'cream paper' }),
  studyNote(801, { x: 548, y: 22, w: 190, h: 316, paper: 'ink', text: 'ink paper' }),
]

const ENDS = PALETTE_TOKENS.map((_, i) => TOP_Y + i * PITCH).map((y): [Point, Point] => [
  { x: LEFT_X, y },
  { x: RIGHT_X, y },
])
const PINS: PinMark[] = ENDS.flatMap(([a, b]) => [
  { p: a, kind: 'edge' as const },
  { p: b, kind: 'edge' as const },
])
const CURVES = ENDS.map(([a, b]) => flattenBezier(segmentBezier(a, b, restSagPoint(a, b)), 0.25))

/** Eight dyes at rest sag over cork between edge pins, each crossing a cream and an ink note. */
export function YarnSwatches({ palette }: { palette: Record<PaletteToken, PaletteEntry> }) {
  const strands = useMemo<StrandMark[]>(
    () => PALETTE_TOKENS.map((t, i) => ({ points: CURVES[i] ?? [], color: palette[t].yarn })),
    [palette],
  )
  return (
    <CorkPanel
      width={W}
      height={H}
      notes={NOTES}
      pins={PINS}
      strands={strands}
      testId="yarn-swatches"
      canvasTestId="yarn-canvas"
    >
      {PALETTE_TOKENS.map((t, i) => (
        <span
          key={t}
          className="yarn-tag yarn-tag--swatch"
          style={{ right: W - LEFT_X + 14, top: TOP_Y + i * PITCH }}
        >
          {palette[t].yarnName}
        </span>
      ))}
    </CorkPanel>
  )
}
