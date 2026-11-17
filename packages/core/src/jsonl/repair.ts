import { blockIndex, keepBlockIndex, reindexBlock } from '../book/blockIndex'
import { cardCounts, cardMarkT } from '../book/cards'
import { withoutDanglingAnchors } from '../book/footnotes'
import { normalizeMarks } from '../book/splice'
import { withoutPin } from '../ops/draft'
import { keepThreadIndex, reindex, threadIndex } from '../ops/threadIndex'
import type { Block, Book, Yarn } from '../schema/records'
import { asPMap, type BoardState } from '../state'
import type { LoadIssue } from './parse'

/**
 * A figure whose photo is gone, as the paragraph of its caption: `kind: 'p'`, no `image`, and the
 * card it was made from (`image.card`) carried as a card mark over the whole caption, so the book
 * still names the card where it has text to name it with. A figure cannot drop
 * its image as a note can; this keeps its words. The record is otherwise as it was.
 */
export function figureAsCaption(block: Block): Block {
  const { image, ...rest } = block
  const card = image?.card
  const marks =
    card !== undefined && block.text.length > 0
      ? normalizeMarks([{ t: cardMarkT(card), from: 0, to: block.text.length }, ...block.marks])
      : block.marks
  return { ...rest, kind: 'p', marks }
}

/** The `dangling-reference` message of a figure kept as its caption. */
export const figureAsCaptionMessage = (block: Block): string =>
  `block ${block.id}: image asset ${block.image?.assetId} is missing; figure kept as its caption`

/**
 * Restore the reference invariants of a state built from individually valid records.
 * - A note image whose asset is missing becomes `image: null`.
 * - A figure whose asset is missing becomes the paragraph of its caption
 *   ({@link figureAsCaption}); a card that no block names after it leaves its book's `cards`.
 * - Yarn `noteIds` pointing at missing notes are removed (with their `pins` entries); a yarn
 *   left with fewer than 2 notes is dropped.
 * - A block whose book is missing is dropped.
 * - A footnote anchor (`n:` mark) that names no `footnote` block of its book loses that mark;
 *   the text stays. This one is quiet: an anchor whose footnote was deleted is a
 *   normal leftover, not damage, so it gives no issue.
 * Each other repaired or dropped record gives one `dangling-reference` issue (`line: 0`, `raw` = the
 * original record JSON). Issues come notes first, then yarns, then blocks (the orphans, then the
 * figures), each in map (file) order.
 * Returns the input state unchanged when nothing needed repair. Timestamps are not touched.
 */
export function repairReferences(state: BoardState): { state: BoardState; issues: LoadIssue[] } {
  const issues: LoadIssue[] = []

  // Repairs overwrite in place and drops delete, so the maps keep their (file) order.
  const notes = asPMap(state.notes).asTransient()
  for (const [id, note] of state.notes) {
    if (note.image && !state.assets.has(note.image.assetId)) {
      issues.push({
        line: 0,
        kind: 'dangling-reference',
        raw: JSON.stringify(note),
        message: `note ${id}: image asset ${note.image.assetId} is missing; image removed`,
      })
      notes.set(id, { ...note, image: null })
    }
  }

  const yarns = asPMap(state.yarns).asTransient()
  const rewound: Array<[string, Yarn, Yarn | undefined]> = []
  for (const [id, yarn] of state.yarns) {
    const kept = yarn.noteIds.filter((noteId) => notes.has(noteId))
    if (kept.length === yarn.noteIds.length) continue
    const missing = yarn.noteIds.filter((noteId) => !notes.has(noteId))
    const dropped = kept.length < 2
    issues.push({
      line: 0,
      kind: 'dangling-reference',
      raw: JSON.stringify(yarn),
      message: dropped
        ? `yarn ${id}: missing notes ${missing.join(', ')}; fewer than 2 notes left, yarn removed`
        : `yarn ${id}: missing notes ${missing.join(', ')} removed from the thread`,
    })
    const repaired = dropped ? undefined : { ...missing.reduce(withoutPin, yarn), noteIds: kept }
    if (repaired) yarns.set(id, repaired)
    else yarns.delete(id)
    rewound.push([id, yarn, repaired])
  }

  const orphans = [...state.blocks.values()].filter((b) => !state.books.has(b.bookId))
  for (const block of orphans) {
    issues.push({
      line: 0,
      kind: 'dangling-reference',
      raw: JSON.stringify(block),
      message: `block ${block.id}: book ${block.bookId} is missing; block removed`,
    })
  }

  const shown: Block[] = []
  for (const block of state.blocks.values()) {
    if (block.image === undefined || state.assets.has(block.image.assetId)) continue
    if (!state.books.has(block.bookId)) continue // an orphan: dropped above
    issues.push({
      line: 0,
      kind: 'dangling-reference',
      raw: JSON.stringify(block),
      message: figureAsCaptionMessage(block),
    })
    shown.push(block)
  }

  // The blocks repaired in place: the figures as their captions, then any dangling anchors gone.
  const fixed = new Map<string, Block>()
  for (const block of shown) fixed.set(block.id, figureAsCaption(block))
  const isFootnote = (id: string, bookId: string) => {
    const b = state.blocks.get(id)
    return b !== undefined && b.kind === 'footnote' && b.bookId === bookId
  }
  for (const block of state.blocks.values()) {
    if (!state.books.has(block.bookId) || block.marks.length === 0) continue // an orphan: above
    const was = fixed.get(block.id) ?? block
    const now = withoutDanglingAnchors(was, isFootnote)
    if (now !== was) fixed.set(block.id, now)
  }

  if (issues.length === 0 && fixed.size === 0) return { state, issues }
  let blocks = state.blocks
  if (orphans.length > 0 || fixed.size > 0) {
    // The block index carried over, the dropped blocks taken out of it, the figures re-indexed.
    const t = asPMap(state.blocks).asTransient()
    const index = blockIndex(state.blocks).asTransient()
    for (const block of orphans) {
      reindexBlock(index, block, undefined)
      t.delete(block.id)
    }
    for (const [id, p] of fixed) {
      reindexBlock(index, state.blocks.get(id) as Block, p)
      t.set(id, p)
    }
    blocks = t.persist()
    keepBlockIndex(blocks, index.persist())
  }
  const books = booksNamingOnly({ ...state, blocks }, shown)
  // Threads untouched keep their map, and with it their thread index.
  const repairedYarns = rewound.length === 0 ? asPMap(state.yarns) : yarns.persist()
  if (rewound.length > 0) {
    // Carry the thread index over, re-indexing only the threads repaired here.
    const index = threadIndex(state.yarns).asTransient()
    for (const [id, before, after] of rewound) reindex(index, id, before, after)
    keepThreadIndex(repairedYarns, index.persist())
  }
  return {
    state: {
      ...state,
      assets: asPMap(state.assets),
      notes: notes.persist(),
      yarns: repairedYarns,
      books,
      blocks,
    },
    issues,
  }
}

/**
 * `state.books` with each card that a figure of `figures` (made into its caption by
 * {@link figureAsCaption}, in `state` already) named, and that no block of its book names now,
 * taken off the book's `cards`: a figure with no caption has nothing left to name its card with.
 * The map itself when there is none. O(figures) with the block index's counts.
 */
export function booksNamingOnly(
  state: BoardState,
  figures: readonly Block[],
): ReadonlyMap<string, Book> {
  const gone = figures.filter((b) => b.image?.card !== undefined && b.text.length === 0)
  if (gone.length === 0) return state.books
  const t = asPMap(state.books).asTransient()
  for (const block of gone) {
    const book = t.get(block.bookId)
    const card = block.image?.card as string
    if (book === undefined || !book.cards?.includes(card)) continue
    if ((cardCounts(state, book.id).get(card) ?? 0) > 0) continue
    // Emptied, the key goes (absent = none); the record keeps the schema's key order.
    const { cards, rev, ...rest } = book
    const left = cards.filter((n) => n !== card)
    t.set(book.id, {
      ...rest,
      ...(left.length > 0 ? { cards: left } : {}),
      ...(rev === undefined ? {} : { rev }),
    })
  }
  return t.persist()
}

/**
 * `state` without the asset records in `ids` (their files are missing: a restore or an import
 * found nothing to serve), with every note that showed one repaired by {@link repairReferences}
 * (`image: null`). One `dangling-reference` issue per record dropped (`raw` = the asset JSON), in
 * map order, then the repairs' own. Returns the input state unchanged when no id is on it.
 */
export function withoutAssets(
  state: BoardState,
  ids: ReadonlySet<string>,
): { state: BoardState; issues: LoadIssue[] } {
  const issues: LoadIssue[] = []
  const assets = asPMap(state.assets).asTransient()
  for (const [id, asset] of state.assets) {
    if (!ids.has(id)) continue
    issues.push({
      line: 0,
      kind: 'dangling-reference',
      raw: JSON.stringify(asset),
      message: `asset ${id}: its files are missing; record removed`,
    })
    assets.delete(id)
  }
  if (issues.length === 0) return { state, issues }
  const repaired = repairReferences({ ...state, assets: assets.persist() })
  return { state: repaired.state, issues: [...issues, ...repaired.issues] }
}
