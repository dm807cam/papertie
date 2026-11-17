/**
 * A target beside the board that takes a card dragged across the seam (the open book's
 * page). The board holds the pointer through the drag (its capture), so the target never sees the
 * pointer itself: the runtime hands it the drag while the pointer is over it, and the release
 * there. The board's own drag ends committing nothing, so the cards never move on the board.
 */
export interface SeamDrop {
  /** Whether client point (x, y) is over the target (the book pane's page). */
  over(x: number, y: number): boolean
  hover(x: number, y: number, noteIds: readonly string[], alt: boolean): void
  /** The drop; true when it took the notes. */
  drop(x: number, y: number, noteIds: readonly string[], alt: boolean): boolean
  leave(): void
  /** On touch: card `noteId` held still `LONG_PRESS_MS` at client (x, y) (Copy · Move). */
  press?(noteId: string, x: number, y: number): void
  /** What the next drop does, where ⌥ is not the say (touch: Copy · Move); null: ⌥ decides. */
  armed?(): 'copy' | 'move' | null
}
