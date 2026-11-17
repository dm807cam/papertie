/**
 * The writer's formatting in the sidebar (the selection popover's successor): what the sidebar
 * holds follows what is on screen (the board, a book at full width, a book beside the board,
 * following where the user works there; the mini-bar the same), and its writing tools act on the
 * book's selection without taking it away, on touch too (a tap keeps the selection; Pin offers
 * Pin and Move where no ⌥ is held).
 */
import { applyBatch, type Block, bookBlocks, emptyBoardState, posKeysBetween } from '@papertie/core'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { BoardWithBooks } from '../../src/app/BoardScreen'
import { BookChunk } from '../../src/app/prefetchBooks'
import { prefsStore } from '../../src/app/prefs'
import { navigate, useRoute } from '../../src/app/router'
import { rememberScreen } from '../../src/app/screenMemory'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { closeSearch } from '../../src/search/searchStore'
import { attachBooks } from '../../src/sync/books/bookStore'
import { blockEl, caret } from '../book/writerKit'
import { book, para } from '../helpers/books'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const ID = idOf('book', 6)
const N1 = idOf('note', 1)

function session(): BoardSession {
  const keys = posKeysBetween(null, null, 2)
  const state = applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [
      { op: 'note.create', note: note(N1, { x: 100, y: 100, text: 'one' }) },
      { op: 'book.create', book: { ...book(ID, { title: 'Tools' }), trashedAt: null } },
      ...['Hello world.', 'Second paragraph.'].map((text, i) => ({
        op: 'block.create' as const,
        block: {
          type: 'block' as const,
          id: para(i + 1),
          bookId: ID,
          pos: keys[i] as string,
          kind: 'p' as const,
          text,
          marks: [],
        },
      })),
    ],
    { now: T0 },
  )
  const s = openLocalSession({ kind: 'local', state, label: 'test' })
  s.boardId = BOARD_ID
  attachBooks(s.store)
  return s
}

function App({ session }: { session: BoardSession }) {
  const r = useRoute()
  const books =
    r.name === 'book'
      ? ({ kind: 'book', bookId: r.id } as const)
      : r.name === 'shelf'
        ? ({ kind: 'shelf' } as const)
        : null
  return <BoardWithBooks session={session} books={books} />
}

/** Make `(max-width: 767px)` match, or not. */
function stubNarrow(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (q: string) =>
      ({
        matches: q.includes('max-width') && matches,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
}

async function openOn(width: number): Promise<BoardSession> {
  vi.stubGlobal('innerWidth', width)
  const s = session()
  rememberScreen(BOARD_ID, { screen: 'book', bookId: ID })
  navigate({ name: 'book', id: ID })
  render(<App session={s} />)
  await screen.findByRole('textbox', { name: 'Title' })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30))
  })
  return s
}

const tools = () => screen.getByRole('toolbar', { name: 'Tools' })
/** The buttons a user can reach in the sidebar (not those of a folded or hidden part). */
const reachable = () =>
  within(tools())
    .getAllByRole('button')
    .filter((b) => b.closest('[inert]') === null)
    .map((b) => b.getAttribute('aria-label') ?? b.textContent)
const tool = (name: string) => within(tools()).getByRole('button', { name })
const page = () => document.querySelector('.bk-book') as HTMLElement
const blocks = (s: BoardSession): Block[] =>
  bookBlocks(s.store.getState().blocks, ID).chunks.flat() as Block[]

/** The caret (or a selection) in block `n`, the focus in its text, as a click there leaves it. */
function select(n: number, from: number, to = from) {
  const el = blockEl(page(), para(n))
  const host = (el.closest('[contenteditable="true"]') as HTMLElement | null) ?? el
  act(() => {
    host.focus()
  })
  caret(el, from, to)
}

/** A press on the board's cork, as a click there gives it the keys. */
function pressBoard() {
  const board = document.querySelector('.viewport') as HTMLElement
  const cork = document.querySelector('.cork') as HTMLElement
  act(() => {
    fireEvent.pointerDown(cork)
    board.tabIndex = -1
    board.focus()
  })
}

/** A tap (or click) on a control: the press, then the click. */
function tap(el: HTMLElement, pointerType = 'mouse', init: MouseEventInit = {}) {
  let kept = true
  act(() => {
    kept = fireEvent.pointerDown(el, { pointerType }) && kept
    kept = fireEvent.mouseDown(el) && kept
    fireEvent.click(el, init)
  })
  return kept
}

const BOARD_TOOLS = ['New note', 'Select', 'Yarn', 'Photo', 'Search']
const WRITING_TOOLS = ['Text style', 'Bold', 'Italic', 'Footnote', 'Pin to board', 'Search']

let restore: () => void = () => {}
beforeAll(async () => {
  await BookChunk.load()
})
beforeEach(() => {
  localStorage.clear()
  restore = installCanvasStubs()
  prefsStore.setState({ sidebar: 'open', tool: 'select' })
})
afterEach(() => {
  act(() => closeSearch())
  cleanup()
  attachBooks(null)
  restore()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
  document.body.replaceChildren()
})

describe('the sidebar follows what is on screen', () => {
  it('the board alone keeps its tools', async () => {
    vi.stubGlobal('innerWidth', 1440)
    const s = session()
    render(<App session={s} />)
    expect(reachable()).toEqual(['Papertie — hide tools', ...BOARD_TOOLS, 'Books', 'Settings'])
  })

  it('a book at full width: the writing tools, Search, Books and Settings, and no board tool', async () => {
    await openOn(900)
    expect(reachable()).toEqual(['Papertie — hide tools', ...WRITING_TOOLS, 'Books', 'Settings'])
    expect(within(tools()).queryByRole('button', { name: 'New note' })).toBeNull()
    expect(within(tools()).queryByRole('button', { name: 'Yarn' })).toBeNull()
  })

  it('beside the board it follows where you work: the book’s tools in the book, the board’s on the board, with a fade', async () => {
    await openOn(1440)
    expect(document.querySelector('.board-split')?.getAttribute('data-layout')).toBe('split')
    select(1, 0, 5)
    expect(reachable()).toEqual(['Papertie — hide tools', ...WRITING_TOOLS, 'Books', 'Settings'])
    pressBoard()
    expect(reachable()).toEqual(['Papertie — hide tools', ...BOARD_TOOLS, 'Books', 'Settings'])
    // The switch fades (the motion tokens: instant under reduced motion), the panel's width kept.
    expect(document.querySelector('.sidebar-group')?.hasAttribute('data-swap')).toBe(true)
    select(2, 0)
    expect(reachable()).toEqual(['Papertie — hide tools', ...WRITING_TOOLS, 'Books', 'Settings'])
    // A press on the sidebar itself is neither: the tools stay.
    act(() => {
      fireEvent.pointerDown(tools())
    })
    expect(reachable()).toContain('Bold')
  })

  it('the mini-bar switches the same way: under a book its writing row, Books, Search and Settings', async () => {
    stubNarrow(true)
    await openOn(390)
    const labels = reachable()
    expect(labels).toEqual([
      'Text style',
      'Bold',
      'Italic',
      'Footnote',
      'Pin to board',
      'Books',
      'Search',
      'Settings',
    ])
    expect(document.querySelector('.minibar .minibar-writing')).not.toBeNull()
  })
})

describe('the writing tools', () => {
  it('the selection popover is gone: selecting text shows no floating bar', async () => {
    await openOn(900)
    select(1, 0, 5)
    expect(screen.queryByRole('toolbar', { name: 'Format' })).toBeNull()
    expect(document.querySelector('.writer-pop')).toBeNull()
  })

  it('Bold, Italic, Footnote and Pin wait for selected text; Text style for a caret', async () => {
    await openOn(900)
    const off = (name: string) => tool(name).getAttribute('aria-disabled') === 'true'
    // Before the caret is in the book, nothing to act on.
    act(() => {
      document.getSelection()?.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(off('Text style')).toBe(true)
    select(1, 3)
    expect(off('Text style')).toBe(false)
    for (const name of ['Bold', 'Italic', 'Footnote', 'Pin to board']) expect(off(name)).toBe(true)
    select(1, 0, 5)
    for (const name of ['Text style', 'Bold', 'Italic', 'Footnote', 'Pin to board'])
      expect(off(name)).toBe(false)
  })

  it('a disabled control does nothing', async () => {
    const s = await openOn(900)
    select(1, 3)
    const before = s.store.getState()
    tap(tool('Bold'))
    tap(tool('Footnote'))
    expect(s.store.getState()).toBe(before)
  })

  it('a tap on Bold keeps the selection in the book and bolds it; Bold then shows pressed', async () => {
    const s = await openOn(900)
    select(1, 6, 11)
    expect(tool('Bold').getAttribute('aria-pressed')).toBe('false')
    // The press takes nothing from the text: its default (the focus, the selection) prevented.
    expect(tap(tool('Bold'), 'touch')).toBe(false)
    expect(blocks(s)[0]?.marks).toEqual([{ t: 'b', from: 6, to: 11 }])
    expect(page().contains(document.activeElement)).toBe(true)
    expect(document.getSelection()?.toString()).toBe('world')
    expect(tool('Bold').getAttribute('aria-pressed')).toBe('true')
    expect(tool('Italic').getAttribute('aria-pressed')).toBe('false')
  })

  it('a selection the browser dropped as the control was tapped is put back before it acts', async () => {
    const s = await openOn(900)
    select(1, 0, 5)
    act(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      document.getSelection()?.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })
    // Still offered: the last range in the book is kept.
    expect(tool('Italic').getAttribute('aria-disabled')).toBe('false')
    tap(tool('Italic'), 'touch')
    expect(blocks(s)[0]?.marks).toEqual([{ t: 'i', from: 0, to: 5 }])
  })

  it('Text style shows the block’s kind and opens a picker of the six, the current one marked', async () => {
    const s = await openOn(900)
    select(1, 2)
    expect(tool('Text style').getAttribute('title')).toBe('Text style: Paragraph')
    tap(tool('Text style'))
    const picker = screen.getByRole('dialog', { name: 'Text style' })
    const radios = within(picker).getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Paragraph',
      'Chapter',
      'Section',
      'Quote',
      'List',
      'Prompt',
    ])
    expect(radios.filter((r) => r.checked).map((r) => r.getAttribute('aria-label'))).toEqual([
      'Paragraph',
    ])
    // Opened by a press, the caret stays in the text.
    expect(page().contains(document.activeElement)).toBe(true)
    const chapter = within(picker).getByRole('radio', { name: 'Chapter' })
    act(() => {
      fireEvent.pointerDown(chapter.closest('label') as HTMLElement)
      fireEvent.click(chapter)
    })
    expect(blocks(s)[0]).toMatchObject({ kind: 'h1', text: 'Hello world.' })
    expect(screen.queryByRole('dialog', { name: 'Text style' })).toBeNull()
    expect(tool('Text style').getAttribute('title')).toBe('Text style: Chapter')
  })

  it('Footnote makes a footnote over the selection', async () => {
    const s = await openOn(900)
    select(1, 6, 11)
    tap(tool('Footnote'))
    expect(blocks(s).map((b) => b.kind)).toEqual(['p', 'footnote', 'p'])
  })

  it('with ⌥ held Pin to board reads Move to board, and moves the text', async () => {
    const s = await openOn(900)
    select(1, 0, 5)
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true })))
    expect(tool('Move to board')).toBeTruthy()
    const notes = s.store.getState().notes.size
    tap(tool('Move to board'), 'mouse', { altKey: true })
    expect(s.store.getState().notes.size).toBe(notes + 1)
    expect(blocks(s)[0]?.text).toBe(' world.')
    act(() => void window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' })))
    expect(tool('Pin to board')).toBeTruthy()
  })

  it('a click on Pin to board pins and leaves the text', async () => {
    const s = await openOn(900)
    select(1, 0, 5)
    const notes = s.store.getState().notes.size
    tap(tool('Pin to board'))
    expect(s.store.getState().notes.size).toBe(notes + 1)
    expect(blocks(s)[0]?.text).toBe('Hello world.')
  })

  it('on touch, a tap on Pin offers Pin to board and Move to board', async () => {
    const s = await openOn(900)
    select(1, 0, 5)
    const notes = s.store.getState().notes.size
    tap(tool('Pin to board'), 'touch')
    const choice = screen.getByRole('dialog', { name: 'Pin to board' })
    expect(
      within(choice)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Pin to board', 'Move to board'])
    // Nothing made yet; the choice keeps the selection too.
    expect(s.store.getState().notes.size).toBe(notes)
    expect(tap(within(choice).getByRole('button', { name: 'Move to board' }), 'touch')).toBe(false)
    expect(s.store.getState().notes.size).toBe(notes + 1)
    expect(blocks(s)[0]?.text).toBe(' world.')
    expect(screen.queryByRole('dialog', { name: 'Pin to board' })).toBeNull()
  })

  it('Tab from selected text reaches the tools, the selection kept; Esc goes back to the text', async () => {
    const s = await openOn(900)
    select(1, 6, 11)
    act(() => {
      ;(document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      )
    })
    expect(document.activeElement).toBe(tool('Text style'))
    act(() => tool('Bold').focus())
    fireEvent.click(tool('Bold'))
    expect(blocks(s)[0]?.marks).toEqual([{ t: 'b', from: 6, to: 11 }])
    act(() => {
      fireEvent.keyDown(tool('Bold'), { key: 'Escape' })
    })
    expect(page().contains(document.activeElement)).toBe(true)
    expect(document.getSelection()?.toString()).toBe('world')
    // Esc there was the tools': the book is still open.
    expect(location.pathname).toBe(`/book/${ID}`)
  })
})
