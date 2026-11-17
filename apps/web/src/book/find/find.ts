/**
 * Find in the writer: every match of a query in the whole book (every block
 * held, prompts and captions included), by the board's own search fold (`foldForSearch`: case
 * and width folded, accents as typed), mapped back to each block's own text. Whole-book work, so
 * only on the user's command and in slices (`sync/pace.ts`, 4 ms), never in a keystroke's task.
 */
import { type BoardState, bookBlocks, foldForSearch } from '@papertie/core'
import { pagePace, type SlicePace, slicer } from '../../sync/pace'

/** A match: offsets in its block's text, `[from, to)`. */
export interface Match {
  blockId: string
  from: number
  to: number
}

/** Blocks read between two looks at the slice's clock. */
export const FIND_STEP = 64
/** The slicer's budget (ms). */
const SLICE_MS = 4

const ascii = (s: string) => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false
  return true
}
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** Every occurrence of `needle` in `hay`, none overlapping. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = []
  for (let p = hay.indexOf(needle); p >= 0; p = hay.indexOf(needle, p + needle.length)) out.push(p)
  return out
}

/**
 * `query`'s matches in `text`, by the board's fold (`foldForSearch`), mapped back to `text`'s own
 * offsets. ASCII text folds unit for unit (its lowercase); other text is folded a grapheme
 * cluster at a time, each folded unit remembering its cluster's span, so a match never cuts a
 * cluster (a ligature, a decomposed accent) and maps to the clusters it covers.
 */
export function matchesIn(text: string, query: string): Array<[number, number]> {
  const needle = foldForSearch(query).trim()
  if (needle === '' || text === '') return []
  if (ascii(text)) return occurrences(text.toLowerCase(), needle).map((p) => [p, p + needle.length])
  // The cheap whole-text fold first: most blocks have no match and are never segmented.
  if (!foldForSearch(text).includes(needle)) return []
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  for (const { segment, index } of segmenter.segment(text)) {
    const f = foldForSearch(segment)
    for (let i = 0; i < f.length; i++) {
      starts.push(index)
      ends.push(index + segment.length)
    }
    folded += f
  }
  const out: Array<[number, number]> = []
  let last = -1
  for (const p of occurrences(folded, needle)) {
    const from = starts[p] as number
    const to = ends[p + needle.length - 1] as number
    // Two matches within one cluster's span are one.
    if (from < last) continue
    out.push([from, to])
    last = to
  }
  return out
}

/**
 * Every match of `query` in the book, in book order, a slice (≤ 4 ms) at a time; cancelled by
 * `signal`. It begins after a task boundary (never in the keystroke's own task), says what each
 * slice found as the slice ends (`onSome(matches, false)`), and `done` once, at the end. `pace`:
 * the page's own, or a test's.
 */
export function findInBook(
  state: BoardState,
  bookId: string,
  query: string,
  o: {
    signal: AbortSignal
    onSome(matches: readonly Match[], done: boolean): void
    pace?: SlicePace
  },
): void {
  const pace: SlicePace = o.pace ?? pagePace
  let found: Match[] = []
  // What a slice found is said as it ends, before the page gets its turn.
  const tick = slicer(
    {
      hidden: () => pace.hidden(),
      clock: pace.clock,
      yield: () => {
        if (found.length > 0 && !o.signal.aborted) {
          o.onSome(found, false)
          found = []
        }
        return pace.yield()
      },
    },
    SLICE_MS,
  )
  void (async () => {
    await pace.yield()
    if (o.signal.aborted) return
    const chunks = bookBlocks(state.blocks, bookId).chunks
    let read = 0
    for (const chunk of chunks) {
      for (const b of chunk) {
        for (const [from, to] of matchesIn(b.text, query)) found.push({ blockId: b.id, from, to })
        if (++read % FIND_STEP === 0) {
          await tick()
          if (o.signal.aborted) return
        }
      }
    }
    o.onSome(found, true)
  })()
}
