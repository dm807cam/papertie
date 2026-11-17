import { emptyBoardState, serializeBoard } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHttpTransport, type EventSourceLike, type SyncEvent } from '../../src/sync/transport'
import type { CommitEvent } from '../../src/sync/types'

const BOARD = `board_${'0'.repeat(25)}1`
const NOW = '2026-10-30T09:00:00.000Z'

class StubSource implements EventSourceLike {
  readyState = 0
  onopen: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  closed = false
  private readonly listeners = new Map<string, Array<(e: MessageEvent) => void>>()

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (e: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closed = true
    this.readyState = 2
  }

  frame(type: string, data: unknown): void {
    const e = new MessageEvent(type, {
      data: typeof data === 'string' ? data : JSON.stringify(data),
    })
    for (const fn of this.listeners.get(type) ?? []) fn(e)
  }

  /** The connection fails; `gaveUp` is the browser closing it for good (a non-200 answer). */
  fail(gaveUp: boolean): void {
    this.readyState = gaveUp ? 2 : 0
    this.onerror?.(new Event('error'))
  }
}

const commit = (revision: number): CommitEvent => ({
  revision,
  ops: [{ op: 'board.update', set: { name: `r${revision}` } }],
  originClientId: null,
  seq: null,
  now: NOW,
})

let sources: StubSource[] = []
const open = (url: string) => {
  const s = new StubSource(url)
  sources.push(s)
  return s
}
const latest = () => sources.at(-1) as StubSource

beforeEach(() => {
  vi.useFakeTimers()
  sources = []
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('createHttpTransport requests', () => {
  it('loads, sends and catches up through the board API', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const t = createHttpTransport(BOARD, open)
    expect(t.boardId).toBe(BOARD)

    const state = emptyBoardState(BOARD, 'B', NOW)
    fetchMock.mockResolvedValueOnce(
      new Response(serializeBoard(state), {
        headers: { 'X-Papertie-Revision': '0', 'X-Papertie-Now': NOW },
      }),
    )
    const loaded = await t.load()
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/boards/${BOARD}`)
    expect(loaded).toMatchObject({ revision: 0, serverNow: NOW, serverNowKnown: true })

    const ack = { clientId: 'tab_x', seq: 1, revision: 1, now: NOW, duplicate: false }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(ack)))
    const body = {
      clientId: `tab_${'0'.repeat(26)}`,
      seq: 1,
      baseRevision: 0,
      ops: [{ op: 'board.update' as const, set: { name: 'x' } }],
    }
    expect(await t.send(body)).toEqual(ack)
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe(`/api/boards/${BOARD}/ops`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual(body)

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ revision: 3, full: true })))
    expect(await t.since(2)).toEqual({ revision: 3, full: true })
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/api/boards/${BOARD}/ops?since=2`)
    // The server's clock comes with it (a resume may load nothing else).
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ revision: 3, commits: [] }), {
        headers: { 'X-Papertie-Now': NOW, 'X-Papertie-Recovered': '1' },
      }),
    )
    expect(await t.since(3)).toEqual({
      revision: 3,
      commits: [],
      serverNow: NOW,
      recovered: true,
    })
  })
})

describe('createHttpTransport events', () => {
  it('opens at the revision, passes hello, commit and reset frames, and ignores malformed ones', () => {
    const seen: SyncEvent[] = []
    createHttpTransport(BOARD, open).events(5, (e) => seen.push(e))
    expect(latest().url).toBe(`/api/boards/${BOARD}/events?since=5`)
    latest().frame('hello', { revision: 5 })
    latest().frame('commit', commit(6))
    latest().frame('commit', '{not json')
    latest().frame('commit', { revision: 'seven' })
    latest().frame('reset', { revision: 9 })
    expect(seen).toEqual([
      { type: 'hello', revision: 5 },
      { type: 'commit', event: commit(6) },
      { type: 'reset', revision: 9 },
    ])
  })

  it('a new stream opens without a revision', () => {
    createHttpTransport(BOARD, open).events(null, () => {})
    expect(latest().url).toBe(`/api/boards/${BOARD}/events`)
  })

  it('leaves a dropped stream to the browser, and reopens one it gave up on after 5 s from the last commit', () => {
    const seen: SyncEvent[] = []
    createHttpTransport(BOARD, open).events(5, (e) => seen.push(e))
    const first = latest()
    first.frame('commit', commit(6))

    // Dropped: the browser reconnects by itself (sending Last-Event-ID 6).
    first.fail(false)
    first.fail(false)
    expect(seen.filter((e) => e.type === 'down')).toEqual([{ type: 'down', status: null }])
    vi.advanceTimersByTime(60_000)
    expect(sources).toHaveLength(1)

    // Given up (say a 429): reopened here, never sooner than the stream cap's Retry-After.
    first.fail(true)
    expect(first.closed).toBe(true)
    vi.advanceTimersByTime(4999)
    expect(sources).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sources).toHaveLength(2)
    expect(latest().url).toBe(`/api/boards/${BOARD}/events?since=6`)

    // Frames from the replaced source are ignored; the new one delivers.
    first.frame('commit', commit(7))
    latest().frame('commit', commit(7))
    expect(seen.filter((e) => e.type === 'commit')).toEqual([
      { type: 'commit', event: commit(6) },
      { type: 'commit', event: commit(7) },
    ])
  })

  it('backs off 5, 10, 20, 30 s while the browser keeps giving up', () => {
    createHttpTransport(BOARD, open).events(1, () => {})
    const delays: number[] = []
    for (let i = 0; i < 5; i++) {
      const before = Date.now()
      latest().fail(true)
      const count = sources.length
      while (sources.length === count) vi.advanceTimersByTime(1000)
      delays.push(Date.now() - before)
    }
    expect(delays).toEqual([5000, 10_000, 20_000, 30_000, 30_000])
  })

  it('reopens past a reset at once, so a later reconnect never resumes from before it', () => {
    createHttpTransport(BOARD, open).events(5, () => {})
    const first = latest()
    first.frame('reset', { revision: 12 })
    expect(first.closed).toBe(true)
    expect(latest().url).toBe(`/api/boards/${BOARD}/events?since=12`)
  })

  it('closing stops the stream and any reopen', () => {
    const seen: SyncEvent[] = []
    const close = createHttpTransport(BOARD, open).events(5, (e) => seen.push(e))
    latest().fail(true)
    close()
    vi.advanceTimersByTime(60_000)
    expect(sources).toHaveLength(1)
    latest().frame('commit', commit(6))
    expect(seen).toEqual([{ type: 'down', status: null }])
  })
})
