import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as boards from '../../src/api/boards'
import * as userApi from '../../src/api/data'
import { AppShell } from '../../src/app/AppShell'
import * as router from '../../src/app/router'
import * as sessions from '../../src/app/session'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, fakeSession } from './fakeSession'

vi.mock('../../src/api/boards', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/api/boards')>()
  return {
    ...m,
    listBoards: vi.fn(),
    createBoard: vi.fn(),
    postBatch: vi.fn(),
    loadBoard: vi.fn(),
    boardMeta: vi.fn(),
    listBackups: vi.fn(),
  }
})
vi.mock('../../src/api/data', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/api/data')>()
  return { ...m, deleteAllData: vi.fn() }
})
vi.mock('../../src/app/session', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/app/session')>()
  return { ...m, openServerSession: vi.fn() }
})
vi.mock('../../src/app/router', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/app/router')>()
  return { ...m, loadPage: vi.fn() }
})

/** The one user: no email, no account. */
const _USER = { userId: 'user_one' }

const open = vi.mocked(sessions.openServerSession)
const loadPage = vi.mocked(router.loadPage)
const deleteAll = vi.mocked(userApi.deleteAllData)

function Routed() {
  return <AppShell route={router.useRoute()} />
}

/** No word of an account in what is on screen (text, labels, links). */
function expectNoAccountWords() {
  const text = document.body.textContent ?? ''
  const labels = [...document.querySelectorAll('[aria-label]')].map((e) =>
    e.getAttribute('aria-label'),
  )
  for (const said of [text, ...labels]) {
    expect(said).not.toMatch(/account|e-?mail|sign(ed)? ?(in|out|up)|password|session/i)
  }
}

let restore: () => void = () => {}
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  restore = installCanvasStubs()
  vi.mocked(boards.listBoards).mockResolvedValue([
    {
      id: BOARD_ID,
      name: 'My board',
      revision: 1,
      createdAt: '2026-10-30T09:00:00.000Z',
      updatedAt: '2026-10-30T09:00:00.000Z',
      recovered: false,
    },
  ])
  vi.mocked(boards.listBackups).mockResolvedValue([])
  open.mockResolvedValue(fakeSession().session)
})
afterEach(() => {
  restore()
})

describe('the one user', () => {
  it('opens straight on the board, with nothing of an account', async () => {
    history.replaceState(null, '', '/')
    render(<Routed />)
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeTruthy())
    expect(open).toHaveBeenCalledWith(BOARD_ID, expect.anything())
    expect(location.pathname).toBe('/')
    expectNoAccountWords()
  })

  it('Settings has Export, History, Preferences and Data, with Delete all data', async () => {
    history.replaceState(null, '', '/settings/export')
    render(<Routed />)
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    const tabs = within(within(dialog).getByRole('navigation', { name: 'Settings' }))
      .getAllByRole('link')
      .map((a) => a.textContent)
    expect(tabs).toEqual(['Export', 'History', 'Preferences', 'Data'])
    fireEvent.click(within(dialog).getByRole('link', { name: 'Data' }))
    expect(location.pathname).toBe('/settings/data')
    expect(await screen.findByRole('heading', { name: 'Delete all data' })).toBeTruthy()
    expectNoAccountWords()
  })

  it('/settings opens on Export', async () => {
    history.replaceState(null, '', '/settings')
    render(<Routed />)
    await screen.findByRole('heading', { name: 'Export' })
  })

  it("the sidebar's Settings opens on Export", async () => {
    history.replaceState(null, '', '/')
    render(<Routed />)
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeTruthy())
    fireEvent.click(
      within(document.querySelector('.sidebar') as HTMLElement).getByRole('button', {
        name: 'Settings',
      }),
    )
    expect(location.pathname).toBe('/settings/export')
  })

  it('Delete all data asks for "delete" typed, then lets go of what the page held and opens afresh', async () => {
    deleteAll.mockResolvedValue(undefined)
    history.replaceState(null, '', '/settings/data')
    render(<Routed />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all data…' }))
    expect(screen.getByText(/board, photos, books and backups/)).toBeTruthy()
    const confirm = screen.getByLabelText('Type delete to confirm')
    const go = () => screen.getByRole('button', { name: 'Delete all data' }) as HTMLButtonElement
    expect(go().disabled).toBe(true)
    fireEvent.change(confirm, { target: { value: 'delet' } })
    expect(go().disabled).toBe(true)
    fireEvent.change(confirm, { target: { value: ' Delete ' } })
    expect(go().disabled).toBe(false)
    fireEvent.click(go())
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith('/'))
    expect(deleteAll).toHaveBeenCalledWith(' Delete ')
  })

  it('a failed deletion says so and leaves everything', async () => {
    const { ApiError } = await import('../../src/api/http')
    deleteAll.mockRejectedValue(new ApiError(0, 'network'))
    history.replaceState(null, '', '/settings/data')
    render(<Routed />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all data…' }))
    fireEvent.change(screen.getByLabelText('Type delete to confirm'), {
      target: { value: 'delete' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }))
    await screen.findByText(/Nothing was deleted/)
    expect(loadPage).not.toHaveBeenCalled()
    expectNoAccountWords()
  })
})
