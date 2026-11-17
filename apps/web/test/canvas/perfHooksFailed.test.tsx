import { emptyBoardState } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { openLocalSession } from '../../src/app/session'
import { CanvasView } from '../../src/canvas/CanvasView'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, T0 } from '../helpers/fakeServer'

// The bench's perf hooks are a chunk of their own: one that fails to load.
vi.mock('../../src/perf/perfHooks', () => {
  throw new Error('chunk failed')
})

let restore: () => void = () => {}
beforeEach(() => {
  vi.useFakeTimers()
  restore = installCanvasStubs()
})
afterEach(() => {
  cleanup()
  restore()
  vi.useRealTimers()
})

describe('the perf hooks fail to load', () => {
  it('the page is never ready, says why once, and nothing is left unhandled', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const session = openLocalSession({
      kind: 'local',
      state: emptyBoardState(BOARD_ID, 'Test board', T0),
      label: 'test',
    })
    render(<CanvasView session={session} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(window.__papertie?.ready).toBe(false)
    expect(window.__papertie?.notReady).toMatch(/perf hooks did not load/)
    expect(errors.mock.calls.filter((c) => /perf hooks/.test(String(c[0])))).toHaveLength(1)
    session.dispose()
  })
})
