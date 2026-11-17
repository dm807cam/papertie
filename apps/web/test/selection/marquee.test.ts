// @vitest-environment jsdom
import { applyBatch, type ClientOp, emptyBoardState } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { prefsStore } from '../../src/app/prefs'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { CanvasView } from '../../src/canvas/CanvasView'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import { SpatialIndex } from '../../src/canvas/spatialIndex'
import { marqueeHits, marqueeRect } from '../../src/selection/marquee'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const ids = [1, 2, 3, 4].map((n) => idOf('note', n))
const [N1, N2, N3, N4] = ids as [string, string, string, string]

/** A 2 × 2 grid of 200 × 120 notes at (0,0) (400,0) (0,400) (400,400). */
function grid(): ClientOp[] {
  return ids.map((id, i) => ({
    op: 'note.create' as const,
    note: note(id, { x: (i % 2) * 400, y: Math.floor(i / 2) * 400, z: i + 1 }),
  }))
}

describe('marqueeRect', () => {
  it('is the same rect whichever corner the drag starts from', () => {
    expect(marqueeRect({ x: 50, y: 40 }, { x: 10, y: 90 })).toEqual({ x: 10, y: 40, w: 40, h: 50 })
    expect(marqueeRect({ x: 10, y: 90 }, { x: 50, y: 40 })).toEqual({ x: 10, y: 40, w: 40, h: 50 })
  })
})

describe('marqueeHits', () => {
  it('finds the notes whose paper meets the rect, through the index', () => {
    const state = applyBatch(emptyBoardState(BOARD_ID, 'T', T0), grid(), { now: T0 })
    const index = new SpatialIndex()
    index.rebuild(state, new Map())
    expect(marqueeHits(index, { x: 150, y: 50, w: 300, h: 20 }).sort()).toEqual([N1, N2])
    expect(marqueeHits(index, { x: 250, y: 150, w: 100, h: 100 })).toEqual([])
    expect(marqueeHits(index, { x: -10, y: -10, w: 700, h: 700 }).sort()).toEqual(ids)
  })
})

describe('marquee on the canvas', () => {
  let restore: () => void = () => {}
  const sessions: BoardSession[] = []

  const frames = (ms = 50) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  const runtime = () => window.__papertie?.runtime as CanvasRuntime
  const fire = (
    target: EventTarget,
    type: string,
    x: number,
    y: number,
    shiftKey = false,
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
          shiftKey,
        }),
      )
      await vi.advanceTimersByTimeAsync(20)
    })

  async function open() {
    const state = applyBatch(emptyBoardState(BOARD_ID, 'T', T0), grid(), { now: T0 })
    const session = openLocalSession({ kind: 'local', state, label: 'test' })
    sessions.push(session)
    render(createElement(CanvasView, { session }))
    await frames()
    return session
  }

  /** A drag on the root from viewport point `a` to `b`, the camera at `zoom` over the origin. */
  async function drag(zoom: number, a: [number, number], b: [number, number], shift = false) {
    const rt = runtime()
    await act(async () => {
      rt.camera.set({ x: 0, y: 0, zoom })
      await vi.advanceTimersByTimeAsync(50)
    })
    const root = document.querySelector('main.viewport') as HTMLElement
    await fire(root, 'pointerdown', a[0], a[1], shift)
    await fire(root, 'pointermove', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, shift)
    await fire(root, 'pointermove', b[0], b[1], shift)
    await fire(root, 'pointerup', b[0], b[1], shift)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T0))
    restore = installCanvasStubs()
    prefsStore.setState({ tool: 'select', tilt: false })
  })
  afterEach(() => {
    cleanup()
    for (const s of sessions.splice(0)) s.dispose()
    restore()
    vi.useRealTimers()
  })

  it('Shift-drag on cork draws the marquee, at zoom 1 and in overview', async () => {
    await open()
    // Zoom 1: the top row only (viewport px are world px).
    await drag(1, [150, 20], [450, 60], true)
    expect(runtime().lod).toBe('full')
    expect([...runtime().selection].sort()).toEqual([N1, N2])
    expect(document.querySelector('[data-live-region]')?.textContent?.trim()).toBe(
      'Selected 2 notes',
    )
    // Overview (zoom 0.1): the grid is a few dozen px wide; from bare cork between its columns, a
    // drag back over the left column, added to what was selected.
    await drag(0.1, [25, 3], [3, 60], true)
    expect(runtime().lod).toBe('overview')
    expect([...runtime().selection].sort()).toEqual([N1, N2, N3])
  })

  it('Shift adds to the selection; a click on cork clears it', async () => {
    await open()
    await drag(1, [10, 10], [20, 20], true)
    expect([...runtime().selection]).toEqual([N1])
    await drag(1, [420, 410], [440, 430], true)
    expect([...runtime().selection].sort()).toEqual([N1, N4])
    await drag(1, [300, 300], [301, 301])
    expect([...runtime().selection]).toEqual([])
  })

  it('a plain drag on cork pans the board and keeps the selection', async () => {
    await open()
    await drag(1, [10, 10], [20, 20], true)
    expect([...runtime().selection]).toEqual([N1])
    await drag(1, [300, 300], [360, 340])
    expect(runtime().camera.get()).toMatchObject({ x: -60, y: -40, zoom: 1 })
    expect([...runtime().selection]).toEqual([N1])
    expect(document.querySelector('.overlay > .marquee')?.hasAttribute('hidden') ?? true).toBe(true)
    // In overview too: cork between the cards pans.
    await drag(0.1, [25, 3], [35, 13])
    expect(runtime().camera.get()).toMatchObject({ x: -100, y: -100 })
    expect([...runtime().selection]).toEqual([N1])
  })

  it('on touch and pen, a long press on cork arms the band (a corner shows), then a drag draws it', async () => {
    for (const pointerType of ['touch', 'pen']) {
      await open()
      const rt = runtime()
      await act(async () => {
        rt.camera.set({ x: 0, y: 0, zoom: 1 })
        rt.selectNotes([N4], 'replace')
        await vi.advanceTimersByTimeAsync(50)
      })
      const root = document.querySelector('main.viewport') as HTMLElement
      const band = () => document.querySelector('.overlay > .marquee') as HTMLElement
      await fire(root, 'pointerdown', 150, 20, false, pointerType)
      expect(band().hidden).toBe(true)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(band().hidden).toBe(false)
      expect(band().hasAttribute('data-armed')).toBe(true)
      await fire(root, 'pointermove', 300, 40, false, pointerType)
      await fire(root, 'pointermove', 450, 60, false, pointerType)
      expect(band().hasAttribute('data-armed')).toBe(false)
      await fire(root, 'pointerup', 450, 60, false, pointerType)
      // Added to what was selected, as Shift-drag does; the board never moved.
      expect([...rt.selection].sort()).toEqual([N1, N2, N4].sort())
      expect(rt.camera.get()).toMatchObject({ x: 0, y: 0 })
      expect(band().hidden).toBe(true)
      cleanup()
    }
  })

  it('on touch, a drag before the long press pans; a long press released in place changes nothing', async () => {
    await open()
    const rt = runtime()
    await act(async () => {
      rt.camera.set({ x: 0, y: 0, zoom: 1 })
      rt.selectNotes([N1], 'replace')
      await vi.advanceTimersByTimeAsync(50)
    })
    const root = document.querySelector('main.viewport') as HTMLElement
    await fire(root, 'pointerdown', 300, 300, false, 'touch')
    await fire(root, 'pointermove', 340, 330, false, 'touch')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    await fire(root, 'pointermove', 360, 340, false, 'touch')
    await fire(root, 'pointerup', 360, 340, false, 'touch')
    expect(rt.camera.get()).toMatchObject({ x: -60, y: -40 })
    expect(document.querySelector('.overlay > .marquee')?.hasAttribute('hidden')).toBe(true)
    expect([...rt.selection]).toEqual([N1])

    await fire(root, 'pointerdown', 300, 300, false, 'touch')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    await fire(root, 'pointerup', 300, 300, false, 'touch')
    expect([...rt.selection]).toEqual([N1])
    expect(document.querySelector('.overlay > .marquee')?.hasAttribute('hidden')).toBe(true)
  })

  it('a mouse never arms the band by holding still', async () => {
    await open()
    const rt = runtime()
    const root = document.querySelector('main.viewport') as HTMLElement
    await fire(root, 'pointerdown', 300, 300)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(document.querySelector('.overlay > .marquee')?.hasAttribute('hidden')).toBe(true)
    await fire(root, 'pointermove', 340, 330)
    await fire(root, 'pointerup', 340, 330)
    expect(rt.selection.size).toBe(0)
    expect(rt.camera.get().x).not.toBe(0)
  })

  it('the yarn tool pans on cork as well', async () => {
    await open()
    prefsStore.setState({ tool: 'yarn' })
    await frames()
    await drag(1, [300, 300], [330, 300])
    expect(runtime().camera.get()).toMatchObject({ x: -30, y: 0 })
  })

  it('Esc during the drag puts the old selection back', async () => {
    await open()
    await drag(1, [10, 10], [20, 20], true)
    const rt = runtime()
    const root = document.querySelector('main.viewport') as HTMLElement
    await fire(root, 'pointerdown', 300, 300, true)
    await fire(root, 'pointermove', 460, 450, true)
    expect(rt.selection.size).toBe(2)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await vi.advanceTimersByTimeAsync(20)
    })
    expect([...rt.selection]).toEqual([N1])
    expect(document.querySelector('.overlay > .marquee')?.hasAttribute('hidden')).toBe(true)
  })
})
