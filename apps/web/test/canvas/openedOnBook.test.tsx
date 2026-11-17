/**
 * A session opened on a book (Papertie opened again into it) is open before the
 * board's first paint is in: its canvas is made once the paint is, on it, as any opening's canvas
 * is (a canvas made on no board would take the paint as a change and catch up with it a slice at a
 * time, the opening's slices after it too, the card overview drawn whole each frame meanwhile).
 */
import { applyBatch, emptyBoardState } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { cameraKey } from '../../src/app/cameraMemory'
import { openingView } from '../../src/app/opening'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { CanvasView } from '../../src/canvas/CanvasView'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

let restore: () => void = () => {}

/** A page that can run the pyramid (`pyramidSupported`): a worker that never answers. Returns the undo. */
function runsPyramid(): () => void {
  const g = globalThis as Record<string, unknown>
  const was = {
    Worker: g.Worker,
    OffscreenCanvas: g.OffscreenCanvas,
    createImageBitmap: g.createImageBitmap,
  }
  g.Worker = class {
    onmessage = null
    onerror = null
    onmessageerror = null
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  }
  g.OffscreenCanvas = class {}
  g.createImageBitmap = async () => ({})
  return () => Object.assign(g, was)
}
const sessions: BoardSession[] = []
const runtime = () => window.__papertie?.runtime as CanvasRuntime | undefined
const frames = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  restore = installCanvasStubs()
  localStorage.clear()
  performance.clearMeasures?.()
})
afterEach(() => {
  cleanup()
  for (const s of sessions.splice(0)) s.dispose()
  document.body.replaceChildren()
  restore()
  localStorage.clear()
  vi.useRealTimers()
})

describe('a board opened under a book', () => {
  it('is drawn once its first paint is in, from that paint: never caught up with as a change', async () => {
    const empty = emptyBoardState(BOARD_ID, 'Test board', T0)
    const session = { ...openLocalSession({ kind: 'local', state: empty, label: 'test' }) }
    const opening = openingView(false)
    session.opening = opening
    sessions.push(session)
    render(<CanvasView session={session} />)
    await frames(50)
    expect(runtime()).toBeUndefined()
    // The paint: more notes than a told change is taken in at once.
    const ops = Array.from({ length: 80 }, (_, i) => ({
      op: 'note.create' as const,
      note: note(idOf('note', i + 1), { x: (i % 10) * 300, y: Math.floor(i / 10) * 200 }),
    }))
    const paint = applyBatch(empty, ops, { now: T0 })
    act(() => {
      session.store.replace(paint)
      opening.paint()
    })
    await frames(200)
    const rt = runtime()
    expect(rt).toBeDefined()
    expect(rt?.store.getState().notes.size).toBe(80)
    expect(performance.getEntriesByName('papertie:catch-up')).toEqual([])
    expect(document.querySelectorAll('article.note').length).toBeGreaterThan(0)
  })

  it('under a book, a far view’s card overview is not drawn (the whole view’s cards in one frame): it is, once the book goes', async () => {
    const empty = emptyBoardState(BOARD_ID, 'Test board', T0)
    const ops = Array.from({ length: 200 }, (_, i) => ({
      op: 'note.create' as const,
      note: note(idOf('note', i + 1), { x: (i % 20) * 4000, y: Math.floor(i / 20) * 4000 }),
    }))
    const state = applyBatch(empty, ops, { now: T0 })
    const session = {
      ...openLocalSession({ kind: 'local', state, label: 'test' }),
      boardId: BOARD_ID,
    }
    sessions.push(session)
    localStorage.setItem(cameraKey(BOARD_ID), JSON.stringify({ x: -1000, y: -1000, zoom: 0.01 }))
    const view = render(<CanvasView session={session} covered books="book" />)
    await frames(200)
    const rt = runtime() as CanvasRuntime
    expect(rt.view.getState().lod).toBe('overview')
    // A board past the pyramid's threshold (lowered: 200 notes stand for 100,000), on a page
    // that runs the pyramid (its worker answering nothing yet: never ready).
    rt.pyramidAbove = 100
    const undo = runsPyramid()
    const draw = vi.spyOn(rt.yarn, 'render')
    act(() => rt.requestYarn())
    await frames(200)
    expect(draw).not.toHaveBeenCalled()
    view.rerender(<CanvasView session={session} />)
    await frames(200)
    expect(draw).toHaveBeenCalled()
    undo()
  })

  it('a board the pyramid never draws (at most 5,000 notes): its far view under a book is drawn as before', async () => {
    const empty = emptyBoardState(BOARD_ID, 'Test board', T0)
    const ops = Array.from({ length: 200 }, (_, i) => ({
      op: 'note.create' as const,
      note: note(idOf('note', i + 1), { x: (i % 20) * 4000, y: Math.floor(i / 20) * 4000 }),
    }))
    const state = applyBatch(empty, ops, { now: T0 })
    const session = {
      ...openLocalSession({ kind: 'local', state, label: 'test' }),
      boardId: BOARD_ID,
    }
    sessions.push(session)
    localStorage.setItem(cameraKey(BOARD_ID), JSON.stringify({ x: -1000, y: -1000, zoom: 0.01 }))
    const view = render(<CanvasView session={session} covered books="book" />)
    await frames(50)
    const rt = runtime() as CanvasRuntime
    expect(rt.view.getState().lod).toBe('overview')
    expect(rt.store.getState().notes.size).toBeLessThanOrEqual(rt.pyramidAbove)
    const draw = vi.spyOn(rt.yarn, 'render')
    // A remote change, as the store's own: drawn under the book.
    act(() =>
      session.store.replace(
        applyBatch(state, [{ op: 'note.update', id: idOf('note', 1), set: { x: 10 } }], {
          now: T0,
        }),
      ),
    )
    await frames(200)
    expect(draw).toHaveBeenCalled()
    view.unmount()
  })

  it('a board past the threshold on a page that can never make the pyramid: its far view under a book is drawn as before', async () => {
    const empty = emptyBoardState(BOARD_ID, 'Test board', T0)
    const ops = Array.from({ length: 200 }, (_, i) => ({
      op: 'note.create' as const,
      note: note(idOf('note', i + 1), { x: (i % 20) * 4000, y: Math.floor(i / 20) * 4000 }),
    }))
    const state = applyBatch(empty, ops, { now: T0 })
    const session = {
      ...openLocalSession({ kind: 'local', state, label: 'test' }),
      boardId: BOARD_ID,
    }
    sessions.push(session)
    localStorage.setItem(cameraKey(BOARD_ID), JSON.stringify({ x: -1000, y: -1000, zoom: 0.01 }))
    render(<CanvasView session={session} covered books="book" />)
    await frames(50)
    const rt = runtime() as CanvasRuntime
    expect(rt.view.getState().lod).toBe('overview')
    rt.pyramidAbove = 100
    // No worker with OffscreenCanvas here (jsdom): the pyramid can never be made.
    expect(typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas).not.toBe(
      'function',
    )
    const draw = vi.spyOn(rt.yarn, 'render')
    act(() =>
      session.store.replace(
        applyBatch(state, [{ op: 'note.update', id: idOf('note', 1), set: { x: 10 } }], {
          now: T0,
        }),
      ),
    )
    await frames(200)
    expect(draw).toHaveBeenCalled()
  })

  it('a board past the threshold on a page whose pyramid worker cannot be made: its far view under a book is drawn as before', async () => {
    const empty = emptyBoardState(BOARD_ID, 'Test board', T0)
    const ops = Array.from({ length: 200 }, (_, i) => ({
      op: 'note.create' as const,
      note: note(idOf('note', i + 1), { x: (i % 20) * 4000, y: Math.floor(i / 20) * 4000 }),
    }))
    const state = applyBatch(empty, ops, { now: T0 })
    const session = {
      ...openLocalSession({ kind: 'local', state, label: 'test' }),
      boardId: BOARD_ID,
    }
    sessions.push(session)
    localStorage.setItem(cameraKey(BOARD_ID), JSON.stringify({ x: -1000, y: -1000, zoom: 0.01 }))
    render(<CanvasView session={session} covered books="book" />)
    await frames(50)
    const rt = runtime() as CanvasRuntime
    expect(rt.view.getState().lod).toBe('overview')
    // The page has what the pyramid needs, but its worker fails as it is made (`pyramidBroken`).
    const undo = runsPyramid()
    ;(globalThis as Record<string, unknown>).Worker = class {
      constructor() {
        throw new Error('no worker')
      }
    }
    rt.pyramidAbove = 100
    const draw = vi.spyOn(rt.yarn, 'render')
    act(() =>
      session.store.replace(
        applyBatch(state, [{ op: 'note.update', id: idOf('note', 1), set: { x: 10 } }], {
          now: T0,
        }),
      ),
    )
    // (The pyramid is made a while after the board was last told: past that.)
    await frames(3000)
    undo()
    expect(draw).toHaveBeenCalled()
  })
})
