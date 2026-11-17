import { taskPace } from '../../sync/pace'
import type { EditorKind } from './BookEditor'
import { type NumberOf, renderInto, TAG } from './dom'
import type { Block, BookModel } from './model'

/**
 * The writer's window onto its book (ADR-0007): only the blocks near the view are
 * in the DOM, a spacer standing for each run of blocks between them at their heights (estimated
 * from their text until the page has drawn them, then measured as they leave it: the model's
 * sums, never a pass over the book). The window follows the scroller's middle, `SIDE` blocks each
 * side of the block there, and keeps the view still as it moves: a block on the page stays where
 * it is on screen whatever the spacers above it become. The focused or composing block (and any a
 * held change named) stays in the DOM wherever it is, alone, with a spacer on each side.
 *
 * Prompts and footnotes are drawn in the right margin where it is wide enough, taking no height in
 * the text column: a prompt beside the top of the block before it, a footnote beside the line its
 * number is on, each below the one above where they would meet. Their tops are set by the CSSOM
 * once a frame after the page changed, reading the window's elements only (`placeAsides`:
 * O(window)); inline where the margin is narrow.
 */

/** Room kept between two notes in the margin, one below the other (px). */
export const ASIDE_GAP = 8
/**
 * A footnote's top below the top of its number's line (px): its 13 px first line then sits on the
 * body line's baseline.
 */
export const FOOTNOTE_DROP = 4

/** A block on the page as `liveBlocks` gives it: its top and height in the book's coordinates. */
export interface LiveBlock {
  id: string
  kind: EditorKind
  top: number
  height: number
}

/** How many blocks a window gets when the engine is windowed and nothing has asked yet. */
export const FIRST_WINDOW = 120
/** How many of them go onto the page a task: the first part is a screenful. */
export const FIRST_STEP = 30
/** Blocks kept on each side of the one at the scroller's middle. */
export const SIDE = 60

/**
 * A place on the page: the caret's block and offset, and how far the page is scrolled past that
 * block's top (px; negative when the block begins lower on the page). Stated against the block,
 * not the page's top, it lands the same however the heights above it were estimated.
 */
export interface PagePlace {
  blockId: string
  offset: number
  scrollTop: number
}

export interface WindowHost {
  model(): BookModel
  root(): HTMLElement | null
  scroller(): HTMLElement | null | undefined
  /** Blocks that stay in the DOM wherever they are: the selection's ends, a composition's. */
  keep(): Iterable<string>
  /** The window must not move now (a composition in the one host). */
  still(): boolean
  /** A chapter's label words ("Chapter"), by the book's language. */
  chapterWord(): string
  /** Whether prompts and footnotes are drawn in the margin now (the estimates follow it). */
  asidesInMargin(): boolean
  /** The page or the scroller was resized (the margin's notes may change place with it). */
  resized(): void
  /** A footnote's number as the page has it (its anchors drawn with it). */
  numberOf?: NumberOf
}

export interface PageWindow {
  /** The block elements in the DOM, by id. */
  readonly els: Map<string, HTMLElement>
  makeEl(b: Block, i?: number): HTMLElement
  /** `b`'s element (block `i`), put in among those in the DOM in book order. */
  insertEl(b: Block, i: number): HTMLElement
  /** Whether a block beside block `i` is in the DOM. */
  neighbourShown(i: number): boolean
  /** A spacer for every run of blocks not in the DOM, and each chapter's label right. */
  layout(): void
  /** Blocks `[a, b]` in the DOM (and the kept ones), the view kept still. */
  renderRange(a: number, b: number): void
  /** Block `id` in the DOM, with the window around it when it is not. */
  ensureRendered(id: string): void
  /** The book drawn afresh: its first window, or (with `at`) the window around a place. */
  build(at?: PagePlace): void
  /** The page scrolled so that block `id` (in the DOM) is `scrollTop` px scrolled past. */
  scrollTo(id: string, scrollTop: number): void
  /** The place to keep: `caret` while it is on screen, else the block at the view's top. */
  placeOf(caret: { blockId: string; offset: number } | null): PagePlace | null
  /** The kept blocks not on the page put on it, where they go (the window does not move). */
  pin(): void
  /** Listen to the scroller (the window follows its middle), and to the page's width and fonts. */
  attach(): () => void
  /** The window may move again (a composition in the one host ended): what waited, now. */
  unstill(): void
  /** The page changed (an edit, the window, a size): the notes placed, then `onLayout`'s told. */
  changed(): void
  /** The spacers laid out again from the model's heights, the view held (the notes moved). */
  reflow(): void
  /** The blocks in the DOM, in order, with their tops and heights: O(window). */
  liveBlocks(): LiveBlock[]
  /** Told once a frame at most after the page changed; returns the way to stop. */
  onLayout(fn: () => void): () => void
  clear(): void
}

const familyName = (f: string) =>
  f
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()

/** What `document.fonts` holds of a face, as the window reads it. */
interface Face {
  family: string
  status: string
  loaded: Promise<unknown>
}

/**
 * The page's faces still to come, watched once each for the page's lifetime (WebKit fires no
 * `loadingdone`: a face tells by its own `loaded` promise). A face that never settles (a
 * unicode-range subset no text asks for: Latin Extended, in most books) keeps its handler for as
 * long as the page lives, so the handler holds nothing of any book: it names the face alone, and
 * tells whichever windows are live then. A window on a book closed is gone from `liveWindows`
 * with its engine.
 */
const facesWatched = new WeakSet<Face>()
const liveWindows = new Set<(families: ReadonlySet<string>) => void>()
let facesIn: Set<string> | null = null
const faceLoaded = (face: Face) => {
  if (facesIn === null) {
    facesIn = new Set()
    // Faces that come in together, told once.
    queueMicrotask(() => {
      const families = facesIn ?? new Set<string>()
      facesIn = null
      for (const tell of liveWindows) tell(families)
    })
  }
  facesIn.add(familyName(face.family))
}
const watchFace = (face: Face) => {
  if (face.status === 'loaded' || facesWatched.has(face)) return
  facesWatched.add(face)
  face.loaded.then(
    () => faceLoaded(face),
    () => {},
  )
}

export function createPageWindow(h: WindowHost, windowed: boolean): PageWindow {
  const els = new Map<string, HTMLElement>()
  let spacerEls: HTMLElement[] = []
  /** The block at the scroller's middle when the window was last placed. */
  let anchor = -1
  /** The first window's growth under way (a newer build, or the scroll, ends it). */
  let growing = 0
  let raf = 0

  /** A prompt or a footnote drawn in the margin: out of the text's flow (no height there). */
  const aside = (e: Element | null): boolean =>
    e !== null &&
    h.asidesInMargin() &&
    (e.classList.contains('bk-prompt') || e.classList.contains('bk-footnote'))
  /** `e`, or the first element after it in the text's flow. */
  const inFlow = (e: Element | null): HTMLElement | null => {
    while (e !== null && aside(e)) e = e.nextElementSibling
    return e as HTMLElement | null
  }

  /** A chapter's label: "Chapter N" by its place among the book's chapters. */
  const label = (el: HTMLElement, i: number) => {
    const text = `${h.chapterWord()} ${h.model().chaptersBefore(i) + 1}`
    if (el.dataset.label !== text) el.dataset.label = text
  }

  const makeEl = (b: Block, i = h.model().indexOf(b.id)): HTMLElement => {
    const el = document.createElement(TAG[b.kind])
    el.className = `bk bk-${b.kind}`
    el.dataset.id = b.id
    // A host of its own, or (under the one host's editable book) just editable. A figure's host
    // is its caption (its image is not editable: `dom.ts`).
    if (b.kind !== 'figure') el.setAttribute('contenteditable', 'true')
    else el.tabIndex = -1
    if (b.kind === 'h1') label(el, i)
    renderInto(el, b, h.numberOf)
    if (b.kind === 'footnote') {
      const n = h.numberOf?.(b.id)
      if (n !== undefined) el.dataset.n = String(n)
    }
    els.set(b.id, el)
    return el
  }

  const spacer = (from: number, to: number): HTMLElement => {
    const model = h.model()
    const el = document.createElement('div')
    el.className = 'bk-spacer'
    el.setAttribute('aria-hidden', 'true')
    el.style.height = `${model.heightOf(from, to)}px`
    el.dataset.spacerFrom = model.at(from)?.id ?? ''
    el.dataset.spacerTo = model.at(to)?.id ?? ''
    spacerEls.push(el)
    return el
  }

  /**
   * A spacer for every run of blocks not in the DOM, and each chapter's label right. Never moves
   * a block's element. A block held while gone from the model (a held delete) is passed over.
   */
  const layout = () => {
    const root = h.root()
    if (root === null) return
    const model = h.model()
    for (const s of spacerEls) s.remove()
    spacerEls = []
    let prev = -1
    for (const el of [...root.children] as HTMLElement[]) {
      const id = el.dataset.id
      if (id === undefined) continue
      const i = model.indexOf(id)
      if (i < 0) continue
      if (i > prev + 1) el.before(spacer(prev + 1, i - 1))
      if (el.tagName === 'H1') label(el, i)
      prev = i
    }
    if (prev < model.length - 1) root.append(spacer(prev + 1, model.length - 1))
    changed()
  }

  // --- The notes in the margin, and what the page tells once a frame --------------------------

  const listeners = new Set<() => void>()
  let frame = 0
  /** Notes placed while the window had to stay still: once it may move. */
  let placeDue = false

  /**
   * Each note in the margin: a prompt beside the top of the block before it (one at the book's
   * start beside the first block), a footnote beside the line its number is on (an orphan, or one
   * whose paragraph is off the page, as a prompt), and each below the one above where they would
   * meet, in the order of where they want to be. All the reads first, then the writes (one
   * layout); only the window's elements: O(window).
   */
  const placeAsides = () => {
    const root = h.root()
    if (root === null || !h.asidesInMargin()) return
    if (h.still()) {
      placeDue = true
      return
    }
    placeDue = false
    // Where each footnote's number is drawn: after the last line of its anchor.
    const origin = root.getBoundingClientRect().top
    const lines = new Map<string, number>()
    for (const a of root.querySelectorAll<HTMLElement>('.bk-anchor[data-note]')) {
      const rects = a.getClientRects()
      const last = rects[rects.length - 1]
      if (last !== undefined) lines.set(a.dataset.note as string, last.top - origin + FOOTNOTE_DROP)
    }
    const notes: Array<{ el: HTMLElement; beside: number | null; height: number }> = []
    let top: number | null = null
    /** Where the last footnote of the block before wants to be (that block's top with none). */
    let after = Number.NEGATIVE_INFINITY
    for (const c of root.children as HTMLCollectionOf<HTMLElement>) {
      if (c.classList.contains('bk-spacer')) {
        // The block before it is off the page: beside where the page goes on.
        top = c.offsetTop + c.offsetHeight
        after = top
        continue
      }
      if (c.dataset.id === undefined) continue
      if (aside(c)) {
        const footnote = c.classList.contains('bk-footnote')
        const line = footnote ? lines.get(c.dataset.id) : undefined
        // A footnote with no number on the page: no higher than the footnote before it.
        const beside = line ?? (footnote && top !== null ? Math.max(top, after) : top)
        if (footnote && beside !== null) after = beside
        notes.push({ el: c, beside, height: c.offsetHeight })
        continue
      }
      top = c.offsetTop
      after = top
      for (const p of notes) if (p.beside === null) p.beside = top
    }
    // By where each wants to be (the page's order where two want the same place).
    const order = notes.map((p, k) => ({ k, at: p.beside ?? 0 }))
    order.sort((x, y) => x.at - y.at || x.k - y.k)
    let bottom = Number.NEGATIVE_INFINITY
    const tops: number[] = []
    for (const { at, k } of order) {
      const t = Math.max(at, bottom + ASIDE_GAP)
      tops[k] = t
      bottom = t + (notes[k] as { height: number }).height
    }
    notes.forEach((p, k) => {
      const v = `${Math.round(tops[k] as number)}px`
      if (p.el.style.top !== v) p.el.style.top = v
    })
  }

  /** After the page changed: once a frame, the margin's notes placed and `onLayout`'s told. */
  function changed() {
    if (frame !== 0 || typeof requestAnimationFrame !== 'function') return
    frame = requestAnimationFrame(() => {
      frame = 0
      placeAsides()
      for (const fn of listeners) fn()
    })
  }

  const liveBlocks = (): LiveBlock[] => {
    const root = h.root()
    if (root === null) return []
    const model = h.model()
    const out: LiveBlock[] = []
    for (const c of root.children as HTMLCollectionOf<HTMLElement>) {
      const id = c.dataset.id
      const b = id === undefined ? undefined : model.get(id)
      if (b === undefined) continue
      out.push({ id: b.id, kind: b.kind, top: c.offsetTop, height: c.offsetHeight })
    }
    return out
  }

  const insertEl = (b: Block, i: number): HTMLElement => {
    const model = h.model()
    const root = h.root()
    const el = makeEl(b, i)
    const prev = model.at(i - 1)
    const pe = prev === undefined ? undefined : els.get(prev.id)
    if (pe !== undefined && pe !== el) {
      pe.after(el)
      return el
    }
    for (const c of root?.children ?? []) {
      const id = (c as HTMLElement).dataset.id
      if (id !== undefined && c !== el && model.indexOf(id) > i) {
        c.before(el)
        return el
      }
    }
    root?.append(el)
    return el
  }

  const neighbourShown = (i: number) => {
    const model = h.model()
    const prev = model.at(i - 1)
    const next = model.at(i + 1)
    return (prev !== undefined && els.has(prev.id)) || (next !== undefined && els.has(next.id))
  }

  /** The first block on screen that `stays` keeps, and its top: what the view is held by. */
  const pinOf = (stays: (el: HTMLElement) => boolean): { el: HTMLElement; top: number } | null => {
    const sc = h.scroller()
    const root = h.root()
    if (!windowed || sc === null || sc === undefined || root === null) return null
    const top = sc.getBoundingClientRect?.().top
    if (top === undefined) return null
    for (const c of root.children as HTMLCollectionOf<HTMLElement>) {
      if (c.dataset.id === undefined || !stays(c) || aside(c)) continue
      const r = c.getBoundingClientRect()
      if (r.bottom > top) return { el: c, top: r.top }
    }
    return null
  }

  /** The view moved back by what the page above `pin` grew or shrank. */
  const hold = (pin: { el: HTMLElement; top: number } | null) => {
    const sc = h.scroller()
    if (pin === null || sc === null || sc === undefined || !pin.el.isConnected) return
    const delta = pin.el.getBoundingClientRect().top - pin.top
    if (Math.abs(delta) >= 0.5) sc.scrollTop += delta
  }

  const renderRange = (a: number, b: number) => {
    const root = h.root()
    if (root === null) return
    const model = h.model()
    a = Math.max(0, a)
    b = Math.min(model.length - 1, b)
    const keep = new Set<string>(h.keep())
    const leaving: Array<[string, HTMLElement]> = []
    for (const [id, el] of els) {
      const i = model.indexOf(id)
      if ((i < a || i > b) && !keep.has(id)) leaving.push([id, el])
    }
    const gone = new Set(leaving.map(([, el]) => el))
    // Read before any write (one layout): what holds the view, and the leaving blocks' heights,
    // each from its top to the next element's (a block or a spacer).
    const pin = pinOf((el) => !gone.has(el))
    if (windowed)
      for (const [id, el] of leaving) {
        // A note in the margin has no height in the text; a block's runs to the next in it.
        if (aside(el)) continue
        const next = inFlow(el.nextElementSibling)
        if (next !== null) model.measure(id, next.offsetTop - el.offsetTop)
      }
    for (const [id, el] of leaving) {
      el.remove()
      els.delete(id)
    }
    for (let i = a; i <= b; i++) {
      const blk = model.at(i) as Block
      if (!els.has(blk.id)) insertEl(blk, i)
    }
    layout()
    hold(pin)
  }

  const ensureRendered = (id: string) => {
    if (els.has(id)) return
    const i = h.model().indexOf(id)
    if (i < 0) return
    growing++
    anchor = i
    renderRange(i - SIDE, i + SIDE)
  }

  /** The block at the scroller's middle: a block's own, or its place in a spacer's run. */
  const follow = () => {
    raf = 0
    const sc = h.scroller()
    const root = h.root()
    if (!windowed || sc === null || sc === undefined || root === null || h.still()) return
    const model = h.model()
    const box = root.getBoundingClientRect?.()
    const view = sc.getBoundingClientRect?.()
    if (box === undefined || view === undefined) return
    const x = box.left + Math.min(40, box.width / 2)
    const y = view.top + view.height / 2
    const hit = document.elementFromPoint?.(x, y)
    let i = -1
    const b = hit?.closest<HTMLElement>('[data-id]')
    if (b && root.contains(b)) i = model.indexOf(b.dataset.id ?? '')
    else {
      const sp = hit?.closest<HTMLElement>('[data-spacer-from]')
      if (sp) {
        const from = model.indexOf(sp.dataset.spacerFrom ?? '')
        const to = model.indexOf(sp.dataset.spacerTo ?? '')
        const r = sp.getBoundingClientRect()
        i = Math.round(from + ((y - r.top) / Math.max(1, r.height)) * (to - from))
      }
    }
    if (i < 0 || Math.abs(i - anchor) < 20) return
    growing++
    anchor = i
    renderRange(i - SIDE, i + SIDE)
  }
  const onScroll = () => {
    if (raf === 0) raf = requestAnimationFrame(follow)
  }

  /**
   * A measured height is of one width and one set of fonts: another, and every block is estimated
   * again (minor 9), the spacers with it, the view held by the block on screen (as
   * `renderRange` holds it). Never while the window must stay still (a composition in the one
   * host: the spacers are in its editing host): then once it may move (minor 3).
   */
  let againDue = false
  const again = () => {
    if (h.still()) {
      againDue = true
      return
    }
    againDue = false
    const pin = pinOf(() => true)
    h.model().unmeasureAll()
    layout()
    hold(pin)
  }
  /** The model's heights changed by themselves (the notes' place): the spacers, the view held. */
  const reflow = () => {
    const root = h.root()
    if (root === null) return
    const pin = pinOf(() => true)
    if (!h.asidesInMargin())
      for (const c of root.querySelectorAll<HTMLElement>(
        ':scope > .bk-prompt, :scope > .bk-footnote',
      ))
        c.style.top = ''
    layout()
    hold(pin)
  }
  /** Fonts that came in together: the heights estimated again once. */
  let againQueued = false
  const againSoon = () => {
    if (againQueued) return
    againQueued = true
    queueMicrotask(() => {
      againQueued = false
      again()
    })
  }
  /** The families the book is set in: its body's, and its headings' and quotes' on the page. */
  const bookFamilies = (): Set<string> => {
    const out = new Set<string>()
    const root = h.root()
    if (root === null || typeof getComputedStyle !== 'function') return out
    const add = (el: Element | null) => {
      if (el === null) return
      for (const f of getComputedStyle(el).fontFamily.split(',')) {
        const name = familyName(f)
        if (name !== '') out.add(name)
      }
    }
    add(root)
    for (const tag of ['h1', 'h2', 'h3', 'blockquote']) add(root.querySelector(tag))
    return out
  }
  /** Fonts loaded: only one the book is set in changes its heights (the board's never do). */
  const fontsIn = (families: ReadonlySet<string>) => {
    if (families.size > 0) {
      const used = bookFamilies()
      let any = false
      for (const f of families) if (used.has(f)) any = true
      if (!any) return
    }
    againSoon()
  }
  const onFonts = (e: Event) => {
    const faces = (e as Event & { fontfaces?: ReadonlyArray<{ family: string }> }).fontfaces
    fontsIn(new Set((faces ?? []).map((f) => familyName(f.family))))
  }

  const scrollTo = (id: string, scrollTop: number) => {
    const sc = h.scroller()
    const el = els.get(id)
    if (sc === null || sc === undefined || el === undefined) return
    const view = sc.getBoundingClientRect?.()
    const r = el.getBoundingClientRect?.()
    if (view === undefined || r === undefined) return
    sc.scrollTop += r.top - (view.top - scrollTop)
  }

  const build = (at?: PagePlace) => {
    const root = h.root()
    if (root === null) return
    const model = h.model()
    root.textContent = ''
    els.clear()
    spacerEls = []
    anchor = -1
    const token = ++growing
    const n = model.length
    if (n === 0) return
    if (!windowed) {
      renderRange(0, n - 1)
      return
    }
    const i = at === undefined ? -1 : model.indexOf(at.blockId)
    // A screenful first, then the rest of the window a part a task: never one long task for the
    // page to show (a slow device draws 120 paragraphs in more than 50 ms).
    let lo = Math.max(0, i - 3)
    let hi = Math.min(n, (i < 0 ? 0 : lo) + FIRST_STEP) - 1
    renderRange(lo, hi)
    if (at !== undefined && i >= 0) {
      scrollTo(at.blockId, at.scrollTop)
      anchor = i
    }
    const from = i < 0 ? 0 : i - SIDE
    const to = i < 0 ? FIRST_WINDOW - 1 : i + SIDE
    const grow = () => {
      if (h.root() === null || h.model() !== model || token !== growing) return
      if (lo <= Math.max(0, from) && hi >= Math.min(n - 1, to)) return
      // Not under a composition in the one host (its spacers are in the editing host): later.
      if (h.still()) {
        setTimeout(grow, 32)
        return
      }
      hi = Math.min(n - 1, to, hi + FIRST_STEP)
      lo = Math.max(0, from, lo - FIRST_STEP)
      renderRange(lo, hi)
      void taskPace.yield().then(grow)
    }
    // Behind what the page has queued (the board's opening beside it), not ahead of it.
    void taskPace.yield().then(grow)
  }

  const placeOf = (caret: { blockId: string; offset: number } | null): PagePlace | null => {
    const sc = h.scroller()
    if (sc === null || sc === undefined || h.root() === null) return null
    const view = sc.getBoundingClientRect?.()
    if (view === undefined) return null
    const on = (el: HTMLElement | undefined) => {
      const r = el?.getBoundingClientRect()
      return r !== undefined && r.bottom > view.top && r.top < view.bottom ? r : null
    }
    const mine = caret === null ? null : on(els.get(caret.blockId))
    if (caret !== null && mine !== null)
      return { blockId: caret.blockId, offset: caret.offset, scrollTop: view.top - mine.top }
    const pin = pinOf(() => true)
    const id = pin?.el.dataset.id
    if (pin === null || id === undefined) return null
    return { blockId: id, offset: 0, scrollTop: view.top - pin.top }
  }

  return {
    els,
    makeEl,
    insertEl,
    neighbourShown,
    layout,
    renderRange,
    ensureRendered,
    build,
    scrollTo,
    placeOf,
    pin() {
      const model = h.model()
      for (const id of h.keep()) {
        if (els.has(id)) continue
        const i = model.indexOf(id)
        const b = model.at(i)
        if (b !== undefined) insertEl(b, i)
      }
      layout()
    },
    attach() {
      const sc = h.scroller()
      const root = h.root()
      if (!windowed || !sc || root === null) return () => {}
      sc.addEventListener('scroll', onScroll, { passive: true })
      let width: number | null = null
      const ro =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver((entries) => {
              h.resized()
              changed()
              let w: number | undefined
              for (const e of entries ?? []) if (e.target !== sc) w = e.contentRect.width
              if (w === undefined) return
              if (width !== null && Math.abs(w - width) >= 1) again()
              width = w
            })
      ro?.observe(root)
      // The scroller too: the margin the prompts are drawn in is its width's.
      ro?.observe(sc)
      const fonts = (
        document as { fonts?: EventTarget & { forEach?(fn: (f: Face) => void): void } }
      ).fonts
      fonts?.addEventListener('loadingdone', onFonts)
      // WebKit fires no `loadingdone`: each face not in yet tells by its own promise,
      // through the page's registry (`watchFace`): this window is told while it is live, and
      // nothing of it stays on a face once it is not.
      liveWindows.add(fontsIn)
      fonts?.forEach?.(watchFace)
      return () => {
        liveWindows.delete(fontsIn)
        sc.removeEventListener('scroll', onScroll)
        ro?.disconnect()
        fonts?.removeEventListener('loadingdone', onFonts)
        againDue = false
        if (raf !== 0) cancelAnimationFrame(raf)
        raf = 0
      }
    },
    unstill() {
      if (againDue) again()
      if (placeDue) changed()
    },
    changed,
    reflow,
    liveBlocks,
    onLayout(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    clear() {
      growing++
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      listeners.clear()
      els.clear()
      spacerEls = []
    },
  }
}
