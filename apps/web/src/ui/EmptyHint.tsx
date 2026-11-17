import { useSyncExternalStore } from 'react'
import { OPENED, type OpeningView } from '../app/opening'
import { touchScreen } from '../lib/pointer'
import { type BoardStore, useBoard } from '../store/boardStore'
import '../styles/pin.css'
import './emptyHint.css'

/**
 * The empty board: a small paper hint card pinned to the cork in the middle of the view, until
 * the first note is made. It catches no pointer, so the cork under it still pans. While the board
 * is still opening, a view with no note yet says nothing: the board may not be empty.
 */
export function EmptyHint({
  store,
  opening = OPENED,
}: {
  store: BoardStore
  opening?: OpeningView
}) {
  const empty = useBoard(store, (s) => s.notes.size === 0)
  const open = useSyncExternalStore(opening.subscribe, () => opening.open)
  if (!empty || open) return null
  return (
    <aside className="empty-hint" aria-label="Empty board" data-testid="empty-hint">
      <span className="empty-hint-shadow" aria-hidden="true" />
      <span className="empty-hint-pin brass-pin" aria-hidden="true" />
      <div className="empty-hint-card">
        <p className="empty-hint-title">A clean board</p>
        <p className="empty-hint-subtitle">Begin with a blank sheet</p>
        <p className="empty-hint-line">{touchScreen() ? 'Tap' : 'Press'} + to pin a thought</p>
      </div>
    </aside>
  )
}
