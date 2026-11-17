/**
 * A note's reference on the board: a free-text field at the bottom of a note. Shown under a hairline at reading
 * zooms, labelled "Reference"; nothing without one. While the note is written on, "Add
 * reference" at the bottom of its editor opens a small field (an existing ref shows in it); it
 * commits on close, as part of the writing's own undo step, and only a ref that changed since it
 * opened.
 */
import { applyBatch, emptyBoardState, type Note } from '@papertie/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { NoteView } from '../../src/notes/NoteView'
import { textKey } from '../../src/notes/noteCommands'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const N1 = idOf('note', 1)
const REF = 'Thoreau, Walden, 1854,\nTicknor and Fields'

function board(notes: Note[]): BoardSession {
  const state = applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    notes.map((n) => ({ op: 'note.create' as const, note: n })),
    { now: T0 },
  )
  return openLocalSession({ kind: 'local', state, label: 'test' })
}

/** The note being written on, with a control outside it to take the focus. */
function editing(session: BoardSession, done = vi.fn()) {
  const commits: Array<{ set: unknown; label?: string; key?: string }> = []
  session.store.onCommit((_b, ops, o) => {
    for (const op of ops)
      if (op.op === 'note.update') commits.push({ set: op.set, label: o.label, key: o.coalesceKey })
  })
  const view = (on: boolean) => (
    <div>
      <NoteView
        note={session.store.getState().notes.get(N1) as Note}
        lod="full"
        rotation={false}
        editing={on ? { store: session.store, heading: false, onDone: done } : undefined}
      />
      <button type="button">elsewhere</button>
    </div>
  )
  const r = render(view(true))
  return { done, commits, rerender: (on: boolean) => r.rerender(view(on)) }
}

afterEach(cleanup)

describe('a note’s ref on the board', () => {
  it('a note with a ref shows it at its bottom under a hairline; one without shows nothing', () => {
    const { container, rerender } = render(
      <NoteView note={note(N1, { text: 'Simplify.', ref: REF })} lod="full" rotation={false} />,
    )
    const ref = container.querySelector('.note-ref') as HTMLElement
    expect(ref.getAttribute('role')).toBe('note')
    expect(ref.getAttribute('aria-label')).toBe('Reference')
    expect(ref.textContent).toBe(REF)
    // After the text, in the paper.
    const text = container.querySelector('.note-text') as HTMLElement
    expect(text.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    rerender(<NoteView note={note(N1, { text: 'Simplify.' })} lod="full" rotation={false} />)
    expect(container.querySelector('.note-ref')).toBeNull()
    expect(screen.queryByRole('note', { name: 'Reference' })).toBeNull()
    // Not at far zooms.
    rerender(<NoteView note={note(N1, { text: 'S', ref: REF })} lod="lite" rotation={false} />)
    expect(container.querySelector('.note-ref')).toBeNull()
  })

  it('Add reference while editing opens the ref field; the ref commits on close with the writing', async () => {
    const session = board([note(N1, { text: 'Simplify.' })])
    const { done, commits } = editing(session)
    const add = await screen.findByRole('button', { name: 'Add reference' })
    fireEvent.click(add)
    const field = screen.getByRole('textbox', { name: 'Reference' }) as HTMLTextAreaElement
    expect(document.activeElement).toBe(field)
    expect(field.maxLength).toBe(2000)
    fireEvent.change(field, { target: { value: `  ${REF}  ` } })
    // Nothing is sent while typing.
    expect(commits).toEqual([])
    fireEvent.blur(field, { relatedTarget: screen.getByText('elsewhere') })
    expect(session.store.getState().notes.get(N1)?.ref).toBe(REF)
    // Part of the writing session's one undo step (its key and label).
    expect(commits).toEqual([{ set: { ref: REF }, label: 'edit', key: textKey(N1) }])
    expect(done).toHaveBeenCalledWith('blur')
  })

  it('an existing ref is edited the same way, and clearing it removes it', async () => {
    const session = board([note(N1, { text: 'Simplify.', ref: 'Old' })])
    const { done, commits } = editing(session)
    const field = (await screen.findByRole('textbox', { name: 'Reference' })) as HTMLTextAreaElement
    expect(field.value).toBe('Old')
    expect(screen.queryByRole('button', { name: 'Add reference' })).toBeNull()
    fireEvent.change(field, { target: { value: '   ' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(Object.keys(session.store.getState().notes.get(N1) as object)).not.toContain('ref')
    expect(commits).toEqual([{ set: { ref: null }, label: 'edit', key: textKey(N1) }])
    expect(done).toHaveBeenCalledWith('escape')
  })

  it('on close it sends only a ref that changed since it opened, never stale values', async () => {
    const session = board([note(N1, { text: 'Simplify.', ref: 'Old' })])
    const { commits, rerender } = editing(session)
    const field = (await screen.findByRole('textbox', { name: 'Reference' })) as HTMLTextAreaElement
    // The board takes another text and ref for the note meanwhile.
    act(() =>
      session.store.replace(
        applyBatch(
          session.store.getState(),
          [{ op: 'note.update', id: N1, set: { text: 'From the store', ref: 'Store ref' } }],
          { now: T0 },
        ),
      ),
    )
    // Closed untouched: nothing is sent, those edits stay.
    fireEvent.blur(field, { relatedTarget: screen.getByText('elsewhere') })
    expect(commits).toEqual([])
    expect(session.store.getState().notes.get(N1)).toMatchObject({
      text: 'From the store',
      ref: 'Store ref',
    })
    // Opened again and changed: only the ref goes, the text as it is.
    rerender(false)
    rerender(true)
    const again = (await screen.findByRole('textbox', { name: 'Reference' })) as HTMLTextAreaElement
    expect(again.value).toBe('Store ref')
    fireEvent.change(again, { target: { value: 'Laptop ref' } })
    // The editor closes under it (a press elsewhere, a zoom): what was typed is kept.
    rerender(false)
    expect(commits).toEqual([{ set: { ref: 'Laptop ref' }, label: 'edit', key: textKey(N1) }])
    expect(session.store.getState().notes.get(N1)?.text).toBe('From the store')
  })

  it('moving from the ref back to the note’s text keeps writing', async () => {
    const session = board([note(N1, { text: 'Simplify.' })])
    const { done } = editing(session)
    fireEvent.click(await screen.findByRole('button', { name: 'Add reference' }))
    const field = screen.getByRole('textbox', { name: 'Reference' })
    const text = screen.getByRole('textbox', { name: 'Note text' })
    fireEvent.blur(field, { relatedTarget: text })
    fireEvent.blur(text, { relatedTarget: field })
    expect(done).not.toHaveBeenCalled()
  })
})
