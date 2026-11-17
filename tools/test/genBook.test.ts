import {
  type Block,
  BlockRecordSchema,
  type Book,
  BookRecordSchema,
  ClientOpSchema,
  cardsFromBlocks,
  LIMITS,
} from '@papertie/core'
import {
  chapterMoveOps,
  type GenBlock,
  genBook,
  genBookBlocks,
  genChapterBook,
  genLibrary,
  genLimitBook,
  LIFETIME_LIBRARY,
  libraryOps,
} from '../src/genBook'

const KINDS = ['p', 'h1', 'h2', 'quote', 'li'] as const

const wordsOf = (blocks: readonly GenBlock[]) =>
  blocks.reduce((n, b) => n + (b.text.match(/\S+/g)?.length ?? 0), 0)

describe('genBook', () => {
  it('genBook is deterministic and within 1 % of its word count, with every kind present', () => {
    for (const seed of [1, 2, 3]) {
      const a = genBook({ seed, words: 200_000 })
      const b = genBook({ seed, words: 200_000 })
      expect(b).toEqual(a)
      expect(Math.abs(wordsOf(a) - 200_000)).toBeLessThanOrEqual(2_000)
      for (const kind of KINDS)
        expect(
          a.some((x) => x.kind === kind),
          `${seed} ${kind}`,
        ).toBe(true)
      expect(a.some((x) => x.marks.some((m) => m.t === 'b'))).toBe(true)
      expect(a.some((x) => x.marks.some((m) => m.t === 'i'))).toBe(true)
      expect(new Set(a.map((x) => x.id)).size).toBe(a.length)
      for (const x of a)
        for (const m of x.marks) {
          expect(m.from).toBeGreaterThanOrEqual(0)
          expect(m.to).toBeGreaterThan(m.from)
          expect(m.to).toBeLessThanOrEqual(x.text.length)
        }
    }
    expect(genBook({ seed: 1, words: 2_000 })).not.toEqual(genBook({ seed: 2, words: 2_000 }))
  })

  it('opens each chapter with an h1 and honours the chapter count', () => {
    const book = genBook({ seed: 7, words: 20_000, chapters: 5 })
    expect(book[0]?.kind).toBe('h1')
    expect(book.filter((b) => b.kind === 'h1')).toHaveLength(5)
  })
})

describe('genBookBlocks', () => {
  it('genBookBlocks gives blocks in pos order within maxPosLength', () => {
    const bookId = `book_${'0'.repeat(25)}9`
    const gen = genBook({ seed: 4, words: 200_000 })
    const blocks = genBookBlocks({ seed: 4, words: 200_000, bookId })
    // genBook's blocks, as they are, in the same order.
    expect(blocks.map(({ id, kind, text, marks }) => ({ id, kind, text, marks }))).toEqual(gen)
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i] as (typeof blocks)[number]
      expect(BlockRecordSchema.parse(b)).toEqual(b)
      expect(b.bookId).toBe(bookId)
      expect(b.pos.length).toBeLessThanOrEqual(LIMITS.maxPosLength)
      if (i > 0) expect((blocks[i - 1] as typeof b).pos < b.pos).toBe(true)
    }
    expect(genBookBlocks({ seed: 4, words: 200_000, bookId })).toEqual(blocks)
  })
})

describe('genLibrary', () => {
  const NOW = '2026-11-12T08:00:00.000Z'
  const words = (blocks: readonly Block[], bookId: string) =>
    blocks
      .filter((b) => b.bookId === bookId)
      .reduce((n, b) => n + (b.text.match(/\S+/g)?.length ?? 0), 0)

  it('is the lifetime library: 50 books, one of 200,000 words, four of 50,000, the rest 1,000–20,000, three trashed', () => {
    const lib = genLibrary({ seed: 1, now: NOW })
    expect(lib.books).toHaveLength(LIFETIME_LIBRARY.books)
    expect(lib.books.length).toBeLessThanOrEqual(LIMITS.maxBooks)
    const counts = lib.books.map((b) => words(lib.blocks, b.id))
    const near = (n: number, w: number) => Math.abs(n - w) <= w * 0.01
    expect(counts.filter((n) => near(n, 200_000))).toHaveLength(1)
    expect(counts.filter((n) => near(n, 50_000))).toHaveLength(4)
    const rest = counts.filter((n) => !near(n, 200_000) && !near(n, 50_000))
    expect(rest).toHaveLength(45)
    for (const n of rest) {
      expect(n).toBeGreaterThanOrEqual(1_000 * 0.99)
      expect(n).toBeLessThanOrEqual(20_000 * 1.01)
    }
    // Seeded, not all one length.
    expect(new Set(rest).size).toBeGreaterThan(30)
    const trashed = lib.books.filter((b) => b.trashedAt !== null)
    expect(trashed).toHaveLength(3)
    for (const b of trashed) {
      expect(b.trashedAt).toBe(NOW)
      expect(rest).toContain(words(lib.blocks, b.id))
    }
    // The long book is the one ADR-0007 measured: genBook's 200,000 words at the library's seed
    // (the prompts and figures between its blocks, and its card marks, set aside).
    const long = lib.books.find((b) => near(words(lib.blocks, b.id), 200_000)) as Book
    expect(long.title).toBe('A lifetime')
    expect(long.trashedAt).toBeNull()
    expect(
      lib.blocks
        .filter((b) => b.bookId === long.id && b.kind !== 'prompt' && b.kind !== 'figure')
        .map((b) => ({ ...b, marks: b.marks.filter((m) => !m.t.startsWith('c:')) })),
    ).toEqual(genBookBlocks({ seed: 1, words: 200_000, bookId: long.id }))
  })

  it('is deterministic per seed, and another seed gives another library', () => {
    const a = genLibrary({ seed: 3, now: NOW })
    expect(genLibrary({ seed: 3, now: NOW })).toEqual(a)
    const b = genLibrary({ seed: 4, now: NOW })
    expect(b.books.map((x) => x.id)).not.toEqual(a.books.map((x) => x.id))
    expect(b.blocks.slice(0, 50)).not.toEqual(a.blocks.slice(0, 50))
  })

  it('gives valid records within the limits: ids unique, the shelf and each book in pos order', () => {
    const lib = genLibrary({ seed: 2, now: NOW })
    for (const b of lib.books) expect(BookRecordSchema.parse(b)).toEqual(b)
    expect(new Set(lib.books.map((b) => b.id)).size).toBe(lib.books.length)
    expect(new Set(lib.blocks.map((b) => b.id)).size).toBe(lib.blocks.length)
    for (let i = 1; i < lib.books.length; i++)
      expect((lib.books[i - 1] as Book).shelfPos < (lib.books[i] as Book).shelfPos).toBe(true)
    const ids = new Set(lib.books.map((b) => b.id))
    const byBook = new Map<string, Block[]>()
    for (const b of lib.blocks) {
      expect(ids.has(b.bookId)).toBe(true)
      byBook.set(b.bookId, [...(byBook.get(b.bookId) ?? []), b])
    }
    expect(byBook.size).toBe(lib.books.length)
    for (const blocks of byBook.values()) {
      expect(blocks.length).toBeLessThanOrEqual(LIMITS.maxBlocksPerBook)
      expect(blocks.reduce((n, b) => n + b.text.length, 0)).toBeLessThanOrEqual(LIMITS.maxBookChars)
      for (let i = 1; i < blocks.length; i++)
        expect((blocks[i - 1] as Block).pos < (blocks[i] as Block).pos).toBe(true)
    }
    for (const b of lib.blocks.slice(0, 2_000)) expect(BlockRecordSchema.parse(b)).toEqual(b)
  })

  it('genLibrary is deterministic and every book’s cards equal cardsFromBlocks', () => {
    const cards = Array.from({ length: 40 }, (_, i) => `note_${String(i).padStart(26, '0')}`)
    const asset = `asset_${'0'.repeat(25)}7`
    const o = { seed: 6, now: NOW, scale: 0.05, cards, asset }
    const lib = genLibrary(o)
    expect(genLibrary(o)).toEqual(lib)
    const byBook = new Map<string, Block[]>()
    for (const b of lib.blocks) byBook.set(b.bookId, [...(byBook.get(b.bookId) ?? []), b])
    // The long books (the first and the four of 50,000 words): card marks, prompts and figures.
    const long = new Set(
      lib.books
        .map((b) => b.id)
        .filter((id) => {
          const n = words(lib.blocks, id)
          return Math.abs(n - 200_000 * 0.05) <= 200 || Math.abs(n - 50_000 * 0.05) <= 60
        }),
    )
    expect(long.size).toBe(5)
    const known = new Set(cards)
    for (const book of lib.books) {
      const blocks = byBook.get(book.id) ?? []
      // Stamped as the server would: the cards its blocks name.
      const named = cardsFromBlocks(blocks)
      expect(book.cards ?? []).toEqual(named)
      for (const c of named) expect(known.has(c)).toBe(true)
      for (const b of blocks) expect(BlockRecordSchema.parse(b)).toEqual(b)
      if (!long.has(book.id)) {
        expect(named).toEqual([])
        expect(blocks.some((b) => b.kind === 'prompt' || b.kind === 'figure')).toBe(false)
        continue
      }
      // A prompt after every 30th block, a figure (the photo, a card's) after every 200th.
      const text = blocks.filter((b) => b.kind !== 'prompt' && b.kind !== 'figure')
      const prompts = blocks.filter((b) => b.kind === 'prompt')
      const figures = blocks.filter((b) => b.kind === 'figure')
      expect(prompts).toHaveLength(Math.floor(text.length / 30))
      expect(figures).toHaveLength(Math.floor(text.length / 200))
      for (const f of figures) {
        expect(f.image?.assetId).toBe(asset)
        expect(known.has(f.image?.card ?? '')).toBe(true)
      }
      // A card mark on 1 block in 5, over the whole block.
      const marked = text.filter((b) => b.marks.some((m) => m.t.startsWith('c:')))
      expect(marked).toHaveLength(Math.floor(text.length / 5))
      for (const b of marked) {
        const m = b.marks.find((x) => x.t.startsWith('c:'))
        expect([m?.from, m?.to]).toEqual([0, b.text.length])
      }
      // Several of the board's cards, not one: the first (longest) book names many.
      expect(named.length).toBeGreaterThan(book === lib.books[0] ? 10 : 1)
    }
    // Without the board's cards or a photo: prompts only, no card names.
    const plain = genLibrary({ seed: 6, now: NOW, scale: 0.05 })
    expect(plain.books.every((b) => b.cards === undefined)).toBe(true)
    expect(plain.blocks.some((b) => b.kind === 'figure')).toBe(false)
    expect(plain.blocks.some((b) => b.kind === 'prompt')).toBe(true)
    // libraryOps leaves the stamping to the server.
    for (const op of libraryOps(lib))
      if (op.op === 'book.create') expect('cards' in op.book).toBe(false)
  })

  it('genLimitBook is one book of 500,000 words, within maxBookChars and maxBlocksPerBook', () => {
    const lib = genLimitBook({ seed: 1, now: NOW })
    expect(genLimitBook({ seed: 1, now: NOW })).toEqual(lib)
    expect(lib.books).toHaveLength(1)
    const [book] = lib.books as [Book]
    expect(BookRecordSchema.parse(book)).toEqual(book)
    expect(book.trashedAt).toBeNull()
    expect(Math.abs(words(lib.blocks, book.id) - 500_000)).toBeLessThanOrEqual(5_000)
    expect(lib.blocks.every((b) => b.bookId === book.id)).toBe(true)
    expect(lib.blocks.length).toBeLessThanOrEqual(LIMITS.maxBlocksPerBook)
    expect(lib.blocks.reduce((n, b) => n + b.text.length, 0)).toBeLessThanOrEqual(
      LIMITS.maxBookChars,
    )
  })

  it('libraryOps makes each book, then its blocks, then deletes the trashed ones: valid client ops', () => {
    const lib = genLibrary({ seed: 5, now: NOW })
    const ops = libraryOps(lib)
    expect(ops).toHaveLength(lib.books.length + lib.blocks.length + 3)
    for (const op of ops) expect(ClientOpSchema.safeParse(op).success, op.op).toBe(true)
    const made = new Set<string>()
    for (const op of ops) {
      if (op.op === 'book.create') {
        expect(op.book.trashedAt).toBeNull()
        made.add(op.book.id)
      } else if (op.op === 'block.create') expect(made.has(op.block.bookId)).toBe(true)
      else if (op.op === 'book.update') expect(op.set.trashedAt).toBe(NOW)
      else throw new Error(`unexpected ${op.op}`)
    }
    expect(ops.slice(-3).every((op) => op.op === 'book.update')).toBe(true)
  })
})

describe('the bench scaffolding beside the library', () => {
  it('genLibrary at a smaller scale (a smoke run) keeps its shape, at that share of the words', () => {
    const lib = genLibrary({ seed: 1, scale: 0.01 })
    expect(lib.books).toHaveLength(50)
    expect(lib.books.filter((b) => b.trashedAt !== null)).toHaveLength(3)
    const long = lib.books[0] as Book
    const n = lib.blocks
      .filter((b) => b.bookId === long.id)
      .reduce((k, b) => k + (b.text.match(/\S+/g)?.length ?? 0), 0)
    expect(Math.abs(n - 2_000)).toBeLessThanOrEqual(20)
  })

  it('genChapterBook is two chapters of half the blocks each; chapterMoveOps puts the second first', () => {
    const lib = genChapterBook({ seed: 1, blocks: 600 })
    expect(lib.books).toHaveLength(1)
    const [book] = lib.books as [Book]
    expect(lib.blocks).toHaveLength(600)
    expect(lib.blocks.filter((b) => b.kind === 'h1').map((b) => lib.blocks.indexOf(b))).toEqual([
      0, 300,
    ])
    for (const b of lib.blocks) {
      expect(b.bookId).toBe(book.id)
      expect(BlockRecordSchema.parse(b)).toEqual(b)
    }
    const ops = chapterMoveOps(lib)
    expect(ops).toHaveLength(300)
    const first = (lib.blocks[0] as Block).pos
    const keys: string[] = []
    for (const [i, op] of ops.entries()) {
      expect(ClientOpSchema.safeParse(op).success).toBe(true)
      if (op.op !== 'block.set') throw new Error(op.op)
      expect(op.id).toBe((lib.blocks[300 + i] as Block).id)
      expect(op.bookId).toBe(book.id)
      keys.push(op.set.pos as string)
    }
    expect([...keys].sort()).toEqual(keys)
    expect((keys.at(-1) as string) < first).toBe(true)
    expect(keys.every((k) => k.length <= LIMITS.maxPosLength)).toBe(true)
  })
})
