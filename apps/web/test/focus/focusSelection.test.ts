// @vitest-environment jsdom
import { applyBatch, type ClientOp } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { prefsStore } from '../../src/app/prefs'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { CanvasView } from '../../src/canvas/CanvasView'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import { focusHash, HASH_INCLUDE_MAX, withIncludes } from '../../src/focus/focusMode'
import { installCanvasStubs } from '../helpers/domCanvas'
import { idOf, note, T0 } from '../helpers/fakeServer'
import { A, B, C, chainBoard, D, E, F, G, H } from './board'

/** `n` more notes, hidden in any focus on A, in a block to the right of the chain, out of view. */
function crowd(n: number): ClientOp[] {
  return Array.from({ length: n }, (_, i) => ({
    op: 'note.create' as const,
    note: note(idOf('note', 1000 + i), {
      x: 8000 + (i % 60) * 300,
      y: Math.floor(i / 60) * 200 - 2000,
      z: 100 + i,
    }),
  }))
}

/**
 * Selection inside focus mode: the marquee, the arrows and ⌘A take only
 * the notes the focus shows, and a command that makes notes (duplicate) brings each one in.
 * The focus is A at depth 1 (A, B, C) with F brought in; D, E, G and H are hidden.
 */
describe('selection in focus mode', () => {
  let restore: () => void = () => {}
  const sessions: BoardSession[] = []

  const frames = (ms = 50) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  const runtime = () => window.__papertie?.runtime as CanvasRuntime
  const press = (k: string, init: KeyboardEventInit = {}) =>
    act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
      )
      await vi.advanceTimersByTimeAsync(20)
    })
  const fire = (type: string, x: number, y: number, shiftKey = false) =>
    act(async () => {
      runtime().els.root.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: x,
          clientY: y,
          shiftKey,
        }),
      )
      await vi.advanceTimersByTimeAsync(20)
    })
  const selected = () => [...runtime().selection].sort()

  /** The chain board in a canvas, the whole row in view (zoom 0.25), focused on A with F in. */
  async function open(extra: ClientOp[] = []) {
    const state = extra.length === 0 ? chainBoard() : applyBatch(chainBoard(), extra, { now: T0 })
    const session = openLocalSession({ kind: 'local', state, label: 'test' })
    sessions.push(session)
    render(createElement(CanvasView, { session }))
    await frames()
    const rt = runtime()
    await act(async () => {
      rt.camera.set({ x: -40, y: -200, zoom: 0.25 })
      rt.setFocus({ seeds: [A], depth: 1, include: [F] }, { instant: true, fit: false })
      await vi.advanceTimersByTimeAsync(400)
    })
    expect([...(rt.focus?.notes ?? [])].sort()).toEqual([A, B, C, F].sort())
    return { rt, session }
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
    // The chip binds focus to the hash, and a board restores it from there: none carries over.
    history.replaceState(null, '', '/')
  })

  it('⌘A selects what the focus shows, never a hidden note', async () => {
    await open()
    await press('a', { metaKey: true })
    expect(selected()).toEqual([A, B, C, F].sort())
  })

  it('an arrow skips the hidden notes on its way to the next shown one', async () => {
    const { rt } = await open()
    await act(async () => rt.selectNote(C))
    // D and E lie between C and F, hidden.
    await press('ArrowRight')
    expect(selected()).toEqual([F])
    // Nothing shown further right: the selection stays.
    await press('ArrowRight')
    expect(selected()).toEqual([F])
  })

  it('the marquee leaves the hidden notes it crosses out', async () => {
    const { rt } = await open()
    // Shift-drag from bare cork below the row to above its far end: the band meets all eight.
    await fire('pointerdown', 4, 300, true)
    await fire('pointermove', 400, 150, true)
    await fire('pointermove', 1000, 20, true)
    await fire('pointerup', 1000, 20, true)
    expect(selected()).toEqual([A, B, C, F].sort())
    for (const id of [D, E, G, H]) expect(rt.selection.has(id)).toBe(false)
  })

  it('duplicating several notes brings every copy into the focus', async () => {
    const { rt, session } = await open()
    await act(async () => rt.selectNotes([A, B], 'replace'))
    const before = new Set(session.store.getState().notes.keys())
    await press('d', { metaKey: true })
    // The copies mount on the next recull.
    await frames(100)
    const copies = [...session.store.getState().notes.keys()].filter((id) => !before.has(id))
    expect(copies).toHaveLength(2)
    expect(selected()).toEqual([...copies].sort())
    for (const id of copies) {
      expect(rt.focus?.notes.has(id)).toBe(true)
      const el = rt.noteEls.get(id)
      expect(el).toBeDefined()
      expect(el?.hasAttribute('inert')).toBe(false)
      expect(el?.getAttribute('aria-hidden')).toBeNull()
    }
    expect(rt.focusState?.include).toEqual(expect.arrayContaining([F, ...copies]))
  })

  it('Esc leaves focus first, then clears the selection', async () => {
    const { rt } = await open()
    await act(async () => rt.selectNotes([A, C], 'replace'))
    await press('Escape')
    expect(rt.focusState).toBeNull()
    expect(selected()).toEqual([A, C].sort())
    await press('Escape')
    expect(selected()).toEqual([])
  })

  it('an arrow past the last shown note reads the focus, never the hidden crowd', async () => {
    // A 4-note focus on a board of 3,000 hidden notes, all of them to the right of F.
    const { rt } = await open(crowd(3000))
    await act(async () => rt.selectNote(F))
    const queried = vi.spyOn(rt.index, 'notesIn')
    const { notes } = rt.store.getState()
    const reads = vi.spyOn(notes, 'get')
    await press('ArrowRight')
    const fromIndex = queried.mock.results.reduce(
      (sum, r) => sum + (Array.isArray(r.value) ? r.value.length : 0),
      0,
    )
    const candidates = reads.mock.calls.length + fromIndex
    queried.mockRestore()
    reads.mockRestore()
    // Nothing shown lies that way: the selection stays, and the search cost O(|focus|).
    expect(selected()).toEqual([F])
    expect(candidates).toBeLessThanOrEqual(4 * 4)
  })

  it('a focus of most of the board walks the bands, skipping the hidden notes', async () => {
    const { rt } = await open()
    // The whole component of A (A to F) and H: 7 of 8 notes, so the arrows use the index.
    await act(async () => {
      rt.setFocus({ seeds: [A], depth: 'all', include: [H] }, { instant: true, fit: false })
      await vi.advanceTimersByTimeAsync(400)
    })
    await act(async () => rt.selectNote(F))
    const queried = vi.spyOn(rt.index, 'notesIn')
    await press('ArrowRight')
    expect(queried).toHaveBeenCalled()
    queried.mockRestore()
    expect(selected()).toEqual([H])
  })

  it('brings a large batch in with one focus change, and keeps the hash bounded', async () => {
    const { rt } = await open(crowd(2000))
    const changes: unknown[] = []
    const off = rt.onFocusChange((f) => changes.push(f))
    const many = Array.from({ length: 2000 }, (_, i) => idOf('note', 1000 + i))
    await act(async () => rt.selectNotes(many, 'replace', { bringIn: true }))
    off()
    expect(changes).toHaveLength(1)
    expect(rt.focusState?.include).toHaveLength(2001)
    expect(rt.selection.size).toBe(2000)
    // Past the cap the hash keeps the focus by its seeds and depth only.
    expect(location.hash).toBe(`#focus=${A}&d=1`)
  })
})

describe('withIncludes and the hash', () => {
  const f = { seeds: [A], depth: 1 as const, include: [F] }

  it('adds ids in one pass, skipping seeds, repeats and what is already in', () => {
    expect(withIncludes(f, [B, A, F, B, C])).toEqual({ ...f, include: [F, B, C] })
    expect(withIncludes(f, [A, F])).toBe(f)
  })

  it('writes the included notes while they are few, and drops them past the cap', () => {
    expect(focusHash(f)).toBe(`#focus=${A}&d=1&in=${F}`)
    const ids = Array.from({ length: HASH_INCLUDE_MAX + 1 }, (_, i) => idOf('note', 1000 + i))
    expect(focusHash(withIncludes(f, ids.slice(1, HASH_INCLUDE_MAX)))).toContain('&in=')
    expect(focusHash(withIncludes(f, ids))).toBe(`#focus=${A}&d=1`)
  })
})
