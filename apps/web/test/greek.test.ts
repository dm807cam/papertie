import { greekLines } from '../src/notes/greek'

describe('greekLines', () => {
  it('greekLines of empty text is empty', () => expect(greekLines('', 240)).toEqual([]))

  it('greekLines caps at maxLines and stays in (0,1]', () => {
    const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20)
    for (const text of [long, '🧵'.repeat(200), `${'a'.repeat(300)}\n\n${'🧵'.repeat(120)}`]) {
      const bars = greekLines(text, 184)
      expect(bars.length).toBe(6)
      for (const b of bars) {
        expect(b).toBeGreaterThan(0)
        expect(b).toBeLessThanOrEqual(1)
      }
      expect(greekLines(text, 184, 3)).toHaveLength(3)
    }
  })

  it('a short line is one partial bar', () => {
    const bars = greekLines('next step', 184)
    expect(bars).toHaveLength(1)
    expect(bars[0]).toBeLessThan(0.6)
  })

  it('wide glyphs take more room than Latin ones', () => {
    const [latin] = greekLines('abcdefgh', 400)
    const [wide] = greekLines('🧵🧵🧵🧵🧵🧵🧵🧵', 400)
    expect(wide).toBeGreaterThan(latin as number)
  })

  it('keeps one bar per hard line and skips blank lines', () => {
    expect(greekLines('one\ntwo\n\nthree', 184)).toHaveLength(3)
    expect(greekLines('\n\n  \n', 184)).toEqual([])
  })

  it('is deterministic', () => {
    const text = 'Tie ideas together with yarn. Thought to thought, by thread.'.repeat(4)
    expect(greekLines(text, 184)).toEqual(greekLines(text, 184))
  })

  it('degenerate widths and line caps give no bars', () => {
    for (const w of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(greekLines('text', w)).toEqual([])
    }
    expect(greekLines('text', 184, 0)).toEqual([])
    expect(greekLines('text', 184, Number.NaN)).toEqual([])
  })
})
