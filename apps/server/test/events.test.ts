import { readFileSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeepPartial, ServerConfig } from '../src/config'
import { boardFile, compactBoard, createBoard, noteCreate, postOps, tabNow } from './helpers/boards'
import type { TestUser } from './helpers/client'
import { startTestServer, type TestServer } from './helpers/harness'
import { type EventStream, openEvents } from './helpers/sse'

const NOW = '2026-10-27T10:00:00.000Z'

let server: TestServer
let user: TestUser
let board: string
const streams: EventStream[] = []

async function start(config: DeepPartial<ServerConfig> = {}) {
  server = await startTestServer({
    config: {
      ...config,
      sseKeepaliveMs: config.sseKeepaliveMs ?? 50,
    },
  })
  user = server.user
  board = await createBoard(user)
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const s of streams.splice(0)) s.close()
  await server.close()
})

const open = async (u = user, id = board, opts: { lastEventId?: string } = {}) => {
  const s = await openEvents(u, id, opts)
  streams.push(s)
  return s
}

/** Commit one note (a batch of `n` notes) from `clientId`; the ack. */
async function commit(clientId: string, seq: number, baseRevision: number, u = user, id = board) {
  const res = await postOps(u, id, { clientId, seq, baseRevision, ops: [noteCreate({ at: NOW })] })
  expect(res.status).toBe(200)
  return (await res.json()) as { revision: number; now: string }
}

/**
 * Opens the events stream over a raw socket and, once `hello` has arrived, stops reading from it.
 * `closed` resolves when the server has dropped the connection (the buffered bytes are read first).
 */
async function openThenStall(id: string): Promise<{ socket: Socket; closed: Promise<void> }> {
  const { port, hostname } = new URL(server.url)
  const socket = connect(Number(port), hostname)
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
  socket.on('error', () => {})
  socket.write(
    `GET /api/boards/${id}/events HTTP/1.1\r\nHost: ${hostname}\r\nOrigin: ${server.url}\r\n\r\n`,
  )
  await new Promise<void>((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error(`no hello: ${JSON.stringify(text)}`)), 2000)
    socket.on('data', function onData(chunk) {
      text += chunk.toString()
      if (!text.includes('event: hello')) return
      clearTimeout(timer)
      socket.off('data', onData)
      socket.pause()
      resolve()
    })
  })
  return { socket, closed }
}

/** Big commits (~800 KB each) so that a client that is not reading fills the socket buffers. */
async function floodBoard(commits: number) {
  const tab = tabNow(server)
  for (let i = 1; i <= commits; i++) {
    const ops = Array.from({ length: 40 }, () => noteCreate({ text: 'x'.repeat(20_000), at: NOW }))
    const res = await postOps(user, board, { clientId: tab, seq: i, baseRevision: i - 1, ops })
    expect(res.status).toBe(200)
  }
}

const until = async (check: () => boolean, ms = 1000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('GET /api/boards/:id/events', () => {
  it('opens with retry and hello at the current revision', async () => {
    await start()
    const res = await user.request(`/api/boards/${board}/events`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-store')
    await res.body?.cancel()

    const s = await open()
    expect(await s.next()).toEqual({ event: 'hello', data: { revision: 0 } })
    expect(s.retry).toBe(2000)
  })

  it("forwards a commit with id, origin, seq and the commit's now", async () => {
    await start()
    const tab1 = await open()
    await tab1.next() // hello
    const tab2 = tabNow(server)
    const ops = [noteCreate({ at: NOW })]
    const res = await postOps(user, board, { clientId: tab2, seq: 1, baseRevision: 0, ops })
    const ack = (await res.json()) as { now: string }

    const msg = await tab1.next()
    expect(msg.event).toBe('commit')
    expect(msg.id).toBe('1')
    expect(msg.data).toEqual({ revision: 1, ops, originClientId: tab2, seq: 1, now: ack.now })
  })

  it('delivers a staged transaction as one commit', async () => {
    await start()
    const s = await open()
    await s.next()
    const clientId = tabNow(server)
    const send = (index: number) =>
      postOps(user, board, {
        clientId,
        seq: 1,
        baseRevision: 0,
        ops: [noteCreate({ at: NOW })],
        part: { index, count: 2, digest: 'a'.repeat(32) },
      })
    expect((await send(0)).status).toBe(202)
    expect((await send(1)).status).toBe(200)

    const msg = await s.next()
    expect(msg).toMatchObject({ event: 'commit', id: '1' })
    expect((msg.data as { ops: unknown[] }).ops).toHaveLength(2)
    await expect(s.next(150)).rejects.toThrow(/no SSE message/)
  })

  it('sends keepalive comments', async () => {
    await start()
    const s = await open()
    await s.next()
    await until(() => s.comments.includes('keepalive'), 200)
  })

  describe('replay', () => {
    it('Last-Event-ID replays the commits after it, then goes live', async () => {
      await start()
      const tab = tabNow(server)
      for (let i = 1; i <= 3; i++) await commit(tab, i, i - 1)
      const s = await open(user, board, { lastEventId: '1' })
      expect(await s.next()).toMatchObject({ event: 'commit', id: '2', data: { revision: 2 } })
      expect(await s.next()).toMatchObject({ event: 'commit', id: '3', data: { revision: 3 } })
      await commit(tab, 4, 3)
      expect(await s.next()).toMatchObject({ event: 'commit', id: '4' })
    })

    it('?since= works like Last-Event-ID', async () => {
      await start()
      const tab = tabNow(server)
      for (let i = 1; i <= 3; i++) await commit(tab, i, i - 1)
      const abort = new AbortController()
      const res = await user.request(`/api/boards/${board}/events?since=2`, {
        signal: abort.signal,
      })
      expect(res.status).toBe(200)
      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let text = ''
      while (!text.includes('event: commit')) {
        const chunk = await reader?.read()
        if (!chunk || chunk.done) break
        text += decoder.decode(chunk.value)
      }
      abort.abort()
      expect(text).toContain('retry: 2000')
      expect(text).toContain('id: 3\nevent: commit')
      expect(text).not.toContain('id: 2\n')
    })

    it('answers reset when the ring cannot supply the gap, or the client is ahead', async () => {
      await start({ store: { ringCommits: 2 } })
      const tab = tabNow(server)
      for (let i = 1; i <= 3; i++) await commit(tab, i, i - 1)
      const gap = await open(user, board, { lastEventId: '0' })
      expect(await gap.next()).toEqual({ event: 'reset', data: { revision: 3 } })
      const ahead = await open(user, board, { lastEventId: '99' })
      expect(await ahead.next()).toEqual({ event: 'reset', data: { revision: 3 } })
      const current = await open(user, board, { lastEventId: '3' })
      await expect(current.next(150)).rejects.toThrow(/no SSE message/)
    })

    it('loses and repeats nothing when commits land while a stream opens', async () => {
      await start()
      const tab = tabNow(server)
      const writer = (async () => {
        for (let i = 1; i <= 25; i++) await commit(tab, i, i - 1)
      })()
      const s = await open(user, board, { lastEventId: '0' })
      const seen: number[] = []
      while (seen.at(-1) !== 25) {
        const m = await s.next()
        expect(m.event).toBe('commit')
        seen.push((m.data as { revision: number }).revision)
      }
      await writer
      expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    })

    it.each(['abc', '-1', '1.5', '', '1e3'])(
      'rejects Last-Event-ID %j with 400 and no stream',
      async (v) => {
        await start()
        const res = await user.request(`/api/boards/${board}/events`, {
          headers: { 'Last-Event-ID': v },
        })
        expect(res.status).toBe(400)
        expect(res.headers.get('content-type')).toContain('application/json')
        expect(await res.json()).toEqual({ error: 'invalid' })
        const q = await user.request(`/api/boards/${board}/events?since=${v}`)
        expect(q.status).toBe(400)
      },
    )
  })

  it('tells open streams to reset when board.jsonl is edited by hand', async () => {
    await start()
    await commit(tabNow(server), 1, 0)
    await compactBoard(server, user.id, board) // the note is in board.jsonl now
    const s = await open()
    expect(await s.next()).toMatchObject({ event: 'hello', data: { revision: 1 } })
    const file = boardFile(server, user.id, board)
    writeFileSync(file, readFileSync(file, 'utf8').replace('"hello"', '"hand edit!"'))
    const res = await user.request(`/api/boards/${board}`)
    expect(res.status).toBe(200)
    const revision = Number(res.headers.get('x-papertie-revision'))
    expect(revision).toBeGreaterThan(1) // recovery of the edit is itself a revision
    expect(await s.next()).toEqual({ event: 'reset', data: { revision } })
  })

  describe('closing', () => {
    it('unsubscribes when the client hangs up', async () => {
      await start()
      const s = await open()
      await s.next()
      expect(server.deps.store?.hub.countUser(user.id)).toBe(1)
      s.close()
      await s.closed
      await until(() => server.deps.store?.hub.countUser(user.id) === 0)
    })

    it('ends the stream when the store closes the board', async () => {
      await start()
      const s = await open()
      await s.next()
      await server.deps.store?.closeUser(user.id)
      await Promise.race([
        s.closed,
        new Promise((_, no) => setTimeout(() => no(new Error('stream still open')), 500)),
      ])
      expect(server.deps.store?.hub.countUser(user.id)).toBe(0)
    })

    it('drops a client that stopped reading once too many frames are queued for it', async () => {
      await start({ sseKeepaliveMs: 2 })
      const stalled = await openThenStall(board)
      await floodBoard(15)
      await until(() => server.deps.store?.hub.countUser(user.id) === 0, 8000)
      stalled.socket.resume()
      await stalled.closed
    }, 30_000)

    it('server close() does not hang on open streams', async () => {
      await start()
      const s = await open()
      await s.next()
      await server.close()
      await s.closed
      server = await startTestServer() // for afterEach
    })
  })
})

describe('GET /api/boards/:id/ops?since', () => {
  const since = (v: string, u = user) => u.request(`/api/boards/${board}/ops?since=${v}`)

  it('returns the commits after since, or none when up to date', async () => {
    await start()
    const tab = tabNow(server)
    const acks = [await commit(tab, 1, 0), await commit(tab, 2, 1), await commit(tab, 3, 2)]
    const res = await since('1')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // The server's clock, as on a load: a page catching up loads nothing else.
    expect(res.headers.get('x-papertie-now')).toBe(server.clock.now().toISOString())
    // A board never repaired or restored: no recovery to tell of.
    expect(res.headers.get('x-papertie-recovered')).toBeNull()
    const body = (await res.json()) as { revision: number; commits: Array<{ revision: number }> }
    expect(body.revision).toBe(3)
    expect(body.commits.map((c) => c.revision)).toEqual([2, 3])
    expect(body.commits[0]).toMatchObject({ originClientId: tab, seq: 2, now: acks[1]?.now })
    expect(await (await since('3')).json()).toEqual({ revision: 3, commits: [] })
  })

  it('answers full when ahead of the board or past the ring', async () => {
    await start({ store: { ringCommits: 2 } })
    const tab = tabNow(server)
    for (let i = 1; i <= 3; i++) await commit(tab, i, i - 1)
    expect(await (await since('99')).json()).toEqual({ revision: 3, full: true })
    expect(await (await since('0')).json()).toEqual({ revision: 3, full: true })
  })

  it.each(['-1', 'abc', '1.5', ''])('rejects since=%j with 400', async (v) => {
    await start()
    const res = await since(v)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid' })
  })

  it('rejects a missing since', async () => {
    await start()
    expect((await user.request(`/api/boards/${board}/ops`)).status).toBe(400)
  })
})
