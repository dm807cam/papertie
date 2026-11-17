// @vitest-environment jsdom
import type { ClientOp } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { type BoardSession, openLocalSession, openServerSession } from '../../src/app/session'
import { CanvasView } from '../../src/canvas/CanvasView'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { droppedMessage } from '../../src/sync/notices'
import { canvasElements, installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, FakeServer, FakeTransport, idOf, note, T0 } from '../helpers/fakeServer'

/** NoteView renders by note id: a memoised note re-renders only when its own props change. */
const renders = vi.hoisted(() => new Map<string, number>())
vi.mock('../../src/notes/NoteView', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/notes/NoteView')>()
  return {
    ...m,
    NoteView: (p: Parameters<typeof m.NoteView>[0]) => {
      renders.set(p.note.id, (renders.get(p.note.id) ?? 0) + 1)
      return m.NoteView(p)
    },
  }
})

const N1 = idOf('note', 1)
const N2 = idOf('note', 2)
const N3 = idOf('note', 3)

const update = (id: string, set: Record<string, unknown>) =>
  ({ op: 'note.update', id, set }) as ClientOp

/** N1–N3 side by side at revision 1, so a camera fitting them shows all three. */
function seeded(): FakeServer {
  const server = new FakeServer()
  server.commit(
    [N1, N2, N3].map((id, i) => ({ op: 'note.create' as const, note: note(id, { x: i * 300 }) })),
  )
  return server
}

let restore: () => void = () => {}
const sessions: BoardSession[] = []
const runtimes: CanvasRuntime[] = []

async function open(server: FakeServer) {
  const transport = new FakeTransport(server)
  const session = await openServerSession(BOARD_ID, {
    transport,
    env: null,
  })
  sessions.push(session)
  return { session, transport }
}

function runtimeOn(session: BoardSession): CanvasRuntime {
  const rt = new CanvasRuntime(canvasElements(), session.store)
  runtimes.push(rt)
  return rt
}

/** A note's element as `NoteLayer` would mount it, inside the world layer. */
function noteEl(rt: CanvasRuntime, id: string): HTMLElement {
  const el = document.createElement('article')
  el.dataset.noteId = id
  rt.els.world.append(el)
  return el
}

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

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  restore = installCanvasStubs()
  renders.clear()
})
afterEach(() => {
  cleanup()
  for (const rt of runtimes.splice(0)) rt.dispose()
  for (const s of sessions.splice(0)) s.dispose()
  document.body.replaceChildren()
  restore()
  vi.useRealTimers()
})

describe('remote changes on the canvas', () => {
  it('remote delete of the note being edited', async () => {
    const server = seeded()
    const { session, transport } = await open(server)
    const rt = runtimeOn(session)
    const removed: string[] = []
    rt.onNoteRemoved((id) => removed.push(id))
    // The editor is open on N1, with typing not yet sent (a coalescing batch).
    rt.selectNote(N1)
    session.store.commit([update(N1, { text: 'half a thought' })], {
      coalesceKey: `text:${N1}`,
      label: 'Edit text',
    })

    // A commit of the store's own deletes N1.
    server.commit([{ op: 'note.delete', id: N1 }])
    await vi.advanceTimersByTimeAsync(0)

    expect(removed).toEqual([N1])
    expect(rt.selection.size).toBe(0)
    expect(rt.view.getState().selected.size).toBe(0)
    expect(session.store.getState().notes.has(N1)).toBe(false)
    expect(session.feed.getState().notices).toMatchObject([
      { kind: 'dropped', count: 1, message: droppedMessage(1) },
    ])
    expect(session.sync?.unsavedJsonl()).toContain('half a thought')
    // Nothing threw: a throw in the view callback would have made the client reload.
    expect(transport.loads).toBe(1)
    expect(session.sync?.pending).toBe(0)
  })

  it('a removed note leaves no selection, height, hover or gesture behind', async () => {
    const server = seeded()
    const { session } = await open(server)
    const rt = runtimeOn(session)
    const commits = session.store.commits
    const el = noteEl(rt, N2)
    rt.measured(N2, 420)
    rt.setHoverPin(N2)

    // A drag of N2 is under way: past the threshold, so it moves through the overrides.
    el.dispatchEvent(pointer('pointerdown', 400, 300))
    el.dispatchEvent(pointer('pointermove', 460, 340))
    expect(rt.selection).toEqual(new Set([N2]))
    expect(rt.overrides.get(N2)).toBeDefined()

    server.commit([{ op: 'note.delete', id: N2 }])
    await vi.advanceTimersByTimeAsync(0)

    expect(rt.selection.size).toBe(0)
    expect(rt.measuredH.has(N2)).toBe(false)
    expect(rt.overrides.size).toBe(0)
    expect((rt as unknown as { hoverPin: unknown }).hoverPin).toBeNull()
    // The gesture was abandoned: its release commits nothing (and throws nothing).
    el.dispatchEvent(pointer('pointerup', 480, 360))
    expect(session.store.commits).toBe(commits)
    expect(session.sync?.pending).toBe(0)
  })

  it('a remote note.update re-renders that note only', async () => {
    const server = seeded()
    const { session } = await open(server)
    render(createElement(CanvasView, { session }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(renders.get(N1)).toBeGreaterThan(0)
    const before = new Map(renders)

    await act(async () => {
      server.commit([update(N2, { text: 'from the store' })])
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(session.store.getState().notes.get(N2)?.text).toBe('from the store')
    expect(renders.get(N2)).toBe((before.get(N2) ?? 0) + 1)
    expect(renders.get(N1)).toBe(before.get(N1))
    expect(renders.get(N3)).toBe(before.get(N3))
  })

  it('a stamp wakes only the card it names; a keystroke commit wakes no note', async () => {
    const server = seeded()
    const BOOK = idOf('book', 1)
    const PARA = idOf('block', 1)
    server.commit([
      {
        op: 'book.create',
        book: {
          type: 'book',
          id: BOOK,
          title: 'Shared',
          lang: 'en',
          shelfPos: 'V',
          cover: { seed: 1, ink: 'indigo', motif: 'overprint' },
          trashedAt: null,
          createdAt: T0,
          updatedAt: T0,
        },
      },
      {
        op: 'block.create',
        block: {
          type: 'block',
          id: PARA,
          bookId: BOOK,
          pos: 'V',
          kind: 'p',
          text: 'pinned',
          marks: [],
        },
      },
    ])
    const { session } = await open(server)
    const view = render(createElement(CanvasView, { session }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(renders.get(N1)).toBeGreaterThan(0)
    let before = new Map(renders)

    // N1's words are pinned in the book: the store stamps the book's cards.
    await act(async () => {
      server.commit([
        {
          op: 'block.edit',
          bookId: BOOK,
          id: PARA,
          splices: [],
          addMarks: [{ t: `c:${N1}`, from: 0, to: 6 }],
        },
      ])
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(session.store.getState().books.get(BOOK)?.cards).toEqual([N1])
    expect(renders.get(N1)).toBe((before.get(N1) ?? 0) + 1)
    expect(renders.get(N2)).toBe(before.get(N2))
    expect(renders.get(N3)).toBe(before.get(N3))
    const el = view.container.querySelector(`[data-note-id="${N1}"]`) as HTMLElement
    expect(el.dataset.used).toBe('')
    expect(el.querySelector('.note-ink')?.getAttribute('aria-label')).toBe('Used in books')
    expect(view.container.querySelector(`[data-note-id="${N2}"]`)?.hasAttribute('data-used')).toBe(
      false,
    )

    // Typing inside the pinned text: the book record is stamped again, its cards are not.
    before = new Map(renders)
    await act(async () => {
      server.commit([
        {
          op: 'block.edit',
          bookId: BOOK,
          id: PARA,
          splices: [{ at: 3, del: 0, ins: 'x' }],
          takes: [[`c:${N1}`]],
        },
      ])
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(new Map(renders)).toEqual(before)
  })

  it('a local session drops removed ids as well', () => {
    const server = seeded()
    const session = openLocalSession({ kind: 'local', state: server.state, label: 'test' })
    sessions.push(session)
    const rt = runtimeOn(session)
    const removed: string[] = []
    const off = rt.onNoteRemoved((id) => removed.push(id))
    rt.selectNote(N3)
    session.store.commit([{ op: 'note.delete', id: N3 }])
    expect(removed).toEqual([N3])
    expect(rt.selection.size).toBe(0)
    off()
    session.store.commit([{ op: 'note.delete', id: N1 }])
    expect(removed).toEqual([N3])
  })
})
