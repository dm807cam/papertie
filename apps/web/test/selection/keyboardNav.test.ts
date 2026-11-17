// @vitest-environment jsdom
import { applyBatch, type ClientOp, emptyBoardState } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { prefsStore } from '../../src/app/prefs'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { CanvasView } from '../../src/canvas/CanvasView'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import { SpatialIndex } from '../../src/canvas/spatialIndex'
import {
  nearestInDirection,
  readingOrder,
  selectionKey,
  stableOrder,
} from '../../src/selection/keyboardNav'
import type { CommitOptions } from '../../src/store/boardStore'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const nid = (n: number) => idOf('note', n)

/** A 3 × 3 grid, ids 1..9 row by row, 200 × 120 notes 300 px apart. */
function grid3(): ClientOp[] {
  return Array.from({ length: 9 }, (_, i) => ({
    op: 'note.create' as const,
    note: note(nid(i + 1), { x: (i % 3) * 300, y: Math.floor(i / 3) * 300, z: i + 1 }),
  }))
}

const stateOf = (ops: ClientOp[]) =>
  applyBatch(emptyBoardState(BOARD_ID, 'T', T0), ops, { now: T0 })

describe('nearestInDirection', () => {
  const state = stateOf(grid3())
  const index = new SpatialIndex()
  index.rebuild(state, new Map())
  const go = (from: number, dir: 'up' | 'down' | 'left' | 'right') =>
    nearestInDirection(state, nid(from), dir, index)

  it('picks the right neighbour on a 3×3 grid and null at the edge', () => {
    expect(go(5, 'right')).toBe(nid(6))
    expect(go(5, 'left')).toBe(nid(4))
    expect(go(5, 'up')).toBe(nid(2))
    expect(go(5, 'down')).toBe(nid(8))
    expect(go(1, 'left')).toBeNull()
    expect(go(1, 'up')).toBeNull()
    expect(go(9, 'right')).toBeNull()
    expect(go(9, 'down')).toBeNull()
    expect(go(3, 'right')).toBeNull()
    expect(go(1, 'right')).toBe(nid(2))
    expect(go(1, 'down')).toBe(nid(4))
  })

  it('ignores notes outside the ±60° cone, however near', () => {
    const s = stateOf([
      { op: 'note.create', note: note(nid(1), { x: 0, y: 0 }) },
      // Mostly below, a little right: not "right" of the first.
      { op: 'note.create', note: note(nid(2), { x: 120, y: 400 }) },
    ])
    const idx = new SpatialIndex()
    idx.rebuild(s, new Map())
    expect(nearestInDirection(s, nid(1), 'right', idx)).toBeNull()
    expect(nearestInDirection(s, nid(1), 'down', idx)).toBe(nid(2))
  })

  it('prefers the aligned note over a slightly nearer one off to the side', () => {
    const s = stateOf([
      { op: 'note.create', note: note(nid(1), { x: 0, y: 0 }) },
      { op: 'note.create', note: note(nid(2), { x: 300, y: 0 }) },
      { op: 'note.create', note: note(nid(3), { x: 270, y: 230 }) },
    ])
    const idx = new SpatialIndex()
    idx.rebuild(s, new Map())
    expect(nearestInDirection(s, nid(1), 'right', idx)).toBe(nid(2))
  })

  it('reaches a far note, widening its query, and asks the index only', () => {
    const s = stateOf([
      { op: 'note.create', note: note(nid(1), { x: 0, y: 0 }) },
      { op: 'note.create', note: note(nid(2), { x: 4_000_000, y: 30 }) },
    ])
    const idx = new SpatialIndex()
    idx.rebuild(s, new Map())
    const spy = vi.spyOn(idx, 'notesIn')
    expect(nearestInDirection(s, nid(1), 'right', idx)).toBe(nid(2))
    expect(spy.mock.calls.length).toBeLessThan(20)
  })

  it('is null for an unknown note', () => {
    expect(go(99, 'right')).toBeNull()
  })
})

describe('readingOrder', () => {
  it('goes by rows of 200 world px, then x', () => {
    const ns = new Map([
      ['a', { x: 500, y: 10 }],
      ['b', { x: 0, y: 190 }],
      ['c', { x: 100, y: 210 }],
      ['d', { x: 100, y: 10 }],
      ['e', { x: -50, y: 400 }],
    ])
    expect(readingOrder(['a', 'b', 'c', 'd', 'e'], ns)).toEqual(['b', 'd', 'a', 'c', 'e'])
  })

  it('breaks a tie by id and leaves its input alone', () => {
    const ns = new Map([
      ['b', { x: 0, y: 0 }],
      ['a', { x: 0, y: 0 }],
    ])
    const input = ['b', 'a']
    expect(readingOrder(input, ns)).toEqual(['a', 'b'])
    expect(input).toEqual(['b', 'a'])
  })
})

describe('stableOrder', () => {
  it('keeps the old relative order, drops the gone and slots in the new', () => {
    // `m` follows `c`, the kept note before it in the order wanted; `n` follows `a`.
    expect(stableOrder(['c', 'a', 'x', 'b'], ['a', 'n', 'b', 'c', 'm'])).toEqual([
      'c',
      'm',
      'a',
      'n',
      'b',
    ])
    expect(stableOrder([], ['a', 'b'])).toEqual(['a', 'b'])
    expect(stableOrder(['a'], ['z', 'a'])).toEqual(['z', 'a'])
  })
})

describe('selectionKey', () => {
  const key = (k: string, extra: Partial<Parameters<typeof selectionKey>[0]> = {}) =>
    selectionKey({ key: k, code: k, shiftKey: false, target: null, ...extra })

  it('maps arrows, Alt+arrows and select all', () => {
    expect(key('ArrowLeft')).toEqual({ kind: 'move', dir: 'left' })
    expect(key('ArrowDown')).toEqual({ kind: 'move', dir: 'down' })
    expect(key('ArrowRight', { altKey: true })).toEqual({ kind: 'nudge', dir: 'right', step: 1 })
    expect(key('ArrowUp', { altKey: true, shiftKey: true })).toEqual({
      kind: 'nudge',
      dir: 'up',
      step: 10,
    })
    expect(key('a', { code: 'KeyA', metaKey: true })).toEqual({ kind: 'all' })
    expect(key('a', { code: 'KeyA', ctrlKey: true })).toEqual({ kind: 'all' })
  })

  it('leaves other chords, and every key in a text field, alone', () => {
    expect(key('ArrowLeft', { shiftKey: true })).toBeNull()
    expect(key('ArrowLeft', { metaKey: true })).toBeNull()
    expect(key('a', { code: 'KeyA' })).toBeNull()
    expect(key('a', { code: 'KeyA', metaKey: true, shiftKey: true })).toBeNull()
    const field = { tagName: 'TEXTAREA' } as unknown as EventTarget
    expect(key('ArrowLeft', { target: field })).toBeNull()
    expect(key('a', { code: 'KeyA', metaKey: true, target: field })).toBeNull()
    expect(key('ArrowLeft', { altKey: true, target: field })).toBeNull()
  })
})

describe('keyboard on the canvas', () => {
  let restore: () => void = () => {}
  const sessions: BoardSession[] = []

  const frames = (ms = 50) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  const runtime = () => window.__papertie?.runtime as CanvasRuntime
  const press = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) =>
    act(async () => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
      )
      await vi.advanceTimersByTimeAsync(20)
    })
  const said = () => document.querySelector('[data-live-region]')?.textContent?.trim()
  const articles = () => [...document.querySelectorAll<HTMLElement>('article[data-note-id]')]

  async function open(ops: ClientOp[]) {
    const session = openLocalSession({ kind: 'local', state: stateOf(ops), label: 'test' })
    sessions.push(session)
    const commits: Array<{ ops: readonly ClientOp[]; o: CommitOptions }> = []
    session.store.onCommit((_b, o, opts) => commits.push({ ops: o, o: opts }))
    render(createElement(CanvasView, { session }))
    await frames()
    return { session, commits }
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

  it('tab order follows reading order', async () => {
    // Painted bottom-up: the first row is on top, so paint order is the reverse of reading order.
    const ops = grid3().map((op, i) =>
      op.op === 'note.create'
        ? { ...op, note: { ...op.note, z: 9 - i, text: `note ${i + 1}` } }
        : op,
    )
    await open(ops)
    const els = articles()
    expect(els.map((e) => e.dataset.noteId)).toEqual(
      Array.from({ length: 9 }, (_, i) => nid(i + 1)),
    )
    for (const el of els) {
      expect(el.tabIndex).toBe(0)
      expect(el.hasAttribute('aria-selected')).toBe(false)
      expect(el.hasAttribute('aria-describedby')).toBe(false)
    }
    expect(els[0]?.getAttribute('aria-label')).toBe('note 1')
    // Painting still follows z, not the DOM: the lowest z is the lowest rank.
    const stack = (id: string) =>
      Number(els.find((e) => e.dataset.noteId === id)?.style.getPropertyValue('--stack'))
    expect(stack(nid(9))).toBeLessThan(stack(nid(8)))
    expect(stack(nid(2))).toBeLessThan(stack(nid(1)))
  })

  it('puts the chrome before the notes in the tab order', async () => {
    await open(grid3())
    const ui = document.querySelector('main.viewport > .ui') as HTMLElement
    const world = document.querySelector('main.viewport > .world') as HTMLElement
    expect(ui.compareDocumentPosition(world) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('ranks paint order by z itself, so a note entering the view rewrites nobody else', async () => {
    const spaced = grid3().map((op) =>
      op.op === 'note.create' ? { ...op, note: { ...op.note, z: op.note.z * 10 } } : op,
    )
    const { session } = await open(spaced)
    const stack = (id: string) =>
      articles()
        .find((e) => e.dataset.noteId === id)
        ?.style.getPropertyValue('--stack')
    expect(stack(nid(3))).toBe('30')
    expect(stack(nid(9))).toBe('90')
    const writes = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty')
    // Another note comes between 3 and 4 in z: only it is written.
    await act(async () => {
      session.store.commit([{ op: 'note.create', note: note(nid(20), { x: 100, y: 150, z: 35 }) }])
      await vi.advanceTimersByTimeAsync(50)
    })
    const stackWrites = writes.mock.calls.filter((c) => c[0] === '--stack')
    writes.mockRestore()
    expect(stackWrites).toHaveLength(1)
    expect(stack(nid(9))).toBe('90')
    expect(stack(nid(20))).toBe('35')
  })

  it('falls back to dense ranks while two mounted notes share a z', async () => {
    const ops = grid3().map((op) =>
      op.op === 'note.create'
        ? { ...op, note: { ...op.note, z: op.note.z === 2 ? 1 : op.note.z } }
        : op,
    )
    await open(ops)
    const ranks = articles().map((e) => [
      e.dataset.noteId,
      Number(e.style.getPropertyValue('--stack')),
    ])
    const byRank = ranks.sort((a, b) => (a[1] as number) - (b[1] as number)).map((r) => r[0])
    // z 1 twice (notes 1 and 2, by id), then 3..9.
    expect(byRank).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(nid))
    expect(new Set(ranks.map((r) => r[1])).size).toBe(9)
  })

  it('labels an empty note and follows the selection in aria-selected', async () => {
    await open(grid3())
    expect(articles()[0]?.getAttribute('aria-label')).toBe('Empty note')
    act(() => runtime().selectNotes([nid(1), nid(5)], 'replace'))
    await frames()
    // One shared, hidden "Selected" node, which selected notes point at (aria-selected is not an
    // article's attribute).
    const mark = document.querySelector<HTMLElement>('[data-selected-mark]')
    expect(mark?.textContent).toBe('Selected')
    expect(document.querySelectorAll('[data-selected-mark]')).toHaveLength(1)
    const sel = articles().filter((e) => e.getAttribute('aria-describedby') === mark?.id)
    expect(sel.map((e) => e.dataset.noteId)).toEqual([nid(1), nid(5)])
    expect(articles().some((e) => e.hasAttribute('aria-selected'))).toBe(false)
  })

  it('describes each mounted note by the notes its threads tie it to, and follows the board', async () => {
    const named = grid3().map((op, i) =>
      op.op === 'note.create' ? { ...op, note: { ...op.note, text: `note ${i + 1}` } } : op,
    )
    const thread = (n: number, ids: number[], color: 'indigo' | 'apricot'): ClientOp => ({
      op: 'yarn.create',
      yarn: {
        type: 'yarn',
        id: idOf('yarn', n),
        noteIds: ids.map(nid),
        color,
        label: '',
        createdAt: T0,
        updatedAt: T0,
      },
    })
    const { session } = await open([...named, thread(1, [1, 2], 'indigo')])
    const el = (n: number) => articles().find((e) => e.dataset.noteId === nid(n)) as HTMLElement
    /** The accessible description: the text of what `aria-describedby` names, in order. */
    const description = (n: number) =>
      (el(n).getAttribute('aria-describedby') ?? '')
        .split(' ')
        .filter((id) => id !== '')
        .map((id) => document.getElementById(id)?.textContent ?? `<missing ${id}>`)
        .join(' ')
    expect(description(1)).toBe('Tied to “note 2” by indigo yarn.')
    expect(description(2)).toBe('Tied to “note 1” by indigo yarn.')
    // A note on no thread has no description at all.
    expect(el(3).hasAttribute('aria-describedby')).toBe(false)

    // Selected, it is also "Selected", after what it is tied to.
    act(() => runtime().selectNotes([nid(1)], 'replace'))
    await frames()
    expect(description(1)).toBe('Tied to “note 2” by indigo yarn. Selected')

    // A new thread, and a tied note written on, change what is said.
    act(() => {
      session.store.commit([thread(2, [3, 1], 'apricot')])
      session.store.commit([{ op: 'note.update', id: nid(2), set: { text: 'Packing list' } }])
    })
    await frames()
    expect(description(1)).toBe(
      'Tied to “Packing list” by indigo yarn, and to “note 3” by crimson yarn. Selected',
    )
    expect(description(3)).toBe('Tied to “note 1” by crimson yarn.')
  })

  it('never moves a focused note in the DOM when others reorder around it, then settles', async () => {
    const { session } = await open(grid3())
    const five = articles().find((e) => e.dataset.noteId === nid(5)) as HTMLElement
    const removed: Node[] = []
    const mo = new MutationObserver((rs) => {
      for (const r of rs) for (const n of r.removedNodes) removed.push(n)
    })
    mo.observe(five.parentElement as HTMLElement, { childList: true })
    act(() => five.focus())
    await frames()
    // Note 1 moves far down: reading order puts it last.
    await act(async () => {
      session.store.commit([{ op: 'note.update', id: nid(1), set: { y: 900 } }])
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(removed).not.toContain(five)
    expect(document.activeElement).toBe(five)
    expect(articles().at(-1)?.dataset.noteId).not.toBe(nid(1))
    // The keyboard leaves: the order catches up with the board.
    await act(async () => {
      five.blur()
      await vi.advanceTimersByTimeAsync(50)
    })
    mo.disconnect()
    expect(articles().map((e) => e.dataset.noteId)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 1].map(nid))
  })

  it('keeps the overlay frame for one selected note, and none for several', async () => {
    await open(grid3())
    const frame = () => document.querySelector<HTMLElement>('.overlay > .selection')
    act(() => runtime().selectNote(nid(1)))
    await frames()
    expect(frame()?.hidden).toBe(false)
    act(() => runtime().selectNotes([nid(2)], 'add'))
    await frames()
    expect(frame()?.hidden).toBe(true)
    act(() => runtime().selectNotes([nid(2)], 'toggle'))
    await frames()
    expect(frame()?.hidden).toBe(false)
  })

  it('arrow keys move selection (and focus) to the nearest note', async () => {
    await open(grid3())
    act(() => runtime().selectNote(nid(5)))
    await press('ArrowRight')
    expect([...runtime().selection]).toEqual([nid(6)])
    expect(document.activeElement).toBe(articles().find((e) => e.dataset.noteId === nid(6)))
    await press('ArrowDown')
    expect([...runtime().selection]).toEqual([nid(9)])
    await press('ArrowDown')
    expect([...runtime().selection]).toEqual([nid(9)])
    await press('ArrowLeft')
    expect([...runtime().selection]).toEqual([nid(8)])
  })

  it('keeps arrows and ⌘A native inside the editor', async () => {
    await open(grid3())
    act(() => runtime().selectNote(nid(5)))
    const field = document.createElement('div')
    field.setAttribute('contenteditable', 'true')
    document.body.append(field)
    await press('ArrowRight', {}, field)
    await press('a', { metaKey: true, code: 'KeyA' }, field)
    expect([...runtime().selection]).toEqual([nid(5)])
    field.remove()
  })

  it('⌘A selects every note and says so; Esc clears', async () => {
    await open(grid3())
    await press('a', { metaKey: true, code: 'KeyA' })
    expect(runtime().selection.size).toBe(9)
    expect(said()).toBe('Selected 9 notes')
    await press('Escape')
    expect(runtime().selection.size).toBe(0)
  })

  it('Alt+Shift+Right nudges by 10 and coalesces', async () => {
    const { session, commits } = await open(grid3())
    act(() => runtime().selectNotes([nid(1), nid(2)], 'replace'))
    await press('ArrowRight', { altKey: true, shiftKey: true })
    await press('ArrowRight', { altKey: true, shiftKey: true })
    await press('ArrowDown', { altKey: true })
    const notes = session.store.getState().notes
    expect(notes.get(nid(1))).toMatchObject({ x: 20, y: 1, z: 1 })
    expect(notes.get(nid(2))).toMatchObject({ x: 320, y: 1 })
    expect(notes.get(nid(3))).toMatchObject({ x: 600, y: 0 })
    expect(commits).toHaveLength(3)
    for (const c of commits) {
      expect(c.o).toMatchObject({ label: 'nudge', coalesceKey: 'nudge' })
      expect(c.ops).toHaveLength(2)
    }
    // One burst, one undo step: both notes are back after a single undo.
    await press('z', { metaKey: true, code: 'KeyZ' })
    expect(session.store.getState().notes.get(nid(1))).toMatchObject({ x: 0, y: 0 })
    expect(session.store.getState().notes.get(nid(2))).toMatchObject({ x: 300, y: 0 })
    // The burst is announced once, after a pause.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(said()).toBe('Moved 2 notes')
  })

  it('a pause longer than the window starts a new undo step', async () => {
    const { session } = await open(grid3())
    act(() => runtime().selectNote(nid(1)))
    await press('ArrowRight', { altKey: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    await press('ArrowRight', { altKey: true })
    expect(session.store.getState().notes.get(nid(1))?.x).toBe(2)
    await press('z', { metaKey: true, code: 'KeyZ' })
    expect(session.store.getState().notes.get(nid(1))?.x).toBe(1)
  })
})
