// @vitest-environment node
/**
 * The search index: a trigram index over NFKC-folded note text, kept in a
 * worker and updated per commit. Run here in node: the worker's side (`serve`, `TrigramIndex`)
 * talks to the page's side (`createSearchIndex`) over a real `MessageChannel`, so every message
 * is structured-cloned and answered in order, as it is between a page and its worker.
 */
import { loadavg } from 'node:os'
import { type Board, type BoardState, type Note, stateFromRecords } from '@papertie/core'
import { TrigramIndex } from '../../src/search/index.worker'
import {
  attachSearchIndex,
  type SearchChanges,
  type SearchIndex,
} from '../../src/search/searchIndex'
import { createBoardStore } from '../../src/store/boardStore'

const T0 = '2026-10-27T10:00:00.000Z'
const STAMPS = [
  '2026-10-27T10:00:00.000Z',
  '2026-10-28T09:30:00.000Z',
  '2026-10-29T18:00:00.000Z',
  '2026-10-30T07:15:00.000Z',
]
const nid = (n: number) => `note_${String(n).padStart(26, '0')}`

const BOARD: Board = {
  type: 'board',
  schemaVersion: 6,
  id: `board_${'0'.repeat(25)}1`,
  name: 'Test',
  revision: 0,
  clients: {},
  createdAt: T0,
  updatedAt: T0,
}

function note(n: number, text: string, updatedAt = T0): Note {
  return {
    type: 'note',
    id: nid(n),
    x: 0,
    y: 0,
    w: 240,
    h: 160,
    z: n,
    paper: 'cream',
    style: 'rustic',
    text,
    image: null,
    createdAt: T0,
    updatedAt,
  }
}

const board = (notes: Note[]): BoardState => stateFromRecords(BOARD, notes)

/** A page's index on a worker's, joined by a real channel. */
const open: SearchIndex[] = []

afterEach(() => {
  for (const index of open.splice(0)) index.dispose()
})

// The timed rows of searchIndex.test.ts (wall-time bounds), in the timing project (`vitest.config.ts`).
// The default file keeps each row's untimed proof (the one-note commit's diff, an edit's and a
// needle's hits), without its bound.
describe('index stays consistent under remote commits', () => {
  it('a commit sends only the notes it changed, found without a scan of the board', () => {
    const notes = Array.from({ length: 100_000 }, (_, i) => note(i + 1, `note ${i + 1}`))
    const store = createBoardStore(board(notes))
    const sent: SearchChanges[] = []
    const loads: number[] = []
    const spy: SearchIndex = {
      load: (all) => void loads.push([...all].length),
      apply: (c) => void sent.push(c),
      query: async () => [],
      recent: async () => [],
      dispose: () => {},
    }
    const off = attachSearchIndex(store, spy)
    expect(loads).toEqual([100_000])
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      store.commit([{ op: 'note.update', id: nid(54_321), set: { text: `changed ${i}` } }])
      best = Math.min(best, performance.now() - t0)
    }
    store.commit([{ op: 'note.update', id: nid(7), set: { x: 40 } }])
    store.commit([{ op: 'note.delete', id: nid(8) }])
    expect(sent).toHaveLength(7)
    expect(sent[0]?.put.map((d) => [d.id, d.text])).toEqual([[nid(54_321), 'changed 0']])
    // A move changes no text, but `updatedAt` ranks: it is sent too.
    expect(sent[5]?.put.map((d) => d.id)).toEqual([nid(7)])
    expect(sent[6]).toEqual({ put: [], removed: [nid(8)] })
    console.info(`index: a one-note commit on 100,000 notes ${best.toFixed(3)} ms with the diff`)
    expect(best).toBeLessThanOrEqual(4)
    off()
  })
})

// ---- bench-style: the worker's own query time ------------------------------------------------

const WORDS = [
  'knot',
  'Łódź',
  'Kraków',
  'Zürich',
  'meeting',
  'sketch',
  'memo',
  'notion',
  'papertie',
  'notebook',
  'thing',
  'for',
  'about',
  'working',
  'company',
  'journey',
  'photo',
  'kork',
  'rustic',
  'yarn',
  'cork',
  'board',
  'thread',
  'paper',
  'paris',
  'meeting',
  'design',
  'idea',
  'the',
  'and',
  'notes',
  'plan',
  'review',
  'Ⓟⓐⓡⓘⓢ',
  'ﬁle',
]

/** p-th percentile of `xs`. */
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0
}

describe('query p95 ≤ 16 ms on 100,000 notes (worker, bench-style)', () => {
  it('times the worker index on a lifetime board', () => {
    let seed = 11
    const rand = (k: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % k
    }
    const ix = new TrigramIndex()
    const texts: string[] = []
    const t0 = performance.now()
    for (let i = 0; i < 100_000; i++) {
      const words: string[] = []
      const count = 6 + rand(14)
      for (let w = 0; w < count; w++) words.push(WORDS[rand(WORDS.length)] as string)
      const text = `${words.join(rand(2) === 0 ? ' ' : '')} ${i}`
      texts.push(text)
      ix.put(nid(i + 1), text, STAMPS[rand(STAMPS.length)] as string)
    }
    const built = performance.now() - t0
    // What a writer types: the prefixes of a word or two of some note, one key at a time, and
    // things that are nowhere.
    const queries: string[] = []
    while (queries.length < 300) {
      const t = texts[rand(texts.length)] as string
      const at = rand(Math.max(1, t.length - 8))
      const word = t.slice(at, at + 2 + rand(8))
      for (let k = 1; k <= word.length && queries.length < 300; k++) queries.push(word.slice(0, k))
      if (rand(5) === 0) queries.push('xylophone quartz')
    }
    for (const q of queries.slice(0, 50)) ix.query(q, 8) // warm
    const times = queries.map((q) => {
      let best = Number.POSITIVE_INFINITY
      for (let r = 0; r < 3; r++) {
        const s = performance.now()
        ix.query(q, 8)
        best = Math.min(best, performance.now() - s)
      }
      return best
    })
    const p50 = percentile(times, 50)
    const p95 = percentile(times, 95)
    console.info(
      `search index at 100,000 notes: built ${built.toFixed(0)} ms, query p50 ${p50.toFixed(2)} ms, ` +
        `p95 ${p95.toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms ` +
        `(load1 ${loadavg()[0]?.toFixed(2)})`,
    )
    expect(p95).toBeLessThanOrEqual(16)
  }, 120_000)
})

describe('an edit or a removal costs what the note holds, not the board', () => {
  /** The mean ms of a removal and a fresh put of one note, over `n` notes on an index of `size`. */
  function churn(size: number, n = 2000): number {
    const ix = new TrigramIndex()
    const text = (i: number) => `Knots of Łódź, a meeting: cork board, design memo, idea ${i}`
    for (let i = 0; i < size; i++) ix.put(nid(i + 1), text(i), T0)
    // Warm the paths first, on notes the timing does not touch.
    for (let i = 0; i < 200; i++) {
      ix.remove(nid(size - i))
      ix.put(nid(size - i), `${text(i)} warm`, T0)
    }
    const t0 = performance.now()
    for (let k = 0; k < n; k++) {
      const id = nid(1 + ((k * 7919) % (size - 400)))
      ix.remove(id)
      ix.put(id, `${text(k)} again`, T0)
    }
    return (performance.now() - t0) / n
  }

  it('a removal and a re-put at 100,000 notes stay well under 0.1 ms, flat from 25,000', () => {
    const small = churn(25_000)
    const large = churn(100_000)
    console.info(
      `remove + put: ${small.toFixed(4)} ms at 25,000 notes, ${large.toFixed(4)} ms at 100,000`,
    )
    expect(large).toBeLessThan(0.1)
    expect(large).toBeLessThan(Math.max(3 * small, 0.02))
  }, 120_000)

  it('an edit of the text costs what the note holds, not the board', () => {
    const ix = new TrigramIndex()
    for (let i = 0; i < 100_000; i++) ix.put(nid(i + 1), `Knots of Łódź cork board ${i}`, T0)
    const t0 = performance.now()
    for (let k = 0; k < 2000; k++)
      ix.put(nid(1 + k * 37), `design memo idea ${k}`, STAMPS[1] as string)
    const ms = (performance.now() - t0) / 2000
    console.info(`text edit at 100,000 notes: ${ms.toFixed(4)} ms`)
    expect(ms).toBeLessThan(0.1)
    expect(ix.query('design memo', 3).map((h) => h.id)).toHaveLength(3)
    expect(ix.query('knots of łódź', 100_000)).toHaveLength(98_000)
  }, 120_000)
})

describe('a needle of one or two characters on 100,000 notes', () => {
  it('reads only the notes that hold its characters: a miss never scans the board', () => {
    const ix = new TrigramIndex()
    // Letters past Latin-1 (Łódź): two-byte strings, where a scan for a miss reads every unit.
    for (let i = 0; i < 100_000; i++) {
      ix.put(nid(i + 1), `Łódź knots, a meeting at the cork board: design memo, idea ${i}`, T0)
    }
    ix.put(nid(100_001), 'Kwiat tower plan in Łódź', T0)
    const best = (q: string) => {
      let ms = Number.POSITIVE_INFINITY
      for (let r = 0; r < 5; r++) {
        const s = performance.now()
        ix.query(q, 8)
        ms = Math.min(ms, performance.now() - s)
      }
      return ms
    }
    // One note holds kw, none holds x or zq: each answer reads at most a short posting list.
    expect(ix.query('kw', 8).map((h) => h.id)).toEqual([nid(100_001)])
    expect(ix.query('x', 8)).toEqual([])
    const times = { kw: best('kw'), x: best('x'), zq: best('zq') }
    console.info(`short needles at 100,001 notes: ${JSON.stringify(times)} ms`)
    for (const ms of Object.values(times)) expect(ms).toBeLessThanOrEqual(0.5)
  }, 120_000)
})
