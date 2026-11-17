/**
 * The note picker's chunk will not load (its prefetch failed): ⌘K, Connect to…
 * and Bring in… each close their picker quietly, count the failure, and leave the board as it
 * was, in use. Opened again once the network is back, the chunk is fetched again. (Run without
 * `test/setup/chunks.ts`: the chunk is not in.)
 */
import { type Board, stateFromRecords } from '@papertie/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import { FocusChip } from '../../src/focus/FocusChip'
import { SearchPalette } from '../../src/search/SearchPalette'
import { releaseSearchIndex } from '../../src/search/searchIndex'
import { closeSearch, isSearchOpen, openSearch } from '../../src/search/searchStore'
import { createBoardStore } from '../../src/store/boardStore'
import { closeConnect, connectFrom, openConnect } from '../../src/yarn/connectStore'
import { YarnLayer } from '../../src/yarn/YarnLayer'
import { A, chainRuntime } from '../focus/board'
import { installCanvasStubs } from '../helpers/domCanvas'

const net = vi.hoisted(() => ({ online: false, tries: 0 }))
vi.mock('../../src/search/Picker', async (importOriginal) => {
  net.tries++
  if (!net.online) throw new Error('Failed to fetch dynamically imported module')
  return importOriginal()
})

const T0 = '2026-10-27T10:00:00.000Z'
const BOARD: Board = {
  type: 'board',
  schemaVersion: 6,
  id: `board_${'0'.repeat(25)}1`,
  name: 'Test',
  revision: 0,
  clients: {},
  createdAt: T0,
  updatedAt: T0,
}

let restore: () => void = () => {}
const runtimes: CanvasRuntime[] = []
beforeEach(() => {
  restore = installCanvasStubs()
})
afterEach(() => {
  act(() => {
    closeSearch()
    closeConnect()
  })
  cleanup()
  for (const rt of runtimes.splice(0)) rt.dispose()
  restore()
})

/** Let the failed import settle and React take it. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))

describe('the picker chunk will not load', () => {
  it('⌘K, Connect to… and Bring in… close their picker and leave the board in use; opened again online, it loads', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createBoardStore(stateFromRecords(BOARD, []))
    const rt = { held: false, stopEditing: vi.fn(), focusNote: vi.fn(), selectNote: vi.fn() }
    const chain = chainRuntime()
    runtimes.push(chain.rt)
    const board = render(
      <main data-testid="board">
        <p>the board</p>
        <SearchPalette runtime={rt} store={store} />
        <YarnLayer runtime={chain.rt} store={chain.store} />
        <FocusChip runtime={chain.rt} store={chain.store} />
      </main>,
    )

    // ⌘K: the palette is put away, the board stays.
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', metaKey: true })
    await settle()
    expect(isSearchOpen()).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('the board')).toBeTruthy()

    // Connect to…: the same.
    act(() => openConnect(A))
    await settle()
    expect(connectFrom()).toBeNull()
    expect(screen.getByText('the board')).toBeTruthy()

    // Bring in…: the same, and the focus chip is still there to use.
    act(() => chain.rt.setFocus({ seeds: [A], depth: 1, include: [] }))
    fireEvent.click(screen.getByRole('button', { name: 'Bring in…' }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Bring in…' }).getAttribute('aria-expanded'),
    ).not.toBe('true')
    expect(board.getByTestId('board').isConnected).toBe(true)

    // Each failure counted in the console, nothing more.
    expect(
      errors.mock.calls.filter((c) => /^picker did not load \(\d+\)$/.test(String(c[0]))),
    ).toHaveLength(3)

    // The board has its keys: a plain key reaches it.
    const keys = vi.fn()
    window.addEventListener('keydown', keys)
    fireEvent.keyDown(document.body, { key: 'v', code: 'KeyV' })
    window.removeEventListener('keydown', keys)
    expect(keys).toHaveBeenCalledTimes(1)

    // Back online: ⌘K tries the chunk again, and the palette opens.
    const before = net.tries
    net.online = true
    act(() => openSearch())
    expect(await screen.findByRole('dialog', { name: 'Search notes' })).toBeTruthy()
    expect(net.tries).toBeGreaterThan(before)
    releaseSearchIndex(store)
    errors.mockRestore()
  })
})
