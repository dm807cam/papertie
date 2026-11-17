/**
 * Book → card: the selection as one new card on the board. Its text is the
 * selection as plain text with line breaks: a line per block, a list item as `- …` (the card
 * shows its bullet), headings, quotes and prompts as plain lines, a figure as its caption, no
 * marks. A selection of one figure is an image card, its caption the card's text, and a move of it
 * takes the figure out whole. The card is the
 * pinned design at `NEW_NOTE`'s size, on top, and remembers where it came from (`from`:
 * the book and the selection's first block). Provenance is one-way: the book's text
 * gets no mark pointing at the card. A move takes the text out of the book in the same batch,
 * exactly as the engine's own delete across blocks would (`deleteRange`, through
 * `changesToOps`): one undo step. What it reads is the selection's blocks (O(selection + log
 * book)), stopping once the text is past what a card holds.
 */
import {
  type Block,
  type BoardState,
  bookBlocks,
  type ClientOp,
  LIMITS,
  type Note,
  newId,
  OpError,
} from '@papertie/core'
import { announce } from '../../app/liveRegion'
import { prefsStore } from '../../app/prefs'
import type { BoardSession } from '../../app/session'
import type { Point } from '../../canvas/types'
import { topZOf } from '../../notes/noteCommands'
import { type NoteDesign, newNoteOp, pinnedDesign } from '../../notes/noteDesign'
import { BookModel, deleteRange, type Pos } from '../editor/model'
import { blocksFromTo, changesToOps } from '../editorOps'
import { sayLimit } from '../sayLimit'

export const PINNED_COPY = 'Pinned to the board.'
export const MOVED_COPY = 'Moved to the board.'
export const TOO_LONG_COPY = 'That’s more than a card holds.'
export const EMPTY_COPY = 'There is no text to pin.'
/** The undo labels: a card pinned from the book, and a move to the board. */
export const OUT_LABELS = { copy: 'pin to the board', move: 'move to the board' } as const

/** A figure's photo on a card: the frame a photo note takes (the Photo tool's). */
const FRAME = 'print' as const

/** The selected part of block `b`'s text, the selection being [a, z). */
function partOf(b: Block, a: Pos, z: Pos): string {
  const from = b.id === a.blockId ? a.offset : 0
  const to = b.id === z.blockId ? z.offset : b.text.length
  return b.text.slice(Math.max(0, from), Math.max(0, to))
}

/**
 * A block's line on the card: the selected part of its text (a figure's: of its caption, as a
 * move takes out exactly that part).
 */
function lineOf(b: Block, text: string): string {
  const one = text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  if (one === '') return ''
  return b.kind === 'li' ? `- ${one}` : one
}

/** The note ops for the selection [a, b) of book `bookId` as one card centred at world `at`; `move` also removes the text. */
export function toCardOps(o: {
  state: BoardState
  bookId: string
  a: Pos
  b: Pos
  at: Point
  move: boolean
  now: string
  newBlockId(): string
  /** How the card looks: the pinned design (`pinnedDesign`) by default. */
  design?: NoteDesign
}): { ops: ClientOp[]; noteId: string } | { refused: 'empty' | 'too-long' } {
  const { state, bookId, a, b } = o
  let length = 0
  const lines: string[] = []
  const blocks = blocksFromTo(
    state,
    bookId,
    a.blockId,
    b.blockId,
    () => length > LIMITS.maxTextLength,
  )
  const only = blocks.length === 1 ? blocks[0] : undefined
  const figure = only?.kind === 'figure' && only.image !== undefined ? only.image : null
  for (const block of blocks) {
    // One figure is an image card with its whole caption, whatever part of it is selected.
    const line = figure !== null ? block.text.trim() : lineOf(block, partOf(block, a, b))
    if (line === '') continue
    length += (lines.length > 0 ? 1 : 0) + line.length
    lines.push(line)
  }
  if (length > LIMITS.maxTextLength) return { refused: 'too-long' }
  if (lines.length === 0 && figure === null) return { refused: 'empty' }
  const first = blocks[0] as Block
  const design = o.design ?? pinnedDesign(prefsStore.getState())
  const create = newNoteOp(o.at, topZOf(state), o.now, design)
  const note: Note = {
    ...create.note,
    ...(figure === null ? {} : { style: 'print' as const }),
    text: lines.join('\n'),
    image: figure === null ? null : { assetId: figure.assetId, frame: FRAME },
    from: { book: bookId, block: first.id },
  }
  const ops: ClientOp[] = [{ op: 'note.create', note }]
  if (o.move && figure !== null) {
    // The card took the photo and the whole caption: the figure goes whole. A
    // book is never left with no block: its only one gives way to an empty paragraph.
    const f = only as Block
    ops.push({ op: 'block.delete', bookId, id: f.id })
    if (bookBlocks(state.blocks, bookId).count === 1) {
      const block: Block = {
        type: 'block',
        id: o.newBlockId(),
        bookId,
        pos: f.pos,
        kind: 'p',
        text: '',
        marks: [],
      }
      ops.push({ op: 'block.create', block, after: null })
    }
  } else if (o.move) {
    // The engine's own delete of [a, b): its changes over the selection's blocks alone.
    const model = new BookModel(blocks)
    ops.push(...changesToOps(state, bookId, deleteRange(model, a, b)))
  }
  return { ops, noteId: note.id }
}

/** The board's side of a card made from the book: it selects the new card there. */
export interface PinBoard {
  selectNote(id: string | null): void
}

/**
 * The selection `range` of book `bookId` made a card at world `at` (`toCardOps`), committed as one
 * step (`move`: the text taken out of the book too), selected on the board and said in the live
 * region. A selection too long for a card, or with nothing in it, changes nothing and says so.
 * The new card's id, or null.
 */
export function pinSelection(o: {
  session: Pick<BoardSession, 'store' | 'sync' | 'feed'>
  bookId: string
  range: { a: Pos; b: Pos }
  at: Point
  move: boolean
  board?: PinBoard | null
  design?: NoteDesign
  newBlockId?(): string
}): string | null {
  const store = o.session.store
  const r = toCardOps({
    state: store.getState(),
    bookId: o.bookId,
    a: o.range.a,
    b: o.range.b,
    at: o.at,
    move: o.move,
    now: store.now(),
    newBlockId: o.newBlockId ?? (() => newId('block')),
    ...(o.design ? { design: o.design } : {}),
  })
  if ('refused' in r) {
    if (r.refused === 'too-long') sayLimit(o.session, TOO_LONG_COPY)
    else announce(EMPTY_COPY)
    return null
  }
  try {
    store.commit(r.ops, { label: o.move ? OUT_LABELS.move : OUT_LABELS.copy })
  } catch (e) {
    // A board at its note limit (or a book changed under the selection): nothing is made.
    if (e instanceof OpError) {
      sayLimit(
        o.session,
        e.code === 'limit'
          ? `Couldn’t pin: a board holds at most ${LIMITS.maxNotes.toLocaleString('en')} notes`
          : 'Couldn’t pin the text',
      )
      return null
    }
    throw e
  }
  o.board?.selectNote(r.noteId)
  announce(o.move ? MOVED_COPY : PINNED_COPY)
  return r.noteId
}
