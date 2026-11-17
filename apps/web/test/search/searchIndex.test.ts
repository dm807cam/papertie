/**
 * The search index: a trigram index over NFKC-folded note text, kept in a
 * worker and updated per commit. Run here in node: the worker's side (`serve`, `TrigramIndex`)
 * talks to the page's side (`createSearchIndex`) over a real `MessageChannel`, so every message
 * is structured-cloned and answered in order, as it is between a page and its worker.
 */
import {
  applyBatch,
  type Board,
  type BoardState,
  type ClientOp,
  invertBatch,
  type Note,
  searchNotes,
  stateFromRecords,
  touchedNone,
} from '@papertie/core'
import fc from 'fast-check'
import {
  type IndexPort,
  type IndexReply,
  type IndexRequest,
  serve,
  TrigramIndex,
} from '../../src/search/index.worker'
import {
  attachSearchIndex,
  createSearchIndex,
  localPortFrom,
  type SearchChanges,
  type SearchIndex,
  type SearchPort,
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
function channelIndex(): SearchIndex {
  const { port1, port2 } = new MessageChannel()
  serve(port1)
  const index = createSearchIndex(port2)
  open.push(index)
  return index
}

afterEach(() => {
  for (const index of open.splice(0)) index.dispose()
})

/** Index `state` and wait until the worker has it all. */
async function indexed(state: BoardState): Promise<SearchIndex> {
  const index = channelIndex()
  index.load(state.notes.values())
  await index.query('', 1)
  return index
}

// Width, case, accents composed and combining, ligatures, letters past Latin-1, Greek sigma, a
// dotted capital, a sign that unfolds into letters and an astral character: the folds that
// change length or depend on context.
const UNITS = [
  'a',
  'b',
  'A',
  'ⓐ',
  'Ⓑ',
  ' ',
  'e',
  '\u0301',
  'é',
  'É',
  'ﬁ',
  'ﬀ',
  'f',
  'i',
  'ø',
  'å',
  'ł',
  'Ł',
  'ź',
  'Σ',
  'σ',
  'ς',
  'İ',
  'ß',
  '™',
  '😀',
  '\n',
]
const arbText = fc.array(fc.constantFrom(...UNITS), { maxLength: 24 }).map((u) => u.join(''))

/** A query: a piece of some note's text (perhaps in capitals), or random units. */
const arbQuery = (texts: string[]) =>
  fc.oneof(
    fc
      .tuple(
        fc.nat({ max: Math.max(0, texts.length - 1) }),
        fc.nat({ max: 30 }),
        fc.nat({ max: 8 }),
        fc.boolean(),
      )
      .map(([i, at, len, upper]) => {
        const t = texts[i] ?? ''
        const piece = t.slice(at % (t.length + 1), (at % (t.length + 1)) + len)
        return upper ? piece.toUpperCase() : piece
      }),
    fc.array(fc.constantFrom(...UNITS), { maxLength: 6 }).map((u) => u.join('')),
  )

describe('index agrees with searchNotes', () => {
  it('for every query on boards of 200 notes (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(arbText, fc.constantFrom(...STAMPS)), {
          minLength: 200,
          maxLength: 200,
        }),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (rows, seed) => {
          const state = board(rows.map(([text, stamp], i) => note(i + 1, text, stamp)))
          const texts = rows.map(([t]) => t)
          const queries = fc.sample(arbQuery(texts), { numRuns: 25, seed })
          const index = await indexed(state)
          for (const q of queries) {
            for (const limit of [1, 8, 20, 200]) {
              expect(await index.query(q, limit)).toEqual(searchNotes(state, q, limit))
            }
          }
          index.dispose()
        },
      ),
      { numRuns: 40 },
    )
  })

  it('finds text across width, ligatures and accents: substrings, NFKC', async () => {
    const state = board([
      // A combining accent: NFKC composes it, as a precomposed é is typed.
      note(1, 'Meet at the cafe\u0301 by the station'),
      note(2, 'The ﬁnal design notes'),
      note(3, 'Ⓟⓐⓡⓘⓢ trip plans'),
      note(4, 'Acme Widgets™'),
    ])
    const index = await indexed(state)
    const ids = async (q: string) => (await index.query(q, 20)).map((h) => h.id)
    expect(await ids('café')).toEqual([nid(1)])
    expect(await ids('afé by')).toEqual([nid(1)])
    expect(await ids('final design')).toEqual([nid(2)])
    expect(await ids('ﬁnal')).toEqual([nid(2)])
    expect(await ids('paris')).toEqual([nid(3)])
    expect(await ids('PARIS TRIP')).toEqual([nid(3)])
    expect(await ids('widgetstm')).toEqual([nid(4)])
    expect(await ids('é')).toEqual([nid(1)])
    expect(await ids('  ')).toEqual([])
  })

  it('answers the recent notes, newest first', async () => {
    const state = board([
      note(1, 'one', STAMPS[0]),
      note(2, 'two', STAMPS[2]),
      note(3, 'three', STAMPS[1]),
    ])
    const index = await indexed(state)
    expect(await index.recent(2)).toEqual([nid(2), nid(3)])
    expect(await index.recent(0)).toEqual([])
  })
})

/** A remote change: what the store committed by itself, as a server session swaps it in. */
function remote(state: BoardState, ops: ClientOp[], now: string): BoardState {
  return applyBatch(state, ops, { now })
}

describe('index stays consistent under remote commits', () => {
  it('every query answers the board as it stood when it was asked; deleted notes never come back', async () => {
    let n = 0
    const texts = ['knot cord', 'Paris Ⓟⓐⓡⓘⓢ', 'ﬁne board', 'fibre paper', 'cork pin']
    const initial = board(Array.from({ length: 3000 }, () => note(++n, `${texts[n % 5]} ${n}`)))
    const store = createBoardStore(initial)
    const index = channelIndex()
    // Attached while the store already holds 3,000 notes: the load is still going out in
    // slices while the commits below arrive.
    const off = attachSearchIndex(store, index)
    const queries = ['knot', 'paris', 'fine', 'paper 1', 'pin', 'q', 'zz', 'cord 2']
    const checks: Array<Promise<void>> = []
    let rng = 7
    const rand = (k: number) => {
      rng = (rng * 1_103_515_245 + 12_345) % 2_147_483_648
      return rng % k
    }
    /** The last random round, for an undo; the last undo, for a redo. */
    let last: { before: BoardState; ops: ClientOp[] } | null = null
    let undone: ClientOp[] | null = null
    let recreated = 0
    for (let round = 0; round < 150; round++) {
      const now = new Date(Date.parse(T0) + (round + 1) * 1000).toISOString()
      let ops: ClientOp[] = []
      if (round % 5 === 3 && last !== null) {
        // Undo the round before: its deleted notes come back under their own ids, its new
        // note goes.
        ops = invertBatch(last.before, last.ops) as ClientOp[]
        recreated += last.ops.filter((o) => o.op === 'note.delete').length
        undone = last.ops
        last = null
      } else if (round % 5 === 4 && undone !== null) {
        // Redo it: the note the undo took off is made again under the same id.
        ops = undone
        undone = null
      } else {
        const live = [...store.getState().notes.keys()]
        const touched = new Set<string>()
        for (let k = 0; k < 4; k++) {
          const id = live[rand(live.length)] as string
          if (touched.has(id)) continue
          touched.add(id)
          if (rand(3) === 0) ops.push({ op: 'note.delete', id })
          else
            ops.push({ op: 'note.update', id, set: { text: `${texts[rand(5)]} edited ${round}` } })
        }
        ops.push({ op: 'note.create', note: note(++n, `${texts[rand(5)]} new ${round}`, now) })
      }
      const before = store.getState()
      // Half come from the store (the store's board swapped), half are the page's own.
      if (round % 2 === 0) store.replace(remote(before, ops, now))
      else store.commit(ops)
      if (round % 5 < 3) last = { before, ops }
      const state = store.getState()
      for (const q of [queries[round % queries.length] as string, 'edited', 'new']) {
        checks.push(
          index.query(q, 20).then((hits) => {
            expect(hits).toEqual(searchNotes(state, q, 20))
            for (const h of hits) expect(state.notes.has(h.id)).toBe(true)
          }),
        )
      }
    }
    await Promise.all(checks)
    expect(recreated).toBeGreaterThan(5)
    const final = store.getState()
    for (const q of ['edited', 'new', 'cord']) {
      expect(await index.query(q, 5000)).toEqual(searchNotes(final, q, 5000))
    }
    off()
  })

  it('a reload of the whole board (a reset) re-indexes it', async () => {
    const store = createBoardStore(board([note(1, 'old words'), note(2, 'kept words')]))
    const index = channelIndex()
    const off = attachSearchIndex(store, index)
    store.replace(board([note(2, 'kept words'), note(3, 'fresh words')]))
    expect((await index.query('words', 20)).map((h) => h.id).sort()).toEqual([nid(2), nid(3)])
    off()
  })

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
    off()
  })

  it("an opening's slice is read from the notes the store says it touched, never by a walk", () => {
    const store = createBoardStore(board([note(1, 'drawn'), note(2, 'gone soon')]))
    const sent: SearchChanges[] = []
    const spy: SearchIndex = {
      load: () => {},
      apply: (c) => void sent.push(c),
      query: async () => [],
      recent: async () => [],
      dispose: () => {},
    }
    const off = attachSearchIndex(store, spy)
    const cur = store.getState()
    const next = new Map(cur.notes)
    next.set(nid(3), note(3, 'joined'))
    next.delete(nid(2))
    // A note map that answers by key and never lets itself be walked: an O(slice) read only.
    const walked = () => {
      throw new Error('the whole note map was walked for a slice')
    }
    const unwalkable = Object.assign(next, {
      [Symbol.iterator]: walked,
      entries: walked,
      keys: walked,
      values: walked,
      forEach: walked,
    })
    store.replace(
      { ...cur, notes: unwalkable },
      { ...touchedNone(), notes: new Set([nid(3), nid(2)]) },
    )
    expect(sent).toEqual([{ put: [note(3, 'joined')], removed: [nid(2)] }])
    off()
  })
})

describe('a worker that fails', () => {
  /** A port that takes messages and never answers, until it is made to fail. */
  function deadPort(opts: { throwOnPost?: boolean } = {}) {
    const port: SearchPort & { sent: number; terminated: boolean } = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      sent: 0,
      terminated: false,
      postMessage() {
        port.sent++
        if (opts.throwOnPost && port.sent > 1) throw new DOMException('no', 'DataCloneError')
      },
      terminate() {
        port.terminated = true
      },
    }
    return port
  }

  it('is replaced by the index on this thread, rebuilt from the board; questions waiting are answered', async () => {
    const state = board([note(1, 'Paris trip'), note(2, 'Ⓟⓐⓡⓘⓢ station'), note(3, 'Turin')])
    const store = createBoardStore(state)
    const port = deadPort()
    const index = createSearchIndex(port)
    open.push(index)
    const off = attachSearchIndex(store, index)
    const waiting = index.query('paris', 20)
    store.commit([{ op: 'note.update', id: nid(3), set: { text: 'paris again' } }])
    port.onerror?.(new Event('error') as ErrorEvent)
    expect(port.terminated).toBe(true)
    expect(await waiting).toEqual(searchNotes(store.getState(), 'paris', 20))
    expect(await index.query('station', 20)).toEqual(searchNotes(store.getState(), 'station', 20))
    store.commit([{ op: 'note.delete', id: nid(1) }])
    expect(await index.query('paris', 20)).toEqual(searchNotes(store.getState(), 'paris', 20))
    off()
  })

  it('questions waiting when it fails are hurried on the new index, not left to idle time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // A page that is never idle: only a hurried load (a task per slice) gets anywhere.
    vi.stubGlobal('requestIdleCallback', () => 1)
    vi.stubGlobal('cancelIdleCallback', () => undefined)
    const notes = Array.from({ length: 5500 }, (_, i) => note(i + 1, `n ${i}`))
    const store = createBoardStore(board(notes))
    const port = deadPort()
    const index = createSearchIndex(port)
    open.push(index)
    const off = attachSearchIndex(store, index)
    let answer: Awaited<ReturnType<typeof index.query>> | null = null
    void index.query('n 5499', 1).then((r) => {
      answer = r
    })
    port.onerror?.(new Event('error') as ErrorEvent)
    try {
      for (let i = 0; i < 20 && answer === null; i++) await vi.advanceTimersByTimeAsync(10)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
    expect(answer).toEqual(searchNotes(store.getState(), 'n 5499', 1))
    off()
  })

  it('a message it cannot take (a postMessage that throws) fails over the same way', async () => {
    const store = createBoardStore(board([note(1, 'rustic'), note(2, 'cork')]))
    const port = deadPort({ throwOnPost: true })
    const index = createSearchIndex(port)
    open.push(index)
    const off = attachSearchIndex(store, index)
    expect(await index.query('cork', 20)).toEqual(searchNotes(store.getState(), 'cork', 20))
    expect(port.terminated).toBe(true)
    off()
  })

  it('a messageerror fails over too', async () => {
    const store = createBoardStore(board([note(1, 'rustic')]))
    const port = deadPort()
    const index = createSearchIndex(port)
    open.push(index)
    const off = attachSearchIndex(store, index)
    const waiting = index.recent(5)
    port.onmessageerror?.(new Event('messageerror') as MessageEvent)
    expect(await waiting).toEqual([nid(1)])
    off()
  })
})

describe('excluded notes', () => {
  it('are skipped in the worker, so a list past them still fills', async () => {
    const notes: Note[] = []
    for (let i = 1; i <= 100; i++) {
      notes.push(note(i, `entry ${i}`, new Date(Date.parse(T0) + i * 60_000).toISOString()))
    }
    const index = await indexed(board(notes))
    // The 60 edited last are excluded (a focus holding them, say).
    const skip = new Set(notes.slice(40).map((n) => n.id))
    const recent = await index.recent(8, skip)
    expect(recent).toEqual(Array.from({ length: 8 }, (_, i) => nid(40 - i)))
    const hits = await index.query('entry', 8, skip)
    expect(hits).toHaveLength(8)
    for (const h of hits) expect(skip.has(h.id)).toBe(false)
    // Without it, the same index answers the whole board again.
    expect(await index.recent(1)).toEqual([nid(100)])
    expect(await index.query('entry 1', 3)).toEqual(searchNotes(board(notes), 'entry 1', 3))
  })

  it('are sent once per change of what they hold, not per question', async () => {
    const { port1, port2 } = new MessageChannel()
    serve(port1)
    const sent: string[] = []
    const post = port2.postMessage.bind(port2)
    port2.postMessage = (m: { t: string }) => {
      sent.push(m.t)
      post(m)
    }
    const index = createSearchIndex(port2 as unknown as SearchPort)
    open.push(index)
    index.load([note(1, 'a b c')])
    const skip = new Set([nid(1)])
    await index.query('abc', 8, skip)
    await index.query('abcd', 8, new Set([nid(1)]))
    await index.recent(8, skip)
    await index.recent(8)
    await index.recent(8)
    expect(sent.filter((t) => t === 'exclude')).toHaveLength(2)
  })
})

describe('loading in slices', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps one chain of slices, however many questions hurry it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const idle = new Map<number, () => void>()
    let next = 0
    vi.stubGlobal('requestIdleCallback', (fn: (d: { timeRemaining(): number }) => void) => {
      const id = ++next
      idle.set(id, () => fn({ timeRemaining: () => 0 }))
      return id
    })
    vi.stubGlobal('cancelIdleCallback', (id: number) => void idle.delete(id))
    const scheduled = () => idle.size + vi.getTimerCount()
    const { port1, port2 } = new MessageChannel()
    serve(port1)
    const index = createSearchIndex(port2)
    open.push(index)
    index.load(Array.from({ length: 5500 }, (_, i) => note(i + 1, `n ${i}`)))
    expect(scheduled()).toBe(1)
    const asked = [index.query('n 1', 1), index.query('n 2', 1), index.recent(1)]
    expect(scheduled()).toBe(1)
    let most = 0
    while (scheduled() > 0) {
      most = Math.max(most, scheduled())
      const [id, run] = [...idle][0] ?? []
      if (id !== undefined && run !== undefined) {
        idle.delete(id)
        run()
      } else vi.advanceTimersToNextTimer()
    }
    expect(most).toBe(1)
    vi.useRealTimers()
    expect((await Promise.all(asked)).map((r) => r.length)).toEqual([1, 1, 1])
  })
})

describe('compaction', () => {
  it('clears out dead slots a step at a time, answering the same before, during and after', () => {
    const ix = new TrigramIndex()
    const live = new Map<string, Note>()
    const put = (n: number, text: string, at = T0) => {
      const x = note(n, text, at)
      live.set(x.id, x)
      ix.put(x.id, text, at)
    }
    const drop = (n: number) => {
      live.delete(nid(n))
      ix.remove(nid(n))
    }
    for (let i = 1; i <= 6000; i++) put(i, `paper ${i} knot`)
    // Over half the notes go, or move on to a new text: their slots die.
    for (let i = 1; i <= 3000; i++) drop(i)
    for (let i = 3001; i <= 4500; i++) put(i, `cord ${i} Łódź`, STAMPS[2])
    const queries = ['paper', 'cord', 'knot', 'łódź', '45', 'zz', 'c']
    const reference = () =>
      queries.map((q) => searchNotes(board([...live.values()]), q, 20).map((h) => h.id))
    const answers = () => queries.map((q) => ix.query(q, 20).map((h) => h.id))
    expect(ix.wantsCompaction).toBe(true)
    expect(answers()).toEqual(reference())
    // Steps of no time at all: 256 slots each. Edits keep coming between them.
    let steps = 0
    let n = 6001
    while (ix.compactStep(0)) {
      steps++
      if (steps % 3 === 0) put(n++, `paper new ${n}`, STAMPS[3])
      if (steps % 4 === 0) drop(3001 + steps)
      if (steps % 5 === 0) put(4600 + steps, `cord moved ${steps}`, STAMPS[1])
      expect(answers()).toEqual(reference())
    }
    expect(steps).toBeGreaterThan(5)
    expect(ix.wantsCompaction).toBe(false)
    expect(ix.size).toBe(live.size)
    expect(answers()).toEqual(reference())
    expect(ix.recent(10)).toEqual(
      [...live.values()]
        .sort((a, b) =>
          a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : a.updatedAt > b.updatedAt ? -1 : 1,
        )
        .slice(0, 10)
        .map((x) => x.id),
    )
  })

  it('a pour during a compaction never makes one of its steps long: 5,000 notes changed meanwhile', () => {
    const ix = new TrigramIndex()
    const text = (i: number, v: string) =>
      `Łódź knots, a meeting at the cork board: design memo, idea ${v} ${i}`
    for (let i = 1; i <= 40_000; i++) ix.put(nid(i), text(i, 'a'), T0)
    for (let i = 1; i <= 25_000; i++) ix.remove(nid(i))
    expect(ix.wantsCompaction).toBe(true)
    ix.compactStep(0) // under way
    // The pour: 5,000 notes edited while the copy goes on, each one dirty for the last pass.
    for (let i = 25_001; i <= 30_000; i++) ix.put(nid(i), text(i, 'poured'), STAMPS[2] as string)
    // Steps of no time at all: each copies 256 slots, or takes 64 of the notes changed meanwhile,
    // then stops. The changed notes go in slices too, never all in one step.
    let longest = 0
    let steps = 0
    for (;;) {
      const t0 = performance.now()
      const more = ix.compactStep(0)
      longest = Math.max(longest, performance.now() - t0)
      steps++
      if (!more) break
    }
    console.info(
      `compaction with 5,000 dirty notes: ${steps} steps, longest ${longest.toFixed(2)} ms`,
    )
    const copy = Math.floor(45_000 / 256)
    const dirty = Math.floor(5000 / 64)
    expect(steps).toBeGreaterThanOrEqual(copy + dirty)
    expect(ix.wantsCompaction).toBe(false)
    expect(ix.size).toBe(15_000)
    expect(ix.query('poured', 10_000)).toHaveLength(5000)
  })

  it('the worker compacts on its own between messages', async () => {
    const port: IndexPort<IndexRequest, IndexReply> = { onmessage: null, postMessage: () => {} }
    const ix = serve(port)
    const say = (data: IndexRequest) => port.onmessage?.({ data } as MessageEvent<IndexRequest>)
    const ids = Array.from({ length: 10_000 }, (_, i) => nid(i + 1))
    say({ t: 'put', ids, texts: ids.map((id) => `note ${id}`), stamps: ids.map(() => T0) })
    say({ t: 'remove', ids: ids.slice(0, 6000) })
    expect(ix.wantsCompaction).toBe(true)
    for (let i = 0; i < 200 && ix.wantsCompaction; i++) await new Promise((r) => setTimeout(r, 0))
    expect(ix.wantsCompaction).toBe(false)
    expect(ix.size).toBe(4000)
    expect(ix.query('note', 5)).toHaveLength(5)
  })
})

describe('an edit or a removal costs what the note holds, not the board', () => {
  it('an edit of the text costs what the note holds, not the board', () => {
    // What it costs is the timing row's (`searchIndex.timing.test.ts`); here, what it finds.
    const ix = new TrigramIndex()
    for (let i = 0; i < 100_000; i++) ix.put(nid(i + 1), `Knots of Łódź cork board ${i}`, T0)
    for (let k = 0; k < 2000; k++)
      ix.put(nid(1 + k * 37), `design memo idea ${k}`, STAMPS[1] as string)
    expect(ix.query('design memo', 3).map((h) => h.id)).toHaveLength(3)
    expect(ix.query('knots of łódź', 100_000)).toHaveLength(98_000)
  }, 120_000)
})

describe('a needle of one or two characters on 100,000 notes', () => {
  it('reads only the notes that hold its characters: a miss never scans the board', () => {
    // What a needle reads, timed, is the timing row's (`searchIndex.timing.test.ts`); here, what
    // it finds.
    const ix = new TrigramIndex()
    for (let i = 0; i < 100_000; i++) {
      ix.put(nid(i + 1), `Łódź knots, a meeting at the cork board: design memo, idea ${i}`, T0)
    }
    ix.put(nid(100_001), 'Kwiat tower plan in Łódź', T0)
    // One note holds kw, none holds x or zq.
    expect(ix.query('kw', 8).map((h) => h.id)).toEqual([nid(100_001)])
    expect(ix.query('x', 8)).toEqual([])
    expect(ix.query('zq', 8)).toEqual([])
  }, 120_000)
})

describe('a note’s ref', () => {
  it('search finds a note by its ref', async () => {
    const reffed = { ...note(1, 'Simplify, simplify.'), ref: 'Henry David Thoreau, Walden, 1854' }
    const state = board([reffed, note(2, 'unrelated words'), note(3, 'Walden pond')])
    const index = await indexed(state)
    const hits = await index.query('thoreau', 20)
    expect(hits.map((h) => h.id)).toEqual([nid(1)])
    expect(hits[0]?.snippet).toContain('Henry David Thoreau')
    expect(hits).toEqual(searchNotes(state, 'thoreau', 20))
    expect((await index.query('walden', 20)).map((h) => h.id).sort()).toEqual([nid(1), nid(3)])

    // A ref given on the board is found at once.
    const store = createBoardStore(board([note(4, 'Notes on light')]))
    const live = channelIndex()
    const off = attachSearchIndex(store, live)
    store.commit([
      { op: 'note.update', id: nid(4), set: { ref: 'Newton, Opticks, Royal Society' } },
    ])
    expect((await live.query('royal society', 20)).map((h) => h.id)).toEqual([nid(4)])
    off()
  })

  it('a question can be limited to a kept set of notes: recent and query rank only them', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      note(10 + i, `walden plain ${i}`, `2026-11-13T12:00:${String(i).padStart(2, '0')}.000Z`),
    )
    const old = { ...note(1, 'Walden', '2026-01-01T00:00:00.000Z'), ref: 'Thoreau' }
    const index = await indexed(board([old, ...many]))
    const only = new Set([nid(1)])
    expect(await index.recent(8, undefined, only)).toEqual([nid(1)])
    expect((await index.query('walden', 8, undefined, only)).map((h) => h.id)).toEqual([nid(1)])
    // Without it, the plain cards fill the list.
    expect(await index.recent(8)).not.toContain(nid(1))
  })
})

describe('the index on this thread, when its code cannot load', () => {
  it('questions are answered empty, never left waiting', async () => {
    const failing = createSearchIndex(
      {
        onmessage: null,
        postMessage() {
          throw new Error('no worker')
        },
      },
      () => localPortFrom(() => Promise.reject(new Error('offline'))),
    )
    const answered = await Promise.race([
      failing.query('walden', 8).then((h) => ({ h })),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 1000)),
    ])
    expect(answered).toEqual({ h: [] })
    failing.dispose()
  })
})
