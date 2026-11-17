import {
  BlockRecordSchema,
  BoardParser,
  type BoardState,
  BookRecordSchema,
  computeEof,
  NoteRecordSchema,
  parseBoard,
  serializeBoard,
  stateFromRecords,
} from '../../src/index'
import { fixtureId, makeAsset, makeBlock, makeBoard, makeBook, makeNote, T0 } from '../fixtures'

const BOOK = fixtureId('book', 1)
const BOOK2 = fixtureId('book', 2)

function bookState(): BoardState {
  return stateFromRecords(makeBoard({ revision: 4 }), [
    makeAsset(),
    makeNote(),
    makeBook({ id: BOOK2, shelfPos: 'a' }),
    makeBook({ id: BOOK, shelfPos: 'a', title: 'First' }),
    makeBlock({ id: fixtureId('block', 3), bookId: BOOK2, pos: 'V' }),
    makeBlock({
      id: fixtureId('block', 2),
      bookId: BOOK,
      pos: 'W',
      marks: [{ t: 'b', from: 0, to: 4 }],
    }),
    makeBlock({ id: fixtureId('block', 1), bookId: BOOK, pos: 'W' }),
    makeBlock({ id: fixtureId('block', 4), bookId: BOOK, pos: 'K', kind: 'h1', text: 'One' }),
  ])
}

/** A file's lines from records: the body as given, then a matching eof. */
function file(lines: object[], revision = 0): string {
  const body = lines.map((l) => JSON.stringify(l))
  return `${[...body, JSON.stringify(computeEof(body, revision))].join('\n')}\n`
}

describe('book and block records', () => {
  it('book and block records round-trip through JSONL with eof checksum, in the v2 line order', () => {
    const text = serializeBoard(bookState())
    const types = text
      .trim()
      .split('\n')
      .map((l) => {
        const r = JSON.parse(l) as { type: string; id?: string }
        return r.type === 'board' || r.type === 'eof' ? r.type : `${r.type} ${r.id}`
      })
    // board, assets, notes, yarns, books (shelfPos, id), blocks (bookId, pos, id), eof.
    expect(types).toEqual([
      'board',
      `asset ${makeAsset().id}`,
      `note ${makeNote().id}`,
      `book ${BOOK}`,
      `book ${BOOK2}`,
      `block ${fixtureId('block', 4)}`,
      `block ${fixtureId('block', 1)}`,
      `block ${fixtureId('block', 2)}`,
      `block ${fixtureId('block', 3)}`,
      'eof',
    ])
    const parsed = parseBoard(text)
    expect(parsed.integrity).toBe('ok')
    expect(parsed.issues).toEqual([])
    expect(parsed.state?.books).toEqual(bookState().books)
    expect(parsed.state?.blocks).toEqual(bookState().blocks)
    expect(parsed.state?.blocksHeld).toBe('all')
    expect(serializeBoard(parsed.state as BoardState)).toBe(text)
  })

  it('card marks round-trip through JSONL in the v3 line order, and a v2 file loads as v5', () => {
    const NOTE = makeNote().id
    const pinned = stateFromRecords(makeBoard({ revision: 5 }), [
      makeAsset(),
      // Parsed, as a loaded record is: its keys in the schema's order.
      NoteRecordSchema.parse(
        makeNote({ from: { book: BOOK, block: fixtureId('block', 1) }, rev: 5 }),
      ),
      makeBook({ id: BOOK, cards: [NOTE], rev: 5 }),
      makeBlock({
        id: fixtureId('block', 1),
        bookId: BOOK,
        pos: 'K',
        text: 'A passage from a card',
        marks: [
          { t: 'b', from: 0, to: 1 },
          { t: `c:${NOTE}`, from: 2, to: 9 },
          { t: 'i', from: 2, to: 4 },
        ],
        rev: 5,
      }),
      makeBlock({
        id: fixtureId('block', 2),
        bookId: BOOK,
        pos: 'V',
        kind: 'figure',
        text: '',
        marks: [],
        image: { assetId: makeAsset().id, card: NOTE },
      }),
      makeBlock({
        id: fixtureId('block', 3),
        bookId: BOOK,
        pos: 'W',
        kind: 'prompt',
        text: 'Why?',
      }),
    ])
    const text = serializeBoard(pinned)
    const lines = text.trim().split('\n')
    expect(JSON.parse(lines[0] as string).schemaVersion).toBe(6)
    // Each record's keys in the schema's order, `rev` last.
    expect(lines[3]).toBe(JSON.stringify({ ...makeBook({ id: BOOK }), cards: [NOTE], rev: 5 }))
    expect(Object.keys(JSON.parse(lines[2] as string))).toEqual(
      Object.keys(NoteRecordSchema.shape).filter(
        (k) => !['motif', 'stamp', 'layered', 'ref'].includes(k),
      ),
    )
    const parsed = parseBoard(text)
    expect(parsed.integrity).toBe('ok')
    expect(parsed.issues).toEqual([])
    expect(serializeBoard(parsed.state as BoardState)).toBe(text)
    // Deferred (the server's clean load), the same records.
    const parser = new BoardParser(undefined, { deferRecords: true })
    for (const [i, l] of text.split('\n').entries()) parser.line(l, i + 1)
    const out = parser.finish()
    expect('done' in out ? out.done.issues : out.issues).toEqual([])

    // A field the schema does not know inside a figure's image or a note's origin is checked.
    const issuesOf = (lines: object[]) => {
      const p = new BoardParser(undefined, { deferRecords: true })
      for (const [i, l] of file(lines).split('\n').entries()) p.line(l, i + 1)
      const r = p.finish()
      return 'done' in r ? ['done'] : r.issues.map((x) => x.kind)
    }
    expect(
      issuesOf([
        makeBoard(),
        makeAsset(),
        makeBook(),
        makeBlock({ kind: 'figure', image: { assetId: makeAsset().id, glow: 1 } as never }),
      ]),
    ).toEqual(['invalid-record'])
    expect(
      issuesOf([
        makeBoard(),
        makeNote({ from: { book: BOOK, block: fixtureId('block', 1), at: 1 } as never }),
      ]),
    ).toEqual(['invalid-record'])
  })

  it('a board of an older or a newer version is refused whole, deferred or not', () => {
    for (const schemaVersion of [1, 5, 7]) {
      const text = file([{ ...makeBoard(), schemaVersion }, makeBook(), makeBlock()])
      const r = parseBoard(text)
      expect(r.state).toBeNull()
      expect(r.issues.map((i) => i.kind)).toEqual(['unsupported-version'])
      const parser = new BoardParser(undefined, { deferRecords: true })
      for (const [i, l] of text.split('\n').entries()) parser.line(l, i + 1)
      const out = parser.finish()
      expect('done' in out && out.done.state).toBeNull()
    }
  })

  it('refs and footnotes round-trip through JSONL, deferred too', () => {
    const FN = fixtureId('block', 7)
    const s = stateFromRecords(makeBoard({ revision: 2 }), [
      NoteRecordSchema.parse(makeNote({ ref: 'Thoreau, Walden, 1854,\nhttps://e.com, p. 12' })),
      makeBook({ id: BOOK }),
      makeBlock({
        id: fixtureId('block', 1),
        bookId: BOOK,
        pos: 'K',
        text: 'Simplify, simplify.',
        marks: [{ t: `n:${FN}`, from: 0, to: 9 }],
      }),
      makeBlock({ id: FN, bookId: BOOK, pos: 'L', kind: 'footnote', text: 'Thoreau, Walden' }),
    ])
    const text = serializeBoard(s)
    const parsed = parseBoard(text)
    expect(parsed.issues).toEqual([])
    expect(serializeBoard(parsed.state as BoardState)).toBe(text)
    const parser = new BoardParser(undefined, { deferRecords: true })
    for (const [i, l] of text.split('\n').entries()) parser.line(l, i + 1)
    const out = parser.finish()
    expect('done' in out ? out.done.issues : out.issues).toEqual([])
    // A key the schema does not know is checked, deferred or not.
    const odd = file([makeBoard(), { ...makeNote(), source: { title: 'T' } }])
    const p = new BoardParser(undefined, { deferRecords: true })
    for (const [i, l] of odd.split('\n').entries()) p.line(l, i + 1)
    const r = p.finish()
    expect('done' in r ? ['done'] : r.issues.map((x) => x.kind)).toEqual(['invalid-record'])
  })

  it('a block naming a missing book is repaired away as a dangling-reference on load', () => {
    const orphan = makeBlock({ id: fixtureId('block', 9), bookId: fixtureId('book', 9) })
    const kept = makeBlock({ id: fixtureId('block', 1), bookId: BOOK })
    const r = parseBoard(file([makeBoard(), makeBook(), kept, orphan]))
    expect(r.integrity).toBe('ok')
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]).toMatchObject({
      line: 0,
      kind: 'dangling-reference',
      raw: JSON.stringify(orphan),
    })
    expect([...(r.state?.blocks.keys() ?? [])]).toEqual([kept.id])
  })

  it('a whole-board read that holds no blocks keeps the books and none of the blocks', () => {
    const r = parseBoard(serializeBoard(bookState()), { blocksHeld: 'none' })
    expect(r.integrity).toBe('ok')
    expect(r.issues).toEqual([])
    expect(r.state?.books.size).toBe(2)
    expect(r.state?.blocks.size).toBe(0)
    expect(r.state?.blocksHeld).toEqual(new Set())
  })

  it('deferred records are taken unchecked only with known keys, nested ones included', () => {
    const lines = (book: object, block: object) =>
      file([
        makeBoard(),
        makeBook(),
        { ...makeBook({ id: BOOK2 }), ...book },
        { ...makeBlock(), ...block },
      ])
    const issuesOf = (text: string) => {
      const parser = new BoardParser(undefined, { deferRecords: true })
      for (const [i, l] of text.split('\n').entries()) parser.line(l, i + 1)
      const out = parser.finish()
      return 'done' in out ? ['done'] : out.issues.map((i) => i.kind)
    }
    expect(issuesOf(lines({}, {}))).toEqual([])
    expect(
      issuesOf(lines({ cover: { seed: 1, ink: 'indigo', motif: 'overprint', glow: 1 } }, {})),
    ).toEqual(['invalid-record'])
    expect(issuesOf(lines({}, { marks: [{ t: 'b', from: 0, to: 1, href: 'x' }] }))).toEqual([
      'invalid-record',
    ])
    expect(issuesOf(lines({ spine: 'red' }, {}))).toEqual(['invalid-record'])
  })

  it('a state that does not hold every book’s blocks is never serialized', () => {
    const s = { ...bookState(), blocksHeld: new Set([BOOK]) as ReadonlySet<string> }
    expect(() => serializeBoard(s)).toThrow(RangeError)
    expect(() => serializeBoard({ ...bookState(), blocksHeld: new Set<string>() })).toThrow(
      RangeError,
    )
  })

  it('the schemas take valid records and refuse past the limits', () => {
    expect(BookRecordSchema.safeParse(makeBook()).success).toBe(true)
    expect(BookRecordSchema.safeParse(makeBook({ title: 'x'.repeat(201) })).success).toBe(false)
    expect(BookRecordSchema.safeParse(makeBook({ trashedAt: T0 })).success).toBe(true)
    expect(BookRecordSchema.safeParse(makeBook({ shelfPos: 'a0' })).success).toBe(false)
    expect(
      BookRecordSchema.safeParse({
        ...makeBook(),
        cover: { seed: 2 ** 32, ink: 'indigo', motif: 'overprint' },
      }).success,
    ).toBe(false)
    expect(BlockRecordSchema.safeParse(makeBlock()).success).toBe(true)
    expect(BlockRecordSchema.safeParse(makeBlock({ text: 'x'.repeat(20_001) })).success).toBe(false)
    expect(BlockRecordSchema.safeParse(makeBlock({ pos: 'z'.repeat(129) })).success).toBe(false)
    expect(BlockRecordSchema.safeParse({ ...makeBlock(), kind: 'h3' }).success).toBe(false)
  })
})
