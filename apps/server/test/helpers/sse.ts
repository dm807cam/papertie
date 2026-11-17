import type { TestUser } from './client'

export interface SseMessage {
  event: string
  id?: string
  data: unknown
}

export interface EventStream {
  /** The next message; rejects when none arrives within `timeoutMs`. */
  next(timeoutMs?: number): Promise<SseMessage>
  /** Comment lines seen so far, without the leading `:` and space (a keepalive is `keepalive`). */
  comments: string[]
  /** The last `retry:` field seen, in ms. */
  readonly retry: number | null
  /** Hang up from the client side. */
  close(): void
  /** Resolves when the stream has ended, from either side. */
  closed: Promise<void>
}

/**
 * Opens `GET /api/boards/:id/events` as `user` and parses the SSE wire format from the response
 * body (no EventSource). Throws when the server answers anything but 200.
 */
export async function openEvents(
  user: TestUser,
  boardId: string,
  opts: { lastEventId?: string } = {},
): Promise<EventStream> {
  const abort = new AbortController()
  const headers: Record<string, string> = { Accept: 'text/event-stream' }
  if (opts.lastEventId !== undefined) headers['Last-Event-ID'] = opts.lastEventId
  const res = await user.request(`/api/boards/${boardId}/events`, {
    headers,
    signal: abort.signal,
  })
  if (res.status !== 200 || !res.body) throw new Error(`events: ${res.status}`)

  const messages: SseMessage[] = []
  const waiters: Array<(m: SseMessage) => void> = []
  const comments: string[] = []
  let retry: number | null = null

  const dispatch = (block: string) => {
    let event = 'message'
    let id: string | undefined
    const data: string[] = []
    for (const line of block.split(/\r\n|\r|\n/)) {
      if (line === '') continue
      if (line.startsWith(':')) {
        comments.push(line.slice(1).replace(/^ /, ''))
        continue
      }
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'id') id = value
      else if (field === 'data') data.push(value)
      else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value)
    }
    if (data.length === 0) return
    const message: SseMessage = { event, data: JSON.parse(data.join('\n')) }
    if (id !== undefined) message.id = id
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else messages.push(message)
  }

  const closed = (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        for (;;) {
          const end = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
          if (!end) break
          dispatch(buffer.slice(0, end.index))
          buffer = buffer.slice(end.index + end[0].length)
        }
      }
    } catch {
      // Aborted or reset: the stream is over either way.
    }
  })()

  return {
    next(timeoutMs = 1000) {
      const queued = messages.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise<SseMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const at = waiters.indexOf(onMessage)
          if (at >= 0) waiters.splice(at, 1)
          reject(new Error(`no SSE message within ${timeoutMs} ms`))
        }, timeoutMs)
        const onMessage = (m: SseMessage) => {
          clearTimeout(timer)
          resolve(m)
        }
        waiters.push(onMessage)
      })
    },
    comments,
    get retry() {
      return retry
    },
    close: () => abort.abort(),
    closed,
  }
}
