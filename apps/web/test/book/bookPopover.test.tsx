/**
 * A book's options on the shelf: Export offers Markdown and Word,
 * downloads from the owner-only export route.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { BoardSession } from '../../src/app/session'
import { BookPopover } from '../../src/book/BookPopover'
import { BOOK, book } from '../helpers/books'
import { BOARD_ID } from '../helpers/fakeServer'

/** A feed whose unsent count the test sets (`SyncFeed`'s getState and subscribe). */
function feedOf(pending: number) {
  let state = { pending, status: 'saving' }
  const fns = new Set<() => void>()
  return {
    getState: () => state,
    subscribe: (fn: () => void) => {
      fns.add(fn)
      return () => fns.delete(fn)
    },
    set(p: number) {
      state = { ...state, pending: p, status: p === 0 ? 'saved' : 'saving' }
      for (const fn of fns) fn()
    },
  }
}

function show(o: { boardId?: string | null; pending?: number } = {}) {
  const anchor = document.createElement('button')
  document.body.append(anchor)
  const closed: boolean[] = []
  const feed = feedOf(o.pending ?? 0)
  const flush = vi.fn(() => Promise.resolve())
  const session = {
    boardId: o.boardId === undefined ? BOARD_ID : o.boardId,
    feed,
    sync: { flush },
  } as unknown as BoardSession
  render(
    <BookPopover
      session={session}
      book={book(BOOK, { title: 'Field notes' })}
      anchor={anchor}
      onClose={(r) => closed.push(r)}
      onDelete={() => {}}
    />,
  )
  return { pop: screen.getByRole('dialog', { name: 'Field notes' }), closed, feed, flush }
}

const exportAs = (pop: HTMLElement) => {
  fireEvent.click(within(pop).getByRole('button', { name: 'Export' }))
  return within(pop).getByRole('group', { name: 'Export as' })
}
const flushAll = () => act(() => new Promise<void>((r) => setTimeout(r, 0)))

afterEach(() => {
  cleanup()
  document.body.textContent = ''
  history.replaceState(null, '', '/')
})

describe('Export on the shelf', () => {
  it('Export on a book offers Markdown and Word', () => {
    const { pop } = show()
    const exp = within(pop).getByRole('button', { name: 'Export' })
    expect(exp.getAttribute('aria-expanded')).toBe('false')
    expect(within(pop).queryByRole('group', { name: 'Export as' })).toBeNull()
    fireEvent.click(exp)
    expect(exp.getAttribute('aria-expanded')).toBe('true')
    const choices = within(pop).getByRole('group', { name: 'Export as' })
    const names = [...choices.querySelectorAll('a, button')].map((e) => e.textContent)
    expect(names).toEqual(['Markdown', 'Word'])
    // Export sits before Delete, which stays the last row.
    const rows = [...pop.querySelectorAll('.book-popover-row')].map((e) => e.textContent)
    expect(rows.slice(-2)).toEqual(['Export', 'Delete'])
  })

  it('Markdown and Word link to the owner-only route', () => {
    const { pop } = show()
    fireEvent.click(within(pop).getByRole('button', { name: 'Export' }))
    const choices = within(pop).getByRole('group', { name: 'Export as' })
    const md = within(choices).getByRole('link', { name: 'Markdown' })
    const word = within(choices).getByRole('link', { name: 'Word' })
    expect(md.getAttribute('href')).toBe(`/api/boards/${BOARD_ID}/books/${BOOK}/export?format=md`)
    expect(word.getAttribute('href')).toBe(
      `/api/boards/${BOARD_ID}/books/${BOOK}/export?format=docx`,
    )
    expect(md.hasAttribute('download')).toBe(true)
    expect(word.hasAttribute('download')).toBe(true)
  })
})

describe('an export follows the writer', () => {
  const saved: string[] = []
  let fetched: string[] = []
  let answer: Response
  beforeEach(() => {
    saved.length = 0
    fetched = []
    answer = new Response(new Blob(['zip']), {
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="field-notes.zip"' },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url)
        return Promise.resolve(answer)
      }),
    )
    URL.createObjectURL = vi.fn(() => 'blob:papertie/1')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      if (this.href.startsWith('blob:')) saved.push(this.download)
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('an export flushes and waits until nothing is unsent before it fetches the file', async () => {
    const { pop, feed, flush } = show({ pending: 2 })
    const md = within(exportAs(pop)).getByRole('link', { name: 'Markdown' })
    fireEvent.click(md)
    await flushAll()
    expect(flush).toHaveBeenCalled()
    // Words still on their way: nothing fetched yet; the link quietly pressed, no words.
    expect(fetched).toEqual([])
    expect(md.hasAttribute('data-pressed')).toBe(true)
    expect(pop.textContent).not.toMatch(/loading|wait|preparing|exporting/i)
    act(() => feed.set(0))
    await flushAll()
    await flushAll()
    expect(fetched).toEqual([`/api/boards/${BOARD_ID}/books/${BOOK}/export?format=md`])
    expect(saved).toEqual(['field-notes.zip'])
    expect(md.hasAttribute('data-pressed')).toBe(false)
  })

  it('an error answer is never saved as a file', async () => {
    answer = new Response('{"error":"rate-limited"}', { status: 429 })
    const { pop } = show()
    fireEvent.click(within(exportAs(pop)).getByRole('link', { name: 'Word' }))
    await flushAll()
    await flushAll()
    expect(fetched).toHaveLength(1)
    expect(saved).toEqual([])
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('with no board id yet, Markdown and Word are not offered as links', () => {
    const { pop } = show({ boardId: null })
    const choices = exportAs(pop)
    expect(within(choices).queryAllByRole('link')).toEqual([])
    for (const name of ['Markdown', 'Word']) {
      const el = within(choices).getByText(name)
      expect(el.getAttribute('aria-disabled')).toBe('true')
      expect(el.hasAttribute('href')).toBe(false)
    }
  })
})
