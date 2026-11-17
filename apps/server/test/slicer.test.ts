import { createHash } from 'node:crypto'
import {
  type Block,
  type BoardState,
  type Book,
  computeEof,
  type Note,
  serializeBoard,
  stateFromRecords,
} from '@papertie/core'
import { describe, expect, it } from 'vitest'
import { bookStream } from '../src/store/bookStream'
import { SnapshotRefused, serializeSliced, stretchSlices } from '../src/store/compact'
import { hugeState } from './helpers/boards'
import { blockRecord, libraryState } from './helpers/books'
import { oldGenAllocated } from './helpers/heap'
import { PI } from './helpers/turns'

describe('Slicer', () => {
  it('sliced jobs take turns: two at once never share an event-loop iteration', async () => {
    const state = hugeState('board_01JBPR0T0SAMP1E000000BRD01', 40_000)
    // Long slices, as the timing row's (`slicer.timing.test.ts`: its iterations' CPU).
    const budget = 20
    const result = await Promise.all([
      serializeSliced(state, budget),
      serializeSliced(state, budget),
    ])
    expect(result[0].parts.join('')).toBe(result[1].parts.join(''))
  }, 60_000)

  it('a stretched slice is still cut at the budget: the work runs slower, the turn does not', async () => {
    // How much slower, and each slice's CPU, are the timing row's (`slicer.timing.test.ts`).
    const state = hugeState('board_01JBPR0T0SAMP1E000000BRD01', 20_000)
    const plain = await serializeSliced(state)
    stretchSlices(5)
    try {
      const slow = await serializeSliced(state)
      expect(slow.parts.join('')).toBe(plain.parts.join(''))
    } finally {
      stretchSlices(1)
    }
  }, 60_000)

  it('a 100,000-note serialization puts its 43 MB outside the V8 heap, not in the old generation', async () => {
    const state = hugeState('board_01JBPR0T0SAMP1E000000BRD01', 100_000)
    // The fixture's texts are concatenations, flattened (in the old generation) by their first
    // JSON.stringify; a loaded board's are flat from the parse. Flattened first, so they are not
    // counted.
    await serializeSliced(state)
    const { result, mb, majorGcs } = await oldGenAllocated(() => serializeSliced(state))
    console.info(
      `serialization of 100,000 notes: ${result.bytes} bytes, ${mb.toFixed(1)} MB into the old ` +
        `generation, ${majorGcs} major collections`,
    )
    // Each compaction and whole-board read serialized into strings held across slices: 67–70 MB
    // of two-byte text in the old generation each time, garbage once written. On a Raspberry Pi the major
    // collections for it held the loop for 38–67 ms. The bytes now go straight into buffers (the
    // records' own JSON dies young); what is left is the sorted record lists and the like.
    expect(result.bytes).toBeGreaterThan(40_000_000)
    expect(mb).toBeLessThanOrEqual(8)
  }, 60_000)
})

/** `hugeState`'s first `notes` notes, the i-th with `text(i)`: long lines, wide characters. */
function withTexts(notes: number, text: (i: number) => string): BoardState {
  const base = hugeState('board_01JBPR0T0SAMP1E000000BRD01', notes)
  const records = [...base.notes.values()].map((n, i): Note => ({ ...n, text: text(i) }))
  return stateFromRecords(base.board, records)
}

/** `serializeSliced(state)` checked against `serializeBoard`: bytes, pieces, checksum. */
async function sameAsWhole(state: BoardState) {
  const out = await serializeSliced(state)
  const whole = Buffer.from(serializeBoard(state), 'utf8')
  const joined = Buffer.concat(out.parts)
  expect(joined.equals(whole)).toBe(true)
  expect(out.bytes).toBe(whole.length)
  // Every piece ends at a line's end, so no character is ever cut between two.
  for (const p of out.parts) expect(p.at(-1)).toBe(0x0a)
  // The eof record's sha256 is over every byte before it, and is the one returned.
  const eof = out.parts.at(-1) as Buffer
  const body = joined.subarray(0, joined.length - eof.length)
  const sha = createHash('sha256').update(body).digest('hex')
  expect(out.sha256).toBe(sha)
  expect(JSON.parse(eof.toString('utf8')).sha256).toBe(sha)
  // What a whole-board read serves: the file's lines up to its first block line, the same bytes,
  // and an eof over them.
  const text = whole.toString('utf8')
  const cut = text.indexOf('{"type":"block"')
  const served = Buffer.concat(out.served.parts)
  expect(out.served.bytes).toBe(served.length)
  for (const p of out.served.parts) expect(p.at(-1)).toBe(0x0a)
  const lines = (cut === -1 ? text : text.slice(0, cut)).trimEnd().split('\n')
  const kept = cut === -1 ? lines.slice(0, -1) : lines
  expect(served.toString('utf8')).toBe(
    `${[...kept, JSON.stringify(computeEof(kept, state.board.revision))].join('\n')}\n`,
  )
  return out
}

describe('serializeSliced into buffers', () => {
  const emoji = '😀'
  it('a board with books and long, wide blocks is byte-identical, and so is its served cut', async () => {
    const lib = libraryState('board_01JBPR0T0SAMP1E000000BRD01', 2_000, 0.05)
    await sameAsWhole(lib)
    // Blocks at the text limit, astral characters at every piece edge.
    const bookId = [...lib.books.keys()][0] as string
    const long = Array.from({ length: 200 }, (_, i) =>
      blockRecord(bookId, `W${String(i).padStart(3, '1')}`, emoji.repeat(1 + ((i * 97) % 10_000))),
    )
    await sameAsWhole(stateFromRecords(lib.board, [...lib.books.values(), ...long]))
  }, 60_000)

  it('lines longer than a piece, and 4-byte characters at every piece edge, are byte-identical', async () => {
    // 120 KB of JSON a line (each control character escaped to 6 bytes): longer than the worst
    // case a 128 KiB piece can hold, so each gets a piece of its own size.
    await sameAsWhole(withTexts(40, (i) => (i % 3 === 0 ? '\u0001'.repeat(20_000) : `note ${i}`)))
    // Emoji lines of 401 sizes, so the pieces fill to every possible last few bytes.
    await sameAsWhole(withTexts(3_000, (i) => `${emoji.repeat(1 + ((i * 37) % 400))}éễ"\n${i}`))
    await sameAsWhole(withTexts(300, (i) => emoji.repeat(i % 3 === 0 ? 10_000 : 1 + i)))
  }, 60_000)

  it('keeps no more memory than its bytes, long lines included', async () => {
    for (const state of [
      withTexts(300, (i) => (i % 3 === 0 ? '\u0001'.repeat(20_000) : `note ${i}`)),
      withTexts(300, (i) => (i % 3 === 0 ? emoji.repeat(10_000) : `note ${i}`)),
      hugeState('board_01JBPR0T0SAMP1E000000BRD01', 5_000),
    ]) {
      const out = await sameAsWhole(state)
      const kept = out.parts.reduce((n, p) => n + p.buffer.byteLength, 0)
      console.info(
        `${out.bytes} bytes kept in ${kept} bytes of buffers (${out.parts.length} pieces)`,
      )
      // Each piece is a view of a buffer of its own: what is kept is the buffers' whole size.
      expect(kept).toBeLessThanOrEqual(1.1 * out.bytes + 131_072)
    }
  }, 60_000)

  it('the eof piece is a buffer of its own, not a slice of the shared pool', async () => {
    const out = await serializeSliced(hugeState('board_01JBPR0T0SAMP1E000000BRD01', 10))
    const eof = out.parts.at(-1) as Buffer
    expect(eof.byteOffset).toBe(0)
    expect(eof.buffer.byteLength).toBe(eof.length)
  })
})

describe('serializeSliced with books', () => {
  const AT = '2026-10-27T10:00:00.000Z'
  const base = () => hugeState('board_01JBPR0T0SAMP1E000000BRD01', 3)
  const book: Book = {
    type: 'book',
    id: 'book_01JBPR0T0SAMP1E0000000BOOK',
    title: 'A private title',
    lang: 'en',
    shelfPos: 'V',
    cover: { seed: 1, ink: 'indigo', motif: 'overprint' },
    trashedAt: null,
    createdAt: AT,
    updatedAt: AT,
  }
  const block: Block = {
    type: 'block',
    id: 'block_01JBPR0T0SAMP1E000000BLOCK',
    bookId: book.id,
    pos: 'V',
    kind: 'p',
    text: 'A private sentence',
    marks: [],
  }

  it('a state with books and blocks is written whole, its served text cut before the blocks', async () => {
    for (const records of [[book], [book, block]] as const) {
      const st = stateFromRecords(base().board, [...base().notes.values(), ...records])
      const out = await sameAsWhole(st)
      const served = Buffer.concat(out.served.parts).toString('utf8')
      expect(served).not.toContain('"type":"block"')
      expect(served).toContain('"type":"book"')
    }
    // A board without books is written as before, and served whole.
    const plain = base()
    const out = await serializeSliced(plain)
    expect(Buffer.concat(out.parts).toString('utf8')).toBe(serializeBoard(plain))
    expect(out.served.parts).toBe(out.parts)
  })

  it('a state that does not hold every book’s blocks is refused', async () => {
    const s = { ...base(), blocksHeld: new Set<string>() }
    const err = await serializeSliced(s).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SnapshotRefused)
    expect((err as SnapshotRefused).code).toBe('blocks-not-held')
  })
})

describe('the lifetime library in slices', () => {
  it('cold load, compaction and the book stream of the lifetime library keep every slice within budget (compaction and book stream, stretched)', async () => {
    // Each slice's CPU and each iteration on a Raspberry Pi are the timing row's (`slicer.timing.test.ts`).
    const state = libraryState('board_01JBPR0T0SAMP1E000000BRD01', 100_000)
    const big = [...state.books.values()].find((b) => b.title === 'Book 0')?.id as string
    stretchSlices(PI)
    try {
      const out = await serializeSliced(state)
      expect((await bookStream(state, big))?.bytes).toBeGreaterThan(0)
      expect(out.served.bytes).toBeLessThan(out.bytes)
      expect(out.slices).toBeGreaterThan(50)
    } finally {
      stretchSlices(1)
    }
  }, 300_000)
})
