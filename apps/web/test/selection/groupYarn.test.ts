// @vitest-environment jsdom
import { applyBatch, type ClientOp, emptyBoardState } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { prefsStore } from '../../src/app/prefs'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import type { Attach, SegmentRef } from '../../src/canvas/attach'
import { CanvasView } from '../../src/canvas/CanvasView'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import { restSagPoint } from '../../src/canvas/yarnGeometry'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const nid = (n: number) => idOf('note', n)
const yid = (n: number) => idOf('yarn', n)
const thread = (id: string, a: string, b: string): ClientOp => ({
  op: 'yarn.create',
  yarn: {
    type: 'yarn',
    id,
    noteIds: [a, b],
    color: 'apricot',
    label: '',
    createdAt: T0,
    updatedAt: T0,
  },
})

/** What the tests read of the runtime's private motion and attachment. */
interface Inner {
  motion: {
    awakeCount: number
    springs: Map<
      string,
      { ref: SegmentRef; s: { x: number; y: number }; target: { x: number; y: number } }
    >
  }
  attachOf(s: unknown): Attach
}

describe('a group drag and the yarn', () => {
  let restore: () => void = () => {}
  let session: BoardSession

  const frames = (ms = 50) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  const runtime = () => window.__papertie?.runtime as CanvasRuntime
  const fire = (target: EventTarget, type: string, x: number, y: number) =>
    act(async () => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: x,
          clientY: y,
        }),
      )
      await vi.advanceTimersByTimeAsync(20)
    })

  async function open(ops: ClientOp[]) {
    const state = applyBatch(emptyBoardState(BOARD_ID, 'T', T0), ops, { now: T0 })
    session = openLocalSession({ kind: 'local', state, label: 'test' })
    render(createElement(CanvasView, { session }))
    await frames()
    await act(async () => {
      runtime().camera.set({ x: 0, y: 0, zoom: 1 })
      await vi.advanceTimersByTimeAsync(50)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T0))
    restore = installCanvasStubs()
    prefsStore.setState({ tool: 'select', tilt: false, motion: 'full' })
  })
  afterEach(() => {
    cleanup()
    session.dispose()
    restore()
    vi.useRealTimers()
  })

  /** C in view and dragged; A and B (threaded) and G (threaded to F, in view) far to the right. */
  const FAR_BOARD: ClientOp[] = [
    { op: 'note.create', note: note(nid(1), { x: 100, y: 100, z: 1 }) },
    { op: 'note.create', note: note(nid(2), { x: 600, y: 400, z: 2 }) },
    { op: 'note.create', note: note(nid(3), { x: 3000, y: 100, z: 3 }) },
    { op: 'note.create', note: note(nid(4), { x: 3000, y: 400, z: 4 }) },
    { op: 'note.create', note: note(nid(5), { x: 6000, y: 250, z: 5 }) },
    thread(yid(1), nid(3), nid(4)),
    thread(yid(2), nid(2), nid(5)),
  ]

  async function dragFar() {
    const rt = runtime()
    act(() => rt.selectNotes([nid(1), nid(3), nid(4), nid(5)], 'replace'))
    const root = document.querySelector('main.viewport') as HTMLElement
    const c = document.querySelector(`article[data-note-id="${nid(1)}"]`) as HTMLElement
    await fire(c, 'pointerdown', 150, 150)
    await fire(root, 'pointermove', 160, 150)
    await fire(root, 'pointermove', -1000, 150)
    await fire(root, 'pointermove', -2750, 150)
    // The pointer rests: every spring goes to sleep.
    await frames(1500)
    return rt
  }

  async function drop() {
    const root = document.querySelector('main.viewport') as HTMLElement
    await fire(root, 'pointerup', -2750, 150)
  }

  for (const motion of ['full', 'reduced'] as const) {
    it(`keeps threads of a group in view drawn while the pointer rests (${motion} motion)`, async () => {
      prefsStore.setState({ motion })
      await open(FAR_BOARD)
      const rt = await dragFar()
      expect(rt.overrides.group).not.toBeNull()
      expect(rt.motion.awakeCount).toBe(0)
      // A and B came into view with their thread (both ends in the group); G is still far off
      // but its thread to F (in view) crosses the view and follows the delta. Both are drawn.
      expect(document.querySelector(`article[data-note-id="${nid(3)}"]`)).not.toBeNull()
      expect(rt.yarnStats.segmentsDynamic).toBe(2)
    })
  }

  it('a thread to a member outside the view does not whip when the group is dropped', async () => {
    await open(FAR_BOARD)
    const rt = await dragFar()
    await drop()
    const inner = rt as unknown as Inner
    // The thread F (in view) to G (far): its spring followed the drag, so it is at its new rest.
    const spring = [...inner.motion.springs.values()].find((sp) => sp.ref.yarnId === yid(2))
    expect(spring).toBeDefined()
    const s = spring?.s ?? { x: 0, y: 0 }
    const t = spring?.target ?? { x: 0, y: 0 }
    expect(Math.hypot(s.x - t.x, s.y - t.y)).toBeLessThan(1)
    expect(rt.motion.awakeCount).toBeLessThanOrEqual(
      document.querySelectorAll('article[data-note-id]').length * 2,
    )
  })

  /** G (a member) is dragged into view; its thread runs to F, an unselected note far to its right. */
  const ONE_END: ClientOp[] = [
    { op: 'note.create', note: note(nid(1), { x: 100, y: 100, z: 1 }) },
    { op: 'note.create', note: note(nid(3), { x: 3000, y: 100, z: 3 }) },
    { op: 'note.create', note: note(nid(4), { x: 6000, y: 300, z: 4 }) },
    thread(yid(1), nid(3), nid(4)),
  ]

  for (const motion of ['full', 'reduced'] as const) {
    it(`keeps the thread of a member dragged into view, to a note outside it, drawn (${motion} motion)`, async () => {
      prefsStore.setState({ motion })
      await open(ONE_END)
      const rt = runtime()
      act(() => rt.selectNotes([nid(1), nid(3)], 'replace'))
      const root = document.querySelector('main.viewport') as HTMLElement
      const c = document.querySelector(`article[data-note-id="${nid(1)}"]`) as HTMLElement
      await fire(c, 'pointerdown', 150, 150)
      await fire(root, 'pointermove', 160, 150)
      await fire(root, 'pointermove', -1000, 150)
      await fire(root, 'pointermove', -2750, 150)
      await frames(1500)
      expect(document.querySelector(`article[data-note-id="${nid(3)}"]`)).not.toBeNull()
      expect(rt.motion.awakeCount).toBe(0)
      expect(rt.yarnStats.segmentsDynamic).toBe(1)
    })
  }

  /** A 20 × 20 grid, each note threaded to the one on its right, 50 or so in view. */
  const GRID: ClientOp[] = []
  for (let i = 0; i < 400; i++) {
    GRID.push({
      op: 'note.create',
      note: note(nid(i + 1), { x: (i % 20) * 250, y: Math.floor(i / 20) * 200, z: i + 1 }),
    })
  }
  for (let i = 0; i < 400; i++)
    if (i % 20 !== 19) GRID.push(thread(yid(i + 1), nid(i + 1), nid(i + 2)))

  it('after the drop no spring aims at a doubled position, and few are awake', async () => {
    await open(GRID)
    const rt = runtime()
    act(() => rt.selectAll())
    const root = document.querySelector('main.viewport') as HTMLElement
    const first = document.querySelector('article[data-note-id]') as HTMLElement
    await fire(first, 'pointerdown', 50, 50)
    await fire(root, 'pointermove', 60, 50)
    await fire(root, 'pointermove', 360, 150)
    const mounted = document.querySelectorAll('article[data-note-id]').length
    await fire(root, 'pointerup', 360, 150)
    const inner = rt as unknown as Inner
    const s = rt.store.getState()
    const ends = inner.attachOf(s)
    let doubled = 0
    for (const spring of inner.motion.springs.values()) {
      const e = ends.ends(spring.ref)
      if (e === undefined) continue
      const want = restSagPoint(e.a, e.b)
      if (Math.hypot(spring.target.x - want.x, spring.target.y - want.y) > 0.5) doubled++
    }
    expect(doubled).toBe(0)
    expect(inner.motion.springs.size).toBe(380)
    // What is moving after the drop is what is in view (and its neighbours), not the 380 threads.
    expect(inner.motion.awakeCount).toBeLessThanOrEqual(2 * mounted)
    expect(s.notes.get(nid(1))).toMatchObject({ x: 310, y: 100 })
  })
})
