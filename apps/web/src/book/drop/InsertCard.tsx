/**
 * ⌘K in the book: "Insert card" in the top band, and its accelerator, open the board's own
 * picker ("Insert a card"). Enter puts the card found in as a copy after the caret's paragraph
 * (after the prompts that annotate it), Alt+Enter moves it there (the accelerators of the
 * picker's "Copy into the book" and "Move into the book"); with no caret in the book, after
 * the block at the view's top. It lands in the likely form, is said as a drop is, and the caret
 * goes after it; the drop's chooser follows (the caller's).
 */
import type { BoardSession } from '../../app/session'
import { Picker } from '../../search/LazyPicker'
import type { BlockEngine } from '../editor/blockEngine'
import { afterPrompts } from '../editorOps'
import { type Dropped, landCards } from './cardDrop'
import { likelyForm } from './dropForms'

/** Where an insert goes: after the caret's block, else after the block at the view's top. */
export function insertAfter(
  session: Pick<BoardSession, 'store'>,
  bookId: string,
  engine: Pick<BlockEngine, 'liveBlocks'>,
  caret: string | null,
  view: { page: HTMLElement | null; scroller: HTMLElement | null },
): string | null {
  const state = session.store.getState()
  const on = (id: string | null | undefined) =>
    id != null && state.blocks.get(id)?.bookId === bookId ? id : null
  let at = on(caret)
  if (at === null) {
    const top =
      (view.scroller?.getBoundingClientRect().top ?? 0) -
      (view.page?.getBoundingClientRect().top ?? 0)
    const live = engine.liveBlocks()
    const text = (k: string) => k !== 'prompt' && k !== 'footnote'
    at = on((live.find((b) => text(b.kind) && b.top + b.height > top) ?? live[0])?.id)
  }
  return at === null ? null : afterPrompts(state, bookId, at)
}

export function InsertCard(p: {
  session: BoardSession
  bookId: string
  /** The block the card goes after (null: first in the book), read as the picker opened. */
  after: string | null
  onClose(): void
  onInserted(made: Dropped): void
}) {
  return (
    <div className="search-stage insert-stage">
      <Picker
        store={p.session.store}
        title="Insert a card"
        placeholder="Find a card"
        onClose={p.onClose}
        how={{ copy: 'Copy into the book', move: 'Move into the book' }}
        onPick={(noteId, how) => {
          p.onClose()
          const made = landCards({
            session: p.session,
            bookId: p.bookId,
            after: p.after,
            noteIds: [noteId],
            move: how.alt,
            form: likelyForm(),
          })
          if (made !== null) p.onInserted(made)
        }}
      />
    </div>
  )
}
