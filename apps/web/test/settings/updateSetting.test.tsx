import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { UpdateBridge } from '../../src/app/updates'
import { UPDATES_HINT, UPDATES_LEGEND } from '../../src/settings/Preferences'
import { Settings } from '../../src/settings/Settings'
import { installCanvasStubs } from '../helpers/domCanvas'
import { fakeSession } from './fakeSession'

/*
 * Settings → Preferences, in the desktop app: whether Papertie checks for updates by itself. The
 * choice is the main process's, read and set through the bridge.
 */

const desktop = window as { papertieDesktop?: Partial<UpdateBridge> }

function fakeBridge(initial: boolean) {
  let kept = initial
  const bridge = {
    onUpdateAvailable: vi.fn(),
    openUpdate: vi.fn(),
    dismissUpdate: vi.fn(),
    getUpdateSetting: vi.fn(async () => kept),
    setUpdateSetting: vi.fn(async (on: boolean) => {
      kept = on
      return kept
    }),
  }
  desktop.papertieDesktop = bridge
  return bridge
}

const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement

let restore: () => void = () => {}
beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/settings/preferences')
  restore = installCanvasStubs()
})
afterEach(() => {
  cleanup()
  restore()
  delete desktop.papertieDesktop
  document.body.replaceChildren()
})

describe('Settings → Preferences: Check for updates automatically', () => {
  it('is on as the main process has it, with one honest line under it', async () => {
    fakeBridge(true)
    const { session } = fakeSession()
    render(<Settings section="preferences" session={session} />)
    const group = await screen.findByRole('group', { name: 'Check for updates automatically' })
    expect(UPDATES_LEGEND).toBe('Check for updates automatically')
    expect(radio('On').checked).toBe(true)
    expect(radio('Off').checked).toBe(false)
    const hint = document.getElementById(group.getAttribute('aria-describedby') ?? '')
    expect(hint?.textContent).toBe(
      'Once a day, Papertie asks GitHub whether a newer version exists. Nothing about you or your board is sent.',
    )
    expect(hint?.textContent).toBe(UPDATES_HINT)
  })

  it('switching it off and on tells the main process, and nothing is kept in the page', async () => {
    const bridge = fakeBridge(true)
    const { session } = fakeSession()
    render(<Settings section="preferences" session={session} />)
    await screen.findByRole('group', { name: UPDATES_LEGEND })
    fireEvent.click(radio('Off'))
    expect(bridge.setUpdateSetting).toHaveBeenLastCalledWith(false)
    await waitFor(() => expect(radio('Off').checked).toBe(true))
    fireEvent.click(radio('On'))
    expect(bridge.setUpdateSetting).toHaveBeenLastCalledWith(true)
    await waitFor(() => expect(radio('On').checked).toBe(true))
    expect(localStorage.getItem('papertie.prefs') ?? '').not.toContain('update')
  })

  it('shows what the main process kept: off stays off when it was off', async () => {
    fakeBridge(false)
    const { session } = fakeSession()
    render(<Settings section="preferences" session={session} />)
    await screen.findByRole('group', { name: UPDATES_LEGEND })
    expect(radio('Off').checked).toBe(true)
  })

  it('a choice the main process did not take goes back', async () => {
    const bridge = fakeBridge(true)
    bridge.setUpdateSetting.mockRejectedValueOnce(new Error('no'))
    const { session } = fakeSession()
    render(<Settings section="preferences" session={session} />)
    await screen.findByRole('group', { name: UPDATES_LEGEND })
    fireEvent.click(radio('Off'))
    await waitFor(() => expect(radio('On').checked).toBe(true))
  })

  it('in a browser (no desktop bridge) the control is not there', async () => {
    const { session } = fakeSession()
    render(<Settings section="preferences" session={session} />)
    expect(screen.getByRole('group', { name: 'Paper tilt' })).toBeTruthy()
    await Promise.resolve()
    expect(screen.queryByRole('group', { name: UPDATES_LEGEND })).toBeNull()
    expect(screen.queryByText(UPDATES_HINT)).toBeNull()
  })
})
