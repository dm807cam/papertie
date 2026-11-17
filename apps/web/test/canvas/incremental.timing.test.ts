// @vitest-environment jsdom
/**
 * The canvas updates only what changed: on a lifetime board of
 * 100,000 notes and 10,000 threads, one commit costs what it touched, never a pass over the board;
 * the thread topology, the spatial index and the springs follow edits incrementally and always
 * equal a rebuild; and a board swapped in whole is taken in slices, never as one long task. Here
 * the rows' wall and CPU times, run by the timing project a file at a time (`incremental.test.ts`
 * keeps their untimed proofs: the walks, the index, the catch-up's slices and topology).
 */
import { type BoardState, type Note, PMap, stateFromRecords, type Yarn } from '@papertie/core'
import { generateBoard } from '@papertie/tools/gen-board'
import { buildTopology, type Topology, topologyOf } from '../../src/canvas/attach'
import { CanvasRuntime } from '../../src/canvas/runtime'
import type { SpatialIndex } from '../../src/canvas/spatialIndex'
import type { YarnMotion } from '../../src/canvas/YarnMotion'
import { type BoardStore, createBoardStore } from '../../src/store/boardStore'
import { canvasElements, installCanvasStubs } from '../helpers/domCanvas'

/** What the runtime keeps that a test compares (private fields, read through a cast). */
interface Inside {
  index: SpatialIndex
  motion: YarnMotion
  /** The board the index, the springs and the topology stand for. */
  model: Pick<BoardState, 'notes' | 'yarns'>
  /** Catching up with a board swapped in whole; null once caught up. */
  catching: object | null
  /** One slice of catching up, until `end` (one step when `end` has passed). */
  catchUpSlice(end: number): boolean
}
const inside = (rt: CanvasRuntime) => rt as unknown as Inside

// ---- walks: the largest Map (or PMap) iterated while the runtime handles a commit ------------

type Iter = 'entries' | 'keys' | 'values' | 'forEach' | typeof Symbol.iterator
const ITERS: Iter[] = ['entries', 'keys', 'values', 'forEach', Symbol.iterator]
const MAP_VIEW = Object.getPrototypeOf(PMap.prototype) as Record<Iter, unknown>

/**
 * Run `f` and answer the size of the largest map it walked (iterated, in whole or in part): every
 * `Map` and every persistent map (`PMap`) of core.
 */
function largestWalk(f: () => void): number {
  let largest = 0
  const undo: Array<() => void> = []
  for (const proto of [Map.prototype, MAP_VIEW] as Array<Record<Iter, unknown>>) {
    for (const name of ITERS) {
      const was = proto[name] as (this: ReadonlyMap<unknown, unknown>, ...a: unknown[]) => unknown
      proto[name] = function (this: ReadonlyMap<unknown, unknown>, ...a: unknown[]) {
        largest = Math.max(largest, this.size)
        return was.apply(this, a)
      }
      undo.push(() => {
        proto[name] = was
      })
    }
  }
  try {
    f()
  } finally {
    for (const u of undo) u()
  }
  return largest
}

/**
 * The runtime's own share of each store change: a listener before it and one after it time it,
 * and the walk is measured over the same span.
 */
function bracket(store: BoardStore) {
  let t0 = 0
  let last = { ms: 0 }
  const off0 = store.subscribe(() => {
    t0 = performance.now()
  })
  return {
    after() {
      return store.subscribe(() => {
        last = { ms: performance.now() - t0 }
      })
    },
    get ms() {
      return last.ms
    },
    off0,
  }
}

// ---- the lifetime board ---------------------------------------------------------------------

const BIG = { notes: 100_000, yarns: 10_000 }

/** The same board loaded again: equal records (each a copy), nothing shared. */
function valueCopy(s: BoardState, note: (n: Note) => Note = (n) => ({ ...n })): BoardState {
  return stateFromRecords(s.board, [
    ...s.assets.values(),
    ...[...s.notes.values()].map(note),
    ...[...s.yarns.values()].map((y) => ({ ...y })),
  ])
}

/** Let `n` animation frames (and the tasks between them) run. */
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 17))
}

let restore: () => void = () => {}
let big: BoardState
beforeAll(() => {
  big = generateBoard({ notes: BIG.notes, yarns: BIG.yarns, seed: 4242 })
})

/** A thread of at least three notes away from the hub, and its middle note. */
function threadOfThree(s: BoardState): { yarn: Yarn; middle: string } {
  for (const y of s.yarns.values()) {
    if (y.noteIds.length >= 3 && !y.noteIds.includes([...s.notes.keys()][0] as string)) {
      return { yarn: y, middle: y.noteIds[1] as string }
    }
  }
  throw new Error('no thread of three')
}

describe(`a commit on a ${BIG.notes.toLocaleString('en')}-note, ${BIG.yarns.toLocaleString('en')}-thread board`, () => {
  let store: BoardStore
  let rt: CanvasRuntime
  let timing: ReturnType<typeof bracket>
  let offAfter: () => void = () => {}

  beforeAll(() => {
    restore = installCanvasStubs()
    // jsdom has no image decoding; the overview's photo tones wait on it.
    Object.assign(HTMLImageElement.prototype, { decode: () => Promise.resolve() })
    store = createBoardStore(big)
    timing = bracket(store)
    rt = new CanvasRuntime(canvasElements(), store)
    offAfter = timing.after()
  }, 120_000)
  afterAll(() => {
    offAfter()
    timing.off0()
    rt.dispose()
    document.body.replaceChildren()
    restore()
  })

  it('a single-note commit does O(1) runtime work: no walk over 64, ≤ 1 ms best of 5', () => {
    const { middle } = threadOfThree(store.getState())
    let best = Number.POSITIVE_INFINITY
    let walked = 0
    for (let i = 0; i < 5; i++) {
      const n = store.getState().notes.get(middle) as Note
      walked = Math.max(
        walked,
        largestWalk(() => {
          store.commit([{ op: 'note.update', id: middle, set: { x: n.x + 7 } }])
        }),
      )
      best = Math.min(best, timing.ms)
      walked = Math.max(
        walked,
        largestWalk(() => {
          store.commit([{ op: 'note.update', id: middle, set: { text: `typed ${i}` } }], {
            coalesceKey: `text:${middle}`,
          })
        }),
      )
      best = Math.min(best, timing.ms)
    }
    // The runtime did take each commit: the index has the note where it went.
    const moved = store.getState().notes.get(middle) as Note
    const r = (dx: number) => ({ x: moved.x + dx, y: moved.y + 1, w: 1, h: 1 })
    expect(inside(rt).index.notesIn(r(moved.w - 2))).toContain(middle)
    console.log(`one commit at ${BIG.notes}: runtime ${best.toFixed(3)} ms best, walk ${walked}`)
    expect(walked).toBeLessThanOrEqual(64)
    expect(best).toBeLessThanOrEqual(1)
  })

  it('a board swapped in whole is taken in slices of at most 8 ms, never one long task', {
    retry: 3,
    timeout: 120_000,
  }, async () => {
    // Read at reading zoom, in the middle of the board.
    const mid = store.getState().notes.get([...store.getState().notes.keys()][40_000] as string)
    rt.camera.set({ x: (mid as Note).x - 600, y: (mid as Note).y - 400, zoom: 1 })
    await frames(3)
    // The same board loaded again: equal records, nothing shared (a reload, a restore).
    const again = valueCopy(store.getState())
    performance.clearMeasures('papertie:catch-up')
    // Each slice's own CPU time too: this thread's, so what the rest of the suite runs
    // (other processes and threads) is not in it, as it is in wall time.
    const cpu: number[] = []
    const own = rt as unknown as { catchUpSlice(end: number): boolean }
    const slice = own.catchUpSlice.bind(rt)
    own.catchUpSlice = (end) => {
      const c0 = process.threadCpuUsage()
      const r = slice(end)
      const c = process.threadCpuUsage(c0)
      cpu.push((c.user + c.system) / 1000)
      return r
    }
    let first = 0
    const off = timing.after()
    try {
      store.replace(again, 'all')
      first = timing.ms
    } finally {
      off()
    }
    const done = () => inside(rt).model === again
    for (let i = 0; i < 5000 && !done(); i++) await new Promise((r) => setTimeout(r, 0))
    expect(done()).toBe(true)
    // Caught up: the topology is the board's own, and a commit is incremental again.
    expect(rt.topology).toBe(topologyOf(again))
    const slices = performance.getEntriesByName('papertie:catch-up').map((e) => e.duration)
    console.log(
      `whole board taken in ${slices.length} slices: first ${first.toFixed(1)} ms, ` +
        `longest ${Math.max(...slices).toFixed(1)} ms`,
    )
    delete (own as { catchUpSlice?: unknown }).catchUpSlice
    console.log(`  its slices' own CPU time: longest ${Math.max(...cpu).toFixed(1)} ms`)
    expect(first).toBeLessThanOrEqual(8)
    expect(slices.length).toBeGreaterThanOrEqual(20)
    // A slice's own time: wall time, which a machine running the rest of the suite stretches, is
    // printed above; a run is retried.
    expect(Math.max(...cpu)).toBeLessThanOrEqual(8)
  })
})

describe('catching up with long threads', () => {
  beforeAll(() => {
    restore = installCanvasStubs()
  })
  afterAll(() => {
    document.body.replaceChildren()
    restore()
  })

  it('sixteen threads of 1,000 notes each never make a slice of more than 8 ms', {
    retry: 3,
    timeout: 120_000,
  }, async () => {
    const base = generateBoard({ notes: 20_000, yarns: 0, seed: 11 })
    const ids = [...base.notes.keys()]
    const chains: Yarn[] = Array.from({ length: 16 }, (_, k) => ({
      type: 'yarn',
      id: `yarn_01JBCHA1N${String(k).padStart(17, '0')}`,
      noteIds: ids.slice(k * 1000, (k + 1) * 1000),
      color: 'indigo',
      label: '',
      createdAt: T,
      updatedAt: T,
    }))
    const s = stateFromRecords(base.board, [...base.notes.values(), ...chains])
    const store = createBoardStore(s)
    const rt = new CanvasRuntime(canvasElements(), store)
    try {
      const first = s.notes.get(ids[500] as string) as Note
      rt.camera.set({ x: first.x - 600, y: first.y - 400, zoom: 1 })
      await frames(3)
      performance.clearMeasures('papertie:catch-up')
      const again = valueCopy(s, (n) => ({ ...n, y: n.y + 5 }))
      store.replace(again, 'all')
      for (let i = 0; i < 5000 && inside(rt).catching !== null; i++) {
        await new Promise((r) => setTimeout(r, 0))
      }
      expect(inside(rt).catching).toBeNull()
      expect(canonical(rt.topology)).toEqual(canonical(buildTopology(again)))
      const slices = performance.getEntriesByName('papertie:catch-up').map((e) => e.duration)
      console.log(
        `16 threads of 1,000: ${slices.length} slices, longest ${Math.max(...slices).toFixed(1)} ms`,
      )
      expect(Math.max(...slices)).toBeLessThanOrEqual(8)
    } finally {
      rt.dispose()
    }
  })
})

const T = '2026-11-05T00:00:00.000Z'

/** A topology in a canonical form: every list sorted, maps as sorted entries. */
function canonical(t: Topology) {
  const sortBy = <T>(xs: readonly T[], k: (x: T) => string) =>
    [...xs].sort((p, q) => (k(p) < k(q) ? -1 : k(p) > k(q) ? 1 : 0))
  return {
    segments: t.segments,
    byYarn: sortBy([...t.byYarn], ([k]) => k),
    byNote: sortBy([...t.byNote], ([k]) => k).map(([k, ends]) => [
      k,
      sortBy(ends, (e) => `${e.ref.key}#${e.end}`),
    ]),
    yarnsOf: sortBy([...t.yarnsOf], ([k]) => k).map(([k, ys]) => [k, [...ys].sort()]),
  }
}
