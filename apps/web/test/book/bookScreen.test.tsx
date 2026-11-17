import { applyBatch, emptyBoardState } from '@papertie/core'
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { openLocalSession } from '../../src/app/session'
import { BookScreen } from '../../src/book/BookScreen'
import { ShelfScreen } from '../../src/book/ShelfScreen'
import { openBook } from '../../src/book/shelfActions'
import { attachBooks } from '../../src/sync/books/bookStore'
import { book } from '../helpers/books'
import { BOARD_ID, idOf, T0 } from '../helpers/fakeServer'

const ID = idOf('book', 4)

function session() {
  const state = applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [{ op: 'book.create', book: { ...book(ID, { title: 'Winter notes' }), trashedAt: null } }],
    { now: T0 },
  )
  const s = openLocalSession({ kind: 'local', state, label: 'test' })
  attachBooks(s.store)
  return s
}

afterEach(() => {
  cleanup()
  attachBooks(null)
  history.replaceState(null, '', '/')
})

describe('the book screen (until the writer)', () => {
  it('under StrictMode its title is focused, or selected, as it was asked to open', () => {
    const s = session()
    openBook(ID, 'select')
    const view = render(
      <StrictMode>
        <BookScreen session={s} bookId={ID} />
      </StrictMode>,
    )
    const title = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement
    expect(document.activeElement).toBe(title)
    expect([title.selectionStart, title.selectionEnd]).toEqual([0, 'Winter notes'.length])
    view.unmount()

    // Opened again without asking (Books back to it): the sheet has the focus, not the title.
    render(
      <StrictMode>
        <BookScreen session={s} bookId={ID} />
      </StrictMode>,
    )
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Winter notes' }))
  })

  it('under StrictMode the shelf and a book give the focus back to what opened them', async () => {
    const s = session()
    const opener = document.createElement('button')
    opener.textContent = 'Opener'
    document.body.append(opener)
    try {
      for (const sheet of [
        <ShelfScreen key="shelf" session={s} />,
        <BookScreen key="book" session={s} bookId={ID} />,
      ]) {
        opener.focus()
        const view = render(<StrictMode>{sheet}</StrictMode>)
        // The sheet takes the focus as it opens…
        expect(document.activeElement).not.toBe(opener)
        expect(view.container.contains(document.activeElement)).toBe(true)
        // …and gives it back to its opener as it goes.
        view.unmount()
        await act(async () => {})
        expect(document.activeElement).toBe(opener)
      }
    } finally {
      opener.remove()
    }
  })
})

describe('the writer’s top band', () => {
  it('Books at the left; Find, Insert card and Board at the right, the accelerator ⌘\\, pressed while the board is beside the book', () => {
    const s = session()
    const view = render(<BookScreen session={s} bookId={ID} layout="split" />)
    const band = document.querySelector('.writer-band') as HTMLElement
    const names = [...band.querySelectorAll('button')].map((b) => b.textContent)
    expect(names).toEqual(['Books', 'Find', 'Insert card', 'Board'])
    const board = screen.getByRole('button', { name: 'Board' })
    expect(board.getAttribute('aria-pressed')).toBe('true')
    expect(board.getAttribute('aria-keyshortcuts')).toBe('Meta+\\ Control+\\')
    // Find is ⌘F's control; Insert card is ⌘K's.
    expect(screen.getByRole('button', { name: 'Find' }).getAttribute('aria-keyshortcuts')).toBe(
      'Meta+F Control+F',
    )
    expect(
      screen.getByRole('button', { name: 'Insert card' }).getAttribute('aria-keyshortcuts'),
    ).toBe('Meta+K Control+K')
    // Beside the board the book is a pane, not a dialog over it.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('.book-pane')?.getAttribute('data-layout')).toBe('split')
    view.rerender(<BookScreen session={s} bookId={ID} layout="full" />)
    expect(board.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('dialog', { name: 'Winter notes' })).toBeTruthy()
  })
})
