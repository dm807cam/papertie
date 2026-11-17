/**
 * Find in the writer: the whole book searched by the board's fold, in 4 ms
 * slices of a bounded number of blocks, cancelled by its signal.
 */
import {
  applyBatch,
  type Block,
  type BoardState,
  bookBlocks,
  type ClientOp,
  emptyBoardState,
  posKeysBetween,
} from '@papertie/core'
import { FIND_STEP, findInBook, type Match, matchesIn } from '../../src/book/find/find'
import { book } from '../helpers/books'
import { BOARD_ID, idOf, T0 } from '../helpers/fakeServer'

const ID = idOf('book', 3)
const ASSET = `asset_${'0'.repeat(25)}1`

type Kind = Block['kind']

function bookState(rows: ReadonlyArray<[Kind, string]>): BoardState {
  const keys = posKeysBetween(null, null, rows.length)
  const ops: ClientOp[] = [
    { op: 'book.create', book: { ...book(ID, { title: 'Found' }), trashedAt: null } },
    {
      op: 'asset.add',
      asset: {
        type: 'asset',
        id: ASSET,
        mime: 'image/webp',
        width: 300,
        height: 200,
        bytes: 1000,
        sha256: 'a'.repeat(64),
        createdAt: T0,
      },
    } as unknown as ClientOp,
    ...rows.map(
      ([kind, text], i): ClientOp => ({
        op: 'block.create',
        block: {
          type: 'block',
          id: idOf('block', i + 1),
          bookId: ID,
          pos: keys[i] as string,
          kind,
          text,
          marks: [],
          ...(kind === 'figure' ? { image: { assetId: ASSET } } : {}),
        },
      }),
    ),
  ]
  return applyBatch(emptyBoardState(BOARD_ID, 'Test board', T0), ops, { now: T0 })
}

/** Every match, once the search is done. */
function findAll(state: BoardState, query: string): Promise<Match[]> {
  return new Promise((resolve) => {
    const out: Match[] = []
    findInBook(state, ID, query, {
      signal: new AbortController().signal,
      pace: { hidden: () => false, yield: () => Promise.resolve() },
      onSome(m, done) {
        out.push(...m)
        if (done) resolve(out)
      },
    })
  })
}

describe('matchesIn', () => {
  it('finds case- and width-folded matches and maps them to the text’s own offsets', () => {
    const at = (text: string, q: string) => matchesIn(text, q).map(([a, b]) => text.slice(a, b))
    // Case, and every match (not only the first), never overlapping.
    expect(matchesIn('Ink and ink, INK.', 'ink')).toEqual([
      [0, 3],
      [8, 11],
      [13, 16],
    ])
    // Width: full-width letters fold to their ASCII.
    expect(at('a ⒾⓃⓀ well', 'ink')).toEqual(['ⒾⓃⓀ'])
    // A ligature: ﬁ is one unit in the text, "fi" in the fold; the match maps to the ligature.
    const fi = 'The ﬁeld, the field.'
    expect(matchesIn(fi, 'field')).toEqual([
      [4, 8],
      [14, 19],
    ])
    expect(at(fi, 'fi')).toEqual(['ﬁ', 'fi'])
    // Σ and ς: final sigma unified, whatever the case or the place in the word.
    expect(at('ΟΔΟΣ and οδος', 'οδοσ')).toEqual(['ΟΔΟΣ', 'οδος'])
    expect(at('ΟΔΟΣ', 'ΟΔΟς')).toEqual(['ΟΔΟΣ'])
    // A composed é (U+00E9) and a decomposed one (e + U+0301) find each other…
    const composed = 'café'
    const decomposed = 'café'
    expect(matchesIn(`${composed} ${decomposed}`, composed)).toEqual([
      [0, 4],
      [5, 10],
    ])
    expect(matchesIn(`${composed} ${decomposed}`, decomposed)).toEqual([
      [0, 4],
      [5, 10],
    ])
    // …but accents count as typed: "e" does not find "é", and "é" does not find "e".
    expect(matchesIn(`${composed} ${decomposed}`, 'cafe')).toEqual([])
    expect(matchesIn('cafe', composed)).toEqual([])
    // An empty or blank query finds nothing.
    expect(matchesIn('anything', '')).toEqual([])
    expect(matchesIn('any thing', '  ')).toEqual([])
  })
})

describe('findInBook', () => {
  it('finds matches beyond the window, in book order, in slices of at most 4 ms of work', async () => {
    const n = FIND_STEP * 6 + 17
    const rows: Array<[Kind, string]> = Array.from({ length: n }, (_, i) => [
      'p',
      i % 50 === 7 ? `Block ${i}: a lantern, and a Lantern.` : `Block ${i}: quiet prose.`,
    ])
    const state = bookState(rows)
    let read = 0
    const counted = new Map<string, Block>()
    for (const [id, b] of state.blocks)
      counted.set(
        id,
        new Proxy(b, {
          get(t, k, r) {
            if (k === 'text') read++
            return Reflect.get(t, k, r)
          },
        }),
      )
    const fake = { ...state, blocks: counted } as BoardState
    // The index made (it reads every text once); from here each block the search reads counts.
    expect(bookBlocks(fake.blocks, ID).count).toBe(n)
    read = 0
    const perSlice: number[] = []
    let t = 0
    const found: Match[] = []
    let calls = 0
    await new Promise<void>((resolve) => {
      findInBook(fake, ID, 'lantern', {
        signal: new AbortController().signal,
        // A clock past the slice's 4 ms at every look: each step is a slice of its own.
        pace: {
          hidden: () => false,
          clock: () => (t += 5),
          yield: () => {
            perSlice.push(read)
            read = 0
            return Promise.resolve()
          },
        },
        onSome(m, done) {
          calls++
          found.push(...m)
          if (done) resolve()
        },
      })
    })
    perSlice.push(read)
    // Never more than one step of blocks in a slice; the whole book read.
    expect(Math.max(...perSlice)).toBeLessThanOrEqual(FIND_STEP)
    expect(perSlice.reduce((a, b) => a + b, 0)).toBe(n)
    expect(perSlice.length).toBeGreaterThan(6)
    // Results came a slice at a time, not all at the end.
    expect(calls).toBeGreaterThan(2)
    // Every match, in book order: two per marked block, the last ones far past any window.
    const marked = rows.flatMap(([, text], i) => (text.includes('lantern') ? [i] : []))
    expect(found.map((m) => m.blockId)).toEqual(
      marked.flatMap((i) => [idOf('block', i + 1), idOf('block', i + 1)]),
    )
    const first = rows[7]?.[1] as string
    expect(found.slice(0, 2).map((m) => first.slice(m.from, m.to))).toEqual(['lantern', 'Lantern'])
  })

  it('stops when aborted', async () => {
    const state = bookState(
      Array.from({ length: FIND_STEP * 4 }, (_, i): [Kind, string] => ['p', `ink ${i}`]),
    )
    // Aborted before it begins: it never reports (it starts after a task boundary).
    const early = new AbortController()
    const said: boolean[] = []
    findInBook(state, ID, 'ink', {
      signal: early.signal,
      onSome: (_m, done) => said.push(done),
    })
    early.abort()
    // Aborted after its first slice: nothing more is said.
    const late = new AbortController()
    let t = 0
    const slices: number[] = []
    findInBook(state, ID, 'ink', {
      signal: late.signal,
      pace: {
        hidden: () => false,
        clock: () => (t += 5),
        yield: () => Promise.resolve(),
      },
      onSome(m, done) {
        slices.push(m.length)
        said.push(done)
        late.abort()
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(slices).toEqual([FIND_STEP])
    expect(said).toEqual([false])
  })

  it('prompts and captions are searched', async () => {
    const state = bookState([
      ['h1', 'A chapter of rivers'],
      ['p', 'The paragraph says nothing.'],
      ['prompt', 'Ask about the river here'],
      ['figure', 'The river at dawn'],
      ['quote', 'Rivers remember.'],
    ])
    const found = await findAll(state, 'river')
    expect(found.map((m) => m.blockId)).toEqual([
      idOf('block', 1),
      idOf('block', 3),
      idOf('block', 4),
      idOf('block', 5),
    ])
  })
})
