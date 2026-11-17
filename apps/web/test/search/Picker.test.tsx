import { type Board, type BoardState, type Note, stateFromRecords } from '@papertie/core'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { matchRange } from '../../src/search/highlight'
import { Picker } from '../../src/search/Picker'
import { releaseSearchIndex, type SearchIndex, searchIndexFor } from '../../src/search/searchIndex'
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

function note(n: number, text: string, over: Partial<Note> = {}): Note {
  return {
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
    updatedAt: T0,
    ...over,
  }
}

const board = (notes: Note[]): BoardState => stateFromRecords(BOARD, notes)

let store: BoardStore | null = null

afterEach(() => {
  if (store) releaseSearchIndex(store)
  store = null
})

/**
 * Every answer the index owes has come and been shown. The index answers in order, so once a
 * question asked now is answered, so are the picker's; a task later React has shown them.
 */
async function settle(): Promise<void> {
  await act(async () => {
    if (store) await searchIndexFor(store).query('', 1)
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function setup(
  state: BoardState,
  props: Partial<Parameters<typeof Picker>[0]> = {},
): Promise<{ onPick: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> }> {
  const onPick = vi.fn()
  const onClose = vi.fn()
  store = createBoardStore(state)
  render(
    <Picker
      store={store}
      title="Connect to…"
      placeholder="Find a note"
      onPick={onPick}
      onClose={onClose}
      {...props}
    />,
  )
  await settle()
  return { onPick, onClose }
}

const input = () => screen.getByRole('combobox') as HTMLInputElement
const typeNow = (value: string) => fireEvent.change(input(), { target: { value } })
/** Type `value` and wait for its answer. */
const type = async (value: string) => {
  typeNow(value)
  await settle()
}
const key = (k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(input(), { key: k, ...init })
const options = () => screen.queryAllByRole('option')

describe('Picker search', () => {
  it('finds a note across width and case (NFKC)', async () => {
    await setup(board([note(1, 'Paris trip'), note(2, 'Turin')]))
    await type('ⓟⓐⓡⓘⓢ')
    expect(options()).toHaveLength(1)
    expect(options()[0]?.textContent).toContain('Paris trip')
  })

  it('emphasises the match inside the snippet', async () => {
    await setup(board([note(1, 'A trip to Paris')]))
    await type('paris')
    const mark = options()[0]?.querySelector('mark')
    expect(mark?.textContent).toBe('Paris')
  })

  it('hides excluded ids', async () => {
    await setup(board([note(1, 'Paris one'), note(2, 'Paris two')]), { exclude: new Set([nid(1)]) })
    await type('paris')
    expect(options()).toHaveLength(1)
    expect(options()[0]?.textContent).toContain('Paris two')
  })

  it('still fills the list when excluded notes rank first', async () => {
    const notes = [note(1, 'paris a', { updatedAt: '2026-10-28T10:00:00.000Z' })]
    for (let i = 2; i <= 12; i++) notes.push(note(i, `paris ${i}`))
    await setup(board(notes), { exclude: new Set([nid(1)]) })
    await type('paris')
    expect(options()).toHaveLength(8)
  })

  it('says so when nothing matches', async () => {
    await setup(board([note(1, 'Turin')]))
    await type('zzz')
    expect(options()).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe('No matching notes')
  })

  it('lists the 8 most recently edited notes for an empty query, newest first', async () => {
    const notes: Note[] = []
    for (let i = 1; i <= 12; i++) {
      notes.push(
        note(i, `note ${i}`, { updatedAt: `2026-10-27T10:${String(i).padStart(2, '0')}:00.000Z` }),
      )
    }
    await setup(board(notes))
    const texts = options().map((o) => o.textContent)
    expect(texts).toHaveLength(8)
    expect(texts[0]).toContain('note 12')
    expect(texts[7]).toContain('note 5')
  })

  it('leaves excluded notes out of the recent list', async () => {
    await setup(board([note(1, 'one'), note(2, 'two')]), { exclude: new Set([nid(2)]) })
    expect(options()).toHaveLength(1)
  })

  it('names an empty note and a picture', async () => {
    await setup(
      board([
        note(1, '', { updatedAt: '2026-10-27T10:05:00.000Z' }),
        note(2, '', {
          updatedAt: '2026-10-27T10:04:00.000Z',
          image: { assetId: `asset_${'0'.repeat(26)}`, frame: 'none' } as Note['image'],
        }),
      ]),
    )
    expect(options().map((o) => o.textContent)).toEqual(['Empty note', 'Picture'])
  })

  it('shows each hit with its paper', async () => {
    await setup(board([note(1, 'Paris', { paper: 'rose' })]))
    await type('paris')
    const swatch = options()[0]?.querySelector('.picker-swatch') as HTMLElement
    expect(swatch.style.background).toContain('--paper-rose')
  })
})

describe('Picker keyboard', () => {
  const three = () =>
    board([
      note(1, 'paris a', { updatedAt: '2026-10-27T10:03:00.000Z' }),
      note(2, 'paris b', { updatedAt: '2026-10-27T10:02:00.000Z' }),
      note(3, 'paris c', { updatedAt: '2026-10-27T10:01:00.000Z' }),
    ])

  it('Enter picks the first hit; Down and Up move', async () => {
    const { onPick } = await setup(three())
    await type('paris')
    key('Enter')
    expect(onPick).toHaveBeenLastCalledWith(nid(1), { alt: false })
    key('ArrowDown')
    key('ArrowDown')
    key('Enter')
    expect(onPick).toHaveBeenLastCalledWith(nid(3), { alt: false })
    key('ArrowUp')
    key('Enter')
    expect(onPick).toHaveBeenLastCalledWith(nid(2), { alt: false })
  })

  it('Alt+Enter picks with Alt (Insert card moves it); Enter and a click without', async () => {
    const { onPick } = await setup(three())
    await type('paris')
    key('Enter', { altKey: true })
    expect(onPick).toHaveBeenLastCalledWith(nid(1), { alt: true })
    key('Enter')
    expect(onPick).toHaveBeenLastCalledWith(nid(1), { alt: false })
    fireEvent.click(options()[1] as HTMLElement, { altKey: true })
    expect(onPick).toHaveBeenLastCalledWith(nid(2), { alt: true })
  })

  it('wraps at both ends', async () => {
    const { onPick } = await setup(three())
    await type('paris')
    key('ArrowUp')
    key('Enter')
    expect(onPick).toHaveBeenLastCalledWith(nid(3), { alt: false })
    key('ArrowDown')
    key('Enter')
    expect(onPick).toHaveBeenLastCalledWith(nid(1), { alt: false })
  })

  it('a click picks that hit', async () => {
    const { onPick } = await setup(three())
    await type('paris')
    fireEvent.click(options()[1] as HTMLElement)
    expect(onPick).toHaveBeenCalledWith(nid(2), { alt: false })
  })

  it('closes on Escape and on Enter with nothing to pick, without picking', async () => {
    const { onPick, onClose } = await setup(three())
    await type('zzz')
    key('Enter')
    expect(onPick).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    key('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a press outside', async () => {
    const { onClose } = await setup(three())
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores the Enter that ends an IME composition', async () => {
    const { onPick } = await setup(three())
    await type('paris')
    key('Enter', { isComposing: true })
    key('Enter', { keyCode: 229 })
    expect(onPick).not.toHaveBeenCalled()
    key('Enter')
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('does not close on the Escape that cancels an IME composition', async () => {
    const { onClose } = await setup(three())
    key('Escape', { isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('with multi, Enter adds and the picker stays open', async () => {
    const { onPick, onClose } = await setup(three(), { multi: true })
    await type('paris')
    key('Enter')
    key('ArrowDown')
    key('Enter')
    expect(onPick.mock.calls).toEqual([
      [nid(1), { alt: false }],
      [nid(2), { alt: false }],
    ])
    expect(onClose).not.toHaveBeenCalled()
    expect(input().value).toBe('paris')
  })

  it('without multi, Enter picks once and leaves closing to the caller', async () => {
    const { onPick, onClose } = await setup(three())
    await type('paris')
    key('Enter')
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Picker accessibility', () => {
  it('wires the combobox to its listbox and the active option', async () => {
    await setup(board([note(1, 'paris a'), note(2, 'paris b')]))
    await type('paris')
    const list = screen.getByRole('listbox')
    expect(input().getAttribute('aria-controls')).toBe(list.id)
    expect(input().getAttribute('aria-expanded')).toBe('true')
    const first = options()[0] as HTMLElement
    expect(input().getAttribute('aria-activedescendant')).toBe(first.id)
    expect(first.getAttribute('aria-selected')).toBe('true')
    key('ArrowDown')
    const second = options()[1] as HTMLElement
    expect(input().getAttribute('aria-activedescendant')).toBe(second.id)
    expect(second.getAttribute('aria-selected')).toBe('true')
    expect(first.getAttribute('aria-selected')).toBe('false')
  })

  it('has no active option when the list is empty', async () => {
    await setup(board([note(1, 'turin')]))
    await type('zzz')
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('is modal, and Tab and Shift+Tab never take the focus out of the field', async () => {
    await setup(board([note(1, 'a')]))
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
    expect(key('Tab')).toBe(false)
    expect(key('Tab', { shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(input())
    // From a row (a click can focus one), Tab brings it back, and Esc still closes.
    const row = options()[0] as HTMLElement
    row.focus()
    fireEvent.keyDown(row, { key: 'Tab' })
    expect(document.activeElement).toBe(input())
  })

  it('is a dialog named by its title, with the focus in the field', async () => {
    await setup(board([note(1, 'a')]), { title: 'Search notes', placeholder: 'Search notes' })
    expect(screen.getByRole('dialog', { name: 'Search notes' })).toBeTruthy()
    expect(document.activeElement).toBe(input())
    expect(input().getAttribute('placeholder')).toBe('Search notes')
  })

  it('announces how many notes match', async () => {
    await setup(board([note(1, 'paris a'), note(2, 'paris b')]))
    await type('paris')
    expect(screen.getByRole('status').textContent).toBe('2 notes')
  })
})

describe('Picker and its index', () => {
  const many = () => {
    const notes: Note[] = []
    for (let i = 1; i <= 2000; i++) notes.push(note(i, `entry ${i}`))
    return board(notes)
  }

  it('says nothing before the first answer, never a wrong "Nothing pinned yet"', () => {
    store = createBoardStore(many())
    render(
      <Picker store={store} title="Find" placeholder="Find" onPick={vi.fn()} onClose={vi.fn()} />,
    )
    expect(options()).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('shows the answer to what is typed now, not to the keys before it', async () => {
    await setup(many())
    typeNow('entry 19')
    typeNow('entry 199')
    typeNow('entry 1998')
    await settle()
    expect(options().map((o) => o.textContent)).toEqual(['entry 1998'])
  })

  it('keeps the last answer on screen until the next one comes', async () => {
    await setup(many())
    await type('entry 1999')
    typeNow('entry 1998')
    expect(options()[0]?.textContent).toContain('entry 1999')
    await settle()
    expect(options()[0]?.textContent).toContain('entry 1998')
  })

  it('Enter before the answer picks from what is typed, once', async () => {
    const { onPick } = await setup(many())
    typeNow('entry 1999')
    key('Enter')
    key('Enter')
    expect(onPick).not.toHaveBeenCalled()
    await settle()
    expect(onPick.mock.calls).toEqual([[nid(1999), { alt: false }]])
  })

  it('clearing the field shows the recent notes again', async () => {
    await setup(many())
    await type('entry 1999')
    await type('')
    expect(options()).toHaveLength(8)
  })

  it('finds a note made after it opened, and never one removed since', async () => {
    await setup(board([note(1, 'paris one'), note(2, 'paris two')]))
    act(() => {
      store?.commit([
        { op: 'note.delete', id: nid(1) },
        { op: 'note.create', note: note(3, 'paris three') },
      ])
    })
    await type('paris')
    expect(
      options()
        .map((o) => o.textContent)
        .sort(),
    ).toEqual(['paris three', 'paris two'])
  })

  it('does not move the list when the board changes under it', async () => {
    await setup(board([note(1, 'paris one'), note(2, 'paris two')]))
    await type('paris')
    act(() => {
      store?.commit([{ op: 'note.create', note: note(3, 'paris three') }])
    })
    await settle()
    expect(options()).toHaveLength(2)
  })
})

describe('Picker with many notes excluded', () => {
  it('still fills the recent list and the hits past more than 56 excluded notes', async () => {
    const notes: Note[] = []
    for (let i = 1; i <= 100; i++) {
      const at = `2026-10-27T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`
      notes.push(note(i, `entry ${i}`, { updatedAt: at }))
    }
    // The 60 edited last are in focus already (Bring in… excludes them).
    const exclude = new Set(notes.slice(40).map((n) => n.id))
    await setup(board(notes), { exclude })
    expect(options()).toHaveLength(8)
    expect(options()[0]?.textContent).toBe('entry 40')
    expect(screen.getByRole('status').textContent).toBe('')
    await type('entry')
    expect(options()).toHaveLength(8)
    for (const o of options()) expect(exclude.has(o.id.slice(-nid(1).length))).toBe(false)
  })
})

describe('Picker first paint', () => {
  afterEach(() => vi.useRealTimers())

  /** An index whose answers come only when `answer` is called. */
  function slowIndex(): SearchIndex & { answer(): void } {
    const due: Array<() => void> = []
    return {
      load: () => {},
      apply: () => {},
      query: () => new Promise((r) => due.push(() => r([]))),
      recent: () => new Promise((r) => due.push(() => r([nid(1)]))),
      dispose: () => {},
      answer: () => {
        for (const f of due.splice(0)) f()
      },
    }
  }

  it('is held until the first answer, so the sheet never shows empty and then grows', async () => {
    const search = slowIndex()
    store = createBoardStore(board([note(1, 'rustic')]))
    render(
      <Picker
        store={store}
        search={search}
        title="Find"
        placeholder="Find"
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const sheet = screen.getByRole('dialog')
    expect(sheet.hasAttribute('data-waiting')).toBe(true)
    // The field has the keyboard already: nothing typed meanwhile goes to the board.
    expect(document.activeElement).toBe(input())
    await act(async () => search.answer())
    expect(sheet.hasAttribute('data-waiting')).toBe(false)
    expect(options()).toHaveLength(1)
  })

  it('is shown after 50 ms whatever happens to the answer', () => {
    vi.useFakeTimers()
    store = createBoardStore(board([note(1, 'rustic')]))
    render(
      <Picker
        store={store}
        search={slowIndex()}
        title="Find"
        placeholder="Find"
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const sheet = screen.getByRole('dialog')
    act(() => vi.advanceTimersByTime(30))
    expect(sheet.hasAttribute('data-waiting')).toBe(true)
    act(() => vi.advanceTimersByTime(30))
    expect(sheet.hasAttribute('data-waiting')).toBe(false)
  })
})

describe('matchRange', () => {
  it('finds the span across width and case', () => {
    expect(matchRange('Go to ⓅⒶⓇⒾⓈ now', 'paris')).toEqual([6, 11])
  })

  it('maps a decomposed-accent match back to the original units', () => {
    expect(matchRange('a cafe\u0301 au', 'café')).toEqual([2, 7])
  })

  it('is null without a match or a query', () => {
    expect(matchRange('hello', 'zzz')).toBeNull()
    expect(matchRange('hello', '  ')).toBeNull()
  })
})
