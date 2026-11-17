import type { OpBatch } from '@papertie/core'
import {
  type FetchedBook,
  fetchBook,
  type LoadedBoard,
  loadBoard,
  type OpsSince,
  opsSince,
  postBatch,
} from '../api/boards'
import type { CommitAck, CommitEvent, StagedAck, StagedPart } from './types'

/**
 * What the board's event stream says. `hello` opens a stream started without a revision; `commit`
 * is one commit (its `revision` is the frame id); `reset` means the board changed behind the
 * store and must be loaded again; `down` means the stream dropped (the transport reconnects).
 */
export type SyncEvent =
  | { type: 'hello'; revision: number }
  | { type: 'commit'; event: CommitEvent }
  | { type: 'reset'; revision: number }
  | { type: 'down'; status: number | null }

/** Everything the sync engine needs from the server for one board. */
export interface SyncTransport {
  readonly boardId: string
  load(): Promise<LoadedBoard>
  send(body: OpBatch | StagedPart): Promise<CommitAck | StagedAck>
  since(rev: number): Promise<OpsSince>
  /** One book and its blocks, of one revision (`GET /books/:bookId`); null when it is gone. */
  book(bookId: string): Promise<FetchedBook | null>
  /**
   * Open the event stream, resuming after revision `since` (null: a new stream, which starts
   * with `hello`). The transport reconnects by itself; the returned function closes it.
   */
  events(since: number | null, on: (e: SyncEvent) => void): () => void
}

/** The part of `EventSource` the transport uses. */
export interface EventSourceLike {
  readonly readyState: number
  onopen: ((e: Event) => void) | null
  onerror: ((e: Event) => void) | null
  addEventListener(type: string, listener: (e: MessageEvent) => void): void
  close(): void
}

/** `EventSource.CLOSED`: the browser gave up on the stream and will not reconnect it. */
const CLOSED = 2

/**
 * Delays before reopening a stream the browser gave up on (a non-200 answer, such as the 429 of
 * the per-user stream cap). `EventSource` hides the status and its `Retry-After`, so the first
 * delay is the server's stream-cap `Retry-After` (5 s), and none is sooner.
 */
const REOPEN_MS = [5000, 10_000, 20_000, 30_000]

export const eventsUrl = (boardId: string, since: number | null): string =>
  `/api/boards/${boardId}/events${since === null ? '' : `?since=${since}`}`

const isRevision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

function isCommitEvent(v: unknown): v is CommitEvent {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Partial<Record<keyof CommitEvent, unknown>>
  return (
    isRevision(c.revision) &&
    Array.isArray(c.ops) &&
    typeof c.now === 'string' &&
    (c.originClientId === null || typeof c.originClientId === 'string') &&
    (c.seq === null || Number.isSafeInteger(c.seq)) &&
    (c.sent === undefined || typeof c.sent === 'string')
  )
}

function parseData(e: MessageEvent): unknown {
  try {
    return JSON.parse(String(e.data))
  } catch {
    return undefined
  }
}

/**
 * The event stream over `open(since)` sources. While the browser reconnects a dropped stream it
 * sends `Last-Event-ID` (the last commit's revision) itself. A stream it gave up on is reopened
 * here with `?since=` the last revision seen. After a `reset` (whose frame has no id) the stream is
 * reopened past the reset, so a later reconnect does not resume from before it. A malformed frame
 * is ignored: the next commit then shows a gap, which the client fills.
 */
export function eventStream(
  open: (since: number | null) => EventSourceLike,
): SyncTransport['events'] {
  return (since, on) => {
    let lastId = since
    let source: EventSourceLike | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    let down = false
    let closed = false

    const up = () => {
      down = false
      failures = 0
    }
    const connect = () => {
      timer = null
      if (closed) return
      const es = open(lastId)
      source = es
      const live = () => source === es && !closed
      es.onopen = () => {
        if (live()) up()
      }
      es.onerror = () => {
        if (!live()) return
        if (!down) {
          down = true
          on({ type: 'down', status: null })
        }
        if (es.readyState !== CLOSED) return
        es.close()
        source = null
        timer = setTimeout(connect, REOPEN_MS[Math.min(failures++, REOPEN_MS.length - 1)])
      }
      es.addEventListener('hello', (e) => {
        if (!live()) return
        up()
        const d = parseData(e) as { revision?: unknown } | undefined
        if (isRevision(d?.revision)) on({ type: 'hello', revision: d.revision })
      })
      es.addEventListener('commit', (e) => {
        if (!live()) return
        up()
        const c = parseData(e)
        if (!isCommitEvent(c)) return
        lastId = c.revision
        on({ type: 'commit', event: c })
      })
      es.addEventListener('reset', (e) => {
        if (!live()) return
        up()
        const d = parseData(e) as { revision?: unknown } | undefined
        if (!isRevision(d?.revision)) return
        lastId = d.revision
        on({ type: 'reset', revision: d.revision })
        es.close()
        connect()
      })
    }

    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      source?.close()
      source = null
    }
  }
}

/** The board's transport over HTTP: the API calls, plus an `EventSource` stream. */
export function createHttpTransport(
  boardId: string,
  openSource: (url: string) => EventSourceLike = (url) => new EventSource(url),
): SyncTransport {
  return {
    boardId,
    load: () => loadBoard(boardId),
    send: (body) => postBatch(boardId, body),
    since: (rev) => opsSince(boardId, rev),
    book: (bookId) => fetchBook(boardId, bookId),
    events: eventStream((since) => openSource(eventsUrl(boardId, since))),
  }
}
