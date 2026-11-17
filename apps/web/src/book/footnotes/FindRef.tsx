/**
 * ⌘K in a footnote: the board's picker, offering the cards with a ref
 * only (a kept set of their ids, so the list is never filled by others). Enter
 * inserts the card's ref at the footnote's caret, its own text kept: one commit.
 */
import type { BoardSession } from '../../app/session'
import { Picker } from '../../search/LazyPicker'
import { refIdsOf } from '../../search/refIds'
import type { BlockEngine } from '../editor/blockEngine'
import type { Pos } from '../editor/model'

export function FindRef(p: {
  session: BoardSession
  engine: Pick<BlockEngine, 'insertInFootnote'>
  /** Where in the footnote the caret was as the picker opened. */
  at: Pos
  onClose(): void
}) {
  const store = p.session.store
  return (
    <div className="search-stage insert-stage">
      <Picker
        store={store}
        title="Insert a reference"
        placeholder="Find a card with a reference"
        only={() => refIdsOf(store)}
        onClose={p.onClose}
        onPick={(noteId) => {
          p.onClose()
          const ref = store.getState().notes.get(noteId)?.ref
          if (ref !== undefined) p.engine.insertInFootnote(p.at, ref)
        }}
      />
    </div>
  )
}
