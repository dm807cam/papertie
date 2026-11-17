/**
 * What a card becomes in a book: pure, the drop's and ⌘K's ops. Each of a
 * text card's rendered blocks (`parseNoteText`) is one block of the form; a photo card is one
 * figure, captioned with its text. A copy keeps the card's mark over each block's whole text (a
 * figure's on `image.card`); a move keeps none and takes the card off the board in the same batch
 * (one undo step), its threads closed up by core as a delete's are.
 *
 * A card's ref: a text card with a ref lands as a
 * quote, whatever the likely form (the likely form for a card with a ref), with a footnote of its
 * ref anchored over its last block, in the same batch. A photo card stays a figure, no footnote.
 */
import { type BoardState, type ClientOp, cardMarkT, type Note } from '@papertie/core'
import { parseNoteText } from '../../notes/noteText'
import type { EditorChange, EditorKind } from '../editor/BookEditor'
import { changesToOps } from '../editorOps'
import { noteMark } from '../footnotes/marks'

export type DropForm = 'p' | 'quote' | 'prompt'

/** What the live region calls each form, and a figure. */
export const FORM_NOUN: Record<DropForm | 'figure', string> = {
  p: 'a paragraph',
  quote: 'a quote',
  prompt: 'a prompt',
  figure: 'a figure',
}

/** Board reading order: by y, then x (then id, so it is total). */
export const readingOrder = (a: Note, b: Note): number =>
  a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** One line of every run of lines (a body block's lines, a caption's) joined by a space. */
const oneLine = (text: string) =>
  text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' ')

/** The blocks `note` becomes, as `form`: kind and text (a figure's image beside). */
function blocksOf(
  note: Note,
  form: DropForm,
): Array<{ kind: EditorKind; text: string; image?: { assetId: string }; bullet?: true }> {
  if (note.image !== null) {
    return [{ kind: 'figure', text: oneLine(note.text), image: { assetId: note.image.assetId } }]
  }
  const out: Array<{ kind: EditorKind; text: string; bullet?: true }> = []
  for (const b of parseNoteText(note.text)) {
    const text = oneLine(b.text)
    if (text === '') continue
    const bullet = b.kind === 'bullet'
    out.push({ kind: form === 'p' && bullet ? 'li' : form, text, ...(bullet ? { bullet } : {}) })
  }
  return out
}

/** The kind a dropped block takes as `form`: in Paragraph form, a card's bullet is a list item. */
export const kindAs = (form: DropForm, bullet: boolean): EditorKind =>
  form === 'p' && bullet ? 'li' : form

/**
 * The ops that put `notes` (board reading order: by y, then x) after block `after` (null: first),
 * as `form`: `changesToOps`'s run of creates (their keys together), then, for a move, each card's
 * `note.delete`. `blockIds`: the new blocks, in book order; `bullets`: those made from a card's
 * bullets (a switch back to Paragraph makes them list items again). Empty ops for cards with
 * nothing in them.
 */
export function cardDropOps(o: {
  state: BoardState
  bookId: string
  after: string | null
  notes: readonly Note[]
  form: DropForm
  move: boolean
  newBlockId(): string
}): {
  ops: ClientOp[]
  blockIds: string[]
  bullets: string[]
  /** The footnotes made (a card with a ref's), never among `blockIds`. */
  footnotes: string[]
  /** The form the text landed in: the first text card's (a card with a ref's quote). */
  form: DropForm
  /** A text card had a ref: its form was the ref's, so it is not counted. */
  reffed: boolean
  /** The last block of the cards' text (a figure too; never a footnote). */
  last: string | null
} {
  const changes: EditorChange[] = []
  const blockIds: string[] = []
  const bullets: string[] = []
  const footnotes: string[] = []
  const taken: string[] = []
  let form: DropForm | null = null
  let reffed = false
  let last: string | null = null
  let at = o.after
  for (const note of [...o.notes].sort(readingOrder)) {
    // A text card with a ref: a quote, and its footnote.
    const ref = note.image === null ? note.ref : undefined
    const as: DropForm = ref !== undefined ? 'quote' : o.form
    const made = blocksOf(note, as)
    if (made.length === 0) continue
    taken.push(note.id)
    if (ref !== undefined) reffed = true
    if (note.image === null) form ??= as
    const footnote = ref === undefined ? null : o.newBlockId()
    made.forEach((b, k) => {
      const id = o.newBlockId()
      const mark = !o.move && b.image === undefined && b.text.length > 0
      // The footnote's anchor over the quote's last block (its number after the quote).
      const anchor = footnote !== null && k === made.length - 1 && b.text.length > 0
      const marks = [
        ...(mark ? [{ t: cardMarkT(note.id), from: 0, to: b.text.length }] : []),
        ...(anchor ? [{ t: noteMark(footnote), from: 0, to: b.text.length }] : []),
      ]
      changes.push({
        t: 'create',
        id,
        after: at,
        kind: b.kind,
        text: b.text,
        ...(marks.length > 0 ? { marks } : {}),
        ...(b.image === undefined
          ? {}
          : {
              image: {
                assetId: b.image.assetId,
                ...(o.move ? {} : { card: note.id }),
                // The board keeps no aspect (`changesToOps` drops it).
                aspect: 1,
              },
            }),
      })
      blockIds.push(id)
      if ('bullet' in b && b.bullet) bullets.push(id)
      at = id
      last = id
    })
    if (footnote !== null && ref !== undefined && at !== null) {
      changes.push({ t: 'create', id: footnote, after: at, kind: 'footnote', text: ref })
      footnotes.push(footnote)
      at = footnote
    }
  }
  const none = { footnotes, form: form ?? o.form, reffed, last }
  if (changes.length === 0) return { ops: [], blockIds: [], bullets: [], ...none }
  const ops = changesToOps(o.state, o.bookId, changes)
  if (o.move) for (const id of taken) ops.push({ op: 'note.delete', id })
  return { ops, blockIds, bullets, ...none }
}

/**
 * The switch of the chooser: `block.set kind` on each dropped block still there and of another
 * kind (a figure never). One commit and one undo step, labelled `change to a quote`.
 */
export function switchOps(
  state: BoardState,
  bookId: string,
  blockIds: readonly string[],
  bullets: ReadonlySet<string>,
  form: DropForm,
): ClientOp[] {
  const ops: ClientOp[] = []
  for (const id of blockIds) {
    const b = state.blocks.get(id)
    if (b === undefined || b.bookId !== bookId || b.kind === 'figure') continue
    const kind = kindAs(form, bullets.has(id))
    if (b.kind !== kind) ops.push({ op: 'block.set', bookId, id, set: { kind } })
  }
  return ops
}

/** The undo label of a switch to `form`. */
export const switchLabel = (form: DropForm): string => `change to ${FORM_NOUN[form]}`
