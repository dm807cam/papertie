/**
 * What a dropped card became, and the way to change it ("well implemented"): the text is in
 * the book already, in the likely form; this small paper chooser beside its first block
 * offers Paragraph · Quote · Prompt (keys 1 · 2 · 3, or a tap), the current form marked. A switch
 * is a commit of its own (the caller's), so undo takes it back before the drop. While it shows,
 * plain 1–3 are its own (never under a composition: a dead key pending keeps them); any other key
 * goes on to the page as usual and puts it away, as do Esc, a press elsewhere and a new drag.
 * With nothing done it goes after 8 s. It never takes the keyboard from the caret.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isReducedMotion, prefsStore, systemReducedMotion } from '../../app/prefs'
import { MOTION } from '../../styles/motion'
import type { DropForm } from './cardBlocks'
import { chosen } from './dropForms'

/** With nothing done, the chooser goes after this long. */
export const CHOOSER_MS = 8000

const FORMS: ReadonlyArray<{ form: DropForm; key: string; name: string }> = [
  { form: 'p', key: '1', name: 'Paragraph' },
  { form: 'quote', key: '2', name: 'Quote' },
  { form: 'prompt', key: '3', name: 'Prompt' },
]

/** Keys that are no keystroke of their own: they leave the chooser be. */
const QUIET = new Set(['Shift', 'Alt', 'Meta', 'Control', 'CapsLock', 'Fn', 'Dead'])

const reduced = () => isReducedMotion(prefsStore.getState(), systemReducedMotion())

export function DropChooser(p: {
  blockIds: readonly string[]
  form: DropForm
  onSwitch(f: DropForm): void
  onDone(): void
  /**
   * Whether what is picked counts toward the likely form: not for a drop of a card with
   * a ref, whose form was the ref's, not a choice.
   */
  count?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const [fading, setFading] = useState(false)
  /** A form was picked (a switch): typing on is not counted again. */
  const picked = useRef(false)
  const props = useRef(p)
  props.current = p
  const [since, setSince] = useState(0)

  const fade = useCallback(() => {
    if (reduced()) props.current.onDone()
    else setFading(true)
  }, [])

  useEffect(() => {
    if (!fading) return
    const t = setTimeout(() => props.current.onDone(), MOTION.base)
    return () => clearTimeout(t)
  }, [fading])

  // With nothing done: it goes (a switch starts the wait again).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `since` restarts the wait
  useEffect(() => {
    const t = setTimeout(fade, CHOOSER_MS)
    return () => clearTimeout(t)
  }, [fade, since])

  const pick = useCallback((f: DropForm) => {
    picked.current = true
    if (props.current.count !== false) chosen(f)
    if (f !== props.current.form) props.current.onSwitch(f)
    setSince((n) => n + 1)
  }, [])

  useEffect(() => {
    let composing = false
    const start = () => {
      composing = true
    }
    const end = () => {
      composing = false
    }
    const onKey = (e: KeyboardEvent) => {
      if (composing || e.isComposing || e.keyCode === 229 || QUIET.has(e.key)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        fade()
        return
      }
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      const f = plain ? FORMS.find((x) => x.key === e.key) : undefined
      if (f !== undefined) {
        e.preventDefault()
        e.stopPropagation()
        pick(f.form)
        return
      }
      // Typing on keeps the form it landed in.
      if (
        !picked.current &&
        props.current.count !== false &&
        e.key.length === 1 &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        chosen(props.current.form)
      }
      fade()
    }
    const onPress = (e: Event) => {
      if (!(e.target instanceof Node && box.current?.contains(e.target))) fade()
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('compositionstart', start, true)
    document.addEventListener('compositionend', end, true)
    document.addEventListener('pointerdown', onPress, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('compositionstart', start, true)
      document.removeEventListener('compositionend', end, true)
      document.removeEventListener('pointerdown', onPress, true)
    }
  }, [fade, pick])

  // Beside the new text's first block, kept there as the page scrolls (the CSSOM: the CSP).
  const first = p.blockIds[0]
  useLayoutEffect(() => {
    const el = box.current
    if (el === null || first === undefined) return
    const place = () => {
      const block = document.querySelector<HTMLElement>(`.bk-book [data-id="${first}"]`)
      if (block === null) return
      const r = block.getBoundingClientRect()
      const w = el.offsetWidth
      const right = r.right + 12
      const left = right + w <= window.innerWidth - 8 ? right : Math.max(8, r.right - w)
      el.style.left = `${Math.round(left)}px`
      el.style.top = `${Math.round(Math.max(8, r.top - (left === right ? 0 : 40)))}px`
    }
    place()
    document.addEventListener('scroll', place, true)
    return () => document.removeEventListener('scroll', place, true)
  }, [first])

  return (
    <div
      ref={box}
      className="drop-chooser sync-paper"
      role="radiogroup"
      aria-label="Add as"
      data-block={first}
      data-fading={fading || undefined}
    >
      {FORMS.map((f) => (
        // biome-ignore lint/a11y/useSemanticElements: a switch of what was dropped that keeps the caret where it is; a radio input would take the focus
        <button
          key={f.form}
          type="button"
          role="radio"
          tabIndex={-1}
          aria-checked={p.form === f.form}
          aria-keyshortcuts={f.key}
          className="drop-chooser-form"
          // A tap keeps the caret where it is.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(f.form)}
        >
          <span className="drop-chooser-key" aria-hidden="true">
            {f.key}
          </span>
          {f.name}
        </button>
      ))}
    </div>
  )
}
