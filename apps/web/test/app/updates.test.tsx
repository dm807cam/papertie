import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UpdateSlip } from '../../src/app/UpdateSlip'
import {
  type AvailableUpdate,
  listenForUpdates,
  showUpdate,
  type UpdateBridge,
  updateBridge,
} from '../../src/app/updates'
import { installCanvasStubs } from '../helpers/domCanvas'

/*
 * The desktop app's update check, in the page: a newer release the main process found is said on a
 * quiet slip, with "Download" and "Later". The page asks GitHub nothing and names no address.
 */

const PAGE = 'https://github.com/dm807cam/papertie/releases/tag/v0.3.1'
const desktop = window as { papertieDesktop?: Partial<UpdateBridge> }

/** A stand-in for the preload's bridge: what the page asked of it, and a way to announce. */
function fakeBridge() {
  let tell: (u: AvailableUpdate) => void = () => {}
  const bridge = {
    onUpdateAvailable: vi.fn((cb: (u: AvailableUpdate) => void) => {
      tell = cb
    }),
    openUpdate: vi.fn(),
    dismissUpdate: vi.fn(),
    getUpdateSetting: vi.fn(async () => true),
    setUpdateSetting: vi.fn(async (on: boolean) => on),
  }
  desktop.papertieDesktop = bridge
  return {
    bridge,
    announce: (u: Partial<AvailableUpdate> = {}) =>
      act(() => tell({ version: '0.3.1', url: PAGE, manual: false, ...u })),
  }
}

const slip = () => screen.queryByRole('note')

let restore: () => void = () => {}
beforeEach(() => {
  restore = installCanvasStubs()
})
afterEach(() => {
  cleanup()
  restore()
  act(() => showUpdate(null))
  delete desktop.papertieDesktop
  document.body.replaceChildren()
})

describe('the update slip', () => {
  it('says the newer version in the notices’ paper, politely, and takes no focus', () => {
    const { announce, bridge } = fakeBridge()
    listenForUpdates()
    expect(bridge.onUpdateAvailable).toHaveBeenCalledTimes(1)
    render(<UpdateSlip writing={null} waiting={false} />)
    expect(slip()).toBeNull()
    const before = document.activeElement

    announce()
    const note = slip() as HTMLElement
    expect(note.textContent).toContain('Papertie 0.3.1 is available.')
    expect(note.className).toBe('sync-slip sync-paper')
    expect(note.closest('section')?.getAttribute('aria-label')).toBe('Updates')
    // Read out by the page's polite live region; the focus stays where it was.
    const live = document.querySelector('[data-live-region]')
    expect(live?.getAttribute('aria-live')).toBe('polite')
    expect(live?.textContent?.trim()).toBe('Papertie 0.3.1 is available.')
    expect(document.activeElement).toBe(before)
    // Two real buttons, in the Tab order.
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Download', 'Later'])
    for (const b of buttons) expect(b.tabIndex).toBe(0)
    // The address is the main process's: the page shows no link to it.
    expect(note.querySelector('a')).toBeNull()
  })

  it('Download asks the main process to open the release page, and the slip goes', () => {
    const { announce, bridge } = fakeBridge()
    listenForUpdates()
    render(<UpdateSlip writing={null} waiting={false} />)
    announce()
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    // No address passes from the page.
    expect(bridge.openUpdate).toHaveBeenCalledWith()
    expect(bridge.dismissUpdate).not.toHaveBeenCalled()
    expect(slip()).toBeNull()
  })

  it('Later dismisses that version; a newer one is said again', () => {
    const { announce, bridge } = fakeBridge()
    listenForUpdates()
    render(<UpdateSlip writing={null} waiting={false} />)
    announce()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(bridge.dismissUpdate).toHaveBeenCalledWith('0.3.1')
    expect(bridge.openUpdate).not.toHaveBeenCalled()
    expect(slip()).toBeNull()

    announce({ version: '0.3.2' })
    expect(slip()?.textContent).toContain('Papertie 0.3.2 is available.')
  })

  it('never lies on the writer’s text: it waits while a book fills the window', () => {
    const { announce } = fakeBridge()
    listenForUpdates()
    const view = render(<UpdateSlip writing="full" waiting={false} />)
    announce()
    expect(slip()).toBeNull()
    // Back at the board (or the shelf), it is there.
    view.rerender(<UpdateSlip writing={null} waiting={false} />)
    expect(slip()).not.toBeNull()
    // Beside the board, it is shown (on the board's pane: `useSlipOnPane`).
    view.rerender(<UpdateSlip writing="split" waiting={false} />)
    expect(slip()).not.toBeNull()
  })

  it('a check asked for through the menu is answered wherever the person is', () => {
    const { announce } = fakeBridge()
    listenForUpdates()
    render(<UpdateSlip writing="full" waiting={false} />)
    announce({ manual: true })
    expect(slip()?.textContent).toContain('Papertie 0.3.1 is available.')
  })

  it('waits while the page’s reload slip stands in its place', () => {
    const { announce } = fakeBridge()
    listenForUpdates()
    const view = render(<UpdateSlip writing={null} waiting={true} />)
    announce()
    expect(slip()).toBeNull()
    view.rerender(<UpdateSlip writing={null} waiting={false} />)
    expect(slip()).not.toBeNull()
  })

  it('a version that is not a plain version is not shown', () => {
    const { announce } = fakeBridge()
    listenForUpdates()
    render(<UpdateSlip writing={null} waiting={false} />)
    announce({ version: '0.3.1 — click here' })
    announce({ version: '' })
    expect(slip()).toBeNull()
  })

  it('in a browser (no desktop bridge) nothing listens and nothing shows', () => {
    expect(updateBridge()).toBeNull()
    expect(() => listenForUpdates()).not.toThrow()
    render(<UpdateSlip writing={null} waiting={false} />)
    expect(slip()).toBeNull()
    // A bridge of an older shape (opened files only) is no update bridge either.
    desktop.papertieDesktop = {}
    expect(updateBridge()).toBeNull()
    expect(() => listenForUpdates()).not.toThrow()
  })
})
