/**
 * Opening the board where it was left: the first paint from the region the
 * remembered camera shows, the rest of the board nearest first, and edits made before the whole
 * board is in kept in order and applied once (Review Focus 3).
 */
import type { ClientOp, Note, Yarn } from '@papertie/core'
import { type OpeningSource, type OpeningStage, openBoard, TILE } from '../../src/app/opening'
import { type BoardSession, META_WAIT_MS, openServerSession } from '../../src/app/session'
import type { Camera } from '../../src/canvas/Camera'
import type { SyncClient } from '../../src/sync/SyncClient'
import { BOARD_ID, connect, FakeServer, FakeTransport, idOf, note, T0 } from '../helpers/fakeServer'

const _USER = 'user_a'
const VIEWPORT = { width: 1280, height: 800 }
/** The view from the origin at 100 %: the world rect 0..1280 × 0..800. */
const HOME: Camera = { x: 0, y: 0, zoom: 1 }

const id = (n: number) => idOf('note', n)
const update = (noteId: string, set: Record<string, unknown>) =>
  ({ op: 'note.update', id: noteId, set }) as ClientOp
const thread = (n: number, noteIds: string[]): Yarn => ({
  type: 'yarn',
  id: idOf('yarn', n),
  noteIds,
  color: 'indigo',
  label: '',
  createdAt: T0,
  updatedAt: T0,
})

/** A server whose board holds `notes` and `yarns`, at revision 1. */
function serverWith(notes: Note[], yarns: Yarn[] = []): FakeServer {
  const server = new FakeServer()
  server.commit([
    ...notes.map((n) => ({ op: 'note.create' as const, note: n })),
    ...yarns.map((y) => ({ op: 'yarn.create' as const, yarn: y })),
  ])
  return server
}

/** The part of `server`'s board in `rect`, as the store's region route answers it. */
const regionOf =
  (server: FakeServer): OpeningSource['region'] =>
  async (rect) => {
    const notes = [...server.state.notes.values()].filter(
      (n) => n.x >= rect.x0 && n.x <= rect.x1 && n.y >= rect.y0 && n.y <= rect.y1,
    )
    const shown = new Set(notes.map((n) => n.id))
    const yarns = [...server.state.yarns.values()].filter((y) =>
      y.noteIds.some((i) => shown.has(i)),
    )
    return { board: server.state.board, notes, others: [...server.state.assets.values(), ...yarns] }
  }

/** An opening source over a sync client, as a server session makes it. */
function sourceOn(client: SyncClient, region: OpeningSource['region']): OpeningSource {
  return {
    viewport: VIEWPORT,
    region,
    start: async () => {
      await client.start()
      return client.view
    },
  }
}

async function stagesOf(gen: AsyncGenerator<OpeningStage>): Promise<OpeningStage[]> {
  const out: OpeningStage[] = []
  for await (const s of gen) out.push(s)
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
})
afterEach(() => vi.useRealTimers())

describe('openBoard', () => {
  it('the first paint comes from the store’s region, and the whole board follows', async () => {
    const server = serverWith([note(id(1), { x: 100, y: 100 }), note(id(2), { x: 90_000 })])
    const h = connect(server)
    const gate = h.transport.gateLoads()
    const asked: unknown[] = []
    const region: OpeningSource['region'] = async (rect) => {
      asked.push(rect)
      return {
        board: server.state.board,
        notes: [server.state.notes.get(id(1)) as Note],
        others: [],
      }
    }
    const gen = openBoard(BOARD_ID, HOME, sourceOn(h.client, region))
    const first = (await gen.next()).value as OpeningStage
    expect(first.kind).toBe('firstPaint')
    expect(asked).toEqual([{ x0: -TILE, y0: -TILE, x1: 1280 + TILE, y1: 800 + TILE }])
    gate()
    const rest = await stagesOf(gen)
    expect(rest.map((s) => s.kind)).toEqual(['synced', 'ready'])
    h.client.stop()
  })

  it('no camera: nothing is painted before the whole board is in', async () => {
    const server = serverWith([note(id(1))])
    const h = connect(server)
    const stages = await stagesOf(openBoard(BOARD_ID, null, sourceOn(h.client, regionOf(server))))
    expect(stages.map((s) => s.kind)).toEqual(['synced', 'ready'])
    h.client.stop()
  })
})

// ---- the session: edits before the whole board is in ------------------------------------------

const sessions: BoardSession[] = []
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose()
})

async function openOn(server: FakeServer, o: { transport?: FakeTransport } = {}) {
  const transport = o.transport ?? new FakeTransport(server)
  const session = await openServerSession(BOARD_ID, {
    transport,
    env: null,
    camera: HOME,
    viewport: VIEWPORT,
    region: async (_id, rect) => regionOf(server)(rect),
  })
  sessions.push(session)
  return { session, transport }
}

/** Advance fake time until `done` holds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 120 && !done(); i++) await vi.advanceTimersByTimeAsync(i === 0 ? 0 : 1000)
  expect(done()).toBe(true)
}

const N9 = id(9)
const created = note(N9, { x: 300, y: 300, text: '' })

describe('opening a server session', () => {
  it('edits during opening are queued and applied once', async () => {
    const server = serverWith([note(id(1), { x: 100 }), note(id(2), { x: 50_000 })])
    const from = server.revision
    const transport = new FakeTransport(server)
    const release = transport.gateLoads()
    const { session } = await openOn(server, { transport })
    const sync = session.sync as SyncClient
    // The first paint is up; the rest has not come.
    expect(session.opening.open).toBe(true)
    expect(session.store.getState().notes.has(id(1))).toBe(true)
    expect(session.store.getState().notes.has(id(2))).toBe(false)

    // Meanwhile: a new note, written on, and N1 moved.
    session.store.commit([{ op: 'note.create', note: created }], { label: 'Add a note' })
    for (const text of ['m', 'mo', 'morning']) {
      session.store.commit([update(N9, { text })], { coalesceKey: `text:${N9}`, label: 'Edit' })
    }
    session.store.commit([update(id(1), { x: 140 })], { label: 'Move' })
    // Shown at once; nothing sent while the board opens.
    expect(session.store.getState().notes.get(N9)?.text).toBe('morning')
    expect(session.store.getState().notes.get(id(1))?.x).toBe(140)
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.sends).toHaveLength(0)
    expect(server.revision).toBe(from)

    release()
    await session.opening.done
    expect(session.opening.open).toBe(false)
    await until(() => sync.pending === 0 && sync.confirmed.board.revision === server.revision)

    // Each landed once, in order: the note, its text (one batch), the move.
    const mine = server.log.filter((e) => e.originClientId === sync.clientId)
    expect(mine.map((e) => e.ops.map((op) => op.op))).toEqual([
      ['note.create'],
      ['note.update'],
      ['note.update'],
    ])
    expect(mine[1]?.ops).toEqual([update(N9, { text: 'morning' })])
    expect(server.state.notes.get(id(1))?.x).toBe(140)
    // The store shows the client's view from now on, and later edits go straight to it.
    expect(session.store.getState()).toBe(sync.view)
    expect(session.store.getState().notes.has(id(2))).toBe(true)
    session.store.commit([update(N9, { x: 320 })])
    expect(sync.pending).toBe(1)
    await until(() => sync.pending === 0)
  })

  it('a note shown at the first paint is never brought back by a slice after its delete', async () => {
    const server = serverWith([note(id(1), { x: 100 }), note(id(2), { x: 50_000 })])
    const transport = new FakeTransport(server)
    const release = transport.gateLoads()
    const { session } = await openOn(server, { transport })
    session.store.commit([{ op: 'note.delete', id: id(1) }])
    release()
    await session.opening.done
    expect(session.store.getState().notes.has(id(1))).toBe(false)
    expect(session.store.getState().notes.has(id(2))).toBe(true)
  })

  it('the save dot and the download count edits made while the board opens', async () => {
    const server = serverWith([note(id(1), { x: 100 })])
    const transport = new FakeTransport(server)
    transport.gateLoads()
    const { session } = await openOn(server, { transport })
    session.store.commit([{ op: 'note.create', note: created }])
    session.store.commit([update(id(1), { x: 150 })])
    expect(session.feed.getState().pending).toBe(2)
    const jsonl = session.sync?.unsavedJsonl() ?? ''
    expect(jsonl.split('\n').filter((l) => l !== '')).toHaveLength(2)
    expect(jsonl).toContain(N9)
  })

  it('a shown note deleted and undone before the board is ready stays in the store', async () => {
    const n1 = note(id(1), { x: 100 })
    const server = serverWith([n1, note(id(2), { x: 50_000 }), note(id(3), { x: 90_000 })])
    const transport = new FakeTransport(server)
    const release = transport.gateLoads()
    const { session } = await openOn(server, { transport })
    const shown = session.store.getState().notes.get(id(1)) as Note
    session.store.commit([{ op: 'note.delete', id: id(1) }])
    // Undo: the note made again as it was.
    session.store.commit([{ op: 'note.create', note: shown }])
    release()
    await session.opening.done
    expect(session.store.getState().notes.has(id(1))).toBe(true)
  })

  it('deleted, undone and deleted again before the board is ready, a note stays gone', async () => {
    const server = serverWith([
      note(id(1), { x: 100 }),
      note(id(2), { x: 50_000 }),
      note(id(3), { x: 90_000 }),
    ])
    const transport = new FakeTransport(server)
    const release = transport.gateLoads()
    const { session } = await openOn(server, { transport })
    const shown = session.store.getState().notes.get(id(1)) as Note
    session.store.commit([{ op: 'note.delete', id: id(1) }])
    session.store.commit([{ op: 'note.create', note: shown }])
    session.store.commit([{ op: 'note.delete', id: id(1) }])
    release()
    await session.opening.done
    expect(session.store.getState().notes.has(id(1))).toBe(false)
  })

  it('the whole board is taken a slice at a time before the hand-over', async () => {
    const server = serverWith(
      [note(id(1), { x: 100 }), note(id(2), { x: 50_000 }), note(id(3), { x: 60_000 })],
      [thread(1, [id(2), id(3)])],
    )
    const transport = new FakeTransport(server)
    const told: Array<ReturnType<BoardSession['store']['touched']>> = []
    const session = await openServerSession(BOARD_ID, {
      transport,
      env: null,
      camera: HOME,
      viewport: VIEWPORT,
      region: async () => ({
        board: server.state.board,
        notes: [server.state.notes.get(id(1)) as Note],
        others: [],
      }),
    })
    sessions.push(session)
    session.store.subscribe((s, prev) => told.push(session.store.touched(s, prev)))
    await session.opening.done
    const s = session.store.getState()
    expect(s).toBe(session.sync?.view)
    expect([...s.notes.keys()].sort()).toEqual([id(1), id(2), id(3)].sort())
    expect(s.yarns.has(idOf('yarn', 1))).toBe(true)
    // Notes and the thread came in told slices; nothing was swapped in whole.
    expect(told).not.toContain('all')
    expect(told.some((t) => t !== undefined && t !== 'all' && t.notes.has(id(2)))).toBe(true)
  })
})

// With no camera remembered, a large board opens at the view that fits it, told by the store's
// meta, read first from the region route as any first paint is (loaded whole first, 100,000
// notes show nothing for 2.7–3.8 s).
describe('a board with no camera remembered', () => {
  const notes = [note(id(1), { x: -4000, y: 0 }), note(id(2), { x: 8000, y: 3000 })]
  const open = async (count: number, asked: Array<{ x0: number; x1: number }>) => {
    const server = serverWith(notes)
    const session = await openServerSession(BOARD_ID, {
      transport: new FakeTransport(server),
      env: null,
      viewport: VIEWPORT,
      extent: async () => ({ notes: count, extent: { x0: -4000, y0: 0, x1: 8240, y1: 3160 } }),
      region: async (_id, rect) => {
        asked.push(rect)
        return {
          board: server.state.board,
          notes: [server.state.notes.get(id(1)) as Note],
          others: [],
        }
      },
    })
    sessions.push(session)
    return session
  }

  it('opens a large board fitted, its first paint read from that view', async () => {
    const asked: Array<{ x0: number; x1: number }> = []
    const session = await open(100_000, asked)
    const cam = session.camera as Camera
    expect(cam).not.toBeNull()
    // The whole extent in view, with the fit's padding, at no more than 100 %.
    expect(cam.zoom).toBeCloseTo((VIEWPORT.width - 128) / 12_240, 9)
    expect(cam.x).toBeLessThan(-4000)
    expect(cam.x + VIEWPORT.width / cam.zoom).toBeGreaterThan(8240)
    expect(asked).toHaveLength(1)
    expect(session.store.getState().notes.has(id(1))).toBe(true)
    await session.opening.done
    expect(session.store.getState().notes.size).toBe(2)
  })

  // The meta is one round trip in sequence before such an open: it is waited for a short while only.
  it('waits for the meta a short while at most: without its answer by then, the board loads whole', async () => {
    const server = serverWith(notes)
    const extent = vi.fn(() => new Promise<never>(() => {}))
    let session: BoardSession | null = null
    void openServerSession(BOARD_ID, {
      transport: new FakeTransport(server),
      env: null,
      viewport: VIEWPORT,
      extent,
    }).then((s) => {
      session = s
      sessions.push(s)
    })
    await vi.advanceTimersByTimeAsync(299)
    expect(extent).toHaveBeenCalledTimes(1)
    expect(session).toBeNull()
    await vi.advanceTimersByTimeAsync(50)
    expect(session).not.toBeNull()
    if (session === null) return
    session = session as BoardSession
    expect(META_WAIT_MS).toBe(300)
    expect(session.camera).toBeNull()
    await session.opening.done
    expect(session.store.getState().notes.size).toBe(2)
  })

  it('opens a small board whole, as before: fitted once it is in', async () => {
    const asked: Array<{ x0: number; x1: number }> = []
    const session = await open(2, asked)
    expect(session.camera).toBeNull()
    expect(asked).toEqual([])
    await session.opening.done
    expect(session.store.getState().notes.size).toBe(2)
  })
})
