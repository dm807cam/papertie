/**
 * Typing into the writer in a DOM test (jsdom): the browser's own part of a keystroke done by
 * hand (the character into the block's text at the caret, `beforeinput` and `input` around it),
 * a dead key as composition events, Enter and the like as keydowns the engine handles itself.
 */
import { act } from '@testing-library/react'

/** The block element `id`, or the first one. */
export function blockEl(root: ParentNode, id?: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(id === undefined ? '[data-id]' : `[data-id="${id}"]`)
  if (el === null) throw new Error(`no block ${id ?? ''}`)
  return el
}

/** The DOM point at text offset `offset` of `el`. */
function pointAt(el: HTMLElement, offset: number): { node: Node; offset: number } {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let left = offset
  let last: Text | null = null
  for (let n = w.nextNode() as Text | null; n !== null; n = w.nextNode() as Text | null) {
    if (left <= n.data.length) return { node: n, offset: left }
    left -= n.data.length
    last = n
  }
  return last === null ? { node: el, offset: 0 } : { node: last, offset: last.data.length }
}

/** Put the caret (or a selection to `to`) at text offset `at` of `el`. */
export function caret(el: HTMLElement, at: number, to = at, toEl = el): void {
  const a = pointAt(el, at)
  const b = pointAt(toEl, to)
  act(() => {
    document.getSelection()?.setBaseAndExtent(a.node, a.offset, b.node, b.offset)
    document.dispatchEvent(new Event('selectionchange'))
  })
}

/** The text offset of the caret in `el` (-1 when it is not there). */
export function caretOffset(el: HTMLElement): number {
  const s = document.getSelection()
  if (!s?.focusNode || !el.contains(s.focusNode)) return -1
  const r = document.createRange()
  r.setStart(el, 0)
  r.setEnd(s.focusNode, s.focusOffset)
  return r.toString().length
}

/** The block the caret is in. */
const focusBlock = (): HTMLElement => {
  const n = document.getSelection()?.focusNode ?? null
  const e = n === null ? null : n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement
  const b = e?.closest<HTMLElement>('[data-id]')
  if (!b) throw new Error('the caret is in no block')
  return b
}

/** What the browser does with a typed `ch` at the caret: in the text node there, the caret after. */
function insertAtCaret(ch: string): void {
  const s = document.getSelection()
  if (!s || s.rangeCount === 0) throw new Error('no caret')
  const r = s.getRangeAt(0)
  r.deleteContents()
  let node = r.startContainer
  let off = r.startOffset
  if (node.nodeType !== Node.TEXT_NODE) {
    const t = document.createTextNode('')
    const ref = node.childNodes[off] ?? null
    node.insertBefore(t, ref)
    node = t
    off = 0
  }
  ;(node as Text).insertData(off, ch)
  s.setBaseAndExtent(node, off + ch.length, node, off + ch.length)
}

/** Type `text` at the caret, one key at a time, as a Western keyboard does without dead keys. */
export function type(text: string): void {
  for (const ch of text) {
    act(() => {
      const el = focusBlock()
      const k = new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true })
      if (!el.dispatchEvent(k)) return
      const before = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: ch,
        bubbles: true,
        cancelable: true,
      })
      if (!el.dispatchEvent(before)) return
      insertAtCaret(ch)
      el.dispatchEvent(
        new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }),
      )
    })
  }
}

/** A key the engine handles itself (Enter, Backspace, ⌘Z…): whether it took it (prevented). */
export function press(key: string, o: KeyboardEventInit = {}): boolean {
  let taken = false
  act(() => {
    const el = focusBlock()
    taken = !el.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o }),
    )
  })
  return taken
}

/**
 * A dead key at the caret, as Safari and Chrome deliver it: `compositionstart`, the pending mark
 * (`´`) shown, then replaced by `commit` (`é`), `compositionend`. `between` runs while the mark is
 * pending (a remote change, say).
 */
export function deadKey(mark: string, commit: string, between?: () => void): void {
  const finish = startDeadKey(mark)
  between?.()
  finish(commit)
}

/** A dead key pressed and pending (its mark shown); the function it returns commits it. */
export function startDeadKey(mark: string): (commit: string) => void {
  const el = focusBlock()
  let at = 0
  let node: Text | null = null
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Dead', keyCode: 229, bubbles: true, cancelable: true }),
    )
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
    el.dispatchEvent(
      new InputEvent('beforeinput', {
        inputType: 'insertCompositionText',
        data: mark,
        isComposing: true,
        bubbles: true,
      }),
    )
    insertAtCaret(mark)
    const s = document.getSelection() as Selection
    node = s.focusNode as Text
    at = s.focusOffset - mark.length
    el.dispatchEvent(
      new InputEvent('input', {
        inputType: 'insertCompositionText',
        data: mark,
        isComposing: true,
        bubbles: true,
      }),
    )
  })
  return (commit) =>
    act(() => {
      // The browser replaces its pending mark with what was composed, in its own text node.
      const t = node as Text
      if (t.isConnected) {
        t.replaceData(at, mark.length, commit)
        document.getSelection()?.setBaseAndExtent(t, at + commit.length, t, at + commit.length)
      }
      const host = t.isConnected ? (t.parentElement ?? el) : el
      host.dispatchEvent(
        new InputEvent('input', {
          inputType: 'insertCompositionText',
          data: commit,
          isComposing: true,
          bubbles: true,
        }),
      )
      host.dispatchEvent(new CompositionEvent('compositionend', { data: commit, bubbles: true }))
    })
}

/** A paste of `data` (type → text) at the caret, through the `paste` event. */
export function paste(data: Record<string, string>): void {
  act(() => {
    const e = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'clipboardData', {
      value: { getData: (t: string) => data[t] ?? '', types: Object.keys(data) },
    })
    focusBlock().dispatchEvent(e)
  })
}
