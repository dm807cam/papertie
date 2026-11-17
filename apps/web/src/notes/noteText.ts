import { textWidthEm } from './greek'

/** The title size, px; titles that would run past two lines at it step down (`isLongTitle`). */
export const TITLE_PX = 30

/** One rendered block of a note's plain text. */
export interface NoteBlock {
  kind: 'title' | 'subtitle' | 'bullet' | 'body'
  text: string
}

const BULLET = /^\s*[-•]\s*(.*)$/
const LATIN_ONLY = /^[\p{Script=Latin}\p{Nd}\s.,:;!?'"’‘“”&()[\]/–—-]+$/u
const HAS_LATIN = /\p{Script=Latin}/u

/** Whether `line` is Latin letters with digits, spaces and basic punctuation only (no other script). */
export function isLatinOnly(line: string): boolean {
  return LATIN_ONLY.test(line) && HAS_LATIN.test(line)
}

/**
 * What one line of a note's text is in the rendering: a title, subtitle, bullet or body line, or
 * a gap (a blank line the rendering drops: before the title, or at the edge of a body block).
 */
export type LineRole = 'title' | 'subtitle' | 'bullet' | 'body' | 'gap'

/** One line of the text (`\n` line breaks) as the editor sets it. */
export interface EditLine {
  role: LineRole
  /** The line as written. */
  text: string
  /** Where it starts in the text. */
  start: number
  /** A body line that starts its block. */
  blockStart: boolean
  /** A bullet's marker with its spaces ("- ", "• "), which the rendering draws as "•". */
  markLen: number
}

const BLANK = /^\s*$/

/**
 * The lines of `text` with the role each plays in the rendering, by `parseNoteText`'s rules:
 * the first non-empty line is the title, unless it is a bullet; a Latin-only line straight
 * after it is the subtitle; "-" and "•" lines are bullets; runs of other lines are body
 * blocks, whose blank edge lines are gaps.
 */
export function editLines(text: string): EditLine[] {
  const raw = text.split(/\r\n|\r|\n/)
  const out: EditLine[] = []
  let at = 0
  for (const line of raw) {
    out.push({ role: 'gap', text: line, start: at, blockStart: false, markLen: 0 })
    at += line.length + 1
  }
  const lineAt = (i: number) => out[i]?.text ?? ''
  const set = (i: number, role: LineRole) => {
    const l = out[i]
    if (l) l.role = role
  }
  let i = 0
  while (i < out.length && BLANK.test(lineAt(i))) i++
  if (i < out.length && !BULLET.test(lineAt(i))) {
    set(i++, 'title')
    const next = out[i]
    if (next !== undefined && !BULLET.test(next.text) && isLatinOnly(next.text.trim())) {
      set(i++, 'subtitle')
    }
  }
  let body: number[] = []
  const flush = () => {
    let a = 0
    let b = body.length
    while (a < b && BLANK.test(lineAt(body[a] ?? 0))) a++
    while (b > a && BLANK.test(lineAt(body[b - 1] ?? 0))) b--
    for (let k = a; k < b; k++) set(body[k] ?? 0, 'body')
    const first = out[body[a] ?? -1]
    if (a < b && first) first.blockStart = true
    body = []
  }
  for (; i < out.length; i++) {
    const bullet = BULLET.exec(lineAt(i))
    if (bullet === null) body.push(i)
    else {
      flush()
      const l = out[i] as EditLine
      l.role = 'bullet'
      // The regex's spaces after the marker are greedy, so the rest starts with its text.
      l.markLen = l.text.length - (bullet[1] ?? '').length
    }
  }
  flush()
  return out
}

/** A block with where its shown text starts in the note's text, with line breaks as `\n`. */
interface PlacedBlock extends NoteBlock {
  start: number
}

/** `parseNoteText`, each block with its start, from `editLines`. */
function parseBlocks(text: string): PlacedBlock[] {
  const out: PlacedBlock[] = []
  let body: PlacedBlock | null = null
  for (const l of editLines(text)) {
    if (l.role !== 'body' || l.blockStart) body = null
    const lead = l.text.length - l.text.trimStart().length
    if (l.role === 'title' || l.role === 'subtitle') {
      out.push({ kind: l.role, text: l.text.trim(), start: l.start + lead })
    } else if (l.role === 'bullet') {
      out.push({ kind: 'bullet', text: l.text.slice(l.markLen).trim(), start: l.start + l.markLen })
    } else if (l.role === 'body') {
      if (body === null) {
        body = { kind: 'body', text: l.text, start: l.start }
        out.push(body)
      } else body.text += `\n${l.text}`
    }
  }
  return out
}

/**
 * How a note's plain text renders: the first non-empty line is the title, unless it is a
 * bullet; a Latin-only line straight after the title is its subtitle; lines starting with
 * "-" or "•" are bullets; runs of other lines are body blocks with blank edges dropped.
 */
export function parseNoteText(text: string): NoteBlock[] {
  return parseBlocks(text).map(({ kind, text }) => ({ kind, text }))
}

/** A heading-only note (a title, perhaps a subtitle) is set centred. */
export const isHeading = (blocks: readonly NoteBlock[]): boolean =>
  blocks.length > 0 && blocks.every((b) => b.kind === 'title' || b.kind === 'subtitle')

/**
 * Where offset `at` of block `block`'s shown text (as `parseNoteText` gives the blocks) lies in
 * the note's text with `\n` line breaks, as a textarea holds it: the caret for a click on the
 * rendered note. The end of the text for a block that is not there.
 */
export function textOffset(text: string, block: number, at: number): number {
  const end = text.replace(/\r\n?/g, '\n').length
  const b = parseBlocks(text)[block]
  if (b === undefined || !Number.isFinite(at)) return end
  return Math.min(end, b.start + Math.max(0, Math.min(b.text.length, Math.round(at))))
}

/** The long-title size, px (`.note-title--long`). */
export const LONG_TITLE_PX = 21

/** The title face as note.css sets it (`--font-display`, 600). */
const TITLE_FONT = '"Newsreader", "Newsreader Fallback", Georgia, serif'
const TITLE_FAMILY = 'Newsreader'

/** Measured word widths by size and word, once the face that sets them is in. */
const widths = new Map<string, number>()
const WIDTHS_KEPT = 4096
let measurer: OffscreenCanvasRenderingContext2D | null | undefined

type Fonts = EventTarget & { check(font: string, text?: string): boolean }
const fontsOf = (): Fonts | undefined =>
  (globalThis as { document?: { fonts?: Fonts } }).document?.fonts

/**
 * The title face's arrival, for the titles measured before it (in its metric-matched fallback,
 * and not kept): a version that rises once when the face loads after such a measure, which the
 * note view reads, so those titles are set again then. Never per frame; nothing when no title
 * waited.
 */
export const titleFace = (() => {
  let version = 0
  let waiting = false
  let listening: Fonts | null = null
  const subscribers = new Set<() => void>()
  const onLoaded = (e: Event) => {
    const faces = (e as Event & { fontfaces?: readonly { family: string }[] }).fontfaces ?? []
    if (!waiting || !faces.some((f) => f.family.replace(/"/g, '') === TITLE_FAMILY)) return
    waiting = false
    version++
    for (const fn of subscribers) fn()
  }
  return {
    get: () => version,
    subscribe(fn: () => void): () => void {
      const fonts = fontsOf()
      if (fonts !== undefined && listening !== fonts) {
        listening?.removeEventListener('loadingdone', onLoaded)
        fonts.addEventListener('loadingdone', onLoaded)
        listening = fonts
      }
      subscribers.add(fn)
      return () => {
        subscribers.delete(fn)
      }
    },
    /** A title was measured before the face was in. */
    waited() {
      waiting = true
    },
    /** Tests: as on a fresh page. */
    reset() {
      listening?.removeEventListener('loadingdone', onLoaded)
      listening = null
      subscribers.clear()
      waiting = false
      version = 0
      measurer = undefined
      widths.clear()
    },
  }
})()

/**
 * The width of `word` in the title face at `px`: measured with a canvas where
 * there is one (and kept once the face is loaded), else estimated (`textWidthEm`).
 * Asked when a title's text, the note's width or the face's arrival changes, never per frame.
 */
function wordWidthPx(word: string, px: number): number {
  const key = `${px}|${word}`
  const kept = widths.get(key)
  if (kept !== undefined) return kept
  if (measurer === undefined) {
    measurer =
      typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d')
  }
  if (measurer === null) return textWidthEm(word) * px
  const font = `600 ${px}px ${TITLE_FONT}`
  measurer.font = font
  const w = measurer.measureText(word).width
  // Until the face is in, the metric-matched fallback stands in: measured, not kept, and set
  // again when the face comes (`titleFace`).
  if (fontsOf()?.check(font, word)) {
    if (widths.size >= WIDTHS_KEPT) widths.clear()
    widths.set(key, w)
  } else titleFace.waited()
  return w
}

/** The widest word of `title` at `px`, px (a title is set without tracking: note.css). */
function longestWordPx(title: string, px: number): number {
  let widest = 0
  for (const word of title.split(/\s+/)) {
    if (word === '') continue
    const w = wordWidthPx(word, px)
    if (w > widest) widest = w
  }
  return widest
}

/**
 * The title sizes, px: every whole pixel from `TITLE_PX` down to `LONG_TITLE_PX`. A title
 * takes the largest at which its longest word fits (note.css has a class for each).
 */
export const TITLE_STEPS = [30, 29, 28, 27, 26, 25, 24, 23, 22, 21] as const
export type TitleSize = (typeof TITLE_STEPS)[number]

const asSize = (px: number): TitleSize =>
  Math.min(TITLE_PX, Math.max(LONG_TITLE_PX, Math.floor(px))) as TitleSize

/**
 * The size a title is set at in `widthPx` (its measure, `titleWidth`): `LONG_TITLE_PX` when it
 * would wrap past two lines at `TITLE_PX` (a whole sentence on the first line); else the largest
 * of `TITLE_STEPS` at which its longest word fits the measure, so a word never breaks unless it
 * is wider than the measure at the floor. The step is read from the word's own
 * overflow at `TITLE_PX` (its width scales with the size), then checked by measure at that size
 * and the next: two or three cached measures, never a search, and no jump past what the word
 * needs ("Phrasebook" at 22 px, not 21, beside its 30 px neighbours).
 */
export function titleSize(title: string, widthPx: number): TitleSize {
  if (!(widthPx > 0)) return LONG_TITLE_PX
  // 1.9 lines leaves room for a line broken early.
  if (textWidthEm(title) * TITLE_PX > 1.9 * widthPx) return LONG_TITLE_PX
  const fits = (px: number) => longestWordPx(title, px) <= widthPx
  const full = longestWordPx(title, TITLE_PX)
  if (full <= widthPx) return TITLE_PX
  let px = asSize((TITLE_PX * widthPx) / full)
  // A face's widths are near enough linear in the size, not exactly: settle on the step.
  while (px < TITLE_PX - 1 && fits(px + 1)) px++
  while (px > LONG_TITLE_PX && !fits(px)) px--
  return asSize(px)
}

/** Whether a title is set at the long-title size (`titleSize`). */
export function isLongTitle(title: string, widthPx: number): boolean {
  return titleSize(title, widthPx) === LONG_TITLE_PX
}

/**
 * Room the title keeps from a side of the paper that carries an edge pin, beyond its padding, so
 * a title never runs into the pin there (34 px from the paper's edge: 26 + 8 on rustic and smooth paper,
 * 18 + 16 on a print). A side with no pin, and a tag's title (hooked at the top), keep none.
 */
const TITLE_CLEARANCE = { rustic: 8, smooth: 8, print: 16 } as const

/**
 * A title's measure in a note whose text box is `contentWidthPx` wide, keeping the clearance on
 * each side in `sides` (those that carry an edge pin: `EdgeSides`; both when not known).
 */
export function titleWidth(
  contentWidthPx: number,
  style: keyof typeof TITLE_CLEARANCE,
  tag: boolean,
  sides: string = 'left right',
): number {
  if (tag) return contentWidthPx
  const n = (sides.includes('left') ? 1 : 0) + (sides.includes('right') ? 1 : 0)
  return contentWidthPx - n * TITLE_CLEARANCE[style]
}

/**
 * A title's classes: `note-title` and its size (`titleSize`: `--26`, `--23`, `--long` at 21 px).
 * The note view and the editor both set a title by it.
 */
export function titleClass(title: string, widthPx: number): string {
  const px = titleSize(title, widthPx)
  const size =
    px === LONG_TITLE_PX ? ' note-title--long' : px === TITLE_PX ? '' : ` note-title--${px}`
  return `note-title${size}`
}
