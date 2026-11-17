// @vitest-environment jsdom
import { applyBatch, type ClientOp, emptyBoardState } from '@papertie/core'
import { announce } from '../../src/app/liveRegion'
import {
  type BoardSession,
  canvasHistory,
  openLocalSession,
  openServerSession,
  stepHistory,
} from '../../src/app/session'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { BOOK, textOf as blockText, makeBook, typeAt } from '../helpers/books'
import { canvasElements, installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, FakeServer, FakeTransport, idOf, note, T0 } from '../helpers/fakeServer'

const N1 = idOf('note', 1)
const N2 = idOf('note', 2)

const update = (id: string, set: Record<string, unknown>) =>
  ({ op: 'note.update', id, set }) as ClientOp
const create = (id: string, x: number): ClientOp => ({ op: 'note.create', note: note(id, { x }) })

const region = () => document.querySelectorAll('[aria-live="polite"]')
const said = () => region()[0]?.textContent?.trim()

function local(): BoardSession {
  const state = applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [create(N1, 0), create(N2, 1)],
    {
      now: T0,
    },
  )
  return openLocalSession({ kind: 'local', state, label: 'test' })
}

describe('announce', () => {
  it('writes to one polite live region, and says the same text again', () => {
    announce('First')
    announce('Second')
    expect(region()).toHaveLength(1)
    expect(said()).toBe('Second')
    const before = region()[0]?.textContent
    announce('Second')
    // Changed text, so a screen reader reads the repeat too.
    expect(region()[0]?.textContent).not.toBe(before)
    expect(said()).toBe('Second')
  })
})

describe('session undo', () => {
  it('records commits; undo and redo go through store.commit and are not recorded', () => {
    const session = local()
    const { store, undo } = session
    store.commit([update(N1, { x: 50 })], { label: 'Move note' })
    expect(undo.canUndo).toBe(true)

    stepHistory(session, 'undo')
    // Said politely, by the step's label.
    expect(said()).toBe('Undid Move note')
    expect(store.getState().notes.get(N1)?.x).toBe(0)
    expect(store.commits).toBe(2)
    expect(undo.canUndo).toBe(false)
    expect(undo.canRedo).toBe(true)

    stepHistory(session, 'redo')
    expect(store.getState().notes.get(N1)?.x).toBe(50)
    expect(undo.canUndo).toBe(true)
    expect(undo.canRedo).toBe(false)

    // A commit marked `skip` is not recorded: the next undo is still the redone move's.
    store.commit([update(N1, { x: 60 })], { undo: 'skip' })
    stepHistory(session, 'undo')
    expect(store.getState().notes.get(N1)?.x).toBe(0)
    // Redo puts back what that undo replaced; with nothing left to redo, a step is quiet.
    stepHistory(session, 'redo')
    expect(said()).toBe('Redid Move note')
    announce('Something else')
    stepHistory(session, 'redo')
    expect(said()).toBe('Something else')
    expect(store.getState().notes.get(N1)?.x).toBe(60)
    expect(store.commits).toBe(6)
  })

  it('announces a skip, singular and plural, for undo and redo', () => {
    const session = local()
    const { store } = session
    store.commit([update(N1, { x: 50 })], { label: 'Move note' })
    // A commit of the store's own removes the note.
    store.replace(applyBatch(store.getState(), [{ op: 'note.delete', id: N1 }], { now: T0 }))
    stepHistory(session, 'undo')
    expect(said()).toBe('Undid Move note — 1 part no longer applied.')

    store.commit([update(N2, { x: 10, y: 10 }), { op: 'note.create', note: note(N1) }], {
      label: 'Arrange',
    })
    stepHistory(session, 'undo')
    store.replace(applyBatch(store.getState(), [{ op: 'note.delete', id: N2 }], { now: T0 }))
    stepHistory(session, 'redo')
    expect(said()).toBe('Redid Arrange — 1 part no longer applied.')

    store.commit([update(N1, { x: 1 }), update(N1, { y: 2 })])
    store.replace(applyBatch(store.getState(), [{ op: 'note.delete', id: N1 }], { now: T0 }))
    stepHistory(session, 'undo')
    // An unlabelled change has a name of its own.
    expect(said()).toBe('Undid a change — 2 parts no longer applied.')
  })

  it('server session: records against the view and undoes through sync', async () => {
    vi.useFakeTimers()
    try {
      const server = new FakeServer()
      server.commit([create(N1, 0)])
      const transport = new FakeTransport(server)
      const session = await openServerSession(BOARD_ID, {
        transport,
        env: null,
      })
      const sync = session.sync
      if (!sync) throw new Error('a server session has a client')
      // Unsent, the move is in the view (not yet confirmed): undo works from the view.
      session.store.commit([update(N1, { x: 50 })], { label: 'Move note' })
      stepHistory(session, 'undo')
      expect(session.store.getState().notes.get(N1)?.x).toBe(0)
      expect(sync.pending).toBeGreaterThan(0)
      for (let i = 0; i < 30 && sync.pending > 0; i++) await vi.advanceTimersByTimeAsync(1000)
      expect(sync.pending).toBe(0)
      expect(server.state.notes.get(N1)?.x).toBe(0)
      // Both the move and its undo reached the server as edits.
      expect(server.log.slice(1).flatMap((e) => e.ops)).toEqual([
        update(N1, { x: 50 }),
        update(N1, { x: 0 }),
      ])

      session.dispose()
      expect(session.undo.canUndo || session.undo.canRedo).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('undo keys on the board', () => {
  it('⌘Z undoes and ⇧⌘Z redoes on the board; a textarea keeps its own undo', () => {
    const restore = installCanvasStubs()
    const session = local()
    const rt = new CanvasRuntime(canvasElements(), session.store, null, canvasHistory(session))
    try {
      const x = () => session.store.getState().notes.get(N1)?.x
      const press = (init: KeyboardEventInit, target: EventTarget = window) => {
        const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
        target.dispatchEvent(e)
        return e
      }
      session.store.commit([update(N1, { x: 50 })], { label: 'Move note' })
      expect(press({ key: 'z', code: 'KeyZ', metaKey: true }).defaultPrevented).toBe(true)
      expect(x()).toBe(0)
      press({ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true })
      expect(x()).toBe(50)
      press({ key: 'z', code: 'KeyZ', ctrlKey: true })
      expect(x()).toBe(0)
      press({ key: 'y', code: 'KeyY', ctrlKey: true })
      expect(x()).toBe(50)

      const textarea = document.createElement('textarea')
      document.body.append(textarea)
      const e = press({ key: 'z', code: 'KeyZ', metaKey: true }, textarea)
      expect(e.defaultPrevented).toBe(false)
      expect(x()).toBe(50)
      textarea.remove()
    } finally {
      rt.dispose()
      restore()
    }
  })
})

describe('session undo, books: a book closed meanwhile', () => {
  const sessions: BoardSession[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T0))
  })
  afterEach(() => {
    for (const s of sessions.splice(0)) s.dispose()
    vi.useRealTimers()
  })

  async function open(server: FakeServer, transport = new FakeTransport(server)) {
    const session = await openServerSession(BOARD_ID, {
      transport,
      env: null,
      camera: null,
    })
    sessions.push(session)
    await session.books?.open(BOOK)
    return { session, transport }
  }

  const settled = async (server: FakeServer, session: BoardSession) => {
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(1000)
      if (session.sync?.pending === 0 && session.sync.confirmed.board.revision === server.revision)
        return
    }
    throw new Error(`pending ${session.sync?.pending}`)
  }

  it('undo of a book edit after the book was closed never holds back the board', async () => {
    const server = new FakeServer()
    server.commit([create(N1, 0), ...makeBook(['words'])])
    const { session } = await open(server)
    session.store.commit([typeAt(1, 5, ' typed')], { label: 'Typing' })
    await settled(server, session)
    session.books?.close(BOOK)
    await vi.advanceTimersByTimeAsync(0)
    expect(session.store.getState().blocks.size).toBe(0) // let go
    stepHistory(session, 'undo')
    // The step's book part is skipped, and said so: never undone blind.
    expect(said()).toBe('Undid Typing — 1 part no longer applied.')
    session.store.commit([update(N1, { x: 77 })], { label: 'Move note' })
    await settled(server, session)
    expect(server.state.notes.get(N1)?.x).toBe(77)
    expect(blockText(server.state, 1)).toBe('words typed') // nothing undone blind
  })
})
