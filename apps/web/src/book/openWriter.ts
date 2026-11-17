/**
 * The book open in the writer, for what lives outside its chunk: the reverse view's
 * "Used in" and "From" go to a block of the book already open through its writer (the route is
 * the same, so a navigation would not move the page). Tiny, so the reverse view's chunk stays
 * small: it holds a function, never the writer.
 */
interface Open {
  bookId: string
  reveal(blockId: string): void
}

let open: Open | null = null

/** `w` is the book open in the writer until the function it returns is called. */
export function writerOpen(w: Open): () => void {
  open = w
  return () => {
    if (open === w) open = null
  }
}

/** Block `blockId` shown in the open writer when `bookId` is the book open there; else false. */
export function revealInWriter(bookId: string, blockId: string): boolean {
  if (open === null || open.bookId !== bookId) return false
  open.reveal(blockId)
  return true
}
