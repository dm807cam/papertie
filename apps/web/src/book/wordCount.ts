import { pagePace, slicer } from '../sync/pace'
import type { EditorKind } from './editor/BookEditor'
import { countWords } from './typography'

/**
 * The text of block `b` that is the book's words: a prompt's are not (a note to the writer, never
 * exported), nor a footnote's; a caption's are. Null when there is no block.
 */
export const counted = (b: { kind: EditorKind; text: string } | undefined): string | null =>
  b === undefined || b.kind === 'prompt' || b.kind === 'footnote' ? null : b.text

/** How many block texts the word counts read (for the test that a keystroke reads O(1)). */
export const wordCountStats = { reads: 0 }

/**
 * A book's word count: the book as shown counted once, in 4 ms slices after the page shows; a
 * change adds the words of a block's new text less those of its old (a keystroke reads its one
 * block twice), never the book. The two add up in any order, so a change made while the count
 * runs is counted right; and the count keeps nothing per block (a long book's count makes no
 * garbage to collect).
 */
export class WordCount {
  private sum = 0
  private delta = 0
  private done = false
  private stopped = false

  constructor(private readonly told: (words: number) => void) {}

  get total(): number {
    return this.sum + this.delta
  }

  /** Count the book as shown, in its chunks (core's index, never flattened), a slice at a time. */
  async start(chunks: readonly (readonly { kind: EditorKind; text: string }[])[]): Promise<void> {
    // Never in the task that put the page up: its first slice is a task of its own.
    await pagePace.yield()
    const pause = slicer()
    let n = 0
    for (const chunk of chunks) {
      for (const b of chunk) {
        if (this.stopped) return
        const text = counted(b)
        if (text !== null) this.sum += read(text)
        if ((++n & 63) === 0) await pause()
      }
    }
    if (this.stopped) return
    this.done = true
    this.told(this.total)
  }

  /** A block's text changed from `before` to `after` (null: it was not there, or is gone). */
  change(before: string | null, after: string | null): void {
    if (before === after) return
    this.delta += (after === null ? 0 : read(after)) - (before === null ? 0 : read(before))
    if (this.done) this.told(this.total)
  }

  stop(): void {
    this.stopped = true
  }
}

const read = (text: string): number => {
  wordCountStats.reads++
  return countWords(text)
}
