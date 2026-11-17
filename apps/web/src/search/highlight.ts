import { foldForSearch } from '@papertie/core'

// Grapheme clusters keep NFKC-composing sequences together (a letter and its combining accent are one cluster),
// the same unit core's snippets are cut on.
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** Core's matching fold, so the mark lands where the search matched. */
const foldUnit = foldForSearch

/**
 * Where `query` first matches in `text`, as the span `[start, end)` of the ORIGINAL text, or null.
 * Folding changes lengths (e + U+0301 is two units, é one), so the text is folded a cluster at a time and
 * each folded unit remembers the cluster it came from; a match always begins and ends on a cluster
 * boundary. Run on the few rows shown, never on the board.
 */
export function matchRange(text: string, query: string): [number, number] | null {
  const needle = foldUnit(query).trim()
  if (needle === '') return null
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  for (const { segment, index } of segmenter.segment(text)) {
    const f = foldUnit(segment)
    for (let i = 0; i < f.length; i++) {
      starts.push(index)
      ends.push(index + segment.length)
    }
    folded += f
  }
  const pos = folded.indexOf(needle)
  if (pos < 0) return null
  const start = starts[pos]
  const end = ends[pos + needle.length - 1]
  return start === undefined || end === undefined ? null : [start, end]
}
