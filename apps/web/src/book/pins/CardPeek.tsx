import type { Note } from '@papertie/core'
import { useLayoutEffect, useRef } from 'react'
import { NoteView } from '../../notes/NoteView'

export const DELETED_COPY = 'This card was deleted.'

/**
 * A pin's peek: the card it came from, drawn by `NoteView` as the board
 * draws it at reading zoom (`lod: 'full'`), not editable and out of the tab order (`inert`); a
 * deleted card's says so. Either way it offers "Remove pin". A card with a ref offers
 * "Add footnote from" its ref.
 */
export function CardPeek({
  note,
  top,
  onRemove,
  onEnter,
  onLeave,
  onFootnote,
}: {
  note: Note | undefined
  /** Its top in the pin layer (px): beside its pin. */
  top: number
  onRemove(): void
  /** A footnote of the card's ref on the pinned block. */
  onFootnote?(): void
  onEnter?(): void
  onLeave?(): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  // Placed and sized by the CSSOM (the CSP allows no style attributes in markup).
  useLayoutEffect(() => {
    if (box.current) box.current.style.top = `${Math.round(top)}px`
    const el = card.current
    if (el && note) {
      el.style.width = `${note.w}px`
      el.style.minHeight = `${note.h}px`
    }
  }, [top, note])
  return (
    <div
      ref={box}
      className="card-peek sync-paper"
      data-faded={note === undefined ? '' : undefined}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      {note === undefined ? (
        <p className="card-peek-gone">{DELETED_COPY}</p>
      ) : (
        <div ref={card} className="card-peek-card" inert>
          <NoteView note={note} lod="full" rotation={false} anchorOf={() => note} />
        </div>
      )}
      {note?.ref !== undefined && onFootnote !== undefined && (
        <fieldset className="card-peek-sources">
          <legend className="card-peek-sources-label">Add footnote from</legend>
          <button type="button" className="card-peek-source" onClick={() => onFootnote()}>
            {note.ref}
          </button>
        </fieldset>
      )}
      <button type="button" className="card-peek-remove" onClick={onRemove}>
        Remove pin
      </button>
    </div>
  )
}
