import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { usePrefs } from '../../app/prefs'
import { ActionButton } from '../../ui/buttons'
import { Choice, isComposing, PickerSheet, Row } from '../../ui/PickerSheet'
import {
  NO_SELECTION,
  type ToolsBar,
  useWriterTools,
  type WriterSelection,
  writerTools,
} from '../../ui/writerTools'
import type { EditorKind } from '../editor/BookEditor'
import type { BlockEngine } from '../editor/blockEngine'
import type { Pos } from '../editor/model'
import {
  BoldIcon,
  FootnoteIcon,
  ItalicIcon,
  KIND_ICON,
  ParagraphIcon,
  PinIcon,
} from './writingIcons'
import './writingTools.css'

/**
 * The writer's formatting, in the sidebar (and the mini-bar) where the selection popover was: Text
 * style (the caret's block's kind, and a picker of the six), Bold, Italic, Footnote and, where the
 * board takes a card, Pin to board (with ⌥ held, Move to board; on touch, a choice of both). Every
 * control is also an accelerator typed in the text (`# `, `## `, `> `, `- `, `*…*`, `**…**`, `^[`)
 * or a key (⌘B, ⌘I); "Paragraph" has none: it turns a block back. A press on a control never takes
 * the focus or the selection from the text (its default is prevented), and should the browser
 * have dropped the selection anyway, the last one the book had is put back before it acts. Tab
 * from selected text reaches the controls; Esc (or Shift+Tab from the first) goes back to the
 * text, the selection as it was. The code is the writer's chunk's: the sidebar shows what the
 * writer registers (`writerTools`).
 */

export const KINDS: ReadonlyArray<readonly [EditorKind, string]> = [
  ['p', 'Paragraph'],
  ['h1', 'Chapter'],
  ['h2', 'Section'],
  ['quote', 'Quote'],
  ['li', 'List'],
  ['prompt', 'Prompt'],
]

const apple = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

const same = (a: Pos, b: Pos) => a.blockId === b.blockId && a.offset === b.offset

const sameSel = (x: WriterSelection, y: WriterSelection) =>
  x.kind === y.kind && x.b === y.b && x.i === y.i && x.at === y.at && x.has === y.has

/** A press that leaves the text's focus and selection where they are. */
const hold = (e: SyntheticEvent) => e.preventDefault()

/** Tab from the text came here: Shift+Tab from the first control goes back to it. */
let fromText = false

/**
 * The book's selection, read for the tools (once per change: the caret's block's kind, or for
 * selected text `engine.active()`, the popover's own read; never a walk of the book). A selection
 * gone from the book while the focus went to nothing, or to the tools, was dropped by the browser
 * as a control was pressed: what it was is kept, to be put back.
 */
export function readSelection(): void {
  const { engine, sel, last } = writerTools.getState()
  if (engine === null) return
  const r = engine.range()
  if (r === null) {
    const at = document.activeElement
    if (at === null || at === document.body || at.closest('[data-writing], .picker-sheet')) return
    if (sel !== NO_SELECTION || last !== null)
      writerTools.setState({ sel: NO_SELECTION, last: null })
    return
  }
  const has = !same(r.a, r.b)
  const next: WriterSelection = has
    ? { ...engine.active(), at: true, has: true }
    : { kind: engine.block(r.a.blockId)?.kind ?? null, b: false, i: false, at: true, has: false }
  writerTools.setState(sameSel(sel, next) ? { last: r } : { sel: next, last: r })
}

/** The selection in the book again, if the browser dropped it: whether there is one to act on. */
function ensureRange(engine: BlockEngine): boolean {
  if (engine.range() !== null) return true
  const last = writerTools.getState().last
  if (last === null) return false
  engine.select(last.a, last.b, { focus: false })
  return engine.range() !== null
}

/** The focus back in the text, the selection as it was. */
function backToText(): void {
  const { engine, last } = writerTools.getState()
  if (engine !== null && last !== null) engine.select(last.a, last.b)
}

/**
 * The writer's side of the tools: it registers them (and its engine and Pin) while the book is
 * open, reads its selection as it changes, and, beside the board, follows where the user works
 * (a press or the focus in the book, or on the board; never the sidebar's own).
 */
export function useWritingTools(
  engine: BlockEngine | null,
  pin: ((move: boolean) => void) | undefined,
  layout: 'split' | 'full',
): void {
  const pinNow = useRef(pin)
  pinNow.current = pin
  const canPin = pin !== undefined

  useEffect(() => {
    if (engine === null) return
    writerTools.setState({
      Tools: WritingTools,
      engine,
      working: 'book',
      sel: NO_SELECTION,
      last: null,
    })
    document.addEventListener('selectionchange', readSelection)
    // A kind changed by its accelerator, a remote edit: the tools read the selection again.
    const offLayout = engine.onLayout(readSelection)
    readSelection()
    // Tab from selected text goes to the tools (not through every paragraph), the selection kept.
    const onTab = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Tab' || e.shiftKey || isComposing(e) || e.defaultPrevented) return
      if (!document.activeElement?.closest('.bk-book')) return
      const r = engine.range()
      if (r === null || same(r.a, r.b)) return
      const first = document.querySelector<HTMLElement>('[data-writing] button')
      if (first === null) return
      e.preventDefault()
      fromText = true
      first.focus()
    }
    document.addEventListener('keydown', onTab, true)
    return () => {
      document.removeEventListener('selectionchange', readSelection)
      document.removeEventListener('keydown', onTab, true)
      offLayout()
      writerTools.setState({
        Tools: null,
        engine: null,
        layout: null,
        pin: null,
        sel: NO_SELECTION,
        last: null,
      })
    }
  }, [engine])

  useEffect(() => {
    if (engine !== null) writerTools.setState({ layout })
  }, [engine, layout])

  useEffect(() => {
    if (engine !== null)
      writerTools.setState({ pin: canPin ? (move: boolean) => pinNow.current?.(move) : null })
  }, [engine, canPin])

  // Beside the board: the tools follow where the user works.
  useEffect(() => {
    if (layout !== 'split') return
    const at = (e: Event) => {
      const t = e.target
      if (!(t instanceof Element)) return
      const w = t.closest('.book-pane')
        ? 'book'
        : t.closest('.viewport') && !t.closest('.sidebar, .minibar, .picker-sheet, .save-pop')
          ? 'board'
          : null
      if (w !== null && writerTools.getState().working !== w) writerTools.setState({ working: w })
    }
    document.addEventListener('pointerdown', at, true)
    document.addEventListener('focusin', at)
    return () => {
      document.removeEventListener('pointerdown', at, true)
      document.removeEventListener('focusin', at)
    }
  }, [layout])
}

/** Whether ⌥ is held (while `on`): "Pin to board" reads "Move to board". */
function useAlt(on: boolean): boolean {
  const [alt, setAlt] = useState(false)
  useEffect(() => {
    if (!on) return
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Alt') setAlt(e.type === 'keydown')
      else if (e.altKey !== undefined) setAlt(e.altKey)
    }
    const off = () => setAlt(false)
    window.addEventListener('keydown', key, true)
    window.addEventListener('keyup', key, true)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('keyup', key, true)
      window.removeEventListener('blur', off)
      setAlt(false)
    }
  }, [on])
  return alt
}

const isArrow = (e: KeyboardEvent) => e.key.startsWith('Arrow')

/**
 * Text style's picker beside the panel, as "+"'s is: the six kinds, the current one marked; a
 * press on one sets it (a click, Space, or Enter on the one the arrows moved to).
 */
function StylePicker({
  anchor,
  kind,
  focusIn,
  onChoose,
  onClose,
}: {
  anchor: HTMLElement | null
  kind: EditorKind | null
  focusIn: boolean
  onChoose(kind: EditorKind): void
  onClose(refocus: boolean): void
}) {
  const [choice, setChoice] = useState(kind)
  const name = useId()
  const arrowing = useRef(false)
  return (
    <PickerSheet
      anchor={anchor}
      label="Text style"
      className="writing-picker"
      focusIn={focusIn}
      onEnter={() => {
        if (choice !== null) onChoose(choice)
      }}
      onClose={onClose}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: it keeps the text's focus on a press, and watches its radios' arrows */}
      <div
        className="writing-picker-form"
        onPointerDown={hold}
        onMouseDown={hold}
        onKeyDown={(e) => {
          if (isArrow(e)) arrowing.current = true
        }}
        onKeyUp={(e) => {
          if (isArrow(e)) arrowing.current = false
        }}
      >
        <Row title="Text style">
          {KINDS.map(([k, label]) => {
            const Face = KIND_ICON[k] ?? ParagraphIcon
            return (
              <Choice
                key={k}
                className="writing-choice"
                name={name}
                label={label}
                checked={choice === k}
                onPick={() => setChoice(k)}
                onPress={() => {
                  if (!arrowing.current) onChoose(k)
                }}
              >
                <Face />
                <span className="writing-choice-name" aria-hidden="true">
                  {label}
                </span>
              </Choice>
            )
          })}
        </Row>
      </div>
    </PickerSheet>
  )
}

/** On touch (no ⌥ to hold): Pin to board or Move to board. */
function PinChoice({
  anchor,
  onPin,
  onClose,
}: {
  anchor: HTMLElement | null
  onPin(move: boolean): void
  onClose(refocus: boolean): void
}) {
  return (
    <PickerSheet
      anchor={anchor}
      label="Pin to board"
      className="writing-picker writing-pin"
      focusIn={false}
      onEnter={() => onPin(false)}
      onClose={onClose}
    >
      <div className="writing-pin-choices">
        <button
          type="button"
          className="writing-pin-choice"
          onPointerDown={hold}
          onMouseDown={hold}
          onClick={() => onPin(false)}
        >
          Pin to board
        </button>
        <button
          type="button"
          className="writing-pin-choice"
          onPointerDown={hold}
          onMouseDown={hold}
          onClick={() => onPin(true)}
        >
          Move to board
        </button>
      </div>
    </PickerSheet>
  )
}

/** The writing tools, in the panel's column (`sidebar`) or the mini-bar's row. */
export function WritingTools({ bar }: { bar: ToolsBar }) {
  const engine = useWriterTools((s) => s.engine)
  const canPin = useWriterTools((s) => s.pin !== null)
  const sel = useWriterTools((s) => s.sel)
  const folded = usePrefs((p) => p.sidebar === 'folded')
  const [open, setOpen] = useState<'style' | 'pin' | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const styleButton = useRef<HTMLButtonElement>(null)
  const pinButton = useRef<HTMLButtonElement>(null)
  // Text style opened from the keyboard: its picker takes the focus (and gives it back).
  const keyed = useRef(false)
  // The last press's pointer: a finger has no ⌥ to hold.
  const pointer = useRef('')
  const alt = useAlt(canPin && sel.has)

  // Folding or unrolling puts the pickers away: what they stood beside is moving.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the fold changing is the cue
  useEffect(() => setOpen(null), [folded])

  // Over the mini-bar, a phone's keyboard: the bar stands on it, in view (the visual viewport).
  useEffect(() => {
    const vv = window.visualViewport
    const el = box.current?.closest<HTMLElement>('.minibar')
    if (bar !== 'minibar' || !vv || !el) return
    const lift = () => {
      const k = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      el.style.setProperty('--keyboard', `${k}px`)
    }
    lift()
    vv.addEventListener('resize', lift)
    vv.addEventListener('scroll', lift)
    return () => {
      vv.removeEventListener('resize', lift)
      vv.removeEventListener('scroll', lift)
      el.style.removeProperty('--keyboard')
    }
  }, [bar])

  if (engine === null) return null
  const act = (fn: () => void) => {
    if (!ensureRange(engine)) return
    fn()
    readSelection()
  }
  const pin = (move: boolean) => {
    setOpen(null)
    act(() => writerTools.getState().pin?.(move))
  }
  const choose = (k: EditorKind) => {
    const back = keyed.current
    setOpen(null)
    act(() => engine.format(k))
    if (back) backToText()
  }
  const KindFace = (sel.kind !== null && KIND_ICON[sel.kind]) || ParagraphIcon
  const kindName = KINDS.find(([k]) => k === sel.kind)?.[1] ?? 'Paragraph'
  const mod = apple() ? '⌘' : 'Ctrl+'
  const keep = { onPointerDown: hold, onMouseDown: hold }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of commands, not a form field set
    <div
      ref={box}
      className="writing-tools"
      data-writing=""
      data-bar={bar}
      role="group"
      aria-label="Writing"
      onKeyDown={(e) => {
        if (isComposing(e.nativeEvent)) return
        const back =
          e.key === 'Escape' ||
          (e.key === 'Tab' && e.shiftKey && fromText && e.target === styleButton.current)
        if (!back) return
        // Back to the text (the page's own Esc does not go to the shelf).
        e.preventDefault()
        e.stopPropagation()
        fromText = false
        backToText()
      }}
      onBlur={(e: FocusEvent) => {
        const to = e.relatedTarget
        if (!(to instanceof Node) || !box.current?.contains(to)) fromText = false
      }}
    >
      <button
        ref={styleButton}
        type="button"
        className="sidebar-btn writing-style"
        aria-label="Text style"
        title={`Text style: ${kindName}`}
        aria-haspopup="dialog"
        aria-expanded={open === 'style'}
        aria-disabled={!sel.at}
        onPointerDown={(e: PointerEvent) => {
          e.preventDefault()
          pointer.current = e.pointerType || 'mouse'
        }}
        onMouseDown={hold}
        onClick={() => {
          // No press before it: Enter or Space, the keyboard's.
          keyed.current = pointer.current === ''
          pointer.current = ''
          if (!sel.at) return
          setOpen((o) => (o === 'style' ? null : 'style'))
        }}
      >
        <KindFace />
      </button>
      {bar === 'sidebar' && <span className="sidebar-rule" aria-hidden="true" />}
      <ActionButton
        label="Bold"
        Icon={BoldIcon}
        shortcut={`${mod}B`}
        keys="Meta+B Control+B"
        aria-pressed={sel.b}
        aria-disabled={!sel.has}
        {...keep}
        onClick={() => {
          if (sel.has) act(() => engine.format('b'))
        }}
      />
      <ActionButton
        label="Italic"
        Icon={ItalicIcon}
        shortcut={`${mod}I`}
        keys="Meta+I Control+I"
        aria-pressed={sel.i}
        aria-disabled={!sel.has}
        {...keep}
        onClick={() => {
          if (sel.has) act(() => engine.format('i'))
        }}
      />
      <ActionButton
        label="Footnote"
        Icon={FootnoteIcon}
        shortcut="^["
        aria-disabled={!sel.has}
        {...keep}
        onClick={() => {
          if (sel.has) act(() => engine.footnote())
        }}
      />
      {canPin && (
        <ActionButton
          ref={pinButton}
          label={alt ? 'Move to board' : 'Pin to board'}
          Icon={PinIcon}
          shortcut={alt ? undefined : '⌥ moves'}
          aria-disabled={!sel.has}
          aria-expanded={open === 'pin' || undefined}
          onPointerDown={(e: PointerEvent) => {
            e.preventDefault()
            pointer.current = e.pointerType || 'mouse'
          }}
          onMouseDown={hold}
          onClick={(e) => {
            const finger = pointer.current === 'touch' || pointer.current === 'pen'
            pointer.current = ''
            if (!sel.has) return
            if (finger && !alt && !e.altKey) setOpen((o) => (o === 'pin' ? null : 'pin'))
            else pin(alt || e.altKey)
          }}
        />
      )}
      {open === 'style' && (
        <StylePicker
          anchor={styleButton.current}
          kind={sel.kind}
          focusIn={keyed.current}
          onChoose={choose}
          onClose={(refocus) => {
            setOpen(null)
            // Esc: back to Text style when the keyboard opened it; a press left the text focused.
            if (refocus && keyed.current) styleButton.current?.focus()
          }}
        />
      )}
      {open === 'pin' && (
        <PinChoice anchor={pinButton.current} onPin={pin} onClose={() => setOpen(null)} />
      )}
    </div>
  )
}
