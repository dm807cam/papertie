// @vitest-environment jsdom
/**
 * The find bar: ⌘F in the book (never on the board beside it), "Find" in the
 * top band, Enter and ⇧Enter through the whole book's matches, the matches highlighted, Esc
 * closing it with the match selected; a change to the book makes the results stale, and the next
 * Enter searches again from the current match, which is kept wherever its text is.
 */
import {
  applyBatch,
  type BoardState,
  type ClientOp,
  emptyBoardState,
  posKeysBetween,
} from '@papertie/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { prefsStore } from '../../src/app/prefs'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { BookScreen } from '../../src/book/BookScreen'
import { attachBooks } from '../../src/sync/books/bookStore'
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

const TEXTS = [
  'The lantern by the door.',
  'Nothing here.',
  'A second lantern, and a third Lantern.',
  'The end.',
]

function open(texts: readonly string[] = TEXTS): { session: BoardSession; page: HTMLElement } {
  const s = openLocalSession({ kind: 'local', state: stateWith(texts), label: 'test' })
  attachBooks(s.store)
  const board = document.createElement('main')
  board.className = 'viewport'
  board.tabIndex = 0
  document.body.append(board)
  render(<BookScreen session={s} bookId={ID} layout="split" runtime={{ setSeamDrop() {} }} />)
  return { session: s, page: document.querySelector('.bk-book') as HTMLElement }
}

const bar = () => screen.queryByRole('search', { name: 'Find in the book' })
const field = () => screen.getByRole('searchbox', { name: 'Find in the book' }) as HTMLInputElement
const count = () => document.querySelector('.find-count')?.textContent ?? ''

function cmdF(target: Element): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: 'f',
    code: 'KeyF',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

/** The 120 ms rest, and the search's slices, run out. */
async function rest(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 160))
  })
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

/** The highlights the page draws: CSS.highlights where the browser has it (stubbed here). */
class FakeHighlight extends Set<Range> {
  // As the browser's: `new Highlight(...ranges)`.
  constructor(...ranges: Range[]) {
    super(ranges)
  }
}
const registry = new Map<string, FakeHighlight>()
const current = () => [...(registry.get('book-find-current') ?? [])].map((r) => r.toString())
const all = () => [...(registry.get('book-find') ?? [])].map((r) => r.toString())

beforeEach(() => {
  prefsStore.setState({ motion: 'reduced' })
  registry.clear()
  ;(globalThis as { CSS?: unknown }).CSS = { highlights: registry }
  ;(globalThis as { Highlight?: unknown }).Highlight = FakeHighlight
})
afterEach(() => {
  cleanup()
  attachBooks(null)
  for (const el of document.querySelectorAll('main.viewport')) el.remove()
  delete (globalThis as { CSS?: unknown }).CSS
  delete (globalThis as { Highlight?: unknown }).Highlight
  prefsStore.setState({ motion: 'system' })
})

describe('the find bar', () => {
  it('⌘F in the book opens the find bar; ⌘F on the board does not', async () => {
    const o = open()
    // On the board beside the book: the browser's own find (nothing prevented, no bar).
    const board = document.querySelector('main.viewport') as HTMLElement
    const onBoard = cmdF(board)
    expect(onBoard.defaultPrevented).toBe(false)
    expect(bar()).toBeNull()
    // In the book: the bar, its field focused.
    const el = blockEl(o.page, para(1))
    caret(el, 2)
    const inBook = cmdF(el)
    expect(inBook.defaultPrevented).toBe(true)
    expect(bar()).not.toBeNull()
    expect(document.activeElement).toBe(field())
    // "Find" in the top band is its control, with ⌘F as its accelerator.
    const names = [
      ...(document.querySelector('.writer-band') as HTMLElement).querySelectorAll(
        ':scope > button',
      ),
    ].map((b) => b.textContent)
    expect(names).toEqual(['Books', 'Find', 'Insert card', 'Board'])
    expect(screen.getByRole('button', { name: 'Find' }).getAttribute('aria-keyshortcuts')).toBe(
      'Meta+F Control+F',
    )
    // Esc closes it, and does not leave the book for the shelf.
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(bar()).toBeNull()
    expect(window.location.pathname).not.toBe('/shelf')
    // The band's Find opens it again.
    fireEvent.click(screen.getByRole('button', { name: 'Find' }))
    expect(bar()).not.toBeNull()
  })

  it('Enter and ⇧Enter go through every match; Esc leaves the match selected', async () => {
    const o = open()
    caret(blockEl(o.page, para(2)), 0)
    cmdF(blockEl(o.page, para(2)))
    fireEvent.change(field(), { target: { value: 'lantern' } })
    await rest()
    // The first match at or after the caret (paragraph 2) is the current one.
    expect(count()).toBe('2 of 3')
    expect(current()).toEqual(['lantern'])
    expect(all()).toEqual(['lantern', 'Lantern'])
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(count()).toBe('3 of 3')
    expect(current()).toEqual(['Lantern'])
    // Past the last, round to the first; ⇧Enter goes back.
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(count()).toBe('1 of 3')
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true })
    expect(count()).toBe('3 of 3')
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(count()).toBe('2 of 3')
    // Esc: the bar goes, the match is the selection in the book.
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(bar()).toBeNull()
    expect(document.getSelection()?.toString()).toBe('lantern')
    expect(registry.get('book-find')?.size ?? 0).toBe(0)
    // Nothing found says so.
    cmdF(blockEl(o.page, para(1)))
    fireEvent.change(field(), { target: { value: 'harbour' } })
    await rest()
    expect(count()).toBe('No matches')
  })

  it('a remote edit makes the results stale; the next Enter keeps the current match', async () => {
    const o = open()
    caret(blockEl(o.page, para(3)), 0)
    cmdF(blockEl(o.page, para(3)))
    fireEvent.change(field(), { target: { value: 'lantern' } })
    await rest()
    expect(count()).toBe('2 of 3')
    // The board takes text before the current match, in its own paragraph, and adds a match
    // before it in the book.
    const s = o.session.store.getState()
    o.session.store.replace(
      applyBatch(
        s,
        [
          {
            op: 'block.edit',
            bookId: ID,
            id: para(3),
            splices: [{ at: 0, del: 0, ins: 'Lo, ' }],
          },
          {
            op: 'block.edit',
            bookId: ID,
            id: para(2),
            splices: [{ at: 0, del: 0, ins: 'A lantern. ' }],
          },
        ],
        { now: T0 },
      ),
    )
    await rest()
    // The next Enter searches again from the current match: the same words, now 4 chars on.
    fireEvent.keyDown(field(), { key: 'Enter' })
    await rest()
    expect(count()).toBe('3 of 4')
    expect(current()).toEqual(['lantern'])
    const r = [...(registry.get('book-find-current') ?? [])][0] as Range
    const host = blockEl(o.page, para(3))
    expect(host.contains(r.startContainer)).toBe(true)
    expect(r.startOffset).toBe('Lo, A second '.length)
    // And then on, as before.
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(count()).toBe('4 of 4')
  })
})
