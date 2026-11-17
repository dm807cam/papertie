/**
 * The stamp's press: the mark pressed into the paper as its note is pinned (note.css,
 * `stamp-press`). It plays once, on the stamp's first appearance after this user pinned the note
 * here (`markPinned` from the runtime's create), never for a note that arrives by sync or with
 * the board, and never again when the note scrolls out of view and back.
 */
const pending = new Set<string>()
/** Ids waiting for their stamp to mount, oldest first; a note pinned and never seen is let go. */
const MAX_PENDING = 16

/** `noteId` was just pinned by this user with a stamp: it is pressed in when it first shows. */
export function markPinned(noteId: string): void {
  pending.add(noteId)
  if (pending.size > MAX_PENDING) {
    const oldest = pending.values().next().value
    if (oldest !== undefined) pending.delete(oldest)
  }
}

/** Whether `noteId`'s stamp is still to be pressed (it has not shown since it was pinned). */
export function stampPending(noteId: string): boolean {
  return pending.has(noteId)
}

/** Whether the stamp of `noteId` mounting now is to be pressed; it is the only time it is. */
export function takeStamp(noteId: string): boolean {
  return pending.delete(noteId)
}

/**
 * A stamp's ref: on its first mount after `markPinned`, the press class goes on, and comes off when
 * the press is over (under reduced motion the tokens are 0 ms, so at once).
 */
export function stampOnMount(noteId: string): (el: Element | null) => void {
  return (el) => {
    if (el === null || !takeStamp(noteId)) return
    el.classList.add('note-stamp--press')
    const done = () => el.classList.remove('note-stamp--press')
    el.addEventListener('animationend', done, { once: true })
    el.addEventListener('animationcancel', done, { once: true })
  }
}
