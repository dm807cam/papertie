import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Faults, noFaults } from '../src/store/faults'
import { appendJournal, encodeBase, rotateJournal } from '../src/store/journal'

/**
 * The journal's lines are encoded and written a piece of 32,768 UTF-16 units at
 * a time (`appendJournal`, `rotateJournal`), never cutting a surrogate pair. The bytes on disk
 * must be the one-shot encode's, and the append's fault point must fall at exactly half of them.
 */

const PIECE = 32_768
const ref = { revision: 0, sha256: 'a'.repeat(64) }
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'papertie-pieces-'))
  await rotateJournal(dir, ref, [], noFaults)
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const journal = () => readFile(join(dir, 'journal.jsonl'))
const oneShot = (lines: string[]) => Buffer.from(lines.map((l) => `${l}\n`).join(''), 'utf8')

/** A line of about 2.1 pieces with `at` (offsets around each cut) holding `mark`. */
function lineWith(mark: string, offset: number): string {
  const units = Array.from<unknown, string>({ length: 2 * PIECE + 3000 }, (_, i) =>
    i % 7 === 0 ? 'é' : 'a',
  )
  for (const cut of [PIECE, 2 * PIECE]) {
    const at = cut + offset
    units.splice(at, mark.length, ...mark.split(''))
  }
  return units.join('').slice(0, 2 * PIECE + 3000)
}

const marks = {
  'a surrogate pair': '😀',
  'a lone high surrogate': '\uD83D',
  'a lone low surrogate': '\uDE00',
  'two pairs': '😀😀',
}

describe('a journal line longer than a piece', () => {
  for (const [what, mark] of Object.entries(marks)) {
    it(`is written byte for byte with ${what} at every position near a cut`, async () => {
      const before = await journal()
      const lines: string[] = []
      for (let offset = -3; offset <= 3; offset++) lines.push(lineWith(mark, offset))
      lines.push('short')
      const bytes = await appendJournal(dir, lines, noFaults)
      const after = await journal()
      expect(after.subarray(before.length).equals(oneShot(lines))).toBe(true)
      expect(bytes).toBe(oneShot(lines).length)
    })
  }

  // The half falls inside a piece, on a piece's end, and in a line after a long one.
  for (const [what, lines] of [
    ['inside a piece', ['x'.repeat(50_000)]],
    ['on a piece boundary', ['x'.repeat(2 * PIECE)]],
    ['after a long line', ['x'.repeat(2 * PIECE + 10), 'y'.repeat(70_000), 'z']],
    ['in a line of pairs', [lineWith('😀', -1)]],
  ] as const) {
    it(`stops at exactly half its bytes at the partial-append fault point (${what})`, async () => {
      const start = (await stat(join(dir, 'journal.jsonl'))).size
      class Stop extends Error {}
      const faults: Faults = {
        hit(p) {
          if (p === 'journal:partial-append') throw new Stop(p)
        },
      }
      await expect(appendJournal(dir, [...lines], faults)).rejects.toBeInstanceOf(Stop)
      const whole = oneShot([...lines])
      const written = (await journal()).subarray(start)
      expect(written.length).toBe(Math.floor(whole.length / 2))
      expect(written.equals(whole.subarray(0, written.length))).toBe(true)
    })
  }
})

describe('a rotated journal with long lines in its tail', () => {
  it('holds the base line and every tail line byte for byte', async () => {
    const tail = [
      '{"rev":1}',
      lineWith('😀', 0),
      '{"rev":3}',
      'b'.repeat(PIECE),
      lineWith('\uD83D', -1),
      '{"rev":6}',
    ]
    const bytes = await rotateJournal(dir, ref, tail, noFaults)
    const whole = oneShot([encodeBase(ref), ...tail])
    expect((await journal()).equals(whole)).toBe(true)
    expect(bytes).toBe(whole.length)
  })
})
