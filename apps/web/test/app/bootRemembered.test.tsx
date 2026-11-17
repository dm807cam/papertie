/**
 * The boot with a board remembered (the desktop's every relaunch): the board opens
 * from the copy kept here at once, beside the board list, not after it, so the list's round trip
 * (in the desktop app, the main process's first moments) does not hold the first paint. Should the
 * list name another board, that open is let go and the listed board opens instead.
 */
import { render, screen, waitFor } from '@testing-library/react'
import * as boards from '../../src/api/boards'
import { BoardScreen } from '../../src/app/BoardScreen'
import { BOARD_KEY } from '../../src/app/bootstrap'
import * as sessions from '../../src/app/session'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, fakeSession } from '../settings/fakeSession'

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
const NOW = '2026-11-15T09:00:00.000Z'
const _USER_ID = 'user_a'
const OTHER = 'board_01JBX0000000000000000000ZZ'
const summary = (id: string) => ({
  id,
  name: 'My board',
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  recovered: false,
})

let restore: () => void = () => {}
/** Answers a board list still held (the boot is the page's: a held one would hold the next test). */
let answer: (list: ReturnType<typeof summary>[]) => void = () => {}
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  history.replaceState(null, '', '/')
  restore = installCanvasStubs()
})
afterEach(() => {
  answer([summary(BOARD_ID)])
  restore()
})

it('opens the remembered board beside the board list, shown before the list answers', async () => {
  localStorage.setItem(BOARD_KEY, BOARD_ID)
  api.listBoards.mockReturnValue(new Promise((r) => (answer = r)))
  const s = fakeSession()
  open.mockResolvedValue(s.session)
  render(<BoardScreen />)
  // Asked while the list is still on its way.
  await waitFor(() => expect(open).toHaveBeenCalledWith(BOARD_ID, expect.anything()))
  expect(api.listBoards).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(screen.getByTestId('canvas')).toBeTruthy())
  // The list names the same board: nothing more is opened.
  answer([summary(BOARD_ID)])
  await new Promise((r) => setTimeout(r, 20))
  expect(screen.getByTestId('canvas')).toBeTruthy()
  expect(open).toHaveBeenCalledTimes(1)
  expect(s.dispose).not.toHaveBeenCalled()
})

it('a remembered board the list no longer has is let go, and the listed board opens', async () => {
  localStorage.setItem(BOARD_KEY, OTHER)
  api.listBoards.mockResolvedValue([summary(BOARD_ID)])
  const early = fakeSession()
  const listed = fakeSession()
  open.mockImplementation(async (id) => (id === OTHER ? early.session : listed.session))
  render(<BoardScreen />)
  await waitFor(() => expect(screen.getByTestId('canvas')).toBeTruthy())
  expect(open.mock.calls.map(([id]) => id)).toEqual([OTHER, BOARD_ID])
  await waitFor(() => expect(early.dispose).toHaveBeenCalled())
  expect(listed.dispose).not.toHaveBeenCalled()
})
