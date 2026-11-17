import type { Tool } from '../app/prefs'

/** Zoom factor of one `=`/`-` press, about the viewport centre. */
export const KEY_ZOOM_STEP = 1.25

export type KeyCommand = 'zoomIn' | 'zoomOut' | 'fitAll' | 'fitSelection' | 'panHold'

export interface KeyLike {
  key: string
  code: string
  shiftKey: boolean
  target: EventTarget | null
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

/** Input types that take typed text; checkbox, radio, range and button types act as controls. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'number', 'password', 'tel'])

/** True when keys typed at `target` belong to a text field. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false
  const el = target as {
    tagName?: unknown
    type?: unknown
    isContentEditable?: unknown
    closest?: (selector: string) => unknown
  }
  if (el.isContentEditable === true) return true
  // Where `isContentEditable` is missing (jsdom), the attribute says so.
  if (
    typeof el.closest === 'function' &&
    el.closest('[contenteditable]:not([contenteditable="false"])')
  ) {
    return true
  }
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName !== 'INPUT') return false
  // A missing type attribute reads as 'text' in the DOM.
  return TEXT_INPUT_TYPES.has(typeof el.type === 'string' ? el.type.toLowerCase() : 'text')
}

const tagOf = (target: EventTarget | null) =>
  target !== null && typeof target === 'object'
    ? (target as { tagName?: unknown }).tagName
    : undefined

/**
 * A select uses letters (type-ahead) and Space (open) itself; a button, or a control input such
 * as a checkbox, uses Space (press, toggle).
 */
const ownsLetters = (target: EventTarget | null) =>
  isTypingTarget(target) || tagOf(target) === 'SELECT'
const ownsSpace = (target: EventTarget | null) =>
  ownsLetters(target) || tagOf(target) === 'BUTTON' || tagOf(target) === 'INPUT'

const chord = (e: KeyLike) => e.ctrlKey === true || e.metaKey === true || e.altKey === true
const blocked = (e: KeyLike) => chord(e) || isTypingTarget(e.target)

/**
 * Canvas keyboard commands: `=`/`+` and `-` zoom, Shift+1 fits all notes, Shift+2 fits the
 * selection, Space held makes a drag anywhere pan. Digits match by `code`, so any layout's Shift+1 works.
 * Typing targets and ctrl/cmd/alt chords (browser shortcuts) give null, and so does Space on a
 * focused select, button or control input, which it opens, presses or toggles.
 */
export function keyCommand(e: KeyLike): KeyCommand | null {
  if (blocked(e)) return null
  if (e.key === '=' || e.key === '+') return 'zoomIn'
  if (e.key === '-') return 'zoomOut'
  if (e.shiftKey && e.code === 'Digit1') return 'fitAll'
  if (e.shiftKey && e.code === 'Digit2') return 'fitSelection'
  if ((e.code === 'Space' || e.key === ' ') && !ownsSpace(e.target)) return 'panHold'
  return null
}

/** The sidebar's tools' keys: every shortcut is the accelerator of a control there. */
const TOOL_KEYS: Readonly<Record<string, Tool>> = {
  v: 'select',
  y: 'yarn',
}

/**
 * The tool a single-letter key picks (V, Y), or null; null too on a focused select, whose
 * type-ahead the letter belongs to. A focused button or control input (the tilt checkbox) still
 * passes letters on, as a click leaves the focus on it.
 */
export function toolKey(e: KeyLike): Tool | null {
  if (chord(e) || ownsLetters(e.target) || e.key.length !== 1) return null
  return TOOL_KEYS[e.key.toLowerCase()] ?? null
}

/** P: add a photo (the sidebar's Photo button). Same guards as the tool keys. */
export function photoKey(e: KeyLike): boolean {
  return !chord(e) && !ownsLetters(e.target) && e.key.toLowerCase() === 'p'
}

export type HistoryCommand = 'undo' | 'redo'

/** The key's letter: `e.key` when it is a Latin letter, otherwise (a Cyrillic layout) its place. */
export const letterOf = (e: KeyLike) =>
  /^[a-z]$/i.test(e.key)
    ? e.key.toLowerCase()
    : /^Key[A-Z]$/.test(e.code)
      ? e.code.slice(3).toLowerCase()
      : ''

/**
 * Undo (⌘Z, Ctrl+Z) or redo (⇧⌘Z, Ctrl+Y, Ctrl+Shift+Z), or null. Null in a typing target too:
 * a text field's own undo (the note editor's) is the browser's.
 */
export function historyKey(e: KeyLike): HistoryCommand | null {
  const ctrl = e.ctrlKey === true
  // One of ⌘ and Ctrl, not both; with ⌥ it is another shortcut.
  if (isTypingTarget(e.target) || e.altKey === true || ctrl === (e.metaKey === true)) return null
  const letter = letterOf(e)
  if (letter === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (letter === 'y' && ctrl && !e.shiftKey) return 'redo'
  return null
}

/**
 * C, to connect the selected note to another (the `Connect to…` picker). False with a chord or
 * Shift, in a typing target and on a focused select (whose type-ahead owns letters).
 */
export function connectKey(e: KeyLike): boolean {
  return !blocked(e) && !e.shiftKey && !ownsLetters(e.target) && letterOf(e) === 'c'
}

export type NoteCommand = 'edit' | 'delete' | 'duplicate'

/**
 * A command on the selected notes, or null: Enter edits, Delete or Backspace deletes, ⌘D (Ctrl+D)
 * duplicates. Null in a typing target, and for other chords; Enter also on a focused button,
 * link or select, which it presses or opens.
 */
export function noteKey(e: KeyLike): NoteCommand | null {
  if (isTypingTarget(e.target)) return null
  const ctrl = e.ctrlKey === true
  if (ctrl !== (e.metaKey === true) && e.altKey !== true && !e.shiftKey && letterOf(e) === 'd') {
    return 'duplicate'
  }
  if (chord(e)) return null
  if (e.key === 'Delete' || e.key === 'Backspace') return 'delete'
  const tag = tagOf(e.target)
  if (e.key === 'Enter' && !e.shiftKey && tag !== 'BUTTON' && tag !== 'A' && tag !== 'SELECT') {
    return 'edit'
  }
  return null
}

export type FocusCommand = 'focus' | 'exit'

/**
 * Focus mode's keys, or null: F focuses the selection, Esc leaves focus. Null in a typing target
 * and for chords. Esc's order is the runtime's: an open picker takes it first (it stops it),
 * then writing, then focus, and only then does it clear the selection.
 */
export function focusKey(e: KeyLike): FocusCommand | null {
  if (chord(e) || isTypingTarget(e.target)) return null
  if (e.key === 'Escape') return 'exit'
  return !e.shiftKey && letterOf(e) === 'f' ? 'focus' : null
}
