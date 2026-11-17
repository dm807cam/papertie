// @vitest-environment jsdom
/**
 * The pins in the book's left margin, drawn from the window's blocks: the
 * peek shows the card (drawn by `NoteView`), a click shows it on the board, "Remove pin" is one
 * step, and a deleted card's pin is faded until the card is back.
 */
import {
  applyBatch,
  type BoardState,
  blocksOf,
  type ClientOp,
  cardMarkT,
  emptyBoardState,
  posKeysBetween,
} from '@papertie/core'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { vi } from 'vitest'
import { openLocalSession } from '../../src/app/session'
import type { LiveBlock } from '../../src/book/editor/pageWindow'
import { PinLayer } from '../../src/book/pins/PinLayer'
import { book, para } from '../helpers/books'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const ID = idOf('book', 9)
const CARD = idOf('note', 1)
/** A frame passed (the pins' read of a card deleted or put back waits for one). */
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))

function stateWith(): BoardState {
  const keys = posKeysBetween(null, null, 2)
  return applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [
      { op: 'book.create', book: { ...book(ID, { title: 'On paper' }), trashedAt: null } },
      { op: 'note.create', note: note(CARD, { text: 'Lantern festival\n\nBy the river' }) },
      ...['Lantern festival', 'plain'].map(
        (text, i): ClientOp => ({
          op: 'block.create',
          block: {
            type: 'block',
            id: para(i + 1),
            bookId: ID,
            pos: keys[i] as string,
            kind: 'p',
            text,
            marks: i === 0 ? [{ t: cardMarkT(CARD), from: 0, to: text.length }] : [],
          },
        }),
      ),
    ],
    { now: T0 },
  )
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function setUp(layout: 'split' | 'full' = 'split') {
  const session = openLocalSession({ kind: 'local', state: stateWith(), label: 'test' })
  const live: LiveBlock[] = [
    { id: para(1), kind: 'p', top: 0, height: 40 },
    { id: para(2), kind: 'p', top: 50, height: 40 },
  ]
  const laid = new Set<() => void>()
  const reads = { n: 0 }
  const engine = {
    liveBlocks: () => {
      reads.n++
      return live
    },
    onLayout: (fn: () => void) => {
      laid.add(fn)
      return () => laid.delete(fn)
    },
  }
  const page = document.createElement('div')
  document.body.append(page)
  const runtime = {
    setSeamDrop: () => {},
    els: { root: document.createElement('main') },
    toViewport: (x: number, y: number) => ({ x, y }),
    drawnCamera: () => ({ x: 0, y: 0, zoom: 1 }),
    placeNear: () => ({ x: 0, y: 0 }),
    selectNote: vi.fn(),
    focusNote: vi.fn(() => true),
  }
  render(
    <PinLayer
      session={session}
      bookId={ID}
      engine={engine}
      page={() => page}
      layout={layout}
      runtime={runtime}
    />,
  )
  return { session, runtime, laid, live, reads }
}

describe('the pins', () => {
  it('a pin’s peek shows the card; clicking the pin selects the card on the board and centres it', () => {
    const { runtime } = setUp()
    const pin = screen.getByRole('button', { name: 'From a card: Lantern festival' })
    // One pin: the plain paragraph has none.
    expect(document.querySelectorAll('.bk-pin')).toHaveLength(1)
    fireEvent.pointerEnter(pin, { pointerType: 'mouse' })
    const peek = document.querySelector('.card-peek')
    expect(peek?.querySelector('article.note')?.textContent).toContain('Lantern festival')
    // Drawn by NoteView, not editable.
    expect(peek?.querySelector('[contenteditable]')).toBeNull()
    fireEvent.click(pin)
    expect(runtime.focusNote).toHaveBeenCalledWith(CARD, 1)
    expect(runtime.selectNote).toHaveBeenCalledWith(CARD)
  })

  it('Remove pin takes the mark off and one undo puts it back', () => {
    const { session, laid } = setUp()
    const laidOut = () =>
      act(() => {
        for (const fn of laid) fn()
      })
    const pin = screen.getByRole('button', { name: 'From a card: Lantern festival' })
    fireEvent.focus(pin)
    fireEvent.click(screen.getByRole('button', { name: 'Remove pin' }))
    const marks = () => blocksOf(session.store.getState(), ID)[0]?.marks
    expect(marks()).toEqual([])
    // The engine lays the page out after a block change and tells `onLayout` (once a frame).
    laidOut()
    expect(document.querySelectorAll('.bk-pin')).toHaveLength(0)
    const r = session.undo.undo(session.store.getState())
    expect(r?.label).toBe('remove pin')
    if (r) act(() => session.store.commit(r.ops, { undo: 'skip' }))
    laidOut()
    expect(marks()).toEqual([{ t: cardMarkT(CARD), from: 0, to: 16 }])
    expect(document.querySelectorAll('.bk-pin')).toHaveLength(1)
  })

  it('a deleted card’s pin is faded and comes back when the card is undeleted', async () => {
    const { session } = setUp()
    act(() => session.store.commit([{ op: 'note.delete', id: CARD }], { label: 'delete' }))
    await act(frame)
    const pin = screen.getByRole('button', { name: 'From a deleted card' })
    expect(pin.dataset.faded).toBe('')
    fireEvent.focus(pin)
    expect(document.querySelector('.card-peek')?.textContent).toContain('This card was deleted.')
    expect(screen.getByRole('button', { name: 'Remove pin' })).toBeTruthy()
    const r = session.undo.undo(session.store.getState())
    if (r) act(() => session.store.commit(r.ops, { undo: 'skip' }))
    await act(frame)
    const back = screen.getByRole('button', { name: 'From a card: Lantern festival' })
    expect(back.dataset.faded).toBeUndefined()
  })

  it('a keystroke reads no layout: block changes wait for the engine’s onLayout', async () => {
    const { session, reads } = setUp()
    const before = reads.n
    act(() => {
      for (let n = 0; n < 5; n++) {
        session.store.commit(
          [
            {
              op: 'block.edit',
              bookId: ID,
              id: para(2),
              splices: [{ at: 0, del: 0, ins: `${n}` }],
            },
          ],
          { label: 'typing' },
        )
      }
    })
    await act(frame)
    expect(reads.n).toBe(before)
    // A card deleted is read once, a frame on, however many changes came.
    act(() => {
      session.store.commit([{ op: 'note.delete', id: CARD }], { label: 'delete' })
      session.store.commit([{ op: 'note.create', note: note(idOf('note', 2), { x: 400 }) }], {
        label: 'new',
      })
    })
    expect(reads.n).toBe(before)
    await act(frame)
    expect(reads.n).toBe(before + 1)
  })

  it('pins follow the page’s layout: a block that moves takes its pin with it', () => {
    const { laid, live } = setUp()
    const pin = () => document.querySelector<HTMLElement>('.bk-pin')
    expect(pin()?.style.top).toBe('0px')
    // The page laid out anew (`onLayout`): the block is 30 px lower.
    live[0] = { id: para(1), kind: 'p', top: 30, height: 40 }
    act(() => {
      for (const fn of laid) fn()
    })
    expect(pin()?.style.top).toBe('30px')
  })
})

describe('the peek of a card with a ref', () => {
  it('the peek offers the card’s own ref, and a pick is its footnote in one commit', () => {
    const ref = 'Thoreau, Walden, p. 7'
    const session = openLocalSession({
      kind: 'local',
      state: applyBatch(stateWith(), [{ op: 'note.update', id: CARD, set: { ref } }], {
        now: T0,
      }),
      label: 'test',
    })
    const labels: string[] = []
    session.store.onCommit((_b, _o, c) => labels.push(c.label ?? ''))
    const engine = {
      liveBlocks: (): LiveBlock[] => [{ id: para(1), kind: 'p', top: 0, height: 40 }],
      onLayout: () => () => {},
    }
    render(
      <PinLayer
        session={session}
        bookId={ID}
        engine={engine}
        page={() => document.body}
        layout="split"
        runtime={null}
      />,
    )
    fireEvent.focus(screen.getByRole('button', { name: 'From a card: Lantern festival' }))
    const offer = screen.getByRole('group', { name: 'Add footnote from' })
    expect([...offer.querySelectorAll('button')].map((b) => b.textContent)).toEqual([ref])
    fireEvent.click(within(offer).getByRole('button', { name: ref }))
    const blocks = blocksOf(session.store.getState(), ID)
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ['p', 'Lantern festival'],
      ['footnote', ref],
      ['p', 'plain'],
    ])
    expect(blocks[0]?.marks).toContainEqual({ t: `n:${blocks[1]?.id}`, from: 0, to: 16 })
    // One commit, one undo step.
    expect(labels).toEqual(['add a footnote'])
  })

  it('a card with no ref offers none', () => {
    const session = openLocalSession({ kind: 'local', state: stateWith(), label: 'test' })
    const engine = {
      liveBlocks: (): LiveBlock[] => [{ id: para(1), kind: 'p', top: 0, height: 40 }],
      onLayout: () => () => {},
    }
    render(
      <PinLayer
        session={session}
        bookId={ID}
        engine={engine}
        page={() => document.body}
        layout="split"
        runtime={null}
      />,
    )
    fireEvent.focus(screen.getByRole('button', { name: 'From a card: Lantern festival' }))
    expect(screen.queryByRole('group', { name: 'Add footnote from' })).toBeNull()
  })
})
