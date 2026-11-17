import { describe, expect, it, vi } from 'vitest'
import type { Note } from '../src/index'
import { normalizeForSearch, searchNotes, stateFromRecords } from '../src/index'
import { fixtureId, makeBoard, makeNote } from './fixtures'

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Build a state from texts; note n gets id fixtureId('note', n). Extra overrides per index. */
function stateOf(texts: string[], over: Array<Partial<Note>> = []) {
  const notes = texts.map((text, i) =>
    makeNote({ id: fixtureId('note', i + 1), text, ...(over[i] ?? {}) }),
  )
  return stateFromRecords(makeBoard(), notes)
}

/** Snippet of the single note with this text for this query (fails the test if it does not match). */
function snippetOf(text: string, query: string): string {
  const hit = searchNotes(stateOf([text]), query)[0]
  expect(hit).toBeDefined()
  return hit?.snippet ?? ''
}

const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id)
const id = (n: number) => fixtureId('note', n)

describe('normalizeForSearch', () => {
  it('applies NFKC then lowercases', () => {
    expect(normalizeForSearch('ⒶⒷⒸ')).toBe('abc')
    expect(normalizeForSearch('cafe\u0301')).toBe('café')
    expect(normalizeForSearch('Hello')).toBe('hello')
  })
})

describe('searchNotes: matching', () => {
  it('matches compatibility letters with a plain query (NFKC)', () => {
    const state = stateOf(['ⒶⒷⒸ'])
    expect(ids(searchNotes(state, 'abc'))).toEqual([id(1)])
    expect(ids(searchNotes(state, 'ABC'))).toEqual([id(1)])
  })

  it('matches a decomposed accent against a composed one, both ways', () => {
    expect(ids(searchNotes(stateOf(['cafe\u0301']), 'café'))).toEqual([id(1)])
    expect(ids(searchNotes(stateOf(['café']), 'cafe\u0301'))).toEqual([id(1)])
  })

  it('matches a substring in another script', () => {
    expect(ids(searchNotes(stateOf(['δένωκόμπο']), 'κόμπο'))).toEqual([id(1)])
  })

  it('returns nothing when no note matches', () => {
    expect(searchNotes(stateOf(['hello']), 'zzz')).toEqual([])
  })

  it('returns [] for an empty or whitespace-only query', () => {
    const state = stateOf(['hello'])
    expect(searchNotes(state, '')).toEqual([])
    expect(searchNotes(state, '   ')).toEqual([])
    expect(searchNotes(state, '\u00a0\t\n')).toEqual([])
  })

  it('trims surrounding whitespace from the query', () => {
    expect(ids(searchNotes(stateOf(['hello world']), '  world '))).toEqual([id(1)])
  })

  it('is consistent for final sigma, which lowercases by context', () => {
    expect(ids(searchNotes(stateOf(['ΟΔΟΣ']), 'οδοσ'))).toEqual([id(1)])
    expect(ids(searchNotes(stateOf(['ΟΔΟΣ']), 'ΟΔΟΣ'))).toEqual([id(1)])
  })

  it('does not mutate the state', () => {
    const state = stateOf(['b match', 'a match'])
    const before = [...state.notes.values()]
    searchNotes(state, 'match')
    expect([...state.notes.values()]).toEqual(before)
    expect(state.notes.size).toBe(2)
  })
})

describe('searchNotes: ranking', () => {
  it('ranks a match at the start first, then earlier position, then newer updatedAt, then id', () => {
    const state = stateOf(
      [
        'xx cat', // 1: pos 3
        'cat', // 2: pos 0, older
        'x cat', // 3: pos 2
        'cat again', // 4: pos 0, newer
        'cat tie', // 5: pos 0, same updatedAt as 4 -> id order
      ],
      [
        { updatedAt: '2026-10-27T10:00:00.000Z' },
        { updatedAt: '2026-10-27T10:00:00.000Z' },
        { updatedAt: '2026-10-27T12:00:00.000Z' },
        { updatedAt: '2026-10-27T11:00:00.000Z' },
        { updatedAt: '2026-10-27T11:00:00.000Z' },
      ],
    )
    expect(ids(searchNotes(state, 'cat'))).toEqual([id(4), id(5), id(2), id(3), id(1)])
  })

  it('is independent of map insertion order for ties', () => {
    const a = makeNote({ id: id(1), text: 'tie' })
    const b = makeNote({ id: id(2), text: 'tie' })
    expect(ids(searchNotes(stateFromRecords(makeBoard(), [b, a]), 'tie'))).toEqual([id(1), id(2)])
  })

  it('measures the match position in the normalized text consistently', () => {
    // An accented prefix: position is still earlier than a later match elsewhere.
    const state = stateOf(['àéî Knot', 'Knot'])
    expect(ids(searchNotes(state, 'Knot'))).toEqual([id(2), id(1)])
  })
})

describe('searchNotes: limit', () => {
  const state = stateOf(Array.from({ length: 30 }, (_, i) => `note ${i} match`))

  it('defaults to 20', () => {
    expect(searchNotes(state, 'match')).toHaveLength(20)
  })

  it('respects an explicit limit', () => {
    expect(searchNotes(state, 'match', 5)).toHaveLength(5)
    expect(searchNotes(state, 'match', 100)).toHaveLength(30)
  })

  it('returns the best-ranked hits when limited', () => {
    const s = stateOf(['xx cat', 'cat'])
    expect(ids(searchNotes(s, 'cat', 1))).toEqual([id(2)])
  })

  it('returns [] for a limit of 0', () => {
    expect(searchNotes(state, 'match', 0)).toEqual([])
  })
})

describe('searchNotes: snippets', () => {
  // Snippet = up to 80 UTF-16 code units of the ORIGINAL text, plus a leading and/or trailing '…'.
  const MAX_SNIPPET = 80 + 2

  it('returns the whole short text uncut, with no markers', () => {
    expect(searchNotes(stateOf(['hello world']), 'world')[0]?.snippet).toBe('hello world')
  })

  it('cuts a long text to <= 80 chars around the match, marking both cut edges', () => {
    const text = `${'a'.repeat(200)}NEEDLE${'b'.repeat(200)}`
    const snippet = snippetOf(text, 'needle')
    expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET)
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet).toContain('NEEDLE') // original casing preserved
  })

  it('marks only the trailing edge when the match is near the start', () => {
    const text = `needle${'b'.repeat(200)}`
    const snippet = snippetOf(text, 'needle')
    expect(snippet.startsWith('…')).toBe(false)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBe(81)
    expect(snippet.startsWith('needle')).toBe(true)
  })

  it('marks only the leading edge when the match is near the end', () => {
    const text = `${'b'.repeat(200)}needle`
    const snippet = snippetOf(text, 'needle')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(false)
    expect(snippet.length).toBe(81)
    expect(snippet.endsWith('needle')).toBe(true)
  })

  it('shows the original text, not the normalized text', () => {
    const snippet = snippetOf('ⒶⒷⒸ cafe\u0301', 'café')
    expect(snippet).toBe('ⒶⒷⒸ cafe\u0301')
  })

  it('maps the match back to the original when NFKC shrinks the text before it', () => {
    // Each e\u0301 (2 code units) normalizes to é (1), so normalized offsets drift left of original ones.
    const prefix = 'e\u0301'.repeat(120)
    const text = `${prefix}cafe\u0301${prefix}`
    const snippet = snippetOf(text, 'café')
    expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET)
    expect(snippet).toContain('cafe\u0301')
  })

  it('maps the match back to the original when lowercasing grows the text before it', () => {
    // 'İ'.toLowerCase() is 2 code units, so normalized offsets drift right of original ones.
    const text = `${'İ'.repeat(150)}needle${'İ'.repeat(150)}`
    const snippet = snippetOf(text, 'needle')
    expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET)
    expect(snippet).toContain('needle')
  })

  it('never splits a surrogate pair at either cut edge', () => {
    for (let pad = 0; pad < 4; pad++) {
      const text = `${'x'.repeat(pad)}${'😀'.repeat(60)}needle${'😀'.repeat(60)}`
      const snippet = snippetOf(text, 'needle')
      expect(snippet).toContain('needle')
      expect(snippet).not.toMatch(LONE_SURROGATE)
      expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET)
    }
  })

  it('can match an astral character itself and keep it whole', () => {
    const text = `${'a'.repeat(100)}😀${'a'.repeat(100)}`
    const snippet = snippetOf(text, '😀')
    expect(snippet).toContain('😀')
    expect(snippet).not.toMatch(LONE_SURROGATE)
  })

  it('truncates (from the match start) when the match itself exceeds 80 chars', () => {
    const q = 'm'.repeat(120)
    const snippet = snippetOf(`ab${q}cd`, q)
    expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET)
    expect(snippet).toContain('m'.repeat(80))
  })
})

describe('searchNotes: cost', () => {
  it('only segments/maps the top-limit hits, never non-matching or lower-ranked notes', () => {
    const state = stateOf([
      ...Array.from({ length: 30 }, (_, i) => `note ${i} match`),
      ...Array.from({ length: 30 }, (_, i) => `other ${i}`),
    ])
    const spy = vi.spyOn(Intl.Segmenter.prototype, 'segment')
    try {
      searchNotes(state, 'match', 5)
      expect(spy).toHaveBeenCalledTimes(5)
      spy.mockClear()
      searchNotes(state, 'zzz')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('gives the same results on repeated calls (cached folds)', () => {
    const state = stateOf(['xx cat', 'cat', 'ⒸⒶⓉ'])
    expect(searchNotes(state, 'cat')).toEqual(searchNotes(state, 'cat'))
  })
})

describe('searchNotes: NFKC growth', () => {
  it('maps a match inside an expanding compatibility character (℡ -> TEL)', () => {
    expect(searchNotes(stateOf(['x℡y']), 'e')[0]?.snippet).toBe('x℡y')
    const long = `${'a'.repeat(120)}x℡y${'b'.repeat(120)}`
    const snippet = snippetOf(long, 'e')
    expect(snippet).toContain('℡')
    expect(snippet.length).toBeLessThanOrEqual(82)
  })

  it('maps a match inside a ligature (ﬁ -> fi)', () => {
    expect(searchNotes(stateOf(['aﬁb']), 'fi')[0]?.snippet).toBe('aﬁb')
    const snippet = snippetOf(`${'a'.repeat(120)}aﬁb${'b'.repeat(120)}`, 'fi')
    expect(snippet).toContain('ﬁ')
  })
})
