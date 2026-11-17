import fc from 'fast-check'
import { SPLICE_WORK } from '../../src/book/splice'
import {
  appendSplice,
  applySplices,
  diffSplices,
  invertSplices,
  LIMITS,
  type Mark,
  mapMarks,
  normalizeMarks,
  type Splice,
  subtractMarks,
} from '../../src/index'

const RUNS = { numRuns: 5_000 }

const b = (from: number, to: number): Mark => ({ t: 'b', from, to })
const i = (from: number, to: number): Mark => ({ t: 'i', from, to })
const ins = (at: number, text: string): Splice => ({ at, del: 0, ins: text })
const del = (at: number, n: number): Splice => ({ at, del: n, ins: '' })

describe('applySplices', () => {
  it('applies splices in order, each against the text the one before it left', () => {
    expect(applySplices('hello world', [del(0, 5), ins(0, 'goodbye')])).toBe('goodbye world')
    expect(applySplices('abc', [ins(3, 'd'), ins(4, 'e'), { at: 1, del: 1, ins: 'B' }])).toBe(
      'aBcde',
    )
    expect(applySplices('abc', [])).toBe('abc')
  })

  it('refuses a splice past the end of the text', () => {
    expect(() => applySplices('abc', [ins(4, 'x')])).toThrow(RangeError)
    expect(() => applySplices('abc', [del(2, 2)])).toThrow(RangeError)
    expect(() => applySplices('abc', [{ at: -1, del: 0, ins: 'x' }])).toThrow(RangeError)
  })
})

describe('mapMarks', () => {
  it('mapMarks: text typed inside a mark or at its end takes it, at its start does not; a mark whose text is all deleted goes', () => {
    // "bold" bold at [2, 6) in "a bold b".
    const marks = [b(2, 6)]
    expect(mapMarks(marks, [ins(4, 'xx')])).toEqual([b(2, 8)])
    expect(mapMarks(marks, [ins(6, 'er')])).toEqual([b(2, 8)])
    expect(mapMarks(marks, [ins(2, 'un')])).toEqual([b(4, 8)])
    expect(mapMarks(marks, [ins(0, '>')])).toEqual([b(3, 7)])
    expect(mapMarks(marks, [ins(7, '!')])).toEqual([b(2, 6)])
    // Deleted text: the mark shrinks, and goes when nothing of it is left.
    expect(mapMarks(marks, [del(3, 2)])).toEqual([b(2, 4)])
    expect(mapMarks(marks, [del(0, 3)])).toEqual([b(0, 3)])
    expect(mapMarks(marks, [del(2, 4)])).toEqual([])
    expect(mapMarks(marks, [del(1, 6)])).toEqual([])
    // Replacing all the mark's text: it went with the deletion, so the new text is plain.
    expect(mapMarks(marks, [{ at: 2, del: 4, ins: 'thin' }])).toEqual([])
    // Splices in order: the second is stated against the first's result.
    expect(mapMarks(marks, [ins(6, 'er'), ins(8, 's')])).toEqual([b(2, 9)])
  })

  it('card marks are carried as any mark; typing that says what it takes drops every type present but those', () => {
    const A = 'c:note_00000000000000000000000001' as const
    const B = 'c:note_00000000000000000000000002' as const
    const c = (t: Mark['t'], from: number, to: number): Mark => ({ t, from, to })
    // Typed inside or at the end of the pinned text: it keeps the pin; at its start, not.
    expect(mapMarks([c(A, 2, 6)], [ins(4, 'xx')])).toEqual([c(A, 2, 8)])
    expect(mapMarks([c(A, 2, 6)], [ins(6, 'er')])).toEqual([c(A, 2, 8)])
    expect(mapMarks([c(A, 2, 6)], [ins(2, 'un')])).toEqual([c(A, 4, 8)])
    // Said: the text takes the card it says, and loses the bold and the other card it does not.
    const said = { ...ins(4, 'xx'), takes: [A] }
    expect(mapMarks([b(0, 8), c(A, 2, 6), c(B, 0, 8)], [said])).toEqual([
      b(0, 4),
      b(6, 10),
      c(A, 2, 8),
      c(B, 0, 4),
      c(B, 6, 10),
    ])
    // A card it says that the block had nowhere: the typed text takes it (and not the bold).
    expect(mapMarks([b(0, 2)], [{ ...ins(1, 'y'), takes: [B] }])).toEqual([
      b(0, 1),
      b(2, 3),
      c(B, 1, 2),
    ])
    // All of a card's text deleted: its mark goes.
    expect(mapMarks([c(A, 2, 6), c(B, 0, 8)], [del(2, 4)])).toEqual([c(B, 0, 4)])
  })

  it('merges same-t marks that a deletion brings together', () => {
    expect(mapMarks([b(0, 2), b(4, 6), i(4, 6)], [del(2, 2)])).toEqual([b(0, 4), i(2, 4)])
  })
})

describe('normalizeMarks', () => {
  it('normalizeMarks sorts by (t, from) and merges same-t overlaps and touching ranges', () => {
    expect(normalizeMarks([i(5, 7), b(4, 6), b(0, 2), i(0, 1)])).toEqual([
      b(0, 2),
      b(4, 6),
      i(0, 1),
      i(5, 7),
    ])
    expect(normalizeMarks([b(0, 3), b(2, 5)])).toEqual([b(0, 5)])
    expect(normalizeMarks([b(0, 3), b(3, 5)])).toEqual([b(0, 5)])
    expect(normalizeMarks([b(1, 9), b(2, 3)])).toEqual([b(1, 9)])
    expect(normalizeMarks([b(0, 3), i(3, 5)])).toEqual([b(0, 3), i(3, 5)])
    // Empty ranges go.
    expect(normalizeMarks([b(2, 2), i(3, 1)])).toEqual([])
  })

  it('is idempotent, and its result is sorted, disjoint and non-touching per t', () => {
    const arbMark = fc
      .record({
        t: fc.constantFrom<'b' | 'i'>('b', 'i'),
        from: fc.nat(40),
        len: fc.integer({ min: 0, max: 10 }),
      })
      .map(({ t, from, len }): Mark => ({ t, from, to: from + len }))
    fc.assert(
      fc.property(fc.array(arbMark, { maxLength: 12 }), (marks) => {
        const out = normalizeMarks(marks)
        expect(normalizeMarks(out)).toEqual(out)
        for (let k = 1; k < out.length; k++) {
          const p = out[k - 1] as Mark
          const q = out[k] as Mark
          expect(p.t < q.t || (p.t === q.t && p.to < q.from)).toBe(true)
        }
        // The same characters are marked, per t.
        for (const t of ['b', 'i'] as const) {
          for (let x = 0; x < 52; x++) {
            const inAny = marks.some((m) => m.t === t && m.from <= x && x < m.to)
            const inOut = out.some((m) => m.t === t && m.from <= x && x < m.to)
            expect(inOut).toBe(inAny)
          }
        }
      }),
    )
  })
})

/** The mark-mapping rule, one splice at a time over every mark: the reference the bounded mapping equals. */
function naiveMapMarks(marks: readonly Mark[], splices: readonly Splice[]): Mark[] {
  let out: Mark[] = [...marks]
  for (const s of splices) {
    const end = s.at + s.del
    const cut = (p: number) => (p <= s.at ? p : p >= end ? p - s.del : s.at)
    const next: Mark[] = []
    for (const m of out) {
      let from = cut(m.from)
      let to = cut(m.to)
      if (from >= to) continue
      if (s.at <= from) {
        from += s.ins.length
        to += s.ins.length
      } else if (s.at <= to) to += s.ins.length
      next.push({ t: m.t, from, to })
    }
    out = next
  }
  return normalizeMarks(out)
}

function naiveApply(text: string, splices: readonly Splice[]): string {
  let out = text
  for (const s of splices) out = out.slice(0, s.at) + s.ins + out.slice(s.at + s.del)
  return out
}

/** Text, its marks, and splices each within the text the one before it left. */
const arbEdit = fc
  .string({ maxLength: 30 })
  .chain((text) =>
    fc.record({
      text: fc.constant(text),
      marks: fc
        .array(
          fc
            .record({
              t: fc.constantFrom<'b' | 'i'>('b', 'i'),
              a: fc.nat(text.length),
              b: fc.nat(text.length),
            })
            .map(({ t, a, b }): Mark => ({ t, from: Math.min(a, b), to: Math.max(a, b) })),
          { maxLength: 8 },
        )
        .map(normalizeMarks),
      steps: fc.array(
        fc.record({ at: fc.nat(1000), del: fc.nat(4), ins: fc.string({ maxLength: 4 }) }),
        { maxLength: 12 },
      ),
    }),
  )
  .map(({ text, marks, steps }) => {
    const splices: Splice[] = []
    let len = text.length
    for (const s of steps) {
      const at = s.at % (len + 1)
      const d = Math.min(s.del, len - at)
      splices.push({ at, del: d, ins: s.ins })
      len += s.ins.length - d
    }
    return { text, marks, splices }
  })

describe('bounded splices', () => {
  it('applySplices and mapMarks equal the one-splice-at-a-time rule', () => {
    fc.assert(
      fc.property(arbEdit, ({ text, marks, splices }) => {
        expect(applySplices(text, splices)).toBe(naiveApply(text, splices))
        expect(mapMarks(marks, splices)).toEqual(naiveMapMarks(marks, splices))
        const back = invertSplices(text, splices)
        expect(applySplices(applySplices(text, splices), back)).toBe(text)
      }),
      { numRuns: 3_000 },
    )
  })

  it('1,000 splices over maxMarksPerBlock marks cost O(splices + marks) steps, never splices × marks', () => {
    // At the limit: a long paragraph, the most marks a block may hold, and
    // the most splices an edit may carry, scattered over it.
    const text = 'x'.repeat(LIMITS.maxMarksPerBlock * 5)
    const marks: Mark[] = []
    for (let k = 0; k < LIMITS.maxMarksPerBlock / 2; k++) {
      marks.push({ t: 'b', from: 10 * k, to: 10 * k + 5 })
      marks.push({ t: 'i', from: 10 * k + 2, to: 10 * k + 7 })
    }
    const normalized = normalizeMarks(marks)
    expect(normalized).toHaveLength(LIMITS.maxMarksPerBlock)
    const splices: Splice[] = []
    let len = text.length
    let seed = 7
    for (let i = 0; i < LIMITS.maxSplicesPerEdit; i++) {
      seed = (seed * 48_271) % 2_147_483_647
      const at = seed % len
      splices.push({ at, del: 1, ins: 'yz' })
      len += 1
    }
    SPLICE_WORK.steps = 0
    const mapped = mapMarks(normalized, splices)
    const edited = applySplices(text, splices)
    const work = SPLICE_WORK.steps
    const n = splices.length + normalized.length
    // The rule one splice at a time walks every mark for every splice: 2,000,000 steps here.
    expect(work).toBeLessThanOrEqual(64 * n)
    expect(mapped).toEqual(naiveMapMarks(normalized, splices))
    expect(edited).toBe(naiveApply(text, splices))
  })
})

describe('subtractMarks', () => {
  it('takes away exactly the characters the other marks mark, per t', () => {
    const arbMarks = fc
      .array(
        fc
          .record({ t: fc.constantFrom<'b' | 'i'>('b', 'i'), a: fc.nat(40), n: fc.nat(8) })
          .map(({ t, a, n }): Mark => ({ t, from: a, to: a + n })),
        { maxLength: 10 },
      )
      .map(normalizeMarks)
    fc.assert(
      fc.property(arbMarks, arbMarks, (a, c) => {
        const out = subtractMarks(a, c)
        expect(normalizeMarks(out)).toEqual(out)
        for (const t of ['b', 'i'] as const) {
          for (let x = 0; x < 50; x++) {
            const has = (ms: readonly Mark[]) =>
              ms.some((m) => m.t === t && m.from <= x && x < m.to)
            expect(has(out)).toBe(has(a) && !has(c))
          }
        }
      }),
      { numRuns: 2_000 },
    )
  })
})

describe('appendSplice', () => {
  it('appendSplice of 1,000 consecutive keystrokes is one splice', () => {
    let list: Splice[] = []
    let at = 3
    for (let k = 0; k < 1_000; k++) {
      const key = k % 2 ? 'a' : '😀'
      list = appendSplice(list, ins(at, key))
      at += key.length
    }
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ at: 3, del: 0 })
    // Backspaces into the typed text, then past it into the text before: still one splice.
    const typed = list[0] as Splice
    list = appendSplice(list, del(3 + typed.ins.length - 1, 1))
    expect(list).toEqual([{ at: 3, del: 0, ins: typed.ins.slice(0, -1) }])
    list = appendSplice([ins(3, 'ab')], del(1, 4))
    expect(list).toEqual([{ at: 1, del: 2, ins: '' }])
    // Typing elsewhere is a new splice.
    expect(appendSplice([ins(3, 'ab')], ins(9, 'c'))).toEqual([ins(3, 'ab'), ins(9, 'c')])
  })

  it('a coalesced list edits text as the keystrokes did', () => {
    const arbKeys = fc.array(
      fc.record({
        back: fc.boolean(),
        n: fc.nat(3),
        at: fc.nat(30),
        c: fc.constantFrom('a', '😀', 'é'),
      }),
      { maxLength: 30 },
    )
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), arbKeys, (text, keys) => {
        let cur = text
        let list: Splice[] = []
        const raw: Splice[] = []
        for (const k of keys) {
          const at = k.at % (cur.length + 1)
          const sp = k.back ? del(Math.max(0, at - k.n), Math.min(k.n, at)) : ins(at, k.c)
          raw.push(sp)
          list = appendSplice(list, sp)
          cur = applySplices(cur, [sp])
        }
        expect(applySplices(text, list)).toBe(cur)
        expect(list.length).toBeLessThanOrEqual(raw.length)
      }),
      RUNS,
    )
  })
})

it('keystrokes that say the same of the marks they take stay one splice, and say it; ones that say otherwise do not join; the list marks the text as the keystrokes did', () => {
  const italic = (at: number, c: string) => ({ ...ins(at, c), takes: ['i'] as Mark['t'][] })
  const plain = (at: number, c: string) => ({ ...ins(at, c), takes: [] as Mark['t'][] })
  let list: Splice[] = []
  for (const [k, c] of [...'abc'].entries()) list = appendSplice(list, italic(2 + k, c))
  expect(list).toEqual([{ at: 2, del: 0, ins: 'abc', takes: ['i'] }])
  // Backspacing into it keeps what it says; a deletion it continues into says it too.
  expect(appendSplice(list, del(4, 1))).toEqual([{ at: 2, del: 0, ins: 'ab', takes: ['i'] }])
  expect(appendSplice([del(2, 1)], italic(2, 'x'))).toEqual([
    { at: 2, del: 1, ins: 'x', takes: ['i'] },
  ])
  // Typing on that says otherwise (or nothing) is a splice of its own.
  expect(appendSplice(list, plain(5, 'd'))).toEqual([...list, plain(5, 'd')])
  expect(appendSplice(list, ins(5, 'd'))).toEqual([...list, ins(5, 'd')])
  const marks = [i(0, 2)]
  const keys = [italic(2, 'a'), italic(3, 'b'), plain(4, 'c'), plain(5, 'd'), italic(6, 'e')]
  let one: Splice[] = []
  for (const k of keys) one = appendSplice(one, k)
  expect(one).toHaveLength(3)
  let by = marks
  for (const k of keys) by = mapMarks(by, [k])
  expect(mapMarks(marks, one)).toEqual(by)
})

const wellFormed = (s: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

describe('diffSplices', () => {
  it('diffSplices(a, b) applied to a gives b', () => {
    const arbText = fc
      .array(fc.constantFrom('a', 'b', '😀', '😃', '𝄞', 'é'), { maxLength: 12 })
      .map((cs) => cs.join(''))
    fc.assert(
      fc.property(arbText, arbText, (a, b) => {
        const splices = diffSplices(a, b)
        expect(applySplices(a, splices)).toBe(b)
        expect(splices.length).toBeLessThanOrEqual(1)
        // Never through the middle of an astral character.
        for (const s of splices) expect(wellFormed(s.ins)).toBe(true)
      }),
      RUNS,
    )
    expect(diffSplices('😀', '😃')).toEqual([{ at: 0, del: 2, ins: '😃' }])
    expect(diffSplices('same', 'same')).toEqual([])
  })
})
