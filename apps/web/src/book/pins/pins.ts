/**
 * Provenance pins, pure: a small brass pin in the page's left margin for
 * each card a block on the page names (its card marks, a figure's `image.card`), at the block's
 * top, several stacked 18 px apart; faded while the card is deleted, and back once it is (an
 * undo, a restore). Read from the window's blocks only.
 */
import {
  type Block,
  type BoardState,
  type ClientOp,
  cardMarkT,
  cardsOfBlock,
  type Note,
} from '@papertie/core'
import { parseNoteText } from '../../notes/noteText'
import type { BlockEngine } from '../editor/blockEngine'

/** Pins of one block, this far apart (px). */
export const PIN_STACK_PX = 18

export interface Pin {
  blockId: string
  noteId: string
  top: number
  faded: boolean
}

/** One pin per card per live block, in the left margin, stacked 18 px apart; faded when the card is gone. */
export function pinsOf(
  live: ReturnType<BlockEngine['liveBlocks']>,
  blocks: (id: string) => Block | undefined,
  hasNote: (id: string) => boolean,
): Pin[] {
  const out: Pin[] = []
  for (const l of live) {
    const b = blocks(l.id)
    if (b === undefined || (b.marks.length === 0 && b.image?.card === undefined)) continue
    let k = 0
    for (const noteId of cardsOfBlock(b)) {
      out.push({ blockId: l.id, noteId, top: l.top + k * PIN_STACK_PX, faded: !hasNote(noteId) })
      k++
    }
  }
  return out
}

/** The ops that take card `noteId` off block `blockId`: its marks (`removeMarks`), or a figure's `image.card`. */
export function unpinOps(
  state: BoardState,
  bookId: string,
  blockId: string,
  noteId: string,
): ClientOp[] {
  const b = state.blocks.get(blockId)
  if (b === undefined || b.bookId !== bookId) return []
  const ops: ClientOp[] = []
  const t = cardMarkT(noteId)
  const marks = b.marks.filter((m) => m.t === t)
  if (marks.length > 0) {
    ops.push({ op: 'block.edit', bookId, id: blockId, splices: [], removeMarks: marks })
  }
  if (b.image?.card === noteId) {
    ops.push({ op: 'block.set', bookId, id: blockId, set: { image: { assetId: b.image.assetId } } })
  }
  return ops
}

/** A card's first line (its title), or a photo's word for it. */
export function firstLineOf(n: Note): string {
  const b = parseNoteText(n.text)[0]
  return b?.text.split('\n')[0]?.trim() || (n.image === null ? 'Untitled card' : 'Photo')
}

/** What a pin is called: by its card's first line, or as a deleted card's. */
export const pinLabel = (n: Note | undefined): string =>
  n === undefined ? 'From a deleted card' : `From a card: ${firstLineOf(n)}`
