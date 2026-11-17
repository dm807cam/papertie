import type { ServerResponse } from 'node:http'
import type { Context, Handler } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../http/env'
import { ApiError } from '../http/errors'
import type { BoardEvent, BoardStore } from '../store/boardStore'
import type { CommitEvent } from '../store/ring'

export interface EventsDeps {
  store: BoardStore
  /** How often an idle stream is sent a comment. */
  keepaliveMs: number
}

const RETRY_MS = 2000
/** A client that stops reading is dropped (it reconnects with `Last-Event-ID`) rather than buffered. */
const MAX_QUEUED_WRITES = 1024
/** How long a `closed` stream waits for its queued frames before giving up on a stalled client. */
const CLOSE_DRAIN_MS = 1000

/** A revision as `Last-Event-ID` / `?since=` / `ops?since=` carry it: a plain non-negative integer. */
export function parseRevision(raw: string | undefined): number {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) throw new ApiError(400, 'invalid')
  return Number(raw)
}

/** Where a reconnecting stream resumes from: the header wins over the query; neither means a new stream. */
function resumeFrom(c: Context<AppEnv>): number | null {
  const header = c.req.header('Last-Event-ID')
  const query = c.req.query('since')
  if (header === undefined && query === undefined) return null
  return parseRevision(header ?? query)
}

const frame = (event: string, data: unknown, id?: number) =>
  `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const commitFrame = (commit: CommitEvent) => frame('commit', commit, commit.revision)

/**
 * `GET /api/boards/:id/events` (after auth and ownership): a Server-Sent Events stream of the
 * board's commits.
 *
 * Everything that can fail with a status (bad `Last-Event-ID`, the per-user cap, the board being
 * unreadable) happens before the first stream byte, so those answer as plain JSON errors.
 *
 * No commit is lost between replay and live: the hub subscription is made first and its events are
 * held back; the ring snapshot (`store.since`) is taken after it, so every commit is either in the
 * snapshot or delivered to the subscription (or both). The snapshot is written, then the held events,
 * and a commit at or below the snapshot's revision is dropped as already sent.
 */
export function eventsHandler(deps: EventsDeps): Handler<AppEnv> {
  const { store, keepaliveMs } = deps

  return async (c) => {
    const userId = c.var.user.id
    const boardId = c.req.param('id') ?? ''
    const resume = resumeFrom(c)
    let held: BoardEvent[] | null = []
    let live: (e: BoardEvent) => void = () => {}
    let unsubscribe: (() => void) | undefined
    let initial: string[]
    let skipUpTo: number
    try {
      unsubscribe = await store.subscribe(userId, boardId, (e) => (held ? held.push(e) : live(e)))
      if (resume === null) {
        // `since(-1)` is the cheap way to ask for the current revision: it never replays.
        const { revision } = await store.since(userId, boardId, -1)
        initial = [frame('hello', { revision })]
        skipUpTo = revision
      } else {
        const snap = await store.since(userId, boardId, resume)
        initial =
          'commits' in snap
            ? snap.commits.map(commitFrame)
            : [frame('reset', { revision: snap.revision })]
        skipUpTo = snap.revision
      }
    } catch (e) {
      unsubscribe?.()
      throw e
    }
    const res = streamSSE(c, async (stream) => {
      let ended = false
      let finishing = false
      let queued = 0
      let tail = Promise.resolve()
      let resolveDone: () => void = () => {}
      const done = new Promise<void>((r) => {
        resolveDone = r
      })
      const timers: Array<ReturnType<typeof setInterval>> = []
      let drainTimer: ReturnType<typeof setTimeout> | undefined

      /** Writes go through one chain so frames keep their order whatever the client's pace. */
      const send = (text: string) => {
        if (finishing) return
        if (++queued > MAX_QUEUED_WRITES) return hangUp()
        tail = tail.then(async () => {
          queued--
          if (!ended) await stream.write(text)
        })
      }
      /** Stop now: nothing more is written and nothing is waited for. */
      const stop = () => {
        ended = true
        finishing = true
        resolveDone()
      }
      /** `stop`, and drop the connection too: a stalled client would otherwise keep it (and its buffered frames) open. */
      const hangUp = () => {
        stop()
        const out = (c.env as { outgoing?: ServerResponse } | undefined)?.outgoing
        out?.destroy()
      }
      /** End after what is already queued has been written, for at most CLOSE_DRAIN_MS. */
      const finish = () => {
        if (finishing) return
        finishing = true
        const patience = new Promise<void>((r) => {
          drainTimer = setTimeout(r, CLOSE_DRAIN_MS)
        })
        void Promise.race([tail, patience]).then(resolveDone)
      }
      // Client gone (body cancelled, or the response closed before the stream could learn of it)
      // or server closing: nothing more can be written, so do not wait for the queue.
      const signal = c.req.raw.signal
      stream.onAbort(stop)
      signal.addEventListener('abort', stop, { once: true })

      const handle = (e: BoardEvent) => {
        switch (e.type) {
          case 'commit':
            if (e.commit.revision > skipUpTo) send(commitFrame(e.commit))
            break
          case 'reset':
            send(frame('reset', { revision: e.revision }))
            skipUpTo = e.revision
            break
          case 'closed':
            finish()
            break
        }
      }

      try {
        if (signal.aborted) return stop()
        send(`retry: ${RETRY_MS}\n\n`)
        for (const text of initial) send(text)
        const heldEvents = held ?? []
        held = null
        for (const e of heldEvents) handle(e)
        live = handle

        timers.push(setInterval(() => send(': keepalive\n\n'), keepaliveMs))
        // No session to recheck: the stream lasts until either side ends it.
        await done
      } finally {
        ended = true
        finishing = true
        signal.removeEventListener('abort', stop)
        clearTimeout(drainTimer)
        for (const t of timers) clearInterval(t)
        live = () => {}
        unsubscribe?.()
      }
    })
    res.headers.set('Cache-Control', 'no-store')
    res.headers.set('X-Accel-Buffering', 'no')
    return res
  }
}
