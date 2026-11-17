import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react'
import { createPortal } from 'react-dom'
import { handToBoard } from './handToBoard'
import './pickerSheet.css'

export const isComposing = (e: globalThis.KeyboardEvent) => e.isComposing || e.keyCode === 229

/** Room kept between the sheet and the view's edges. */
const EDGE = 12

/**
 * Place the sheet beside the panel, its top by the button that opened it (above the mini-bar,
 * from its left end), then keep it inside the view. Its height is capped in CSS, so it always
 * fits.
 */
function place(el: HTMLElement, anchor: HTMLElement): void {
  const dot = anchor.getBoundingClientRect()
  const panel = anchor.closest('.sidebar, .minibar')?.getBoundingClientRect() ?? dot
  const { innerWidth: vw, innerHeight: vh } = window
  const w = el.offsetWidth
  const h = el.offsetHeight
  const clamp = (v: number, size: number, room: number) =>
    Math.round(Math.max(EDGE, Math.min(v, room - size - EDGE)))
  el.style.left = `${clamp(anchor.closest('.minibar') ? panel.left : panel.right + EDGE, w, vw)}px`
  el.style.top = `${clamp(anchor.closest('.minibar') ? panel.top - EDGE - h : dot.top + dot.height / 2 - 28, h, vh)}px`
}

/**
 * One row of a picker: a quiet title and its choices, a radio group. With `cols` the choices
 * share the sheet's width in that many columns, so every row ends flush with the others.
 */
export function Row({
  title,
  cols,
  children,
}: {
  title: string
  cols?: number
  children: ReactNode
}) {
  const id = useId()
  return (
    <fieldset className="sheet-row" aria-labelledby={id}>
      <span className="sheet-title" id={id}>
        {title}
      </span>
      <span
        className="picker-choices"
        data-cols={cols}
        style={cols === undefined ? undefined : ({ '--cols': cols } as CSSProperties)}
      >
        {children}
      </span>
    </fieldset>
  )
}

/** A choice of a row: a real radio over the whole face of what it shows. */
export function Choice({
  className,
  name,
  label,
  title,
  checked,
  onPick,
  onPress,
  style,
  children,
}: {
  className: string
  name: string
  /** The accessible name, when the face holds no words. */
  label?: string
  title?: string
  checked: boolean
  onPick(): void
  /** A press on it (a click, Space, or an arrow arriving on it), chosen already or not. */
  onPress?(): void
  style?: CSSProperties
  children?: ReactNode
}) {
  return (
    <label className={`picker-choice ${className}`} title={title} style={style}>
      <input
        type="radio"
        className="picker-radio"
        name={name}
        aria-label={label}
        checked={checked}
        onChange={onPick}
        onClick={onPress}
      />
      {children}
    </label>
  )
}

/**
 * The sheet a sidebar picker opens in (the paper picker of "+", the colours of Yarn): a popover
 * beside the panel (above the mini-bar), in the panel's own material, kept inside the view (and
 * placed again as it resizes, or as `layout` changes its height). It lives in the UI layer, never
 * inside the panel, which clips as it folds. The focus goes in, to the choice now chosen, and back
 * to the board as it goes (to `anchor` on Esc). Enter anywhere in it calls `onEnter`. It closes on Esc wherever the focus is (`onClose(true)`: the
 * focus back on `anchor`), on a press outside it and when the focus leaves it for something else.
 * `anchor` is the button that opened it.
 */
export function PickerSheet({
  anchor,
  label,
  className,
  style,
  layout,
  focusIn = true,
  onEnter,
  onClose,
  children,
}: {
  anchor: HTMLElement | null
  label: string
  className: string
  style?: CSSProperties
  /** A value whose change moves the sheet's size: it is placed again. */
  layout?: unknown
  /**
   * Whether the focus goes in as it opens (the default). The writer's pickers, opened by a press,
   * leave it in the book's text, so the selection there stays (and a phone's keyboard up).
   */
  focusIn?: boolean
  onEnter(): void
  /** `refocus`: put the focus back on `anchor` (Esc). */
  onClose(refocus: boolean): void
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `focusIn` is read as it opens
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !anchor) return
    place(el, anchor)
    // The focus goes in, so Enter reaches it: to the first choice now chosen.
    if (focusIn) el.querySelector<HTMLElement>('input:checked')?.focus()
  }, [anchor])

  // Going with the focus in it (chosen, or put away by a key) hands the keys to the board, never
  // to <body>; Esc has put it back on `anchor` already.
  useLayoutEffect(() => {
    const el = box.current
    return () => {
      const active = document.activeElement
      if (el && active && el.contains(active)) handToBoard(el)
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `layout` changing is the cue
  useLayoutEffect(() => {
    if (box.current && anchor) place(box.current, anchor)
  }, [layout, anchor])

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && !box.current?.contains(t) && !anchor?.contains(t)) onClose(false)
    }
    const resized = () => {
      if (box.current && anchor) place(box.current, anchor)
    }
    // Esc closes it wherever the focus is; the board's own Esc (the selection) waits.
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || isComposing(e)) return
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc, true)
    window.addEventListener('resize', resized)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc, true)
      window.removeEventListener('resize', resized)
    }
  }, [anchor, onClose])

  return createPortal(
    <div
      ref={box}
      className={`picker-sheet ${className}`}
      // Opened from the mini-bar, its choices take a finger's 44 px.
      data-at={anchor?.closest('.minibar') ? 'minibar' : 'sidebar'}
      role="dialog"
      aria-label={label}
      style={style}
      onKeyDown={(e: KeyboardEvent) => {
        if (isComposing(e.nativeEvent)) return
        // The board's own Enter (writing on the selected note) is not for here.
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          e.stopPropagation()
          onEnter()
        }
      }}
      // Focusable itself: Safari focuses no radio or button on a click, but the nearest focusable
      // ancestor, which is then the sheet rather than the board around it.
      tabIndex={-1}
      onBlur={(e) => {
        // The focus going on to something else (Tab out, a click on another control) closes it;
        // to nothing (the window losing it), or to what holds the sheet (Safari's click on a
        // choice), does not.
        const to = e.relatedTarget
        const el = box.current
        if (to === null || !el || el.contains(to) || to.contains(el) || anchor?.contains(to)) return
        onClose(false)
      }}
    >
      {children}
    </div>,
    anchor?.closest('.ui') ?? document.body,
  )
}
