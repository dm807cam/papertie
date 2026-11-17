// @vitest-environment jsdom
/**
 * When the board is not the writer's to drive (`CanvasRuntime.held`): under a screen over it (an
 * inert ancestor) or a sheet (`data-covered`). A part of the board folded away inert (the empty
 * selection group, a closed picker sheet) does not hold it, and ⌘K follows the same rule.
 */
import { emptyBoardState, stateFromRecords } from '@papertie/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { openLocalSession } from '../../src/app/session'
import { CanvasView } from '../../src/canvas/CanvasView'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { closeSearch } from '../../src/search/searchStore'
import { createBoardStore } from '../../src/store/boardStore'
import { canvasElements, installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const board = () =>
  stateFromRecords(emptyBoardState(BOARD_ID, 'b', T0).board, [note(idOf('note', 1), { x: 100 })])

let restore: () => void = () => {}
beforeEach(() => {
  restore = installCanvasStubs()
})
afterEach(() => {
  act(() => closeSearch())
  cleanup()
  document.body.replaceChildren()
  restore()
})

describe('CanvasRuntime.held', () => {
  it('is true under an inert ancestor or a sheet, never for an inert part of the board', () => {
    const els = canvasElements()
    const rt = new CanvasRuntime(els, createBoardStore(board()), null, null, null, false)
    try {
      expect(rt.held).toBe(false)
      // A part of the board folded away (an empty selection group in the UI layer).
      const folded = document.createElement('div')
      folded.setAttribute('inert', '')
      els.root.append(folded)
      expect(rt.held).toBe(false)
      // A screen over the board: the board's stage is inert.
      const stage = document.createElement('div')
      document.body.append(stage)
      stage.append(els.root)
      stage.setAttribute('inert', '')
      expect(rt.held).toBe(true)
      stage.removeAttribute('inert')
      expect(rt.held).toBe(false)
      // A sheet (Settings) over it.
      els.root.setAttribute('data-covered', '')
      expect(rt.held).toBe(true)
    } finally {
      rt.dispose()
    }
  })
})

describe('⌘K on the canvas', () => {
  const cmdK = () => fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
  const mount = (covered: boolean) => {
    const session = openLocalSession({ kind: 'local', state: board(), label: 'test' })
    return render(createElement(CanvasView, { session, covered }))
  }

  it('opens search on the board, with nothing selected', () => {
    mount(false)
    expect(document.querySelector('[inert]')).not.toBeNull() // the folded selection group
    act(() => void cmdK())
    expect(screen.getByRole('dialog', { name: 'Search notes' })).toBeTruthy()
  })

  it('does nothing under Settings', () => {
    mount(true)
    act(() => void cmdK())
    expect(screen.queryByRole('dialog', { name: 'Search notes' })).toBeNull()
  })
})

describe('the board’s keys beside a book (the split view)', () => {
  it('the runtime takes only keys from the page itself or from inside the board', () => {
    const els = canvasElements()
    const store = createBoardStore(
      stateFromRecords(emptyBoardState(BOARD_ID, 'b', T0).board, [
        note(idOf('note', 1), { x: 100 }),
        note(idOf('note', 2), { x: 400 }),
      ]),
    )
    const rt = new CanvasRuntime(els, store, null, null, null, false)
    const pane = document.createElement('div')
    pane.className = 'book-pane'
    // A control of the book's (its Board button, say): no text field, which the board leaves be.
    const field = document.createElement('button')
    pane.append(field)
    document.body.append(pane)
    try {
      rt.selectNotes([idOf('note', 1), idOf('note', 2)], 'replace')
      const key = (target: EventTarget, init: KeyboardEventInit) =>
        act(
          () =>
            void target.dispatchEvent(
              new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
            ),
        )
      // From the book's pane: nothing the board does.
      key(field, { key: 'Delete' })
      key(field, { key: 'Backspace' })
      expect(store.getState().notes.size).toBe(2)
      key(field, { key: 'ArrowRight' })
      expect([...rt.selection].sort()).toEqual([idOf('note', 1), idOf('note', 2)])
      // From the page itself: the board's, as before.
      key(document.body, { key: 'Delete' })
      expect(store.getState().notes.size).toBe(0)
    } finally {
      rt.dispose()
    }
  })

  it('⌘K in the book’s pane is the writer’s; in the board pane it still opens the board’s search', () => {
    const session = openLocalSession({ kind: 'local', state: board(), label: 'test' })
    render(createElement(CanvasView, { session }))
    const pane = document.createElement('div')
    pane.className = 'book-pane'
    const field = document.createElement('input')
    pane.append(field)
    document.body.append(pane)
    act(() => {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true }),
      )
    })
    expect(screen.queryByRole('dialog', { name: 'Search notes' })).toBeNull()
    const inBoard = document.querySelector('.viewport') as HTMLElement
    act(() => {
      inBoard.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true }),
      )
    })
    expect(screen.getByRole('dialog', { name: 'Search notes' })).toBeTruthy()
  })
})
