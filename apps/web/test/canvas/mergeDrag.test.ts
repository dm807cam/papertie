// @vitest-environment jsdom
import { applyBatch, type ClientOp, emptyBoardState } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { createElement, Profiler } from 'react'
import { prefsStore } from '../../src/app/prefs'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { CanvasView } from '../../src/canvas/CanvasView'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import { MERGE } from '../../src/interactions/merge'
import { MOTION } from '../../src/styles/motion'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const D = idOf('note', 1)
const T = idOf('note', 2)
const O = idOf('note', 3)
const Y = idOf('yarn', 1)

describe('merging notes on the canvas', () => {
  let restore: () => void = () => {}
  let session: BoardSession
  let renders = 0

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'performance', 'Date'],
    })
    vi.setSystemTime(new Date(T0))
    restore = installCanvasStubs()
    prefsStore.setState({ tool: 'select', tilt: false, motion: 'full' })
    renders = 0
  })
  afterEach(() => {
    cleanup()
    session.dispose()
    restore()
    vi.useRealTimers()
    prefsStore.setState({ motion: 'system' })
  })

  async function open() {
    const ops: ClientOp[] = [
      { op: 'note.create', note: note(D, { x: 600, y: 100, text: 'moved', z: 1 }) },
      { op: 'note.create', note: note(T, { x: 100, y: 100, text: 'target', z: 2 }) },
      { op: 'note.create', note: note(O, { x: 100, y: 500, text: 'other', z: 3 }) },
      {
        op: 'yarn.create',
        yarn: {
          type: 'yarn',
          id: Y,
          noteIds: [O, D],
          color: 'apricot',
          label: '',
          createdAt: T0,
          updatedAt: T0,
        },
      },
    ]
    const state = applyBatch(emptyBoardState(BOARD_ID, 'T', T0), ops, { now: T0 })
    session = openLocalSession({ kind: 'local', state, label: 'test' })
    render(
      createElement(
        Profiler,
        {
          id: 'canvas',
          onRender: () => {
            renders++
          },
        },
        createElement(CanvasView, { session }),
      ),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    const rt = window.__papertie?.runtime as CanvasRuntime
    await act(async () => {
      rt.camera.set({ x: 0, y: 0, zoom: 1 })
      await vi.advanceTimersByTimeAsync(50)
    })
    return rt
  }

  const root = () => document.querySelector('main.viewport') as HTMLElement
  const el = (id: string) => document.querySelector(`article[data-note-id="${id}"]`) as HTMLElement
  const fire = (
    target: EventTarget,
    type: string,
    x: number,
    y: number,
    wait = 20,
    altKey = false,
    pointerType = 'mouse',
  ) =>
    act(async () => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: x,
          clientY: y,
          altKey,
        }),
      )
      await vi.advanceTimersByTimeAsync(wait)
    })
  const key = (type: 'keydown' | 'keyup', k: string) =>
    act(async () => {
      window.dispatchEvent(
        new KeyboardEvent(type, { key: k, code: 'AltLeft', altKey: type === 'keydown' }),
      )
      await vi.advanceTimersByTimeAsync(20)
    })
  const bridge = () => document.querySelector('canvas.merge-bridge') as HTMLCanvasElement

  it('holding a note beside another with Alt (Option) shows the bridge without React renders, and the release merges; one undo splits them again', async () => {
    const rt = await open()
    const before = session.store.getState()
    // Grab the dragged note (600..800) and bring its left edge 8 px right of the target's (300).
    await fire(el(D), 'pointerdown', 700, 150, 20, true)
    await fire(root(), 'pointermove', 690, 150, 20, true)
    const quiet = renders
    for (let i = 1; i <= 10; i++) await fire(root(), 'pointermove', 690 - 39 * i, 150, 20, true)
    await fire(root(), 'pointermove', 408, 150, MERGE.dwellMs + 40, true)
    expect(bridge().hidden).toBe(false)
    // The drag and the bridge ran in frames only: nothing rendered through React.
    expect(renders).toBe(quiet)

    const commits = session.store.commits
    await fire(root(), 'pointerup', 408, 150, 20, true)
    expect(session.store.commits).toBe(commits + 1)
    const s = session.store.getState()
    expect(s.notes.has(D)).toBe(false)
    expect(s.notes.get(T)).toMatchObject({ text: 'target\n\nmoved', x: 100, y: 100, w: 200 })
    expect(s.yarns.get(Y)?.noteIds).toEqual([O, T])
    expect([...rt.selection]).toEqual([T])
    // The absorb plays, then everything it left goes.
    expect(document.querySelector('article.note--merging')).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOTION.slow + 100)
    })
    expect(document.querySelector('article.note--merging')).toBeNull()
    expect(bridge().hidden).toBe(true)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', metaKey: true }))
      await vi.advanceTimersByTimeAsync(20)
    })
    const back = session.store.getState()
    expect(back.notes.get(D)?.text).toBe('moved')
    expect(back.notes.get(T)?.text).toBe('target')
    expect(back.notes.get(D)?.x).toBe(before.notes.get(D)?.x)
    expect(back.yarns.get(Y)?.noteIds).toEqual([O, D])
  })

  it('dropping into the book leaves the cards where they were on the board', async () => {
    const rt = await open()
    const calls: string[] = []
    let dropped: { ids: readonly string[]; alt: boolean } | null = null
    // The book's page: everything right of x = 1000.
    rt.setSeamDrop({
      over: (x) => x >= 1000,
      hover: (_x, _y, ids) => calls.push(`hover ${ids.join()}`),
      drop: (_x, _y, ids, alt) => {
        calls.push('drop')
        dropped = { ids, alt }
        return true
      },
      leave: () => calls.push('leave'),
    })
    const before = session.store.getState()
    // Held beside the target with Alt (a bridge forms), then on into the book and let go there.
    await fire(el(D), 'pointerdown', 700, 150, 20, true)
    await fire(root(), 'pointermove', 690, 150, 20, true)
    await fire(root(), 'pointermove', 408, 150, MERGE.dwellMs + 40, true)
    expect(bridge().hidden).toBe(false)
    await fire(root(), 'pointermove', 1100, 150, 20, true)
    expect(calls).toEqual([`hover ${D}`])
    // The board's drag does not follow the pointer into the book.
    const commits = session.store.commits
    await fire(root(), 'pointerup', 1100, 150, 20, true)
    expect(calls).toEqual([`hover ${D}`, 'drop'])
    expect(dropped).toEqual({ ids: [D], alt: true })
    // Nothing committed on the board: no note.update, no merge; the merge watch ended.
    expect(session.store.commits).toBe(commits)
    const s = session.store.getState()
    expect(s.notes.get(D)).toEqual(before.notes.get(D))
    expect(s.notes.get(T)).toEqual(before.notes.get(T))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOTION.slow + 100)
    })
    expect(bridge().hidden).toBe(true)
    // The selection stays.
    expect([...rt.selection]).toEqual([D])
    // Back out of the book before the release: it is the board's drag again, and the book is told.
    await fire(el(D), 'pointerdown', 700, 150)
    await fire(root(), 'pointermove', 690, 150)
    await fire(root(), 'pointermove', 1100, 150)
    await fire(root(), 'pointermove', 650, 400)
    expect(calls.at(-1)).toBe('leave')
    await fire(root(), 'pointerup', 650, 400)
    expect(calls.at(-1)).toBe('leave')
    expect(session.store.getState().notes.get(D)?.y).not.toBe(before.notes.get(D)?.y)
    rt.setSeamDrop(null)
  })

  it('a quick sweep past a note, even with Alt, drops it where it is, unmerged', async () => {
    await open()
    await fire(el(D), 'pointerdown', 700, 150, 20, true)
    await fire(root(), 'pointermove', 690, 150, 20, true)
    await fire(root(), 'pointermove', 408, 150, 30, true)
    await fire(root(), 'pointerup', 408, 150, 20, true)
    const s = session.store.getState()
    expect(s.notes.get(D)).toMatchObject({ x: 308, text: 'moved' })
    expect(s.notes.get(T)?.text).toBe('target')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOTION.fast + 50)
    })
    expect(bridge().hidden).toBe(true)
  })

  it('a note moved over another never merges, even with Alt', async () => {
    await open()
    await fire(el(D), 'pointerdown', 700, 150, 20, true)
    await fire(root(), 'pointermove', 690, 150, 20, true)
    await fire(root(), 'pointermove', 300, 170, MERGE.dwellMs * 2, true)
    expect(bridge().hidden).toBe(true)
    await fire(root(), 'pointerup', 300, 170, 20, true)
    const s = session.store.getState()
    expect(s.notes.get(D)).toMatchObject({ x: 200, y: 120, text: 'moved' })
    expect(s.notes.get(T)?.text).toBe('target')
  })

  it('without Alt a note held beside another only moves there: no bridge, no merge (user)', async () => {
    await open()
    const commits = session.store.commits
    await fire(el(D), 'pointerdown', 700, 150)
    await fire(root(), 'pointermove', 690, 150)
    await fire(root(), 'pointermove', 408, 150, MERGE.dwellMs * 2)
    expect(bridge().hidden).toBe(true)
    await fire(root(), 'pointerup', 408, 150)
    const s = session.store.getState()
    expect(s.notes.get(D)).toMatchObject({ x: 308, text: 'moved' })
    expect(s.notes.get(T)?.text).toBe('target')
    expect(session.store.commits).toBe(commits + 1)
  })

  it('pressing Alt while held beside a note forms the bridge; letting go of it before the release lets the bridge go, and the release only drops', async () => {
    await open()
    await fire(el(D), 'pointerdown', 700, 150)
    await fire(root(), 'pointermove', 690, 150)
    await fire(root(), 'pointermove', 408, 150, MERGE.dwellMs + 40)
    expect(bridge().hidden).toBe(true)
    await key('keydown', 'Alt')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MERGE.dwellMs + 40)
    })
    expect(bridge().hidden).toBe(false)
    await key('keyup', 'Alt')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOTION.fast + 50)
    })
    expect(bridge().hidden).toBe(true)
    await fire(root(), 'pointerup', 408, 150)
    expect(session.store.getState().notes.get(D)).toMatchObject({ x: 308, text: 'moved' })
    expect(session.store.getState().notes.get(T)?.text).toBe('target')
  })

  it('a release without Alt never merges, though the bridge was armed while Alt was held', async () => {
    await open()
    await fire(el(D), 'pointerdown', 700, 150, 20, true)
    await fire(root(), 'pointermove', 690, 150, 20, true)
    await fire(root(), 'pointermove', 408, 150, MERGE.dwellMs + 40, true)
    expect(bridge().hidden).toBe(false)
    // The key's own keyup missed (focus elsewhere): the release says Alt is up.
    await fire(root(), 'pointerup', 408, 150)
    const s = session.store.getState()
    expect(s.notes.get(D)).toMatchObject({ x: 308, text: 'moved' })
    expect(s.notes.get(T)?.text).toBe('target')
  })

  it('on touch, which has no Alt, a note held beside another still merges on release', async () => {
    await open()
    await fire(el(D), 'pointerdown', 700, 150, 20, false, 'touch')
    await fire(root(), 'pointermove', 690, 150, 20, false, 'touch')
    await fire(root(), 'pointermove', 408, 150, MERGE.dwellMs + 40, false, 'touch')
    expect(bridge().hidden).toBe(false)
    await fire(root(), 'pointerup', 408, 150, 20, false, 'touch')
    const s = session.store.getState()
    expect(s.notes.has(D)).toBe(false)
    expect(s.notes.get(T)?.text).toBe('target\n\nmoved')
  })
})
