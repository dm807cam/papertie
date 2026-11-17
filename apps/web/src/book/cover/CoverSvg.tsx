import { memo } from 'react'
import {
  type Cover,
  type CoverLayout,
  type CoverShape,
  type CoverSize,
  coverLayout,
  coverRoom,
  coverShapes,
} from './cover'
import './cover.css'

/** The width the drawing is made at, in its own units (the shelf's cover, in px). */
const UNIT_W = 104

/** Opacity to two places, as short as SVG allows. */
const op = (v: number | undefined) =>
  v === undefined ? undefined : String(Math.round(v * 100) / 100).replace(/^0\./, '.')

/** The title's measure in each layout, in `cqw` (cover.css's margins). */
const MEASURE: Record<CoverLayout, number> = { head: 77, foot: 77, aside: 71.5 }
/** The steps' sizes in `cqw` (cover.css). */
const STEPS = [
  ['l', 11.6],
  ['m', 10.2],
  ['s', 8.8],
] as const

/**
 * A title's size step: the largest whose lines it fits in three of (four at the smallest), and
 * whose longest word fits a line, so a word is hyphenated only when it cannot fit at all. The
 * display serif runs just under half an em a character, tracking and a ragged edge included.
 */
function titleStep(title: string, layout: CoverLayout): 'l' | 'm' | 's' {
  const measure = MEASURE[layout]
  const word = title.split(/\s+/).reduce((n, w) => Math.max(n, w.length), 0)
  for (const [step, size] of STEPS) {
    const perLine = measure / (size * 0.54)
    if (word <= perLine && title.length <= perLine * (step === 's' ? 3.4 : 2.4)) return step
  }
  return 's'
}

function shape(s: CoverShape, key: number) {
  switch (s.kind) {
    case 'rect':
      return (
        <rect
          key={key}
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          fill={s.fill}
          opacity={op(s.opacity)}
        />
      )
    case 'disc':
      return <circle key={key} cx={s.cx} cy={s.cy} r={s.r} fill={s.fill} opacity={op(s.opacity)} />
    case 'ring':
      return (
        <circle
          key={key}
          cx={s.cx}
          cy={s.cy}
          r={s.r}
          fill="none"
          stroke={s.stroke}
          strokeWidth={s.width}
          opacity={op(s.opacity)}
        />
      )
    case 'area':
      return (
        <path
          key={key}
          d={s.d}
          fill={s.fill}
          fillRule={s.evenodd ? 'evenodd' : undefined}
          opacity={op(s.opacity)}
        />
      )
    default:
      return <path key={key} d={s.d} fill="none" stroke={s.stroke} strokeWidth={s.width} />
  }
}

interface Props {
  cover: Cover
  title: string
  size: CoverSize
  /** The book's id plus a use suffix (`b_x-shelf`): every id inside starts with it. */
  idBase: string
}

/**
 * A book's cover: cream fibre paper (the wrapper's ground, cover.css), the seeded drawing as
 * inline SVG with presentation attributes only, kept to its room by a clip, and the title as HTML
 * over the paper the drawing leaves bare.
 */
/** Equal by value: a shelf passes a fresh `size` (and, after a sync, a fresh `cover`) each render. */
function sameCover(a: Props, b: Props): boolean {
  return (
    a.title === b.title &&
    a.idBase === b.idBase &&
    a.size.w === b.size.w &&
    a.size.h === b.size.h &&
    a.cover.seed === b.cover.seed &&
    a.cover.ink === b.cover.ink &&
    a.cover.motif === b.cover.motif
  )
}

export const CoverSvg = memo(function CoverSvg({ cover, title, size, idBase }: Props) {
  const layout = coverLayout(cover)
  // Drawn in the shelf's units (104 across) and scaled by the viewBox: the same drawing at every
  // size, and its numbers as short at twice the size as at once.
  const unit = { w: UNIT_W, h: Math.round((UNIT_W * size.h * 10) / size.w) / 10 }
  const shapes = coverShapes(cover, unit)
  const room = coverRoom(cover, unit)
  // A fields cover fills its whole box; the others are held off the title's paper.
  const clip = room.h < unit.h ? `${idBase}-room` : undefined
  const name = title.trim()
  return (
    <div
      className={`cover cover--${layout} cover--${cover.motif} cover--g${(cover.seed >>> 8) % 4}`}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        className="cover-art"
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${unit.w} ${unit.h}`}
      >
        {clip && (
          <clipPath id={clip}>
            <rect x={room.x} y={room.y} width={room.w} height={room.h} />
          </clipPath>
        )}
        <g
          className="cover-ink"
          clipPath={clip && `url(#${clip})`}
          strokeLinecap={cover.motif === 'contour' ? 'round' : undefined}
          strokeLinejoin={cover.motif === 'contour' ? 'round' : undefined}
        >
          {shapes.map(shape)}
        </g>
      </svg>
      <div className="cover-face">
        <span
          className={`cover-title cover-title--${titleStep(name, layout)}${name ? '' : ' cover-title--untitled'}`}
        >
          {name || 'Untitled'}
        </span>
      </div>
    </div>
  )
}, sameCover)
