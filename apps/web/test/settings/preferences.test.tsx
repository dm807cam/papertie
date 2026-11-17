import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_PREFS, prefsStore } from '../../src/app/prefs'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { Settings } from '../../src/settings/Settings'
import { canvasElements, installCanvasStubs } from '../helpers/domCanvas'
import { fakeSession } from './fakeSession'

let restore: () => void = () => {}
beforeEach(() => {
  localStorage.clear()
  prefsStore.setState({ ...DEFAULT_PREFS })
  history.replaceState(null, '', '/settings/preferences')
  restore = installCanvasStubs()
})
afterEach(() => {
  cleanup()
  restore()
  document.body.replaceChildren()
})

describe('Settings preferences', () => {
  it('preferences change prefsStore and the runtime applies them without reload', () => {
    const { session } = fakeSession()
    const els = canvasElements()
    const rt = new CanvasRuntime(els, session.store)
    render(<Settings section="preferences" session={session} />)

    // Motion: the runtime puts the choice on <html>, where the motion tokens read it.
    expect(document.documentElement.dataset.motion).toBe('system')
    fireEvent.click(screen.getByRole('radio', { name: 'Reduced' }))
    expect(prefsStore.getState().motion).toBe('reduced')
    expect(document.documentElement.dataset.motion).toBe('reduced')
    fireEvent.click(screen.getByRole('radio', { name: 'Full' }))
    expect(document.documentElement.dataset.motion).toBe('full')

    // Wheel: a plain scroll pans, then (no remount) zooms.
    const scroll = () =>
      act(() => {
        els.root.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 100, clientX: 400, clientY: 300, cancelable: true }),
        )
      })
    const before = rt.camera.get()
    scroll()
    expect(rt.camera.get().zoom).toBe(before.zoom)
    expect(rt.camera.get().y).not.toBe(before.y)
    fireEvent.click(screen.getByRole('radio', { name: 'Zoom' }))
    expect(prefsStore.getState().wheel).toBe('zoom')
    const panned = rt.camera.get()
    scroll()
    expect(rt.camera.get().zoom).not.toBe(panned.zoom)

    // Tilt: two choices like their neighbours, the store's, and what the canvas
    // reads at its next frame.
    const tilted = screen.getByRole('radio', { name: 'Tilted' }) as HTMLInputElement
    const straight = screen.getByRole('radio', { name: 'Straight' }) as HTMLInputElement
    expect(screen.getByRole('group', { name: 'Paper tilt' })).toBeTruthy()
    expect(tilted.checked).toBe(true)
    fireEvent.click(straight)
    expect(prefsStore.getState().tilt).toBe(false)
    expect(straight.checked).toBe(true)
    expect(screen.queryByRole('switch')).toBeNull()
    rt.dispose()
    expect(document.documentElement.dataset.motion).toBeUndefined()
  })

  it('keeps the choices in local storage', () => {
    const { session } = fakeSession()
    render(<Settings section="preferences" session={session} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Reduced' }))
    expect(JSON.parse(localStorage.getItem('papertie.prefs') ?? '{}').motion).toBe('reduced')
  })

  it('makes each choice a group of real radio buttons, so the arrow keys move between them', () => {
    const { session } = fakeSession()
    render(<Settings section="preferences" session={session} />)
    expect((screen.getByRole('radio', { name: 'System' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).name)).toEqual([
      'motion',
      'motion',
      'motion',
      'wheel',
      'wheel',
      'tilt',
      'tilt',
    ])
  })
})
