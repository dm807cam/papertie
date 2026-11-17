import {
  type Block,
  type Book,
  type ClientOp,
  COVER_INKS,
  COVER_MOTIFS,
  cardMarkT,
  cardsFromBlocks,
  type Mark,
  posBetween,
  posKeysBetween,
} from '@papertie/core'
import { seededId } from './genBoard'
import { mulberry32 } from './rng'

/**
 * A deterministic book for the writer's tests and benchmarks: chapters (`h1`), sections
 * (`h2`), paragraphs, quotes and short lists, with some bold and italic, in Western prose (books
 * are mostly English or German). Linear time and nothing from Node, so the browser can call it.
 */

export type GenKind = 'p' | 'h1' | 'h2' | 'quote' | 'li'
export interface GenMark {
  t: 'b' | 'i'
  from: number
  to: number
}
/** `EditorBlock`'s shape (`apps/web/src/book/editor/BookEditor.ts`). */
export interface GenBlock {
  id: string
  kind: GenKind
  text: string
  marks: GenMark[]
}

export interface GenBookOptions {
  seed: number
  /** Words in the whole book, headings included: met exactly, unless a chapter is shorter than its heading. */
  words: number
  /** Default: one chapter per 5,000 words, at least one. */
  chapters?: number
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const WORDS = (
  'the a of and to in that it was he she for on with as his her at by from they we you this ' +
  'but had not are or which an were be one all there their what so up out if about who them ' +
  'when would could into time only over even like after back river morning letter garden ' +
  'window paper light quiet winter summer evening house street station harbour mountain ' +
  'forest silence memory journey promise kitchen table lantern bridge village train coat ' +
  'shadow stone water field orchard distance answer question reason moment season ink thread ' +
  'knot board needle careful slowly finally perhaps almost always never again still already ' +
  'walked waited listened remembered wrote folded carried opened closed turned smiled ' +
  'thought noticed returned wondered gathered kept left found knew felt saw said asked ' +
  'und der die das nicht ist mit auf für sich dem den ein eine auch noch nach wie über ' +
  'Morgen Abend Fenster Brief Garten Stille Weg Haus Licht Zeit immer wieder schon langsam ' +
  'café naïve über déjà Straße Mädchen größer'
).split(' ')

const TITLES = (
  'The Long Winter|A Letter Unsent|The Orchard|Paper Lanterns|The Harbour at Dawn|' +
  'What the River Kept|Der lange Weg|Am Fenster|The Quiet House|Threads|The Last Train|' +
  'Ink and Water|Small Hours|The Bridge|Ein Brief|The Garden Wall'
).split('|')

function blockId(rng: () => number): string {
  let out = 'block_'
  for (let i = 0; i < 26; i++) out += ALPHABET[Math.floor(rng() * 32)]
  return out
}

/** `n` words of prose, as a sentence or several, capitalised and full-stopped. */
function prose(rng: () => number, n: number): string {
  const parts: string[] = []
  let sentence = 0
  for (let i = 0; i < n; i++) {
    let w = WORDS[Math.floor(rng() * WORDS.length)] as string
    if (sentence === 0) w = w.charAt(0).toUpperCase() + w.slice(1)
    sentence++
    const end = i === n - 1 || (sentence >= 6 && rng() < 0.12)
    if (end) {
      w += rng() < 0.1 ? '?' : '.'
      sentence = 0
    } else if (rng() < 0.06) w += ','
    parts.push(w)
  }
  return parts.join(' ')
}

/** A bold or italic run over whole words of `text`, or none. */
function someMarks(rng: () => number, text: string): GenMark[] {
  if (rng() >= 0.15) return []
  const starts: number[] = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === ' ') starts.push(i + 1)
  const first = Math.floor(rng() * starts.length)
  const last = Math.min(starts.length - 1, first + Math.floor(rng() * 4))
  const from = starts[first] as number
  const nextStart = starts[last + 1]
  const to = nextStart === undefined ? text.length : nextStart - 1
  if (to <= from) return []
  return [{ t: rng() < 0.5 ? 'b' : 'i', from, to }]
}

const countWords = (s: string) => s.match(/\S+/g)?.length ?? 0

export function genBook(o: GenBookOptions): GenBlock[] {
  const rng = mulberry32(o.seed)
  const ids = mulberry32(o.seed ^ 0x5bd1e995)
  const chapters = Math.max(1, o.chapters ?? Math.round(o.words / 5000))
  const perChapter = o.words / chapters
  const out: GenBlock[] = []
  let words = 0
  const push = (kind: GenKind, text: string, marks: GenMark[] = []) => {
    out.push({ id: blockId(ids), kind, text, marks })
    words += countWords(text)
  }

  for (let c = 0; c < chapters; c++) {
    const chapterEnd = Math.round(perChapter * (c + 1))
    push('h1', `${c + 1}. ${TITLES[c % TITLES.length]}`)
    let sinceSection = 0
    let section = 0
    while (words < chapterEnd) {
      const left = chapterEnd - words
      const r = rng()
      if (sinceSection > 1200 && left > 300) {
        section++
        push('h2', `${TITLES[(c + section * 7) % TITLES.length]} ${section}`)
        sinceSection = 0
        continue
      }
      let kind: GenKind = 'p'
      if (r < 0.05) kind = 'quote'
      else if (r < 0.09) kind = 'li'
      if (kind === 'li') {
        const items = 3 + Math.floor(rng() * 3)
        for (let i = 0; i < items && words < chapterEnd; i++) {
          const n = Math.min(chapterEnd - words, 3 + Math.floor(rng() * 10))
          const text = prose(rng, n)
          push('li', text, someMarks(rng, text))
          sinceSection += n
        }
        continue
      }
      const n = Math.min(
        left,
        kind === 'quote' ? 15 + Math.floor(rng() * 40) : 40 + Math.floor(rng() * 120),
      )
      const text = prose(rng, n)
      push(kind, text, someMarks(rng, text))
      sinceSection += n
    }
  }
  return out
}

/**
 * `genBook`'s blocks as the board keeps them (core's `Block`): in book `o.bookId`, each with a
 * `pos` from `posKeysBetween`, in order. `genLibrary` builds every book of its library with it.
 */
export function genBookBlocks(o: { seed: number; words: number; bookId: string }): Block[] {
  const gen = genBook({ seed: o.seed, words: o.words })
  const keys = posKeysBetween(null, null, gen.length)
  return gen.map((b, i) => ({
    type: 'block',
    id: b.id,
    bookId: o.bookId,
    pos: keys[i] as string,
    kind: b.kind,
    text: b.text,
    marks: b.marks,
  }))
}

/**
 * The lifetime library, for the 100,000-note board: 50 books, one of 200,000
 * words, four of 50,000, the rest 1,000–20,000 words (seeded), three of those deleted (in
 * "Recently deleted"); and, apart, one 500,000-word book for the limit row.
 */
export const LIFETIME_LIBRARY = {
  books: 50,
  longWords: 200_000,
  midBooks: 4,
  midWords: 50_000,
  restMinWords: 1_000,
  restMaxWords: 20_000,
  trashed: 3,
  limitWords: 500_000,
} as const

/** Books and their blocks, as the board keeps them: each book's blocks in `pos` order. */
export interface Library {
  books: Book[]
  blocks: Block[]
}

export interface LibraryOptions {
  seed: number
  /** Stamped on every book, and the deleted books' `trashedAt`. Default 2026-11-12T00:00:00Z. */
  now?: string
  /** Every book's words times this (default 1): a smoke run's small library of the same shape. */
  scale?: number
  /**
   * The board's cards (note ids) the long books are made from: a card mark on 1 block in
   * 5 of them, and each figure's card. None: no card marks.
   */
  cards?: readonly string[]
  /** The photo (an asset on the board) the long books' figures show. None: no figures. */
  asset?: string
}

/** The shape of a long book: a card mark on 1 block in this many… */
export const LIBRARY_CARD_EVERY = 5
/** …a prompt after every this many blocks… */
export const LIBRARY_PROMPT_EVERY = 30
/** …and a figure after every this many. */
export const LIBRARY_FIGURE_EVERY = 200

const PROMPTS = (
  'Say where this happened|Who else was there?|Find the letter for this|Check the date|' +
  'A photo would help here|Say it more plainly|Ask about the river|Is this the same morning?'
).split('|')

/**
 * A long book's blocks with card marks, prompts and figures (`genLibrary`): every 5th text block
 * marked
 * whole with one of `cards` (a passage taken from a card on the board), a prompt after every 30th
 * block and a figure (the photo `asset`, made from a card) after every 200th. The book's own
 * blocks keep their ids, texts and places; the new ones go between them (`posBetween`).
 */
function withCardContent(
  blocks: readonly Block[],
  rng: () => number,
  cards: readonly string[],
  asset: string | undefined,
): Block[] {
  const out: Block[] = []
  const card = () => cards[Math.floor(rng() * cards.length)] as string
  for (let i = 0; i < blocks.length; i++) {
    let b = blocks[i] as Block
    const next = blocks[i + 1]
    if (cards.length > 0 && (i + 1) % LIBRARY_CARD_EVERY === 0 && b.text.length > 0) {
      const mark: Mark = { t: cardMarkT(card()), from: 0, to: b.text.length }
      b = { ...b, marks: [...b.marks, mark].sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0)) }
    }
    out.push(b)
    let after = b.pos
    const between = () => {
      after = posBetween(after, next?.pos ?? null)
      return after
    }
    if ((i + 1) % LIBRARY_PROMPT_EVERY === 0) {
      out.push({
        type: 'block',
        id: blockId(rng),
        bookId: b.bookId,
        pos: between(),
        kind: 'prompt',
        text: PROMPTS[Math.floor(rng() * PROMPTS.length)] as string,
        marks: [],
      })
    }
    if (asset !== undefined && (i + 1) % LIBRARY_FIGURE_EVERY === 0) {
      out.push({
        type: 'block',
        id: blockId(rng),
        bookId: b.bookId,
        pos: between(),
        kind: 'figure',
        text: prose(rng, 3 + Math.floor(rng() * 5)),
        marks: [],
        image: cards.length > 0 ? { assetId: asset, card: card() } : { assetId: asset },
      })
    }
  }
  return out
}

const DEFAULT_NOW = '2026-11-12T00:00:00.000Z'

const SHELF_TITLES = (
  'Field notes|Winter letters|Dissertation|Essays 2026|On collecting|The paper garden|' +
  'Milan, slowly|Recipes|Morning pages|A year of rivers|Untitled draft|Notes on light|' +
  'The Orchard|Paper Lanterns|Der lange Weg|Am Fenster|Small Hours|Threads'
).split('|')

function book(
  rng: () => number,
  title: string,
  shelfPos: string,
  now: string,
  cover?: Book['cover'],
): Book {
  return {
    type: 'book',
    id: seededId('book', rng),
    title,
    lang: 'en',
    shelfPos,
    cover: cover ?? {
      seed: Math.floor(rng() * 0x1_0000_0000),
      ink: COVER_INKS[Math.floor(rng() * COVER_INKS.length)] as Book['cover']['ink'],
      motif: COVER_MOTIFS[Math.floor(rng() * COVER_MOTIFS.length)] as Book['cover']['motif'],
    },
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

/** A book's own text seed: the library's, apart for each place on the shelf. */
const bookSeed = (seed: number, i: number) => (Math.imul(seed, 0x9e3779b1) + i * 7919 + 1) >>> 0

/**
 * The lifetime library, deterministic per seed. On the shelf the long book ("A lifetime", whose
 * text is `genBook`'s 200,000 words at `o.seed`, so seed 1 is the book ADR-0007 measured) comes
 * first, then the others in a seeded order. Linear time, nothing from Node.
 */
export function genLibrary(o: LibraryOptions): Library {
  const L = LIFETIME_LIBRARY
  const now = o.now ?? DEFAULT_NOW
  const scaled = (w: number) => Math.max(20, Math.round(w * (o.scale ?? 1)))
  const rng = mulberry32(o.seed ^ 0x2545f491)
  const keys = posKeysBetween(null, null, L.books)
  // Words of the books after the long one: the four of 50,000 and the rest, in a seeded order.
  const sizes: number[] = Array.from({ length: L.books - 1 }, (_, i) =>
    i < L.midBooks
      ? L.midWords
      : L.restMinWords + Math.floor(rng() * (L.restMaxWords - L.restMinWords + 1)),
  )
  for (let i = sizes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[sizes[i], sizes[j]] = [sizes[j] as number, sizes[i] as number]
  }
  // Three of the short books are deleted.
  const short = sizes.flatMap((w, i) => (w === L.midWords ? [] : [i]))
  const trashed = new Set<number>()
  while (trashed.size < L.trashed) trashed.add(short[Math.floor(rng() * short.length)] as number)

  const books: Book[] = []
  const blocks: Block[] = []
  const long = book(rng, 'A lifetime', keys[0] as string, now, {
    seed: 11,
    ink: 'ink',
    motif: 'fields',
  })
  books.push(long)
  // The long books carry prompts, figures and passages from the board's cards.
  const content = mulberry32(o.seed ^ 0x27d4eb2f)
  const cards = o.cards ?? []
  const shaped = (bs: Block[]) => withCardContent(bs, content, cards, o.asset)
  blocks.push(
    ...shaped(genBookBlocks({ seed: o.seed, words: scaled(L.longWords), bookId: long.id })),
  )
  sizes.forEach((words, i) => {
    const base = SHELF_TITLES[i % SHELF_TITLES.length] as string
    const title =
      i < SHELF_TITLES.length ? base : `${base} ${Math.floor(i / SHELF_TITLES.length) + 1}`
    const b = book(rng, title, keys[i + 1] as string, now)
    if (trashed.has(i)) b.trashedAt = now
    books.push(b)
    const own = genBookBlocks({ seed: bookSeed(o.seed, i), words: scaled(words), bookId: b.id })
    blocks.push(...(words === L.midWords ? shaped(own) : own))
  })
  // Each book's `cards` as the server stamps them: the cards its blocks name.
  const byBook = new Map<string, Block[]>()
  for (const b of blocks) {
    const list = byBook.get(b.bookId)
    if (list === undefined) byBook.set(b.bookId, [b])
    else list.push(b)
  }
  for (const b of books) {
    const named = cardsFromBlocks(byBook.get(b.id) ?? [])
    if (named.length > 0) b.cards = named
  }
  return { books, blocks }
}

/** The limit row's book: one of 500,000 words. */
export function genLimitBook(o: LibraryOptions): Library {
  const now = o.now ?? DEFAULT_NOW
  const rng = mulberry32(o.seed ^ 0x6c8e9cf5)
  const b = book(rng, 'The long one', posKeysBetween(null, null, 1)[0] as string, now)
  return {
    books: [b],
    blocks: genBookBlocks({
      seed: bookSeed(o.seed, 1_000),
      words: Math.max(20, Math.round(LIFETIME_LIBRARY.limitWords * (o.scale ?? 1))),
      bookId: b.id,
    }),
  }
}

/**
 * The client ops that put `lib` on a board (the cards and the photo it names already there): each
 * book made (not deleted: a create carries
 * `trashedAt: null`), then every block in order, then the deleted books' `trashedAt` set.
 */
export function libraryOps(lib: Library): ClientOp[] {
  return [
    // `cards` is the server's to stamp, from the blocks as they come.
    ...lib.books.map(
      ({ cards: _cards, ...b }): ClientOp => ({
        op: 'book.create',
        book: { ...b, trashedAt: null },
      }),
    ),
    ...lib.blocks.map((block): ClientOp => ({ op: 'block.create', block })),
    ...lib.books.flatMap((b): ClientOp[] =>
      b.trashedAt === null
        ? []
        : [{ op: 'book.update', id: b.id, set: { trashedAt: b.trashedAt } }],
    ),
  ]
}

/**
 * The chapter-move row's book: `o.blocks` short paragraphs (`maxBlocksPerBook`'s 60,000 for the
 * row) in two chapters of half each, an `h1` opening each.
 */
export function genChapterBook(o: { seed: number; blocks: number; now?: string }): Library {
  const now = o.now ?? DEFAULT_NOW
  const rng = mulberry32(o.seed ^ 0x1b873593)
  const b = book(rng, 'Two halves', posKeysBetween(null, null, 1)[0] as string, now)
  const keys = posKeysBetween(null, null, o.blocks)
  const half = Math.floor(o.blocks / 2)
  const blocks: Block[] = keys.map((pos, i) => ({
    type: 'block',
    id: blockId(rng),
    bookId: b.id,
    pos,
    kind: i === 0 || i === half ? 'h1' : 'p',
    text: i === 0 ? 'The first half' : i === half ? 'The second half' : prose(rng, 4 + (i % 9)),
    marks: [],
  }))
  return { books: [b], blocks }
}

/**
 * A `genChapterBook`'s second chapter moved before its first, as the outline moves a chapter
 * (`apps/web/src/book/chapterMove.ts`): a `block.set pos` for each of its blocks, keys spread
 * before the book's first block. One staged transaction (at most 64 parts of 500).
 */
export function chapterMoveOps(lib: Library): ClientOp[] {
  const half = Math.floor(lib.blocks.length / 2)
  const moved = lib.blocks.slice(half)
  const keys = posKeysBetween(null, (lib.blocks[0] as Block).pos, moved.length)
  return moved.map((b, i) => ({
    op: 'block.set',
    bookId: b.bookId,
    id: b.id,
    set: { pos: keys[i] as string },
  }))
}
