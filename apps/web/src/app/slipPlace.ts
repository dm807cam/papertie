import { type RefObject, useLayoutEffect } from 'react'

/** A pane's span across the window, px. */
export interface Span {
  left: number
  width: number
}

/** Which pane of the split view the user works in. */
export type Pane = 'board' | 'book'

/**
 * Where a slip that lies over every screen stands: centred on the pane the
 * user works in while the book is beside the board (`book` is its pane, `board` the board's), so it
 * never straddles the seam; centred on the window otherwise. Its width is that pane's or the
 * window's, which the slip's own `min()` keeps it within.
 */
export function slipSpan(o: {
  window: number
  board: Span | null
  book: Span | null
  working: Pane
}): { centre: number; width: number } {
  const on = o.board !== null && o.book !== null ? o[o.working] : null
  if (on === null || !(on.width > 0)) return { centre: o.window / 2, width: o.window }
  return { centre: on.left + on.width / 2, width: on.width }
}

/** The pane a press or a focus at `target` is in; `null` for the UI layer over both (the sidebar). */
export function paneOf(target: EventTarget | null): Pane | null {
  if (!(target instanceof Element)) return null
  if (target.closest('.book-pane')) return 'book'
  if (target.closest('.viewport > .ui, .sync-updated')) return null
  return target.closest('.board-split') ? 'board' : null
}

const spanOf = (el: Element | null): Span | null => {
  if (el === null) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, width: r.width }
}

/**
 * Keeps `slip` (while `shown`) on the pane the user works in: `--slip-x` and `--slip-w` set on it
 * through the CSSOM (the CSP allows no inline style attribute), from the last press or focus in a
 * pane, and again when a pane is resized. Listens only while the slip is up: nothing on the board's
 * hot paths.
 */
export function useSlipOnPane(
  slip: RefObject<HTMLElement | null>,
  shown: boolean,
  /** The pane the slip keeps to, wherever the user works. */
  only?: Pane,
): void {
  useLayoutEffect(() => {
    if (!shown) return
    let working: Pane = only ?? paneOf(document.activeElement) ?? 'board'
    const place = () => {
      const el = slip.current
      if (el === null) return
      const split = document.querySelector('.board-split[data-layout="split"]')
      const book = split?.querySelector(':scope > .book-pane') ?? null
      const board = split?.querySelector(':scope > .viewport') ?? null
      const { centre, width } = slipSpan({
        window: window.innerWidth,
        board: spanOf(board),
        book: spanOf(book),
        working,
      })
      el.style.setProperty('--slip-x', `${centre}px`)
      el.style.setProperty('--slip-w', `${width}px`)
    }
    const into = (e: Event) => {
      const p = only ?? paneOf(e.target)
      if (p === null || p === working) return
      working = p
      place()
    }
    place()
    const resized = new ResizeObserver(place)
    const watch = () => {
      resized.disconnect()
      for (const el of document.querySelectorAll('.board-split, .board-split > .book-pane'))
        resized.observe(el)
    }
    watch()
    // The book opening or closing beside the board changes the panes.
    const layout = new MutationObserver(() => {
      watch()
      place()
    })
    const stage = document.querySelector('.board-split')
    if (stage) layout.observe(stage, { attributes: true, attributeFilter: ['data-layout'] })
    document.addEventListener('pointerdown', into, true)
    document.addEventListener('focusin', into, true)
    window.addEventListener('resize', place)
    return () => {
      resized.disconnect()
      layout.disconnect()
      document.removeEventListener('pointerdown', into, true)
      document.removeEventListener('focusin', into, true)
      window.removeEventListener('resize', place)
    }
  }, [slip, shown, only])
}
