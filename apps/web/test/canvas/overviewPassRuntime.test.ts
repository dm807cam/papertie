// @vitest-environment jsdom
/**
 * A card overview drawn over several frames asks
 * for each next frame while it runs. A board change that came while it ran was merged into those
 * frames; on the frame the pass ended nothing asked for another, so the change was never drawn
 * (a card added stayed missing, a card removed stayed as a ghost) until something unrelated asked
 * for a frame. Driven here through the runtime's own frame loop, never a hand-called render.
 */
import { applyBatch, type ClientOp, emptyBoardState, type Yarn } from '@papertie/core'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { YarnRenderer } from '../../src/canvas/YarnRenderer'
import { createBoardStore } from '../../src/store/boardStore'
import { canvasElements, installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'
import { recordingContext } from '../helpers/recordingContext'

const COLS = 20
const ROWS = 15
const NOTES = COLS * ROWS

function board() {
  const ops: ClientOp[] = []
  for (let i = 0; i < NOTES; i++) {
    ops.push({
      op: 'note.create',
      note: note(idOf('note', i + 1), { x: (i % COLS) * 300, y: Math.floor(i / COLS) * 200, z: i }),
    })
  }
  for (let r = 0; r < ROWS; r++) {
    ops.push({
      op: 'yarn.create',
      yarn: {
        type: 'yarn',
        id: idOf('yarn', r + 1),
        noteIds: Array.from({ length: COLS }, (_, c) => idOf('note', r * COLS + c + 1)),
        color: 'indigo',
        label: '',
        createdAt: T0,
        updatedAt: T0,
      } as Yarn,
    })
  }
  return applyBatch(emptyBoardState(BOARD_ID, 'Pass', T0), ops, { now: T0 })
}

/** A clock that moves 1 ms each time it is read: a pass's pieces per frame are then fixed. */
function ticking() {
  let t = 0
  return () => ++t
}

interface Inside {
  yarn: YarnRenderer
}

/**
 * A runtime on the whole board in its card overview, its yarn renderer one that slices any
 * overview (every card guessed at 1 ms) into pieces of 32, on a clock of its own.
 */
function open() {
  const store = createBoardStore(board())
  const els = canvasElements()
  const rt = new CanvasRuntime(els, store, null, null, { x: -200, y: -200, zoom: 0.1 })
  const fake = () => {
    const canvas = { width: 0, height: 0, getContext: () => recordingContext().ctx }
    return canvas as unknown as HTMLCanvasElement
  }
  ;(rt as unknown as Inside).yarn = new YarnRenderer(els.yarnCanvas, els.pinCanvas, fake, {
    now: ticking(),
    overviewItemMs: 1,
    overviewPiece: 32,
  })
  return { rt, store, yarn: () => (rt as unknown as Inside).yarn }
}

/** Exactly one frame of `rt`'s loop (time moved a ms at a time until it has run). */
async function frame(rt: CanvasRuntime): Promise<void> {
  const was = rt.loop.framesDrawn
  for (let ms = 0; ms < 100 && rt.loop.framesDrawn === was; ms++) {
    await vi.advanceTimersByTimeAsync(1)
  }
  expect(rt.loop.framesDrawn).toBe(was + 1)
}

/** Frames until the pass under way is done (at most `most`); how many it took. */
async function untilDone(rt: CanvasRuntime, yarn: () => YarnRenderer, most = 500): Promise<number> {
  let n = 0
  while (yarn().passing && n < most) {
    await frame(rt)
    n++
  }
  return n
}

const added = note(idOf('note', 9001), { x: 1500, y: 3200, z: NOTES + 1 })

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

describe('a board change while the card overview is drawn over several frames', () => {
  it('is drawn once the pass ends, with no further input', async () => {
    const { rt, store, yarn } = open()
    try {
      await frame(rt)
      expect(rt.lod).toBe('overview')
      expect(yarn().passing).toBe(true)
      await frame(rt)
      expect(yarn().passing).toBe(true)
      // Mid-pass: a card added in view, and one taken away.
      store.commit([
        { op: 'note.create', note: added },
        { op: 'note.delete', id: idOf('note', 1) },
      ])
      await untilDone(rt, yarn)
      // Nothing more happens on the board: the loop alone must bring the picture up to date.
      await vi.advanceTimersByTimeAsync(5000)
      expect(yarn().passing).toBe(false)
      expect(yarn().staticInvalid).toBe(false)
      expect(rt.loop.running).toBe(false)
      expect(rt.yarnStats.cards).toBe(NOTES)
    } finally {
      rt.dispose()
    }
  })

  it('arriving on the pass’s last frame, is drawn once that frame ends it', async () => {
    // The same opening, untouched: how many frames its pass takes.
    const a = open()
    let frames: number
    try {
      await frame(a.rt)
      expect(a.yarn().passing).toBe(true)
      frames = 1 + (await untilDone(a.rt, a.yarn))
      expect(a.yarn().passing).toBe(false)
      expect(frames).toBeGreaterThan(3)
    } finally {
      a.rt.dispose()
    }
    const { rt, store, yarn } = open()
    try {
      for (let f = 0; f < frames - 1; f++) await frame(rt)
      expect(yarn().passing).toBe(true)
      // Between the last two frames: the change's request merges into the frame that ends it.
      store.commit([{ op: 'note.create', note: added }])
      await frame(rt)
      expect(yarn().passing).toBe(false)
      await vi.advanceTimersByTimeAsync(5000)
      expect(yarn().passing).toBe(false)
      expect(yarn().staticInvalid).toBe(false)
      expect(rt.loop.running).toBe(false)
      expect(rt.yarnStats.cards).toBe(NOTES + 1)
    } finally {
      rt.dispose()
    }
  })
})
