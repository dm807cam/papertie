import { applyBatch, emptyBoardState } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { CAMERA_SAVE_MS, cameraKey } from '../../src/app/cameraMemory'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { MOVING_TAIL_MS } from '../../src/canvas/CameraController'
import { CanvasView } from '../../src/canvas/CanvasView'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

/** Every `rememberCamera` call, passed through to the real one. */
const remembered = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../src/app/cameraMemory', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/app/cameraMemory')>()
  return {
    ...m,
    rememberCamera: (...a: Parameters<typeof m.rememberCamera>) => {
      remembered.calls++
      return m.rememberCamera(...a)
    },
  }
})

let restore: () => void = () => {}
const sessions: BoardSession[] = []

/** A board that has an id, as a server board does, so its camera is remembered. */
function board(boardId: string | null): BoardSession {
  const state = applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [{ op: 'note.create', note: note(idOf('note', 1), { x: 5000, y: 5000, text: 'far' }) }],
    { now: T0 },
  )
  const session = { ...openLocalSession({ kind: 'local', state, label: 'test' }), boardId }
  sessions.push(session)
  return session
}

const frames = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const runtime = () => window.__papertie?.runtime as CanvasRuntime

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  restore = installCanvasStubs()
  localStorage.clear()
  remembered.calls = 0
})
afterEach(() => {
  cleanup()
  for (const s of sessions.splice(0)) s.dispose()
  document.body.replaceChildren()
  restore()
  localStorage.clear()
  vi.useRealTimers()
})

describe('camera memory on the board', () => {
  it('opens fitting every note when nothing is remembered, then remembers where it rested', async () => {
    render(<CanvasView session={board(BOARD_ID)} />)
    await frames(50)
    const rt = runtime()
    const fitted = rt.camera.get()
    // The far note is in view.
    const r = rt.notesRect()
    expect(r).not.toBeNull()
    expect(localStorage.getItem(cameraKey(BOARD_ID))).toBeNull()
    // Opening is not the writer's doing: nothing is saved for it.
    await frames(CAMERA_SAVE_MS + 100)
    expect(localStorage.getItem(cameraKey(BOARD_ID))).toBeNull()

    act(() => rt.camera.set({ x: 100, y: 200, zoom: 0.75 }))
    await frames(40)
    expect(localStorage.getItem(cameraKey(BOARD_ID))).toBeNull()
    // The camera counts as settled a moment after its last move (the frame loop's tail).
    await frames(CAMERA_SAVE_MS + MOVING_TAIL_MS + 100)
    expect(JSON.parse(localStorage.getItem(cameraKey(BOARD_ID)) ?? 'null')).toEqual({
      x: 100,
      y: 200,
      zoom: 0.75,
    })
    expect(fitted).not.toEqual({ x: 100, y: 200, zoom: 0.75 })
  })

  it('opens a new board on its welcome note at 100%, not magnified to fill the view', async () => {
    const state = applyBatch(
      emptyBoardState(BOARD_ID, 'My board', T0),
      [{ op: 'note.create', note: note(idOf('note', 1), { x: 0, y: 0, w: 280, h: 160 }) }],
      { now: T0 },
    )
    const session = { ...openLocalSession({ kind: 'local', state, label: 'test' }), boardId: null }
    sessions.push(session)
    render(<CanvasView session={session} />)
    await frames(50)
    const cam = runtime().camera.get()
    expect(cam.zoom).toBe(1)
    // The note's middle is the view's middle.
    const { width, height } = runtime().viewport
    expect(cam.x + width / 2).toBeCloseTo(140, 0)
    expect(cam.y + height / 2).toBeGreaterThan(0)
  })

  it('opens an empty board at 100% on the origin', async () => {
    const state = emptyBoardState(BOARD_ID, 'My board', T0)
    const session = { ...openLocalSession({ kind: 'local', state, label: 'test' }), boardId: null }
    sessions.push(session)
    render(<CanvasView session={session} />)
    await frames(50)
    const cam = runtime().camera.get()
    expect(cam.zoom).toBe(1)
    const { width, height } = runtime().viewport
    expect({ x: cam.x + width / 2, y: cam.y + height / 2 }).toEqual({ x: 0, y: 0 })
  })

  it('opens where the camera was left', async () => {
    localStorage.setItem(cameraKey(BOARD_ID), JSON.stringify({ x: 4900, y: 4900, zoom: 2 }))
    render(<CanvasView session={board(BOARD_ID)} />)
    await frames(50)
    expect(runtime().camera.get()).toEqual({ x: 4900, y: 4900, zoom: 2 })
  })

  it('a board without an id (a dev board) remembers nothing', async () => {
    render(<CanvasView session={board(null)} />)
    await frames(50)
    act(() => runtime().camera.set({ x: 1, y: 2, zoom: 1 }))
    await frames(CAMERA_SAVE_MS + 100)
    expect(localStorage.length).toBe(0)
  })

  it('does not re-render the board when the camera moves', async () => {
    render(<CanvasView session={board(BOARD_ID)} />)
    await frames(50)
    const before = window.__papertie?.renders.canvasView
    for (let i = 0; i < 20; i++) {
      act(() => runtime().camera.set({ x: i * 10, y: 0, zoom: 1 }))
      await frames(16)
    }
    await frames(CAMERA_SAVE_MS + 100)
    expect(window.__papertie?.renders.canvasView).toBe(before)
  })

  it('opens fitting the notes when the remembered view shows none of them', async () => {
    render(<CanvasView session={board(BOARD_ID)} />)
    await frames(50)
    const fitted = runtime().camera.get()
    cleanup()
    document.body.replaceChildren()
    localStorage.setItem(cameraKey(BOARD_ID), JSON.stringify({ x: -400, y: 30, zoom: 2 }))
    render(<CanvasView session={board(BOARD_ID)} />)
    await frames(50)
    expect(runtime().camera.get()).toEqual(fitted)
  })

  it('asks to remember once per gesture, when the camera settles', async () => {
    render(<CanvasView session={board(BOARD_ID)} />)
    await frames(50)
    for (let i = 0; i < 20; i++) {
      act(() => runtime().camera.set({ x: i * 10, y: 0, zoom: 1 }))
      await frames(16)
    }
    expect(remembered.calls).toBe(0)
    await frames(MOVING_TAIL_MS + 50)
    expect(remembered.calls).toBe(1)
    // A resize refresh moves nothing: nothing to remember.
    act(() => runtime().camera.refresh())
    await frames(MOVING_TAIL_MS + 50)
    expect(remembered.calls).toBe(1)
  })

  it('saves when the page is hidden, not only on pagehide', async () => {
    render(<CanvasView session={board(BOARD_ID)} />)
    await frames(50)
    act(() => runtime().camera.set({ x: 7, y: 8, zoom: 1 }))
    // Applied, and still moving: the settle (MOVING_TAIL_MS on) has not come.
    await frames(50)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(JSON.parse(localStorage.getItem(cameraKey(BOARD_ID)) ?? 'null')).toEqual({
      x: 7,
      y: 8,
      zoom: 1,
    })
    Reflect.deleteProperty(document, 'visibilityState')
  })
})
