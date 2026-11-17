import { render, screen, waitFor } from '@testing-library/react'
import { AppShell } from '../../src/app/AppShell'
import { useRoute } from '../../src/app/router'
import * as sessions from '../../src/app/session'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, fakeSession } from '../settings/fakeSession'

/*
 * The page's boot: with no accounts there is no session to check, so the first
 * request is the board list itself.
 */

vi.mock('../../src/app/session', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/app/session')>()
  return { ...m, openServerSession: vi.fn() }
})
const open = vi.mocked(sessions.openServerSession)

const NOW = '2026-11-14T09:00:00.000Z'
const BOARDS = [
  { id: BOARD_ID, name: 'My board', revision: 1, createdAt: NOW, updatedAt: NOW, recovered: false },
]

function Routed() {
  return <AppShell route={useRoute()} />
}

let asked: string[] = []
let restore: () => void = () => {}
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  history.replaceState(null, '', '/')
  restore = installCanvasStubs()
  asked = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), location.origin).pathname
      asked.push(path)
      if (path === '/api/boards')
        return new Response(JSON.stringify(BOARDS), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 })
    }),
  )
  open.mockResolvedValue(fakeSession().session)
})
afterEach(() => {
  restore()
  vi.unstubAllGlobals()
})

describe('boot', () => {
  it('asks for the board list first, with no session or "who am I" request before it', async () => {
    render(<Routed />)
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeTruthy())
    expect(asked[0]).toBe('/api/boards')
    expect(asked.filter((p) => /^\/api\/(me|auth|account|session)/.test(p))).toEqual([])
    // The user came with the list, and the board opened for them.
    expect(open).toHaveBeenCalledWith(BOARD_ID, expect.anything())
  })

  it('a book opened by its address boots the same way: the board list first', async () => {
    history.replaceState(null, '', '/shelf')
    render(<Routed />)
    await waitFor(() => expect(open).toHaveBeenCalled())
    expect(asked[0]).toBe('/api/boards')
    expect(asked.filter((p) => /^\/api\/(me|auth|account|session)/.test(p))).toEqual([])
  })
})
