// @vitest-environment jsdom
/**
 * The canvas while the board opens: a slice of notes joins the board on screen
 * in O(slice), without re-rendering or re-mounting the notes already drawn, and a remembered view
 * holds until the whole board is in.
 */
import {
  type BoardState,
  emptyBoardState,
  type Note,
  type PMap,
  stateFromRecords,
  touchedNone,
} from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { openingView } from '../../src/app/opening'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { visibleWorldRect } from '../../src/canvas/Camera'
import { CanvasView } from '../../src/canvas/CanvasView'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { canvasElements, installCanvasStubs, VIEWPORT } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const renders = vi.hoisted(() => new Map<string, number>())
vi.mock('../../src/notes/NoteView', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/notes/NoteView')>()
  return {
    ...m,
    NoteView: (p: Parameters<typeof m.NoteView>[0]) => {
      renders.set(p.note.id, (renders.get(p.note.id) ?? 0) + 1)
      return m.NoteView(p)
    },
  }
})

const id = (n: number) => idOf('note', n)
const board = (notes: Note[]) => stateFromRecords(emptyBoardState(BOARD_ID, 'b', T0).board, notes)

/**
 * A note map that can be read by key but never walked: whatever walks it while a slice joins
 * does work that grows with the board.
 */
class Unwalkable implements ReadonlyMap<string, Note> {
  constructor(private readonly m: PMap<string, Note>) {}
  get size() {
    return this.m.size
  }
  get(k: string) {
    return this.m.get(k)
  }
  has(k: string) {
    return this.m.has(k)
  }
  private walked(): never {
    throw new Error('the whole note map was walked for a slice')
  }
  forEach(): void {
    this.walked()
  }
  entries(): MapIterator<[string, Note]> {
    return this.walked()
  }
  keys(): MapIterator<string> {
    return this.walked()
  }
  values(): MapIterator<Note> {
    return this.walked()
  }
  [Symbol.iterator](): MapIterator<[string, Note]> {
    return this.walked()
  }
}

/** A server-board session on a local store, still opening at `camera`. */
function opening(state: BoardState, camera = { x: 0, y: 0, zoom: 1 }) {
  const local = openLocalSession({ kind: 'local', state, label: 'test' })
  const view = openingView()
  const session: BoardSession = { ...local, boardId: BOARD_ID, opening: view, camera }
  return { session, view }
}

let restore: () => void = () => {}
beforeEach(() => {
  vi.useFakeTimers()
  restore = installCanvasStubs()
  renders.clear()
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  restore()
  vi.useRealTimers()
})

describe('the canvas while the board opens', () => {
  it('a slice joins without re-rendering or re-mounting the notes already drawn', async () => {
    const drawn = [note(id(1), { x: 100 }), note(id(2), { x: 500 })]
    const { session } = opening(board(drawn))
    render(createElement(CanvasView, { session }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    const el = (n: string) => document.querySelector(`article[data-note-id="${n}"]`)
    const before = { one: el(id(1)), two: el(id(2)), renders: new Map(renders) }
    expect(before.one).toBeTruthy()

    // A slice of the board's copy: two notes, one in view. The board shown is never walked.
    const cur = session.store.getState()
    const t = (cur.notes as PMap<string, Note>).asTransient()
    t.set(id(3), note(id(3), { x: 800 }))
    t.set(id(4), note(id(4), { x: 90_000 }))
    const next = { ...cur, notes: new Unwalkable(t.persist()) }
    await act(async () => {
      session.store.replace(next, { ...touchedNone(), notes: new Set([id(3), id(4)]) })
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(el(id(3))).toBeTruthy()
    expect(el(id(4))).toBeNull() // not in view
    expect(el(id(1))).toBe(before.one)
    expect(el(id(2))).toBe(before.two)
    expect(renders.get(id(1))).toBe(before.renders.get(id(1)))
    expect(renders.get(id(2))).toBe(before.renders.get(id(2)))
    expect(renders.get(id(3))).toBe(1)
  })

  it('keeps the remembered view while it opens; once in, a blank view fits the notes', () => {
    const els = canvasElements()
    const blank = { x: 40_000, y: 40_000, zoom: 1 }
    const { session } = opening(board([note(id(1), { x: 100 })]), blank)
    const rt = new CanvasRuntime(els, session.store, null, null, blank, true)
    try {
      expect(rt.camera.get()).toEqual(blank)
      rt.opened()
      expect(rt.camera.get()).not.toEqual(blank)
      const v = visibleWorldRect(rt.camera.get(), VIEWPORT)
      expect(v.x < 100 && v.x + v.w > 100 && v.y < 0 && v.y + v.h > 0).toBe(true)
    } finally {
      rt.dispose()
    }
  })

  it('a view the user has moved since the first paint stays where they took it', () => {
    const els = canvasElements()
    const blank = { x: 40_000, y: 40_000, zoom: 1 }
    const moved = { x: 41_000, y: 40_000, zoom: 1 }
    const { session } = opening(board([note(id(1), { x: 100 })]), blank)
    const rt = new CanvasRuntime(els, session.store, null, null, blank, true)
    try {
      rt.camera.set(moved)
      rt.opened()
      expect(rt.camera.get()).toEqual(moved)
    } finally {
      rt.dispose()
    }
  })

  it('the empty-board hint waits for the whole board', async () => {
    const { session, view } = opening(board([]))
    render(createElement(CanvasView, { session }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(document.querySelector('[data-testid="empty-hint"]')).toBeNull()
    await act(async () => view.end())
    expect(document.querySelector('[data-testid="empty-hint"]')).toBeTruthy()
  })
})
