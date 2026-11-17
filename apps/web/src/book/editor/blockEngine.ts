import { announce } from '../../app/liveRegion'
import { DRAG_THRESHOLD_PX } from '../../interactions/drag'
import {
  addFootnote,
  anchorable,
  anchorOf,
  FOOTNOTE_LABELS,
  insertInFootnote,
  paragraphOf,
  removeFootnote,
  wordBefore,
} from '../footnotes/footnotes'
import { footnoteOf as footnoteOfMark } from '../footnotes/marks'
import { numberWindow, paintNumbers } from '../footnotes/numbers'
import { htmlOf, piecesFromHtml } from '../pasteHtml'
import { accelerate, type BookLang, smartTypography } from '../typography'
import type { BookEditor, EditorChange, EditorKind, EditorMark, EditorSplice } from './BookEditor'
import { type Comp, composed, hold as holdChange, idsOf, rebaseComposed } from './compose'
import {
  mapCaret,
  offsetIn,
  pointAt,
  readMarks,
  renderInto,
  subtractRun,
  TAG,
  textHost,
} from './dom'
import {
  anchorIds,
  type Block,
  BookModel,
  deleteRange,
  diffMarks,
  diffText,
  enterCaret,
  insertPieces,
  insertText,
  joinTarget,
  mapMarks,
  marked,
  mergeBack,
  mergeForward,
  normalizeMarks,
  type Pos,
  piecesOf,
  setKind,
  splitAt,
  textOf,
  toggleMark,
} from './model'
import { createPageWindow, type LiveBlock, type PagePlace } from './pageWindow'

/**
 * The writer's engine (ADR-0007): one contenteditable per block. Typing and dead keys inside a
 * block are the browser's own; the engine reads the block back on `input` (outside a
 * composition) and states it as an `edit`, with the book's typography and the Markdown
 * accelerators applied as part of that keystroke's own change (`typography.ts`). Enter, Backspace
 * and Delete at a block's edge, paste, copy, cut, the mark keys and the popover's controls are the
 * engine's commands. A pointer press makes the book one editing host for the drag, so a selection
 * can cross blocks; it goes back to one host per block as soon as the selection is inside one
 * block again. A composition (or a dead key) over such a selection deletes it through the engine
 * first and then composes in the one block left, still in the one host.
 *
 * While a composition runs, a remote change to its block (or to any block a held change named)
 * goes into the model at once and onto the page when the composition ends: the composed text is
 * then rebased onto the model and emitted against the text the consumer already holds. A
 * composition exactly at a remote split's point stays with the head, where it was being typed. A
 * `reset` (a restore) waits for the composition's end too.
 *
 * Only the window is in the DOM (`window`, or the scroller it follows: `pageWindow.ts`), and the
 * focused or composing block wherever it is; a spacer stands for each run of blocks between them.
 * The DOM's own reading and writing of a block is `dom.ts`.
 */

/**
 * Prompts and footnotes go in the right margin when it is at least this wide (px), else inline
 * (a prompt on lines of its own, a footnote under its paragraph): the margin is
 * the scroller's width less the text's edge (the page's left padding, the measure and the gap
 * before the margin: `writer.css`'s container query on `.writer-scroll` at 900 px).
 */
export const MARGIN_MIN = 200
export const TEXT_EDGE = 700

/** The words a chapter is labelled with, by the book's language (the page's `lang`). */
const CHAPTER: Record<BookLang, string> = { en: 'Chapter', de: 'Kapitel' }

/** The popover's controls: a kind for the selected blocks, or a mark over the selected text. */
export type FormatCommand = EditorKind | 'b' | 'i'

/** A run of a block's text, `[from, to)` (find's matches). */
export interface TextRange {
  blockId: string
  from: number
  to: number
}

/** The registry of the CSS Custom Highlight API, where the browser has it. */
type Highlights = {
  registry: { set(name: string, h: unknown): void; delete(name: string): void }
  make: (...r: Range[]) => unknown
}
const highlights = (): Highlights | null => {
  const reg = (globalThis as { CSS?: { highlights?: Highlights['registry'] } }).CSS?.highlights
  const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight
  return reg === undefined || H === undefined
    ? null
    : { registry: reg, make: (...r) => new H(...r) }
}

/** The engine: `BookEditor`, and what the writer's popover and checks ask of it. */
export interface BlockEngine extends BookEditor {
  /**
   * `mount`, with the book's model built already (a long book's, in slices: `BookModel.build`);
   * `at`: the place to open at (its window, the page scrolled to it; the caret is the writer's).
   */
  mountModel(
    el: HTMLElement,
    book: BookModel,
    opts: Parameters<BookEditor['mount']>[2],
    at?: PagePlace,
  ): void
  /** `reset`, with the book's model built already; under a composition, at its end. */
  resetModel(book: BookModel): void
  /** The selection, ordered; null when it is not in the book. */
  range(): { a: Pos; b: Pos } | null
  /** Apply a popover control to the selection (as its accelerator would). */
  format(cmd: FormatCommand): void
  /** Which controls are on for the selection: its blocks' kind (when one), its marks. */
  active(): { kind: EditorKind | null; b: boolean; i: boolean }
  /** The block as the engine holds it (to check it against the board). */
  block(id: string): Block | undefined
  /**
   * Chapter (or any block) `id` near the view's top, the caret at its start; with `offset` (find), the block on the page with that offset at the view's middle, the caret and
   * the focus left where they are.
   */
  reveal(id: string, offset?: number): void
  /**
   * `a`…`b` as the selection, its blocks kept on the page while it is there (one host for a range
   * across blocks); `focus: false` leaves the focus where it is (the find field).
   */
  select(a: Pos, b: Pos, o?: { focus?: boolean }): void
  /**
   * Find's matches drawn on the page (`CSS.highlights` `book-find`, the current one
   * `book-find-current`), of the blocks on it only (the caller passes the window's); where the
   * browser has no highlights, the current match is selected instead. Its block is kept on the
   * page until the next call; `highlight([])` clears them.
   */
  highlight(ranges: readonly TextRange[], current?: TextRange | null): void
  /** Where the page is: what to keep for the next open (`PagePlace`); null when not shown. */
  place(): PagePlace | null
  /** The block elements' box for the selection (the popover's place); null when none. */
  rect(): DOMRect | null
  /** The blocks on the page, in book order, with their tops and heights (px): O(window). */
  liveBlocks(): ReadonlyArray<LiveBlock>
  /** Told after any window move, edit, measure or resize, at most once a frame. */
  onLayout(fn: () => void): () => void
  /**
   * "Footnote" on the selection: a footnote after its paragraph, anchored over it, the
   * caret in it; one commit, `add a footnote`. False when the selection takes none.
   */
  footnote(): boolean
  /** Where the caret is in a footnote, or null when it is in none. */
  footnoteAt(): Pos | null
  /**
   * `text` (a card's ref) inserted into the footnote at `at` (its own
   * text kept), a space before it after a word; the caret after it. One commit, `fill a footnote`.
   */
  insertInFootnote(at: Pos, text: string): void
  /** Footnote `id` and its anchor removed, one commit; `caret`: the caret back at the anchor. */
  removeFootnote(id: string, caret?: boolean): void
  /** Whether footnote `id` is an orphan (nothing anchors it any more). */
  orphan(id: string): boolean
  /**
   * Told when a mouse press inside the selection has travelled `DRAG_THRESHOLD_PX`: the selection's drag out of the book, given the press. Only while one listens does a
   * press inside the selection keep it (no native selecting); released without travel, the caret
   * goes where it was pressed.
   */
  onDragOut(fn: (press: PointerEvent) => void): () => void
}

export interface EngineOptions {
  /** Only a window of blocks in the DOM (the default), or every block (a test, a spike). */
  windowed?: boolean
  /** The book's language: its quotes and its chapter label. */
  lang?: () => BookLang
  /** The element that scrolls the page: the window follows its middle. */
  scroller?: HTMLElement | null
}

export function createEngine(o: EngineOptions = {}): BlockEngine {
  const windowed = o.windowed ?? true
  const lang = o.lang ?? (() => 'en' as BookLang)
  let model = new BookModel([])
  let root: HTMLElement | null = null
  let opts: Parameters<BookEditor['mount']>[2] | null = null
  /** One editing host for the whole window (a drag, a selection across blocks). */
  let span = false
  /** In the one host: the selection's ends as last read (kept on the page as the window moves). */
  let spanEnds: { a: Pos; b: Pos } | null = null
  let pointerDown = false
  /** A selection across blocks was deleted for a composition about to start: stay one host. */
  let holdSpan = false
  /** A dead key was pressed and its composition has not started (or ended) yet. */
  let deadPending = false
  let comp: Comp | null = null
  /** Find's current match's block: kept on the page while the bar shows it. */
  let held: string | null = null
  /** A reset asked for while composing: done when the composition ends. */
  let pendingReset: BookModel | null = null
  /** The empty paragraph shown for a book with none: made on the board by its first change. */
  let ghost: string | null = null
  const cleanup: Array<() => void> = []

  const blockElOf = (n: Node | null): HTMLElement | null => {
    const e =
      n === null ? null : n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement
    const b = e?.closest<HTMLElement>('[data-id]') ?? null
    return b !== null && root?.contains(b) ? b : null
  }

  /** The footnotes' numbers as last laid out (the window's: `numbers.ts`). */
  let numbers: ReadonlyMap<string, number> = new Map()
  const numberOf = (id: string) => numbers.get(id)
  /** Block `b` into its element, its anchors' numbers as the page has them. */
  const draw = (el: HTMLElement, b: Block) => renderInto(el, b, numberOf)

  const win = createPageWindow(
    {
      model: () => model,
      numberOf,
      root: () => root,
      scroller: () => o.scroller,
      keep: () => {
        const keep = new Set<string>(comp?.stale ?? [])
        // Both ends of the selection (a drag across the window keeps its anchor),
        // and, in the one host, the ends it last had where the engine could read them.
        const s = document.getSelection()
        for (const n of [s?.focusNode ?? null, s?.anchorNode ?? null]) {
          const id = blockElOf(n)?.dataset.id
          if (id !== undefined) keep.add(id)
        }
        if (span && spanEnds !== null) {
          keep.add(spanEnds.a.blockId)
          keep.add(spanEnds.b.blockId)
        }
        if (held !== null) keep.add(held)
        return keep
      },
      // A composition in the one host: no block of the host moves until it ends (minor 8).
      still: () => span && comp !== null,
      chapterWord: () => CHAPTER[lang()],
      asidesInMargin: () => model.asidesInMargin,
      resized: () => asidesPlace(),
    },
    windowed,
  )
  const { els, makeEl, insertEl, neighbourShown, layout, ensureRendered } = win

  /** Whether the page's right margin is wide enough for its notes (the scroller's width). */
  const marginWide = () => (o.scroller?.clientWidth ?? 0) - TEXT_EDGE >= MARGIN_MIN
  /** The notes to the margin or inline as the page's width says, the estimates with them. */
  const asidesPlace = () => {
    const on = marginWide()
    if (root !== null) root.dataset.asides = on ? 'margin' : 'inline'
    if (model.setAsidesInMargin(on)) win.reflow()
  }

  /** A figure picked by a click on its image: Delete or Backspace removes it. */
  let picked: string | null = null
  const pick = (id: string | null) => {
    if (picked === id) return
    if (picked !== null) els.get(picked)?.removeAttribute('data-selected')
    picked = id
    const el = id === null ? undefined : els.get(id)
    if (el === undefined) {
      picked = null
      return
    }
    el.dataset.selected = 'true'
    el.focus({ preventScroll: true })
    document.getSelection()?.setBaseAndExtent(el, 0, el, 0)
    announce('Figure selected. Delete removes it.')
  }

  // --- Selection ---------------------------------------------------------------------------

  const selectedBlock = (): string | null => {
    const sel = document.getSelection()
    return blockElOf(sel?.focusNode ?? null)?.dataset.id ?? null
  }

  const posOf = (node: Node | null, off: number): Pos | null => {
    const el = blockElOf(node)
    if (el === null || node === null) return null
    return { blockId: el.dataset.id ?? '', offset: offsetIn(el, node, off) }
  }

  /** The selection as an ordered pair of positions. */
  const range = (): { a: Pos; b: Pos } | null => {
    const sel = document.getSelection()
    if (sel === null || sel.rangeCount === 0) return null
    const r = sel.getRangeAt(0)
    const a = posOf(r.startContainer, r.startOffset)
    const b = posOf(r.endContainer, r.endOffset)
    return a === null || b === null ? null : { a, b }
  }

  const place = (pos: Pos, focus = true) => {
    ensureRendered(pos.blockId)
    const el = els.get(pos.blockId)
    if (el === undefined) return
    if (focus && !span) textHost(el).focus({ preventScroll: true })
    const p = pointAt(el, pos.offset)
    document.getSelection()?.setBaseAndExtent(p.node, p.offset, p.node, p.offset)
  }

  /**
   * One host for the window: the book's element editable. Its blocks stay `contenteditable` but
   * are no editing hosts under an editable parent, so the switch is one attribute, never one a
   * block (toggling 121 blocks' attributes was the first press's 58 ms frame).
   */
  const enterSpan = () => {
    if (span || root === null) return
    span = true
    spanEnds = null
    root.setAttribute('contenteditable', 'true')
  }

  /** Back to one host per block, keeping the selection (which must be inside one block). */
  const exitSpan = () => {
    if (!span || root === null) return
    const sel = document.getSelection()
    const saved =
      sel !== null && sel.rangeCount > 0
        ? { a: sel.anchorNode, ao: sel.anchorOffset, f: sel.focusNode, fo: sel.focusOffset }
        : null
    span = false
    spanEnds = null
    root.removeAttribute('contenteditable')
    const el = blockElOf(saved?.f ?? null)
    if (el !== null && saved !== null && saved.a !== null && saved.f !== null) {
      textHost(el).focus({ preventScroll: true })
      document.getSelection()?.setBaseAndExtent(saved.a, saved.ao, saved.f, saved.fo)
    }
  }

  // --- Changes -----------------------------------------------------------------------------

  /**
   * The selection's two ends as block offsets, mapped through `splices` where they are in `id`,
   * and put back after `redraw` has rewritten that block (span mode: a remote edit inside a
   * selection dragged across blocks keeps it).
   */
  const keepSelection = (id: string, splices: readonly EditorSplice[], redraw: () => void) => {
    const sel = document.getSelection()
    const a = sel === null ? null : posOf(sel.anchorNode, sel.anchorOffset)
    const f = sel === null ? null : posOf(sel.focusNode, sel.focusOffset)
    redraw()
    // A selection elsewhere is left alone (setting it again would end a composition there).
    if (a === null || f === null || sel === null || (a.blockId !== id && f.blockId !== id)) return
    const mapped = (p: Pos) => {
      if (p.blockId !== id) return p
      let off = p.offset
      for (const s of splices) off = mapCaret(off, s)
      return { blockId: id, offset: Math.min(off, model.get(id)?.text.length ?? 0) }
    }
    const pa = mapped(a)
    const pf = mapped(f)
    const ea = els.get(pa.blockId)
    const ef = els.get(pf.blockId)
    if (ea === undefined || ef === undefined) return
    const x = pointAt(ea, pa.offset)
    const y = pointAt(ef, pf.offset)
    sel.setBaseAndExtent(x.node, x.offset, y.node, y.offset)
  }

  /**
   * Show a change the model already holds. Whether the page's spacers and labels are to be laid
   * out again (a structural change): the caller lays them out once for all of a command's changes
   * (item 5: ⌘A then Delete of 60,000 paragraphs laid them out 60,000 times).
   */
  const reflect = (c: EditorChange): boolean => {
    switch (c.t) {
      case 'edit': {
        const el = els.get(c.id)
        const b = model.get(c.id)
        if (el === undefined || b === undefined) return false
        // The selection's ends kept as offsets (a mark set over it, an undo's edit
        // before the caret, a drag across blocks in the one host).
        keepSelection(c.id, c.splices, () => draw(el, b))
        return false
      }
      case 'split': {
        const el = els.get(c.id)
        const head = model.get(c.id)
        const tail = model.get(c.newId)
        if (el !== undefined && head !== undefined && tail !== undefined) {
          draw(el, head)
          el.after(makeEl(tail))
        }
        return true
      }
      case 'merge': {
        const into = els.get(c.into)
        const b = model.get(c.into)
        if (into !== undefined && b !== undefined) draw(into, b)
        els.get(c.from)?.remove()
        els.delete(c.from)
        return true
      }
      case 'kind': {
        const el = els.get(c.id)
        const b = model.get(c.id)
        if (el === undefined || b === undefined) return false
        const r = range()
        const mine = selectedBlock() === c.id
        els.delete(c.id)
        el.replaceWith(makeEl(b))
        if (mine && r !== null) {
          const ea = els.get(r.a.blockId)
          const eb = els.get(r.b.blockId)
          if (ea !== undefined && eb !== undefined) {
            if (!span) els.get(c.id)?.focus({ preventScroll: true })
            const x = pointAt(ea, r.a.offset)
            const y = pointAt(eb, r.b.offset)
            document.getSelection()?.setBaseAndExtent(x.node, x.offset, y.node, y.offset)
          }
        }
        return true
      }
      case 'create': {
        const b = model.get(c.id)
        const i = model.indexOf(c.id)
        if (b !== undefined && (neighbourShown(i) || els.size === 0)) insertEl(b, i)
        return true
      }
      case 'delete': {
        if (picked === c.id) picked = null
        els.get(c.id)?.remove()
        els.delete(c.id)
        return true
      }
      case 'image': {
        const el = els.get(c.id)
        const b = model.get(c.id)
        if (el !== undefined && b !== undefined) draw(el, b)
        return true
      }
    }
  }

  /** The DOM of `ids` again from the model: gone ones out, new ones in beside a shown block. */
  const reconcile = (ids: Set<string>) => {
    for (const id of ids)
      if (model.indexOf(id) < 0) {
        els.get(id)?.remove()
        els.delete(id)
      }
    const live = [...ids]
      .map((id) => [id, model.indexOf(id)] as const)
      .filter(([, i]) => i >= 0)
      .sort((x, y) => x[1] - y[1])
    for (const [id, i] of live) {
      const b = model.at(i) as Block
      const old = els.get(id)
      if (old === undefined) {
        if (neighbourShown(i)) insertEl(b, i)
      } else if (old.tagName !== TAG[b.kind].toUpperCase() || old.className !== `bk bk-${b.kind}`) {
        els.delete(id)
        old.replaceWith(makeEl(b, i))
      } else draw(old, b)
    }
    layout()
  }

  /** Whether a block's text may be typed into as one line only (a figure's caption). */
  const oneLine = (id: string) => {
    const k = model.get(id)?.kind
    return k === 'figure' || k === 'footnote'
  }

  const sel = () => {
    const s = document.getSelection()
    return s === null ? null : posOf(s.focusNode, s.focusOffset)
  }

  /** The block before the empty paragraph a book with none shows, as the page has it. */
  const ghostAfter = (): string | null =>
    ghost === null ? null : (model.at(model.indexOf(ghost) - 1)?.id ?? null)

  /**
   * Changes the consumer is told of: a change naming the empty paragraph a book with none shows
   * makes it first (a `create`, the paragraph as it was shown).
   */
  const emit = (changes: EditorChange[], coalesceKey?: string, label?: string) => {
    if (ghost !== null && changes.some((c) => idsOf(c).includes(ghost as string))) {
      // Where the page shows it: after any paragraph the board took meanwhile.
      changes = [{ t: 'create', id: ghost, after: ghostAfter(), kind: 'p', text: '' }, ...changes]
      ghost = null
    }
    opts?.onChange(changes, {
      ...(coalesceKey === undefined ? {} : { coalesceKey }),
      ...(label === undefined ? {} : { label }),
    })
  }

  /** A command's changes: into the model, onto the page, and out. */
  const local = (changes: EditorChange[], caret?: Pos, coalesceKey?: string, label?: string) => {
    if (changes.length === 0) return
    let lay = false
    for (const c of changes) {
      model.apply(c)
      if (reflect(c)) lay = true
    }
    if (lay) layout()
    else win.changed()
    emit(changes, coalesceKey, label)
    if (caret !== undefined) place(caret)
  }

  // --- Footnotes -----------------------------------------------------------------

  /** A footnote anchored over `[from, to)` of block `blockId`, the caret in it: one commit. */
  const makeFootnote = (blockId: string, from: number, to: number, before: EditorChange[] = []) => {
    if (opts === null) return false
    const id = opts.newBlockId()
    const made = addFootnote(model, blockId, from, to, id)
    if (made.length === 0) return false
    const caret = { blockId: id, offset: 0 }
    if (span) {
      local([...before, ...made], undefined, undefined, FOOTNOTE_LABELS.add)
      exitSpanAt(caret)
    } else local([...before, ...made], caret, undefined, FOOTNOTE_LABELS.add)
    return true
  }

  /**
   * `^[` typed at `p` (its `[` about to go in, or both just composed): a footnote anchored over
   * the word before it, the accelerator's characters taken out in the same commit.
   */
  const footnoteKey = (p: Pos, typed: number): boolean => {
    const b = model.get(p.blockId)
    if (!anchorable(b) || b === undefined) return false
    const at = p.offset - typed
    if (at < 0 || b.text.slice(at, p.offset) !== '^['.slice(0, typed)) return false
    const word = wordBefore(b.text, at)
    if (word === null) return false
    const out: EditorChange = { t: 'edit', id: b.id, splices: [{ at, del: typed, ins: '' }] }
    return makeFootnote(b.id, word.from, word.to, [out])
  }

  /** Footnote `id` and its anchor out of the book; the caret back at the anchor's end. */
  const dropFootnote = (id: string, caret: boolean) => {
    const at = anchorOf(model, id)
    const para = paragraphOf(model, id)
    const changes = removeFootnote(model, id)
    if (changes.length === 0) return
    const to = !caret
      ? undefined
      : at !== null
        ? { blockId: at.block.id, offset: at.mark.to }
        : para !== undefined
          ? { blockId: para.id, offset: para.text.length }
          : undefined
    local(changes, to, undefined, FOOTNOTE_LABELS.remove)
  }

  /** Enter in a footnote: the caret to its paragraph's end, where the text goes on. */
  const leaveFootnote = (id: string) => {
    const para = paragraphOf(model, id)
    if (para !== undefined) place({ blockId: para.id, offset: para.text.length })
  }

  /** The window's footnotes and anchors numbered again, once a frame after the page changed. */
  const renumber = () => {
    // A page not in the document (closed, a test's left behind) needs no numbers.
    if (root === null || !root.isConnected) return
    const ids: string[] = []
    for (const c of root.children as HTMLCollectionOf<HTMLElement>) {
      const id = c.dataset.id
      if (id !== undefined) ids.push(id)
    }
    numbers = numberWindow(model, ids)
    paintNumbers(els, model, ids, numbers)
  }

  /**
   * After an emphasis accelerator, the caret sits at its mark's end: what is typed there next is
   * plain (`*word* and on`), as the Markdown it came from reads.
   */
  let stopMark: { id: string; at: number; t: EditorMark['t'] } | null = null

  const textWith = (text: string, s: EditorSplice) =>
    text.slice(0, s.at) + s.ins + text.slice(s.at + s.del)

  /**
   * Read a block back from the DOM (native typing) and state what changed. A key typed (one
   * character, `insertText`) takes the book's typography and completes an accelerator as part of
   * its own change: the keystroke and its typography are one splice, an accelerator's syntax
   * taken out after it, its kind or mark in the same change. The block is drawn again only then
   * (or when the browser wrote markup of its own), the caret kept where the typing goes on.
   */
  const sync = (el: HTMLElement, typed?: string) => {
    const id = el.dataset.id ?? ''
    const b = model.get(id)
    if (b === undefined) return
    const domText = textHost(el).textContent ?? ''
    const s0 = document.getSelection()
    let caret =
      s0 !== null && s0.focusNode !== null && el.contains(s0.focusNode)
        ? offsetIn(el, s0.focusNode, s0.focusOffset)
        : undefined
    const { marks: domMarks, foreign } = readMarks(el)
    const raw = diffText(b.text, domText, caret)
    const key =
      typed !== undefined &&
      comp === null &&
      raw !== null &&
      raw.del === 0 &&
      raw.ins === typed &&
      caret === raw.at + typed.length
    const stop = stopMark
    stopMark = null
    let text = domText
    let shown = normalizeMarks(domMarks, text.length)
    if (key && caret !== undefined) {
      for (const s of smartTypography(text, caret, lang())) {
        text = textWith(text, s)
        shown = mapMarks(shown, s)
        caret = mapCaret(caret, s)
      }
    }
    // What is typed right after an emphasis accelerator's mark is outside it.
    let unmark: EditorMark | null = null
    if (key && raw !== null && stop !== null && stop.id === id && raw.at === stop.at) {
      unmark = { t: stop.t, from: raw.at, to: raw.at + (text.length - b.text.length) }
      shown = subtractRun(shown, unmark)
    }
    const own = diffText(b.text, text, caret)
    // A caption takes no accelerator: a figure stays a figure, and its caption plain of kinds.
    const found =
      key && caret !== undefined && b.kind !== 'figure' ? accelerate(text, caret, b.kind) : null
    // A footnote stays a footnote: its emphasis only.
    const acc = b.kind === 'footnote' && found?.kind !== undefined ? null : found
    const after = acc?.splices ?? []
    for (const s of after) {
      text = textWith(text, s)
      shown = mapMarks(shown, s)
      if (caret !== undefined) caret = mapCaret(caret, s)
    }
    const splices: EditorSplice[] = own === null ? [...after] : [own, ...after]
    let expected: EditorMark[] = [...b.marks]
    for (const s of splices) expected = mapMarks(expected, s)
    expected = normalizeMarks(expected, text.length)
    // The page shows bold and italic only: a card's marks are the model's, carried as it carries
    // them, never taken away because the page cannot show them.
    let cards = expected.filter((m) => m.t !== 'b' && m.t !== 'i')
    // A footnote's anchor ends where it was set: what is typed right after its number is not in
    // it, so the number never moves with the typing.
    if (own !== null && own.del === 0 && own.ins !== '')
      for (const m of b.marks)
        if (m.to === own.at && footnoteOfMark(m.t) !== null)
          cards = subtractRun(cards, { t: m.t, from: own.at, to: own.at + own.ins.length })
    const want = normalizeMarks([...shown, ...(acc?.addMarks ?? []), ...cards], text.length)
    const md = diffMarks(expected, want)
    const changes: EditorChange[] = []
    if (splices.length > 0 || md !== null) changes.push({ t: 'edit', id, splices, ...(md ?? {}) })
    if (acc?.kind !== undefined) changes.push({ t: 'kind', id, kind: acc.kind })
    let redraw = (foreign && comp === null) || text !== domText || acc !== null || unmark !== null
    if (changes.length > 0) {
      for (const c of changes) model.apply(c)
      if (ghost === id) {
        // The empty paragraph shown for a book with none: its first keystroke makes it.
        const made = model.get(id) as Block
        const after = ghostAfter()
        ghost = null
        opts?.onChange(
          [
            {
              t: 'create',
              id,
              after,
              kind: made.kind,
              text: made.text,
              ...(made.marks.length > 0 ? { marks: [...made.marks] } : {}),
            },
          ],
          { coalesceKey: `type:${id}` },
        )
      } else opts?.onChange(changes, { coalesceKey: `type:${id}` })
    }
    // A block with anchors is drawn again (the browser types at an anchor's end inside its span).
    if (changes.length > 0 && anchorIds(model.get(id) as Block).length > 0) redraw = true
    const mark = acc?.addMarks?.[0]
    if (mark !== undefined) stopMark = { id, at: mark.to, t: mark.t }
    if (changes.length > 0) win.changed()
    if (!redraw) return
    const now = model.get(id) as Block
    if (acc?.kind !== undefined) {
      els.delete(id)
      el.replaceWith(makeEl(now))
      layout()
      place({ blockId: id, offset: caret ?? 0 })
    } else {
      draw(el, now)
      if (caret !== undefined) place({ blockId: id, offset: caret }, false)
    }
  }

  // --- Events ------------------------------------------------------------------------------

  const caretAtLineEdge = (block: HTMLElement, up: boolean): boolean => {
    const el = textHost(block)
    const s = document.getSelection()
    if (s === null || s.rangeCount === 0) return true
    const r = s.getRangeAt(0).getClientRects?.()[0]
    const box = el.getBoundingClientRect?.()
    if (r === undefined || box === undefined) return true
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 27
    return up ? r.top - box.top < line * 0.8 : box.bottom - r.bottom < line * 0.8
  }

  const moveVertical = (el: HTMLElement, up: boolean): boolean => {
    const i = model.indexOf(el.dataset.id ?? '')
    const target = model.at(up ? i - 1 : i + 1)
    if (target === undefined) return false
    ensureRendered(target.id)
    const t = els.get(target.id)
    if (t === undefined) return false
    const s = document.getSelection()
    const x = s?.rangeCount ? (s.getRangeAt(0).getClientRects?.()[0]?.left ?? 0) : 0
    t.scrollIntoView?.({ block: 'nearest' })
    const box = t.getBoundingClientRect?.()
    const hit =
      box === undefined
        ? null
        : document.caretRangeFromPoint?.(x, up ? box.bottom - 4 : box.top + 4)
    textHost(t).focus({ preventScroll: true })
    if (hit && t.contains(hit.startContainer))
      document
        .getSelection()
        ?.setBaseAndExtent(hit.startContainer, hit.startOffset, hit.startContainer, hit.startOffset)
    else place({ blockId: target.id, offset: up ? target.text.length : 0 }, false)
    return true
  }

  /**
   * A selection across blocks about to be composed over (a dead key): the engine deletes it, the
   * caret left at its start in the same host, so the browser never edits across blocks and the
   * composition does not lose its focus.
   */
  const clearForComposition = (): boolean => {
    if (!span) return false
    const r = range()
    if (r === null || r.a.blockId === r.b.blockId) return false
    // Held first: the deletion's own selection changes must not end the one host.
    holdSpan = true
    local(deleteRange(model, r.a, r.b))
    place(r.a, false)
    return true
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (opts === null) return
    if (e.key === 'Escape') {
      // A dead key cancelled: nothing composes, and the one host need not be held for it. The Esc
      // was the dead key's (where no composition events came, as on Chrome for Windows and
      // Linux): it goes no further, so the page's own Esc (back to the shelf) never sees it.
      if (deadPending) e.stopPropagation()
      holdSpan = false
      deadPending = false
      if (comp === null && span) {
        const r = range()
        if (r === null || r.a.blockId === r.b.blockId) exitSpan()
      }
    }
    if (comp !== null) return
    if (picked !== null && !e.isComposing) {
      const id = picked
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // The figure picked by its image goes whole; the caret to the block after it.
        e.preventDefault()
        pick(null)
        const i = model.indexOf(id)
        const next = model.at(i + 1)
        const prev = model.at(i - 1)
        const to =
          next !== undefined
            ? { blockId: next.id, offset: 0 }
            : prev !== undefined
              ? { blockId: prev.id, offset: prev.text.length }
              : undefined
        local([{ t: 'delete', id }], to)
        return
      }
      // Any other key lets it go: it goes on as it would.
      pick(null)
    }
    const mod = e.metaKey || e.ctrlKey
    if (e.isComposing || e.keyCode === 229 || e.key === 'Dead' || e.key === 'Process') {
      if (e.key === 'Dead') deadPending = true
      if (!mod) clearForComposition()
      return
    }
    deadPending = false
    holdSpan = false
    if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      opts.onHistory(e.shiftKey ? 'redo' : 'undo')
      return
    }
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
      // The whole book, the blocks the window does not show too (the browser's own would take
      // one block): copy, cut and Delete then act on all of it through the model (minor 9).
      e.preventDefault()
      selectAll()
      return
    }
    const r = range()
    if (r === null) return
    const collapsed = r.a.blockId === r.b.blockId && r.a.offset === r.b.offset
    if (mod && !e.altKey && (e.key === 'b' || e.key === 'i')) {
      e.preventDefault()
      local(toggleMark(model, r.a, r.b, e.key))
      return
    }
    if (span && r.a.blockId !== r.b.blockId) {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        local(deleteRange(model, r.a, r.b))
        exitSpanAt(r.a)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        local(deleteRange(model, r.a, r.b))
        exitSpanAt(r.a)
        splitHere(r.a)
      } else if (!mod && (e.key.length === 1 || e.key === 'Unidentified')) {
        // The key itself goes in natively, into the one block left.
        local(deleteRange(model, r.a, r.b))
        exitSpanAt(r.a)
      }
      return
    }
    const el = els.get(r.b.blockId)
    if (el === undefined) return
    const len = model.get(r.b.blockId)?.text.length ?? 0
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) return
      if (!collapsed) local(deleteRange(model, r.a, r.b))
      splitHere(r.a)
      return
    }
    if (!collapsed || e.shiftKey || e.altKey || mod) {
      if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) enterSpanKeep()
      else if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        // Shift+→ at its block's end (or ← at its start): the selection grows into the next.
        const f = sel()
        const end = f === null ? 0 : (model.get(f.blockId)?.text.length ?? 0)
        if (f !== null && (e.key === 'ArrowRight' ? f.offset >= end : f.offset === 0))
          enterSpanKeep()
      }
      return
    }
    if (e.key === 'Backspace' && r.a.offset === 0) {
      e.preventDefault()
      const b = model.get(r.a.blockId)
      // A figure's caption at its start: a figure stays a figure, never merged.
      if (b === undefined || b.kind === 'figure') return
      // A footnote is never merged: empty, it goes with its anchor.
      if (b.kind === 'footnote') {
        if (b.text === '') dropFootnote(b.id, true)
        return
      }
      // A heading, quote, list item or prompt at its start goes back to a paragraph first.
      if (b.kind !== 'p') {
        local([{ t: 'kind', id: b.id, kind: 'p' }], r.a)
        return
      }
      const prev = joinTarget(model, model.indexOf(b.id), -1)
      if (prev === undefined) return
      const at = prev.text.length
      ensureRendered(prev.id)
      // After a figure: to its caption's end (the paragraph never runs into it).
      if (prev.kind === 'figure') place({ blockId: prev.id, offset: at })
      else local(mergeBack(model, r.a.blockId), { blockId: prev.id, offset: at })
    } else if (e.key === 'Delete' && r.a.offset === len) {
      e.preventDefault()
      local(mergeForward(model, r.a.blockId), r.a)
    } else if (e.key === 'ArrowLeft' && r.a.offset === 0) {
      const prev = model.at(model.indexOf(r.a.blockId) - 1)
      if (prev === undefined) return
      e.preventDefault()
      place({ blockId: prev.id, offset: prev.text.length })
    } else if (e.key === 'ArrowRight' && r.a.offset === len) {
      const next = model.at(model.indexOf(r.a.blockId) + 1)
      if (next === undefined) return
      e.preventDefault()
      place({ blockId: next.id, offset: 0 })
    } else if (
      (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      caretAtLineEdge(el, e.key === 'ArrowUp')
    ) {
      if (moveVertical(el, e.key === 'ArrowUp')) e.preventDefault()
    }
  }

  /** The selection from the book's first block to its last's end, in the one host. */
  const selectAll = () => {
    const first = model.at(0)
    const last = model.at(model.length - 1)
    if (root === null || first === undefined || last === undefined) return
    enterSpan()
    spanEnds = {
      a: { blockId: first.id, offset: 0 },
      b: { blockId: last.id, offset: last.text.length },
    }
    win.pin()
    const ea = els.get(first.id)
    const eb = els.get(last.id)
    if (ea === undefined || eb === undefined) return
    holdSpan = true
    root.focus({ preventScroll: true })
    const x = pointAt(ea, 0)
    const y = pointAt(eb, last.text.length)
    document.getSelection()?.setBaseAndExtent(x.node, x.offset, y.node, y.offset)
  }

  /**
   * Enter at `at` (`splitAt`: by kind); the caret goes to the start of the new block, or stays in
   * an empty one made a paragraph. In a caption only at its end, a paragraph after the figure.
   */
  const splitHere = (at: Pos) => {
    if (opts === null) return
    const b = model.get(at.blockId)
    if (b?.kind === 'figure' && at.offset < b.text.length) return
    if (b?.kind === 'footnote') {
      leaveFootnote(b.id)
      return
    }
    const newId = opts.newBlockId()
    const changes = splitAt(model, at, newId)
    local(changes, enterCaret(changes, at, newId))
  }

  const exitSpanAt = (p: Pos) => {
    place(p, false)
    exitSpan()
    place(p)
  }

  /** Shift+↑/↓ at a block's edge: the selection may now grow past it. */
  const enterSpanKeep = () => {
    if (span || root === null) return
    const s = document.getSelection()
    if (s === null || s.anchorNode === null || s.focusNode === null) return
    const saved = { a: s.anchorNode, ao: s.anchorOffset, f: s.focusNode, fo: s.focusOffset }
    enterSpan()
    root.focus({ preventScroll: true })
    document.getSelection()?.setBaseAndExtent(saved.a, saved.ao, saved.f, saved.fo)
  }

  /** The key `beforeinput` saw last, for `input` to tell a typed key from other input. */
  let typing: string | undefined

  const onBeforeInput = (e: InputEvent) => {
    if (opts === null) return
    const t = e.inputType
    typing = undefined
    if (t === 'historyUndo' || t === 'historyRedo') {
      e.preventDefault()
      opts.onHistory(t === 'historyUndo' ? 'undo' : 'redo')
      return
    }
    if (e.isComposing || t === 'insertCompositionText') {
      // Not cancelable: a selection across blocks is cleared before the browser replaces it.
      if (comp === null) clearForComposition()
      return
    }
    if (span) {
      const r = range()
      const s = document.getSelection()
      if (r === null && s !== null && s.rangeCount > 0 && root?.contains(s.focusNode)) {
        // A selection the engine cannot read (an end in a spacer): never left to the browser,
        // which would edit across the blocks the window does not show.
        e.preventDefault()
        return
      }
      if (r !== null && r.a.blockId !== r.b.blockId) {
        // Anything the keys above did not catch: never let the browser edit across blocks.
        e.preventDefault()
        local(deleteRange(model, r.a, r.b))
        exitSpanAt(r.a)
        if (t === 'insertText' && e.data) {
          const { changes, caret } = insertText(model, r.a, e.data, opts.newBlockId)
          local(changes, caret, `type:${r.a.blockId}`)
        }
        return
      }
    }
    if (t === 'formatBold' || t === 'formatItalic') {
      e.preventDefault()
      const r = range()
      if (r !== null) local(toggleMark(model, r.a, r.b, t === 'formatBold' ? 'b' : 'i'))
      return
    }
    if (
      t === 'insertParagraph' ||
      t === 'insertLineBreak' ||
      t === 'insertFromPaste' ||
      t === 'insertFromDrop' ||
      t === 'deleteByDrag' ||
      t === 'insertFromYank' ||
      t.startsWith('format')
    ) {
      e.preventDefault()
      if (t === 'insertParagraph') {
        const r = range()
        if (r === null) return
        local(deleteRange(model, r.a, r.b))
        splitHere(r.a)
      }
      return
    }
    if (t === 'insertText' && e.data === '[') {
      const r = range()
      if (r !== null && r.a.blockId === r.b.blockId && r.a.offset === r.b.offset) {
        if (footnoteKey(r.a, 1)) {
          e.preventDefault()
          return
        }
      }
    }
    if (t === 'insertText' && e.data !== null && [...e.data].length === 1) typing = e.data
  }

  const onInput = (e: Event) => {
    const ie = e as InputEvent
    const typed = ie.inputType === 'insertText' && ie.data === typing ? typing : undefined
    typing = undefined
    if (ie.isComposing || comp !== null) return
    deadPending = false
    const el = blockElOf(e.target as Node) ?? blockElOf(document.getSelection()?.focusNode ?? null)
    if (el !== null) sync(el, typed ?? undefined)
  }

  const onCompositionStart = (e: CompositionEvent) => {
    deadPending = false
    clearForComposition()
    const el = blockElOf(document.getSelection()?.focusNode ?? null) ?? blockElOf(e.target as Node)
    if (el === null) return
    const id = el.dataset.id ?? ''
    // What the composition replaces: the selection it starts over, in this block (one source for
    // where its text goes, and for which side of a remote split it falls on).
    const r = range()
    const inside = r !== null && r.a.blockId === id && r.b.blockId === id
    const base = model.get(id)?.text ?? ''
    const start = inside ? r.a.offset : Math.min(base.length, sel()?.offset ?? 0)
    const end = inside ? r.b.offset : start
    comp = {
      id,
      base,
      start,
      end,
      span,
      target: id,
      pos: start,
      gone: false,
      ops: [],
      stale: new Set([id]),
      touched: false,
    }
  }

  const onCompositionEnd = () => {
    const k = comp
    deadPending = false
    if (k === null) return
    comp = null
    holdSpan = false
    const el = els.get(k.id)
    if (pendingReset !== null) settleReset(k, el)
    else if (!k.touched && el !== undefined) sync(el)
    else settle(k, el)
    if (k.span) exitSpan()
    // What waited for the window to move again (fonts, a width: `pageWindow.ts`).
    win.unstill()
    // A dead `^` and the `[` after it, composed together: the footnote's accelerator.
    const p = sel()
    if (p !== null) footnoteKey(p, 2)
  }

  /** The composed text rebased past the held changes, emitted, and the held DOM redrawn. */
  const settle = (k: Comp, el: HTMLElement | undefined) => {
    const text = (el === undefined ? null : textHost(el).textContent) ?? k.base
    const s0 = document.getSelection()
    const caret =
      el !== undefined && s0?.focusNode && el.contains(s0.focusNode)
        ? offsetIn(el, s0.focusNode, s0.focusOffset)
        : undefined
    const mine = composed(k, text, caret)
    // The marks the browser gave the composed text where it was typed (inside a bold run, say).
    const dom = el === undefined ? [] : readMarks(el).marks
    const { target, gone, at, end } = rebaseComposed(k, mine)
    const ins = mine?.ins ?? ''
    if (mine !== null) {
      // The composed text's marks as the page showed them, where the model's rule would differ.
      const splice = { at, del: Math.max(0, end - at), ins }
      const would = gone < 0 ? mapMarks(model.get(target)?.marks ?? [], splice) : []
      const covers = (ms: readonly EditorMark[], t: 'b' | 'i', from: number) =>
        ms.some((m) => m.t === t && m.from <= from && m.to >= from + ins.length)
      const run = { from: at, to: at + ins.length }
      const addMarks: EditorMark[] = []
      const removeMarks: EditorMark[] = []
      for (const t of ['b', 'i'] as const) {
        if (ins.length === 0) continue
        const shown = covers(dom, t, mine.at)
        if (shown && !covers(would, t, at)) addMarks.push({ t, ...run })
        if (!shown && covers(would, t, at)) removeMarks.push({ t, ...run })
      }
      // Against a block gone meanwhile, the edit still goes out: the consumer rejects it whole
      // and offers the text (the one "block gone" policy); the page drops it.
      const change: EditorChange = {
        t: 'edit',
        id: target,
        splices: [splice],
        ...(addMarks.length > 0 ? { addMarks } : {}),
        ...(removeMarks.length > 0 ? { removeMarks } : {}),
      }
      if (gone < 0) model.apply(change)
      emit([change], `type:${target}`)
    }
    const ids = new Set(k.stale)
    if (gone < 0) ids.add(target)
    reconcile(ids)
    if (gone < 0) place({ blockId: target, offset: at + ins.length }, !k.span)
    else {
      const next = model.at(gone) ?? model.at(gone - 1)
      if (next !== undefined) place({ blockId: next.id, offset: 0 }, !k.span)
    }
  }

  /**
   * A reset waited for the composition's end: the book is replaced, and the composed text goes
   * into the same block at the same place when the new book has that block, else it goes out
   * against it all the same (the consumer offers it as text).
   */
  const settleReset = (k: Comp, el: HTMLElement | undefined) => {
    const text = (el === undefined ? null : textHost(el).textContent) ?? k.base
    const mine = composed(k, text, undefined)
    const next = pendingReset ?? new BookModel([])
    pendingReset = null
    doReset(next, win.placeOf(sel()) ?? undefined)
    if (mine === null || mine.ins === '') return
    const b = model.get(k.id)
    const at = Math.min(mine.at, b?.text.length ?? mine.at)
    const change: EditorChange = { t: 'edit', id: k.id, splices: [{ at, del: 0, ins: mine.ins }] }
    if (b !== undefined) {
      model.apply(change)
      if (reflect(change)) layout()
    }
    emit([change], `type:${k.id}`)
    if (b !== undefined) place({ blockId: k.id, offset: at + mine.ins.length })
  }

  const onPaste = (e: ClipboardEvent) => {
    if (opts === null) return
    e.preventDefault()
    const data = e.clipboardData
    const html = data?.getData('text/html') ?? ''
    const text = data?.getData('text/plain') ?? ''
    const r = range()
    if (r === null || (html === '' && text === '')) return
    const pieces = html !== '' ? piecesFromHtml(html) : null
    if (pieces !== null && pieces.length === 0 && text === '') return
    if (r.a.blockId !== r.b.blockId || r.a.offset !== r.b.offset) {
      local(deleteRange(model, r.a, r.b))
      if (span) exitSpanAt(r.a)
    }
    if (oneLine(r.a.blockId)) {
      // Into a caption: its words on one line, plain of kinds (a figure is never split).
      const line = (
        pieces !== null && pieces.length > 0 ? pieces.map((p) => p.text).join(' ') : text
      ).replace(/\s+/g, ' ')
      const { changes, caret } = insertText(model, r.a, line, opts.newBlockId)
      local(changes, caret)
      return
    }
    const { changes, caret } =
      pieces !== null && pieces.length > 0
        ? insertPieces(model, r.a, pieces, opts.newBlockId)
        : insertText(model, r.a, text, opts.newBlockId)
    local(changes, caret)
  }

  const onCopy = (e: ClipboardEvent, cut: boolean) => {
    const r = range()
    if (r === null || e.clipboardData === null) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', textOf(model, r.a, r.b))
    e.clipboardData.setData('text/html', htmlOf(piecesOf(model, r.a, r.b)))
    if (cut) {
      local(deleteRange(model, r.a, r.b))
      if (span) exitSpanAt(r.a)
      else place(r.a)
    }
  }

  /**
   * A press: the window becomes one host only once the pointer leaves the block it pressed (a
   * drag across blocks), so a plain click changes nothing on the page (switching at
   * every press made the first press's frame, and then the first key's, pay for the window's
   * styles). A press on no block (a spacer, the page's edge) is one host at once.
   */
  let pressed: string | null = null
  /** Who takes a selection dragged out of the book (`onDragOut`). */
  const dragOuts = new Set<(press: PointerEvent) => void>()
  /** A mouse press inside the selection, not yet travelled far enough to be its drag. */
  let outPress: PointerEvent | null = null

  /** Whether client point (x, y) is on the selected text (its boxes). */
  const onSelection = (x: number, y: number): boolean => {
    const r = range()
    if (r === null || (r.a.blockId === r.b.blockId && r.a.offset === r.b.offset)) return false
    const s = document.getSelection()
    if (s === null || s.rangeCount === 0) return false
    const boxes = s.getRangeAt(0).getClientRects?.() ?? []
    for (const q of boxes)
      if (x >= q.left && x <= q.right && y >= q.top && y <= q.bottom) return true
    return false
  }

  /** A press inside the selection let go where it was: the caret there, as a click would. */
  const caretAtPoint = (x: number, y: number) => {
    const d = document as Document & {
      caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null
      caretRangeFromPoint?(x: number, y: number): Range | null
    }
    const p = d.caretPositionFromPoint?.(x, y)
    const node = p?.offsetNode ?? d.caretRangeFromPoint?.(x, y)?.startContainer
    const offset = p?.offset ?? d.caretRangeFromPoint?.(x, y)?.startOffset
    if (node == null || offset === undefined || root === null || !root.contains(node)) return
    document.getSelection()?.setBaseAndExtent(node, offset, node, offset)
  }
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || comp !== null) return
    outPress = null
    // A mouse press on the selected text may be its drag out of the book: the selection
    // is kept (its mousedown's default prevented) until it travels or is let go.
    if (
      dragOuts.size > 0 &&
      e.pointerType === 'mouse' &&
      !e.shiftKey &&
      onSelection(e.clientX, e.clientY)
    ) {
      outPress = e
      return
    }
    // A press on a figure's image picks the figure (not its text).
    const frame = (e.target as Element | null)?.closest?.('.bk-figure-image')
    const fig = frame ? blockElOf(frame) : null
    if (fig !== null && !span) {
      e.preventDefault()
      pick(fig.dataset.id ?? null)
      return
    }
    pick(null)
    holdSpan = false
    pointerDown = true
    pressed = blockElOf(e.target as Node)?.dataset.id ?? null
    if (pressed === null) enterSpan()
    else if (e.shiftKey && !span) {
      // Shift+click in another block than the selection's anchor: one host before the browser
      // extends the selection, or it stops at the anchor's block (Important A).
      const anchor = blockElOf(document.getSelection()?.anchorNode ?? null)?.dataset.id
      if (anchor !== undefined && anchor !== pressed) enterSpanKeep()
    }
  }
  const onPointerMove = (e: PointerEvent) => {
    const out = outPress
    if (out !== null) {
      if (Math.hypot(e.clientX - out.clientX, e.clientY - out.clientY) < DRAG_THRESHOLD_PX) return
      outPress = null
      for (const fn of [...dragOuts]) fn(out)
      return
    }
    if (!pointerDown || span || comp !== null) return
    const over = blockElOf(e.target as Node)?.dataset.id ?? null
    if (over !== pressed) enterSpan()
  }

  const onPointerUp = (e: PointerEvent) => {
    if (outPress !== null) {
      outPress = null
      caretAtPoint(e.clientX, e.clientY)
      return
    }
    if (!pointerDown) return
    pointerDown = false
    const r = range()
    if (comp === null && (r === null || r.a.blockId === r.b.blockId)) exitSpan()
    else if (span) focusSpan()
  }

  /**
   * The one host keeps the keys: Firefox takes the focus from the pressed block as the book's
   * element turns editable under it, and its keys then go to the page's body. Only when
   * the focus has left the book, so Chrome and WebKit (the block still focused) change nothing.
   */
  const focusSpan = () => {
    const a = document.activeElement
    if (root === null || (a !== null && root.contains(a))) return
    const s = document.getSelection()
    if (s === null || s.rangeCount === 0 || s.anchorNode === null || s.focusNode === null) return
    const { anchorNode, anchorOffset, focusNode, focusOffset } = s
    root.focus({ preventScroll: true })
    s.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
  }

  const onSelectionChange = () => {
    // The selection gone from a picked figure lets it go.
    if (
      picked !== null &&
      blockElOf(document.getSelection()?.focusNode ?? null)?.dataset.id !== picked
    )
      pick(null)
    if (!span) return
    const ends = range()
    if (ends !== null) spanEnds = ends
    if (pointerDown || comp !== null || holdSpan) return
    const r = ends
    if (r !== null && r.a.blockId === r.b.blockId) exitSpan()
  }

  // --- The adapter -------------------------------------------------------------------------

  function apply(changes: readonly EditorChange[]): void {
    // A reset waiting for a composition's end takes them too: it is the book they are made on.
    if (pendingReset !== null) for (const c of changes) pendingReset.apply(c)
    let lay = false
    for (const c of changes) {
      const k = comp
      // Composing in the one host, every change waits for the end: any DOM write there could
      // touch the composition.
      if (k !== null && (k.span || idsOf(c).some((id) => k.stale.has(id)))) holdChange(model, k, c)
      else if (model.apply(c) && reflect(c)) lay = true
    }
    if (lay) layout()
    else win.changed()
  }

  /**
   * The book replaced (by its blocks, or a model built already: a long book's, in slices); a
   * book with none shows one empty paragraph (`ghost`).
   */
  const doReset = (next: BookModel, at?: PagePlace) => {
    ghost = null
    picked = null
    next.setAsidesInMargin(marginWide())
    if (root !== null) root.dataset.asides = next.asidesInMargin ? 'margin' : 'inline'
    if (next.length === 0 && opts !== null) {
      ghost = opts.newBlockId()
      next.reset([{ id: ghost, kind: 'p', text: '', marks: [] }])
    }
    model = next
    win.build(at)
  }

  const engine: BlockEngine = {
    mount(el, blocks, options) {
      engine.mountModel(el, new BookModel(blocks), options)
    },
    mountModel(el, book, options, at) {
      opts = options
      root = document.createElement('div')
      root.className = 'bk-book'
      el.append(root)
      doReset(book, at)
      const on = <K extends keyof HTMLElementEventMap>(
        target: HTMLElement | Document,
        type: K,
        fn: (e: HTMLElementEventMap[K]) => void,
      ) => {
        target.addEventListener(type, fn as EventListener)
        cleanup.push(() => target.removeEventListener(type, fn as EventListener))
      }
      on(root, 'keydown', onKeyDown)
      on(root, 'beforeinput', onBeforeInput)
      on(root, 'input', onInput)
      on(root, 'compositionstart', onCompositionStart)
      on(root, 'compositionend', onCompositionEnd)
      on(root, 'paste', onPaste)
      on(root, 'copy', (e) => onCopy(e, false))
      on(root, 'cut', (e) => onCopy(e, true))
      on(root, 'pointerdown', onPointerDown)
      on(root, 'mousedown', (e) => {
        if (outPress !== null) e.preventDefault()
      })
      // The book's own text drag never starts: text goes out by the pointer drag.
      on(root, 'dragstart', (e) => e.preventDefault())
      on(document as unknown as HTMLElement, 'pointermove', onPointerMove)
      on(document as unknown as HTMLElement, 'pointerup', onPointerUp)
      const sc = () => onSelectionChange()
      document.addEventListener('selectionchange', sc)
      cleanup.push(() => document.removeEventListener('selectionchange', sc))
      cleanup.push(win.attach())
      cleanup.push(win.onLayout(renumber))
    },
    apply,
    reset(blocks) {
      engine.resetModel(new BookModel(blocks))
    },
    resetModel(book) {
      // Never under a composition: the book is replaced once it ends.
      if (comp !== null) {
        pendingReset = book
        return
      }
      // The page stays where it was (and the caret, where the book still has its block).
      const caret = sel()
      const focused = root?.contains(document.activeElement) === true
      doReset(book, win.placeOf(caret) ?? undefined)
      const b = caret === null ? undefined : model.get(caret.blockId)
      if (caret !== null && focused && b !== undefined && ghost === null)
        place({ blockId: b.id, offset: Math.min(caret.offset, b.text.length) })
    },
    window(r) {
      const a = model.indexOf(r.fromBlockId)
      const b = model.indexOf(r.toBlockId)
      if (a < 0 || b < 0) return
      win.renderRange(Math.min(a, b), Math.max(a, b))
    },
    selection: () => sel(),
    focusAt(pos) {
      place(pos)
      els.get(pos.blockId)?.scrollIntoView?.({ block: 'nearest' })
    },
    composing: () => comp !== null || deadPending,
    destroy() {
      for (const f of cleanup.splice(0)) f()
      root?.remove()
      root = null
      win.clear()
      opts = null
      comp = null
      pendingReset = null
    },
    range,
    format(cmd) {
      const r = range()
      if (r === null || opts === null) return
      if (cmd === 'b' || cmd === 'i') local(toggleMark(model, r.a, r.b, cmd))
      else local(setKind(model, r.a, r.b, cmd))
    },
    active() {
      const r = range()
      if (r === null) return { kind: null, b: false, i: false }
      const ia = model.indexOf(r.a.blockId)
      const ib = model.indexOf(r.b.blockId)
      let kind: EditorKind | null = model.at(ia)?.kind ?? null
      for (let i = ia + 1; i <= ib && kind !== null; i++)
        if (model.at(i)?.kind !== kind) kind = null
      return { kind, b: marked(model, r.a, r.b, 'b'), i: marked(model, r.a, r.b, 'i') }
    },
    block: (id) => model.get(id),
    reveal(id, offset) {
      const b = model.get(id)
      if (b === undefined || root === null) return
      ensureRendered(id)
      if (offset === undefined) {
        // A little below the view's top: a chapter's label above its title shows too.
        win.scrollTo(id, -32)
        place({ blockId: id, offset: 0 })
        return
      }
      const el = els.get(id)
      const sc = o.scroller
      if (el === undefined) return
      const p = pointAt(el, Math.min(offset, b.text.length))
      const r = document.createRange()
      r.setStart(p.node, p.offset)
      const at = r.getBoundingClientRect?.()
      const box = at === undefined || at.height === 0 ? el.getBoundingClientRect?.() : at
      const view = sc?.getBoundingClientRect?.()
      if (sc === null || sc === undefined || box === undefined || view === undefined) {
        el.scrollIntoView?.({ block: 'center' })
        return
      }
      sc.scrollTop += box.top + box.height / 2 - (view.top + view.height / 2)
    },
    select(a, b, so) {
      ensureRendered(a.blockId)
      ensureRendered(b.blockId)
      const ea = els.get(a.blockId)
      const eb = els.get(b.blockId)
      if (ea === undefined || eb === undefined) return
      held = a.blockId
      const focus = so?.focus ?? true
      if (a.blockId !== b.blockId) enterSpan()
      else if (focus && !span) textHost(ea).focus({ preventScroll: true })
      if (focus && span) root?.focus({ preventScroll: true })
      const x = pointAt(ea, a.offset)
      const y = pointAt(eb, b.offset)
      document.getSelection()?.setBaseAndExtent(x.node, x.offset, y.node, y.offset)
    },
    highlight(ranges, current = null) {
      held = current?.blockId ?? null
      const h = highlights()
      if (h === null) {
        if (current !== null) {
          engine.select(
            { blockId: current.blockId, offset: current.from },
            { blockId: current.blockId, offset: current.to },
            { focus: false },
          )
        }
        return
      }
      const rangeOf = (m: TextRange): Range | null => {
        const el = els.get(m.blockId)
        const len = model.get(m.blockId)?.text.length
        if (el === undefined || len === undefined || m.to > len) return null
        const x = pointAt(el, m.from)
        const y = pointAt(el, m.to)
        const r = document.createRange()
        r.setStart(x.node, x.offset)
        r.setEnd(y.node, y.offset)
        return r
      }
      const same = (m: TextRange) =>
        current !== null &&
        m.blockId === current.blockId &&
        m.from === current.from &&
        m.to === current.to
      const rest: Range[] = []
      for (const m of ranges) {
        if (same(m)) continue
        const r = rangeOf(m)
        if (r !== null) rest.push(r)
      }
      const cur = current === null ? null : rangeOf(current)
      if (rest.length === 0 && cur === null) {
        h.registry.delete('book-find')
        h.registry.delete('book-find-current')
        return
      }
      h.registry.set('book-find', h.make(...rest))
      h.registry.set('book-find-current', cur === null ? h.make() : h.make(cur))
    },
    place: () => win.placeOf(sel()),
    rect() {
      const s = document.getSelection()
      if (s === null || s.rangeCount === 0 || range() === null) return null
      const r = s.getRangeAt(0)
      const rects = r.getClientRects?.()
      const first = rects?.[0]
      const box = r.getBoundingClientRect?.()
      return first === undefined ? (box ?? null) : (box ?? first)
    },
    liveBlocks: () => win.liveBlocks(),
    onLayout: (fn) => win.onLayout(fn),
    footnote() {
      const r = range()
      if (r === null || opts === null) return false
      if (r.a.blockId === r.b.blockId)
        return r.a.offset < r.b.offset && makeFootnote(r.a.blockId, r.a.offset, r.b.offset)
      // Across blocks: over the selection's part of its last block (else of its first).
      if (r.b.offset > 0) return makeFootnote(r.b.blockId, 0, r.b.offset)
      const first = model.get(r.a.blockId)
      return first !== undefined && makeFootnote(first.id, r.a.offset, first.text.length)
    },
    footnoteAt() {
      const p = sel()
      return p !== null && model.get(p.blockId)?.kind === 'footnote' ? p : null
    },
    insertInFootnote(at, text) {
      const changes = insertInFootnote(model, at, text)
      const c = changes[0]
      if (c === undefined || c.t !== 'edit') return
      const s = c.splices[0] as EditorSplice
      local(
        changes,
        { blockId: at.blockId, offset: s.at + s.ins.length },
        undefined,
        FOOTNOTE_LABELS.fill,
      )
    },
    removeFootnote: (id, caret = false) => dropFootnote(id, caret),
    orphan: (id) => model.get(id)?.kind === 'footnote' && !model.anchored(id),
    onDragOut(fn) {
      dragOuts.add(fn)
      return () => {
        dragOuts.delete(fn)
      }
    },
  }
  return engine
}
