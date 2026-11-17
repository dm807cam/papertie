import { LIMITS } from '@papertie/core'
import { type EditLine, editLines, titleClass } from './noteText'

/** How the editor was left: Esc (or ⌘Enter) keeps the keyboard on the note; a blur does not. */
export type EditorExit = 'escape' | 'blur'

/** What the runtime asks of the mounted note editor. */
export interface EditorHandle {
  /** Commit what the field holds now (a composition under way included). */
  flush(): void
  /** Focus the field with the caret after the text. */
  focusEnd(): void
}

export interface SourceEditorOptions {
  /** The note's text, `\n` line breaks. */
  text: string
  /** The width the text is set in, px (a title too long for it steps down a size). */
  textWidth: number
  /** The text changed (an edit, an undo, a composition ended): commit it. */
  commit(text: string): void
  /** Typing met the text limit (said once until there is room again). */
  capped(): void
  done(how: EditorExit): void
  /** Whether the focus going to `to` keeps the writing on (the note's own ref field). */
  keeps?(to: EventTarget | null): boolean
}

interface Snapshot {
  text: string
  sel: [number, number]
}

/** Input types an IME's composition makes: the browser's to apply, never ours. */
const COMPOSITION_TYPES = new Set([
  'insertCompositionText',
  'deleteCompositionText',
  'insertFromComposition',
  'deleteByComposition',
])

/** Typing pauses longer than this start a new step of the editor's own undo. */
const UNDO_PAUSE_MS = 1000
const UNDO_DEPTH = 200

const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/** The grapheme boundary before (or after) `at` in `text`. */
function graphemeStep(text: string, at: number, back: boolean): number {
  if (graphemes === null) return Math.max(0, Math.min(text.length, at + (back ? -1 : 1)))
  let prev = 0
  for (const g of graphemes.segment(text)) {
    const end = g.index + g.segment.length
    if (back && end >= at) return g.index < at ? g.index : prev
    if (!back && g.index >= at) return end
    prev = g.index
  }
  return back ? prev : text.length
}

/** A DOM position. */
export interface CaretPoint {
  node: Node
  offset: number
}

/** The DOM position under a client point, by whichever API the browser has. */
export function caretPointAt(doc: Document, x: number, y: number): CaretPoint | null {
  const d = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (typeof d.caretPositionFromPoint === 'function') {
    const p = d.caretPositionFromPoint(x, y)
    return p ? { node: p.offsetNode, offset: p.offset } : null
  }
  if (typeof d.caretRangeFromPoint === 'function') {
    const r = d.caretRangeFromPoint(x, y)
    return r ? { node: r.startContainer, offset: r.startOffset } : null
  }
  return null
}

/** A line element's text: its marker (kept out of the DOM's text) and what it holds. */
function lineText(n: Node | undefined): string {
  if (n === undefined) return ''
  const mark = n instanceof HTMLElement ? (n.dataset.mark ?? '') : ''
  return mark + (n.textContent ?? '')
}

const lineLength = (n: Node | undefined): number => lineText(n).length

/** What a line's element looks like; equal signatures need no new element. */
function signature(l: EditLine, cls: string): string {
  return `${cls}\u0000${l.markLen}\u0000${l.text}`
}

let editableMode: string | undefined
function editableValue(el: HTMLElement): string {
  if (editableMode === undefined) {
    try {
      el.contentEditable = 'plaintext-only'
      editableMode = 'plaintext-only'
    } catch {
      editableMode = 'true'
    }
  }
  return editableMode
}

/**
 * A note's text as editable lines in the note's own typography: each line is an element with
 * the class the rendering gives it (title, subtitle, bullet, body), so editing changes no size,
 * face or leading. What the rendering drops takes no room: a bullet's marker is kept out of the
 * DOM's text (`data-mark`) and drawn as its "•" (Backspace at the bullet's text removes it), and
 * a blank line at a block's edge (a gap) lies collapsed until the caret first enters it.
 *
 * The browser edits the DOM itself only for plain typing inside one line and for an IME
 * composition, which is never touched while it lasts; both are read back from the DOM (at
 * `input`, at `compositionend`). Every other edit (line breaks, deletions, pastes, typing over
 * a selection across lines) is cancelled at `beforeinput` and applied to the text here (its
 * range from `getTargetRanges`, or the selection), then only the changed lines are set again,
 * in place where they can be, and the caret placed. The editor keeps its own undo (the
 * browser's knows nothing of edits it never made).
 */
export class SourceEditor {
  text: string
  private lines: EditLine[] = []
  private els: HTMLElement[] = []
  private sigs: string[] = []
  private composing = false
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null
  private readonly undoStack: Snapshot[] = []
  private readonly redoStack: Snapshot[] = []
  private last = { at: 0, kind: '' }
  private readonly cleanups: Array<() => void> = []

  constructor(
    readonly root: HTMLElement,
    private readonly o: SourceEditorOptions,
  ) {
    this.text = o.text.replace(/\r\n?/g, '\n')
    root.setAttribute('contenteditable', editableValue(root))
    this.render()
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      root.addEventListener(type, fn)
      this.cleanups.push(() => root.removeEventListener(type, fn))
    }
    on('beforeinput', this.onBeforeInput)
    on('input', this.onInput)
    on('compositionstart', this.onCompositionStart)
    on('compositionend', this.onCompositionEnd)
    on('keydown', this.onKeyDown)
    on('blur', this.onBlur)
    on('copy', this.onCopy)
    on('cut', this.onCut)
    on('dragstart', this.onDragStart)
    on('dragend', this.onDragEnd)
    on('drop', this.onDrop)
    const doc = root.ownerDocument
    doc.addEventListener('selectionchange', this.onSelectionChange)
    this.cleanups.push(() => doc.removeEventListener('selectionchange', this.onSelectionChange))
  }

  dispose(): void {
    if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer)
    for (const fn of this.cleanups.splice(0)) fn()
  }

  /** Focus the field with the caret at `at` (default: after the last line the note shows). */
  focus(at?: number): void {
    this.root.focus({ preventScroll: true })
    const shown = this.lines.filter((l) => l.role !== 'gap').at(-1)
    const end = shown === undefined ? 0 : shown.start + shown.text.length
    const c = Math.max(0, Math.min(this.text.length, at ?? end))
    this.setSelection(c, c)
    this.openCaretGap()
  }

  /**
   * Commit whatever the field holds now, a composition still under way included (the system
   * commits marked text when the field loses focus anyway): before the editor closes.
   */
  flush(): void {
    const t = this.readDom()
    if (t === this.text) return
    this.text = this.clamp(t)
    this.o.commit(this.text)
  }

  /** The selection as text offsets, start ≤ end; null when it is not in the field. */
  selection(): [number, number] | null {
    const sel = this.root.ownerDocument.getSelection()
    if (sel === null || sel.rangeCount === 0) return null
    const r = sel.getRangeAt(0)
    if (!this.root.contains(r.startContainer) || !this.root.contains(r.endContainer)) return null
    const a = this.offsetOf(r.startContainer, r.startOffset)
    const b = this.offsetOf(r.endContainer, r.endOffset)
    return a <= b ? [a, b] : [b, a]
  }

  // --- Rendering ---

  /** Each line's class, in one pass (the role of the last line shown carried forward). */
  private classesOf(lines: readonly EditLine[]): string[] {
    let prev: EditLine['role'] | undefined
    return lines.map((l) => {
      const cls = this.classOf(l, prev)
      if (l.role !== 'gap') prev = l.role
      return cls
    })
  }

  /** A line's class; `prev` is the role of the last line before it the note shows. */
  private classOf(l: EditLine, prev: EditLine['role'] | undefined): string {
    switch (l.role) {
      case 'title':
        return titleClass(l.text.trim(), this.o.textWidth)
      case 'subtitle':
        return 'note-subtitle'
      case 'bullet':
        return prev === 'bullet' ? 'note-edit-bullet' : 'note-edit-bullet note-edit-bullet--first'
      case 'body':
        if (!l.blockStart) return 'note-edit-line'
        return prev === 'title' || prev === 'subtitle'
          ? 'note-body note-edit-after-head'
          : 'note-body'
      default:
        return 'note-edit-gap'
    }
  }

  /**
   * A line's element: its text, or a <br> when it has none. A bullet's marker ("- ", "• ") is not
   * in the DOM's text but in `data-mark`, and the rendering's "•" is drawn for it: no caret, no
   * composition can land inside it, and the line's text starts where the bullet's does.
   */
  private lineEl(l: EditLine, cls: string): HTMLElement {
    const doc = this.root.ownerDocument
    const el = doc.createElement('div')
    el.className = cls
    if (l.markLen > 0) el.dataset.mark = l.text.slice(0, l.markLen)
    const rest = l.text.slice(l.markLen)
    el.append(rest === '' ? doc.createElement('br') : doc.createTextNode(rest))
    return el
  }

  /**
   * Set line `l` into its element `el`, touching only what differs. Returns whether the DOM's
   * text changed (a marker typed or composed into the text moved out of it, a node added or
   * removed): the caret is then put back.
   */
  private patch(el: HTMLElement, l: EditLine, cls: string): boolean {
    // A gap opened stays open; a line that is no longer a gap drops it with the old class.
    const open = l.role === 'gap' && el.classList.contains('note-edit-gap--open')
    const next = open ? `${cls} note-edit-gap--open` : cls
    if (el.className !== next) el.className = next
    const mark = l.text.slice(0, l.markLen)
    if ((el.dataset.mark ?? '') !== mark) {
      if (mark === '') delete el.dataset.mark
      else el.dataset.mark = mark
    }
    const rest = l.text.slice(l.markLen)
    const kids = [...el.childNodes]
    const only = kids.length === 1 ? kids[0] : undefined
    if (
      rest === '' ? only?.nodeName === 'BR' : only?.nodeType === 3 && (only as Text).data === rest
    ) {
      return false
    }
    el.replaceChildren(
      rest === ''
        ? this.root.ownerDocument.createElement('br')
        : this.root.ownerDocument.createTextNode(rest),
    )
    return true
  }

  /**
   * Set the lines again where they changed (common head and tail kept, with their state).
   * Returns whether an element was replaced (the selection in it is then gone).
   */
  private render(): boolean {
    let replaced = false
    this.lines = editLines(this.text)
    const classes = this.classesOf(this.lines)
    const sigs = this.lines.map((l, i) => signature(l, classes[i] ?? ''))
    let head = 0
    while (head < sigs.length && head < this.sigs.length && sigs[head] === this.sigs[head]) head++
    let tail = 0
    while (
      tail < sigs.length - head &&
      tail < this.sigs.length - head &&
      sigs[sigs.length - 1 - tail] === this.sigs[this.sigs.length - 1 - tail]
    ) {
      tail++
    }
    const count = sigs.length - tail - head
    if (count === this.sigs.length - tail - head) {
      // As many lines as before (typing in one): set them again in place, elements kept.
      for (let k = head; k < head + count; k++) {
        const l = this.lines[k]
        const el = this.els[k]
        if (l !== undefined && el !== undefined && this.patch(el, l, classes[k] ?? ''))
          replaced = true
      }
    } else {
      const fresh: HTMLElement[] = []
      for (let k = head; k < head + count; k++) {
        const l = this.lines[k]
        if (l !== undefined) fresh.push(this.lineEl(l, classes[k] ?? ''))
      }
      const gone = this.els.splice(head, this.els.length - head - tail, ...fresh)
      for (const el of gone) el.remove()
      const before = this.els[head + fresh.length] ?? null
      for (const el of fresh) this.root.insertBefore(el, before)
      replaced = true
    }
    // Stray nodes (a composition outside the lines) go: the text has them now.
    const kept = new Set<Node>(this.els)
    for (const n of [...this.root.childNodes]) if (!kept.has(n)) n.remove()
    this.sigs = sigs
    return replaced
  }

  /** A gap the caret is in opens (and stays open while this editor lives). */
  private openCaretGap(): void {
    const sel = this.root.ownerDocument.getSelection()
    const node = sel?.focusNode
    if (!node || !this.root.contains(node)) return
    const el = this.lineOf(node)
    if (el?.classList.contains('note-edit-gap')) el.classList.add('note-edit-gap--open')
  }

  // --- Offsets ---

  private lineOf(node: Node): HTMLElement | null {
    let n: Node | null = node
    while (n !== null && n.parentNode !== this.root) n = n.parentNode
    return n instanceof HTMLElement ? n : null
  }

  private textNodes(el: Node): Text[] {
    const out: Text[] = []
    const walk = (n: Node) => {
      if (n.nodeType === 3) out.push(n as Text)
      else for (const c of n.childNodes) walk(c)
    }
    walk(el)
    return out
  }

  /**
   * The text offset of DOM position (node, off) in the field, from the DOM alone (after a
   * composition the lines may hold more than `lines` knows of): the text of the lines before it,
   * one line break each, and the text before it in its own line.
   */
  private offsetOf(node: Node, off: number): number {
    const kids = this.root.childNodes
    let at = 0
    if (node === this.root) {
      for (let k = 0; k < off && k < kids.length; k++) at += lineLength(kids[k]) + 1
      return Math.max(0, Math.min(at, this.textLength()))
    }
    const el = this.lineOf(node)
    if (el === null) return this.textLength()
    for (const k of kids) {
      if (k === el) break
      at += lineLength(k) + 1
    }
    const r = this.root.ownerDocument.createRange()
    r.setStart(el, 0)
    r.setEnd(node, off)
    return at + (el.dataset.mark?.length ?? 0) + r.toString().length
  }

  /** The length of the text the DOM holds. */
  private textLength(): number {
    let n = -1
    for (const k of this.root.childNodes) n += lineLength(k) + 1
    return Math.max(0, n)
  }

  /** The DOM position of text offset `at`; a place in a bullet's marker is its text's start. */
  private positionOf(at: number): { node: Node; off: number } {
    let i = this.lines.findIndex((l) => at <= l.start + l.text.length)
    if (i < 0) i = this.lines.length - 1
    const line = this.lines[i]
    const el = this.els[i]
    if (line === undefined || el === undefined) return { node: this.root, off: 0 }
    let left = Math.max(0, at - line.start - line.markLen)
    const texts = this.textNodes(el)
    for (let k = 0; k < texts.length; k++) {
      const t = texts[k] as Text
      if (left <= t.data.length && (left < t.data.length || k === texts.length - 1)) {
        return { node: t, off: left }
      }
      left -= t.data.length
    }
    // An empty line: before its <br>.
    return { node: el, off: 0 }
  }

  /** The line holding text offset `at`. */
  private lineAt(at: number): EditLine | undefined {
    return this.lines.find((l) => at <= l.start + l.text.length)
  }

  private setSelection(a: number, b: number): void {
    const sel = this.root.ownerDocument.getSelection()
    if (sel === null) return
    const p = this.positionOf(a)
    const q = a === b ? p : this.positionOf(b)
    sel.setBaseAndExtent(p.node, p.off, q.node, q.off)
  }

  /** The text the lines hold now (a composition's result included). */
  private readDom(): string {
    const out: string[] = []
    for (const n of this.root.childNodes) out.push(lineText(n))
    return out.join('\n')
  }

  // --- Editing ---

  private clamp(t: string): string {
    if (t.length <= LIMITS.maxTextLength) return t
    this.o.capped()
    return t.slice(0, LIMITS.maxTextLength)
  }

  private snapshot(kind: string): void {
    const now = Date.now()
    const merge = kind === this.last.kind && kind !== 'other' && now - this.last.at < UNDO_PAUSE_MS
    this.last = { at: now, kind }
    if (merge) return
    this.undoStack.push({ text: this.text, sel: this.selection() ?? [0, 0] })
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift()
    this.redoStack.length = 0
  }

  /** Replace [a, b) with `ins`, within the limit, and put the caret after it. */
  private replace(a: number, b: number, ins: string, kind: string): void {
    const room = LIMITS.maxTextLength - (this.text.length - (b - a))
    let add = ins.replace(/\r\n?/g, '\n')
    if (add.length > room) {
      add = add.slice(0, Math.max(0, room))
      // Never half a surrogate pair.
      if (/[\uD800-\uDBFF]$/.test(add)) add = add.slice(0, -1)
      this.o.capped()
      if (add === '' && a === b) return
    }
    this.snapshot(kind)
    this.text = this.text.slice(0, a) + add + this.text.slice(b)
    this.render()
    const c = a + add.length
    this.setSelection(c, c)
    this.openCaretGap()
    this.o.commit(this.text)
  }

  private restore(s: Snapshot): void {
    this.text = s.text
    this.render()
    this.setSelection(s.sel[0], s.sel[1])
    this.openCaretGap()
    this.o.commit(this.text)
  }

  private undo(): void {
    const s = this.undoStack.pop()
    if (s === undefined) return
    this.redoStack.push({ text: this.text, sel: this.selection() ?? [0, 0] })
    this.last = { at: 0, kind: '' }
    this.restore(s)
  }

  private redo(): void {
    const s = this.redoStack.pop()
    if (s === undefined) return
    this.undoStack.push({ text: this.text, sel: this.selection() ?? [0, 0] })
    this.last = { at: 0, kind: '' }
    this.restore(s)
  }

  /** The range an input acts on: the browser's target range, or the selection. */
  private rangeOf(e: InputEvent): [number, number] | null {
    const ranges = typeof e.getTargetRanges === 'function' ? e.getTargetRanges() : []
    const r = ranges[0]
    if (r !== undefined && this.root.contains(r.startContainer)) {
      const a = this.offsetOf(r.startContainer, r.startOffset)
      const b = this.offsetOf(r.endContainer, r.endOffset)
      return a <= b ? [a, b] : [b, a]
    }
    return this.selection()
  }

  private onBeforeInput = (e: InputEvent): void => {
    if (this.composing || e.isComposing || COMPOSITION_TYPES.has(e.inputType)) return
    if (this.typesNatively(e)) {
      // Plain typing inside a line: the browser inserts it (no layout forced, the caret its
      // own), and `input` reads the line back.
      this.snapshot('insert')
      return
    }
    e.preventDefault()
    const type = e.inputType
    if (type === 'historyUndo' || type === 'historyRedo') {
      if (type === 'historyUndo') this.undo()
      else this.redo()
      return
    }
    const range = this.rangeOf(e)
    if (range === null) return
    let [a, b] = range
    if (type.startsWith('delete')) {
      // Backward at the start of a bullet's text: the marker goes (the line becomes body).
      const at = this.selection()
      const line = at !== null && at[0] === at[1] ? this.lineAt(at[0]) : undefined
      if (type.includes('Backward') && line !== undefined && line.markLen > 0) {
        if (at?.[0] === line.start + line.markLen) {
          this.replace(line.start, line.start + line.markLen, '', 'delete')
          return
        }
      }
      if (a === b) {
        const back = type.includes('Backward')
        if (back) a = graphemeStep(this.text, a, true)
        else b = graphemeStep(this.text, b, false)
      }
      if (a !== b) this.replace(a, b, '', 'delete')
      return
    }
    let ins: string | null = null
    if (type === 'insertParagraph' || type === 'insertLineBreak') ins = '\n'
    else if (type === 'insertText' || type === 'insertReplacementText') {
      ins = e.data ?? e.dataTransfer?.getData('text/plain') ?? ''
    } else if (
      type === 'insertFromPaste' ||
      type === 'insertFromDrop' ||
      type === 'insertFromYank'
    ) {
      ins = e.dataTransfer?.getData('text/plain') ?? e.data ?? ''
    }
    // Formatting and anything else a plain note has no use for: nothing.
    if (ins === null) return
    const kind = type === 'insertText' && !ins.includes('\n') ? 'insert' : 'other'
    this.replace(a, b, ins, kind)
  }

  /** Typing the browser was left to do, or an edit it made itself: read it back. */
  private onInput = (e: Event): void => {
    if (this.composing || (e as InputEvent).isComposing) return
    this.adopt()
  }

  /**
   * Whether `e` is plain typing the browser can insert itself: text without a line break, at a
   * caret (or over a selection) inside one text node of a line's text (not a bullet's marker),
   * with room for it under the limit.
   */
  private typesNatively(e: InputEvent): boolean {
    const data = e.data
    if (e.inputType !== 'insertText' || data === null || data === '' || /[\r\n]/.test(data)) {
      return false
    }
    const sel = this.root.ownerDocument.getSelection()
    if (sel === null || sel.rangeCount !== 1) return false
    const r = sel.getRangeAt(0)
    const node = r.startContainer
    if (node.nodeType !== 3 || r.endContainer !== node || !this.root.contains(node)) return false
    if (node.parentNode?.parentNode !== this.root) return false
    const removed = r.endOffset - r.startOffset
    return this.text.length - removed + data.length <= LIMITS.maxTextLength
  }

  /**
   * Take the DOM's text as the text, commit it, and set the lines again; the caret is put back
   * only where an element under it was replaced (a line that changed kind), so plain typing
   * forces no layout.
   */
  private adopt(): void {
    const t = this.readDom()
    const sel = this.selection()
    const clamped = this.clamp(t)
    const changed = clamped !== this.text
    this.text = clamped
    const replaced = this.render() || clamped !== t
    if (changed) this.o.commit(this.text)
    if (replaced && sel !== null) {
      this.setSelection(Math.min(sel[0], this.text.length), Math.min(sel[1], this.text.length))
    }
  }

  private onCompositionStart = (): void => {
    this.composing = true
    this.snapshot('other')
  }

  private onCompositionEnd = (): void => {
    this.composing = false
    const t = this.readDom()
    if (t !== this.text) {
      this.text = this.clamp(t)
      this.o.commit(this.text)
    }
    // The lines are set again once the browser is done with the composition's DOM.
    if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer)
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      if (!this.composing) this.adopt()
    }, 0)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // The IME's own keys (229: Safari's just after a composition) choose, convert or cancel.
    if (this.composing || e.isComposing || e.keyCode === 229) return
    const mod = e.metaKey !== e.ctrlKey && !e.altKey
    const letter = /^[a-z]$/i.test(e.key)
      ? e.key.toLowerCase()
      : e.code.replace(/^Key/, '').toLowerCase()
    if (mod && (letter === 'z' || (letter === 'y' && e.ctrlKey))) {
      e.preventDefault()
      if (letter === 'z' && !e.shiftKey) this.undo()
      else this.redo()
      return
    }
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault()
      e.stopPropagation()
      this.o.done('escape')
    }
  }

  private onBlur = (e: FocusEvent): void => {
    // The window losing focus (another app) keeps the field the active element: still writing.
    if (this.root.ownerDocument.activeElement === this.root) return
    if (this.o.keeps?.(e.relatedTarget)) return
    this.o.done('blur')
  }

  private onSelectionChange = (): void => {
    if (!this.composing) this.openCaretGap()
  }

  // --- Clipboard and drag: the text as written, bullets' markers included ---

  /**
   * The selection as the text range it stands for. A selection that starts at the start of a
   * bullet's text and runs past that line takes the bullet's marker too: whole lines cut and
   * pasted (a list reordered) stay bullets. Null when it is empty or not in the field.
   */
  private sourceRange(): [number, number] | null {
    const sel = this.selection()
    if (sel === null || sel[0] === sel[1]) return null
    let [a, b] = sel
    const line = this.lineAt(a)
    if (line !== undefined && line.markLen > 0 && a === line.start + line.markLen) {
      if (b > line.start + line.text.length) a = line.start
    }
    return [a, b]
  }

  private onCopy = (e: ClipboardEvent): void => {
    const r = this.sourceRange()
    if (r === null || e.clipboardData === null) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', this.text.slice(r[0], r[1]))
  }

  private onCut = (e: ClipboardEvent): void => {
    const r = this.sourceRange()
    if (r === null || e.clipboardData === null) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', this.text.slice(r[0], r[1]))
    this.replace(r[0], r[1], '', 'other')
  }

  /** The range being dragged out of the field, moved on a drop inside it. */
  private dragged: [number, number] | null = null

  private onDragStart = (e: DragEvent): void => {
    const r = this.sourceRange()
    if (r === null || e.dataTransfer === null) return
    this.dragged = r
    e.dataTransfer.setData('text/plain', this.text.slice(r[0], r[1]))
  }

  private onDragEnd = (): void => {
    this.dragged = null
  }

  /**
   * A drop of the field's own dragged text moves it, as written, to the drop point; a drop from
   * elsewhere is the browser's `insertFromDrop`.
   */
  private onDrop = (e: DragEvent): void => {
    const r = this.dragged
    this.dragged = null
    if (r === null) return
    e.preventDefault()
    const p = caretPointAt(this.root.ownerDocument, e.clientX, e.clientY)
    if (p === null || !this.root.contains(p.node)) return
    const at = this.offsetOf(p.node, p.offset)
    if (at >= r[0] && at <= r[1]) return
    const moved = this.text.slice(r[0], r[1])
    const rest = this.text.slice(0, r[0]) + this.text.slice(r[1])
    const to = at > r[1] ? at - moved.length : at
    this.snapshot('other')
    this.text = rest.slice(0, to) + moved + rest.slice(to)
    this.render()
    this.setSelection(to, to + moved.length)
    this.openCaretGap()
    this.o.commit(this.text)
  }
}
