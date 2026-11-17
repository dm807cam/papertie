// @vitest-environment jsdom
import { applyBatch, type ClientOp, emptyBoardState } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { prefsStore } from '../../src/app/prefs'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { CanvasView } from '../../src/canvas/CanvasView'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

/** Counts the style writes a drag makes on note elements. */
const written = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../src/notes/noteStyle', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/notes/noteStyle')>()
  return {
    ...m,
    writeNoteStyle: (...a: Parameters<typeof m.writeNoteStyle>) => {
      written.n++
      return m.writeNoteStyle(...a)
    },
  }
})

const COUNT = 5000

describe('a group drag on a big board', () => {
  let restore: () => void = () => {}
  let session: BoardSession

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T0))
    restore = installCanvasStubs()
    prefsStore.setState({ tool: 'select', tilt: false })
  })
  afterEach(() => {
    cleanup()
    session.dispose()
    restore()
    vi.useRealTimers()
  })

  it('writes styles for the notes in view only, and keeps no entry per note', async () => {
    const ops: ClientOp[] = Array.from({ length: COUNT }, (_, i) => ({
      op: 'note.create' as const,
      note: note(idOf('note', i + 1), {
        x: (i % 100) * 250,
        y: Math.floor(i / 100) * 200,
        z: i + 1,
      }),
    }))
    const state = applyBatch(emptyBoardState(BOARD_ID, 'T', T0), ops, { now: T0 })
    session = openLocalSession({ kind: 'local', state, label: 'test' })
    render(createElement(CanvasView, { session }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    const rt = window.__papertie?.runtime as CanvasRuntime
    // About 50 notes in view: a few columns and rows at zoom 1 over the origin.
    await act(async () => {
      rt.camera.set({ x: 0, y: 0, zoom: 1 })
      await vi.advanceTimersByTimeAsync(50)
    })
    act(() => rt.selectAll())
    expect(rt.selection.size).toBe(COUNT)
    const mounted = document.querySelectorAll('article[data-note-id]').length
    expect(mounted).toBeGreaterThan(10)
    expect(mounted).toBeLessThan(200)

    const root = document.querySelector('main.viewport') as HTMLElement
    const first = document.querySelector('article[data-note-id]') as HTMLElement
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
    await fire(first, 'pointerdown', 50, 50)
    await fire(root, 'pointermove', 70, 60)
    written.n = 0
    const MOVES = 10
    for (let i = 1; i <= MOVES; i++) await fire(root, 'pointermove', 70 + 3 * i, 60 + 2 * i)
    // Per frame, at most the mounted notes: never the 5,000.
    expect(written.n).toBeLessThanOrEqual(MOVES * mounted * 2)
    expect(written.n).toBeGreaterThan(0)
    expect(rt.overrides.ids()).toEqual([])
    expect(rt.overrides.size).toBe(COUNT)
    expect(rt.dynamicNotes.size).toBeLessThanOrEqual(mounted)
    // Hit-testing sees the group where it is drawn, found through the index: note 1 now covers
    // (50..250, 30..150), and where it was is cork (or another note's).
    expect(rt.noteAt({ x: 150, y: 90 })).toBe(idOf('note', 1))
    expect(rt.noteAt({ x: 10, y: 10 })).toBeUndefined()
    const before = session.store.commits
    await fire(root, 'pointerup', 100, 80)
    expect(session.store.commits).toBe(before + 1)
    expect(session.store.getState().notes.get(idOf('note', COUNT))).toMatchObject({
      x: ((COUNT - 1) % 100) * 250 + 50,
    })
    expect(rt.overrides.size).toBe(0)
  })
})
