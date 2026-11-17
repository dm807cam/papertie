import type { Note } from '@papertie/core'
import {
  type ComponentType,
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import { showUses } from '../app/prefetchBooks'
import { isTag } from '../canvas/geometry'
import type { LodMode } from '../canvas/lod'
import type { Point } from '../canvas/types'
import { NotePhoto } from '../images/NotePhoto'
import { noteVisual } from '../lib/seed'
import { blocksLabel } from '../selection/selection'
import type { BoardStore } from '../store/boardStore'
import { type CardUses, useCardUse, useShelved } from '../sync/books/cardUses'
import { greekLines } from './greek'
import { type EditorExit, NoteEditor } from './NoteEditor'
import { noteStyle, sheetStyle } from './noteStyle'
import {
  isHeading,
  type NoteBlock,
  parseNoteText,
  titleClass,
  titleFace,
  titleWidth,
} from './noteText'
import type { RefFieldProps } from './RefField'
import { StampMark } from './StampMark'
import type { EditorHandle } from './sourceEditor'
import { stampOnMount } from './stampPress'
import './note.css'

/**
 * A note's ref field while it is written on: a chunk of its own, loaded as
 * writing starts. Where it cannot load (a failed fetch), none: the text editor is whole.
 */
const RefField = lazy(
  (): Promise<{ default: ComponentType<RefFieldProps> }> =>
    import('./RefField').catch(() => ({ default: () => null })),
)

/** Horizontal padding of `.note-paper` (26 px each side, 14 on a tag), and of a print's border. */
const TEXT_INSET = { rustic: 52, smooth: 52, print: 36 } as const
const TAG_INSET = 28

/** What the margin rule adds to those: it keeps the text to its right (note.css); not on a tag. */
const MARGIN_SHIFT = { rustic: 14, smooth: 14, print: 26 } as const
/** The stamp's size on a note (20 px on a tag, by note.css). */
const STAMP_SIZE = 26

/** The width a note's paper leaves its text: its own less the paper's padding and a margin rule. */
function textMeasure(note: Note, tag: boolean): number {
  if (tag) return note.w - TAG_INSET
  const shift = note.motif === 'margin' ? MARGIN_SHIFT[note.style] : 0
  return note.w - TEXT_INSET[note.style] - shift
}

/** The id of the one visually hidden "Selected" node that selected notes are described by. */
export const SELECTED_MARK_ID = 'papertie-selected-mark'

/** The id of the hidden node that holds what a note's threads tie it to. */
const tiedId = (noteId: string) => `${noteId}-tied`

/** A note's `aria-describedby`: what it is tied to, then "Selected"; none when neither. */
function describedBy(noteId: string, tied: boolean, selected: boolean): string | undefined {
  if (tied) return selected ? `${tiedId(noteId)} ${SELECTED_MARK_ID}` : tiedId(noteId)
  return selected ? SELECTED_MARK_ID : undefined
}

/** What a note being written on needs for its editor. */
export interface NoteEditing {
  store: BoardStore
  /** Where the caret starts, as an offset into the text; the end when absent. */
  caret?: number
  /** The paper's least height while editing (world px): its height when editing began. */
  holdH?: number
  /**
   * Whether the note was set as a heading (centred) when editing began: kept while writing, so
   * the text never jumps sideways as the first line is typed; the rendering decides again after.
   */
  heading: boolean
  onDone(how: EditorExit): void
  register?(handle: EditorHandle | null): void
}

export interface NoteViewProps {
  note: Note
  /** Overview never mounts notes; a note given it draws as lite. */
  lod: LodMode
  rotation: boolean
  selected?: boolean
  /**
   * The world layer's anchor (floating origin) the note is placed relative to, read at render
   * time; the origin if none. A getter, not a value, so a rebase (which re-places mounted notes
   * itself) never re-renders a note.
   */
  anchorOf?: () => Point
  registerEl?: (id: string, el: HTMLElement | null) => void
  /** Present while the note is being written on: its text is then the editor. */
  editing?: NoteEditing
  /**
   * Where it reads what its threads tie it to (`TiedDescriptions`), its accessible description;
   * '' for a note on no thread. The threads are drawn on the canvas, so this is their DOM
   * equivalent. Absent: no description.
   */
  tied?: TiedSource
  /**
   * Where it reads which sides of its paper carry an edge pin (`EdgeSides`): its title keeps
   * clear of those. Absent: both sides are kept clear.
   */
  sides?: TiedSource
  /**
   * Whether a shelf book uses the card (its reverse mark). Absent: read from `uses`
   * (`cardUses`, followed per note, so a stamp wakes only the cards it changed).
   */
  used?: boolean
  /** Where `used`, and whether the book the card came from (`note.from`) is on the shelf, are read. */
  uses?: CardUses
}

/** What a note reads its "Tied to …" description from, and is told by when it may change. */
export interface TiedSource {
  get(noteId: string): string
  subscribe(noteId: string, fn: () => void): () => void
}

const NO_TIED = () => () => {}

/** The note's "Tied to …" description (or another value read the same way), followed. */
function useTied(source: TiedSource | undefined, noteId: string, absent = ''): string {
  const subscribe = useCallback(
    (fn: () => void) => (source === undefined ? NO_TIED() : source.subscribe(noteId, fn)),
    [source, noteId],
  )
  return useSyncExternalStore(subscribe, () => source?.get(noteId) ?? absent)
}

/**
 * The rendered text. Each block holds its shown text only and carries its index
 * (`data-block`), so a click maps back to a place in the plain text (`caretOffsetAt`).
 */
function NoteText({ blocks, width }: { blocks: readonly NoteBlock[]; width: number }) {
  // A title's size and tracking, from its text and its measure: once per change of either, and
  // once more if the title face arrives after the title was measured in its fallback.
  const face = useSyncExternalStore(titleFace.subscribe, titleFace.get, titleFace.get)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `face` sets the titles again
  const classes = useMemo(
    () => blocks.map((b) => (b.kind === 'title' ? titleClass(b.text, width) : `note-${b.kind}`)),
    [blocks, width, face],
  )
  const out = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b === undefined) continue
    if (b.kind === 'bullet') {
      const items = []
      for (; i < blocks.length && blocks[i]?.kind === 'bullet'; i++) {
        items.push(
          <li key={i} data-block={i}>
            {blocks[i]?.text}
          </li>,
        )
      }
      i--
      out.push(
        <ul key={`u${i}`} className="note-bullets">
          {items}
        </ul>,
      )
    } else {
      out.push(
        <div key={i} className={classes[i]} data-block={i}>
          {b.text}
        </div>,
      )
    }
  }
  return <div className="note-text">{out}</div>
}

/**
 * One paper note in world space: an optional layered backing sheet, a separate shadow element,
 * then the paper with its decoration (drawn by note.css), optional image and text (title, subtitle, bullets and
 * body, parsed from the plain text). It rotates about its pin; in lite mode the text becomes
 * greeked bars and the decoration is left out. Notes 120 px wide or narrower are tags.
 * While it is being written on, its text is the editor (at any level of detail), and the paper
 * holds at least the height it had when editing began.
 */
export function NoteView({
  note,
  lod,
  rotation,
  selected,
  anchorOf,
  registerEl,
  editing,
  tied: tiedSource,
  sides: sidesSource,
  used: usedProp,
  uses,
}: NoteViewProps) {
  // Counted only when the dev hooks are installed; never installs them (no URL parse per note).
  const renders = typeof window === 'undefined' ? undefined : window.__papertie?.renders
  if (renders) renders.noteView = (renders.noteView ?? 0) + 1
  const { id, w, style, paper, text, image, motif, stamp, layered, ref: reference } = note
  const visual = noteVisual(id)
  const lite = lod !== 'full'
  const tag = isTag(note)
  const measure = textMeasure(note, tag)
  const box = noteStyle(note, rotation, anchorOf?.())
  const ref = useCallback((el: HTMLElement | null) => registerEl?.(id, el), [registerEl, id])
  const stampRef = useMemo(() => stampOnMount(id), [id])

  const tied = useTied(tiedSource, id)
  // The sides an edge pin sits on: the title keeps clear of those only.
  const pinned = useTied(sidesSource, id, 'left right')
  const sides = tag ? '' : pinned
  // The reverse mark (a shelf book uses the card) and the origin (made from a book still on the
  // shelf: an origin whose book is gone shows nothing).
  const usedRead = useCardUse(uses, id)
  const used = usedProp ?? usedRead
  const origin = useShelved(uses, note.from?.book)
  const blocks = useMemo(() => parseNoteText(text), [text])
  const label = useMemo(() => blocksLabel(blocks), [blocks])
  // While written on, the runtime's flush of the editor sends the ref field's too.
  const refFlush = useRef<(() => void) | null>(null)
  const given = editing?.register
  const register = useMemo(
    () =>
      given &&
      ((h: EditorHandle | null) =>
        given(
          h && {
            flush: () => {
              h.flush()
              refFlush.current?.()
            },
            focusEnd: () => h.focusEnd(),
          },
        )),
    [given],
  )

  let cls = `note note--${style}`
  if (tag) cls += ' note--tag'
  if ((editing ? editing.heading : isHeading(blocks)) && !tag && style !== 'print') {
    cls += ' note--heading'
  }
  if (lite) cls += ' note--lite'
  if (selected) cls += ' note--selected'
  if (editing) cls += ' note--editing'

  const sheet = layered === undefined ? null : sheetStyle(id)
  const greek = lite && !editing ? greekLines(text, measure) : []
  const held = editing?.holdH
  const minHeight = held !== undefined && held > note.h ? `${held}px` : box.minHeight
  const titled = lite && blocks[0]?.kind === 'title'

  return (
    // A note takes the keyboard (Tab, then Enter writes, Delete removes). Being selected is
    // said by pointing at the one shared "Selected" node (`aria-selected` is not an article's).
    <article
      ref={ref}
      className={cls}
      data-note-id={id}
      data-paper={paper}
      data-mask={visual.maskIndex}
      data-motif={motif}
      data-photo={image === null ? undefined : ''}
      data-used={used ? '' : undefined}
      data-origin={origin ? '' : undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the note is the board's focusable item
      tabIndex={0}
      aria-label={label}
      aria-describedby={describedBy(id, tied !== '', selected === true)}
      style={{ width: box.width, transform: box.transform, transformOrigin: box.transformOrigin }}
    >
      {sheet !== null && (
        <div
          className="note-sheet"
          aria-hidden="true"
          data-sheet-mask={sheet.maskIndex}
          data-sheet-paper={layered}
          style={
            {
              inset: sheet.inset,
              transform: sheet.transform,
              '--sheet-paper': `var(--paper-${layered})`,
              '--sheet-fibre': `var(--fibre-${layered})`,
            } as CSSProperties
          }
        >
          <div className="note-sheet-shadow" />
          <div className="note-sheet-paper" />
        </div>
      )}
      <div className="note-shadow" />
      <div className="note-paper" style={{ minHeight }} data-pin-sides={sides || undefined}>
        {!lite && (motif !== undefined || stamp === true) && (
          <div className="note-decor" aria-hidden="true">
            {motif !== undefined && <div className={`note-motif note-motif--${motif}`} />}
            {stamp === true && (
              <StampMark svgRef={stampRef} className="note-stamp" size={STAMP_SIZE} />
            )}
          </div>
        )}
        <NotePhoto noteId={id} image={image} style={style} lite={lite} w={w} h={note.h} />
        {editing ? (
          <NoteEditor
            note={note}
            store={editing.store}
            caret={editing.caret}
            textWidth={titleWidth(measure, style, tag, sides)}
            onDone={editing.onDone}
            register={register}
          />
        ) : lite ? (
          <div
            className={titled ? 'note-greek note-greek--titled' : 'note-greek'}
            aria-hidden="true"
          >
            {greek.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional and never reorder
              <span key={i} style={{ width: `${f * 100}%` }} />
            ))}
          </div>
        ) : (
          <NoteText blocks={blocks} width={titleWidth(measure, style, tag, sides)} />
        )}
        {editing ? (
          <Suspense fallback={null}>
            <RefField note={note} store={editing.store} onDone={editing.onDone} flush={refFlush} />
          </Suspense>
        ) : (
          !lite &&
          reference !== undefined && (
            // The note's reference: under a hairline, in small type.
            <div className="note-ref" role="note" aria-label="Reference">
              {reference}
            </div>
          )
        )}
        {/* The ink dot in the paper's corner, at reading zooms only (the overview's paint draws
            none, ADR-0003); hover or a tap opens the books it names. */}
        {!lite && (used || origin) && (
          <button
            type="button"
            className="note-ink"
            aria-label={used ? 'Used in books' : 'From a book'}
            aria-haspopup="dialog"
            data-ink={used ? 'used' : 'origin'}
            // Hover (a tap on touch) or a click: the books it names (`CardUses`, lazy).
            onPointerEnter={(e) => {
              if (e.pointerType === 'mouse') showUses({ noteId: id, anchor: e.currentTarget })
            }}
            onClick={(e) => showUses({ noteId: id, anchor: e.currentTarget })}
          />
        )}
      </div>
      {tied !== '' && (
        <span id={tiedId(id)} hidden>
          {tied}
        </span>
      )}
    </article>
  )
}
