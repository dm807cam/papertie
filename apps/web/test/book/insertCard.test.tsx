// @vitest-environment jsdom
/**
 * ⌘K in the book: the board's picker finds a card and puts it after the
 * caret's paragraph, as a copy (Enter) or a move (Alt+Enter), then the drop's chooser follows.
 */
import {
  applyBatch,
  type BoardState,
  blocksOf,
  type ClientOp,
  emptyBoardState,
  posKeysBetween,
} from '@papertie/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { prefsStore } from '../../src/app/prefs'
import { type BoardSession, openLocalSession, stepHistory } from '../../src/app/session'
import { BookScreen } from '../../src/book/BookScreen'
import { releaseSearchIndex, searchIndexFor } from '../../src/search/searchIndex'
import { attachBooks } from '../../src/sync/books/bookStore'
import { book, para } from '../helpers/books'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'
import { blockEl, caret, caretOffset } from './writerKit'

const ID = idOf('book', 9)
const CARD = idOf('note', 1)
const OTHER = idOf('note', 2)

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
      { op: 'note.create', note: note(CARD, { text: 'Lantern festival' }) },
      { op: 'note.create', note: note(OTHER, { text: 'Something else', y: 400 }) },
    ],
    { now: T0 },
  )
}

let session: BoardSession | null = null

function open(): { session: BoardSession; page: HTMLElement } {
  const s = openLocalSession({ kind: 'local', state: stateWith(['one', 'two']), label: 'test' })
  session = s
  attachBooks(s.store)
  render(<BookScreen session={s} bookId={ID} layout="split" runtime={{ setSeamDrop() {} }} />)
  return { session: s, page: document.querySelector('.bk-book') as HTMLElement }
}

/** Every answer the index owes has come and been shown, and the picker's chunk is in. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      if (session) await searchIndexFor(session.store).query('', 1)
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

const picker = () => screen.queryByRole('dialog', { name: 'Insert a card' })
const field = () => screen.getByRole('combobox') as HTMLInputElement
const texts = (s: BoardSession) => blocksOf(s.store.getState(), ID).map((b) => b.text)

async function find(text: string): Promise<void> {
  fireEvent.change(field(), { target: { value: text } })
  await settle()
  expect(screen.getAllByRole('option')[0]?.textContent).toContain(text)
}

beforeEach(() => prefsStore.setState({ motion: 'reduced' }))
afterEach(() => {
  cleanup()
  if (session) releaseSearchIndex(session.store)
  session = null
  prefsStore.setState({ motion: 'system' })
})

describe('Insert card', () => {
  it('⌘K inserts a found card at the caret as a copy; Alt+Enter moves it in one undo step', async () => {
    const o = open()
    const el = blockEl(o.page, para(1))
    caret(el, 1)
    act(() => {
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          code: 'KeyK',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    await settle()
    expect(picker()).not.toBeNull()
    expect(field().placeholder).toBe('Find a card')
    await find('Lantern')
    fireEvent.keyDown(field(), { key: 'Enter' })
    await settle()
    expect(picker()).toBeNull()
    // After the caret's paragraph, the card's mark over it; the caret after what came in.
    expect(texts(o.session)).toEqual(['one', 'Lantern festival', 'two'])
    const made = blocksOf(o.session.store.getState(), ID)[1]
    expect(made?.marks).toEqual([{ t: `c:${CARD}`, from: 0, to: 16 }])
    expect(o.session.store.getState().notes.has(CARD)).toBe(true)
    const inserted = blockEl(o.page, made?.id)
    expect(caretOffset(inserted)).toBe(16)
    // The drop's chooser follows; said as a drop is.
    expect(screen.queryByRole('radiogroup', { name: 'Add as' })).not.toBeNull()
    expect(document.querySelector('[data-live-region]')?.textContent?.trim()).toBe(
      'Added to “On paper” as a paragraph.',
    )

    // Alt+Enter: a move, after the caret's paragraph (the one just inserted).
    act(() => {
      inserted.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          code: 'KeyK',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    await settle()
    await find('Something')
    fireEvent.keyDown(field(), { key: 'Enter', altKey: true })
    await settle()
    expect(texts(o.session)).toEqual(['one', 'Lantern festival', 'Something else', 'two'])
    expect(o.session.store.getState().notes.has(OTHER)).toBe(false)
    expect(document.querySelector('[data-live-region]')?.textContent?.trim()).toBe(
      'Moved into “On paper” as a paragraph.',
    )
    // One undo: the card is back on the board and its text out of the book.
    act(() => stepHistory(o.session, 'undo'))
    expect(o.session.store.getState().notes.has(OTHER)).toBe(true)
    expect(texts(o.session)).toEqual(['one', 'Lantern festival', 'two'])
  })

  it('the picker shows its copy and its move as controls: Move into the book moves the card', async () => {
    const o = open()
    caret(blockEl(o.page, para(1)), 1)
    fireEvent.click(screen.getByRole('button', { name: 'Insert card' }))
    await settle()
    const copy = screen.getByRole('button', { name: 'Copy into the book' })
    const move = screen.getByRole('button', { name: 'Move into the book' })
    expect(copy.getAttribute('aria-keyshortcuts')).toBe('Enter')
    expect(move.getAttribute('aria-keyshortcuts')).toBe('Alt+Enter')
    await find('Something')
    fireEvent.click(move)
    await settle()
    expect(picker()).toBeNull()
    expect(texts(o.session)).toContain('Something else')
    expect(o.session.store.getState().notes.has(OTHER)).toBe(false)
  })

  it('Insert card in the top band opens the same picker', async () => {
    open()
    const button = screen.getByRole('button', { name: 'Insert card' })
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Meta+K Control+K')
    fireEvent.click(button)
    await settle()
    expect(picker()).not.toBeNull()
    // Esc closes it, and the book stays open.
    fireEvent.keyDown(field(), { key: 'Escape' })
    await settle()
    expect(picker()).toBeNull()
    expect(document.querySelector('.book-pane')).not.toBeNull()
  })

  it('with no caret in the book, it inserts after the block at the view’s top', async () => {
    const o = open()
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.click(screen.getByRole('button', { name: 'Insert card' }))
    await settle()
    await find('Lantern')
    fireEvent.keyDown(field(), { key: 'Enter' })
    await settle()
    // jsdom lays nothing out: the first block is at the view's top.
    expect(texts(o.session)).toEqual(['one', 'Lantern festival', 'two'])
  })
})
