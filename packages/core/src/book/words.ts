const LETTER = /[\p{L}\p{N}]/u
const INSIDE = /[\p{L}\p{N}\p{M}]/u

/** Whether code unit `c` (at `i` of `text`) is a letter or digit: ASCII at once, else Unicode's. */
function wordChar(text: string, i: number, re: RegExp): boolean {
  const c = text.charCodeAt(i)
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
  return re.test(text[i] as string)
}

/**
 * The words of `text`, as the writer counts them (the web's `book/typography.ts`): runs starting
 * with a letter or digit, going on through letters, digits, marks and the joiners of a word
 * (' ’ - .). For the server's History rows (a backup's books and words).
 */
export function countWords(text: string): number {
  let n = 0
  let inWord = false
  for (let i = 0; i < text.length; i++) {
    if (inWord) {
      if (wordChar(text, i, INSIDE)) continue
      const c = text[i]
      if (c === "'" || c === '’' || c === '-' || c === '.') continue
      inWord = false
    } else if (wordChar(text, i, LETTER)) {
      inWord = true
      n++
    }
  }
  return n
}

/** Whether a block of `kind` holds the book's words: a prompt's and a footnote's are not. */
export const countedKind = (kind: string): boolean => kind !== 'prompt' && kind !== 'footnote'
