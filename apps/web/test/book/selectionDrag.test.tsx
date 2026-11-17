// @vitest-environment jsdom
/**
 * A selection dragged out of the book onto the board, with a stubbed board
 * runtime: the card lands at the drop point, ⌥ at the drop moves, a release over the book or Esc
 * makes nothing; and the engine's side: the book's own native text drag never starts, and a
 * press inside the selection that travels hands the drag out.
 */
import {
  applyBatch,
  type BoardState,
  blocksOf,
  type ClientOp,
  emptyBoardState,
  posKeysBetween,
} from '@papertie/core'
import { act, cleanup } from '@testing-library/react'
import { vi } from 'vitest'
import { openLocalSession } from '../../src/app/session'
import { createEngine } from '../../src/book/editor/blockEngine'
import { startSelectionDrag } from '../../src/book/out/selectionDrag'
import { book, para } from '../helpers/books'
import { BOARD_ID, idOf, T0 } from '../helpers/fakeServer'
import { blockEl, caret } from './writerKit'

const ID = idOf('book', 9)

function stateWith(texts: readonly string[]): BoardState {
  const keys = posKeysBetween(null, null, texts.length)
  return applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [
      { op: 'book.create', book: { ...book(ID, { title: 'On paper' }), trashedAt: null } },
      ...texts.map(
        (text, i): ClientOp => ({
          op: 'block.create',
          block: {
            type: 'block',
            id: para(i + 1),
            bookId: ID,
            pos: keys[i] as string,
            kind: 'p',
            text,
            marks: [],
          },
        }),
      ),
    ],
    { now: T0 },
  )
}

const rect = (left: number, top: number, width: number, height: number) =>
  ({
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON() {},
  }) as DOMRect

const said = () => document.querySelector('[data-live-region]')?.textContent?.trim()
const pointer = (type: string, x: number, y: number, o: PointerEventInit = {}) =>
  window.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true, ...o }),
  )

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('a selection dragged out of the book', () => {
  /** The board at the window's left 600 px (its camera at world 1000, 1000, zoom 2); the book right of it. */
  function setUp(texts: readonly string[]) {
    const session = openLocalSession({ kind: 'local', state: stateWith(texts), label: 'test' })
    const root = document.createElement('div')
    const pane = document.createElement('section')
    document.body.append(root, pane)
    root.getBoundingClientRect = () => rect(0, 0, 600, 800)
    pane.getBoundingClientRect = () => rect(600, 0, 600, 800)
    const selected: Array<string | null> = []
    const board = {
      els: { root },
      toViewport: (x: number, y: number) => ({ x, y }),
      drawnCamera: () => ({ x: 1000, y: 1000, zoom: 2 }),
      selectNote: (id: string | null) => selected.push(id),
    }
    return { session, board, pane, selected }
  }

  it('dragging a selection onto the board makes the card at the drop point', () => {
    const { session, board, pane, selected } = setUp(['one', 'two'])
    const drag = startSelectionDrag({
      session,
      bookId: ID,
      range: { a: { blockId: para(1), offset: 0 }, b: { blockId: para(2), offset: 3 } },
      board,
      book: pane,
      from: { clientX: 700, clientY: 100, pointerId: 1 },
    })
    // A ghost of the card follows the pointer.
    pointer('pointermove', 300, 200)
    expect(document.querySelector('.card-ghost')).not.toBeNull()
    pointer('pointerup', 300, 200)
    const notes = [...session.store.getState().notes.values()]
    expect(notes).toHaveLength(1)
    const card = notes[0]
    if (card === undefined) throw new Error('no card')
    // Centred on the drop point's world point: (300, 200) / 2 + (1000, 1000).
    expect([card.x + card.w / 2, card.y + card.h / 2]).toEqual([1150, 1100])
    expect(card.text).toBe('one\ntwo')
    expect(selected).toEqual([card.id])
    expect(said()).toBe('Pinned to the board.')
    // The text stays in the book; the ghost is gone.
    expect(blocksOf(session.store.getState(), ID).map((b) => b.text)).toEqual(['one', 'two'])
    expect(document.querySelector('.card-ghost')).toBeNull()
    expect(drag.done()).toBe(true)
  })

  it('⌥ held at the drop moves the text out of the book', () => {
    const { session, board, pane } = setUp(['one', 'two'])
    startSelectionDrag({
      session,
      bookId: ID,
      range: { a: { blockId: para(1), offset: 1 }, b: { blockId: para(2), offset: 3 } },
      board,
      book: pane,
      from: { clientX: 700, clientY: 100, pointerId: 1 },
    })
    pointer('pointermove', 300, 200, { altKey: true })
    expect(document.querySelector('.card-ghost')?.textContent).toMatch(/Move/)
    pointer('pointerup', 300, 200, { altKey: true })
    expect(blocksOf(session.store.getState(), ID).map((b) => b.text)).toEqual(['o'])
    expect(said()).toBe('Moved to the board.')
    expect(session.undo.undo(session.store.getState())?.label).toBe('move to the board')
  })

  it('a release over the book makes nothing and leaves the text as it was', () => {
    const { session, board, pane } = setUp(['one', 'two'])
    const before = session.store.getState()
    startSelectionDrag({
      session,
      bookId: ID,
      range: { a: { blockId: para(1), offset: 0 }, b: { blockId: para(2), offset: 3 } },
      board,
      book: pane,
      from: { clientX: 700, clientY: 100, pointerId: 1 },
    })
    pointer('pointermove', 300, 200, { altKey: true })
    pointer('pointermove', 800, 200, { altKey: true })
    pointer('pointerup', 800, 200, { altKey: true })
    expect(session.store.getState()).toBe(before)
    expect(document.querySelector('.card-ghost')).toBeNull()
  })

  it('Esc during the drag makes nothing', () => {
    const { session, board, pane } = setUp(['one'])
    const before = session.store.getState()
    const drag = startSelectionDrag({
      session,
      bookId: ID,
      range: { a: { blockId: para(1), offset: 0 }, b: { blockId: para(1), offset: 3 } },
      board,
      book: pane,
      from: { clientX: 700, clientY: 100, pointerId: 1 },
    })
    pointer('pointermove', 300, 200)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    pointer('pointerup', 300, 200)
    expect(session.store.getState()).toBe(before)
    expect(drag.done()).toBe(true)
  })
})

describe('the engine and the drag', () => {
  function mount(texts: readonly string[]) {
    const host = document.createElement('div')
    document.body.append(host)
    const engine = createEngine({ windowed: false })
    engine.mount(
      host,
      texts.map((text, i) => ({ id: para(i + 1), kind: 'p' as const, text, marks: [] })),
      { newBlockId: () => para(99), onChange: () => {}, onHistory: () => {} },
    )
    return { engine, host }
  }

  it('the book’s own native drag of text never starts', () => {
    const { host } = mount(['one'])
    const e = new Event('dragstart', { bubbles: true, cancelable: true })
    blockEl(host, para(1)).dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })

  it('a mouse press inside the selection that travels hands the drag out; a press outside it is the page’s own', () => {
    const { engine, host } = mount(['one two', 'three'])
    const el = blockEl(host, para(1))
    caret(el, 0, 3)
    // The selection's box: the first 40 px of the first line.
    const had = Range.prototype.getClientRects
    Range.prototype.getClientRects = () => [rect(10, 10, 40, 20)] as unknown as DOMRectList
    const out = vi.fn()
    const off = engine.onDragOut(out)
    const down = (x: number, y: number) => {
      const e = new PointerEvent('pointerdown', {
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 1,
        pointerType: 'mouse',
        bubbles: true,
        cancelable: true,
      })
      el.dispatchEvent(e)
      const m = new MouseEvent('mousedown', {
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      })
      el.dispatchEvent(m)
      return m
    }
    // Inside: the press keeps the selection (no native selecting), then 3 px of travel hand it out.
    const m = down(20, 15)
    expect(m.defaultPrevented).toBe(true)
    act(() => {
      document.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 21, clientY: 15, pointerId: 1, bubbles: true }),
      )
    })
    expect(out).not.toHaveBeenCalled()
    act(() => {
      document.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 26, clientY: 15, pointerId: 1, bubbles: true }),
      )
    })
    expect(out).toHaveBeenCalledTimes(1)
    expect(out.mock.calls[0]?.[0]).toMatchObject({ clientX: 20, clientY: 15 })
    document.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 26, clientY: 15, bubbles: true }),
    )
    // Outside the selection: the browser's own press (a new caret or selection).
    expect(down(200, 15).defaultPrevented).toBe(false)
    document.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 200, clientY: 15, bubbles: true }),
    )
    off()
    Range.prototype.getClientRects = had
  })
})
