import { type Board, type Note, stateFromRecords } from '@papertie/core'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { SearchPalette, type SearchTarget } from '../../src/search/SearchPalette'
import { releaseSearchIndex, searchIndexFor } from '../../src/search/searchIndex'
import { closeSearch, isSearchOpen, openSearch } from '../../src/search/searchStore'
import { type BoardStore, createBoardStore } from '../../src/store/boardStore'

const T0 = '2026-10-27T10:00:00.000Z'
const nid = (n: number) => `note_${String(n).padStart(26, '0')}`
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
const note = (n: number, text: string): Note => ({
  type: 'note',
  id: nid(n),
  x: 0,
  y: 0,
  w: 240,
  h: 160,
  z: n,
  paper: 'cream',
  style: 'rustic',
  text,
  image: null,
  createdAt: T0,
  updatedAt: `2026-10-27T10:0${n}:00.000Z`,
})

let store: BoardStore | null = null

/** The index has answered everything asked so far, and React has shown it. */
async function settle(): Promise<void> {
  await act(async () => {
    if (store) await searchIndexFor(store).query('', 1)
    await new Promise((r) => setTimeout(r, 0))
  })
}

function setup(texts = ['Paris trip', 'Turin food', 'Old churches'], held = false) {
  const state = stateFromRecords(
    BOARD,
    texts.map((t, i) => note(i + 1, t)),
  )
  store = createBoardStore(state)
  const calls: string[] = []
  const rt: SearchTarget = {
    held,
    stopEditing: vi.fn(() => void calls.push('stopEditing')),
    focusNote: vi.fn((id: string) => {
      calls.push(`focus ${id}`)
      return true
    }),
    selectNote: vi.fn((id: string | null) => void calls.push(`select ${id}`)),
  }
  const view = render(<SearchPalette runtime={rt} store={store} />)
  return { rt, calls, view }
}

const cmdK = (target: Element = document.body, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key: 'k', code: 'KeyK', metaKey: true, ...init })

afterEach(() => {
  act(() => closeSearch())
  if (store) releaseSearchIndex(store)
  store = null
})

describe('SearchPalette', () => {
  it('opens on ⌘K and on Ctrl+K as "Search notes", and closes on the same key', () => {
    setup()
    expect(screen.queryByRole('dialog')).toBeNull()
    cmdK()
    expect(screen.getByRole('dialog', { name: 'Search notes' })).toBeTruthy()
    cmdK()
    expect(screen.queryByRole('dialog')).toBeNull()
    cmdK(document.body, { metaKey: false, ctrlKey: true })
    expect(screen.getByRole('dialog', { name: 'Search notes' })).toBeTruthy()
  })

  it('ignores K with other modifiers or none', () => {
    setup()
    cmdK(document.body, { metaKey: false })
    cmdK(document.body, { shiftKey: true })
    cmdK(document.body, { altKey: true })
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens from a layout where K is not the key (by its place)', () => {
    setup()
    cmdK(document.body, { key: 'л' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('opens on ⌘K while a folded part of the board is inert (the selection group, a closed sheet)', () => {
    const { view } = setup()
    // The sidebar's selection group folds away inert while nothing is selected.
    const folded = document.createElement('div')
    folded.setAttribute('inert', '')
    view.container.append(folded)
    cmdK()
    expect(screen.getByRole('dialog', { name: 'Search notes' })).toBeTruthy()
  })

  it('stays shut while the board is held (under a screen or a sheet over it)', () => {
    setup(undefined, true)
    cmdK()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Esc gives the focus to the board when what had it is gone (a sheet search replaced)', () => {
    store = createBoardStore(stateFromRecords(BOARD, [note(1, 'a')]))
    const rt: SearchTarget = {
      held: false,
      stopEditing() {},
      focusNote: () => true,
      selectNote() {},
    }
    render(
      <main className="viewport">
        <button type="button">in a sheet</button>
        <SearchPalette runtime={rt} store={store} />
      </main>,
    )
    const inSheet = screen.getByRole('button', { name: 'in a sheet' })
    inSheet.focus()
    cmdK()
    inSheet.remove()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('main.viewport'))
  })

  it('Esc gives the focus to the board when it was on <body> as search opened', () => {
    store = createBoardStore(stateFromRecords(BOARD, [note(1, 'a')]))
    const rt: SearchTarget = {
      held: false,
      stopEditing() {},
      focusNote: () => true,
      selectNote() {},
    }
    render(
      <main className="viewport">
        <SearchPalette runtime={rt} store={store} />
      </main>,
    )
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    cmdK()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('main.viewport'))
  })

  it('opens through openSearch, which the sidebar button uses', () => {
    setup()
    act(() => openSearch())
    expect(screen.getByRole('dialog', { name: 'Search notes' })).toBeTruthy()
  })

  it('lists the recently edited notes first', async () => {
    setup()
    cmdK()
    await settle()
    expect(screen.getAllByRole('option')[0]?.textContent).toContain('Old churches')
  })

  it('from inside the note editor it closes the editor first, then opens', () => {
    const { calls, view } = setup()
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    view.container.append(editor)
    editor.focus()
    cmdK(editor)
    expect(calls).toEqual(['stopEditing'])
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('picking focuses the note at zoom 1, selects it and closes', async () => {
    const { rt, calls } = setup()
    cmdK()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'turin' } })
    await settle()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(rt.focusNote).toHaveBeenCalledWith(nid(2), 1)
    expect(rt.selectNote).toHaveBeenCalledWith(nid(2))
    expect(calls.slice(-2)).toEqual([`focus ${nid(2)}`, `select ${nid(2)}`])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(isSearchOpen()).toBe(false)
  })

  it('does not select a note that is gone', async () => {
    const { rt } = setup()
    vi.mocked(rt.focusNote).mockReturnValue(false)
    cmdK()
    await settle()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(rt.selectNote).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Esc closes it and gives the keyboard back to where it was', () => {
    const { view } = setup()
    const button = document.createElement('button')
    view.container.append(button)
    button.focus()
    cmdK(button)
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(button)
  })
})
