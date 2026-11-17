import {
  applySplices,
  mapMarks as coreMapMarks,
  normalizeMarks as coreNormalize,
  LIMITS,
  sliceMarks,
  subtractMarks,
} from '@papertie/core'
import { footnoteOf as footnoteOfMark } from '../footnotes/marks'
import type {
  EditorBlock,
  EditorChange,
  EditorImage,
  EditorKind,
  EditorMark,
  EditorSplice,
} from './BookEditor'

/**
 * The writer's book as its engine keeps it beside the page (ADR-0007), and the editor commands
 * (split, merge, paste, a cross-block delete, a mark or a kind over a selection) stated as
 * `EditorChange`s. A change is applied here exactly as core applies its op (`book/splice.ts`'s
 * marks rule), so the page and the board never drift apart.
 *
 * Blocks are kept in chunks with their sums (the heights of blocks off the page, the chapters), so
 * a structural change, a block's place or the height of a run of blocks costs the chunks (some 470
 * at `maxBlocksPerBook`) and one chunk, never the book. A block's height is estimated from its
 * text until the page has drawn it, then measured (`measure`). Blocks are immutable: a
 * change puts a new one in the old one's place (the board's own blocks are kept as given).
 */

export type Block = EditorBlock

export interface Pos {
  blockId: string
  offset: number
}

/** The text's measure (px): a figure's image is this wide (`writer.css`, `.bk-book`). */
export const FIGURE_MEASURE = 576
/** A figure's aspect (width / height) when its asset is not known (yet). */
export const DEFAULT_ASPECT = 3 / 2

/**
 * A block's estimated height (px) while it is not on the page: the body's 27 px lines. A figure
 * is its image at the measure by its aspect and its caption's lines; a prompt or a footnote in
 * the margin (`inMargin`) takes no height in the text column, inline it is its own lines.
 */
export function estimate(b: Block, inMargin = false): number {
  switch (b.kind) {
    case 'h1':
      return 96
    case 'h2':
      return 56
    case 'prompt':
      return inMargin ? 0 : 23 * Math.max(1, Math.ceil(b.text.length / 84)) + 21
    case 'footnote':
      return inMargin ? 0 : 20 * Math.max(1, Math.ceil(b.text.length / 96)) + 6
    case 'figure': {
      const aspect = b.image?.aspect ?? DEFAULT_ASPECT
      const image = Math.round(FIGURE_MEASURE / (aspect > 0 ? aspect : DEFAULT_ASPECT))
      return image + 22 * Math.max(1, Math.ceil(b.text.length / 90)) + 44
    }
    default:
      return 27 * Math.max(1, Math.ceil(b.text.length / 78)) + (b.kind === 'li' ? 6 : 15)
  }
}

/** A block as the model is given it: a figure's image may come without its aspect (core's). */
export type BlockIn = EditorBlock

export interface ModelOptions {
  /** A figure's aspect from its asset (the board's `assets`), when its block has none. */
  aspectOf?: (assetId: string) => number | undefined
}

/** Marks sorted, same-type overlaps and neighbours joined, empty ones dropped, within `len`. */
export function normalizeMarks(marks: readonly EditorMark[], len: number): EditorMark[] {
  return coreNormalize(
    marks.map((m) => ({ t: m.t, from: Math.max(0, m.from), to: Math.min(len, m.to) })),
  )
}

/** Marks carried through one splice, as core carries them. */
export function mapMarks(marks: readonly EditorMark[], s: EditorSplice): EditorMark[] {
  return coreMapMarks(marks, [s])
}

/** `a` → `b` as marks to remove and to add, or null when they are equal. */
export function diffMarks(
  a: readonly EditorMark[],
  b: readonly EditorMark[],
): { addMarks: EditorMark[]; removeMarks: EditorMark[] } | null {
  const key = (ms: readonly EditorMark[]) => ms.map((m) => `${m.t}${m.from}-${m.to}`).join(',')
  if (key(a) === key(b)) return null
  return { addMarks: subtractMarks(b, a), removeMarks: subtractMarks(a, b) }
}

/**
 * `a` → `b` as one splice: the common prefix and suffix kept. `caret`, the caret's offset in `b`
 * after the change, places an ambiguous splice (a key repeated) where it was typed.
 */
export function diffText(a: string, b: string, caret?: number): EditorSplice | null {
  if (a === b) return null
  const min = Math.min(a.length, b.length)
  let s = 0
  while (s < min && a.charCodeAt(s) === b.charCodeAt(s)) s++
  if (caret !== undefined) s = Math.min(s, Math.max(0, caret - Math.max(0, b.length - a.length)))
  // Never split a surrogate pair.
  if (s > 0 && s < a.length && /[\uD800-\uDBFF]/.test(a.charAt(s - 1))) s--
  let e = 0
  while (e < min - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++
  if (e > 0 && /[\uDC00-\uDFFF]/.test(a.charAt(a.length - e))) e--
  return { at: s, del: a.length - s - e, ins: b.slice(s, b.length - e) }
}

const CHUNK = 128

/**
 * The footnotes block `b` anchors (each once): none for a footnote itself, nor for a prompt (a
 * note to the writer, never exported: its anchors count for nothing). O(marks).
 */
export function anchorIds(b: Block): string[] {
  if (b.kind === 'footnote' || b.kind === 'prompt' || b.marks.length === 0) return []
  let out: string[] | null = null
  for (const m of b.marks) {
    const id = footnoteOfMark(m.t)
    if (id === null) continue
    out ??= []
    if (!out.includes(id)) out.push(id)
  }
  return out ?? []
}

interface Chunk {
  blocks: Block[]
  /** Its place in the list of chunks, and its first block's index (valid below `fresh`). */
  i: number
  start: number
  /** The sum of its blocks' estimated heights, and its chapters (`h1`s). */
  h: number
  chapters: number
  /**
   * The footnote anchors of its blocks (each block's footnotes once), those
   * whose footnote is in the book only (an anchor whose footnote is gone counts for nothing).
   */
  anchors: number
}

export class BookModel {
  private chunks: Chunk[] = []
  private where = new Map<string, Chunk>()
  /** The heights the page measured, by block (px, its margin below included). */
  private heights = new Map<string, number>()
  /** The blocks that anchor each footnote (an orphan has none): kept through every change. */
  private anchoredBy = new Map<string, Set<string>>()
  /**
   * The footnotes anchored in more than one block (a paragraph split inside an anchor): few, and
   * the only ones the chunks' sums count more than once (`anchorsBefore` takes them off).
   */
  private multi = new Set<string>()
  /** The book's footnote blocks: an anchor counts only while its footnote is one of them. */
  private notes = new Set<string>()
  /** Chunks below this one have their `start` right. */
  private fresh = 0
  private n = 0

  /** Prompts and footnotes drawn in the margin (no height in the text column), or inline. */
  private margin = false
  private readonly aspectOf: (assetId: string) => number | undefined

  constructor(blocks: readonly BlockIn[], o: ModelOptions = {}) {
    this.aspectOf = o.aspectOf ?? (() => undefined)
    this.reset(blocks)
  }

  /** O(book) in one go: the chunks and the ids' places (a mount of a short book, a test). */
  reset(blocks: readonly BlockIn[]): void {
    const parts: BlockIn[][] = []
    for (let i = 0; i < blocks.length; i += CHUNK) parts.push(blocks.slice(i, i + CHUNK))
    const steps = this.fill(parts)
    while (!steps.next().done) {}
  }

  /**
   * The model of a book given in chunks (core's block index: 1 to 256 blocks each, taken as they
   * are), built a step at a time: each step yields after about 1,024 blocks, so a writer opening
   * a book of `maxBlocksPerBook` paragraphs can build it between frames (`writer.ts`).
   */
  static *build(
    chunks: readonly (readonly BlockIn[])[],
    o: ModelOptions = {},
  ): Generator<void, BookModel> {
    const m = new BookModel([], o)
    yield* m.fill(chunks)
    return m
  }

  /** A block's height: as the page measured it, else as estimated from its text. */
  private hOf(b: Block): number {
    if (this.margin && aside(b)) return 0
    return this.heights.get(b.id) ?? estimate(b, this.margin)
  }

  /** A figure's image with its aspect: the block's own, else its asset's, else the default. */
  private imageOf(image: BlockIn['image']): EditorImage | undefined {
    if (image === undefined) return undefined
    const aspect = image.aspect ?? this.aspectOf(image.assetId) ?? DEFAULT_ASPECT
    return {
      assetId: image.assetId,
      ...(image.card === undefined ? {} : { card: image.card }),
      aspect,
    }
  }

  /** `b` as the model keeps it: a figure's image with its aspect (any other block as given). */
  private kept(b: BlockIn): Block {
    if (b.image === undefined || b.image.aspect !== undefined) return b as Block
    return { ...b, image: this.imageOf(b.image) } as Block
  }

  /** Whether prompts and footnotes are drawn in the margin. */
  get asidesInMargin(): boolean {
    return this.margin
  }

  /** The margin's notes to it or inline: every block estimated again (O(book), once a switch). */
  setAsidesInMargin(on: boolean): boolean {
    if (on === this.margin) return false
    this.margin = on
    this.reestimate()
    return true
  }

  /**
   * Every block estimated again, the measured heights let go (another layout: a width, the fonts,
   * the prompts' place). O(book), once a change.
   */
  reestimate(): void {
    this.heights.clear()
    for (const c of this.chunks) {
      let h = 0
      for (const b of c.blocks) h += this.hOf(b)
      c.h = h
    }
  }

  private chunkOf(blocks: Block[], i: number): Chunk {
    let h = 0
    let chapters = 0
    let anchors = 0
    for (const b of blocks) {
      h += this.hOf(b)
      if (b.kind === 'h1') chapters++
      anchors += this.live(b)
    }
    return { blocks, i, start: 0, h, chapters, anchors }
  }

  /** How many footnotes block `b` anchors that are in the book (each once). O(marks). */
  private live(b: Block): number {
    if (b.marks.length === 0) return 0
    let n = 0
    for (const id of anchorIds(b)) if (this.notes.has(id)) n++
    return n
  }

  /** Footnote `id` came (1) or went (-1): the chunks of the blocks anchoring it count it so. */
  private noteCounts(id: string, sign: 1 | -1): void {
    for (const by of this.anchoredBy.get(id) ?? []) {
      const c = this.where.get(by)
      if (c !== undefined) c.anchors += sign
    }
  }

  /** Whether footnote `id` is in the book: its anchors count only then. */
  isFootnote(id: string): boolean {
    return this.notes.has(id)
  }

  /** The blocks that anchor footnote `id` (none: an orphan). */
  anchoring(id: string): readonly string[] {
    return [...(this.anchoredBy.get(id) ?? [])]
  }

  /** Block `b`'s anchors (its footnotes once each), counted in (1) or out (-1) of the index. */
  private anchorsOf(b: Block, sign: 1 | -1): number {
    const ids = anchorIds(b)
    for (const id of ids) {
      let by = this.anchoredBy.get(id)
      if (sign > 0) {
        if (by === undefined) {
          by = new Set()
          this.anchoredBy.set(id, by)
        }
        by.add(b.id)
      } else if (by !== undefined) {
        by.delete(b.id)
        if (by.size === 0) this.anchoredBy.delete(id)
      }
      if ((by?.size ?? 0) > 1) this.multi.add(id)
      else this.multi.delete(id)
    }
    return ids.length
  }

  /** Whether some block anchors footnote `id` (one that none does is an orphan). */
  anchored(id: string): boolean {
    return this.anchoredBy.has(id)
  }

  /**
   * The index of the first block anchoring footnote `id`, where it is numbered; -1 for an orphan.
   * O(the blocks anchoring it), one for all but a split anchor's.
   */
  firstAnchor(id: string): number {
    let first = -1
    for (const b of this.anchoredBy.get(id) ?? []) {
      const i = this.indexOf(b)
      if (i >= 0 && (first < 0 || i < first)) first = i
    }
    return first
  }

  /** Whether footnote `id` is anchored in more than one block. */
  anchoredTwice(id: string): boolean {
    return this.multi.has(id)
  }

  /**
   * The footnotes numbered before index `i`: each counted once, at its first anchor. The chunks'
   * sums count a footnote once per block anchoring it, so a footnote anchored in `k` blocks before
   * `i` is taken off `k - 1` times: O(chunks + one chunk + the footnotes anchored twice).
   */
  anchorsBefore(i: number): number {
    const l = this.locate(Math.min(i, this.n - 1))
    if (l === null) return 0
    let n = 0
    for (let k = 0; k < l.c.i; k++) n += (this.chunks[k] as Chunk).anchors
    const end = i >= this.n ? l.c.blocks.length : l.at
    for (let k = 0; k < end; k++) n += this.live(l.c.blocks[k] as Block)
    for (const id of this.multi) {
      if (!this.notes.has(id)) continue
      let before = 0
      for (const b of this.anchoredBy.get(id) ?? []) {
        const at = this.indexOf(b)
        if (at >= 0 && at < i) before++
      }
      if (before > 1) n -= before - 1
    }
    return n
  }

  private *fill(parts: readonly (readonly BlockIn[])[]): Generator<void, void> {
    this.chunks = []
    this.where = new Map()
    this.heights = new Map()
    this.anchoredBy = new Map()
    this.multi = new Set()
    this.notes = new Set()
    this.n = 0
    this.fresh = 0
    // The footnotes first: a paragraph's anchors are counted as its chunk is made, before the
    // footnotes after it come.
    for (const part of parts) for (const b of part) if (b.kind === 'footnote') this.notes.add(b.id)
    let since = 0
    for (const part of parts) {
      if (part.length === 0) continue
      const c = this.chunkOf(
        part.map((b) => this.kept(b)),
        this.chunks.length,
      )
      this.chunks.push(c)
      for (const b of c.blocks) {
        this.where.set(b.id, c)
        if (b.marks.length > 0) this.anchorsOf(b, 1)
      }
      this.n += part.length
      since += part.length
      if (since >= 1024) {
        since = 0
        yield
      }
    }
  }

  get length(): number {
    return this.n
  }

  private starts(upTo: number): void {
    for (let k = this.fresh; k <= upTo && k < this.chunks.length; k++) {
      const c = this.chunks[k] as Chunk
      const p = this.chunks[k - 1]
      c.start = p === undefined ? 0 : p.start + p.blocks.length
      this.fresh = k + 1
    }
  }

  /** The chunk holding index `i` (`i` within the book), and `i`'s slot in it. */
  private locate(i: number): { c: Chunk; at: number } | null {
    if (i < 0 || i >= this.n) return null
    this.starts(this.chunks.length - 1)
    let lo = 0
    let hi = this.chunks.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((this.chunks[mid] as Chunk).start <= i) lo = mid
      else hi = mid - 1
    }
    const c = this.chunks[lo] as Chunk
    return { c, at: i - c.start }
  }

  at(i: number): Block | undefined {
    const l = this.locate(i)
    return l === null ? undefined : l.c.blocks[l.at]
  }

  indexOf(id: string): number {
    const c = this.where.get(id)
    if (c === undefined) return -1
    this.starts(c.i)
    return c.start + c.blocks.findIndex((b) => b.id === id)
  }

  get(id: string): Block | undefined {
    return this.where.get(id)?.blocks.find((b) => b.id === id)
  }

  /**
   * Block `id`'s height as the page drew it (px, from its top to the next element's): from now on
   * the spacers stand for it at that height, not the estimate.
   */
  measure(id: string, h: number): void {
    const c = this.where.get(id)
    const b = c?.blocks.find((x) => x.id === id)
    if (c === undefined || b === undefined || !(h > 0) || !Number.isFinite(h)) return
    c.h += h - this.hOf(b)
    this.heights.set(id, h)
  }

  /** Block `id` estimated again (a split or a merge changed its text by much). */
  private unmeasure(id: string): void {
    const c = this.where.get(id)
    const b = c?.blocks.find((x) => x.id === id)
    if (c === undefined || b === undefined || !this.heights.has(id)) return
    const was = this.hOf(b)
    this.heights.delete(id)
    c.h += this.hOf(b) - was
  }

  /**
   * Every block estimated again (the page's width or its fonts changed: a measured height is of
   * another layout). O(book), once a change.
   */
  unmeasureAll(): void {
    if (this.heights.size === 0) return
    this.reestimate()
  }

  /** Whether the page has measured block `id`. */
  measured(id: string): boolean {
    return this.heights.has(id)
  }

  /** The height of blocks `[from, to]`: the chunks between, and the two ends' slots. */
  heightOf(from: number, to: number): number {
    if (to < from) return 0
    const a = this.locate(from)
    const b = this.locate(to)
    if (a === null || b === null) return 0
    if (a.c === b.c) {
      let h = 0
      for (let k = a.at; k <= b.at; k++) h += this.hOf(a.c.blocks[k] as Block)
      return h
    }
    let h = 0
    for (let k = a.at; k < a.c.blocks.length; k++) h += this.hOf(a.c.blocks[k] as Block)
    for (let k = a.c.i + 1; k < b.c.i; k++) h += (this.chunks[k] as Chunk).h
    for (let k = 0; k <= b.at; k++) h += this.hOf(b.c.blocks[k] as Block)
    return h
  }

  /** The chapters (`h1`s) before index `i`. */
  chaptersBefore(i: number): number {
    const l = this.locate(Math.min(i, this.n - 1))
    if (l === null) return 0
    let n = 0
    for (let k = 0; k < l.c.i; k++) n += (this.chunks[k] as Chunk).chapters
    const end = i >= this.n ? l.c.blocks.length : l.at
    for (let k = 0; k < end; k++) if (l.c.blocks[k]?.kind === 'h1') n++
    return n
  }

  /**
   * Block `b`'s place taken by `next` (the same id). Its measured height is kept while its kind
   * is (the page measures it again as it draws it); a new kind is estimated until then.
   */
  private replace(b: Block, next: Block): void {
    const c = this.where.get(b.id)
    if (c === undefined) return
    const k = c.blocks.indexOf(b)
    c.blocks[k] = next
    const was = this.hOf(b)
    if (next.kind !== b.kind) this.heights.delete(b.id)
    c.h += this.hOf(next) - was
    c.chapters += (next.kind === 'h1' ? 1 : 0) - (b.kind === 'h1' ? 1 : 0)
    if (b.marks.length > 0 || next.marks.length > 0) {
      // Out first: the same id goes back in.
      c.anchors += this.live(next) - this.live(b)
      this.anchorsOf(b, -1)
      this.anchorsOf(next, 1)
    }
  }

  /** `b` put in at index `i` (0 to `length`). */
  private insert(i: number, b: Block): void {
    this.anchorsOf(b, 1)
    if (this.chunks.length === 0) {
      if (b.kind === 'footnote') this.notes.add(b.id)
      const c = this.chunkOf([b], 0)
      this.chunks.push(c)
      this.where.set(b.id, c)
      this.n = 1
      this.fresh = 0
      return
    }
    const l = i >= this.n ? null : this.locate(i)
    const c = l?.c ?? (this.chunks[this.chunks.length - 1] as Chunk)
    const at = l?.at ?? c.blocks.length
    c.blocks.splice(at, 0, b)
    c.h += this.hOf(b)
    if (b.kind === 'h1') c.chapters++
    c.anchors += this.live(b)
    this.where.set(b.id, c)
    // A footnote come (back): the anchors naming it count from now on.
    if (b.kind === 'footnote' && !this.notes.has(b.id)) {
      this.notes.add(b.id)
      this.noteCounts(b.id, 1)
    }
    this.n++
    this.fresh = Math.min(this.fresh, c.i + 1)
    if (c.blocks.length > 2 * CHUNK) {
      const tail = this.chunkOf(c.blocks.splice(CHUNK), c.i + 1)
      c.h -= tail.h
      c.chapters -= tail.chapters
      c.anchors -= tail.anchors
      for (const t of tail.blocks) this.where.set(t.id, tail)
      this.chunks.splice(c.i + 1, 0, tail)
      for (let k = c.i + 2; k < this.chunks.length; k++) (this.chunks[k] as Chunk).i = k
      this.fresh = Math.min(this.fresh, c.i + 1)
    }
  }

  /** The block at index `i` taken out. */
  private remove(i: number): Block | undefined {
    const l = this.locate(i)
    if (l === null) return undefined
    const { c, at } = l
    const [b] = c.blocks.splice(at, 1) as [Block]
    c.h -= this.hOf(b)
    if (b.kind === 'h1') c.chapters--
    c.anchors -= this.live(b)
    this.anchorsOf(b, -1)
    // A footnote gone: the anchors naming it count for nothing from now on.
    if (b.kind === 'footnote' && this.notes.delete(b.id)) this.noteCounts(b.id, -1)
    this.where.delete(b.id)
    this.heights.delete(b.id)
    this.n--
    this.fresh = Math.min(this.fresh, c.i + 1)
    if (c.blocks.length === 0) {
      this.chunks.splice(c.i, 1)
      for (let k = c.i; k < this.chunks.length; k++) (this.chunks[k] as Chunk).i = k
      this.fresh = Math.min(this.fresh, c.i)
    }
    return b
  }

  /** Apply one change; false when it names a block the model does not hold (or cannot apply). */
  apply(c: EditorChange): boolean {
    switch (c.t) {
      case 'edit': {
        const b = this.get(c.id)
        if (b === undefined) return false
        let text: string
        try {
          text = applySplices(b.text, c.splices)
        } catch {
          return false
        }
        let marks = coreMapMarks(b.marks, c.splices)
        if (c.removeMarks) marks = subtractMarks(marks, coreNormalize(c.removeMarks))
        if (c.addMarks) marks = coreNormalize([...marks, ...c.addMarks])
        this.replace(b, { ...b, text, marks: normalizeMarks(marks, text.length) })
        return true
      }
      case 'split': {
        const i = this.indexOf(c.id)
        const b = this.at(i)
        if (b === undefined || c.at > b.text.length || this.where.has(c.newId)) return false
        const end = b.text.length
        this.unmeasure(b.id)
        if (b.kind === 'figure' || c.kind === 'figure') return false
        if (b.kind === 'footnote' || c.kind === 'footnote') return false
        this.replace(this.get(b.id) as Block, {
          ...b,
          text: b.text.slice(0, c.at),
          marks: sliceMarks(b.marks, 0, c.at, 0),
        })
        this.insert(i + 1, {
          id: c.newId,
          kind: c.kind,
          text: b.text.slice(c.at),
          marks: sliceMarks(b.marks, c.at, end, -c.at),
        })
        return true
      }
      case 'merge': {
        const from = this.get(c.from)
        const into = this.get(c.into)
        if (from === undefined || into === undefined || from === into) return false
        if (from.kind === 'figure' || into.kind === 'figure') return false
        if (from.kind === 'footnote' || into.kind === 'footnote') return false
        const at = into.text.length
        this.unmeasure(into.id)
        this.replace(this.get(into.id) as Block, {
          ...into,
          text: into.text + from.text,
          marks: coreNormalize([...into.marks, ...sliceMarks(from.marks, 0, from.text.length, at)]),
        })
        this.remove(this.indexOf(c.from))
        return true
      }
      case 'kind': {
        const b = this.get(c.id)
        if (b === undefined) return false
        if ((b.kind === 'figure') !== (c.kind === 'figure')) return false
        if ((b.kind === 'footnote') !== (c.kind === 'footnote')) return false
        if (b.kind !== c.kind) this.replace(b, { ...b, kind: c.kind })
        return true
      }
      case 'image': {
        const b = this.get(c.id)
        if (b === undefined || b.kind !== 'figure') return false
        this.unmeasure(b.id)
        this.replace(this.get(b.id) as Block, { ...b, image: this.imageOf(c.image) })
        return true
      }
      case 'create': {
        if (this.where.has(c.id)) return false
        const at = c.after === null ? 0 : this.indexOf(c.after) + 1
        if (c.after !== null && at === 0) return false
        this.insert(at, {
          id: c.id,
          kind: c.kind,
          text: c.text,
          marks: normalizeMarks(c.marks ?? [], c.text.length),
          ...(c.image === undefined ? {} : { image: this.imageOf(c.image) }),
        })
        return true
      }
      case 'delete': {
        const i = this.indexOf(c.id)
        if (i < 0) return false
        this.remove(i)
        return true
      }
    }
  }

  /** Every block, in order (O(book): a test's, a copy's). */
  snapshot(): EditorBlock[] {
    return this.chunks.flatMap((c) =>
      c.blocks.map((b) => ({
        id: b.id,
        kind: b.kind,
        text: b.text,
        marks: b.marks.map((m) => ({ ...m })),
        ...(b.image === undefined ? {} : { image: { ...b.image } }),
      })),
    )
  }
}

// --- Commands: what a key, a paste or a cut does, as changes against the model. ---------------

/** Whether a block may be merged with another: a figure and a footnote never are. */
const whole = (b: Block | undefined) =>
  b !== undefined && b.kind !== 'figure' && b.kind !== 'footnote'

/** A block beside the text of the block before it: a prompt or a footnote. */
export const aside = (b: Block | undefined) => b?.kind === 'prompt' || b?.kind === 'footnote'

/**
 * The changes that delete `[a, b)` (a before b), and where the caret lands. The blocks between the
 * ends go (a figure among them whole); the ends are joined, unless one is a figure: a figure is
 * never merged, so its caption is trimmed and it stays. A footnote among the blocks that go takes
 * its anchors with it, in the same change (first, while the marks are where they are), so no anchor is left naming a footnote the book no longer has.
 */
export function deleteRange(model: BookModel, a: Pos, b: Pos): EditorChange[] {
  if (a.blockId === b.blockId) {
    if (b.offset <= a.offset) return []
    return [
      { t: 'edit', id: a.blockId, splices: [{ at: a.offset, del: b.offset - a.offset, ins: '' }] },
    ]
  }
  const ia = model.indexOf(a.blockId)
  const ib = model.indexOf(b.blockId)
  const first = model.at(ia) as Block
  const out: EditorChange[] = []
  const gone = new Set<string>()
  for (let i = ia + 1; i < ib; i++) gone.add((model.at(i) as Block).id)
  for (const id of gone) {
    if (!model.isFootnote(id)) continue
    const t = `n:${id}`
    for (const by of model.anchoring(id)) {
      if (gone.has(by)) continue
      const marks = (model.get(by)?.marks ?? []).filter((m) => m.t === t)
      if (marks.length > 0)
        out.push({ t: 'edit', id: by, splices: [], removeMarks: marks.map((m) => ({ ...m })) })
    }
  }
  if (first.text.length > a.offset)
    out.push({
      t: 'edit',
      id: a.blockId,
      splices: [{ at: a.offset, del: first.text.length - a.offset, ins: '' }],
    })
  if (b.offset > 0)
    out.push({ t: 'edit', id: b.blockId, splices: [{ at: 0, del: b.offset, ins: '' }] })
  for (let i = ia + 1; i < ib; i++) out.push({ t: 'delete', id: (model.at(i) as Block).id })
  const last = model.at(ib) as Block
  if (whole(first) && whole(last)) out.push({ t: 'merge', from: b.blockId, into: a.blockId })
  return out
}

/**
 * Enter at `at` ("it should default to paragraph"):
 * - A quote or a prompt: at its end, a paragraph after it; empty, it becomes a paragraph; in the
 *   middle, two of the kind (the head keeps its id).
 * - A list item goes on as one; an empty one ends the list as a paragraph.
 * - A heading's tail is a paragraph; a paragraph's, a paragraph.
 * - A figure's caption (never split) only at its end: a paragraph after the figure.
 * At a block's end with footnotes or prompts after it (they annotate it), the new block goes
 * after the last of them, so a paragraph's footnotes stay right after it.
 * The caret goes to the start of the block the changes make, or stays where an empty block took
 * a paragraph's kind: {@link enterCaret}.
 */
export function splitAt(model: BookModel, at: Pos, newId: string): EditorChange[] {
  const b = model.get(at.blockId)
  if (b === undefined) return []
  if (b.kind === 'figure' && at.offset < b.text.length) return []
  // An empty quote, prompt or list item: a paragraph.
  if (b.text === '' && (b.kind === 'quote' || b.kind === 'prompt' || b.kind === 'li'))
    return [{ t: 'kind', id: b.id, kind: 'p' }]
  const end = at.offset >= b.text.length
  const kind: EditorKind =
    b.kind === 'h1' || b.kind === 'h2' || b.kind === 'figure'
      ? 'p'
      : end && (b.kind === 'quote' || b.kind === 'prompt')
        ? 'p'
        : b.kind
  if (!end) return [{ t: 'split', id: b.id, at: at.offset, newId, kind }]
  // At the end: a block of its own after the asides that follow (a prompt's own block too).
  const i = model.indexOf(b.id)
  let after = b.id
  for (let j = i + 1; aside(model.at(j)); j++) after = (model.at(j) as Block).id
  if (after === b.id && b.kind !== 'figure')
    return [{ t: 'split', id: b.id, at: at.offset, newId, kind }]
  return [{ t: 'create', id: newId, after, kind, text: '' }]
}

/** Where the caret goes after `splitAt`'s changes: in the new block, or the one made a paragraph. */
export function enterCaret(changes: readonly EditorChange[], at: Pos, newId: string): Pos {
  return changes[0]?.t === 'kind'
    ? { blockId: at.blockId, offset: 0 }
    : { blockId: newId, offset: 0 }
}

/**
 * The block a text block at index `i` joins with, before it (`dir` -1) or after it (+1): its
 * neighbour, past the prompts beside the text when the block is not a prompt itself (a paragraph
 * never runs into a note in the margin). Undefined at the book's edge.
 */
export function joinTarget(model: BookModel, i: number, dir: -1 | 1): Block | undefined {
  const b = model.at(i)
  if (b === undefined) return undefined
  let j = i + dir
  if (b.kind !== 'prompt') while (aside(model.at(j))) j += dir
  return model.at(j)
}

/**
 * Backspace at a block's start: it joins the block before it (past the prompts beside it), which
 * keeps its id. Never into or out of a figure.
 */
export function mergeBack(model: BookModel, id: string): EditorChange[] {
  const i = model.indexOf(id)
  const into = i <= 0 ? undefined : joinTarget(model, i, -1)
  if (!whole(into) || !whole(model.at(i))) return []
  return [{ t: 'merge', from: id, into: (into as Block).id }]
}

/** Delete at a block's end: the block after it (past the prompts beside it) joins this one. */
export function mergeForward(model: BookModel, id: string): EditorChange[] {
  const i = model.indexOf(id)
  const next = i < 0 ? undefined : joinTarget(model, i, 1)
  if (!whole(next) || !whole(model.at(i))) return []
  return [{ t: 'merge', from: (next as Block).id, into: id }]
}

/** A pasted block: its kind (null: the paragraph's it lands in), text and marks. */
export interface Piece {
  kind: EditorKind | null
  text: string
  marks: EditorMark[]
}

/** Where `text` may be cut at or before `at`: never between the two halves of a surrogate pair. */
const cutAt = (text: string, at: number) => {
  const c = text.charCodeAt(at - 1)
  return at > 0 && at < text.length && c >= 0xd800 && c <= 0xdbff ? at - 1 : at
}

/**
 * `pieces` cut where they would make a paragraph longer than one can be (`maxBlockText`), landing
 * after `head` characters of a block with `tail` after them: the first takes what fits after the
 * head, each further one at most a paragraph's worth, and the tail goes on in a paragraph of its
 * own when it would not fit after the last. Each cut keeps its piece's kind and marks.
 */
export function fitPieces(pieces: readonly Piece[], head: number, tail: number): Piece[] {
  const most = LIMITS.maxBlockText
  const out: Piece[] = []
  for (const p of pieces) {
    let from = 0
    for (;;) {
      const room = out.length === 0 ? Math.max(0, most - head) : most
      if (p.text.length - from <= room) break
      const to = cutAt(p.text, from + room)
      out.push({
        kind: p.kind,
        text: p.text.slice(from, to),
        marks: sliceMarks(p.marks, from, to, -from),
      })
      from = to
    }
    out.push(
      from === 0
        ? p
        : {
            kind: p.kind,
            text: p.text.slice(from),
            marks: sliceMarks(p.marks, from, p.text.length, -from),
          },
    )
  }
  const last = out[out.length - 1] as Piece
  const end = (out.length === 1 ? head : 0) + last.text.length + tail
  if (end > most) out.push({ kind: null, text: '', marks: [] })
  return out
}

/**
 * `pieces` inserted at `at`: one is an edit (its marks added); several are an edit (the first,
 * the block's tail cut off) and a `create` for each further piece, the last carrying the tail. A
 * first piece of its own kind landing in an empty block gives the block its kind. Pieces that
 * would make a paragraph longer than one can be are cut into paragraphs that fit ({@link fitPieces}).
 */
export function insertPieces(
  model: BookModel,
  at: Pos,
  given: readonly Piece[],
  newId: () => string,
): { changes: EditorChange[]; caret: Pos } {
  const b = model.get(at.blockId)
  const pieces = b === undefined ? given : fitPieces(given, at.offset, b.text.length - at.offset)
  const first = pieces[0]
  if (b === undefined || first === undefined) return { changes: [], caret: at }
  const shift = (ms: readonly EditorMark[], by: number) =>
    ms.map((m) => ({ t: m.t, from: m.from + by, to: m.to + by }))
  const changes: EditorChange[] = []
  const own = b.text === '' && first.kind !== null && first.kind !== b.kind
  if (pieces.length === 1) {
    changes.push({
      t: 'edit',
      id: b.id,
      splices: [{ at: at.offset, del: 0, ins: first.text }],
      ...(first.marks.length > 0 ? { addMarks: shift(first.marks, at.offset) } : {}),
    })
    if (own) changes.push({ t: 'kind', id: b.id, kind: first.kind as EditorKind })
    return { changes, caret: { blockId: b.id, offset: at.offset + first.text.length } }
  }
  const tail = b.text.slice(at.offset)
  const tailMarks = sliceMarks(b.marks, at.offset, b.text.length, -at.offset)
  changes.push({
    t: 'edit',
    id: b.id,
    splices: [{ at: at.offset, del: tail.length, ins: first.text }],
    ...(first.marks.length > 0 ? { addMarks: shift(first.marks, at.offset) } : {}),
  })
  if (own) changes.push({ t: 'kind', id: b.id, kind: first.kind as EditorKind })
  let after = b.id
  const plain: EditorKind = b.kind === 'h1' || b.kind === 'h2' ? 'p' : b.kind
  for (let i = 1; i < pieces.length; i++) {
    const p = pieces[i] as Piece
    const id = newId()
    const last = i === pieces.length - 1
    const marks = last ? [...p.marks, ...shift(tailMarks, p.text.length)] : p.marks
    changes.push({
      t: 'create',
      id,
      after,
      kind: p.kind ?? plain,
      text: last ? p.text + tail : p.text,
      ...(marks.length > 0 ? { marks } : {}),
    })
    after = id
  }
  const lastText = (pieces[pieces.length - 1] as Piece).text
  return { changes, caret: { blockId: after, offset: lastText.length } }
}

/**
 * Plain text inserted at `at`: one line is an edit; several are an edit (the first line, the
 * block's tail cut off) and a `create` for each further line, the last carrying the tail.
 */
export function insertText(
  model: BookModel,
  at: Pos,
  text: string,
  newId: () => string,
): { changes: EditorChange[]; caret: Pos } {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\t/g, ' '))
  const paras = lines.length === 1 ? lines : lines.filter((l) => l.trim() !== '')
  return insertPieces(
    model,
    at,
    paras.map((t) => ({ kind: null, text: t, marks: [] })),
    newId,
  )
}

/**
 * ⌘B / ⌘I (and the popover's Bold and Italic) over `[a, b)`, across blocks too: removed when all
 * of it has the mark, else added to all of it.
 */
export function toggleMark(model: BookModel, a: Pos, b: Pos, t: 'b' | 'i'): EditorChange[] {
  const runs = runsOf(model, a, b)
  if (runs.length === 0) return []
  const covered = runs.every(({ block, from, to }) =>
    block.marks.some((m) => m.t === t && m.from <= from && m.to >= to),
  )
  return runs.map(({ block, from, to }) => ({
    t: 'edit',
    id: block.id,
    splices: [],
    ...(covered ? { removeMarks: [{ t, from, to }] } : { addMarks: [{ t, from, to }] }),
  }))
}

/** Whether all of `[a, b)` has mark `t`. */
export function marked(model: BookModel, a: Pos, b: Pos, t: 'b' | 'i'): boolean {
  const runs = runsOf(model, a, b)
  return (
    runs.length > 0 &&
    runs.every(({ block, from, to }) =>
      block.marks.some((m) => m.t === t && m.from <= from && m.to >= to),
    )
  )
}

/** The blocks from `a`'s to `b`'s set to `kind` (those not already; a figure stays a figure). */
export function setKind(model: BookModel, a: Pos, b: Pos, kind: EditorKind): EditorChange[] {
  const out: EditorChange[] = []
  if (kind === 'figure' || kind === 'footnote') return out
  const ia = model.indexOf(a.blockId)
  const ib = model.indexOf(b.blockId)
  for (let i = ia; i >= 0 && i <= ib; i++) {
    const blk = model.at(i) as Block
    if (blk.kind !== kind && blk.kind !== 'figure' && blk.kind !== 'footnote')
      out.push({ t: 'kind', id: blk.id, kind })
  }
  return out
}

/** The non-empty runs of text `[a, b)` covers, a run a block. */
function runsOf(
  model: BookModel,
  a: Pos,
  b: Pos,
): Array<{ block: Block; from: number; to: number }> {
  const ia = model.indexOf(a.blockId)
  const ib = model.indexOf(b.blockId)
  const out: Array<{ block: Block; from: number; to: number }> = []
  for (let i = ia; i >= 0 && i <= ib; i++) {
    const block = model.at(i) as Block
    const from = i === ia ? a.offset : 0
    const to = i === ib ? b.offset : block.text.length
    if (to > from) out.push({ block, from, to })
  }
  return out
}

/** The blocks of `[a, b)`, cut to it: what a copy takes. */
export function piecesOf(model: BookModel, a: Pos, b: Pos): Block[] {
  return runsOf(model, a, b).map(({ block, from, to }) => ({
    id: block.id,
    kind: block.kind,
    text: block.text.slice(from, to),
    marks: sliceMarks(block.marks, from, to, -from),
  }))
}

/** The text of `[a, b)` across blocks, a newline between blocks. */
export function textOf(model: BookModel, a: Pos, b: Pos): string {
  const ia = model.indexOf(a.blockId)
  const ib = model.indexOf(b.blockId)
  if (ia === ib) return model.at(ia)?.text.slice(a.offset, b.offset) ?? ''
  const parts = [model.at(ia)?.text.slice(a.offset) ?? '']
  for (let i = ia + 1; i < ib; i++) parts.push(model.at(i)?.text ?? '')
  parts.push(model.at(ib)?.text.slice(0, b.offset) ?? '')
  return parts.join('\n')
}
