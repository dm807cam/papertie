/**
 * The writer's typing rules: typography corrected as you type, and the Markdown
 * accelerators of the selection popover's controls, as pure functions of a block's text.
 */
import { applySplices } from '@papertie/core'
import { accelerate, countWords, smartTypography } from '../../src/book/typography'

/** `text` with the keystroke ending at `at` corrected. */
const fix = (text: string, at: number, lang: 'de' | 'en') =>
  applySplices(text, smartTypography(text, at, lang))

/** Typing `keys` one at a time, each corrected as it lands. */
function typed(keys: string, lang: 'de' | 'en'): string {
  let text = ''
  for (const k of keys) {
    const before = text.length
    text = fix(text + k, before + 1, lang)
  }
  return text
}

describe('smartTypography', () => {
  it('corrects quotes, dashes and ellipses as each key lands, by the book’s language', () => {
    expect(typed('"Hello," she said -- softly...', 'en')).toBe('“Hello,” she said – softly…')
    expect(typed('"Hallo", sagte sie -- leise...', 'de')).toBe('„Hallo“, sagte sie – leise…')
    expect(typed("It's 'quiet' here", 'en')).toBe('It’s ‘quiet’ here')
    expect(typed("Es ist 'still' hier, gib's mir", 'de')).toBe('Es ist ‚still‘ hier, gib’s mir')
    expect(typed('("quoted")', 'en')).toBe('(“quoted”)')
  })

  it('touches only the keystroke and what it completes', () => {
    // Nothing to correct: no splice at all.
    expect(smartTypography('plain', 5, 'en')).toEqual([])
    // A dash typed far from another changes only its own pair.
    expect(fix('a - b -', 7, 'en')).toBe('a - b -')
    expect(fix('a - b --', 8, 'en')).toBe('a - b –')
    // An em dash is a third hyphen after an en dash.
    expect(fix('a –-', 4, 'en')).toBe('a —')
    // A quote typed earlier in the text is never revisited.
    expect(fix('"a" b', 5, 'en')).toBe('"a" b')
  })
})

describe('accelerate', () => {
  it('turns a line start into its kind, the syntax gone', () => {
    expect(accelerate('# ', 2, 'p')).toEqual({ splices: [{ at: 0, del: 2, ins: '' }], kind: 'h1' })
    expect(accelerate('## ', 3, 'p')).toEqual({
      splices: [{ at: 0, del: 3, ins: '' }],
      kind: 'h2',
    })
    expect(accelerate('> ', 2, 'p')).toEqual({
      splices: [{ at: 0, del: 2, ins: '' }],
      kind: 'quote',
    })
    expect(accelerate('- ', 2, 'p')).toEqual({ splices: [{ at: 0, del: 2, ins: '' }], kind: 'li' })
    // Before existing text, too.
    expect(accelerate('# On collecting', 2, 'p')).toEqual({
      splices: [{ at: 0, del: 2, ins: '' }],
      kind: 'h1',
    })
    // Not past the start, not when the block is that kind already, not without the space.
    expect(accelerate('a # ', 4, 'p')).toBeNull()
    expect(accelerate('# ', 2, 'h1')).toBeNull()
    expect(accelerate('#', 1, 'p')).toBeNull()
  })

  it('turns *…* into italic and **…** into bold as the closing star is typed', () => {
    expect(accelerate('a *word*', 8, 'p')).toEqual({
      splices: [
        { at: 7, del: 1, ins: '' },
        { at: 2, del: 1, ins: '' },
      ],
      addMarks: [{ t: 'i', from: 2, to: 6 }],
    })
    expect(accelerate('a **two words**', 15, 'p')).toEqual({
      splices: [
        { at: 13, del: 2, ins: '' },
        { at: 2, del: 2, ins: '' },
      ],
      addMarks: [{ t: 'b', from: 2, to: 11 }],
    })
    // Half a bold run is not an italic one; spaces inside the stars are not emphasis.
    expect(accelerate('a **word*', 9, 'p')).toBeNull()
    expect(accelerate('a * word*', 9, 'p')).toBeNull()
    expect(accelerate('a *word *', 9, 'p')).toBeNull()
    expect(accelerate('2 * 3 * 4', 7, 'p')).toBeNull()
  })
})

describe('countWords', () => {
  it('counts words, not punctuation', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('  ')).toBe(0)
    expect(countWords('Wer schreibt, denkt zweimal – einmal.')).toBe(5)
    expect(countWords('It’s 3 o’clock … well-known')).toBe(4)
  })
})
