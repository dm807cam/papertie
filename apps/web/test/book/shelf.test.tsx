/**
 * The shelf, over a real server session on a fake server: the board stays
 * mounted under it, books are made, reordered, deleted and put back through the board's own op
 * path, and only the covers near the view are drawn.
 */
import { type ClientOp, posBetween } from '@papertie/core'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as boards from '../../src/api/boards'
import { AppShell } from '../../src/app/AppShell'
import { navigate, useRoute } from '../../src/app/router'
import { rememberScreen } from '../../src/app/screenMemory'
import * as sessions from '../../src/app/session'
import { block, book } from '../helpers/books'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, FakeServer, FakeTransport, idOf } from '../helpers/fakeServer'

vi.mock('../../src/api/boards', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/api/boards')>()
  return { ...m, listBoards: vi.fn(), createBoard: vi.fn(), postBatch: vi.fn() }
})
vi.mock('../../src/app/session', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/app/session')>()
  return { ...m, openServerSession: vi.fn() }
})

const actual =
  await vi.importActual<typeof import('../../src/app/session')>('../../src/app/session')
const open = vi.mocked(sessions.openServerSession)
const _USER = { userId: 'user_a' }
const DAY = 86_400_000

let server: FakeServer
let restore: () => void = () => {}

function Routed() {
  return <AppShell route={useRoute()} />
}

/** The sessions the screen opened, in order. */
const opened = async (): Promise<sessions.BoardSession[]> =>
  Promise.all(open.mock.results.map((r) => r.value as Promise<sessions.BoardSession>))

async function session(): Promise<sessions.BoardSession> {
  await waitFor(() => expect(open).toHaveBeenCalled())
  const all = await opened()
  return all[all.length - 1] as sessions.BoardSession
}

/** Everything sent and confirmed: the server has every edit made here. */
async function settled(): Promise<void> {
  const s = await session()
  await waitFor(
    () => {
      expect(s.sync?.pending).toBe(0)
      expect(s.sync?.confirmed.board.revision).toBe(server.revision)
    },
    { timeout: 4000 },
  )
}

async function showShelf(path = '/shelf') {
  history.replaceState(null, '', path)
  render(<Routed />)
  return screen.findByRole('dialog', { name: 'Books' }, { timeout: 4000 })
}

/** The titles on the shelf, in order. */
const order = (shelf: HTMLElement) =>
  within(within(shelf).getByRole('list', { name: 'Books on the shelf' }))
    .getAllByRole('listitem')
    .map((li) => li.dataset.bookTitle)
    .filter((t) => t !== undefined)

/** Books at shelf positions in order, made in one commit on the server. */
function shelve(titles: readonly string[]) {
  let pos: string | null = null
  const ops: ClientOp[] = []
  titles.forEach((title, i) => {
    pos = posBetween(pos, null)
    ops.push({
      op: 'book.create',
      book: { ...book(idOf('book', i + 1), { title, shelfPos: pos }), trashedAt: null },
    })
  })
  server.commit(ops)
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  restore = installCanvasStubs()
  server = new FakeServer()
  vi.mocked(boards.listBoards).mockResolvedValue([
    {
      id: BOARD_ID,
      name: 'Test board',
      revision: 0,
      createdAt: '2026-10-30T09:00:00.000Z',
      updatedAt: '2026-10-30T09:00:00.000Z',
      recovered: false,
    },
  ])
  open.mockImplementation((id, o) =>
    actual.openServerSession(id, {
      ...o,
      transport: new FakeTransport(server),
      env: null,
      camera: null,
    }),
  )
})
afterEach(() => {
  cleanup()
  restore()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

describe('the shelf', () => {
  it('new book appears on the shelf with its cover and opens with the title ready to type', async () => {
    shelve(['Field notes'])
    const shelf = await showShelf()
    fireEvent.click(within(shelf).getByRole('button', { name: 'New book' }))
    await waitFor(() => expect(location.pathname).toMatch(/^\/book\/book_\w+$/))
    const id = location.pathname.slice('/book/'.length)
    const title = await screen.findByRole('textbox', { name: 'Title' }, { timeout: 4000 })
    await waitFor(() => expect(document.activeElement).toBe(title))
    fireEvent.change(title, { target: { value: 'Winter notes' } })
    expect((await session()).store.getState().books.get(id)?.title).toBe('Winter notes')

    act(() => navigate({ name: 'shelf' }))
    const back = await screen.findByRole('dialog', { name: 'Books' })
    // After the books that were there: last on the shelf, with its own drawn cover.
    expect(order(back)).toEqual(['Field notes', 'Winter notes'])
    const slot = within(back).getByRole('button', { name: 'Winter notes' }).closest('li')
    expect(slot?.querySelector('.cover svg')).not.toBeNull()
    expect(slot?.querySelector('[lang]')?.getAttribute('lang')).toBe('en')
  })

  it("a new book's batch holds the book and one empty paragraph", async () => {
    vi.stubGlobal('navigator', { ...navigator, language: 'de-AT' })
    shelve(['First'])
    const shelf = await showShelf()
    await settled()
    const before = server.log.length
    const last = server.state.books.get(idOf('book', 1))?.shelfPos as string
    fireEvent.click(within(shelf).getByRole('button', { name: 'New book' }))
    await settled()
    expect(server.log.length).toBe(before + 1)
    const ops = server.log.at(-1)?.ops ?? []
    expect(ops.map((o) => o.op)).toEqual(['book.create', 'block.create'])
    const [made, para] = ops as [
      Extract<ClientOp, { op: 'book.create' }>,
      Extract<ClientOp, { op: 'block.create' }>,
    ]
    expect(made.book).toMatchObject({ title: '', lang: 'de', trashedAt: null })
    expect(made.book.shelfPos > last).toBe(true)
    expect(made.book.cover).toEqual({
      seed: expect.any(Number),
      ink: expect.any(String),
      motif: expect.any(String),
    })
    // First in the book, and it says so.
    expect(para.after).toBeNull()
    expect(para.block).toMatchObject({
      bookId: made.book.id,
      kind: 'p',
      text: '',
      pos: posBetween(null, null),
      marks: [],
    })
  })

  it('reorder by drag and by keyboard survives reload', async () => {
    shelve(['A', 'B', 'C', 'D'])
    let shelf = await showShelf()
    // Four across, 120 × 180 slots: what the browser would lay out.
    const slots = () =>
      within(shelf)
        .getAllByRole('listitem')
        .filter((li) => li.dataset.bookId !== undefined)
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const i = slots().indexOf(this as HTMLElement)
      const x = i < 0 ? 0 : (i % 4) * 140
      const y = i < 0 ? 0 : Math.floor(i / 4) * 200
      return new DOMRect(x, y, i < 0 ? 0 : 120, i < 0 ? 0 : 180)
    })
    const a = within(shelf).getByRole('button', { name: 'A' })
    fireEvent.pointerDown(a, { pointerId: 1, button: 0, clientX: 60, clientY: 90, isPrimary: true })
    fireEvent.pointerMove(a, { pointerId: 1, clientX: 140, clientY: 90 })
    fireEvent.pointerMove(a, { pointerId: 1, clientX: 340, clientY: 90 })
    fireEvent.pointerUp(a, { pointerId: 1, clientX: 340, clientY: 90 })
    // Dropped on C's place: A goes there. The press that dragged did not open A.
    expect(order(shelf)).toEqual(['B', 'C', 'A', 'D'])
    expect(location.pathname).toBe('/shelf')
    // A held finger's long press (Android's context menu) during a drag opens nothing.
    const b = within(shelf).getByRole('button', { name: 'B' })
    fireEvent.pointerDown(b, { pointerId: 2, button: 0, clientX: 60, clientY: 90, isPrimary: true })
    fireEvent.pointerMove(b, { pointerId: 2, clientX: 90, clientY: 90 })
    fireEvent.contextMenu(b)
    expect(screen.queryByRole('dialog', { name: 'B' })).toBeNull()
    fireEvent.pointerUp(b, { pointerId: 2, clientX: 90, clientY: 90 })
    expect(order(shelf)).toEqual(['B', 'C', 'A', 'D'])
    rect.mockRestore()

    const d = within(shelf).getByRole('button', { name: 'D' })
    d.focus()
    fireEvent.keyDown(d, { key: 'ArrowLeft', altKey: true })
    expect(order(shelf)).toEqual(['B', 'C', 'D', 'A'])
    // It keeps the focus where it went, and says so.
    expect(document.activeElement).toBe(within(shelf).getByRole('button', { name: 'D' }))
    await waitFor(() =>
      expect(document.querySelector('[data-live-region]')?.textContent?.trim()).toBe(
        'Moved D to place 3 of 4',
      ),
    )
    fireEvent.keyDown(within(shelf).getByRole('button', { name: 'B' }), {
      key: 'ArrowLeft',
      altKey: true,
    })
    expect(order(shelf)).toEqual(['B', 'C', 'D', 'A']) // first already: nothing moves
    await settled()

    // A reload: a page of its own, the same server.
    cleanup()
    open.mockClear()
    shelf = await showShelf()
    expect(order(shelf)).toEqual(['B', 'C', 'D', 'A'])
  })

  it('delete asks with the title, deletes, and undo brings the book back with all its blocks', async () => {
    shelve(['Field notes', 'Letters'])
    server.commit([
      { op: 'block.create', block: block(1, 'One', idOf('book', 1), 'V1') },
      { op: 'block.create', block: block(2, 'Two', idOf('book', 1), 'V2') },
    ])
    const shelf = await showShelf()
    const ask = () => {
      fireEvent.click(within(shelf).getByRole('button', { name: 'Options for Field notes' }))
      const pop = screen.getByRole('dialog', { name: 'Field notes' })
      expect(
        within(pop)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Rename', 'New cover', 'Export', 'Delete'])
      expect(within(pop).getByRole('radio', { name: 'English' })).toHaveProperty('checked', true)
      fireEvent.click(within(pop).getByRole('button', { name: 'Delete' }))
      return screen.getByRole('alertdialog')
    }
    // Asked with its title; "Keep" keeps it.
    let sure = ask()
    expect(sure.textContent).toContain('Delete “Field notes”? You can put it back for 30 days.')
    fireEvent.click(within(sure).getByRole('button', { name: 'Keep' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(order(shelf)).toEqual(['Field notes', 'Letters'])

    sure = ask()
    fireEvent.click(within(sure).getByRole('button', { name: 'Delete' }))
    expect(order(shelf)).toEqual(['Letters'])
    await settled()
    expect(server.state.books.get(idOf('book', 1))?.trashedAt).not.toBeNull()

    // ⌘Z on the shelf: one step, the book back where it stood, every paragraph with it.
    fireEvent.keyDown(document.body, { key: 'z', code: 'KeyZ', metaKey: true })
    expect(order(shelf)).toEqual(['Field notes', 'Letters'])
    await settled()
    expect(server.state.books.get(idOf('book', 1))?.trashedAt).toBeNull()
    const blocks = [...server.state.blocks.values()].filter((b) => b.bookId === idOf('book', 1))
    expect(blocks.map((b) => b.text)).toEqual(['One', 'Two'])
  })

  it("the popover's Rename opens the book with its title selected; New cover and Language change the book", async () => {
    shelve(['Field notes'])
    const shelf = await showShelf()
    const s = await session()
    const book = () => s.store.getState().books.get(idOf('book', 1))
    const pop = () => {
      fireEvent.click(within(shelf).getByRole('button', { name: 'Options for Field notes' }))
      return screen.getByRole('dialog', { name: 'Field notes' })
    }
    const seed = book()?.cover.seed
    fireEvent.click(within(pop()).getByRole('button', { name: 'New cover' }))
    expect(book()?.cover.seed).not.toBe(seed)
    expect(book()?.title).toBe('Field notes') // renaming keeps the cover; a new cover keeps the title
    fireEvent.click(within(pop()).getByRole('radio', { name: 'German' }))
    expect(book()?.lang).toBe('de')
    expect(
      within(shelf)
        .getByRole('button', { name: 'Field notes' })
        .querySelector('[lang]')
        ?.getAttribute('lang'),
    ).toBe('de')
    // A right click on the book opens the same popover.
    fireEvent.contextMenu(within(shelf).getByRole('button', { name: 'Field notes' }))
    expect(screen.getByRole('dialog', { name: 'Field notes' })).toBeTruthy()
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Field notes' })).getByRole('button', {
        name: 'Rename',
      }),
    )
    await waitFor(() => expect(location.pathname).toBe(`/book/${idOf('book', 1)}`))
    const title = (await screen.findByRole('textbox', { name: 'Title' })) as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(title))
    expect([title.selectionStart, title.selectionEnd]).toEqual([0, 'Field notes'.length])
  })

  it('recently deleted lists a trashed book and puts it back', async () => {
    const now = Date.now()
    shelve(['Kept', 'Old letters', 'Long gone'])
    // Deleted 5 and 31 days ago, as the server dated it.
    server.commit([
      {
        op: 'book.update',
        id: idOf('book', 2),
        set: { trashedAt: new Date(now - 5 * DAY).toISOString() },
      },
      {
        op: 'book.update',
        id: idOf('book', 3),
        set: { trashedAt: new Date(now - 31 * DAY).toISOString() },
      },
    ])
    const shelf = await showShelf()
    expect(order(shelf)).toEqual(['Kept'])
    fireEvent.click(within(shelf).getByRole('button', { name: 'Recently deleted' }))
    const list = screen.getByRole('dialog', { name: 'Recently deleted' })
    // Past its 30 days (the server's purge may not have reached it yet): not offered.
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Old letters.*25 days left.*Put it back$/),
    ])
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Put it back' }))
    expect(order(shelf)).toEqual(['Kept', 'Old letters'])
    await settled()
    expect(server.state.books.get(idOf('book', 2))?.trashedAt).toBeNull()
    // Nothing deleted is left to offer: the link goes.
    await waitFor(() =>
      expect(within(shelf).queryByRole('button', { name: 'Recently deleted' })).toBeNull(),
    )
  })

  it('on a phone the shelf and a book are not modal: the mini-bar beside them stays reachable', async () => {
    // A phone's window: under the split view's width too, so a book is full width.
    vi.stubGlobal('innerWidth', 390)
    vi.stubGlobal(
      'matchMedia',
      (q: string) =>
        ({
          matches: q.includes('max-width: 767px'),
          media: q,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    )
    shelve(['Field notes'])
    const shelf = await showShelf()
    const bar = screen.getByRole('toolbar', { name: 'Tools' })
    expect(bar.className).toBe('minibar')
    expect(shelf.getAttribute('aria-modal')).toBeNull()
    expect(document.querySelector('[aria-modal="true"]')).toBeNull()
    fireEvent.click(within(shelf).getByRole('button', { name: 'Field notes' }))
    const sheet = await screen.findByRole('dialog', { name: 'Field notes' })
    expect(sheet.getAttribute('aria-modal')).toBeNull()
    expect(document.querySelector('[aria-modal="true"]')).toBeNull()
    expect(
      within(screen.getByRole('toolbar', { name: 'Tools' })).getByRole('button', { name: 'Books' }),
    ).toBeTruthy()
  })

  it('Esc, a press on the veil and Books leave the shelf for the board, giving the focus back', async () => {
    shelve(['Field notes'])
    // Opened by its address: the focus goes to Books, the way back.
    let shelf = await showShelf()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(location.pathname).toBe('/'))
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Books'))

    // Opened from Books: a press on the veil around the case goes back, the focus to Books.
    const books = screen.getByRole('button', { name: 'Books' })
    books.focus()
    fireEvent.click(books)
    shelf = await screen.findByRole('dialog', { name: 'Books' })
    expect(document.activeElement).not.toBe(books)
    fireEvent.click(shelf.parentElement as HTMLElement)
    await waitFor(() => expect(location.pathname).toBe('/'))
    await waitFor(() => expect(document.activeElement).toBe(books))

    // Opened from the search button (what opened it is kept, if it is still there).
    const search = screen.getByRole('button', { name: 'Search' })
    search.focus()
    act(() => navigate({ name: 'shelf' }))
    shelf = await screen.findByRole('dialog', { name: 'Books' })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(location.pathname).toBe('/'))
    await waitFor(() => expect(document.activeElement).toBe(search))

    // Books, pressed on the shelf: back, the focus where it was.
    fireEvent.click(books)
    await screen.findByRole('dialog', { name: 'Books' })
    books.focus()
    fireEvent.click(books)
    await waitFor(() => expect(location.pathname).toBe('/'))
    await waitFor(() => expect(document.activeElement).toBe(books))
  })

  it('the focus goes back to the link after Recently deleted, to a book once the link is gone, and to the options after Keep', async () => {
    shelve(['Field notes', 'Letters', 'Recipes'])
    const now = Date.now()
    server.commit([
      {
        op: 'book.update',
        id: idOf('book', 2),
        set: { trashedAt: new Date(now - DAY).toISOString() },
      },
      {
        op: 'book.update',
        id: idOf('book', 3),
        set: { trashedAt: new Date(now - DAY).toISOString() },
      },
    ])
    const shelf = await showShelf()
    const link = within(shelf).getByRole('button', { name: 'Recently deleted' })
    // Done.
    fireEvent.click(link)
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Recently deleted' })).getByRole('button', {
        name: 'Done',
      }),
    )
    await waitFor(() => expect(document.activeElement).toBe(link))
    // Esc.
    fireEvent.click(link)
    expect(screen.getByRole('dialog', { name: 'Recently deleted' })).toBeTruthy()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Recently deleted' })).toBeNull()
    expect(location.pathname).toBe('/shelf') // the list went, not the shelf
    await waitFor(() => expect(document.activeElement).toBe(link))
    // Putting one back keeps the list, and the focus in it.
    fireEvent.click(link)
    let list = screen.getByRole('dialog', { name: 'Recently deleted' })
    fireEvent.click(within(list).getAllByRole('button', { name: 'Put it back' })[0] as HTMLElement)
    list = screen.getByRole('dialog', { name: 'Recently deleted' })
    await waitFor(() => expect(list.contains(document.activeElement)).toBe(true))
    // Putting back the last: the list and the link go; the focus goes to the shelf's first book.
    fireEvent.click(within(list).getByRole('button', { name: 'Put it back' }))
    await waitFor(() =>
      expect(within(shelf).queryByRole('button', { name: 'Recently deleted' })).toBeNull(),
    )
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(shelf).getByRole('button', { name: 'Field notes' }),
      ),
    )

    // Delete's Keep: the focus goes back to that book's options.
    const options = within(shelf).getByRole('button', { name: 'Options for Letters' })
    fireEvent.click(options)
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Letters' })).getByRole('button', {
        name: 'Delete',
      }),
    )
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(document.activeElement).toBe(options))
    // And Esc in the question keeps it too.
    fireEvent.click(options)
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Letters' })).getByRole('button', {
        name: 'Delete',
      }),
    )
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(location.pathname).toBe('/shelf')
    await waitFor(() => expect(document.activeElement).toBe(options))
  })

  it('Books goes to the last book only while it is on the shelf: a deleted or gone one opens the shelf', async () => {
    shelve(['Field notes', 'Letters'])
    server.commit([
      { op: 'book.update', id: idOf('book', 2), set: { trashedAt: new Date().toISOString() } },
    ])
    history.replaceState(null, '', '/')
    render(<Routed />)
    await screen.findByTestId('canvas')
    const s = await session()
    const books = () => screen.getByRole('button', { name: 'Books' })
    for (const [id, to] of [
      [idOf('book', 1), `/book/${idOf('book', 1)}`],
      [idOf('book', 2), '/shelf'], // deleted
      [idOf('book', 9), '/shelf'], // never was, or purged
    ] as const) {
      await waitFor(() => expect(s.store.getState().books.size).toBe(2))
      rememberScreen(BOARD_ID, { screen: 'book', bookId: id })
      rememberScreen(BOARD_ID, { screen: 'board' })
      act(() => fireEvent.click(books()))
      expect(location.pathname).toBe(to)
      act(() => navigate({ name: 'board' }))
    }
  })

  it('the board stays mounted under the shelf', async () => {
    history.replaceState(null, '', '/')
    render(<Routed />)
    const s = await session()
    const dispose = vi.spyOn(s, 'dispose')
    const board = await screen.findByTestId('canvas')
    fireEvent.click(screen.getByRole('button', { name: 'Books' }))
    expect(await screen.findByRole('dialog', { name: 'Books' })).toBeTruthy()
    expect(board.isConnected).toBe(true)
    expect(board.hasAttribute('data-covered')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Books' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Books' })).toBeNull())
    // The same board and session: never closed and opened again.
    expect(screen.getByTestId('canvas')).toBe(board)
    expect(open).toHaveBeenCalledTimes(1)
    expect(await session()).toBe(s)
    expect(dispose).not.toHaveBeenCalled()
  })

  it('a shelf of 500 books mounts only the covers near the viewport', async () => {
    const watched: Element[] = []
    let report: ((entries: IntersectionObserverEntry[]) => void) | null = null
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
          report = cb
        }
        observe(el: Element) {
          watched.push(el)
        }
        unobserve() {}
        disconnect() {}
      },
    )
    shelve(Array.from({ length: 500 }, (_, i) => `Book ${i + 1}`))
    const shelf = await showShelf()
    await waitFor(() => expect(watched.length).toBe(500))
    // Nothing reported yet: no cover is drawn.
    expect(shelf.querySelectorAll('.cover')).toHaveLength(0)
    // The first rows are near the view; the rest are not.
    act(() =>
      report?.(
        watched.map(
          (target, i) =>
            ({ target, isIntersecting: i < 24 }) as unknown as IntersectionObserverEntry,
        ),
      ),
    )
    expect(within(shelf).getAllByRole('listitem').length).toBe(501) // every title, and "New book"
    expect(shelf.querySelectorAll('.cover')).toHaveLength(24)
    // Scrolled on: those that came near are drawn, those that went far are let go.
    act(() =>
      report?.(
        watched
          .slice(0, 48)
          .map(
            (target, i) =>
              ({ target, isIntersecting: i >= 24 }) as unknown as IntersectionObserverEntry,
          ),
      ),
    )
    expect(shelf.querySelectorAll('.cover')).toHaveLength(24)
    expect(
      within(shelf).getByRole('button', { name: 'Book 30' }).closest('li')?.querySelector('.cover'),
    ).not.toBeNull()
  })
})

/**
 * "New book" with the shelf full (minor 2): 500 books, those in Recently deleted
 * among them (the server's cap counts every book the board holds; a deleted one keeps its words
 * for 30 days, to be put back whole). Nothing is made, nothing opens, and a calm slip says why.
 */
describe('the shelf, full', () => {
  const slips = (s: sessions.BoardSession) =>
    s.feed
      .getState()
      .notices.filter((n) => n.slip)
      .map((n) => n.message)

  it('500 books, one of them deleted: New book says there is no room, counting Recently deleted', async () => {
    shelve(Array.from({ length: 500 }, (_, i) => `Book ${i + 1}`))
    server.commit([
      { op: 'book.update', id: idOf('book', 7), set: { trashedAt: '2026-10-30T09:00:00.000Z' } },
    ])
    const shelf = await showShelf()
    await settled()
    const before = server.log.length
    fireEvent.click(within(shelf).getByRole('button', { name: 'New book' }))
    await settled()
    expect(location.pathname).toBe('/shelf')
    expect(server.log.length).toBe(before)
    expect(slips(await session())).toEqual([
      'There’s no room for a new book: the shelf holds 500, counting those in Recently deleted.',
    ])
  })

  it('the full-shelf slip has a slot of its own: a board-reloaded slip and it are both up, whichever came first', async () => {
    shelve(Array.from({ length: 500 }, (_, i) => `Book ${i + 1}`))
    const shelf = await showShelf()
    await settled()
    const s = await session()
    const full = 'There’s no room for a new book: the shelf holds 500.'
    act(() => s.feed.notice({ kind: 'reset', count: 0, message: 'Board reloaded.' }))
    fireEvent.click(within(shelf).getByRole('button', { name: 'New book' }))
    expect(slips(s)).toEqual(['Board reloaded.', full])
    act(() => s.feed.notice({ kind: 'reset', count: 0, message: 'Restored.' }))
    expect(slips(s)).toEqual([full, 'Restored.'])
  })

  it('the full-shelf slip is said once: by the notices, which read it out, not the page’s live region too', async () => {
    shelve(Array.from({ length: 500 }, (_, i) => `Book ${i + 1}`))
    const shelf = await showShelf()
    await settled()
    const full = 'There’s no room for a new book: the shelf holds 500.'
    fireEvent.click(within(shelf).getByRole('button', { name: 'New book' }))
    await settled()
    const notices = document.querySelector('.sync-notices')
    expect(notices?.getAttribute('aria-live')).toBe('polite')
    expect(notices?.textContent).toContain(full)
    expect(notices?.closest('[inert]')).toBeNull()
    expect(document.querySelector('[data-live-region]')?.textContent ?? '').not.toContain(full)
  })

  it('500 books on the shelf: New book says there is no room', async () => {
    shelve(Array.from({ length: 500 }, (_, i) => `Book ${i + 1}`))
    const shelf = await showShelf()
    await settled()
    fireEvent.click(within(shelf).getByRole('button', { name: 'New book' }))
    expect(location.pathname).toBe('/shelf')
    expect(slips(await session())).toEqual(['There’s no room for a new book: the shelf holds 500.'])
  })
})
