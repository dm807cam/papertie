import { act, fireEvent, render, screen } from '@testing-library/react'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import { FocusChip } from '../../src/focus/FocusChip'
import { releaseSearchIndex, searchIndexFor } from '../../src/search/searchIndex'
import { installCanvasStubs } from '../helpers/domCanvas'
import { idOf, T0 } from '../helpers/fakeServer'
import { A, B, chainRuntime, D, E, F, G, H } from './board'

let restore: () => void = () => {}
const runtimes: CanvasRuntime[] = []

function setup() {
  const made = chainRuntime()
  runtimes.push(made.rt)
  // In the board's UI layer, as `CanvasView` mounts it: keys from it are the board's (key scoping takes only keys from inside the board's root).
  const ui = document.createElement('div')
  ui.className = 'ui'
  made.rt.els.root.append(ui)
  render(<FocusChip runtime={made.rt} store={made.store} />, { container: ui })
  return made
}

const button = (name: string | RegExp) => screen.getByRole('button', { name })

/** The picker's search index (on this thread here, on these fake timers) has answered. */
const answered = () => act(() => vi.advanceTimersByTimeAsync(20))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  restore = installCanvasStubs()
  history.replaceState(null, '', '/')
})
afterEach(() => {
  for (const rt of runtimes.splice(0)) rt.dispose()
  document.body.replaceChildren()
  restore()
  vi.useRealTimers()
  history.replaceState(null, '', '/')
})

describe('FocusChip', () => {
  it('shows nothing until focus is on', () => {
    const { rt } = setup()
    expect(screen.queryByRole('toolbar')).toBeNull()
    act(() => rt.setFocus({ seeds: [A], depth: 1, include: [] }))
    expect(screen.getByRole('toolbar', { name: 'Focus' }).textContent).toContain('Focus · 1 step')
  })

  it('+ grows to depth 2; All covers the component; − never goes below 1', () => {
    const { rt } = setup()
    act(() => rt.setFocus({ seeds: [A], depth: 1, include: [] }))
    const fewer = button('Fewer steps')
    expect(fewer.getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(button('More steps'))
    expect(rt.focusState?.depth).toBe(2)
    expect(rt.focus?.notes.has(D)).toBe(true)
    expect(screen.getByRole('toolbar').textContent).toContain('Focus · 2 steps')

    fireEvent.click(button('All'))
    expect(rt.focusState?.depth).toBe('all')
    expect([E, F].every((id) => rt.focus?.notes.has(id))).toBe(true)
    expect(rt.focus?.looseEnds).toEqual([])
    expect(button('All').getAttribute('aria-pressed')).toBe('true')
    expect(button('More steps').getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(fewer)
    expect(rt.focusState?.depth).toBe(3)
    fireEvent.click(fewer)
    fireEvent.click(fewer)
    expect(rt.focusState?.depth).toBe(1)
    fireEvent.click(fewer)
    expect(rt.focusState?.depth).toBe(1)
    expect(screen.getByRole('toolbar').textContent).toContain('Focus · 1 step')
  })

  it('Bring in adds an unconnected note without expanding from it', async () => {
    const { rt } = setup()
    act(() => rt.setFocus({ seeds: [A], depth: 1, include: [] }))
    fireEvent.click(button('Bring in…'))
    await answered()
    const field = screen.getByRole('combobox')
    // The focused notes are not offered again.
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
    expect(screen.queryByRole('option', { name: /note B/ })).toBeNull()
    fireEvent.change(field, { target: { value: 'note G' } })
    await answered()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(rt.focusState).toEqual({ seeds: [A], depth: 1, include: [G] })
    expect(rt.focus?.notes.has(G)).toBe(true)
    // G is on Y5 with H, but a note brought in is never expanded from.
    expect(rt.focus?.notes.has(H)).toBe(false)
    // `multi`: the picker stays open for more, and G is no longer offered.
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.change(field, { target: { value: 'note' } })
    await answered()
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
    expect(screen.queryByRole('option', { name: /note G/ })).toBeNull()
    // Esc finishes bringing in; focus stays on, and the keyboard goes back to the chip.
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(rt.focus).not.toBeNull()
    expect(document.activeElement).toBe(button('Bring in…'))
  })

  it('Bring in… does not move under the eye when the board changes but the focus does not', async () => {
    const { rt, store } = setup()
    act(() => rt.setFocus({ seeds: [A], depth: 1, include: [] }))
    fireEvent.click(button('Bring in…'))
    await answered()
    const search = searchIndexFor(store)
    const asks = vi.spyOn(search, 'recent')
    const before = rt.focusView.getState().result
    // A second thread between two notes already in focus: a new focus result, the same notes.
    act(() => {
      store.commit([
        {
          op: 'yarn.create',
          yarn: {
            type: 'yarn',
            id: idOf('yarn', 9),
            noteIds: [A, B],
            color: 'indigo',
            label: '',
            createdAt: T0,
            updatedAt: T0,
          },
        },
      ])
    })
    await answered()
    expect(rt.focusView.getState().result).not.toBe(before)
    expect(asks).not.toHaveBeenCalled()
    releaseSearchIndex(store)
  })

  it('✕ leaves focus, and the chip goes', () => {
    const { rt } = setup()
    act(() => rt.setFocus({ seeds: [A], depth: 2, include: [] }))
    fireEvent.click(button(/Exit focus/))
    expect(rt.focus).toBeNull()
    // It sinks away, inert and hidden from assistive tech, then goes.
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(document.querySelector('.focus-chip[data-leaving][inert]')).not.toBeNull()
    act(() => vi.advanceTimersByTime(250))
    expect(document.querySelector('.focus-chip')).toBeNull()
  })

  it('leaving focus from the chip gives the keyboard to the selected note, else the board', () => {
    const { rt } = setup()
    rt.selectNote(B)
    act(() => rt.setFocus({ seeds: [A], depth: 1, include: [] }))
    const exit = button(/Exit focus/)
    exit.focus()
    fireEvent.click(exit)
    expect(document.activeElement).toBe(rt.noteEls.get(B))

    // Esc from a chip button with nothing selected: the board itself.
    rt.selectNote(null)
    act(() => rt.setFocus({ seeds: [A], depth: 1, include: [] }))
    const all = button('All')
    all.focus()
    act(() => {
      all.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(rt.focus).toBeNull()
    expect(document.activeElement).toBe(rt.els.root)
  })
})
