/**
 * The page's client of the store (`sync/SyncClient.ts`): one writer. Edits show at once and are
 * sent one at a time; the store's own commits and a board replaced whole are taken in.
 */
import { type ClientOp, serializeBoard } from '@papertie/core'
import { COALESCE_IDLE_MS, COALESCE_MAX_MS } from '../../src/sync/SyncClient'
import { BOOK, bookServer, makeBook, para, textOf, typeAt } from '../helpers/books'
import {
  apiError,
  connect,
  FakeServer,
  type Harness,
  idOf,
  note,
  settle,
  T0,
} from '../helpers/fakeServer'

const N1 = idOf('note', 1)
const N2 = idOf('note', 2)
const create = (id: string, x = 0): ClientOp => ({ op: 'note.create', note: note(id, { x }) })
const update = (id: string, set: Record<string, unknown>) =>
  ({ op: 'note.update', id, set }) as ClientOp

const started: Harness[] = []
async function start(server: FakeServer) {
  const h = connect(server)
  started.push(h)
  await h.client.start()
  return h
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
})
afterEach(() => {
  for (const h of started.splice(0)) h.client.stop()
  vi.useRealTimers()
})

describe('SyncClient', () => {
  it('an edit shows at once, is sent, and the confirmed board ends as the store’s', async () => {
    const server = new FakeServer()
    const a = await start(server)
    const view = a.client.submit([create(N1, 10)])
    expect(view.notes.get(N1)?.x).toBe(10)
    expect(a.client.pending).toBe(1)
    expect(a.statuses.at(-1)).toBe('saving')
    await settle(server, a)
    expect(a.statuses.at(-1)).toBe('saved')
    expect(serializeBoard(a.client.confirmed)).toBe(serializeBoard(server.state))
    expect(server.log.map((e) => e.originClientId)).toEqual([a.client.clientId])
  })

  it('typing is one edit: it waits while keys come, and never longer than the cap', async () => {
    const server = new FakeServer()
    const a = await start(server)
    a.client.submit([create(N1)])
    await settle(server, a)
    const sends = a.transport.sends.length
    for (const text of ['a', 'ab', 'abc']) {
      a.client.submit([update(N1, { text })], { coalesceKey: `text:${N1}` })
      await vi.advanceTimersByTimeAsync(COALESCE_IDLE_MS - 100)
    }
    expect(a.transport.sends).toHaveLength(sends)
    expect(a.client.pending).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    await settle(server, a)
    expect(a.transport.sends).toHaveLength(sends + 1)
    expect(server.state.notes.get(N1)?.text).toBe('abc')

    // Keys that never pause still go once the cap is reached.
    const before = a.transport.sends.length
    for (let t = 0; t < COALESCE_MAX_MS + 500; t += 200) {
      a.client.submit([update(N1, { text: `t${t}` })], { coalesceKey: `text:${N1}` })
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(a.transport.sends.length).toBeGreaterThan(before)
  })

  it('edits go one at a time, in order, each against the confirmed board', async () => {
    const server = new FakeServer()
    const a = await start(server)
    const release = a.transport.gateSends()
    a.client.submit([create(N1)])
    a.client.submit([create(N2)])
    a.client.submit([update(N1, { x: 5 })])
    await vi.advanceTimersByTimeAsync(0)
    expect(server.revision).toBe(0)
    release()
    await settle(server, a)
    expect(server.log.map((e) => [e.seq, e.ops.map((op) => op.op)])).toEqual([
      [1, ['note.create']],
      [2, ['note.create']],
      [3, ['note.update']],
    ])
    expect(a.transport.sends.map((s) => s.body.baseRevision)).toEqual([0, 1, 2])
  })

  it('flush sends typing now and resolves once everything is committed', async () => {
    const server = new FakeServer()
    const a = await start(server)
    a.client.submit([create(N1)])
    a.client.submit([update(N1, { text: 'draft' })], { coalesceKey: `text:${N1}` })
    const flushed = a.client.flush()
    await vi.advanceTimersByTimeAsync(0)
    await flushed
    expect(a.client.pending).toBe(0)
    expect(server.state.notes.get(N1)?.text).toBe('draft')
  })

  it('edits held while the board opens are submitted, in order, once it is in', async () => {
    const server = new FakeServer()
    server.commit([create(N1)])
    const a = connect(server)
    started.push(a)
    a.client.hold([update(N1, { x: 7 })])
    a.client.hold([update(N1, { text: 'a' })], { coalesceKey: `text:${N1}` })
    a.client.hold([update(N1, { text: 'ab' })], { coalesceKey: `text:${N1}` })
    // One that cannot apply to the board as it is: dropped, kept for the download, and said.
    a.client.hold([update(N2, { x: 1 })])
    expect(a.client.pending).toBe(3)
    await a.client.start()
    expect(a.client.view.notes.get(N1)).toMatchObject({ x: 7, text: 'ab' })
    await settle(server, a)
    expect(server.state.notes.get(N1)).toMatchObject({ x: 7, text: 'ab' })
    expect(a.notices.map((n) => [n.kind, n.count])).toEqual([['dropped', 1]])
    expect(a.client.unsavedJsonl()).toContain(N2)
  })

  it('the store’s own commits are taken in, under what the page has not sent yet', async () => {
    const server = new FakeServer()
    const a = await start(server)
    a.client.submit([create(N1)])
    await settle(server, a)
    const release = a.transport.gateSends()
    a.client.submit([update(N1, { x: 9 })])
    server.commit([create(N2, 3)])
    await vi.advanceTimersByTimeAsync(0)
    expect(a.client.view.notes.get(N2)?.x).toBe(3)
    expect(a.client.view.notes.get(N1)?.x).toBe(9)
    expect(a.views).toContain('remote')
    release()
    await settle(server, a)
    expect(serializeBoard(a.client.confirmed)).toBe(serializeBoard(server.state))
  })

  it('a commit the stream lost is asked for', async () => {
    const server = new FakeServer()
    const a = await start(server)
    a.transport.dropNextEvents(1)
    a.client.submit([create(N1)])
    await settle(server, a)
    expect(a.transport.sinceCalls.length).toBeGreaterThan(0)
    expect(a.client.confirmed.notes.has(N1)).toBe(true)
  })

  it('an answer that is lost: sent again, committed once', async () => {
    const server = new FakeServer()
    const a = await start(server)
    a.transport.loseNextAck()
    a.client.submit([create(N1)])
    await settle(server, a)
    expect(server.log).toHaveLength(1)
    expect(a.client.pending).toBe(0)
  })

  it('the store out of reach: the edit waits, said as offline, and goes when it is back', async () => {
    const server = new FakeServer()
    const a = await start(server)
    a.transport.offline = true
    a.client.submit([create(N1)])
    await vi.advanceTimersByTimeAsync(3000)
    expect(a.statuses.at(-1)).toBe('offline')
    expect(a.client.pending).toBe(1)
    a.transport.offline = false
    await settle(server, a)
    expect(a.statuses.at(-1)).toBe('saved')
    expect(server.state.notes.has(N1)).toBe(true)
  })

  it('an edit the store refuses is dropped, kept for the download, and said; the next goes on', async () => {
    const server = new FakeServer()
    const a = await start(server)
    a.transport.failNext(apiError(422, 'rejected', { code: 'conflict', index: 0 }))
    a.client.submit([create(N1)])
    a.client.submit([create(N2)])
    await settle(server, a)
    expect(a.notices.map((n) => [n.kind, n.count])).toEqual([['rejected', 1]])
    expect(a.client.view.notes.has(N1)).toBe(false)
    expect(server.state.notes.has(N2)).toBe(true)
    expect(a.client.unsavedJsonl()).toContain(N1)
    expect(a.client.unsavedParts().dropped).toHaveLength(1)
  })

  it('a failure trying again will not fix soon is said as an error, and looked at again', async () => {
    const server = new FakeServer()
    const a = await start(server)
    a.transport.failNext(apiError(403, 'forbidden'))
    a.client.submit([create(N1)])
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.statuses.at(-1)).toBe('error')
    await vi.advanceTimersByTimeAsync(30_000)
    await settle(server, a)
    expect(server.state.notes.has(N1)).toBe(true)
  })

  it('a board replaced whole (an import, a restore) is read again, said, and what waits goes on top', async () => {
    const server = new FakeServer()
    const a = await start(server)
    a.client.submit([create(N1)])
    await settle(server, a)
    const other = new FakeServer()
    other.commit([create(N2, 4)])
    server.restore(other.state)
    await vi.advanceTimersByTimeAsync(0)
    await settle(server, a)
    expect(a.views).toContain('reset')
    expect(a.notices.map((n) => n.kind)).toContain('reset')
    expect(a.client.view.notes.has(N1)).toBe(false)
    expect(a.client.view.notes.get(N2)?.x).toBe(4)
    a.client.submit([update(N2, { x: 5 })])
    await settle(server, a)
    expect(server.state.notes.get(N2)?.x).toBe(5)
  })

  it('a load that cannot be fixed by trying again rejects the start', async () => {
    const server = new FakeServer()
    const a = connect(server)
    started.push(a)
    const fail = vi.spyOn(a.transport, 'load').mockRejectedValue(apiError(404, 'not-found'))
    await expect(a.client.start()).rejects.toMatchObject({ status: 404 })
    fail.mockRestore()
  })

  it('an edit of more than one request carries goes in parts, as one commit', async () => {
    const server = new FakeServer()
    const a = await start(server)
    const ops = Array.from({ length: 1200 }, (_, i) => create(idOf('note', 100 + i), i))
    a.client.submit(ops)
    await settle(server, a)
    expect(server.log).toHaveLength(1)
    expect(server.state.notes.size).toBe(1200)
    expect(a.transport.sends.length).toBe(3)
  })

  it('as the page goes, every edit not yet sent goes as one request', async () => {
    const server = new FakeServer()
    const a = await start(server)
    a.transport.gateSends()
    expect(a.client.keepaliveBatch()).toBeNull()
    a.client.submit([create(N1)], { coalesceKey: 'k' })
    a.client.submit([create(N2)])
    const body = a.client.keepaliveBatch()
    expect(body).toMatchObject({ clientId: a.client.clientId, seq: 1, baseRevision: 0 })
    expect(body?.ops.map((op) => op.op)).toEqual(['note.create', 'note.create'])
    // Too large for one request: left to the next launch's nothing (it is not sent in part).
    expect(a.client.keepaliveBatch(10)).toBeNull()
  })
})

describe('SyncClient, books', () => {
  it('a book’s paragraphs are held once read, and edits in it are sent', async () => {
    const server = bookServer(new FakeServer(), ['hello'])
    const a = await start(server)
    expect(a.client.confirmed.blocks.size).toBe(0)
    const f = await a.client.fetchBook(BOOK)
    expect(await a.client.holdBook(BOOK, f?.blocks ?? [], f?.revision ?? 0)).toBe('held')
    expect(textOf(a.client.view, 1)).toBe('hello')
    a.client.submit([typeAt(1, 5, ' there')], { coalesceKey: `block:${para(1)}` })
    expect(a.client.hasPendingOn(BOOK)).toBe(true)
    await settle(server, a)
    expect(a.client.hasPendingOn(BOOK)).toBe(false)
    expect(textOf(server.state, 1)).toBe('hello there')
    a.client.releaseBook(BOOK)
    await vi.advanceTimersByTimeAsync(0)
    expect(a.client.confirmed.blocks.size).toBe(0)
  })

  it('a book that changed after it was read is stale; one that is gone is gone', async () => {
    const server = bookServer(new FakeServer(), ['one'])
    const a = await start(server)
    const f = await a.client.fetchBook(BOOK)
    server.commit([typeAt(1, 3, ' two')])
    await settle(server, a)
    expect(await a.client.holdBook(BOOK, f?.blocks ?? [], f?.revision ?? 0)).toBe('stale')
    expect(await a.client.holdBook(idOf('book', 9), [], server.revision)).toBe('gone')
  })

  it('a book this page makes is held from the start: typing in it needs no read', async () => {
    const server = new FakeServer()
    const a = await start(server)
    a.client.submit(makeBook(['']))
    a.client.submit([typeAt(1, 0, 'first words')])
    expect(textOf(a.client.view, 1)).toBe('first words')
    await settle(server, a)
    expect(textOf(server.state, 1)).toBe('first words')
    expect(textOf(a.client.view, 1)).toBe('first words')
  })

  it('a board replaced whole tells which books were held, to be read again', async () => {
    const server = bookServer(new FakeServer(), ['kept'])
    const reset: string[][] = []
    const a = await start(server)
    ;(a.client as unknown as { o: { onBooksReset(ids: string[]): void } }).o.onBooksReset = (ids) =>
      reset.push(ids)
    const f = await a.client.fetchBook(BOOK)
    await a.client.holdBook(BOOK, f?.blocks ?? [], f?.revision ?? 0)
    server.restore(bookServer(new FakeServer(), ['restored']).state)
    await vi.advanceTimersByTimeAsync(0)
    await settle(server, a)
    expect(reset).toEqual([[BOOK]])
    expect(a.client.confirmed.blocks.size).toBe(0)
  })
})

describe('SyncClient, the page leaving while the board opens', () => {
  it('held edits go as one request against the board painted; a page that stays submits them once', async () => {
    const server = new FakeServer()
    server.commit([create(N1)])
    const a = connect(server)
    started.push(a)
    a.client.hold([update(N1, { x: 4 })])
    // Not before the page knows which board they were made on.
    expect(a.client.keepaliveBatch()).toBeNull()
    a.client.paintedAt(1)
    const body = a.client.keepaliveBatch()
    expect(body).toMatchObject({ seq: 1, baseRevision: 1, ops: [update(N1, { x: 4 })] })
    expect(a.client.keepaliveBatch()).toBeNull()
    // The request never reached the store, and the page stayed: submitted at the start.
    await a.client.start()
    await settle(server, a)
    expect(server.state.notes.get(N1)?.x).toBe(4)
    expect(server.log.filter((e) => e.originClientId === a.client.clientId)).toHaveLength(1)
  })

  it('held edits the store took as the page went are not submitted again', async () => {
    const server = new FakeServer()
    server.commit([create(N1)])
    const a = connect(server)
    started.push(a)
    a.client.hold([update(N1, { x: 4 })])
    a.client.paintedAt(1)
    const body = a.client.keepaliveBatch()
    if (!body) throw new Error('no parting batch')
    await server.post(body)
    await a.client.start()
    await settle(server, a)
    expect(server.log.filter((e) => e.originClientId === a.client.clientId)).toHaveLength(1)
    expect(a.client.pending).toBe(0)
  })
})
