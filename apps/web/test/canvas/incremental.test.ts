// @vitest-environment jsdom
/**
 * The canvas updates only what changed: on a lifetime board of
 * 100,000 notes and 10,000 threads, one commit costs what it touched, never a pass over the board;
 * the thread topology, the spatial index and the springs follow edits incrementally and always
 * equal a rebuild; and a board swapped in whole is taken in slices, never as one long task.
 */
import {
  applyBatch,
  type BoardState,
  type ClientOp,
  emptyBoardState,
  mapChangesWithin,
  type Note,
  OpError,
  PMap,
  stateFromRecords,
  type Yarn,
} from '@papertie/core'
import { generateBoard } from '@papertie/tools/gen-board'
import fc from 'fast-check'
import { prefsStore } from '../../src/app/prefs'
import { buildTopology, type Topology, topologyOf } from '../../src/canvas/attach'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { SpatialIndex } from '../../src/canvas/spatialIndex'
import { YarnMotion } from '../../src/canvas/YarnMotion'
import { type YarnFrameInput, YarnRenderer } from '../../src/canvas/YarnRenderer'
import { segmentKey } from '../../src/canvas/yarnGeometry'
import { mergeOps } from '../../src/interactions/merge'
import { topZOf } from '../../src/notes/noteCommands'
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

/**
 * What is wrong with one yarn frame's board, if anything: it must be one board, its threads (the
 * topology it draws) that board's own, each drawn segment between two of its notes.
 */
function incoherence(i: YarnFrameInput): string[] {
  const out: string[] = []
  const board = { notes: i.state.notes, yarns: i.state.yarns }
  const topo = i.topology ?? topologyOf(board)
  if (topologyOf(board) !== topo) out.push('the threads drawn are not the drawn board’s')
  for (const ref of i.segments.slice(0, 500)) {
    const keys = (topo.byYarn.get(ref.yarnId) ?? []).map((r) => r.key)
    if (!keys.includes(ref.key)) out.push(`segment ${ref.key} is not its thread’s`)
    if (!i.state.yarns.has(ref.yarnId)) out.push(`thread ${ref.yarnId} is not on the board`)
    if (!i.state.notes.has(ref.aNoteId) || !i.state.notes.has(ref.bNoteId))
      out.push(`segment ${ref.key} ends at a note not on the board`)
  }
  return out
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

  beforeAll(() => {
    restore = installCanvasStubs()
    // jsdom has no image decoding; the overview's photo tones wait on it.
    Object.assign(HTMLImageElement.prototype, { decode: () => Promise.resolve() })
    store = createBoardStore(big)
    rt = new CanvasRuntime(canvasElements(), store)
  }, 120_000)
  afterAll(() => {
    rt.dispose()
    document.body.replaceChildren()
    restore()
  })

  it('a single-note commit does O(1) runtime work: no walk over 64, ≤ 1 ms best of 5', () => {
    // The runtime's time, best of 5, is the timing row's (`incremental.timing.test.ts`).
    const { middle } = threadOfThree(store.getState())
    let walked = 0
    for (let i = 0; i < 5; i++) {
      const n = store.getState().notes.get(middle) as Note
      walked = Math.max(
        walked,
        largestWalk(() => {
          store.commit([{ op: 'note.update', id: middle, set: { x: n.x + 7 } }])
        }),
      )
      walked = Math.max(
        walked,
        largestWalk(() => {
          store.commit([{ op: 'note.update', id: middle, set: { text: `typed ${i}` } }], {
            coalesceKey: `text:${middle}`,
          })
        }),
      )
    }
    // The runtime did take each commit: the index has the note where it went.
    const moved = store.getState().notes.get(middle) as Note
    const r = (dx: number) => ({ x: moved.x + dx, y: moved.y + 1, w: 1, h: 1 })
    expect(inside(rt).index.notesIn(r(moved.w - 2))).toContain(middle)
    expect(walked).toBeLessThanOrEqual(64)
  })

  it('after a 300-note move, the top of the stack for a drag start walks nothing: the canvas followed the move', async () => {
    // The canvas met the board in idle time (sliced): wait for that walk to end.
    await frames(30)
    const ids = [...store.getState().notes.keys()].slice(1000, 1300)
    const ops = ids.map((id) => {
      const n = store.getState().notes.get(id) as Note
      return { op: 'note.update' as const, id, set: { x: n.x + 5, z: n.z + 200_000 } }
    })
    store.commit(ops)
    let z = 0
    const walked = largestWalk(() => {
      z = topZOf(store.getState())
    })
    let want = 0
    for (const n of store.getState().notes.values()) want = Math.max(want, n.z)
    expect(walked).toBeLessThanOrEqual(64)
    expect(z).toBe(want)
    // And the top lowered again (an undo of it): a bound still above every note, no walk.
    store.commit(ids.map((id, i) => ({ op: 'note.update' as const, id, set: { z: i } })))
    const again = largestWalk(() => {
      z = topZOf(store.getState())
    })
    expect(again).toBeLessThanOrEqual(64)
    let top = 0
    for (const n of store.getState().notes.values()) top = Math.max(top, n.z)
    expect(z).toBeGreaterThanOrEqual(top)
  })

  it('a thread edit touches only that thread and its notes', () => {
    const { yarn } = threadOfThree(store.getState())
    const edit = (ops: ClientOp[]) => {
      const synced: string[][] = []
      const indexed: string[][] = []
      const sync = vi.spyOn(YarnMotion.prototype, 'sync')
      const update = vi.spyOn(SpatialIndex.prototype, 'updateNotes')
      try {
        const walked = largestWalk(() => store.commit(ops))
        for (const c of sync.mock.calls) synced.push([...(c[2] ?? ['<every thread>'])])
        for (const c of update.mock.calls) indexed.push([...c[1]])
        expect(walked).toBeLessThanOrEqual(64)
      } finally {
        sync.mockRestore()
        update.mockRestore()
      }
      return { synced, indexed }
    }
    // A colour moves no pin: the thread's springs are matched, no note is indexed again.
    const colour = yarn.color === 'ink' ? 'apricot' : 'ink'
    const recoloured = edit([{ op: 'yarn.update', id: yarn.id, set: { color: colour } }])
    expect(recoloured.synced).toEqual([[yarn.id]])
    expect(recoloured.indexed.flat()).toEqual([])
    // A note taken off it: only the thread's notes (that one included) are indexed again.
    const off = yarn.noteIds[2] as string
    const shorter = edit([{ op: 'yarn.removeNote', id: yarn.id, noteId: off }])
    expect(shorter.synced).toEqual([[yarn.id]])
    expect(shorter.indexed).toHaveLength(1)
    expect(new Set(shorter.indexed[0])).toEqual(new Set(yarn.noteIds))
    store.commit([
      { op: 'yarn.insertNote', id: yarn.id, noteId: off, afterNoteId: yarn.noteIds[1] as string },
    ])
  })

  it('delete a note: its threads close up and redraw, nothing else is visited', () => {
    const { yarn, middle } = threadOfThree(store.getState())
    const [a, , c] = yarn.noteIds as [string, string, string]
    const walked = largestWalk(() => {
      store.commit([{ op: 'note.delete', id: middle }])
    })
    expect(walked).toBeLessThanOrEqual(64)
    const s = store.getState()
    const closed = s.yarns.get(yarn.id) as Yarn
    expect(closed.noteIds).not.toContain(middle)
    // The thread runs straight from a to c now: in the topology, the springs and the index.
    const refs = topologyOf(s).byYarn.get(yarn.id) ?? []
    expect(refs.map((r) => [r.aNoteId, r.bNoteId])).toContainEqual([a, c])
    const { motion, index } = inside(rt)
    expect(motion.segmentsOf([a]).map((r) => r.key)).toContain(segmentKey(yarn.id, a, c))
    const na = s.notes.get(a) as Note
    const around = { x: na.x - 2000, y: na.y - 2000, w: 4000, h: 4000 }
    const keys = index.segmentsIn(around).map((r) => r.key)
    expect(keys).toContain(segmentKey(yarn.id, a, c))
    expect(keys).not.toContain(segmentKey(yarn.id, a, middle))
    // Drawn again: the static yarn layer is stale.
    expect(rt.yarnStats).toBeDefined()
  })

  it('a board swapped in whole is taken in slices of at most 8 ms, never one long task', async () => {
    // How long its first task and its slices are is the timing row's
    // (`incremental.timing.test.ts`).
    // Read at reading zoom, in the middle of the board.
    const mid = store.getState().notes.get([...store.getState().notes.keys()][40_000] as string)
    rt.camera.set({ x: (mid as Note).x - 600, y: (mid as Note).y - 400, zoom: 1 })
    await frames(3)
    // The same board loaded again: equal records, nothing shared (a reload, a restore).
    const again = valueCopy(store.getState())
    performance.clearMeasures('papertie:catch-up')
    store.replace(again, 'all')
    const done = () => inside(rt).model === again
    for (let i = 0; i < 5000 && !done(); i++) await new Promise((r) => setTimeout(r, 0))
    expect(done()).toBe(true)
    // Caught up: the topology is the board's own, and a commit is incremental again.
    expect(rt.topology).toBe(topologyOf(again))
    const slices = performance.getEntriesByName('papertie:catch-up').map((e) => e.duration)
    expect(slices.length).toBeGreaterThanOrEqual(20)
  }, 120_000)

  it('while it catches up, every frame draws one board, and the view is caught up first', async () => {
    const s = store.getState()
    const mid = s.notes.get([...s.notes.keys()][50_000] as string) as Note
    const view = { x: mid.x - 600, y: mid.y - 400, w: 1200, h: 800 }
    rt.camera.set({ x: view.x, y: view.y, zoom: 1 })
    await frames(3)
    const inView = inside(rt).index.notesIn(view)
    expect(inView.length).toBeGreaterThan(5)
    // Loaded again, every note moved a little: every record differs.
    const moved = valueCopy(s, (n) => ({ ...n, x: n.x + 9 }))
    const problems: string[] = []
    let drawnWhileCatching = 0
    const original = YarnRenderer.prototype.render
    const spy = vi.spyOn(YarnRenderer.prototype, 'render').mockImplementation(function (
      this: YarnRenderer,
      i: YarnFrameInput,
    ) {
      if (inside(rt).catching !== null) {
        drawnWhileCatching++
        problems.push(...incoherence(i))
        // The notes mounted are the drawn board's.
        const drawn =
          (rt.view.getState() as { drawn?: ReadonlyMap<string, Note> | null }).drawn ??
          store.getState().notes
        if (drawn !== i.state.notes) problems.push('the notes mounted are another board’s')
        for (const id of rt.view.getState().visible) {
          if (!drawn.has(id)) problems.push(`mounted note ${id} is not on the drawn board`)
        }
      }
      return original.call(this, i)
    })
    try {
      store.replace(moved, 'all')
      // The first steps take the notes in view (with their threads) before anything else.
      const c = inside(rt).catching as { first: string[] }
      let steps = 0
      while (c.first.length > 0 && steps < 1000) {
        inside(rt).catchUpSlice(0)
        steps++
      }
      const now = store.getState()
      const behind = inView.filter((id) => inside(rt).model.notes.get(id) !== now.notes.get(id))
      expect(behind).toEqual([])
      let taken = 0
      for (const [id, n] of now.notes) if (inside(rt).model.notes.get(id) === n) taken++
      console.log(
        `the view first: ${inView.length} notes in view, ${taken} taken in ${steps} steps`,
      )
      expect(taken).toBeLessThan(20 * inView.length)
      for (let i = 0; i < 2000 && inside(rt).catching !== null; i++) await frames(1)
      expect(inside(rt).catching).toBeNull()
    } finally {
      spy.mockRestore()
    }
    expect(drawnWhileCatching).toBeGreaterThan(0)
    expect([...new Set(problems)].slice(0, 5)).toEqual([])
  }, 120_000)
})

describe('catching up with long threads', () => {
  beforeAll(() => {
    restore = installCanvasStubs()
  })
  afterAll(() => {
    document.body.replaceChildren()
    restore()
  })

  it('sixteen threads of 1,000 notes each never make a slice of more than 8 ms', async () => {
    // The slices' length is the timing row's (`incremental.timing.test.ts`).
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
    } finally {
      rt.dispose()
    }
  }, 120_000)
})

// ---- the property: incremental equals a rebuild ----------------------------------------------

const NOTE_IDS = Array.from({ length: 24 }, (_, i) => `note_01JBN0TE${String(i).padStart(18, '0')}`)
const YARN_IDS = Array.from({ length: 12 }, (_, i) => `yarn_01JBYARN${String(i).padStart(18, '0')}`)
const T = '2026-11-05T00:00:00.000Z'
/** Notes no edit touches, far off: enough that no commit re-indexes the board whole. */
const FILLER = Array.from(
  { length: 200 },
  (_, i) => `note_01JBF1LLER${String(i).padStart(16, '0')}`,
)

function noteAt(id: string, i: number): Note {
  return {
    type: 'note',
    id,
    x: (i % 6) * 360,
    y: Math.floor(i / 6) * 320,
    w: 220,
    h: 160,
    z: i,
    paper: 'cream',
    style: 'rustic',
    text: '',
    image: null,
    createdAt: T,
    updatedAt: T,
  } as Note
}

/** One random edit, as ops against the board as it is (it may not apply: then it is skipped). */
const arbEdit = fc.oneof(
  fc.record({ k: fc.constant('create' as const), n: fc.nat(23) }),
  fc.record({
    k: fc.constant('move' as const),
    n: fc.nat(23),
    dx: fc.integer({ min: -400, max: 400 }),
    dy: fc.integer({ min: -400, max: 400 }),
  }),
  fc.record({ k: fc.constant('delete' as const), n: fc.nat(23) }),
  fc.record({
    k: fc.constant('thread' as const),
    y: fc.nat(11),
    notes: fc.uniqueArray(fc.nat(23), { minLength: 2, maxLength: 5 }),
    pins: fc.array(fc.tuple(fc.nat(4), fc.nat(2)), { maxLength: 3 }),
  }),
  fc.record({
    k: fc.constant('rethread' as const),
    y: fc.nat(11),
    add: fc.nat(23),
    drop: fc.nat(4),
    after: fc.nat(5),
  }),
  fc.record({ k: fc.constant('pin' as const), y: fc.nat(11), at: fc.nat(4), kind: fc.nat(2) }),
  fc.record({ k: fc.constant('unthread' as const), y: fc.nat(11) }),
  fc.record({ k: fc.constant('merge' as const), a: fc.nat(23), b: fc.nat(23) }),
)
type Edit = typeof arbEdit extends fc.Arbitrary<infer E> ? E : never

const pinKey = (yarnId: string, kind: number) =>
  kind === 0 ? 'hanging' : `y${yarnId.slice(yarnId.indexOf('_') + 1)}${kind === 1 ? 'n' : 'p'}`

function opsFor(s: BoardState, e: Edit): ClientOp[] {
  switch (e.k) {
    case 'create': {
      const id = NOTE_IDS[e.n] as string
      return s.notes.has(id) ? [] : [{ op: 'note.create', note: noteAt(id, e.n) }]
    }
    case 'move': {
      const n = s.notes.get(NOTE_IDS[e.n] as string)
      return n ? [{ op: 'note.update', id: n.id, set: { x: n.x + e.dx, y: n.y + e.dy } }] : []
    }
    case 'delete':
      return [{ op: 'note.delete', id: NOTE_IDS[e.n] as string }]
    case 'thread': {
      const id = YARN_IDS[e.y] as string
      if (s.yarns.has(id)) return []
      const noteIds = e.notes.map((i) => NOTE_IDS[i] as string)
      const pins: Record<string, string> = {}
      for (const [at, kind] of e.pins) {
        const n = noteIds[at]
        if (n !== undefined) pins[n] = pinKey(YARN_IDS[(e.y + at) % 12] as string, kind)
      }
      const yarn: Yarn = {
        type: 'yarn',
        id,
        noteIds,
        color: 'indigo',
        label: '',
        createdAt: T,
        updatedAt: T,
        ...(Object.keys(pins).length > 0 ? { pins } : {}),
      } as Yarn
      return [{ op: 'yarn.create', yarn }]
    }
    case 'rethread': {
      // A note taken off the thread, another put on it after one of its notes (or first).
      const y = s.yarns.get(YARN_IDS[e.y] as string)
      if (y === undefined) return []
      const ops: ClientOp[] = []
      const drop = y.noteIds[e.drop]
      if (drop !== undefined && y.noteIds.length > 2)
        ops.push({ op: 'yarn.removeNote', id: y.id, noteId: drop })
      const add = NOTE_IDS[e.add] as string
      if (s.notes.has(add) && !y.noteIds.includes(add)) {
        const after = y.noteIds.filter((n) => n !== drop)[e.after] ?? null
        ops.push({ op: 'yarn.insertNote', id: y.id, noteId: add, afterNoteId: after })
      }
      return ops
    }
    case 'pin': {
      const y = s.yarns.get(YARN_IDS[e.y] as string)
      const n = y?.noteIds[e.at % (y?.noteIds.length ?? 1)]
      if (!y || !n) return []
      return [
        { op: 'yarn.update', id: y.id, set: { pins: { ...y.pins, [n]: pinKey(y.id, e.kind) } } },
      ]
    }
    case 'unthread':
      return [{ op: 'yarn.delete', id: YARN_IDS[e.y] as string }]
    case 'merge': {
      const a = NOTE_IDS[e.a] as string
      const b = NOTE_IDS[e.b] as string
      if (a === b || !s.notes.has(a) || !s.notes.has(b)) return []
      return mergeOps(s, a, b, 'below')
    }
  }
}

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

/** The spatial index's items, canonically (private fields). */
function indexDump(idx: SpatialIndex) {
  type B = { minX: number; minY: number; maxX: number; maxY: number }
  const p = idx as unknown as {
    noteItems: Map<string, B>
    segItems: Map<string, B & { ref: { key: string } }>
    segsOfNote: Map<string, Set<string>>
  }
  const r = (b: B) => [b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 1000) / 1000)
  return {
    notes: [...p.noteItems].map(([id, b]) => [id, r(b)]).sort(),
    segs: [...p.segItems].map(([k, i]) => [k, i.ref.key, r(i)]).sort(),
    byNote: [...p.segsOfNote].map(([id, keys]) => [id, [...keys].sort()]).sort(),
    size: idx.size,
  }
}

/** The springs, canonically: each segment's key and the rest it aims at. */
function motionDump(m: YarnMotion) {
  const p = m as unknown as {
    springs: Map<string, { ref: { key: string; index: number }; target: { x: number; y: number } }>
    byNote: Map<string, Set<string>>
  }
  return {
    springs: [...p.springs]
      .map(([k, s]) => [
        k,
        s.ref.index,
        Math.round(s.target.x * 1000),
        Math.round(s.target.y * 1000),
      ])
      .sort(),
    byNote: [...p.byNote]
      .filter(([, keys]) => keys.size > 0)
      .map(([id, keys]) => [id, [...keys].sort()])
      .sort(),
  }
}

/** The property's board: twelve notes to edit, and the far-off notes no edit touches. */
function propertyStart(): BoardState {
  return stateFromRecords(emptyBoardState('board_01JB0ARD000000000000000001', 'b', T).board, [
    ...NOTE_IDS.slice(0, 12).map((id, i) => noteAt(id, i)),
    ...FILLER.map((id, i) => ({ ...noteAt(id, i), x: 20_000 + (i % 20) * 300, y: (i / 20) * 300 })),
  ])
}

/** Commit `e` if it applies; whether it did. */
function commitEdit(store: BoardStore, e: Edit): boolean {
  const ops = opsFor(store.getState(), e)
  if (ops.length === 0) return false
  try {
    store.commit(ops)
    return true
  } catch (err) {
    if (err instanceof OpError) return false
    throw err
  }
}

/** The runtime's spatial index and springs equal ones built afresh on the store's board. */
function expectRebuilt(rt: CanvasRuntime, store: BoardStore): void {
  const s = store.getState()
  const { index, motion } = inside(rt)
  const fresh = new SpatialIndex()
  fresh.rebuild(s, new Map(), prefsStore.getState().tilt)
  expect(indexDump(index)).toEqual(indexDump(fresh))
  const full = new YarnMotion(() => true)
  const attach = (
    rt as unknown as { attachOf(s: BoardState): { ends: (r: never) => never } }
  ).attachOf(s)
  full.sync(s, (ref) => attach.ends(ref as never))
  expect(motionDump(motion)).toEqual(motionDump(full))
}

/** A commit, a board swapped in whole, steps of catching up, a told or an untold replace. */
const arbAction = fc.oneof(
  { weight: 10, arbitrary: arbEdit.map((e) => ({ k: 'edit' as const, e })) },
  { weight: 1, arbitrary: fc.constant({ k: 'reload' as const }) },
  { weight: 6, arbitrary: fc.nat(3).map((n) => ({ k: 'step' as const, n })) },
  { weight: 2, arbitrary: arbEdit.map((e) => ({ k: 'hinted' as const, e })) },
  { weight: 2, arbitrary: arbEdit.map((e) => ({ k: 'remote' as const, e })) },
)

describe('incremental topology equals a full rebuild', () => {
  beforeEach(() => {
    restore = installCanvasStubs()
  })
  afterEach(() => {
    document.body.replaceChildren()
    restore()
  })

  it('after 500 random commits: notes, threads, shared pins and merges', () => {
    let commits = 0
    fc.assert(
      fc.property(fc.array(arbEdit, { minLength: 200, maxLength: 200 }), (edits) => {
        const store = createBoardStore(propertyStart())
        const rt = new CanvasRuntime(canvasElements(), store)
        try {
          for (const e of edits) {
            if (!commitEdit(store, e)) continue
            commits++
            const s = store.getState()
            expect(canonical(topologyOf(s))).toEqual(canonical(buildTopology(s)))
          }
          expectRebuilt(rt, store)
        } finally {
          rt.dispose()
        }
      }),
      { numRuns: 8 },
    )
    expect(commits).toBeGreaterThanOrEqual(500)
  }, 120_000)

  it('through boards swapped in whole (caught up a step at a time), told and untold replaces', () => {
    const seen = { reload: 0, hinted: 0, remote: 0, steps: 0, midway: 0 }
    fc.assert(
      fc.property(fc.array(arbAction, { minLength: 150, maxLength: 150 }), (actions) => {
        const store = createBoardStore(propertyStart())
        const rt = new CanvasRuntime(canvasElements(), store)
        const catching = () => inside(rt).catching !== null
        try {
          for (const a of actions) {
            const s = store.getState()
            if (a.k === 'edit') commitEdit(store, a.e)
            else if (a.k === 'reload') {
              if (catching()) seen.midway++
              seen.reload++
              store.replace(valueCopy(s), 'all')
            } else if (a.k === 'step') {
              for (let i = 0; i <= a.n && catching(); i++) {
                inside(rt).catchUpSlice(0)
                seen.steps++
              }
            } else {
              const ops = opsFor(s, a.e)
              if (ops.length === 0) continue
              let next: BoardState
              try {
                next = applyBatch(s, ops, { now: T })
              } catch (err) {
                if (err instanceof OpError) continue
                throw err
              }
              if (a.k === 'hinted') {
                // As a session tells it: what changed, and an id that did not.
                const told = (k: 'notes' | 'yarns' | 'assets' | 'books' | 'blocks') => {
                  const c = mapChangesWithin(
                    s[k] as ReadonlyMap<string, unknown>,
                    next[k],
                    Number.POSITIVE_INFINITY,
                  ) as { set: string[]; deleted: string[] }
                  return new Set([...c.set, ...c.deleted])
                }
                const notes = told('notes')
                notes.add(FILLER[0] as string)
                seen.hinted++
                store.replace(next, {
                  notes,
                  yarns: told('yarns'),
                  assets: told('assets'),
                  books: told('books'),
                  blocks: told('blocks'),
                })
              } else {
                seen.remote++
                store.replace(valueCopy(next))
              }
            }
            // Mid catch-up the canvas's board is its own, whole and coherent.
            const m = inside(rt).model
            expect(canonical(rt.topology)).toEqual(canonical(buildTopology(m)))
          }
          for (let i = 0; i < 10_000 && catching(); i++) inside(rt).catchUpSlice(0)
          expect(catching()).toBe(false)
          expect(canonical(rt.topology)).toEqual(canonical(buildTopology(store.getState())))
          expectRebuilt(rt, store)
        } finally {
          rt.dispose()
        }
      }),
      { numRuns: 8 },
    )
    console.log(`swapped and told: ${JSON.stringify(seen)}`)
    expect(seen.reload).toBeGreaterThan(10)
    expect(seen.midway).toBeGreaterThan(0)
    expect(seen.hinted).toBeGreaterThan(10)
    expect(seen.remote).toBeGreaterThan(10)
  }, 120_000)

  it('two large told changes in a row: the first one’s walk is not dropped', () => {
    const start = generateBoard({ notes: 6_000, yarns: 600, seed: 3 })
    const store = createBoardStore(start)
    const rt = new CanvasRuntime(canvasElements(), store)
    try {
      const ids = [...start.notes.keys()]
      /** Move `few` notes as an opening's catch-up tells it: more than one change at once. */
      const told = (few: string[], dx: number) => {
        const s = store.getState()
        const next = applyBatch(
          s,
          few.map((id) => ({
            op: 'note.update' as const,
            id,
            set: { x: (s.notes.get(id) as Note).x + dx },
          })),
          { now: T },
        )
        store.replace(next, {
          notes: new Set(few),
          yarns: new Set(),
          assets: new Set(),
          books: new Set(),
          blocks: new Set(),
        })
      }
      told(ids.slice(0, 3000), 40)
      expect(inside(rt).catching).not.toBeNull()
      inside(rt).catchUpSlice(0)
      told(ids.slice(3000), -40)
      for (let i = 0; i < 20_000 && inside(rt).catching !== null; i++) inside(rt).catchUpSlice(0)
      expect(inside(rt).catching).toBeNull()
      expect(canonical(rt.topology)).toEqual(canonical(buildTopology(store.getState())))
      expectRebuilt(rt, store)
    } finally {
      rt.dispose()
    }
  }, 120_000)

  it('advances by what changed: the same topology for an edit that moves no thread', () => {
    const s = generateBoard({ notes: 200, yarns: 40, seed: 7 })
    const t = topologyOf(s)
    const id = [...s.notes.keys()][5] as string
    const next = applyBatch(s, [{ op: 'note.update', id, set: { text: 'only words' } }], { now: T })
    expect(topologyOf(next)).toBe(t)
  })
})
