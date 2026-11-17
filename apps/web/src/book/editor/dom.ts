import { assetUrl } from '../../lib/assets'
import { footnoteOf as footnoteOfMark } from '../footnotes/marks'
import type { EditorKind, EditorMark, EditorSplice } from './BookEditor'
import { type Block, FIGURE_MEASURE, normalizeMarks } from './model'

/**
 * The writer's page as DOM (ADR-0007): a block drawn into its element and read back from it, and
 * text offsets mapped to DOM points and back. No state of its own.
 */

export const TAG: Record<EditorKind, string> = {
  p: 'p',
  h1: 'h1',
  h2: 'h2',
  quote: 'blockquote',
  li: 'div',
  // A note in the margin (inline where it is narrow: `writer.css`), and an image with its caption.
  prompt: 'p',
  figure: 'figure',
  // A note after its paragraph.
  footnote: 'p',
}

/**
 * Where a block's text is: the block's element, or a figure's caption (its image is no text). The
 * one editing host of a figure is its caption.
 */
export function textHost(el: HTMLElement): HTMLElement {
  if (el.tagName !== 'FIGURE') return el
  return el.querySelector<HTMLElement>(':scope > figcaption') ?? el
}

/** A figure's image and caption, made once; the image's source kept to the block's. */
function figureParts(el: HTMLElement, b: Block): HTMLElement {
  let frame = el.firstElementChild as HTMLElement | null
  let cap = el.querySelector<HTMLElement>(':scope > figcaption')
  if (frame === null || !frame.classList.contains('bk-figure-image') || cap === null) {
    el.textContent = ''
    frame = document.createElement('div')
    frame.className = 'bk-figure-image'
    frame.setAttribute('contenteditable', 'false')
    const img = document.createElement('img')
    img.alt = ''
    img.draggable = false
    img.decoding = 'async'
    img.loading = 'lazy'
    frame.append(img)
    cap = document.createElement('figcaption')
    cap.className = 'bk-caption'
    cap.setAttribute('contenteditable', 'true')
    el.append(frame, cap)
  }
  const img = frame.firstElementChild as HTMLImageElement
  const id = b.image?.assetId
  const src = id === undefined ? '' : assetUrl(id, 1024)
  if (img.getAttribute('src') !== src) {
    if (src === '') img.removeAttribute('src')
    else img.setAttribute('src', src)
  }
  // Its box before the image is in (the CSSOM: the CSP allows no inline styles), so the page
  // does not move as it loads.
  const aspect = b.image?.aspect ?? 0
  const ratio = aspect > 0 ? `${aspect}` : ''
  if (frame.style.aspectRatio !== ratio) frame.style.aspectRatio = ratio
  img.width = FIGURE_MEASURE
  if (aspect > 0) img.height = Math.round(FIGURE_MEASURE / aspect)
  return cap
}

/** A footnote's number as the page has it now (none: not numbered yet, or an orphan). */
export type NumberOf = (footnoteId: string) => number | undefined

/** The class of the wrapper an anchor's number is drawn on (`data-n`, through CSS). */
export const ANCHOR_CLASS = 'bk-anchor'

/**
 * Block `b`'s text drawn into its element (a figure's caption, its image made once): bold and
 * italic only. A card mark is never drawn (no element, no cut in the text): it is the model's.
 * A footnote's anchor wraps the text that ends where it ends in a span naming its
 * footnote (`data-note`), whose number (`data-n`, from `numberOf`) CSS draws after it: never a
 * text node, and never read back.
 */
export function renderInto(el: HTMLElement, b: Block, numberOf?: NumberOf): void {
  const host = el.tagName === 'FIGURE' ? figureParts(el, b) : el
  const marks = b.marks.filter((m) => m.t === 'b' || m.t === 'i')
  // The anchors by where they end (a footnote is never anchored inside a footnote).
  let ends: Map<number, string[]> | null = null
  const starts = new Map<string, number>()
  if (b.kind !== 'footnote')
    for (const m of b.marks) {
      const id = footnoteOfMark(m.t)
      if (id === null) continue
      ends ??= new Map()
      ends.set(m.to, [...(ends.get(m.to) ?? []), id])
      starts.set(id, m.from)
    }
  if (marks.length === 0 && ends === null) {
    host.textContent = b.text
    return
  }
  el = host
  el.textContent = ''
  const cuts = new Set<number>([0, b.text.length])
  for (const m of marks) {
    cuts.add(m.from)
    cuts.add(m.to)
  }
  for (const [at, ids] of ends ?? []) {
    cuts.add(at)
    for (const id of ids) cuts.add(starts.get(id) ?? at)
  }
  const pts = [...cuts].sort((x, y) => x - y)
  for (let k = 0; k + 1 < pts.length; k++) {
    const s = pts[k] as number
    const e = pts[k + 1] as number
    if (e <= s) continue
    const on = (t: 'b' | 'i') => marks.some((m) => m.t === t && m.from <= s && m.to >= e)
    let node: Node = document.createTextNode(b.text.slice(s, e))
    if (on('i')) {
      const em = document.createElement('em')
      em.append(node)
      node = em
    }
    if (on('b')) {
      const strong = document.createElement('strong')
      strong.append(node)
      node = strong
    }
    for (const id of ends?.get(e) ?? []) {
      const span = document.createElement('span')
      span.className = ANCHOR_CLASS
      span.dataset.note = id
      const n = numberOf?.(id)
      if (n !== undefined) span.dataset.n = String(n)
      span.append(node)
      node = span
    }
    el.append(node)
  }
}

/**
 * The marks the DOM shows (bold and italic: never a card's), and whether it holds anything the
 * engine did not write.
 */
export function readMarks(block: HTMLElement): { marks: EditorMark[]; foreign: boolean } {
  const el = textHost(block)
  const marks: EditorMark[] = []
  let foreign = false
  let at = 0
  const walk = (node: Node, b: boolean, i: boolean) => {
    for (let c = node.firstChild; c !== null; c = c.nextSibling) {
      if (c.nodeType === Node.TEXT_NODE) {
        const len = (c as Text).data.length
        if (len > 0) {
          if (b) marks.push({ t: 'b', from: at, to: at + len })
          if (i) marks.push({ t: 'i', from: at, to: at + len })
        }
        at += len
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        const e = c as HTMLElement
        const tag = e.tagName
        if (tag === 'BR') {
          foreign = true
          continue
        }
        // An anchor's wrapper is the engine's own: no mark of the page's (the model keeps it).
        if (tag === 'SPAN' && e.classList.contains(ANCHOR_CLASS)) {
          walk(e, b, i)
          continue
        }
        const bold = tag === 'STRONG' || tag === 'B' || Number(e.style.fontWeight) >= 600
        const ital = tag === 'EM' || tag === 'I' || e.style.fontStyle === 'italic'
        if ((tag !== 'STRONG' && tag !== 'EM') || e.attributes.length > 0) foreign = true
        walk(e, b || bold, i || ital)
      }
    }
  }
  walk(el, false, false)
  return { marks: normalizeMarks(marks, at), foreign }
}

/** The text offset in `el` of the DOM point `(node, off)`. */
export function offsetIn(block: HTMLElement, node: Node, off: number): number {
  const el = textHost(block)
  if (node === el && off === 0) return 0
  // A point in a figure outside its caption (its image): the caption's start.
  if (el !== block && !el.contains(node)) return 0
  const r = document.createRange()
  r.setStart(el, 0)
  r.setEnd(node, off)
  return r.toString().length
}

/** The DOM point at text offset `offset` of `el`. */
export function pointAt(block: HTMLElement, offset: number): { node: Node; offset: number } {
  const el = textHost(block)
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

/** `p` mapped over a splice; a point at the splice's start stays before the insertion. */
export const mapCaret = (p: number, s: EditorSplice) =>
  p <= s.at ? p : p >= s.at + s.del ? p + s.ins.length - s.del : s.at + s.ins.length

/** `marks` without mark `cut`'s type over its run. */
export function subtractRun(marks: readonly EditorMark[], cut: EditorMark): EditorMark[] {
  const out: EditorMark[] = []
  for (const m of marks) {
    if (m.t !== cut.t || m.to <= cut.from || m.from >= cut.to) out.push(m)
    else {
      if (m.from < cut.from) out.push({ t: m.t, from: m.from, to: cut.from })
      if (m.to > cut.to) out.push({ t: m.t, from: cut.to, to: m.to })
    }
  }
  return out
}
