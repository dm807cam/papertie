/**
 * The note picker before its chunk is in (run without `test/setup/chunks.ts`): ⌘K right after
 * the board opens still opens the palette, once the chunk arrives, with nothing shown before it.
 */
import { type Board, stateFromRecords } from '@papertie/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { PickerChunk } from '../../src/search/LazyPicker'
import { SearchPalette } from '../../src/search/SearchPalette'
import { releaseSearchIndex } from '../../src/search/searchIndex'
import { closeSearch, isSearchOpen, openSearch } from '../../src/search/searchStore'
import { createBoardStore } from '../../src/store/boardStore'

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

afterEach(() => {
  act(() => closeSearch())
  cleanup()
})

describe('the picker chunk', () => {
  it('while it loads, a dead key and a letter typed in a note editor land there; Tab, F-keys and chords go on', () => {
    const store = createBoardStore(stateFromRecords(BOARD, []))
    const rt = { held: false, stopEditing: vi.fn(), focusNote: vi.fn(), selectNote: vi.fn() }
    render(createElement(SearchPalette, { runtime: rt, store }))
    // A note being written (Connect to… and Bring in… leave the editor where it is).
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    editor.tabIndex = 0
    document.body.append(editor)
    editor.focus()
    try {
      act(() => openSearch())
      const press = (target: Element, init: KeyboardEventInit) => {
        const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
        target.dispatchEvent(e)
        return e.defaultPrevented
      }
      // `´` then `e` (é), as a dead key composes it: neither is taken from the editor.
      expect(press(editor, { key: 'Dead', code: 'Equal' })).toBe(false)
      expect(press(editor, { key: 'e', code: 'KeyE' })).toBe(false)
      expect(press(editor, { key: 'Process', keyCode: 229 } as KeyboardEventInit)).toBe(false)
      expect(press(editor, { key: 'a', isComposing: true })).toBe(false)
      // On the board: Tab, F-keys and chords go on; a plain letter waits for the picker.
      for (const init of [
        { key: 'Tab' },
        { key: 'F5' },
        { key: 'v', shiftKey: true, altKey: true },
      ])
        expect(press(document.body, init), init.key).toBe(false)
      expect(press(document.body, { key: 'v', code: 'KeyV' })).toBe(true)
    } finally {
      editor.remove()
      releaseSearchIndex(store)
    }
  })

  it('keys typed between ⌘K and the chunk arriving are not the board’s shortcuts', async () => {
    const store = createBoardStore(stateFromRecords(BOARD, []))
    const rt = { held: false, stopEditing: vi.fn(), focusNote: vi.fn(), selectNote: vi.fn() }
    render(createElement(SearchPalette, { runtime: rt, store }))
    // The board's shortcuts (C, V…) listen on the window, as the canvas's do.
    const board = vi.fn()
    window.addEventListener('keydown', board)
    try {
      fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', metaKey: true })
      for (const key of ['c', 'v', 'C'])
        fireEvent.keyDown(document.body, { key, code: `Key${key.toUpperCase()}` })
      expect(board.mock.calls.map((c) => (c[0] as KeyboardEvent).key)).toEqual([])
      // Esc while it comes puts the palette away.
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(isSearchOpen()).toBe(false)
    } finally {
      window.removeEventListener('keydown', board)
      releaseSearchIndex(store)
    }
  })

  it('⌘K before the picker is in opens the palette once it is, showing nothing until then', async () => {
    const store = createBoardStore(stateFromRecords(BOARD, []))
    const rt = { held: false, stopEditing: vi.fn(), focusNote: vi.fn(), selectNote: vi.fn() }
    const view = render(createElement(SearchPalette, { runtime: rt, store }))
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', metaKey: true })
    expect(rt.stopEditing).toHaveBeenCalledTimes(1)
    // Not in yet: nothing at all (no loading state).
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(view.container.textContent).toBe('')
    await act(async () => {
      await PickerChunk.load()
    })
    expect(await screen.findByRole('dialog', { name: 'Search notes' })).toBeTruthy()
    // In now: closed and opened again, it is there in the same commit.
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', metaKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', metaKey: true })
    expect(screen.getByRole('dialog', { name: 'Search notes' })).toBeTruthy()
    // Closed, the board has its keys again.
    const board = vi.fn()
    window.addEventListener('keydown', board)
    act(() => closeSearch())
    fireEvent.keyDown(document.body, { key: 'v', code: 'KeyV' })
    window.removeEventListener('keydown', board)
    expect(board).toHaveBeenCalledTimes(1)
    releaseSearchIndex(store)
  })
})
