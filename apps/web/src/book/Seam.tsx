import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react'
import { announce } from '../app/liveRegion'
import { BOARD_MIN_PX, BOOK_MIN_PX, recallSplit, rememberSplit } from '../app/screenMemory'
import type { BesideRuntime } from './beside'

/** A keyboard step of the seam: 5% of the window. */
const STEP = 0.05

/** What the seam's move says: the book's share in whole percent. */
export const shareCopy = (share: number): string =>
  `Book takes ${Math.round(share * 100)}% of the window`

/**
 * The seam between the board and the book (the split view): a 12 px grip, a vertical
 * separator whose value is the book's share of the window. Dragged, it sets the pane's own flex
 * basis each frame (the split's `--book-share` at the release), clamped so the board keeps
 * `BOARD_MIN_PX` and the book `BOOK_MIN_PX`; the board's root shrinks and its runtime resizes through its own
 * `ResizeObserver`. While it is dragged the writer's sheet keeps the width it had (clipped at the
 * pane's edge) and takes the new one at release, so the page is measured again once, not every
 * frame; so does the board's runtime with its canvases (`holdSize`: clipped by its
 * root, grown once if the drag widens it past them, sized again at release). ←/→ move it 5%, Home/End to the book's least and most; each move is said and
 * kept by the app (`rememberSplit`), and so is a drag at its release.
 */
export function Seam({ board }: { board?: BesideRuntime | null }) {
  const grip = useRef<HTMLDivElement>(null)
  const [share, setShare] = useState(() => recallSplit().ratio)

  /** The split's wrapper and its box: the window's width the share is of. */
  const box = () => {
    const wrap = grip.current?.closest<HTMLElement>('.board-split') ?? null
    const r = wrap?.getBoundingClientRect()
    const width = r !== undefined && r.width > 0 ? r.width : window.innerWidth
    return { wrap, left: r?.left ?? 0, width }
  }
  const limits = (width: number) => ({
    lo: Math.min(1, BOOK_MIN_PX / width),
    hi: Math.max(0, 1 - BOARD_MIN_PX / width),
  })
  const clamp = (v: number, width: number) => {
    const { lo, hi } = limits(width)
    return Math.min(hi, Math.max(lo, v))
  }
  const show = (v: number) => box().wrap?.style.setProperty('--book-share', String(v))
  /**
   * A frame of the drag: the pane's own flex basis, not the wrapper's `--book-share`, which every
   * element of the board and the book inherits (a change of it restyled them all each frame: 6 ms
   * a frame in the final perf pass's trace). The share is the wrapper's again at the release.
   */
  const showDragged = (v: number) => {
    const p = pane()
    if (p) p.style.flexBasis = `${v * 100}%`
  }
  const keep = (v: number) => rememberSplit({ ratio: v, board: true })

  // The pointer's drag: a frame's move at most once, the sheet's width frozen meanwhile.
  const drag = useRef<{ id: number; x: number; raf: number; value: number } | null>(null)
  const runtime = useRef(board)
  runtime.current = board
  useEffect(
    () => () => {
      const d = drag.current
      if (d !== null && d.raf !== 0) cancelAnimationFrame(d.raf)
      if (d !== null) runtime.current?.holdSize?.(null)
    },
    [],
  )
  const pane = () => grip.current?.closest<HTMLElement>('.book-pane') ?? null

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    try {
      grip.current?.setPointerCapture?.(e.pointerId)
    } catch {
      // No such pointer (a synthetic press): the drag follows the grip's own events.
    }
    const p = pane()
    const sheet = p?.querySelector<HTMLElement>('.writer')
    const w = sheet?.getBoundingClientRect().width ?? 0
    if (p) {
      if (w > 0) p.style.setProperty('--sheet-frozen', `${Math.round(w)}px`)
      p.dataset.seam = 'drag'
    }
    // The widest the board can be while the book keeps its least.
    runtime.current?.holdSize?.(box().width - BOOK_MIN_PX)
    drag.current = { id: e.pointerId, x: e.clientX, raf: 0, value: share }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d === null) return
    d.x = e.clientX
    if (d.raf !== 0) return
    d.raf = requestAnimationFrame(() => {
      d.raf = 0
      const { left, width } = box()
      // The book is on the right: its share is what lies right of the pointer.
      d.value = clamp((left + width - d.x) / width, width)
      showDragged(d.value)
    })
  }
  const onPointerUp = () => {
    const d = drag.current
    if (d === null) return
    drag.current = null
    if (d.raf !== 0) {
      cancelAnimationFrame(d.raf)
      const { left, width } = box()
      d.value = clamp((left + width - d.x) / width, width)
    }
    show(d.value)
    const p = pane()
    if (p) {
      p.style.removeProperty('flex-basis')
      p.style.removeProperty('--sheet-frozen')
      delete p.dataset.seam
    }
    runtime.current?.holdSize?.(null)
    setShare(d.value)
    keep(d.value)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const { width } = box()
    const { lo, hi } = limits(width)
    const next =
      e.key === 'ArrowLeft'
        ? share + STEP
        : e.key === 'ArrowRight'
          ? share - STEP
          : e.key === 'Home'
            ? lo
            : e.key === 'End'
              ? hi
              : null
    if (next === null) return
    e.preventDefault()
    // A step lands on a whole percent (as it is said); the limits are exact.
    const v = clamp(e.key.startsWith('Arrow') ? Math.round(next * 100) / 100 : next, width)
    setShare(v)
    show(v)
    keep(v)
    announce(shareCopy(v))
  }

  const { lo, hi } = limits(window.innerWidth)
  return (
    // biome-ignore lint/a11y/useSemanticElements: a window splitter has no element of its own
    <div
      ref={grip}
      className="book-seam"
      role="separator"
      aria-orientation="vertical"
      aria-label="Book width"
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={Math.round(lo * 100)}
      aria-valuemax={Math.round(hi * 100)}
      aria-valuetext={shareCopy(share)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onKeyDown={onKeyDown}
    />
  )
}
