import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as boards from '../../src/api/boards'
import { AppShell } from '../../src/app/AppShell'
import { DEFAULT_PREFS, prefsStore } from '../../src/app/prefs'
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
vi.mock('../../src/app/session', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/app/session')>()
  return { ...m, openServerSession: vi.fn() }
})

vi.mock('../../src/app/router', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/app/router')>()
  return { ...m, loadPage: vi.fn() }
})
const boardsApi = vi.mocked(boards)
const open = vi.mocked(sessions.openServerSession)

function Routed() {
  return <AppShell route={router.useRoute()} />
}

let restore: () => void = () => {}
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  restore = installCanvasStubs()
  boardsApi.listBoards.mockResolvedValue([
    {
      id: BOARD_ID,
      name: 'My board',
      revision: 1,
      createdAt: '2026-10-30T09:00:00.000Z',
      updatedAt: '2026-10-30T09:00:00.000Z',
      recovered: false,
    },
  ])
  boardsApi.listBackups.mockResolvedValue([])
  history.replaceState(null, '', '/settings/history')
})
afterEach(() => restore())

describe('Settings over the board', () => {
  it('lies over the dimmed board, keeps it mounted, and Esc returns to /', async () => {
    open.mockResolvedValue(fakeSession().session)
    render(<Routed />)
    await screen.findByRole('dialog', { name: 'Settings' })
    expect(await screen.findByRole('heading', { name: 'History' })).toBeTruthy()
    // The board is there, its canvas inert under the sheet; the sheet's tabs mark where we are.
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeTruthy())
    expect(document.querySelector('.world')?.hasAttribute('inert')).toBe(true)
    expect(screen.getByRole('link', { name: 'History' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Export' }).getAttribute('aria-current')).toBeNull()

    // Another tab: the board is not opened again.
    fireEvent.click(screen.getByRole('link', { name: 'Preferences' }))
    expect(location.pathname).toBe('/settings/preferences')
    expect(await screen.findByRole('heading', { name: 'Preferences' })).toBeTruthy()
    expect(open).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(location.pathname).toBe('/')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull())
    expect(document.querySelector('.world')?.hasAttribute('inert')).toBe(false)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not leave while an IME is composing, and the close mark leaves', async () => {
    open.mockResolvedValue(fakeSession().session)
    render(<Routed />)
    await screen.findByRole('dialog', { name: 'Settings' })
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true })
    expect(location.pathname).toBe('/settings/history')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(location.pathname).toBe('/')
  })

  it('closes the question in it before the sheet', async () => {
    open.mockResolvedValue(fakeSession().session)
    boardsApi.listBackups.mockResolvedValue([
      {
        id: 'board.20261028T180000Z.r7.jsonl',
        revision: 7,
        takenAt: '2026-10-28T18:00:00.000Z',
        notes: 1,
        yarns: 0,
        books: 0,
        words: 0,
        bytes: 4096,
        damaged: false,
      },
    ])
    render(<Routed />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    const ask = screen.getByRole('alertdialog')
    fireEvent.keyDown(ask.querySelector('button') as HTMLElement, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(location.pathname).toBe('/settings/history')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(location.pathname).toBe('/')
  })

  it('keeps Tab on the sheet and the sidebar, the two things that can be used', async () => {
    open.mockResolvedValue(fakeSession().session)
    render(<Routed />)
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    const sidebar = document.querySelector('.sidebar') as HTMLElement
    const sidebarKeys = [...sidebar.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)')]
    const sheetKeys = [
      ...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled)',
      ),
    ]
    const last = sheetKeys.at(-1) as HTMLElement
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(sidebarKeys[0])
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})

describe('The sidebar stays usable under Settings', () => {
  const sidebarButton = (name: string) =>
    within(document.querySelector('.sidebar') as HTMLElement).getByRole('button', { name })

  let current: ReturnType<typeof fakeSession>
  beforeEach(() => {
    prefsStore.setState({ ...DEFAULT_PREFS })
    current = fakeSession()
    open.mockResolvedValue(current.session)
  })

  it('dims and holds only the canvas: the sidebar and its save dot are not inert', async () => {
    render(<Routed />)
    await screen.findByRole('dialog', { name: 'Settings' })
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeTruthy())
    const stage = document.querySelector('.board-stage') as HTMLElement
    expect(stage.hasAttribute('inert')).toBe(false)
    const viewport = screen.getByTestId('canvas')
    expect(viewport.hasAttribute('data-covered')).toBe(true)
    for (const layer of ['.cork', '.world', '.overlay'])
      expect(viewport.querySelector(layer)?.hasAttribute('inert')).toBe(true)
    const sidebar = document.querySelector('.sidebar') as HTMLElement
    expect(sidebar.closest('[inert]')).toBeNull()
    expect(sidebar.querySelector('.save-dot')?.closest('[inert]')).toBeNull()
    expect(document.querySelector('.settings-sheet')?.hasAttribute('aria-modal')).toBe(false)
  })

  it('shows Settings pressed in the sidebar, and its second click closes Settings', async () => {
    render(<Routed />)
    await screen.findByRole('dialog', { name: 'Settings' })
    const button = sidebarButton('Settings')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(location.pathname).toBe('/')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull())
    expect(sidebarButton('Settings').getAttribute('aria-pressed')).toBe('false')
    // And a click opens it again.
    fireEvent.click(sidebarButton('Settings'))
    expect(location.pathname).toBe('/settings/export')
  })

  it('another tool closes Settings, then acts', async () => {
    render(<Routed />)
    await screen.findByRole('dialog', { name: 'Settings' })
    // Yarn: its colour picker opens over the board, and a colour takes the tool up.
    fireEvent.click(sidebarButton('Yarn'))
    expect(location.pathname).toBe('/')
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'New thread' })).getByRole('radio', {
        name: 'Indigo',
      }),
    )
    expect(prefsStore.getState()).toMatchObject({ tool: 'yarn', yarnColor: 'indigo' })
  })

  it('the save dot opens its popover without closing Settings', async () => {
    render(<Routed />)
    await screen.findByRole('dialog', { name: 'Settings' })
    const dot = document.querySelector('.save-dot') as HTMLElement
    act(() => {
      // The dot shows only when there is something to say.
      current.session.feed.status('offline')
    })
    fireEvent.click(dot)
    expect(location.pathname).toBe('/settings/history')
    expect(await screen.findByRole('dialog', { name: 'Save status' })).toBeTruthy()
  })

  it('keeps the board from reading keys while covered', async () => {
    render(<Routed />)
    await screen.findByRole('dialog', { name: 'Settings' })
    fireEvent.keyDown(window, { key: 'h' })
    expect(prefsStore.getState().tool).toBe('select')
  })
})

describe("The sheet in the board's UI layer", () => {
  beforeEach(() => {
    open.mockResolvedValue(fakeSession().session)
  })

  it('lies in the UI layer (so the board takes none of its presses and wheels) and a press on it closes it', async () => {
    render(<Routed />)
    await screen.findByRole('dialog', { name: 'Settings' })
    const ui = document.querySelector('.viewport > .ui') as HTMLElement
    const veil = ui.querySelector(':scope > .settings-veil') as HTMLElement
    expect(veil).toBeTruthy()
    expect(veil.hasAttribute('inert')).toBe(false)
    // The sidebar, the notices and the save dot's popover share that layer: all of them in use.
    for (const part of ['.sidebar', '.sync-notices'])
      expect(ui.querySelector(`:scope > ${part}`)?.closest('[inert]')).toBeNull()
    // Every notice in one place, at the foot: the recovery slip is stacked with the others,
    // never over the top row of notes.
    expect(ui.querySelector(':scope > .sync-notices > .recovery')).toBeTruthy()
    // A press on the veil itself (the gutters, the dim) closes; one on the sheet does not.
    fireEvent.click(document.querySelector('.settings-sheet') as HTMLElement)
    expect(location.pathname).toBe('/settings/history')
    fireEvent.click(veil)
    expect(location.pathname).toBe('/')
  })

  it('fills the screen under 768 px as a modal sheet, with the mini-bar and the notices held', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width: 767px'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    render(<Routed />)
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const ui = document.querySelector('.viewport > .ui') as HTMLElement
    await waitFor(() => expect(ui.querySelector('.minibar')?.hasAttribute('inert')).toBe(true))
    expect(ui.querySelector('.sync-notices')?.hasAttribute('inert')).toBe(true)
    expect(ui.querySelector('.settings-veil')?.hasAttribute('inert')).toBe(false)
    // Tab never leaves the sheet: the mini-bar behind it is not in the ring.
    const keys = [
      ...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled)',
      ),
    ]
    const last = keys.at(-1) as HTMLElement
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(keys[0])
  })

  it('under 768 px, Y does nothing while the sheet covers the board: no picker over the held mini-bar', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width: 767px'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    render(<Routed />)
    await screen.findByRole('dialog', { name: 'Settings' })
    const ui = document.querySelector('.viewport > .ui') as HTMLElement
    await waitFor(() => expect(ui.querySelector('.minibar')?.hasAttribute('inert')).toBe(true))
    fireEvent.keyDown(window, { key: 'y' })
    fireEvent.keyDown(document.activeElement ?? window, { key: 'y' })
    expect(screen.queryByRole('dialog', { name: 'New thread' })).toBeNull()
    expect(prefsStore.getState().tool).toBe('select')
  })

  it('does not hold them at 768 px and up', async () => {
    render(<Routed />)
    await screen.findByRole('dialog', { name: 'Settings' })
    expect(document.querySelector('.settings-sheet')?.hasAttribute('aria-modal')).toBe(false)
  })
})

describe('Settings over the board (rest)', () => {
  it('shows the recovery slip over the board when it was repaired', async () => {
    boardsApi.boardMeta.mockResolvedValue({
      id: BOARD_ID,
      name: 'My board',
      revision: 2,
      recovery: {
        integrity: 'repaired',
        detectedAt: '2026-10-30T08:00:00.000Z',
        latestBackup: null,
      },
      notes: 0,
      extent: null,
    })
    open.mockResolvedValue(fakeSession({ recovered: true }).session)
    history.replaceState(null, '', '/')
    render(<Routed />)
    expect(
      await screen.findByText('Papertie repaired your board after a problem saving it.'),
    ).toBeTruthy()
  })
})
