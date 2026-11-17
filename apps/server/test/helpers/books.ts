import {
  type Block,
  type BoardState,
  type Book,
  type Mark,
  newId,
  type Op,
  posKeysBetween,
  type Splice,
  stateFromRecords,
} from '@papertie/core'
import { hugeState } from './boards'

/** Book and block ops and records for the server's tests. */

export const AT = '2026-10-27T10:00:00.000Z'

export function bookRecord(over: Partial<Book> = {}): Book {
  return {
    type: 'book',
    id: newId('book'),
    title: 'A private title',
    lang: 'en',
    shelfPos: 'V',
    cover: { seed: 7, ink: 'indigo', motif: 'overprint' },
    trashedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  }
}

export function blockRecord(bookId: string, pos: string, text: string, over: Partial<Block> = {}) {
  return {
    type: 'block',
    id: newId('block'),
    bookId,
    pos,
    kind: 'p',
    text,
    marks: [],
    ...over,
  } satisfies Block
}

export const bookCreate = (book: Book): Op => ({
  op: 'book.create',
  book: { ...book, trashedAt: null },
})
export const blockCreate = (block: Block): Op => ({ op: 'block.create', block })

export function edit(
  bookId: string,
  id: string,
  splices: Splice[],
  marks: { addMarks?: Mark[]; removeMarks?: Mark[] } = {},
): Op {
  return { op: 'block.edit', bookId, id, splices, ...marks }
}

export const ins = (at: number, text: string): Splice => ({ at, del: 0, ins: text })

export function split(
  bookId: string,
  id: string,
  at: number,
  pos: string,
  newBlockId = newId('block'),
): Op & { op: 'block.split' } {
  return { op: 'block.split', bookId, id, at, newId: newBlockId, pos, kind: 'p' }
}

/** The book's text, its blocks in `(pos, id)` order, one line each. */
export function bookText(state: BoardState, bookId: string): string[] {
  return [...state.blocks.values()]
    .filter((b) => b.bookId === bookId)
    .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1))
    .map((b) => b.text)
}

/** A deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = (
  'the river morning letter garden window paper light quiet winter summer evening house street ' +
  'station harbour mountain forest silence memory journey promise kitchen table lantern bridge ' +
  'und der die das nicht ist mit auf Morgen Abend Fenster Brief café naïve déjà Straße'
).split(' ')

/** One book of `words` words, in paragraphs of about 60 words (some with a bold word). */
export function genBookRecords(seed: number, words: number, over: Partial<Book> = {}) {
  const r = rng(seed)
  const book = bookRecord({ shelfPos: posKeysBetween(null, null, 1)[0] as string, ...over })
  const texts: Array<{ text: string; marks: Mark[] }> = []
  for (let left = words; left > 0; ) {
    const n = Math.min(left, 40 + Math.floor(r() * 40))
    left -= n
    const ws: string[] = []
    for (let i = 0; i < n; i++) ws.push(WORDS[Math.floor(r() * WORDS.length)] as string)
    const text = `${ws.join(' ')}.`
    const marks: Mark[] = r() < 0.3 ? [{ t: 'b', from: 0, to: (ws[0] as string).length }] : []
    texts.push({ text, marks })
  }
  const keys = posKeysBetween(null, null, texts.length)
  const blocks = texts.map(
    (t, i) =>
      ({
        type: 'block',
        id: newId('block'),
        bookId: book.id,
        pos: keys[i] as string,
        kind: i % 40 === 0 ? 'h1' : 'p',
        text: t.text,
        marks: t.marks,
      }) satisfies Block,
  )
  return { book, blocks }
}

/**
 * The lifetime library (as `genLibrary`, built here for the server's tests): 50
 * books, one of 200,000 words, four of 50,000, the rest 1,000–20,000 seeded, three of them
 * trashed; `scale` shrinks every book (for quick tests).
 */
export function libraryRecords(seed = 1, scale = 1): { books: Book[]; blocks: Block[] } {
  const r = rng(seed)
  const sizes = [200_000, 50_000, 50_000, 50_000, 50_000]
  while (sizes.length < 50) sizes.push(1_000 + Math.floor(r() * 19_000))
  const shelf = posKeysBetween(null, null, sizes.length)
  const books: Book[] = []
  const blocks: Block[] = []
  sizes.forEach((words, i) => {
    const g = genBookRecords(seed * 100 + i, Math.max(1, Math.round(words * scale)), {
      title: `Book ${i}`,
      shelfPos: shelf[i] as string,
      trashedAt: i >= 47 ? AT : null,
    })
    books.push(g.book)
    for (const b of g.blocks) blocks.push(b)
  })
  return { books, blocks }
}

/** `hugeState` with the lifetime library on it. */
export function libraryState(boardId: string, notes: number, scale = 1): BoardState {
  const base = hugeState(boardId, notes)
  const lib = libraryRecords(1, scale)
  return stateFromRecords(base.board, [
    ...base.notes.values(),
    ...base.yarns.values(),
    ...lib.books,
    ...lib.blocks,
  ])
}
