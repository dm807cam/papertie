import type { Ref } from 'react'

const n1 = (v: number) => String(Math.round(v * 10) / 10)

/** The two buttons of the tie, in the mark's 40-unit box. */
const BUTTONS = [
  [12.5, 13.5],
  [27.5, 24.5],
] as const

/**
 * The thread: a figure-eight wound round the two buttons (a lemniscate of half-width `a` along
 * the line through them), ending in a short loose tail.
 */
function thread(a: number, tail: number): string {
  const [[x1, y1], [x2, y2]] = BUTTONS
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  const th = Math.atan2(y2 - y1, x2 - x1)
  const co = Math.cos(th)
  const si = Math.sin(th)
  let d = ''
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * Math.PI * 2
    const k = 1 + Math.sin(t) ** 2
    const u = (a * Math.cos(t)) / k
    const v = (a * Math.sin(t) * Math.cos(t)) / k
    d += `${i ? 'L' : 'M'}${n1(cx + u * co - v * si)} ${n1(cy + u * si + v * co)}`
  }
  const q = [
    -si * tail * 0.5 + co * tail * 0.1,
    co * tail * 0.5 + si * tail * 0.1,
    -si * tail - co * tail * 0.35,
    co * tail - si * tail * 0.35,
  ]
  return `${d}M${n1(cx + a * co)} ${n1(cy + a * si)}q${q.map(n1).join(' ')}`
}

const disc = (x: number, y: number, r: number) =>
  `M${n1(x - r)} ${n1(y)}a${r} ${r} 0 1 0 ${n1(2 * r)} 0a${r} ${r} 0 1 0 ${n1(-2 * r)} 0Z`

const THREAD = thread(17.5, 7)
/** Small, the buttons are plain discs; large, each has its eyelet, cut through to the paper. */
const DISCS = { small: 4.6, large: 4.2, eyelet: 1.1 } as const
const SMALL = BUTTONS.map(([x, y]) => disc(x, y, DISCS.small)).join('')
const LARGE = BUTTONS.map(([x, y]) => disc(x, y, DISCS.large) + disc(x, y, DISCS.eyelet)).join('')

/** From this size up the mark is drawn with a finer thread and the buttons' eyelets. */
export const STAMP_DETAIL_FROM = 48

/**
 * The stamp: the closure of a string-tie envelope, two buttons and the thread wound between
 * them. One ink, the element's `color`; decorative, so hidden from assistive technology.
 */
export function StampMark({
  size,
  className,
  svgRef,
}: {
  /** Its drawn size in px (CSS may size it otherwise); it picks the level of detail. */
  size: number
  className?: string
  svgRef?: Ref<SVGSVGElement>
}) {
  const detail = size >= STAMP_DETAIL_FROM
  return (
    <svg
      ref={svgRef}
      className={className}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={THREAD}
        fill="none"
        stroke="currentColor"
        strokeWidth={detail ? 1.9 : 2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d={detail ? LARGE : SMALL} fill="currentColor" fillRule="evenodd" />
    </svg>
  )
}
