/**
 * The split view: the board and an open book side by side, the board one runtime
 * and one session through every layout change, the writer never remounted, the seam's drag and
 * keyboard path, ⌘\ as the accelerator of "Board" (in the writer) and Books (on the board), and
 * the board's keys kept from the book's pane (Review Focus 5).
 */
import { applyBatch, emptyBoardState, posKeysBetween } from '@papertie/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BoardWithBooks } from '../../src/app/BoardScreen'
import { BookChunk } from '../../src/app/prefetchBooks'
import { navigate, useRoute } from '../../src/app/router'
import { rememberScreen, SPLIT_KEY } from '../../src/app/screenMemory'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import { closeSearch } from '../../src/search/searchStore'
import { attachBooks } from '../../src/sync/books/bookStore'
import { book, para } from '../helpers/books'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const ID = idOf('book', 5)
const N1 = idOf('note', 1)
const N2 = idOf('note', 2)

function session(): BoardSession {
  const keys = posKeysBetween(null, null, 2)
  const state = applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [
      { op: 'note.create', note: note(N1, { x: 100, y: 100, text: 'one' }) },
      { op: 'note.create', note: note(N2, { x: 400, y: 100, text: 'two' }) },
      { op: 'book.create', book: { ...book(ID, { title: 'Side by side' }), trashedAt: null } },
      ...['First paragraph.', 'Second paragraph.'].map((text, i) => ({
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

/** The board's screen as the route has it (the board, the shelf or a book). */
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

const runtime = () => window.__papertie?.runtime as CanvasRuntime
const split = () => document.querySelector('.board-split') as HTMLElement
const pane = () => document.querySelector('.book-pane') as HTMLElement | null
const writerBook = () => document.querySelector('.bk-book') as HTMLElement | null
const boardButton = () => screen.getByRole('button', { name: 'Board' })

function widen(width: number) {
  vi.stubGlobal('innerWidth', width)
  act(() => void window.dispatchEvent(new Event('resize')))
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

const cmdBackslash = (target: EventTarget) =>
  act(
    () =>
      void target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '\\',
          code: 'Backslash',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
  )

let restore: () => void = () => {}
beforeAll(async () => {
  await BookChunk.load()
})
beforeEach(() => {
  localStorage.clear()
  restore = installCanvasStubs()
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

describe('the split view', () => {
  it('a book opens beside the board on a wide window and full width below 1024 px', async () => {
    await openOn(1440)
    expect(split().dataset.layout).toBe('split')
    expect(pane()?.dataset.layout).toBe('split')
    // The board beside it is live: not covered, not inert.
    const board = document.querySelector('.viewport') as HTMLElement
    expect(board.hasAttribute('data-covered')).toBe(false)
    expect(board.closest('[inert]')).toBeNull()
    expect(split().lastElementChild).toBe(pane())
    expect(screen.getByRole('separator', { name: 'Book width' })).toBeTruthy()
    expect(boardButton().getAttribute('aria-pressed')).toBe('true')
    // Narrowed below the split's width: the book full width, over the covered board.
    widen(900)
    expect(split().dataset.layout).toBe('full')
    expect(pane()?.dataset.layout).toBe('full')
    expect(board.hasAttribute('data-covered')).toBe(true)
    expect(screen.queryByRole('separator', { name: 'Book width' })).toBeNull()
    expect(boardButton().getAttribute('aria-pressed')).toBe('false')
  })

  it('the board stays the same runtime and session through split ⇄ full width, and the writer is not remounted', async () => {
    const s = await openOn(1440)
    const rt = runtime()
    const page = writerBook()
    const world = document.querySelector('.world')
    expect(rt).toBeTruthy()
    expect(page).not.toBeNull()
    for (const layout of ['full', 'split', 'full', 'split']) {
      fireEvent.click(boardButton())
      expect(split().dataset.layout).toBe(layout)
      expect(runtime()).toBe(rt)
      expect(writerBook()).toBe(page)
      expect(document.querySelector('.world')).toBe(world)
    }
    expect(window.__papertie?.session ?? s).toBe(s)
    // The choice is kept by the app: full width remembered as the board not beside the book.
    fireEvent.click(boardButton())
    expect(JSON.parse(localStorage.getItem(SPLIT_KEY) ?? 'null')).toMatchObject({ board: false })
  })

  it('dragging the seam resizes the board’s viewport, clamped to 360 and 600 px, and is remembered', async () => {
    await openOn(1440)
    const wrap = split()
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 1440,
      bottom: 900,
      width: 1440,
      height: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const seam = screen.getByRole('separator', { name: 'Book width' })
    const sheet = document.querySelector('.writer') as HTMLElement
    vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue({
      width: 700,
    } as DOMRect)
    const ptr = (type: string, x: number) =>
      act(
        () =>
          void seam.dispatchEvent(
            new MouseEvent(type, { clientX: x, clientY: 400, button: 0, bubbles: true }),
          ),
      )
    ptr('pointerdown', 720)
    // While it is dragged the sheet keeps the width it had (measured again once, at release).
    expect(pane()?.dataset.seam).toBe('drag')
    expect(pane()?.style.getPropertyValue('--sheet-frozen')).toBe('700px')
    const before = wrap.style.getPropertyValue('--book-share')
    /** The pane's width while it is dragged: its own flex basis, a share of the window. */
    const dragged = () => Number.parseFloat(pane()?.style.flexBasis ?? '') / 100
    ptr('pointermove', 100)
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    // The board keeps 360 px: the book takes at most 1080 of 1440.
    expect(dragged()).toBeCloseTo(0.75, 4)
    // Set on the pane itself, not as the wrapper's inherited `--book-share`: a change of that
    // restyled every element of the board and the book each frame (the final perf pass's trace:
    // 6 ms a frame).
    expect(wrap.style.getPropertyValue('--book-share')).toBe(before)
    ptr('pointermove', 1300)
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    // The book keeps 600 px.
    expect(dragged()).toBeCloseTo(600 / 1440, 4)
    expect(wrap.style.getPropertyValue('--book-share')).toBe(before)
    ptr('pointerup', 1300)
    // At the release the share is the wrapper's again, once, and the pane's own basis goes.
    expect(Number(wrap.style.getPropertyValue('--book-share'))).toBeCloseTo(600 / 1440, 4)
    expect(pane()?.style.flexBasis).toBe('')
    expect(pane()?.dataset.seam).toBeUndefined()
    expect(pane()?.style.getPropertyValue('--sheet-frozen')).toBe('')
    const kept = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? 'null') as { ratio: number }
    expect(kept.ratio).toBeCloseTo(600 / 1440, 4)
    expect(seam.getAttribute('aria-valuenow')).toBe('42')
  })

  it('while the seam is dragged the board keeps its canvases’ size (no reallocation a frame), and takes the new one once, at the release', async () => {
    // A ResizeObserver that reports the board's root when told to, as the browser does each frame
    // of a drag (the root shrinks and grows with `--book-share`).
    const observed: { el: Element; fn: ResizeObserverCallback }[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private fn: ResizeObserverCallback) {}
        observe(el: Element) {
          observed.push({ el, fn: this.fn })
        }
        unobserve() {}
        disconnect() {}
      },
    )
    await openOn(1440)
    const board = document.querySelector('.viewport') as HTMLElement
    let width = 1200
    Object.defineProperty(board, 'clientWidth', { configurable: true, get: () => width })
    // The window wide enough that the board may grow past the width it had (the drag's reach).
    vi.spyOn(split(), 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 2000,
      bottom: 900,
      width: 2000,
      height: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const yarn = document.querySelector('canvas.yarn-layer') as HTMLCanvasElement
    const before = yarn.width
    let sized = 0
    const setW = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')
    const setH = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height')
    vi.spyOn(HTMLCanvasElement.prototype, 'width', 'set').mockImplementation(function (
      this: HTMLCanvasElement,
      v: number,
    ) {
      sized++
      setW?.set?.call(this, v)
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'height', 'set').mockImplementation(function (
      this: HTMLCanvasElement,
      v: number,
    ) {
      sized++
      setH?.set?.call(this, v)
    })
    const frame = (w: number) => {
      width = w
      const at = sized
      act(() => {
        for (const o of observed) if (o.el === board) o.fn([], {} as ResizeObserver)
      })
      return sized > at
    }
    const seam = screen.getByRole('separator', { name: 'Book width' })
    const ptr = (type: string, x: number) =>
      act(
        () =>
          void seam.dispatchEvent(
            new MouseEvent(type, { clientX: x, clientY: 400, button: 0, bubbles: true }),
          ),
      )
    ptr('pointerdown', 1200)
    // Narrowed, a frame at a time: the canvases and the yarn's layers keep their size.
    const narrowed = [1180, 1100, 1000, 900, 800].filter(frame)
    expect(narrowed).toEqual([])
    expect(yarn.width).toBe(before)
    // Widened past the width it had: they grow once, to the most the board can take in this drag.
    const widened = [900, 1100, 1250, 1300, 1350, 1390].filter(frame)
    expect(widened.length).toBeLessThanOrEqual(1)
    ptr('pointerup', 1390)
    // At the release the board takes the width it has, once.
    const atRelease = sized
    expect(atRelease).toBeGreaterThan(0)
    expect(yarn.width).toBe(Math.round(1390 * runtime().dpr))
    expect(runtime().viewport.width).toBe(1390)
    // The observer's own report of that size after it sizes nothing again.
    expect(frame(1390)).toBe(false)
  })

  it('the seam’s keyboard path moves it by 5 % and says so', async () => {
    await openOn(1440)
    const seam = screen.getByRole('separator', { name: 'Book width' })
    expect(seam.getAttribute('aria-orientation')).toBe('vertical')
    expect(seam.getAttribute('aria-valuenow')).toBe('50')
    seam.focus()
    const live = () => document.querySelector('[data-live-region]')?.textContent ?? ''
    fireEvent.keyDown(seam, { key: 'ArrowLeft' })
    expect(seam.getAttribute('aria-valuenow')).toBe('55')
    expect(Number(split().style.getPropertyValue('--book-share'))).toBeCloseTo(0.55, 4)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(live()).toContain('Book takes 55% of the window')
    fireEvent.keyDown(seam, { key: 'ArrowRight' })
    fireEvent.keyDown(seam, { key: 'ArrowRight' })
    expect(seam.getAttribute('aria-valuenow')).toBe('45')
    fireEvent.keyDown(seam, { key: 'End' })
    expect(seam.getAttribute('aria-valuenow')).toBe(String(Math.round((1 - 360 / 1440) * 100)))
    fireEvent.keyDown(seam, { key: 'Home' })
    expect(seam.getAttribute('aria-valuenow')).toBe(String(Math.round((600 / 1440) * 100)))
    const kept = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? 'null') as { ratio: number }
    expect(kept.ratio).toBeCloseTo(600 / 1440, 4)
  })

  it('⌘\\ in the writer toggles the board beside it; ⌘\\ on the board opens the last book; Board on a phone goes to the board', async () => {
    await openOn(1440)
    const title = screen.getByRole('textbox', { name: 'Title' })
    cmdBackslash(title)
    expect(split().dataset.layout).toBe('full')
    cmdBackslash(title)
    expect(split().dataset.layout).toBe('split')
    // With the focus on the board, it closes the book side…
    cmdBackslash(document.body)
    expect(location.pathname).toBe('/')
    expect(pane()).toBeNull()
    // …and from the board it opens the last book again (Books' accelerator).
    cmdBackslash(document.body)
    expect(location.pathname).toBe(`/book/${ID}`)
    expect(await screen.findByRole('textbox', { name: 'Title' })).toBeTruthy()
    const books = screen.getAllByRole('button', { name: 'Books' })
    expect(books.some((b) => b.getAttribute('aria-keyshortcuts')?.includes('Meta+\\'))).toBe(true)
    // A phone's width: Board goes to the board, the book kept as the last one; Books comes back.
    widen(390)
    fireEvent.click(boardButton())
    expect(location.pathname).toBe('/')
    cmdBackslash(document.body)
    expect(location.pathname).toBe(`/book/${ID}`)
  })

  it('keys from the book pane never reach the board', async () => {
    const s = await openOn(1440)
    const rt = runtime()
    act(() => rt.selectNotes([N1, N2], 'replace'))
    const notes = s.store.getState().notes
    const control = boardButton()
    control.focus()
    const key = (init: KeyboardEventInit) =>
      act(
        () =>
          void control.dispatchEvent(
            new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
          ),
      )
    key({ key: 'Delete' })
    key({ key: 'Backspace' })
    key({ key: 'f' })
    key({ key: 'c' })
    key({ key: 'z', metaKey: true })
    key({ key: 'k', code: 'KeyK', metaKey: true })
    expect([...rt.selection].sort()).toEqual([N1, N2].sort())
    expect(s.store.getState().notes).toBe(notes)
    // F made no focus (it keeps its state on the address).
    expect(location.hash).toBe('')
    expect(screen.queryByRole('dialog', { name: 'Search notes' })).toBeNull()
    // ⌘K in the board pane still opens the board's search.
    act(
      () =>
        void (document.querySelector('.viewport') as HTMLElement).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true }),
        ),
    )
    expect(screen.getByRole('dialog', { name: 'Search notes' })).toBeTruthy()
  })
})
