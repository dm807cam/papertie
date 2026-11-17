// @vitest-environment jsdom
/**
 * What a dropped card becomes: the text lands at once in the likely
 * form, a small chooser beside it switches it (1 · 2 · 3, or a tap) in one undo step of its own,
 * and anything else the writer does puts the chooser away without losing a key.
 */
import {
  applyBatch,
  type BoardState,
  blocksOf,
  type ClientOp,
  emptyBoardState,
  posKeysBetween,
} from '@papertie/core'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { prefsStore } from '../../src/app/prefs'
import { type BoardSession, openLocalSession, stepHistory } from '../../src/app/session'
import { BookScreen } from '../../src/book/BookScreen'
import { DROP_FORMS_KEY } from '../../src/book/drop/dropForms'
import type { SeamDrop } from '../../src/canvas/seamDrop'
import { attachBooks } from '../../src/sync/books/bookStore'
import { book, para } from '../helpers/books'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'
import { blockEl, caret, caretOffset, startDeadKey, type } from './writerKit'

const ID = idOf('book', 9)
const CARD = idOf('note', 1)
/** A card with a ref. */
const QUOTED = idOf('note', 3)
const REF = 'Thoreau, Walden, 1854, p. 92'

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
      { op: 'note.create', note: note(CARD, { text: 'A card' }) },
      { op: 'note.create', note: note(QUOTED, { text: 'Simplify.', y: 300, ref: REF }) },
    ],
    { now: T0 },
  )
}

interface Open {
  session: BoardSession
  seam: SeamDrop
  page: HTMLElement
  labels: string[]
}

function open(texts = ['one', 'two']): Open {
  const session = openLocalSession({ kind: 'local', state: stateWith(texts), label: 'test' })
  attachBooks(session.store)
  const labels: string[] = []
  session.store.onCommit((_b, _ops, c) => labels.push(c.label ?? ''))
  let seam: SeamDrop | null = null
  const runtime = {
    setSeamDrop: (t: SeamDrop | null) => {
      seam = t
    },
  }
  render(<BookScreen session={session} bookId={ID} layout="split" runtime={runtime} />)
  return {
    session,
    seam: seam as unknown as SeamDrop,
    page: document.querySelector('.bk-book') as HTMLElement,
    labels,
  }
}

/** The card dropped (jsdom lays nothing out: after the last block). */
const drop = (o: Open, alt = false) => act(() => void o.seam.drop(700, 300, [CARD], alt))
const chooser = () => screen.queryByRole('radiogroup', { name: 'Add as' })
const kinds = (s: BoardSession) => blocksOf(s.store.getState(), ID).map((b) => [b.kind, b.text])
/** A key pressed where the keyboard is: whether it went on (not taken). */
function key(k: string, o: KeyboardEventInit = {}): boolean {
  let on = true
  act(() => {
    const t = document.activeElement ?? document.body
    on = t.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }),
    )
  })
  return on
}

beforeEach(() => {
  localStorage.clear()
  // A fade is at once under reduced motion.
  prefsStore.setState({ motion: 'reduced' })
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  prefsStore.setState({ motion: 'system' })
})

describe('the drop-form chooser', () => {
  it('a drop lands at once in the likely form, with the chooser beside it', () => {
    localStorage.setItem(DROP_FORMS_KEY, JSON.stringify({ quote: 3, p: 1 }))
    const o = open()
    const el = blockEl(o.page, para(1))
    caret(el, 2)
    drop(o)
    // At once, in the likely form; the caret where it was.
    expect(kinds(o.session)).toEqual([
      ['p', 'one'],
      ['p', 'two'],
      ['quote', 'A card'],
    ])
    expect(caretOffset(el)).toBe(2)
    const group = chooser() as HTMLElement
    expect(group).not.toBeNull()
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['1Paragraph', '2Quote', '3Prompt'])
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    // Beside the new text's first block.
    const made = blocksOf(o.session.store.getState(), ID)[2]?.id
    expect(group.dataset.block).toBe(made)
    // Its forms are buttons, so a tap switches too.
    fireEvent.click(radios[2] as HTMLElement)
    expect(kinds(o.session)[2]).toEqual(['prompt', 'A card'])
    // A figure never asks.
  })

  it('2 switches to a quote in place; undo undoes the switch, then the drop', () => {
    const o = open()
    caret(blockEl(o.page, para(1)), 1)
    drop(o)
    expect(kinds(o.session)[2]).toEqual(['p', 'A card'])
    expect(key('2')).toBe(false)
    expect(kinds(o.session)[2]).toEqual(['quote', 'A card'])
    expect(o.labels.slice(-2)).toEqual(['add to the book', 'change to a quote'])
    // The pin stays: the mark is on the text.
    const b = blocksOf(o.session.store.getState(), ID)[2]
    expect(b?.marks).toEqual([{ t: `c:${CARD}`, from: 0, to: 6 }])
    // Still shown, the new form marked; the switch counted.
    const radios = within(chooser() as HTMLElement).getAllByRole('radio')
    expect(radios[1]?.getAttribute('aria-checked')).toBe('true')
    expect(JSON.parse(localStorage.getItem(DROP_FORMS_KEY) ?? '{}')).toEqual({ quote: 1 })
    act(() => stepHistory(o.session, 'undo'))
    expect(kinds(o.session)).toEqual([
      ['p', 'one'],
      ['p', 'two'],
      ['p', 'A card'],
    ])
    act(() => stepHistory(o.session, 'undo'))
    expect(kinds(o.session)).toEqual([
      ['p', 'one'],
      ['p', 'two'],
    ])
  })

  it('typing, a click elsewhere or a new drag fades the chooser; the key typed goes into the page', () => {
    const o = open()
    const el = blockEl(o.page, para(1))
    caret(el, 3)
    drop(o)
    expect(chooser()).not.toBeNull()
    type('x')
    expect(chooser()).toBeNull()
    expect(el.textContent).toBe('onex')
    // Keeping the default by typing on counts it.
    expect(JSON.parse(localStorage.getItem(DROP_FORMS_KEY) ?? '{}')).toEqual({ p: 1 })
    // A press elsewhere.
    drop(o)
    expect(chooser()).not.toBeNull()
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(chooser()).toBeNull()
    // A new drag reaching the page.
    drop(o)
    expect(chooser()).not.toBeNull()
    act(() => o.seam.hover(700, 300, [CARD], false))
    expect(chooser()).toBeNull()
    act(() => o.seam.leave())
    // Esc: the chooser's, not the page's (the writer stays open).
    drop(o)
    expect(key('Escape')).toBe(false)
    expect(chooser()).toBeNull()
    expect(document.querySelector('.book-pane')).not.toBeNull()
    expect(location.pathname).not.toBe('/shelf')
    // With no chooser, 1–3 are plain keys again.
    type('2')
    expect(el.textContent).toBe('onex2')
  })

  it('1–3 during a dead-key composition are not taken', () => {
    const o = open(['cafe'])
    const el = blockEl(o.page, para(1))
    caret(el, 4)
    drop(o)
    const finish = startDeadKey('´')
    expect(key('2', { isComposing: true })).toBe(true)
    expect(key('3', { keyCode: 229 })).toBe(true)
    expect(kinds(o.session)[1]).toEqual(['p', 'A card'])
    finish('é')
    expect(blocksOf(o.session.store.getState(), ID)[0]?.text).toBe('cafeé')
  })

  it('a move says so and the chooser follows it', () => {
    const o = open()
    drop(o, true)
    expect(o.session.store.getState().notes.has(CARD)).toBe(false)
    expect(chooser()).not.toBeNull()
    expect(key('3')).toBe(false)
    expect(kinds(o.session)[2]).toEqual(['prompt', 'A card'])
    // Undo: the switch, then the move (the card back on the board).
    act(() => stepHistory(o.session, 'undo'))
    act(() => stepHistory(o.session, 'undo'))
    expect(o.session.store.getState().notes.has(CARD)).toBe(true)
    expect(kinds(o.session)).toHaveLength(2)
  })

  it('switching the form keeps the footnote', () => {
    // A card with a ref lands as a quote whatever the likely form.
    localStorage.setItem(DROP_FORMS_KEY, JSON.stringify({ prompt: 5 }))
    const o = open()
    act(() => void o.seam.drop(700, 300, [QUOTED], false))
    expect(kinds(o.session)).toEqual([
      ['p', 'one'],
      ['p', 'two'],
      ['quote', 'Simplify.'],
      ['footnote', REF],
    ])
    const radios = within(chooser() as HTMLElement).getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(key('1')).toBe(false)
    expect(kinds(o.session).slice(2)).toEqual([
      ['p', 'Simplify.'],
      ['footnote', REF],
    ])
    const [quote, fn] = blocksOf(o.session.store.getState(), ID).slice(2)
    expect(quote?.marks).toContainEqual({ t: `n:${fn?.id}`, from: 0, to: 9 })
  })

  it('one undo removes the quote and its footnote', () => {
    const o = open()
    act(() => void o.seam.drop(700, 300, [QUOTED], false))
    expect(kinds(o.session)).toHaveLength(4)
    expect(o.labels.at(-1)).toBe('add to the book')
    act(() => stepHistory(o.session, 'undo'))
    expect(kinds(o.session)).toEqual([
      ['p', 'one'],
      ['p', 'two'],
    ])
  })

  it('likelyForm counts only drops of cards without a ref', () => {
    const o = open()
    const el = blockEl(o.page, para(1))
    caret(el, 3)
    act(() => void o.seam.drop(700, 300, [QUOTED], false))
    // Typing on, or a switch: neither is counted for a ref'd card's drop.
    expect(key('3')).toBe(false)
    type('x')
    expect(localStorage.getItem(DROP_FORMS_KEY)).toBeNull()
    act(() => void o.seam.drop(700, 300, [QUOTED], false))
    type('y')
    expect(localStorage.getItem(DROP_FORMS_KEY)).toBeNull()
    // A plain card's drop is.
    drop(o)
    type('z')
    expect(JSON.parse(localStorage.getItem(DROP_FORMS_KEY) ?? '{}')).toEqual({ p: 1 })
  })
})
