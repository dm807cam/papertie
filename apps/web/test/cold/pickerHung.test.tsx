/**
 * The picker's chunk never answers (a hung fetch): after 3 s the picker is put away quietly and
 * counted, as a failed load is, and the board's keys are its own again.
 */
import { type Board, stateFromRecords } from '@papertie/core'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { SearchPalette } from '../../src/search/SearchPalette'
import { releaseSearchIndex } from '../../src/search/searchIndex'
import { closeSearch, isSearchOpen } from '../../src/search/searchStore'
import { createBoardStore } from '../../src/store/boardStore'

vi.mock('../../src/search/Picker', () => new Promise(() => {}))

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

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  act(() => closeSearch())
  cleanup()
  vi.useRealTimers()
})

describe('a picker chunk that never comes', () => {
  it('is put away at 3 s, counted, and the board has its keys back', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createBoardStore(stateFromRecords(BOARD, []))
    const rt = { held: false, stopEditing: vi.fn(), focusNote: vi.fn(), selectNote: vi.fn() }
    render(<SearchPalette runtime={rt} store={store} />)
    const board = vi.fn()
    window.addEventListener('keydown', board)
    try {
      fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', metaKey: true })
      expect(isSearchOpen()).toBe(true)
      act(() => vi.advanceTimersByTime(2900))
      expect(isSearchOpen()).toBe(true)
      act(() => vi.advanceTimersByTime(200))
      expect(isSearchOpen()).toBe(false)
      expect(errors.mock.calls.map((c) => String(c[0]))).toContain('picker did not load (1)')
      fireEvent.keyDown(document.body, { key: 'v', code: 'KeyV' })
      expect(board).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', board)
      releaseSearchIndex(store)
      errors.mockRestore()
    }
  })
})
