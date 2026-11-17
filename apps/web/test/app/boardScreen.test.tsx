import { emptyBoardState } from '@papertie/core'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import * as boards from '../../src/api/boards'
import { ApiError } from '../../src/api/http'
import { BoardScreen } from '../../src/app/BoardScreen'
import { announce } from '../../src/app/liveRegion'
import * as sessions from '../../src/app/session'
import { reloadMessage } from '../../src/sync/notices'
import type { SyncClient } from '../../src/sync/SyncClient'
import { installCanvasStubs } from '../helpers/domCanvas'

vi.mock('../../src/api/boards', () => ({
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  postBatch: vi.fn(),
  loadBoard: vi.fn(),
}))
vi.mock('../../src/app/router', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/app/router')>()
  return { ...m, loadPage: vi.fn() }
})
vi.mock('../../src/app/session', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/app/session')>()
  return { ...m, openServerSession: vi.fn() }
})

const api = vi.mocked(boards)
const open = vi.mocked(sessions.openServerSession)
const NOW = '2026-10-29T09:00:00.000Z'
const ID = 'board_01JBX0000000000000000000AA'
const _USER = { userId: 'user_a' }

/** A server session's shape on a local board: its client is a stand-in. */
function fakeSession() {
  const s = sessions.openLocalSession({
    kind: 'local',
    state: emptyBoardState(ID, 'My board', NOW),
    label: 'test',
  })
  const sync = { unsavedJsonl: () => '', pending: 0 }
  const session: sessions.BoardSession = {
    ...s,
    sync: sync as unknown as SyncClient,
    boardId: ID,
    dispose: vi.fn(),
  }
  return { session, sync }
}

let restore: () => void = () => {}
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  history.replaceState(null, '', '/')
  restore = installCanvasStubs()
  api.listBoards.mockResolvedValue([
    { id: ID, name: 'My board', revision: 1, createdAt: NOW, updatedAt: NOW, recovered: false },
  ])
})
afterEach(() => restore())

describe('BoardScreen', () => {
  it('makes one first board under StrictMode, then opens it on the canvas', async () => {
    let resolveList: (v: boards.BoardSummary[]) => void = () => {}
    api.listBoards.mockReturnValue(new Promise((r) => (resolveList = r)))
    api.createBoard.mockResolvedValue({
      id: ID,
      name: 'My board',
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
      recovered: false,
    })
    api.postBatch.mockResolvedValue({
      clientId: 'tab_x',
      seq: 1,
      revision: 1,
      now: NOW,
      duplicate: false,
    })
    const { session } = fakeSession()
    open.mockResolvedValue(session)
    render(
      <StrictMode>
        <BoardScreen />
      </StrictMode>,
    )
    // Before the first paint: the bare cork, saying nothing (no loading screen, no progress).
    expect(document.querySelector('main.stage')).toBeTruthy()
    expect(document.body.textContent).toBe('')
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
    resolveList([])
    expect(await screen.findByTestId('canvas')).toBeTruthy()
    expect(api.listBoards).toHaveBeenCalledTimes(1)
    expect(api.createBoard).toHaveBeenCalledTimes(1)
    expect(open.mock.calls.at(-1)?.[0]).toBe(ID)
    expect(screen.getByTestId('save-dot')).toBeTruthy()
  })

  it('while the store is out of reach, the cork says what it waits for', async () => {
    open.mockImplementation((_id, o) => {
      o?.feed?.status('offline')
      return new Promise(() => {})
    })
    render(<BoardScreen />)
    expect(
      await screen.findByText('Your board opens as soon as Papertie can read it.'),
    ).toBeTruthy()
    expect(screen.queryByText(/loading/i)).toBeNull()
  })

  it('an opening that fails after its first paint ends as a failed open would', async () => {
    const { session } = fakeSession()
    let fail: (e: unknown) => void = () => {}
    const done = new Promise<void>((_, reject) => {
      fail = reject
    })
    open.mockResolvedValue({ ...session, opening: { ...session.opening, open: true, done } })
    render(<BoardScreen />)
    await screen.findByTestId('canvas')
    act(() => fail(new ApiError(404, 'not-found')))
    expect(await screen.findByText('Couldn’t open your board')).toBeTruthy()
    expect(session.dispose).toHaveBeenCalled()
  })

  it('says the board is open, and how many notes it holds, once the opening is over', async () => {
    const { session } = fakeSession()
    let end: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      end = resolve
    })
    open.mockResolvedValue({ ...session, opening: { ...session.opening, open: true, done } })
    render(<BoardScreen />)
    await screen.findByTestId('canvas')
    const region = () => document.querySelector('[data-live-region]')?.textContent?.trim()
    announce('Earlier')
    // Nothing while the board is still coming in: it may hold more than it shows.
    expect(region()).toBe('Earlier')
    await act(async () => end())
    expect(region()).toBe('Your board is open: no notes yet')
  })

  it('a page that cannot fetch what it needs to keep saving: the slip says so with a Reload button, over the board, and is announced once', async () => {
    const { session } = fakeSession()
    open.mockResolvedValue(session)
    render(<BoardScreen />)
    const canvas = await screen.findByTestId('canvas')
    const region = () => document.querySelector('[data-live-region]')?.textContent?.trim()
    announce('Earlier')
    const reload = vi.fn()
    const was = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: { ...was, reload } })
    try {
      expect(reloadMessage()).toBe('Papertie needs a reload to keep saving.')
      act(() => session.feed.notice({ kind: 'updated', count: 0, message: reloadMessage() }))
      const slip = document.querySelector('.sync-updated [data-kind="updated"]') as HTMLElement
      expect(within(slip).getByText(reloadMessage())).toBeTruthy()
      // Said through the page's live region, which a screen reader hears change; the slip
      // mounts with its words, so it is no live region itself.
      expect(region()).toBe(reloadMessage())
      expect(document.querySelector('.sync-updated[aria-live]')).toBeNull()
      // Outside the board's stage: still there (and pressable) while the board is inert.
      expect(canvas.parentElement?.contains(slip)).toBe(false)
      act(() => session.feed.notice({ kind: 'updated', count: 0, message: reloadMessage() }))
      expect(document.querySelectorAll('.sync-updated')).toHaveLength(1)
      fireEvent.click(within(slip).getByRole('button', { name: 'Reload' }))
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: was })
    }
  })
})
