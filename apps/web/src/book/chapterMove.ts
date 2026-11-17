import {
  type BoardState,
  blocksOf,
  bookBlocks,
  type ClientOp,
  LIMITS,
  posKeysBetween,
} from '@papertie/core'

/**
 * A chapter moved in the outline: chapter `chapterId` (its heading, an `h1`, and
 * the blocks up to the next heading) put before chapter `beforeChapterId`, or at the book's end
 * (`null`), as `block.set pos` ops. Whichever side has fewer blocks moves: the chapter, or the
 * chapters it passes (which then move to its other side), so a move is at most
 * `maxBlocksPerBook / 2` ops, within one staged batch (64 parts of 500). The keys come from
 * `posKeysBetween`, spread over the gap they go into, and each op says the block it now follows
 * (`after`: the block before the gap, then the one moved before it), so an undo or redo of the
 * move is fitted after that block as the book then has it (`fitStep`). Text is never touched.
 *
 * None when the chapter is where it is asked to be already, when either id is not a chapter of
 * the book, or (in a book whose keys ran to `maxPosLength` around a gap) when the side that fits
 * a staged batch has no keys room there: the other side is never more than half a book.
 */
export function planChapterMove(
  state: BoardState,
  bookId: string,
  chapterId: string,
  beforeChapterId: string | null,
): ClientOp[] {
  const blocks = blocksOf(state, bookId)
  const n = blocks.length
  const s = blocks.findIndex((b) => b.id === chapterId)
  if (s < 0 || blocks[s]?.kind !== 'h1') return []
  let e = s + 1
  while (e < n && blocks[e]?.kind !== 'h1') e++
  let t = n
  if (beforeChapterId !== null) {
    t = blocks.findIndex((b) => b.id === beforeChapterId)
    if (t < 0 || blocks[t]?.kind !== 'h1') return []
  }
  if (t >= s && t <= e) return []
  const pos = (i: number) => blocks[i]?.pos ?? null
  // Blocks `[from, to)` into the gap before block `gap` (`n`: the end).
  const plan = (from: number, to: number, gap: number) => ({ from, to, gap })
  const chapter = plan(s, e, t)
  // The blocks passed go to the chapter's other side.
  const passed = t > e ? plan(e, t, s) : plan(t, s, e)
  const size = (p: { from: number; to: number }) => p.to - p.from
  const tries = size(passed) < size(chapter) ? [passed, chapter] : [chapter, passed]
  for (const p of tries) {
    // Never more than half a book: one staged batch carries no more (64 parts of 500 ops).
    if (size(p) > LIMITS.maxBlocksPerBook / 2) continue
    let keys: string[]
    try {
      keys = posKeysBetween(
        p.gap === 0 ? null : pos(p.gap - 1),
        p.gap === n ? null : pos(p.gap),
        size(p),
      )
    } catch {
      continue // no room between those two keys: the other side, then
    }
    const ops: ClientOp[] = []
    for (let i = p.from; i < p.to; i++) {
      const b = blocks[i]
      // What it now follows: the block before the gap for the first, the one before it after.
      const after =
        i === p.from ? (p.gap === 0 ? null : (blocks[p.gap - 1]?.id ?? null)) : blocks[i - 1]?.id
      if (b !== undefined)
        ops.push({
          op: 'block.set',
          bookId,
          id: b.id,
          set: { pos: keys[i - p.from] as string },
          after: after ?? null,
        })
    }
    return ops
  }
  return []
}

/** The book's chapters (its `h1`s) in order, their ids and titles: O(book), when the outline opens. */
export function chaptersOf(
  state: BoardState,
  bookId: string,
): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = []
  for (const chunk of bookBlocks(state.blocks, bookId).chunks)
    for (const b of chunk) if (b.kind === 'h1') out.push({ id: b.id, title: b.text })
  return out
}
