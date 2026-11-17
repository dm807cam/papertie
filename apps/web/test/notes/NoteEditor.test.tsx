import { applyBatch, type ClientOp, emptyBoardState, LIMITS, PALETTE } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { prefsStore } from '../../src/app/prefs'
import { type BoardSession, openLocalSession, stepHistory } from '../../src/app/session'
import { CanvasView } from '../../src/canvas/CanvasView'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import type { CommitOptions } from '../../src/store/boardStore'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const N1 = idOf('note', 1)
const CAP = 'Notes hold up to 20,000 characters.'

let restore: () => void = () => {}
const sessions: BoardSession[] = []

function board(notes: ClientOp[] = []): BoardSession {
  const state = applyBatch(emptyBoardState(BOARD_ID, 'Test board', T0), notes, { now: T0 })
  const session = openLocalSession({ kind: 'local', state, label: 'test' })
  sessions.push(session)
  return session
}

/** Every commit with its options, from here on. */
function commitsOf(session: BoardSession) {
  const out: Array<{ ops: readonly ClientOp[]; o: CommitOptions }> = []
  session.store.onCommit((_before, ops, o) => out.push({ ops, o }))
  return out
}

/** Let the frame loop cull and React mount what it shows. */
const frames = (ms = 50) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

const runtime = () => window.__papertie?.runtime as CanvasRuntime
const editor = () => document.querySelector<HTMLElement>('.note-edit')
const noteEl = (id: string) => document.querySelector<HTMLElement>(`article[data-note-id="${id}"]`)
const said = () => document.querySelector('[data-live-region]')?.textContent?.trim()
const region = () => document.querySelector('[data-live-region]')?.textContent
const textOf = (session: BoardSession, id: string) => session.store.getState().notes.get(id)?.text
/** The text the field holds, as the editor reads it back. */
const fieldText = (ed: HTMLElement) =>
  [...ed.childNodes]
    .map((n) => ((n as HTMLElement).dataset?.mark ?? '') + (n.textContent ?? ''))
    .join('\n')
const lineEls = (ed: HTMLElement) => [...ed.children] as HTMLElement[]

const fire = (target: EventTarget, e: Event) =>
  act(async () => {
    target.dispatchEvent(e)
    await vi.advanceTimersByTimeAsync(20)
  })
const key = (k: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: x,
    clientY: y,
  })
const beforeInput = (inputType: string, data: string | null = null) =>
  new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data })

/** Select everything in the field. */
function selectAll(ed: HTMLElement) {
  const sel = document.getSelection() as Selection
  sel.setBaseAndExtent(ed, 0, ed, ed.childNodes.length)
}

/**
 * Type `data` at the selection, as the browser does: `beforeinput`, and if the field leaves the
 * typing to the browser, the insertion and an `input`.
 */
async function typeText(ed: HTMLElement, data: string) {
  const e = beforeInput('insertText', data)
  await fire(ed, e)
  if (e.defaultPrevented) return
  const r = (document.getSelection() as Selection).getRangeAt(0)
  const t = r.startContainer as Text
  t.replaceData(r.startOffset, r.endOffset - r.startOffset, data)
  ;(document.getSelection() as Selection).collapse(t, r.startOffset + data.length)
  await fire(ed, new InputEvent('input', { bubbles: true, inputType: 'insertText', data }))
}

/** Replace the whole text with `data`. */
async function replaceAll(ed: HTMLElement, data: string) {
  selectAll(ed)
  await fire(
    ed,
    data === '' ? beforeInput('deleteContentBackward') : beforeInput('insertText', data),
  )
}

/** The browser's part of an IME composition: it writes the composing text into the caret's line. */
function composeInto(ed: HTMLElement, text: string) {
  const line = lineEls(ed).at(-1) as HTMLElement
  const t = document.createTextNode(text)
  line.replaceChildren(t)
  // The caret after the composing text, as the browser keeps it.
  ;(document.getSelection() as Selection).collapse(t, text.length)
  return fire(ed, new InputEvent('input', { bubbles: true, isComposing: true, data: text }))
}

async function openOn(session: BoardSession) {
  render(<CanvasView session={session} />)
  await frames()
}

/** Select note `id` with a click on it, then press Enter: the editor opens on it. */
async function editWithEnter(id: string) {
  const el = noteEl(id)
  if (el === null) throw new Error(`note ${id} is not mounted`)
  await fire(el, pointer('pointerdown', 600, 400))
  await fire(el, pointer('pointerup', 600, 400))
  await fire(document.body, key('Enter'))
  await frames()
}

/** A new blank note at the middle of the view, open for writing (the sidebar's "+"). */
async function pinNewNote() {
  await act(async () => {
    runtime().createNoteAtCentre()
  })
  await frames()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  restore = installCanvasStubs()
  prefsStore.setState({ tool: 'select' })
})
afterEach(() => {
  cleanup()
  for (const s of sessions.splice(0)) s.dispose()
  document.body.replaceChildren()
  restore()
  vi.useRealTimers()
})

describe('note editor', () => {
  it('editor keeps composing text on Enter/Esc', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: '' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor()
    if (ed === null) throw new Error('the editor did not open')
    const commits = commitsOf(session)

    await fire(ed, new CompositionEvent('compositionstart', { bubbles: true }))
    // The IME shows its reading in the field, then the conversion: none of it is committed.
    await composeInto(ed, '´e¨ue')
    await fire(ed, key('Enter', { isComposing: true }))
    await composeInto(ed, 'éü')
    await fire(ed, key('Escape', { isComposing: true }))
    expect(editor()).toBe(ed)
    expect(document.activeElement).toBe(ed)
    expect(commits).toEqual([])

    await fire(ed, new CompositionEvent('compositionend', { bubbles: true, data: 'éü' }))
    // Some browsers send one more input after the composition ends.
    await fire(ed, new InputEvent('input', { bubbles: true, data: 'éü' }))

    expect(editor()).toBe(ed)
    const updates = commits.flatMap((c) => c.ops)
    expect(updates).toEqual([{ op: 'note.update', id: N1, set: { text: 'éü' } }])
    expect(commits[0]?.o).toMatchObject({ coalesceKey: `text:${N1}`, label: 'edit' })
    expect(textOf(session, N1)).toBe('éü')
    // Once the composition is done, its line takes its place: the title.
    expect(lineEls(ed)[0]?.className).toBe('note-title')
  })

  it('a press elsewhere mid-composition keeps the composed text; a new note survives', async () => {
    const session = board()
    await openOn(session)
    await pinNewNote()
    const ed = editor() as HTMLElement
    await fire(ed, new CompositionEvent('compositionstart', { bubbles: true }))
    await composeInto(ed, '´e¨ue')

    // The press comes before the blur that would end the composition.
    const root = document.querySelector('main.viewport') as HTMLElement
    await fire(root, pointer('pointerdown', 5, 5))
    await fire(root, pointer('pointerup', 5, 5))
    await frames()

    expect(editor()).toBeNull()
    const notes = [...session.store.getState().notes.values()]
    expect(notes.map((n) => n.text)).toEqual(['´e¨ue'])
    // The note and its text are one step: one undo takes it away.
    stepHistory(session, 'undo')
    expect(session.store.getState().notes.size).toBe(0)
  })

  it('Enter on a selected note opens the editor; Esc closes and keeps selection', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'Spring trip\n- Milan' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor()
    if (ed === null) throw new Error('the editor did not open')
    expect(fieldText(ed)).toBe('Spring trip\n- Milan')
    // In the note's own typography: a title line and a bullet whose marker draws as "•".
    expect(lineEls(ed).map((l) => l.className)).toEqual([
      'note-title',
      'note-edit-bullet note-edit-bullet--first',
    ])
    expect(lineEls(ed)[1]?.dataset.mark).toBe('- ')
    expect(lineEls(ed)[1]?.textContent).toBe('Milan')
    expect(document.activeElement).toBe(ed)
    expect(noteEl(N1)?.classList.contains('note--editing')).toBe(true)
    // The caret starts at the end of the text.
    await typeText(ed, '!')
    expect(textOf(session, N1)).toBe('Spring trip\n- Milan!')

    await fire(ed, key('Escape'))
    await frames()

    expect(editor()).toBeNull()
    expect(noteEl(N1)?.classList.contains('note--selected')).toBe(true)
    expect(noteEl(N1)?.classList.contains('note--editing')).toBe(false)
    // The note keeps the keyboard, marked by the frame in the focus ink: Enter edits it again.
    expect(document.activeElement).toBe(noteEl(N1))
    expect(document.querySelector('.selection')?.hasAttribute('data-focus')).toBe(true)
    await fire(document.activeElement as Element, key('Enter'))
    await frames()
    expect(editor()).not.toBeNull()
  })

  it('a second Esc clears the selection and lets the keyboard go', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'a' }) }])
    await openOn(session)
    await editWithEnter(N1)
    expect(document.querySelector('.selection')?.hasAttribute('data-focus')).toBe(true)
    await fire(editor() as HTMLElement, key('Escape'))
    await frames()
    await fire(document.activeElement as Element, key('Escape'))
    await frames()
    expect(runtime().selection.size).toBe(0)
    expect(document.activeElement).toBe(document.body)
  })

  it('Enter, Backspace and paste edit the lines; the field keeps its own undo', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'Plan' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor() as HTMLElement
    await fire(ed, beforeInput('insertParagraph'))
    await typeText(ed, '- paper')
    expect(textOf(session, N1)).toBe('Plan\n- paper')
    // Each line carries its role's class (noteText `titleClass`), as the rendering does.
    expect(lineEls(ed).map((l) => l.className)).toEqual([
      'note-title',
      'note-edit-bullet note-edit-bullet--first',
    ])
    await fire(ed, beforeInput('deleteContentBackward'))
    expect(textOf(session, N1)).toBe('Plan\n- pape')
    const paste = beforeInput('insertFromPaste')
    Object.defineProperty(paste, 'dataTransfer', {
      value: { getData: (t: string) => (t === 'text/plain' ? 'r\r\nink' : '') },
    })
    await fire(ed, paste)
    expect(textOf(session, N1)).toBe('Plan\n- paper\nink')
    // Formatting does nothing in a plain note.
    await fire(ed, beforeInput('formatBold'))
    expect(fieldText(ed)).toBe('Plan\n- paper\nink')

    vi.advanceTimersByTime(2000)
    await fire(ed, key('z', { code: 'KeyZ', metaKey: true }))
    expect(textOf(session, N1)).toBe('Plan\n- pape')
    await fire(ed, key('z', { code: 'KeyZ', metaKey: true, shiftKey: true }))
    expect(textOf(session, N1)).toBe('Plan\n- paper\nink')
  })

  it('a blank line the rendering drops takes no room until the caret enters it', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'Hub\n\nbody' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor() as HTMLElement
    const gap = lineEls(ed)[1] as HTMLElement
    expect(gap.className).toBe('note-edit-gap')
    expect(lineEls(ed)[2]?.className).toBe('note-body note-edit-after-head')
    ;(document.getSelection() as Selection).collapse(gap, 0)
    await fire(document, new Event('selectionchange'))
    expect(gap.classList.contains('note-edit-gap--open')).toBe(true)
  })

  it('a new note from "+" opens the editor on it', async () => {
    const session = board()
    await openOn(session)
    const commits = commitsOf(session)

    await pinNewNote()

    const notes = [...session.store.getState().notes.values()]
    expect(notes).toHaveLength(1)
    const created = notes[0]
    expect(created).toMatchObject({ text: '', w: 240, h: 160 })
    expect(commits).toHaveLength(1)
    expect(commits[0]?.o).toMatchObject({ coalesceKey: `text:${created?.id}` })
    const ed = editor()
    expect(ed).not.toBeNull()
    expect(ed?.closest('article')?.dataset.noteId).toBe(created?.id)
    expect(document.activeElement).toBe(ed)
    expect(noteEl(created?.id ?? '')?.classList.contains('note--selected')).toBe(true)
    // Said politely, with its paper: the editor's focus says the rest.
    expect(said()).toBe(`New ${PALETTE[created?.paper ?? 'cream'].name} note. Write, then Esc.`)
  })

  it('a composition right after a bullet marker stays in the bullet', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'Plan\n- ' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor() as HTMLElement
    const bullet = lineEls(ed)[1] as HTMLElement
    // The marker is no part of the line's DOM text: the composition can only go after it.
    expect(bullet.dataset.mark).toBe('- ')
    expect(bullet.textContent).toBe('')
    await fire(ed, new CompositionEvent('compositionstart', { bubbles: true }))
    await composeInto(ed, 'é')
    await fire(ed, new CompositionEvent('compositionend', { bubbles: true, data: 'é' }))
    await frames()
    expect(textOf(session, N1)).toBe('Plan\n- é')
    expect(lineEls(ed)[1]?.className).toBe('note-edit-bullet note-edit-bullet--first')
    // Typing goes on after it, in the bullet.
    await typeText(ed, 'ü')
    expect(textOf(session, N1)).toBe('Plan\n- éü')
    // Backspace at the start of the bullet's text takes the marker, not the line break.
    const t = lineEls(ed)[1]?.firstChild as Text
    ;(document.getSelection() as Selection).collapse(t, 0)
    await fire(ed, beforeInput('deleteContentBackward'))
    expect(textOf(session, N1)).toBe('Plan\néü')
  })

  it('a marker typed at a line start turns it into a bullet, the caret after it', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'Plan\nabc' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor() as HTMLElement
    ;(document.getSelection() as Selection).collapse(lineEls(ed)[1]?.firstChild as Node, 0)
    await typeText(ed, '-')
    await typeText(ed, ' ')
    expect(textOf(session, N1)).toBe('Plan\n- abc')
    expect(lineEls(ed)[1]?.dataset.mark).toBe('- ')
    await typeText(ed, 'x')
    expect(textOf(session, N1)).toBe('Plan\n- xabc')
  })

  it('copy, cut and paste keep bullet markers, so whole lines move as bullets', async () => {
    const session = board([
      { op: 'note.create', note: note(N1, { text: 'Plan\n- Milan\n- Turin' }) },
    ])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor() as HTMLElement
    const clip = new Map<string, string>()
    const clipEvent = (type: string) => {
      const e = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(e, 'clipboardData', {
        value: {
          setData: (t: string, v: string) => clip.set(t, v),
          getData: (t: string) => clip.get(t) ?? '',
        },
      })
      return e
    }
    selectAll(ed)
    await fire(ed, clipEvent('copy'))
    expect(clip.get('text/plain')).toBe('Plan\n- Milan\n- Turin')

    // Both bullets, selected from the start of the first one's text: cut, then pasted above.
    const [, milan, turin] = lineEls(ed) as [HTMLElement, HTMLElement, HTMLElement]
    ;(document.getSelection() as Selection).setBaseAndExtent(
      milan.firstChild as Node,
      0,
      turin.firstChild as Node,
      5,
    )
    await fire(ed, clipEvent('cut'))
    expect(clip.get('text/plain')).toBe('- Milan\n- Turin')
    expect(textOf(session, N1)).toBe('Plan\n')
    ;(document.getSelection() as Selection).collapse(lineEls(ed)[0]?.firstChild as Node, 0)
    const paste = beforeInput('insertFromPaste')
    Object.defineProperty(paste, 'dataTransfer', {
      value: { getData: (t: string) => (t === 'text/plain' ? `${clip.get('text/plain')}\n` : '') },
    })
    await fire(ed, paste)
    expect(textOf(session, N1)).toBe('- Milan\n- Turin\nPlan\n')
    expect(
      lineEls(ed)
        .slice(0, 2)
        .map((l) => l.dataset.mark),
    ).toEqual(['- ', '- '])
  })

  it('a drag of bullet lines inside the field moves them as written', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'Plan\n- Milan\nend' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor() as HTMLElement
    const [, milan, end] = lineEls(ed) as [HTMLElement, HTMLElement, HTMLElement]
    ;(document.getSelection() as Selection).setBaseAndExtent(milan.firstChild as Node, 0, end, 0)
    const data = new Map<string, string>()
    const dragEvent = (type: string) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 1, clientY: 1 })
      Object.defineProperty(e, 'dataTransfer', {
        value: {
          setData: (t: string, v: string) => data.set(t, v),
          getData: (t: string) => data.get(t) ?? '',
        },
      })
      return e
    }
    await fire(ed, dragEvent('dragstart'))
    expect(data.get('text/plain')).toBe('- Milan\n')
    // Dropped at the end of the last line.
    const endText = end.firstChild as Text
    // jsdom lays nothing out: the drop point is the end of the last line.
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => {
        const r = document.createRange()
        r.setStart(endText, 3)
        return r
      },
    })
    try {
      const drop = dragEvent('drop')
      await fire(ed, drop)
      expect(drop.defaultPrevented).toBe(true)
    } finally {
      Reflect.deleteProperty(document, 'caretRangeFromPoint')
    }
    expect(textOf(session, N1)).toBe('Plan\nend- Milan\n')
  })

  it('after writing ends on its own, board keys wait until typing pauses', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: '' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor() as HTMLElement
    await fire(ed, new CompositionEvent('compositionstart', { bubbles: true }))
    await composeInto(ed, '´e¨ue')
    const rt = runtime()
    await act(async () => {
      rt.camera.set({ ...rt.camera.get(), zoom: 0.05 })
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(rt.editing).toBeNull()
    expect(rt.selection.has(N1)).toBe(true)
    // The writer's keys keep coming: none of them acts on the board.
    for (const k of ['Backspace', 'n', 'Delete', 'v']) await fire(document.body, key(k))
    expect(textOf(session, N1)).toBe('´e¨ue')
    expect(prefsStore.getState().tool).toBe('select')
    // A pause, and the board's keys are back.
    await frames(1000)
    await fire(document.body, key('Backspace'))
    expect(session.store.getState().notes.has(N1)).toBe(false)
  })

  it('the edited note keeps its place among the mounted notes when the cull drops it', async () => {
    const notes = [1, 2, 3, 4].map(
      (n): ClientOp => ({
        op: 'note.create',
        note: note(idOf('note', n), { x: (n - 1) * 3000, z: n, text: `n${n}` }),
      }),
    )
    const session = board(notes)
    await openOn(session)
    const edited = idOf('note', 2)
    await act(async () => {
      runtime().startEditing(edited)
      await vi.advanceTimersByTimeAsync(50)
    })
    const ed = editor() as HTMLElement
    const article = ed.closest('article') as HTMLElement
    const moved: Node[] = []
    const mo = new MutationObserver((rs) => {
      for (const r of rs) for (const n of r.removedNodes) moved.push(n)
    })
    mo.observe(article.parentElement as HTMLElement, { childList: true })
    const rt = runtime()
    const home = rt.camera.get()
    // Only the last note in view (the edited one kept mounted), then all of them again.
    await act(async () => {
      rt.focusNote(idOf('note', 4), 1)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(rt.view.getState().visible).toEqual([edited, idOf('note', 4)])
    await act(async () => {
      rt.camera.set(home)
      await vi.advanceTimersByTimeAsync(50)
    })
    mo.disconnect()
    expect(moved).not.toContain(article)
    expect(editor()).toBe(ed)
    expect(document.activeElement).toBe(ed)
  })

  it('zooming out to overview mid-composition keeps the text and ends the writing', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: '' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor() as HTMLElement
    await fire(ed, new CompositionEvent('compositionstart', { bubbles: true }))
    await composeInto(ed, '´e¨ue')
    const rt = runtime()
    await act(async () => {
      rt.camera.set({ ...rt.camera.get(), zoom: 0.05 })
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(rt.lod).toBe('overview')
    expect(rt.editing).toBeNull()
    expect(editor()).toBeNull()
    expect(textOf(session, N1)).toBe('´e¨ue')
  })

  it('a double-click in overview eases in to the new note, and keys wait for its editor', async () => {
    const session = board()
    await openOn(session)
    const rt = runtime()
    await act(async () => {
      rt.camera.set({ x: -3000, y: -3000, zoom: 0.05 })
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(rt.lod).toBe('overview')
    await pinNewNote()
    const [created] = [...session.store.getState().notes.keys()]
    expect(rt.editing).toBe(created)
    // No editor yet: keys meant for it touch neither the tool nor the note.
    await fire(document.body, key('n'))
    await fire(document.body, key('Backspace'))
    await fire(document.body, key('z', { code: 'KeyZ', metaKey: true }))
    expect(prefsStore.getState().tool).toBe('select')
    expect(session.store.getState().notes.size).toBe(1)

    await frames(1000)
    expect(rt.lod).toBe('full')
    expect(rt.camera.get().zoom).toBe(1)
    expect(document.activeElement).toBe(editor())
    expect(editor()?.closest('article')?.dataset.noteId).toBe(created)
  })

  it('the note being written on stays mounted wherever the camera goes', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'stay' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor()
    await act(async () => {
      runtime().camera.set({ x: 50_000, y: 50_000, zoom: 1 })
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(editor()).toBe(ed)
    expect(document.activeElement).toBe(ed)
  })

  it('a heading stays set as it was while writing', async () => {
    const session = board()
    await openOn(session)
    await pinNewNote()
    const ed = editor() as HTMLElement
    const article = ed.closest('article') as HTMLElement
    await typeText(ed, 'Title')
    // A title alone is a heading (centred) once rendered, but not while it is being written.
    expect(article.classList.contains('note--heading')).toBe(false)
    await fire(ed, key('Escape'))
    await frames()
    expect(article.classList.contains('note--heading')).toBe(true)
  })

  it('empty new note disappears on blur without an undo entry', async () => {
    const session = board()
    await openOn(session)
    await pinNewNote()
    const ed = editor()
    if (ed === null) throw new Error('the editor did not open')

    await act(async () => {
      ed.blur()
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(editor()).toBeNull()
    expect(session.store.getState().notes.size).toBe(0)
    expect(session.undo.canUndo).toBe(false)
    // Undo brings back no empty note.
    stepHistory(session, 'undo')
    expect(session.store.getState().notes.size).toBe(0)
  })

  it('a new note typed on and left is one undo step, which takes it away', async () => {
    const session = board()
    await openOn(session)
    await pinNewNote()
    const ed = editor() as HTMLElement
    await typeText(ed, 'ô')
    await typeText(ed, 'ù')
    await fire(ed, key('Escape'))
    await frames()
    expect(session.store.getState().notes.size).toBe(1)

    stepHistory(session, 'undo')
    expect(session.store.getState().notes.size).toBe(0)
    expect(session.undo.canUndo).toBe(false)
  })

  it('a note emptied and left is deleted; one undo brings it back with its text', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'draft' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor() as HTMLElement
    await replaceAll(ed, '')
    await fire(ed, key('Escape'))
    await frames()
    expect(session.store.getState().notes.has(N1)).toBe(false)

    stepHistory(session, 'undo')
    expect(textOf(session, N1)).toBe('draft')
  })

  it('separate writing sessions are separate undo steps', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'a' }) }])
    await openOn(session)
    await editWithEnter(N1)
    await typeText(editor() as HTMLElement, 'b')
    await fire(editor() as HTMLElement, key('Escape'))
    await fire(document.activeElement as Element, key('Enter'))
    await frames()
    await typeText(editor() as HTMLElement, 'c')
    await fire(editor() as HTMLElement, key('Escape'))

    stepHistory(session, 'undo')
    expect(textOf(session, N1)).toBe('ab')
  })

  it('typing 20,001 chars stops at 20,000 and announces "Notes hold up to 20,000 characters."', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: '' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor() as HTMLElement

    await replaceAll(ed, '€'.repeat(LIMITS.maxTextLength + 1))

    expect(fieldText(ed)).toHaveLength(LIMITS.maxTextLength)
    expect(textOf(session, N1)).toHaveLength(LIMITS.maxTextLength)
    expect(said()).toBe(CAP)
    // Said once per hit: pressing on at the cap says nothing more.
    const before = region()
    await typeText(ed, '€')
    await typeText(ed, '€')
    expect(region()).toBe(before)
    expect(textOf(session, N1)).toHaveLength(LIMITS.maxTextLength)
    // Room again, then a new hit: said again.
    await fire(ed, beforeInput('deleteContentBackward'))
    await typeText(ed, '€€')
    expect(region()).not.toBe(before)
    expect(said()).toBe(CAP)
  })

  it('a double-click on cork pins nothing: "+" is the one way to a new note', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'alone' }) }])
    await openOn(session)
    const root = document.querySelector('main.viewport') as HTMLElement
    await fire(root, new MouseEvent('dblclick', { bubbles: true, clientX: 60, clientY: 700 }))
    await frames()
    expect(session.store.getState().notes.size).toBe(1)
    expect(editor()).toBeNull()
  })

  it('double-click on a note edits it, never after a drag', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'drag me' }) }])
    await openOn(session)
    const el = noteEl(N1) as HTMLElement
    const x0 = session.store.getState().notes.get(N1)?.x
    // A drag, released where it ends: the browser may still see a double-click there.
    await fire(el, pointer('pointerdown', 600, 420))
    await fire(el, pointer('pointermove', 660, 460))
    await fire(el, pointer('pointerup', 660, 460))
    expect(session.store.getState().notes.get(N1)?.x).not.toBe(x0)
    await fire(el, new MouseEvent('dblclick', { bubbles: true, clientX: 660, clientY: 460 }))
    await frames()
    expect(editor()).toBeNull()

    // Two clicks that stay put: the editor opens.
    await fire(el, pointer('pointerdown', 660, 460))
    await fire(el, pointer('pointerup', 660, 460))
    await fire(el, new MouseEvent('dblclick', { bubbles: true, clientX: 660, clientY: 460 }))
    await frames()
    expect(fieldText(editor() as HTMLElement)).toBe('drag me')
  })

  it('a press beside the text keeps writing; a press elsewhere ends it', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'margin' }) }])
    await openOn(session)
    await editWithEnter(N1)
    const ed = editor() as HTMLElement
    ;(document.getSelection() as Selection).collapse(ed.firstChild?.firstChild as Node, 0)
    const paper = noteEl(N1)?.querySelector('.note-paper') as HTMLElement
    await fire(paper, pointer('pointerdown', 600, 400))
    expect(editor()).toBe(ed)
    expect(document.activeElement).toBe(ed)
    // The caret went to the end.
    await typeText(ed, '!')
    expect(textOf(session, N1)).toBe('margin!')
    // No tool took the press: nothing moves with the pointer.
    await fire(paper, pointer('pointermove', 680, 460))
    await fire(paper, pointer('pointerup', 680, 460))
    expect(session.store.getState().notes.get(N1)?.x).toBe(0)

    const root = document.querySelector('main.viewport') as HTMLElement
    await fire(root, pointer('pointerdown', 5, 5))
    await fire(root, pointer('pointerup', 5, 5))
    await frames()
    expect(editor()).toBeNull()
  })

  it('Delete removes the selected note; ⌘D duplicates it and selects the copy', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'twice' }) }])
    await openOn(session)
    const el = noteEl(N1) as HTMLElement
    await fire(el, pointer('pointerdown', 600, 400))
    await fire(el, pointer('pointerup', 600, 400))
    const d = key('d', { code: 'KeyD', metaKey: true })
    await fire(document.body, d)
    expect(d.defaultPrevented).toBe(true)
    await frames()
    const notes = session.store.getState().notes
    expect(notes.size).toBe(2)
    const copy = [...notes.values()].find((n) => n.id !== N1)
    expect(copy?.text).toBe('twice')
    expect(noteEl(copy?.id ?? '')?.classList.contains('note--selected')).toBe(true)

    await fire(document.body, key('Backspace'))
    await frames()
    expect([...session.store.getState().notes.keys()]).toEqual([N1])
    // In the editor, Backspace is the text's.
    await editWithEnter(N1)
    await fire(editor() as HTMLElement, key('Backspace'))
    expect(session.store.getState().notes.has(N1)).toBe(true)
  })

  it('a remote-style delete of the note being edited closes the editor and commits nothing', async () => {
    const session = board([{ op: 'note.create', note: note(N1, { text: 'half' }) }])
    await openOn(session)
    await editWithEnter(N1)
    expect(editor()).not.toBeNull()
    const commits = commitsOf(session)
    // The board replaced under the editor, as a server session's remote change does.
    const without = applyBatch(session.store.getState(), [{ op: 'note.delete', id: N1 }], {
      now: T0,
    })
    await act(async () => {
      session.store.replace(without)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(editor()).toBeNull()
    expect(commits).toEqual([])
  })
})
