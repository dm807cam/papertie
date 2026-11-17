import { applyBatch, emptyBoardState } from '@papertie/core'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { prefsStore } from '../../src/app/prefs'
import { rememberScreen } from '../../src/app/screenMemory'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { screenToWorld } from '../../src/canvas/Camera'
import { CanvasView } from '../../src/canvas/CanvasView'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import { closeSearch, isSearchOpen } from '../../src/search/searchStore'
import { createBoardStore } from '../../src/store/boardStore'
import { attachBooks } from '../../src/sync/books/bookStore'
import { SaveDot } from '../../src/sync/SaveDot'
import { registerPhotoPicker } from '../../src/ui/photoPicker'
import { Sidebar } from '../../src/ui/Sidebar'
import { book } from '../helpers/books'
import { installCanvasStubs, VIEWPORT } from '../helpers/domCanvas'
import { BOARD_ID, T0 } from '../helpers/fakeServer'

let restore: () => void = () => {}
const sessions: BoardSession[] = []

function emptyBoard(): BoardSession {
  const state = applyBatch(emptyBoardState(BOARD_ID, 'Test board', T0), [], { now: T0 })
  const session = openLocalSession({ kind: 'local', state, label: 'test' })
  sessions.push(session)
  return session
}

/** Let the frame loop run and React mount what it shows. */
const frames = (ms = 50) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

const runtime = () => window.__papertie?.runtime as CanvasRuntime

/** Make `(max-width: 767px)` match, or not. */
function stubNarrow(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (q: string) =>
      ({
        matches: q.includes('max-width') && matches,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  restore = installCanvasStubs()
  prefsStore.setState({
    tool: 'select',
    noteColor: 'cream',
    noteStyle: 'rustic',
    noteDecoration: 'none',
    noteSheet: 'rose',
    yarnColor: 'apricot',
    sidebar: 'open',
  })
})
afterEach(() => {
  cleanup()
  for (const s of sessions.splice(0)) s.dispose()
  act(() => closeSearch())
  document.body.replaceChildren()
  restore()
  history.replaceState(null, '', '/')
  vi.useRealTimers()
})

/** The buttons a user can reach: not those of a folded part of the panel. */
const reachable = (root: HTMLElement) =>
  within(root)
    .getAllByRole('button')
    .filter((b) => b.closest('[inert]') === null)
    .map((b) => b.getAttribute('aria-label') ?? b.textContent)

const picker = () => screen.getByRole('dialog', { name: 'New note' })
const radio = (group: string, name: string) =>
  within(within(picker()).getByRole('group', { name: group })).getByRole('radio', { name })
const yarnPicker = () => screen.getByRole('dialog', { name: 'New thread' })
const dye = (name: string) => within(yarnPicker()).getByRole('radio', { name }) as HTMLInputElement

describe('sidebar', () => {
  it('every sidebar control has an accessible name and fires its command', () => {
    const picked = vi.fn()
    const off = registerPhotoPicker(picked)
    render(<Sidebar onNewNote={() => {}} foot={<button type="button">Saved</button>} />)
    const bar = screen.getByRole('toolbar', { name: 'Tools' })

    // One control per action, in the mockup's order, with the save dot at the foot. No pan,
    // marquee, text tool or palette: the cork, Shift and "+" do those.
    expect(reachable(bar)).toEqual([
      'Papertie — hide tools',
      'New note',
      'Select',
      'Yarn',
      'Photo',
      'Search',
      'Saved',
      'Books',
      'Settings',
    ])
    expect(within(bar).queryByRole('link')).toBeNull()
    for (const b of within(bar).getAllByRole('button')) {
      expect(b.getAttribute('aria-disabled')).toBeNull()
    }

    // Tools: set the tool, show it pressed, and name their key in the tooltip. Yarn takes its
    // colour first, in its picker.
    for (const [name, tool, key] of [
      ['Yarn', 'yarn', 'Y'],
      ['Select', 'select', 'V'],
    ] as const) {
      const b = within(bar).getByRole('button', { name })
      expect(b.getAttribute('title')).toBe(`${name} (${key})`)
      fireEvent.click(b)
      if (tool === 'yarn') fireEvent.click(dye('Crimson'))
      expect(prefsStore.getState().tool).toBe(tool)
      expect(b.getAttribute('aria-pressed')).toBe('true')
      expect(bar.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1)
    }

    const photo = within(bar).getByRole('button', { name: 'Photo' })
    expect(photo.getAttribute('title')).toBe('Photo (P)')
    fireEvent.click(photo)
    expect(picked).toHaveBeenCalledTimes(1)
    off()

    const search = within(bar).getByRole('button', { name: 'Search' })
    expect(search.getAttribute('title')).toMatch(/^Search \((⌘K|Ctrl\+K)\)$/)
    fireEvent.click(search)
    expect(isSearchOpen()).toBe(true)

    fireEvent.click(within(bar).getByRole('button', { name: 'Settings' }))
    expect(location.pathname).toBe('/settings/export')
  })

  it('"+" opens the paper picker on the last design used; Enter pins the choice', () => {
    prefsStore.setState({ noteColor: 'sage', noteStyle: 'smooth', noteDecoration: 'fold' })
    const onNewNote = vi.fn()
    render(<Sidebar onNewNote={onNewNote} />)
    const plus = screen.getByRole('button', { name: 'New note' })
    expect(plus.getAttribute('aria-haspopup')).toBe('dialog')
    expect(plus.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(plus)
    expect(plus.getAttribute('aria-expanded')).toBe('true')

    // Eight papers, two styles, and the decorations: none, the four motifs, stamp, a sheet.
    const papers = within(within(picker()).getByRole('group', { name: 'Paper' }))
    expect(papers.getAllByRole('radio')).toHaveLength(8)
    expect(
      within(within(picker()).getByRole('group', { name: 'Style' }))
        .getAllByRole('radio')
        .map((r) => r.getAttribute('aria-label') ?? r.closest('label')?.textContent),
    ).toEqual(['Rustic', 'Smooth'])
    expect(
      within(within(picker()).getByRole('group', { name: 'Decoration' }))
        .getAllByRole('radio')
        .map((r) => r.getAttribute('aria-label')),
    ).toEqual(['None', 'Fold', 'Margin', 'Dots', 'Perforation', 'Stamp', 'Layered sheet'])
    // The last design is chosen already, and the focus is on its paper.
    expect((radio('Paper', 'Sage') as HTMLInputElement).checked).toBe(true)
    expect((radio('Style', 'Smooth') as HTMLInputElement).checked).toBe(true)
    expect((radio('Decoration', 'Fold') as HTMLInputElement).checked).toBe(true)
    expect(radio('Decoration', 'Stamp').closest('label')?.getAttribute('title')).toBe('Stamp')
    expect(radio('Paper', 'Ochre').closest('label')?.getAttribute('title')).toBe('Ochre')
    expect(document.activeElement).toBe(radio('Paper', 'Sage'))

    fireEvent.click(radio('Paper', 'Rose'))
    fireEvent.click(radio('Style', 'Rustic'))
    fireEvent.click(radio('Decoration', 'Stamp'))
    expect(onNewNote).not.toHaveBeenCalled()
    fireEvent.keyDown(radio('Decoration', 'Stamp'), { key: 'Enter' })

    expect(onNewNote).toHaveBeenCalledTimes(1)
    expect(onNewNote).toHaveBeenCalledWith({
      paper: 'rose',
      style: 'rustic',
      decoration: 'stamp',
      sheet: 'rose',
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(plus.getAttribute('aria-expanded')).toBe('false')
    // Remembered, for the next "+".
    expect(prefsStore.getState()).toMatchObject({
      noteColor: 'rose',
      noteStyle: 'rustic',
      noteDecoration: 'stamp',
    })
  })

  it('a layered sheet unfolds its colours; Esc leaves without pinning or remembering', () => {
    const onNewNote = vi.fn()
    render(<Sidebar onNewNote={onNewNote} />)
    const plus = screen.getByRole('button', { name: 'New note' })
    fireEvent.click(plus)
    const sheets = () => picker().querySelector('.note-picker-sheets') as HTMLElement
    expect(sheets().hasAttribute('inert')).toBe(true)
    fireEvent.click(radio('Decoration', 'Layered sheet'))
    expect(sheets().hasAttribute('inert')).toBe(false)
    fireEvent.click(radio('Sheet', 'Indigo'))
    fireEvent.click(within(picker()).getByRole('button', { name: 'Pin note' }))
    expect(onNewNote).toHaveBeenCalledWith({
      paper: 'cream',
      style: 'rustic',
      decoration: 'layered',
      sheet: 'indigo',
    })

    fireEvent.click(plus)
    expect((radio('Decoration', 'Layered sheet') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(radio('Paper', 'Ink'))
    fireEvent.keyDown(picker(), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(plus)
    expect(onNewNote).toHaveBeenCalledTimes(1)
    expect(prefsStore.getState().noteColor).toBe('cream')

    // "+" again while it is open closes it too.
    fireEvent.click(plus)
    fireEvent.click(plus)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the mark folds the panel to itself and unrolls it again, remembered by the app', () => {
    render(<Sidebar onNewNote={() => {}} foot={<button type="button">Saved</button>} />)
    const bar = screen.getByRole('toolbar', { name: 'Tools' })
    const mark = within(bar).getByRole('button', { name: 'Papertie — hide tools' })
    expect(mark.getAttribute('aria-expanded')).toBe('true')
    expect(mark.getAttribute('aria-controls')?.split(' ')).toEqual([
      bar.querySelector('.sidebar-body')?.id,
      bar.querySelector('.sidebar-tail')?.id,
    ])

    fireEvent.click(mark)
    expect(prefsStore.getState().sidebar).toBe('folded')
    expect(mark.getAttribute('aria-expanded')).toBe('false')
    expect(mark.getAttribute('aria-label')).toBe('Papertie — show tools')
    expect(bar.hasAttribute('data-folded')).toBe(true)
    // Folded, only the mark is left to reach, and the save dot's foot, which is never folded
    // away (it shows on the tile only while it has something to say).
    expect(reachable(bar)).toEqual(['Papertie — show tools', 'Saved'])

    fireEvent.click(mark)
    expect(prefsStore.getState().sidebar).toBe('open')
    expect(mark.getAttribute('aria-expanded')).toBe('true')
    expect(reachable(bar)).toContain('Settings')
  })

  it('folded, an offline or failing save dot stays on the tile, its status spoken outside the panel', () => {
    for (const status of ['offline', 'error'] as const) {
      const { unmount } = render(
        <div className="ui">
          <Sidebar
            onNewNote={() => {}}
            foot={<SaveDot status={status} onOpenDetail={() => {}} />}
          />
        </div>,
      )
      const bar = screen.getByRole('toolbar', { name: 'Tools' })
      fireEvent.click(within(bar).getByRole('button', { name: 'Papertie — hide tools' }))
      const dot = within(bar).getByTestId('save-dot')
      // Reachable on the folded tile: neither it nor its foot is folded away.
      expect(dot.closest('[inert]')).toBeNull()
      expect(dot.closest('.sidebar-body')).toBeNull()
      expect(
        within(bar).getByRole('button', { name: 'Settings' }).closest('[inert]'),
      ).not.toBeNull()
      // The live region is the UI layer's, outside anything that folds.
      const live = screen.getByRole('status')
      expect(live.textContent).toBe(dot.getAttribute('aria-label'))
      expect(live.closest('.sidebar')).toBeNull()
      expect(live.closest('.ui')).not.toBeNull()
      unmount()
      prefsStore.setState({ sidebar: 'open' })
    }
  })

  it('the save dot moves to the tile only once it has faded out, and back the same way; the sheet scrolls to its top', () => {
    prefsStore.setState({ motion: 'full' })
    render(
      <div className="ui">
        <Sidebar onNewNote={() => {}} foot={<SaveDot status="offline" onOpenDetail={() => {}} />} />
      </div>,
    )
    const bar = screen.getByRole('toolbar', { name: 'Tools' })
    const sheet = bar.querySelector('.sidebar-sheet') as HTMLElement
    sheet.scrollTop = 40
    expect(bar.dataset.foot).toBe('panel')
    fireEvent.click(within(bar).getByRole('button', { name: 'Papertie — hide tools' }))
    // Folding: it fades where it is first, then rests on the tile.
    expect(bar.dataset.foot).toBe('panel')
    act(() => {
      vi.advanceTimersByTime(120)
    })
    expect(bar.dataset.foot).toBe('tile')
    expect(sheet.scrollTop).toBe(0)
    fireEvent.click(within(bar).getByRole('button', { name: 'Papertie — show tools' }))
    expect(bar.dataset.foot).toBe('tile')
    act(() => {
      vi.advanceTimersByTime(120)
    })
    expect(bar.dataset.foot).toBe('panel')
    // Reduced motion: at once.
    prefsStore.setState({ motion: 'reduced' })
    fireEvent.click(within(bar).getByRole('button', { name: 'Papertie — hide tools' }))
    expect(bar.dataset.foot).toBe('tile')
    prefsStore.setState({ motion: 'system', sidebar: 'open' })
  })

  it('the picker closes on a press outside it, on Esc wherever the focus is, and as the focus leaves', () => {
    render(
      <div className="ui">
        <Sidebar onNewNote={() => {}} />
        <button type="button">elsewhere</button>
      </div>,
    )
    const plus = screen.getByRole('button', { name: 'New note' })
    fireEvent.click(plus)
    expect(picker()).toBeTruthy()
    // It lives in the UI layer, never inside the panel (which clips as it folds).
    expect(picker().closest('.sidebar')).toBeNull()
    expect(picker().closest('.ui')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(plus)
    plus.focus()
    fireEvent.keyDown(plus, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(plus)

    fireEvent.click(plus)
    const radio = within(picker()).getAllByRole('radio')[0] as HTMLElement
    const away = screen.getByRole('button', { name: 'elsewhere' })
    fireEvent.blur(radio, { relatedTarget: away })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Safari: a click inside the picker that sends the focus to the board around it keeps it open', () => {
    // Safari focuses neither radios nor buttons on a click: the focus goes to the nearest
    // focusable ancestor instead, here the board itself.
    render(
      <main className="viewport" tabIndex={-1} data-testid="board">
        <div className="ui">
          <Sidebar onNewNote={() => {}} />
        </div>
      </main>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    const radios = within(picker()).getAllByRole('radio')
    fireEvent.blur(radios[0] as HTMLElement, { relatedTarget: screen.getByTestId('board') })
    expect(screen.queryByRole('dialog')).toBeTruthy()
    fireEvent.blur(radios[0] as HTMLElement, { relatedTarget: picker() })
    expect(screen.queryByRole('dialog')).toBeTruthy()
    fireEvent.click(radios[3] as HTMLElement)
    expect((radios[3] as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByRole('dialog')).toBeTruthy()
  })

  it('a resize keeps the picker open and places it again; Enter while an IME composes pins nothing', () => {
    const onNewNote = vi.fn()
    render(<Sidebar onNewNote={onNewNote} />)
    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(picker()).toBeTruthy()
    expect(picker().style.top).not.toBe('')
    const paper = radio('Paper', 'Cream')
    fireEvent.keyDown(paper, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(paper, { key: 'Enter', keyCode: 229 })
    expect(onNewNote).not.toHaveBeenCalled()
    expect(picker()).toBeTruthy()
    fireEvent.keyDown(paper, { key: 'Enter' })
    expect(onNewNote).toHaveBeenCalledTimes(1)
  })

  it('Yarn opens the colour picker on the last colour; a colour arms the tool in it', () => {
    prefsStore.setState({ yarnColor: 'sage' })
    render(<Sidebar onNewNote={() => {}} />)
    const yarn = screen.getByRole('button', { name: 'Yarn' })
    expect(yarn.getAttribute('aria-haspopup')).toBe('dialog')
    expect(yarn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(yarn)
    expect(yarn.getAttribute('aria-expanded')).toBe('true')
    // Not armed until a colour is chosen.
    expect(prefsStore.getState().tool).toBe('select')

    // The eight dyes, a radio group of a named dialog; the last colour chosen, and focused.
    const dyes = within(within(yarnPicker()).getByRole('group', { name: 'Colour' }))
    expect(dyes.getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual([
      'Undyed',
      'Rose',
      'Crimson',
      'Indigo',
      'Moss',
      'Lilac',
      'Ochre',
      'Ink',
    ])
    // Its tooltip is its name.
    expect(dye('Crimson').closest('label')?.getAttribute('title')).toBe('Crimson')
    expect(dye('Moss').checked).toBe(true)
    expect(document.activeElement).toBe(dye('Moss'))
    // It lives in the UI layer's place for pickers, never inside the panel.
    expect(yarnPicker().closest('.sidebar')).toBeNull()

    // One press on a colour chooses it: the picker goes, and the tool is armed in it.
    fireEvent.click(dye('Indigo'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(prefsStore.getState()).toMatchObject({ tool: 'yarn', yarnColor: 'indigo' })
    expect(yarn.getAttribute('aria-pressed')).toBe('true')
    expect(yarn.getAttribute('aria-expanded')).toBe('false')

    // Armed, Yarn opens it again, for the colour of the next threads.
    fireEvent.click(yarn)
    expect(dye('Indigo').checked).toBe(true)
    fireEvent.click(dye('Ochre'))
    expect(prefsStore.getState()).toMatchObject({ tool: 'yarn', yarnColor: 'ochre' })
  })

  it('the arrows move between the colours, Enter or Space chooses; Esc chooses nothing', () => {
    render(<Sidebar onNewNote={() => {}} />)
    const yarn = screen.getByRole('button', { name: 'Yarn' })
    fireEvent.click(yarn)
    // An arrow checks the next radio, with a click event of its own (as browsers do): it moves.
    fireEvent.keyDown(dye('Crimson'), { key: 'ArrowRight' })
    fireEvent.click(dye('Indigo'))
    fireEvent.keyUp(dye('Indigo'), { key: 'ArrowRight' })
    expect(dye('Indigo').checked).toBe(true)
    expect(prefsStore.getState().tool).toBe('select')
    // Enter while an IME composes chooses nothing; Enter chooses.
    fireEvent.keyDown(dye('Indigo'), { key: 'Enter', isComposing: true })
    expect(yarnPicker()).toBeTruthy()
    fireEvent.keyDown(dye('Indigo'), { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(prefsStore.getState()).toMatchObject({ tool: 'yarn', yarnColor: 'indigo' })

    // Space presses the focused radio: that is a choice too.
    fireEvent.click(yarn)
    fireEvent.keyDown(dye('Indigo'), { key: 'ArrowLeft' })
    fireEvent.click(dye('Crimson'))
    fireEvent.keyUp(dye('Crimson'), { key: 'ArrowLeft' })
    fireEvent.keyDown(dye('Crimson'), { key: ' ' })
    fireEvent.click(dye('Crimson'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(prefsStore.getState().yarnColor).toBe('apricot')

    // Esc: nothing chosen or remembered, the focus back on Yarn.
    prefsStore.setState({ tool: 'select' })
    fireEvent.click(yarn)
    fireEvent.keyDown(dye('Crimson'), { key: 'ArrowRight' })
    fireEvent.click(dye('Indigo'))
    fireEvent.keyDown(yarnPicker(), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(yarn)
    expect(prefsStore.getState()).toMatchObject({ tool: 'select', yarnColor: 'apricot' })

    // Yarn again while it is open closes it; so does a press outside.
    fireEvent.click(yarn)
    fireEvent.click(yarn)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(yarn)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(prefsStore.getState().tool).toBe('select')
  })

  it('one picker at a time: "+" and Yarn put each other away', () => {
    render(<Sidebar onNewNote={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    expect(picker()).toBeTruthy()
    const yarn = screen.getByRole('button', { name: 'Yarn' })
    fireEvent.pointerDown(yarn)
    fireEvent.click(yarn)
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull()
    expect(yarnPicker()).toBeTruthy()
    const plus = screen.getByRole('button', { name: 'New note' })
    fireEvent.pointerDown(plus)
    fireEvent.click(plus)
    expect(screen.queryByRole('dialog', { name: 'New thread' })).toBeNull()
    expect(picker()).toBeTruthy()
  })

  it('Safari: a click on a colour that sends the focus to the board around it still chooses', () => {
    render(
      <main className="viewport" tabIndex={-1} data-testid="board">
        <div className="ui">
          <Sidebar onNewNote={() => {}} />
        </div>
      </main>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Yarn' }))
    fireEvent.blur(dye('Crimson'), { relatedTarget: screen.getByTestId('board') })
    expect(yarnPicker()).toBeTruthy()
    fireEvent.click(dye('Moss'))
    expect(prefsStore.getState()).toMatchObject({ tool: 'yarn', yarnColor: 'sage' })
  })

  it('folding closes the paper picker', () => {
    render(<Sidebar onNewNote={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    expect(picker()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Papertie — hide tools' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('mini-bar replaces sidebar under 768 px', () => {
    stubNarrow(true)
    const { unmount } = render(
      <Sidebar onNewNote={() => {}} foot={<span data-testid="dot">dot</span>} />,
    )
    const bar = screen.getByRole('toolbar', { name: 'Tools' })
    expect(bar.className).toBe('minibar')
    // The save dot has its own slot in the pill, at its end after Settings, so at
    // rest it reads as the pill's end, not a hole: never on the board.
    const slot = within(bar).getByTestId('dot').closest('.minibar-foot')
    expect(slot?.parentElement?.className).toBe('minibar-tools')
    expect(slot?.previousElementSibling?.getAttribute('aria-label')).toBe('Settings')
    expect(slot?.nextElementSibling).toBeNull()
    expect(reachable(bar)).toEqual([
      'New note',
      'Select',
      'Yarn',
      'Photo',
      'Search',
      'Books',
      'Settings',
    ])
    unmount()
    stubNarrow(false)
    render(<Sidebar onNewNote={() => {}} />)
    expect(screen.getByRole('toolbar', { name: 'Tools' }).className).toBe('sidebar')
  })

  it("the mini-bar's Yarn opens the same colour picker, outside the pill", () => {
    stubNarrow(true)
    render(<Sidebar onNewNote={() => {}} />)
    const yarn = screen.getByRole('button', { name: 'Yarn' })
    fireEvent.click(yarn)
    expect(yarnPicker().closest('.minibar')).toBeNull()
    // Opened from the pill: its dyes take a finger's 44 px (pickerSheet.css).
    expect(yarnPicker().getAttribute('data-at')).toBe('minibar')
    expect(yarn.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(dye('Ochre'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(prefsStore.getState()).toMatchObject({ tool: 'yarn', yarnColor: 'ochre' })
    stubNarrow(false)
  })
})

describe('Books', () => {
  const BOOK = `book_${'0'.repeat(25)}9`

  it('Books goes to the shelf and back to the board; the mark still folds the panel', () => {
    localStorage.clear()
    render(<Sidebar onNewNote={() => {}} boardId={BOARD_ID} />)
    const books = () => screen.getByRole('button', { name: 'Books' })
    // In the panel's tail, above Settings; its book is drawn, and hidden from assistive tech.
    expect(books().closest('.sidebar-tail')).not.toBeNull()
    expect(books().nextElementSibling?.getAttribute('aria-label')).toBe('Settings')
    expect(books().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(books().textContent).toBe('')
    expect(books().getAttribute('aria-pressed')).toBe('false')

    // Nothing remembered: the shelf. Pressed there, back to the board.
    act(() => fireEvent.click(books()))
    expect(location.pathname).toBe('/shelf')
    expect(books().getAttribute('aria-pressed')).toBe('true')
    act(() => fireEvent.click(books()))
    expect(location.pathname).toBe('/')
    expect(books().getAttribute('aria-pressed')).toBe('false')

    // The last book screen of this board: the book it was in (while it is on the shelf).
    const state = applyBatch(
      emptyBoardState(BOARD_ID, 'Test board', T0),
      [{ op: 'book.create', book: { ...book(BOOK), trashedAt: null } }],
      { now: T0 },
    )
    attachBooks(createBoardStore(state))
    rememberScreen(BOARD_ID, { screen: 'book', bookId: BOOK })
    rememberScreen(BOARD_ID, { screen: 'board' })
    act(() => fireEvent.click(books()))
    expect(location.pathname).toBe(`/book/${BOOK}`)
    expect(books().getAttribute('aria-pressed')).toBe('true')
    act(() => fireEvent.click(books()))
    expect(location.pathname).toBe('/')
    attachBooks(null)

    // The mark still folds the panel, Books with it, and unrolls it again.
    const mark = screen.getByRole('button', { name: 'Papertie — hide tools' })
    act(() => fireEvent.click(mark))
    expect(prefsStore.getState().sidebar).toBe('folded')
    expect(books().closest('[inert]')).not.toBeNull()
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Papertie — show tools' })))
    expect(prefsStore.getState().sidebar).toBe('open')
    expect(books().closest('[inert]')).toBeNull()
  })

  it('the mini-bar has Books between Search and Settings; under a book sheet only Books, Search, Settings and the dot', () => {
    stubNarrow(true)
    const { rerender } = render(
      <Sidebar onNewNote={() => {}} boardId={BOARD_ID} foot={<span data-testid="dot" />} />,
    )
    const bar = () => screen.getByRole('toolbar', { name: 'Tools' })
    expect(reachable(bar())).toEqual([
      'New note',
      'Select',
      'Yarn',
      'Photo',
      'Search',
      'Books',
      'Settings',
    ])
    rerender(
      <Sidebar onNewNote={() => {}} boardId={BOARD_ID} books foot={<span data-testid="dot" />} />,
    )
    expect(reachable(bar())).toEqual(['Books', 'Search', 'Settings'])
    expect(within(bar()).getByTestId('dot')).toBeTruthy()
    stubNarrow(false)
  })
})

describe('sidebar on the board', () => {
  it('+ pins a note of the chosen design at the viewport centre and opens its editor', async () => {
    render(<CanvasView session={emptyBoard()} />)
    await frames()
    const rt = runtime()
    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    fireEvent.click(radio('Paper', 'Indigo'))
    fireEvent.click(radio('Style', 'Smooth'))
    fireEvent.click(radio('Decoration', 'Margin'))
    fireEvent.click(within(picker()).getByRole('button', { name: 'Pin note' }))
    await frames()

    const notes = [...rt.store.getState().notes.values()]
    expect(notes).toHaveLength(1)
    const [n] = notes
    if (n === undefined) throw new Error('no note')
    expect(n).toMatchObject({ paper: 'indigo', style: 'smooth', motif: 'margin' })
    expect(n.stamp).toBeUndefined()
    expect(n.layered).toBeUndefined()
    const c = screenToWorld(rt.camera.get(), { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 })
    expect(n.x + n.w / 2).toBeCloseTo(c.x, 0)
    expect(n.y + n.h / 2).toBeCloseTo(c.y, 0)
    expect(rt.editing).toBe(n.id)
    expect(rt.selection.has(n.id)).toBe(true)
  })

  it('a stamp or a layered sheet is pinned with the note', async () => {
    render(<CanvasView session={emptyBoard()} />)
    await frames()
    const rt = runtime()
    const pin = async (decoration: string, sheet?: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'New note' }))
      fireEvent.click(radio('Decoration', decoration))
      if (sheet !== undefined) fireEvent.click(radio('Sheet', sheet))
      fireEvent.keyDown(picker(), { key: 'Enter' })
      await frames()
      const id = rt.editing
      if (id === null) throw new Error('not writing')
      rt.store.commit([{ op: 'note.update', id, set: { text: 'kept' } }])
      rt.stopEditing()
      return rt.store.getState().notes.get(id)
    }
    expect(await pin('Stamp')).toMatchObject({ stamp: true })
    const layered = await pin('Layered sheet', 'Ochre')
    expect(layered).toMatchObject({ layered: 'ochre' })
    expect(layered?.stamp).toBeUndefined()
    expect(layered?.motif).toBeUndefined()
  })

  it('with notes selected the sidebar offers Duplicate, Focus and Delete, and they act', async () => {
    const session = emptyBoard()
    render(<CanvasView session={session} />)
    await frames()
    const rt = runtime()
    const bar = screen.getByRole('toolbar', { name: 'Tools' })
    const group = within(bar).getByRole('group', { name: 'Selection' })
    // Nothing selected: the section is folded away and takes no focus.
    expect(group.hasAttribute('inert')).toBe(true)

    const a = rt.createNoteAt({ x: 0, y: 0 })
    if (a === undefined) throw new Error('no note')
    rt.store.commit([{ op: 'note.update', id: a, set: { text: 'one' } }])
    rt.stopEditing()
    await frames()
    act(() => rt.selectNotes([a], 'replace'))
    expect(group.hasAttribute('inert')).toBe(false)
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘D' : 'Ctrl+D'
    const button = (name: string) => within(group).getByRole('button', { name })
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.getAttribute('title')),
    ).toEqual([`Duplicate (${mod})`, 'Focus (F)', 'Delete (⌫)'])
    expect(button('Delete').getAttribute('aria-keyshortcuts')).toBe('Delete Backspace')

    // Duplicate copies the design with the text, and selects the copy.
    fireEvent.click(button('Duplicate'))
    expect(rt.store.getState().notes.size).toBe(2)
    const [copy] = rt.selection
    expect(copy).not.toBe(a)
    expect(rt.store.getState().notes.get(copy as string)?.text).toBe('one')

    fireEvent.click(button('Focus'))
    expect(rt.focusState).not.toBeNull()

    fireEvent.click(button('Delete'))
    expect(rt.store.getState().notes.has(copy as string)).toBe(false)
    await frames()
    expect(group.hasAttribute('inert')).toBe(true)
  })

  it('Delete in the section removes every selected note, in one undo step', async () => {
    const session = emptyBoard()
    render(<CanvasView session={session} />)
    await frames()
    const rt = runtime()
    const ids = [0, 400, 800].map((x, i) => {
      const id = rt.createNoteAt({ x, y: 0 })
      if (id === undefined) throw new Error('no note')
      rt.store.commit([{ op: 'note.update', id, set: { text: `n${i}` } }])
      rt.stopEditing()
      return id
    })
    await frames()
    act(() => rt.selectNotes(ids.slice(0, 2), 'replace'))
    const group = screen.getByRole('group', { name: 'Selection' })
    fireEvent.click(within(group).getByRole('button', { name: 'Delete' }))
    expect([...rt.store.getState().notes.keys()]).toEqual([ids[2]])
    act(() => {
      fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true })
    })
    await frames()
    expect(rt.store.getState().notes.size).toBe(3)
  })

  it('Photo, P and the mini-bar Photo each open the photo picker once', async () => {
    const s = { ...emptyBoard(), boardId: BOARD_ID }
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const { unmount } = render(<CanvasView session={s} />)
    await frames()
    // The file input sits in the UI layer, not among the viewport's own layers.
    const input = document.querySelector('[data-testid="photo-input"]')
    expect(input?.parentElement?.className).toBe('ui')

    fireEvent.click(screen.getByRole('button', { name: 'Photo' }))
    expect(click).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'p' })
    expect(click).toHaveBeenCalledTimes(2)
    unmount()

    stubNarrow(true)
    render(<CanvasView session={s} />)
    await frames()
    expect(screen.getByRole('toolbar', { name: 'Tools' }).className).toBe('minibar')
    fireEvent.click(screen.getByRole('button', { name: 'Photo' }))
    expect(click).toHaveBeenCalledTimes(3)
    stubNarrow(false)
    click.mockRestore()
  })

  it('Y opens the colour picker by the Yarn button; folded, by the mark', async () => {
    render(<CanvasView session={emptyBoard()} />)
    await frames()
    fireEvent.keyDown(window, { key: 'y' })
    expect(prefsStore.getState().tool).toBe('select')
    expect(document.activeElement).toBe(dye('Crimson'))
    fireEvent.keyDown(dye('Crimson'), { key: 'ArrowRight' })
    fireEvent.click(dye('Indigo'))
    fireEvent.keyDown(dye('Indigo'), { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(prefsStore.getState()).toMatchObject({ tool: 'yarn', yarnColor: 'indigo' })
    // The board has the keys again, to draw.
    expect(document.activeElement).toBe(screen.getByTestId('canvas'))

    // Folded to the mark, Y opens the same picker beside the mark; the panel stays folded.
    prefsStore.setState({ tool: 'select', sidebar: 'folded' })
    await frames()
    const mark = screen.getByRole('button', { name: 'Papertie — show tools' })
    fireEvent.keyDown(window, { key: 'y' })
    expect(yarnPicker().getAttribute('data-at')).toBe('sidebar')
    expect(document.activeElement).toBe(dye('Indigo'))
    expect(prefsStore.getState()).toMatchObject({ tool: 'select', sidebar: 'folded' })
    // Esc: nothing chosen, the focus back on the mark.
    fireEvent.keyDown(dye('Indigo'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(mark)
    fireEvent.keyDown(window, { key: 'y' })
    fireEvent.click(dye('Ochre'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(prefsStore.getState()).toMatchObject({
      tool: 'yarn',
      yarnColor: 'ochre',
      sidebar: 'folded',
    })
    // The mark unrolling the panel puts it away.
    fireEvent.keyDown(window, { key: 'y' })
    fireEvent.click(mark)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a tool key while the colour picker is open puts it away; Y while "+" is open swaps them', async () => {
    render(<CanvasView session={emptyBoard()} />)
    await frames()
    // V: the picker goes, nothing chosen, and Select is the tool; the board has the keys.
    prefsStore.setState({ tool: 'yarn' })
    fireEvent.keyDown(window, { key: 'y' })
    fireEvent.keyDown(dye('Crimson'), { key: 'v' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(prefsStore.getState()).toMatchObject({ tool: 'select', yarnColor: 'apricot' })
    expect(document.activeElement).toBe(screen.getByTestId('canvas'))
    // Y again, as Yarn again: it closes; a held Y does not flicker it.
    fireEvent.keyDown(window, { key: 'y' })
    fireEvent.keyDown(dye('Crimson'), { key: 'y', repeat: true })
    expect(yarnPicker()).toBeTruthy()
    fireEvent.keyDown(dye('Crimson'), { key: 'y' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(prefsStore.getState().tool).toBe('select')

    // Y while the paper picker is open: one picker at a time.
    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    expect(picker()).toBeTruthy()
    fireEvent.keyDown(document.activeElement ?? window, { key: 'y' })
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull()
    expect(yarnPicker()).toBeTruthy()
  })

  it('a selected thread offers only Delete, which unties it in one undo step', async () => {
    render(<CanvasView session={emptyBoard()} />)
    await frames()
    const rt = runtime()
    const store = rt.store
    const [a, b] = [0, 400].map((x, i) => {
      const id = rt.createNoteAt({ x, y: 0 })
      if (id === undefined) throw new Error('no note')
      store.commit([{ op: 'note.update', id, set: { text: `n${i}` } }])
      rt.stopEditing()
      return id
    }) as [string, string]
    const yarn = rt.yarnFlows.tie(a, b).yarnId
    await frames()
    const group = screen.getByRole('group', { name: 'Selection' })
    act(() => rt.selectYarn(yarn))
    await frames()
    // No popover: nothing to edit on a thread.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(group.hasAttribute('inert')).toBe(false)
    const shown = within(group)
      .getAllByRole('button')
      .map((el) => el.getAttribute('title'))
    expect(shown).toEqual(['Delete (⌫)'])
    const del = within(group).getByRole('button', { name: 'Delete' })
    expect(del.getAttribute('aria-keyshortcuts')).toBe('Delete Backspace')

    fireEvent.click(del)
    expect(store.getState().yarns.has(yarn)).toBe(false)
    expect(rt.selectedYarnId).toBeUndefined()
    expect(document.querySelector('[data-live-region]')?.textContent).toMatch(/Untied the thread/)
    await frames()
    expect(group.hasAttribute('inert')).toBe(true)
    act(() => {
      fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true })
    })
    await frames()
    expect(store.getState().yarns.get(yarn)?.noteIds).toEqual([a, b])

    // Notes selected again: all three are back.
    act(() => rt.selectNotes([a], 'replace'))
    await frames()
    expect(
      within(group)
        .getAllByRole('button')
        .map((el) => el.getAttribute('aria-label')),
    ).toEqual(['Duplicate', 'Focus', 'Delete'])
  })

  it('a new thread takes the colour the Yarn tool was armed with, and so does C', async () => {
    render(<CanvasView session={emptyBoard()} />)
    await frames()
    const rt = runtime()
    const store = rt.store
    const [a, b, c] = [0, 400, 800].map((x, i) => {
      const id = rt.createNoteAt({ x, y: 0 })
      if (id === undefined) throw new Error('no note')
      store.commit([{ op: 'note.update', id, set: { text: `n${i}` } }])
      rt.stopEditing()
      return id
    }) as [string, string, string]
    // The C picker ties through the same flows as the tool: in the colour now chosen.
    const colourOf = (from: string, to: string) => {
      const { yarnId } = rt.yarnFlows.tie(from, to)
      return store.getState().yarns.get(yarnId)?.color
    }
    // Apricot until another colour is chosen.
    expect(colourOf(a, b)).toBe('apricot')
    fireEvent.click(screen.getByRole('button', { name: 'Yarn' }))
    fireEvent.click(dye('Moss'))
    expect(colourOf(b, c)).toBe('sage')
  })
})
