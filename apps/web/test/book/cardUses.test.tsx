// @vitest-environment jsdom
/**
 * The reverse view: a card's ink mark opens "Used in" with each shelf book
 * naming it, and "From" with the book it came from; each title opens its book at the place: the
 * first block naming the card (one sliced scan of the held book), or the card's own block.
 */
import {
  applyBatch,
  type BoardState,
  type ClientOp,
  cardMarkT,
  emptyBoardState,
  posKeysBetween,
} from '@papertie/core'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { showUses, usesShown } from '../../src/app/prefetchBooks'
import { recallPlace } from '../../src/app/screenMemory'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { BookScreen } from '../../src/book/BookScreen'
import { CardUses } from '../../src/book/uses/CardUses'
import { NoteView } from '../../src/notes/NoteView'
import { attachBooks } from '../../src/sync/books/bookStore'
import { cardUsesFor } from '../../src/sync/books/cardUses'
import { book, para } from '../helpers/books'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'
import { caret } from './writerKit'

const USES = idOf('book', 1)
const ORIGIN = idOf('book', 2)
const GONE = idOf('book', 3)
const CARD = idOf('note', 1)

/** Two shelf books naming the card (one of them deleted), and the book it came from. */
function stateWith(): BoardState {
  const keys = posKeysBetween(null, null, 3)
  const blocks = (bookId: string, first: number, texts: string[], marked: number | null) =>
    texts.map(
      (text, i): ClientOp => ({
        op: 'block.create',
        block: {
          type: 'block',
          id: para(first + i),
          bookId,
          pos: keys[i] as string,
          kind: 'p',
          text,
          marks: i === marked ? [{ t: cardMarkT(CARD), from: 0, to: text.length }] : [],
        },
      }),
    )
  return applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [
      {
        op: 'book.create',
        book: {
          ...book(USES, { title: 'River notes', shelfPos: 'V' }),
          trashedAt: null,
        },
      },
      {
        op: 'book.create',
        book: { ...book(ORIGIN, { title: 'Where it began', shelfPos: 'W' }), trashedAt: null },
      },
      {
        op: 'book.create',
        book: {
          ...book(GONE, { title: 'Deleted book', shelfPos: 'X' }),
          trashedAt: null,
        },
      },
      ...blocks(USES, 1, ['one', 'two', 'Lantern'], 2),
      ...blocks(ORIGIN, 11, ['first', 'the card came from here', 'last'], null),
      ...blocks(GONE, 21, ['Lantern'], 0),
      // The server's stamps of the books' cards (a client's book.create never carries them).
      { op: 'book.cards', id: USES, add: [CARD] } as unknown as ClientOp,
      { op: 'book.cards', id: GONE, add: [CARD] } as unknown as ClientOp,
      {
        op: 'note.create',
        note: note(CARD, {
          text: 'Lantern',
          from: { book: ORIGIN, block: para(12) },
        }),
      },
      // One of the books naming it deleted since.
      { op: 'book.update', id: GONE, set: { trashedAt: T0 } },
    ],
    { now: T0 },
  )
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  history.replaceState(null, '', '/')
})

function open(): { session: BoardSession; closed: number[] } {
  const local = openLocalSession({ kind: 'local', state: stateWith(), label: 'test' })
  // A board of its own, so places in its books are kept.
  const session = { ...local, boardId: BOARD_ID } as BoardSession
  const anchor = document.createElement('button')
  document.body.append(anchor)
  const closed: number[] = []
  render(
    <CardUses session={session} noteId={CARD} anchor={anchor} onClose={() => closed.push(1)} />,
  )
  return { session, closed }
}

describe('the reverse view', () => {
  it('the reverse mark lists the shelf books using the card and the book it came from; each opens the book at the place', async () => {
    open()
    const used = screen.getByRole('group', { name: 'Used in' })
    expect(
      within(used)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['River notes'])
    const from = screen.getByRole('group', { name: 'From' })
    expect(
      within(from)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Where it began'])
    // "Used in" opens at the first block naming the card.
    fireEvent.click(within(used).getByRole('button', { name: 'River notes' }))
    await waitFor(() => expect(location.pathname).toBe(`/book/${USES}`))
    expect(recallPlace(BOARD_ID, USES)).toEqual({ blockId: para(3), offset: 0, scrollTop: 0 })
  })

  it('"From" opens the book at the card’s own block', async () => {
    open()
    const from = screen.getByRole('group', { name: 'From' })
    fireEvent.click(within(from).getByRole('button', { name: 'Where it began' }))
    await waitFor(() => expect(location.pathname).toBe(`/book/${ORIGIN}`))
    expect(recallPlace(BOARD_ID, ORIGIN)).toEqual({ blockId: para(12), offset: 0, scrollTop: 0 })
  })

  it('"Used in" for the book open beside the board shows its first use there, in the open writer', async () => {
    const local = openLocalSession({ kind: 'local', state: stateWith(), label: 'test' })
    const session = { ...local, boardId: BOARD_ID } as BoardSession
    attachBooks(session.store)
    history.replaceState(null, '', `/book/${USES}`)
    try {
      render(<BookScreen session={session} bookId={USES} layout="split" />)
      const page = document.querySelector('.bk-book') as HTMLElement
      expect(page.querySelector(`[data-id="${para(3)}"]`)).not.toBeNull()
      // The caret in the book's first paragraph, away from the use.
      const first = page.querySelector(`[data-id="${para(1)}"]`) as HTMLElement
      caret(first, 1)
      const inBlock = () => {
        const at = document.getSelection()?.focusNode ?? null
        return (at instanceof Element ? at : at?.parentElement)
          ?.closest('[data-id]')
          ?.getAttribute('data-id')
      }
      expect(inBlock()).toBe(para(1))
      const anchor = document.createElement('button')
      document.body.append(anchor)
      render(<CardUses session={session} noteId={CARD} anchor={anchor} onClose={() => {}} />)
      const used = screen.getByRole('group', { name: 'Used in' })
      fireEvent.click(within(used).getByRole('button', { name: 'River notes' }))
      // The page goes to the card's first use: the caret there, in the writer that is open.
      await waitFor(() => expect(inBlock()).toBe(para(3)))
      expect(location.pathname).toBe(`/book/${USES}`)
    } finally {
      attachBooks(null)
    }
  })

  it('Esc closes it', () => {
    const { closed } = open()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closed).toEqual([1])
  })

  it('a card’s ink mark opens the reverse view (its chunk), by click or by hover', () => {
    const local = openLocalSession({ kind: 'local', state: stateWith(), label: 'test' })
    const n = local.store.getState().notes.get(CARD)
    if (n === undefined) throw new Error('no card')
    render(<NoteView note={n} lod="full" rotation={false} uses={cardUsesFor(local.store)} />)
    const ink = screen.getByRole('button', { name: 'Used in books' })
    fireEvent.click(ink)
    expect(usesShown.get()).toEqual({ noteId: CARD, anchor: ink })
    showUses(null)
    fireEvent.pointerEnter(ink, { pointerType: 'mouse' })
    expect(usesShown.get()?.noteId).toBe(CARD)
    showUses(null)
  })
})
