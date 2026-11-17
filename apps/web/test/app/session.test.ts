import type { ClientOp } from '@papertie/core'
import { type BoardSession, openServerSession } from '../../src/app/session'
import { BOARD_ID, FakeServer, FakeTransport, idOf, note, T0 } from '../helpers/fakeServer'

const N1 = idOf('note', 1)
const N2 = idOf('note', 2)

const update = (id: string, set: Record<string, unknown>) =>
  ({ op: 'note.update', id, set }) as ClientOp

/** A server whose board holds N1 and N2, at revision 1. */
function seeded(): FakeServer {
  const server = new FakeServer()
  server.commit([N1, N2].map((id, i) => ({ op: 'note.create' as const, note: note(id, { x: i }) })))
  return server
}

const opened: BoardSession[] = []
async function open(server: FakeServer, o: { transport?: FakeTransport } = {}) {
  const transport = o.transport ?? new FakeTransport(server)
  const session = await openServerSession(BOARD_ID, {
    transport,
    env: null,
  })
  opened.push(session)
  return { session, transport }
}

/** Advance fake time until `done` holds (the client backs off up to 30 s). */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 120 && !done(); i++) await vi.advanceTimersByTimeAsync(i === 0 ? 0 : 1000)
  expect(done()).toBe(true)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
})
afterEach(() => {
  for (const s of opened.splice(0)) s.dispose()
  vi.useRealTimers()
})

describe('openServerSession', () => {
  it('server session: store view follows SyncClient view on local and remote changes', async () => {
    const server = seeded()
    const { session } = await open(server)
    const { store, sync } = session
    if (!sync) throw new Error('a server session has a client')
    expect(session.boardId).toBe(BOARD_ID)
    expect(store.getState()).toBe(sync.view)

    // Local: the commit is the client's submit, and the store shows the view it answers.
    const local = store.commit([update(N1, { x: 50 })])
    expect(local).toBe(sync.view)
    expect(store.getState()).toBe(sync.view)
    expect(sync.pending).toBe(1)
    expect(store.commits).toBe(1)

    // Remote: a commit of the store's own reaches the store through the client's view.
    const seen: number[] = []
    store.subscribe((s) => seen.push(s.notes.get(N2)?.x ?? -1))
    server.commit([update(N2, { x: 77 })])
    await until(() => sync.pending === 0 && sync.confirmed.board.revision === server.revision)
    expect(store.getState()).toBe(sync.view)
    expect(store.getState().notes.get(N2)?.x).toBe(77)
    expect(store.getState().notes.get(N1)?.x).toBe(50)
    expect(seen.at(-1)).toBe(77)
    // A remote change is not a commit of this store.
    expect(store.commits).toBe(1)
    expect(session.feed.getState().status).toBe('saved')
  })

  it('an abort while the board loads rejects at once and stops the client', async () => {
    const server = seeded()
    const transport = new FakeTransport(server)
    const openGate = transport.gateLoads()
    const abort = new AbortController()
    const opening = openServerSession(BOARD_ID, {
      transport,
      env: null,
      signal: abort.signal,
    })
    abort.abort()
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    openGate()
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.sends).toHaveLength(0)
  })

  it('flushes on window blur, and dispose stops listening', async () => {
    const server = seeded()
    const transport = new FakeTransport(server)
    const win = new EventTarget()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    const session = await openServerSession(BOARD_ID, {
      transport,
      env: { window: win, document: doc },
    })
    // A typing batch waits 600 ms idle; a blur sends it now.
    session.store.commit([update(N1, { text: 'draft' })], { coalesceKey: `text:${N1}` })
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sends).toHaveLength(0)
    win.dispatchEvent(new Event('blur'))
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sends).toHaveLength(1)

    session.dispose()
    session.store.commit([update(N1, { text: 'after' })], { coalesceKey: `text:${N1}` })
    win.dispatchEvent(new Event('blur'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.sends).toHaveLength(1)
  })
})
