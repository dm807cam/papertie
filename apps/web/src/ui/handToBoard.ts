/** Give the keyboard to the board, from a control of its UI layer (one going away, say). */
export function handToBoard(from: Element | null): void {
  const board = from?.closest<HTMLElement>('.viewport')
  if (!board) return
  if (!board.hasAttribute('tabindex')) board.tabIndex = -1
  board.focus({ preventScroll: true })
}
