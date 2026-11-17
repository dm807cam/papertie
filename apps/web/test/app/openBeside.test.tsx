/**
 * A board that opens with a book beside it (the split view the app keeps): its opening is
 * for the board's part of the window, not the whole window (the final perf pass). Read for the
 * window, the first paint read the tiles of a view twice the board's width, and a remembered
 * camera clamped to the least zoom was clamped about the window's middle: on the book's side of
 * the board, where the lifetime board has no notes, so it showed nothing until it was in whole.
 */
import { render, waitFor } from '@testing-library/react'
import * as boards from '../../src/api/boards'
import { BoardScreen } from '../../src/app/BoardScreen'
import { BOARD_KEY } from '../../src/app/bootstrap'
import { boardViewport, SPLIT_KEY } from '../../src/app/screenMemory'
import * as sessions from '../../src/app/session'
import { installCanvasStubs } from '../helpers/domCanvas'

vi.mock('../../src/api/boards', () => ({
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  postBatch: vi.fn(),
  loadBoard: vi.fn(),
}))
vi.mock('../../src/app/session', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/app/session')>()
  return { ...m, openServerSession: vi.fn() }
})

const api = vi.mocked(boards)
const open = vi.mocked(sessions.openServerSession)
const NOW = '2026-10-29T09:00:00.000Z'
const ID = 'board_01JBX0000000000000000000AA'
const BOOK_ID = 'book_01JBX0000000000000000000BB'
const _USER = { userId: 'user_a' }

let restore: () => void = () => {}
beforeEach(() => {
  localStorage.clear()
  restore = installCanvasStubs()
  api.listBoards.mockResolvedValue([
    { id: ID, name: 'My board', revision: 1, createdAt: NOW, updatedAt: NOW, recovered: false },
  ])
})
afterEach(() => {
  restore()
  vi.unstubAllGlobals()
})

describe('the board’s viewport beside a book', () => {
  it('is the window less the book’s share when the split is kept and fits, else the window', () => {
    // The split's share is kept clamped to the window it is read in.
    vi.stubGlobal('innerWidth', 1600)
    localStorage.setItem(SPLIT_KEY, JSON.stringify({ ratio: 0.5, board: true }))
    expect(boardViewport(1600, 900, true)).toEqual({ width: 800, height: 900 })
    // The book keeps its least (600 px) and the board its least (360 px).
    localStorage.setItem(SPLIT_KEY, JSON.stringify({ ratio: 0.2, board: true }))
    expect(boardViewport(1600, 900, true)).toEqual({ width: 1000, height: 900 })
    localStorage.setItem(SPLIT_KEY, JSON.stringify({ ratio: 0.9, board: true }))
    expect(boardViewport(1600, 900, true)).toEqual({ width: 360, height: 900 })
    // Too narrow for the split, the board not wanted beside the book, or no book: the window.
    vi.stubGlobal('innerWidth', 900)
    expect(boardViewport(900, 700, true)).toEqual({ width: 900, height: 700 })
    vi.stubGlobal('innerWidth', 1600)
    localStorage.setItem(SPLIT_KEY, JSON.stringify({ ratio: 0.5, board: false }))
    expect(boardViewport(1600, 900, true)).toEqual({ width: 1600, height: 900 })
    localStorage.setItem(SPLIT_KEY, JSON.stringify({ ratio: 0.5, board: true }))
    expect(boardViewport(1600, 900, false)).toEqual({ width: 1600, height: 900 })
  })

  it('opened at /book/<id> on a wide window, the session opens for the board’s half', async () => {
    vi.stubGlobal('innerWidth', 1600)
    vi.stubGlobal('innerHeight', 900)
    localStorage.setItem(BOARD_KEY, ID)
    localStorage.setItem(SPLIT_KEY, JSON.stringify({ ratio: 0.5, board: true }))
    history.replaceState(null, '', `/book/${BOOK_ID}`)
    open.mockReturnValue(new Promise(() => {}))
    render(<BoardScreen books={{ kind: 'book', bookId: BOOK_ID }} />)
    await waitFor(() => expect(open).toHaveBeenCalled())
    expect(open.mock.calls[0]?.[1]?.viewport).toEqual({ width: 800, height: 900 })
  })
})
