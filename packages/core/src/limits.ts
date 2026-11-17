export const LIMITS = {
  maxTextLength: 20_000,
  maxNotes: 500_000,
  maxOpsPerBatch: 500,
  maxLabelLength: 80,
  maxThreadNotes: 200,
  noteMinW: 120,
  noteMaxW: 2000,
  noteMinH: 60,
  noteMaxH: 4000,
  maxCoord: 10_000_000,
  /** Books on the board, trashed ones included until they are purged. */
  maxBooks: 500,
  /** A block's text, in UTF-16 units (as a note's, `maxTextLength`). */
  maxBlockText: 20_000,
  maxBlocksPerBook: 60_000,
  /** A book's text, all its blocks together, in UTF-16 units (500,000 words with room). */
  maxBookChars: 4_000_000,
  maxBookTitle: 200,
  /** Splices one `block.edit` may carry. */
  maxSplicesPerEdit: 1_000,
  /** A position key's characters (`book/position.ts`). */
  maxPosLength: 128,
  /**
   * A block's marks, normalized (bold and italic ranges). Real writing marks a few words a
   * paragraph; 2,000 is a mark every 10 characters of the longest paragraph. It bounds what one
   * `block.edit` carries through its splices.
   */
  maxMarksPerBlock: 2_000,
  /** Blocks one `block.purge` may name. */
  maxPurgeBlocks: 500,
  /**
   * The cards a book's `cards` lists: one per block of the largest book. A book naming
   * more has an incomplete list (the stamp stops adding there; the commit never fails for it).
   */
  maxBookCards: 60_000,
  /** A note's reference (`ref`): free text, line breaks allowed. */
  maxNoteRef: 2_000,
} as const
