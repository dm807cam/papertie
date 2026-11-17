// @vitest-environment jsdom
/**
 * A dense lite view: about 3,600 notes mounted at 16 %, on row and column
 * threads. A commit that moves a note in view, or a spring that settles, costs what it changed:
 * the view is not culled again (the index is asked only what lies near the change, never for the
 * view) and the yarn's static layer
 * is patched where the change was and is, never redrawn whole. Measured before: 50–68 ms tasks
 * per nudge, the whole static layer redrawn and the view culled again each time.
 */
import { applyBatch, type ClientOp, emptyBoardState, type Note, type Yarn } from '@papertie/core'
import { cullRect } from '../../src/canvas/cull'
import { CanvasRuntime, MOUNT_BATCH } from '../../src/canvas/runtime'
import type { SpatialIndex } from '../../src/canvas/spatialIndex'
import { createBoardStore } from '../../src/store/boardStore'
import { canvasElements, installCanvasStubs, VIEWPORT } from '../helpers/domCanvas'
import { BOARD_ID, T0 } from '../helpers/fakeServer'

const COLS = 60
const ROWS = 60
const id = (r: number, c: number) => `note_${String(r * COLS + c).padStart(26, '0')}`

function denseBoard() {
  const ops: ClientOp[] = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const note: Note = {
        type: 'note',
        id: id(r, c),
        x: c * 135,
        y: r * 95,
        w: 120,
        h: 80,
        z: r * COLS + c,
        paper: 'cream',
        style: 'rustic',
        text: `Note ${r}-${c}`,
        image: null,
        createdAt: T0,
        updatedAt: T0,
      }
      ops.push({ op: 'note.create', note })
    }
  }
  const yarn = (k: number, noteIds: string[]): ClientOp => ({
    op: 'yarn.create',
    yarn: {
      type: 'yarn',
      id: `yarn_${String(k).padStart(26, '0')}`,
      noteIds,
      color: 'indigo',
      label: '',
      createdAt: T0,
      updatedAt: T0,
    } as Yarn,
  })
  for (let r = 0; r < ROWS; r++) {
    ops.push(
      yarn(
        r,
        Array.from({ length: COLS }, (_, c) => id(r, c)),
      ),
    )
  }
  return applyBatch(emptyBoardState(BOARD_ID, 'Dense', T0), ops, { now: T0 })
}

interface Inside {
  index: SpatialIndex
}

let restore: () => void = () => {}
beforeEach(() => {
  vi.useFakeTimers()
  restore = installCanvasStubs()
})
afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
  restore()
})

it('a nudge in a dense lite view neither culls the view again nor redraws the yarn whole', async () => {
  const store = createBoardStore(denseBoard())
  const rt = new CanvasRuntime(canvasElements(), store, null, null, { x: -20, y: -20, zoom: 0.16 })
  try {
    await vi.advanceTimersByTimeAsync(2000)
    expect(rt.lod).toBe('lite')
    expect(rt.view.getState().visible.length).toBeGreaterThan(2500)
    const index = (rt as unknown as Inside).index
    const notesIn = vi.spyOn(index, 'notesIn')
    const segmentsIn = vi.spyOn(index, 'segmentsIn')
    const cullRectArea = cullRect(rt.camera.get(), VIEWPORT)
    /** Whether `index` was asked for a rect as wide as the view's cull (a cull, not a patch). */
    const askedForTheView = (spy: typeof notesIn | typeof segmentsIn) =>
      spy.mock.calls.some(([r]) => r.w >= cullRectArea.w / 2 || r.h >= cullRectArea.h / 2)
    const target = id(10, 10)
    const redrawn: boolean[] = []
    for (let i = 0; i < 5; i++) {
      const n = store.getState().notes.get(target) as Note
      store.commit([{ op: 'note.update', id: target, set: { x: n.x + 2 } }])
      // The springs of its threads run and settle.
      for (let f = 0; f < 120; f++) {
        await vi.advanceTimersByTimeAsync(17)
        redrawn.push(rt.yarnStats.staticRedrawn)
      }
    }
    expect(askedForTheView(notesIn)).toBe(false)
    expect(askedForTheView(segmentsIn)).toBe(false)
    expect(redrawn.filter(Boolean)).toEqual([])
    // A move that takes a note out of the view is culled again.
    store.commit([{ op: 'note.update', id: target, set: { x: 1e6 } }])
    await vi.advanceTimersByTimeAsync(50)
    expect(askedForTheView(notesIn)).toBe(true)
    expect(rt.view.getState().visible).not.toContain(target)
  } finally {
    rt.dispose()
  }
})

it('a fit-all from reading zoom mounts the notes it eases through a batch a frame', async () => {
  // Fit-all from reading zoom eases through lite: each lite frame mounted every note in its cull
  // at once (453 on the lifetime grid's first eased frame: a 133 ms frame, 116 ms of it React).
  // While the camera moves, at most MOUNT_BATCH notes now start to mount a frame, those in view
  // nearest its middle first; the rest follow.
  const store = createBoardStore(denseBoard())
  const rt = new CanvasRuntime(canvasElements(), store, null, null, { x: 3000, y: 2000, zoom: 1 })
  try {
    await vi.advanceTimersByTimeAsync(500)
    expect(rt.lod).toBe('full')
    let shown = new Set(rt.view.getState().visible)
    let most = 0
    let liteFrames = 0
    const off = rt.view.subscribe((v) => {
      let fresh = 0
      for (const id of v.visible) if (!shown.has(id)) fresh++
      most = Math.max(most, fresh)
      if (v.lod === 'lite') liteFrames++
      shown = new Set(v.visible)
    })
    rt.run('fitAll')
    for (let f = 0; f < 120; f++) await vi.advanceTimersByTimeAsync(17)
    off()
    expect(rt.lod).toBe('overview')
    expect(liteFrames).toBeGreaterThan(0)
    expect(most).toBeGreaterThan(0)
    expect(most).toBeLessThanOrEqual(MOUNT_BATCH)
  } finally {
    rt.dispose()
  }
})

it('in lite at rest after a move, the notes left behind mount a batch a frame until all are', async () => {
  const store = createBoardStore(denseBoard())
  const rt = new CanvasRuntime(canvasElements(), store, null, null, { x: 3000, y: 2000, zoom: 1 })
  try {
    await vi.advanceTimersByTimeAsync(500)
    const start = rt.view.getState().visible
    const updates: string[][] = []
    const off = rt.view.subscribe((v) => updates.push(v.visible))
    rt.camera.animateTo({ x: -20, y: -20, zoom: 0.16 }, false, 200)
    for (let f = 0; f < 200; f++) await vi.advanceTimersByTimeAsync(17)
    off()
    expect(rt.lod).toBe('lite')
    const all = rt.view.getState().visible
    expect(all.length).toBeGreaterThan(2500)
    // Every note the cull wants is mounted in the end; the first of the move's batches were in
    // the view, near its middle.
    expect(new Set(all).size).toBe(all.length)
    let shown = new Set<string>(start)
    let most = 0
    for (const visible of updates) {
      let fresh = 0
      for (const id of visible) if (!shown.has(id)) fresh++
      most = Math.max(most, fresh)
      shown = new Set(visible)
    }
    expect(most).toBeLessThanOrEqual(MOUNT_BATCH)
  } finally {
    rt.dispose()
  }
})

it('a cull at rest while notes still wait to mount mounts the next batch only', async () => {
  // A cull with the camera at rest (a height measured, a remote change) mounted every waiting
  // note at once (the lifetime bench's lite pan: frames of 66–132 ms).
  const store = createBoardStore(denseBoard())
  const rt = new CanvasRuntime(canvasElements(), store, null, null, { x: 3000, y: 2000, zoom: 1 })
  try {
    await vi.advanceTimersByTimeAsync(500)
    rt.camera.animateTo({ x: -20, y: -20, zoom: 0.16 }, false, 100)
    // Until the move is over and notes still wait.
    for (let f = 0; f < 30 && (rt.camera.moving || rt.lod !== 'lite'); f++) {
      await vi.advanceTimersByTimeAsync(17)
    }
    expect(rt.camera.moving).toBe(false)
    const waiting = rt.view.getState().visible
    expect(waiting.length).toBeLessThan(2500)
    let shown = new Set(waiting)
    let most = 0
    const off = rt.view.subscribe((v) => {
      let fresh = 0
      for (const id of v.visible) if (!shown.has(id)) fresh++
      most = Math.max(most, fresh)
      shown = new Set(v.visible)
    })
    // Remote deletes cull again, the camera still: the second one with the cull already where
    // the camera came to rest.
    store.commit([{ op: 'note.delete', id: id(59, 59) }])
    await vi.advanceTimersByTimeAsync(17)
    store.commit([{ op: 'note.delete', id: id(59, 58) }])
    for (let f = 0; f < 120; f++) await vi.advanceTimersByTimeAsync(17)
    off()
    expect(rt.view.getState().visible.length).toBeGreaterThan(2500)
    expect(most).toBeLessThanOrEqual(MOUNT_BATCH)
  } finally {
    rt.dispose()
  }
})

it('while a note holds the keyboard, a move past a neighbour does not cull the view again', async () => {
  // The DOM order is held while the keyboard is on a note (`stableOrder`): a cull would keep it
  // as it is, so a move that changes a note's reading place costs no cull then. It cost one
  // per commit (about 25 ms at 3,600 notes) in tied-scale's scattered batches, where the order
  // held since the nudges never matched reading order again.
  const store = createBoardStore(denseBoard())
  const els = canvasElements()
  const rt = new CanvasRuntime(els, store, null, null, { x: -20, y: -20, zoom: 0.16 })
  try {
    await vi.advanceTimersByTimeAsync(2000)
    // A note element of the board has the keyboard.
    const held = document.createElement('article')
    held.dataset.noteId = id(20, 20)
    held.tabIndex = 0
    els.world.append(held)
    held.focus()
    expect(document.activeElement).toBe(held)
    const index = (rt as unknown as Inside).index
    const notesIn = vi.spyOn(index, 'notesIn')
    const view = cullRect(rt.camera.get(), VIEWPORT)
    const target = id(10, 10)
    for (let i = 0; i < 3; i++) {
      const n = store.getState().notes.get(target) as Note
      // Past its right-hand neighbour: its reading place changes every time.
      store.commit([{ op: 'note.update', id: target, set: { x: n.x + 140 } }])
      for (let f = 0; f < 60; f++) await vi.advanceTimersByTimeAsync(17)
    }
    expect(notesIn.mock.calls.some(([r]) => r.w >= view.w / 2)).toBe(false)
  } finally {
    rt.dispose()
  }
})
