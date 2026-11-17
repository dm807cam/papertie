import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contrastRatio, PALETTE, PALETTE_TOKENS } from '@papertie/core'
import {
  isLatinOnly,
  isLongTitle,
  parseNoteText,
  textOffset,
  titleClass,
  titleFace,
  titleSize,
  titleWidth,
} from '../src/notes/noteText'

describe('parseNoteText', () => {
  it('empty and blank text have no blocks', () => {
    expect(parseNoteText('')).toEqual([])
    expect(parseNoteText('  \n\n \r\n')).toEqual([])
  })

  it('a single line is just a title', () => {
    expect(parseNoteText('Paper goods')).toEqual([{ kind: 'title', text: 'Paper goods' }])
  })

  it('the first non-empty line is the title, trimmed', () => {
    expect(parseNoteText('\n\n  Spring trip  ')).toEqual([{ kind: 'title', text: 'Spring trip' }])
  })

  it('a Latin-only second line is the subtitle', () => {
    expect(parseNoteText('Paper goods\nStationery Design')).toEqual([
      { kind: 'title', text: 'Paper goods' },
      { kind: 'subtitle', text: 'Stationery Design' },
    ])
  })

  it('a second line in another script is body', () => {
    expect(parseNoteText('Weekend plans\nΑγορά στις εννιά')).toEqual([
      { kind: 'title', text: 'Weekend plans' },
      { kind: 'body', text: 'Αγορά στις εννιά' },
    ])
  })

  it('a blank line between title and a Latin line makes it body, not subtitle', () => {
    expect(parseNoteText('Hub\n\nEverything routes through here.')).toEqual([
      { kind: 'title', text: 'Hub' },
      { kind: 'body', text: 'Everything routes through here.' },
    ])
  })

  it('bullets with "-" and "•", after optional spaces', () => {
    expect(
      parseNoteText(
        'Spring trip\nSpring Journey\n- Orchard in bloom\n  • Old town streets\n-The paper shop',
      ),
    ).toEqual([
      { kind: 'title', text: 'Spring trip' },
      { kind: 'subtitle', text: 'Spring Journey' },
      { kind: 'bullet', text: 'Orchard in bloom' },
      { kind: 'bullet', text: 'Old town streets' },
      { kind: 'bullet', text: 'The paper shop' },
    ])
  })

  it('a bullet right after the title is a bullet, not a subtitle', () => {
    expect(parseNoteText('Plan\n- buy paper')).toEqual([
      { kind: 'title', text: 'Plan' },
      { kind: 'bullet', text: 'buy paper' },
    ])
  })

  it('a note that starts with a bullet has no title', () => {
    expect(parseNoteText('- one\n- two')).toEqual([
      { kind: 'bullet', text: 'one' },
      { kind: 'bullet', text: 'two' },
    ])
  })

  it('CRLF and CR line ends', () => {
    expect(parseNoteText('Stock\r\nMaterials\r\n- rag\r- linen')).toEqual([
      { kind: 'title', text: 'Stock' },
      { kind: 'subtitle', text: 'Materials' },
      { kind: 'bullet', text: 'rag' },
      { kind: 'bullet', text: 'linen' },
    ])
  })

  it('consecutive body lines form one block; inner blank lines stay, edge ones go', () => {
    expect(parseNoteText('T\n\nfirst\n\nsecond\n\n- b\n\nafter\n')).toEqual([
      { kind: 'title', text: 'T' },
      { kind: 'body', text: 'first\n\nsecond' },
      { kind: 'bullet', text: 'b' },
      { kind: 'body', text: 'after' },
    ])
  })

  it('keeps long unbroken text whole', () => {
    const url = `https://papertie.example/${'a'.repeat(300)}`
    const word = '12345678'.repeat(30)
    expect(parseNoteText(`${url}\n${word}`)).toEqual([
      { kind: 'title', text: url },
      { kind: 'body', text: word },
    ])
  })
})

describe('textOffset', () => {
  it('maps a place in each shown block back into the text', () => {
    const text = '\n  Spring trip  \nSpring Journey\n  - Orchard in bloom\n\nfirst\n\nsecond\n'
    const blocks = parseNoteText(text)
    expect(blocks.map((b) => b.kind)).toEqual(['title', 'subtitle', 'bullet', 'body'])
    blocks.forEach((b, i) => {
      // Every character of every block lands on that character in the text.
      for (let k = 0; k < b.text.length; k++) {
        expect(text[textOffset(text, i, k)]).toBe(b.text[k])
      }
    })
    // After a block's last character: right after it.
    expect(textOffset(text, 0, 3)).toBe(text.indexOf('Spring trip') + 3)
    expect(textOffset(text, 2, 99)).toBe(text.indexOf('Orchard in bloom') + 16)
  })

  it('counts CRLF and CR as one character, as a textarea does', () => {
    const text = 'Stock\r\nMaterials\r\n- rag\r- linen'
    const lf = text.replace(/\r\n?/g, '\n')
    expect(lf[textOffset(text, 2, 0)]).toBe('r')
    expect(lf[textOffset(text, 3, 0)]).toBe('l')
  })

  it('a block that is not there is the end of the text', () => {
    expect(textOffset('Plan\r\n', 4, 0)).toBe(5)
    expect(textOffset('', 0, 0)).toBe(0)
    expect(textOffset('Plan', 0, Number.NaN)).toBe(4)
  })
})

describe('isLatinOnly', () => {
  it('accepts Latin letters, digits, spaces and basic punctuation', () => {
    for (const s of [
      'Spring Journey',
      'Materials',
      "Milan, spring '26",
      'Café — déjà vu!',
      'A/B (2)',
    ])
      expect(isLatinOnly(s)).toBe(true)
  })

  it('rejects other scripts, emoji, empty and letterless lines', () => {
    for (const s of ['Χαρτί', 'Paper Χαρτί', 'Бумага', 'tea 🍵', '', '   ', '2026', '— !'])
      expect(isLatinOnly(s)).toBe(false)
  })
})

/** sRGB hex mix as CSS `color-mix(in srgb, a p%, b)` computes it. */
function mix(a: string, b: string, p: number): string {
  const ch = (hex: string, i: number) => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) * p + ch(b, i) * (1 - p)))
  return `#${out.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

describe('subtitle ink', () => {
  const css = readFileSync(join(__dirname, '../src/notes/note.css'), 'utf8')
  const m =
    /\.note-subtitle\s*{[^}]*color-mix\(in srgb, var\(--note-ink\) (\d+)%, var\(--note-paper\)\)/.exec(
      css,
    )

  it('is a mix of ink and paper that stays at 4.5:1 or better on every paper', () => {
    expect(m).not.toBeNull()
    const p = Number(m?.[1]) / 100
    for (const token of PALETTE_TOKENS) {
      const { ink, paper } = PALETTE[token]
      expect(contrastRatio(mix(ink, paper, p), paper)).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('isLongTitle', () => {
  it('keeps short titles large and steps long ones down', () => {
    expect(isLongTitle('Spring trip', 348)).toBe(false)
    expect(isLongTitle('Ideas', 320)).toBe(false)
    expect(isLongTitle('Pin it. Move on.', 148)).toBe(false)
    expect(isLongTitle('Ask about the apricot dye workshop.', 188)).toBe(true)
    expect(isLongTitle('A knot ties thoughts together.', 148)).toBe(true)
  })

  it('treats a bad width as long', () => {
    for (const w of [0, -1, Number.NaN]) expect(isLongTitle('Hub', w)).toBe(true)
  })

  it('steps a short title down when its longest word is wider than the measure', () => {
    // "Calligraphy" alone is wider than 100 px at every step: the floor, 21 px.
    expect(isLongTitle('Calligraphy class', 100)).toBe(true)
    expect(isLongTitle('Calligraphy class', 260)).toBe(false)
    // A shorter word steps down too, not to the floor.
    expect(isLongTitle('Spring', 90)).toBe(false)
  })
})

describe('titleSize', () => {
  it('takes the largest size from 30 to 21 px at which the longest word fits', () => {
    expect(titleSize('Spring trip', 168)).toBe(30)
    expect(titleSize('Calligraphy class', 168)).toBe(29)
    expect(titleSize('Calligraphy', 140)).toBe(24)
    expect(titleSize('Calligraphy', 100)).toBe(21)
    // A sentence for a title is the long-title size.
    expect(titleSize('Ask about the apricot dye workshop.', 188)).toBe(21)
    for (const w of [0, -1, Number.NaN]) expect(titleSize('Hub', w)).toBe(21)
  })
})

describe('titleSize by the word’s own overflow', () => {
  it('steps a single long word down only as far as it must, a pixel at a time', () => {
    // "Phrasebook" (5.2 em, as estimated here) fits 120 px at 23 px, not 24: it takes 23, never
    // the 21 px floor beside its 30 px neighbours.
    expect(titleSize('Phrasebook', 120)).toBe(23)
    expect(titleClass('Phrasebook', 120)).toBe('note-title note-title--23')
    // Every size from 30 down to the floor is a step; the largest that fits is taken.
    for (let w = 100; w <= 200; w++) {
      const px = titleSize('Sketchbook', w)
      expect(px).toBeGreaterThanOrEqual(21)
      expect(px).toBeLessThanOrEqual(30)
      if (px > 21) expect(5.2 * px).toBeLessThanOrEqual(w)
      if (px < 30) expect(5.2 * (px + 1)).toBeGreaterThan(w)
    }
  })
})

describe('titleWidth', () => {
  it('keeps 34 px from each side of the paper for the title, clear of an edge pin', () => {
    // Rustic and smooth: 26 px of padding, 8 more for the title; print: 18, 16 more.
    expect(titleWidth(168, 'rustic', false)).toBe(152)
    expect(titleWidth(168, 'smooth', false)).toBe(152)
    expect(titleWidth(200, 'print', false)).toBe(168)
    // A tag's title is its own: hooked at the top, no edge pins beside it.
    expect(titleWidth(92, 'rustic', true)).toBe(92)
  })

  it('keeps that room only on a side that carries an edge pin', () => {
    expect(titleWidth(168, 'rustic', false, '')).toBe(168)
    expect(titleWidth(168, 'rustic', false, 'left')).toBe(160)
    expect(titleWidth(168, 'rustic', false, 'right')).toBe(160)
    expect(titleWidth(168, 'rustic', false, 'left right')).toBe(152)
    expect(titleWidth(200, 'print', false, 'right')).toBe(184)
  })
})

describe('titleFace', () => {
  it('counts the loads of the title face that measured titles waited for, and nothing else', () => {
    const fonts = new EventTarget() as EventTarget & { check(): boolean }
    let loaded = false
    fonts.check = () => loaded
    const g = globalThis as { document?: unknown; OffscreenCanvas?: unknown }
    const was = g.document
    g.document = { fonts }
    const had = g.OffscreenCanvas
    g.OffscreenCanvas = class {
      getContext() {
        return { font: '', measureText: (t: string) => ({ width: t.length * 20 }) }
      }
    }
    try {
      titleFace.reset()
      const seen: number[] = []
      const off = titleFace.subscribe(() => seen.push(titleFace.get()))
      // A face that is not the title's: nothing.
      const done = (family: string) => {
        const e = new Event('loadingdone') as Event & { fontfaces: { family: string }[] }
        e.fontfaces = [{ family }]
        fonts.dispatchEvent(e)
      }
      titleSize('Phrasebook', 160)
      done('"Instrument Sans"')
      expect(seen).toEqual([])
      // The title face: the titles measured meanwhile are set again, once.
      loaded = true
      done('"Newsreader"')
      expect(seen).toEqual([1])
      // Nothing measured before it came: a later load asks nothing again.
      titleSize('Phrasebook', 160)
      done('"Newsreader"')
      expect(seen).toEqual([1])
      off()
    } finally {
      g.document = was
      g.OffscreenCanvas = had
      titleFace.reset()
    }
  })
})

describe('titleClass', () => {
  it('marks a title for its size', () => {
    expect(titleClass('Spring trip', 168)).toBe('note-title')
    expect(titleClass('Calligraphy class', 168)).toBe('note-title note-title--29')
    expect(titleClass('Calligraphy', 100)).toBe('note-title note-title--long')
    expect(titleClass('A knot ties the loose thoughts.', 148)).toBe('note-title note-title--long')
  })
})
