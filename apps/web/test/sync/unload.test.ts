/** What happens as the page goes away: a flush, and one last keepalive send when it fits. */
import type { ClientOp, OpBatch } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installUnload, KEEPALIVE_MAX_BYTES } from '../../src/sync/unload'
import { BOARD_ID, connect, FakeServer, type Harness, idOf, note, T0 } from '../helpers/fakeServer'

const N1 = idOf('note', 1)

const update = (id: string, set: Record<string, unknown>) =>
  ({ op: 'note.update', id, set }) as ClientOp

/** A page's window and document, as `installUnload` listens to them. */
function page() {
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as 'visible' | 'hidden',
  })
  const win = new EventTarget()
  return {
    env: { window: win, document: doc },
    hide() {
      doc.visibilityState = 'hidden'
      doc.dispatchEvent(new Event('visibilitychange'))
    },
    pagehide() {
      win.dispatchEvent(new Event('pagehide'))
    },
  }
}

const started: Harness[] = []
let fetchMock: ReturnType<typeof vi.fn>

/** A client out of the store's reach, with one pending batch whose body is exactly `bytes` long. */
async function pendingOf(bytes: number) {
  const server = new FakeServer()
  server.commit([{ op: 'note.create', note: note(N1) }])
  const h = connect(server)
  started.push(h)
  await h.client.start()
  h.transport.offline = true
  const body = (text: string): OpBatch => ({
    clientId: h.client.clientId,
    seq: 1,
    baseRevision: h.client.confirmed.board.revision,
    ops: [update(N1, { text })],
  })
  const size = (b: OpBatch) => new TextEncoder().encode(JSON.stringify(b)).length
  // '€' is three bytes in UTF-8, 'a' one: pad to the exact size, within the 20,000-char limit.
  const rest = bytes - size(body(''))
  const text = '€'.repeat(Math.floor(rest / 3)) + 'a'.repeat(rest % 3)
  expect(size(body(text))).toBe(bytes)
  h.client.submit(body(text).ops)
  await vi.advanceTimersByTimeAsync(0)
  return { h, body: body(text) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  fetchMock = vi.fn(() => new Promise<Response>(() => {}))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  for (const h of started.splice(0)) h.client.stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('installUnload', () => {
  it('keepalive is used only under 60,000 bytes', async () => {
    expect(KEEPALIVE_MAX_BYTES).toBe(60_000)
    const small = await pendingOf(KEEPALIVE_MAX_BYTES - 1)
    const p1 = page()
    installUnload(small.h.client, p1.env)
    p1.pagehide()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/boards/${BOARD_ID}/ops`)
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin' })
    expect(JSON.parse(String(init.body))).toEqual(small.body)

    const large = await pendingOf(KEEPALIVE_MAX_BYTES)
    const p2 = page()
    installUnload(large.h.client, p2.env)
    p2.pagehide()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('hidden and pagehide flush the pending edits; uninstall stops listening', async () => {
    const { h } = await pendingOf(500)
    const flush = vi.spyOn(h.client, 'flush')
    const p = page()
    const uninstall = installUnload(h.client, p.env)
    p.hide()
    expect(flush).toHaveBeenCalledTimes(1)
    p.pagehide()
    expect(flush).toHaveBeenCalledTimes(2)
    uninstall()
    p.pagehide()
    p.hide()
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('no keepalive for an edit that is with the store already', async () => {
    const server = new FakeServer()
    server.commit([{ op: 'note.create', note: note(N1) }])
    const busy = connect(server)
    started.push(busy)
    await busy.client.start()
    busy.transport.send = () => new Promise(() => {}) // the request is out, unanswered
    busy.client.submit([update(N1, { x: 2 })])
    await vi.advanceTimersByTimeAsync(0)
    const p2 = page()
    installUnload(busy.client, p2.env)
    p2.pagehide()
    expect(busy.client.keepaliveBatch()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no keepalive send when nothing is pending', async () => {
    const server = new FakeServer()
    const h = connect(server)
    started.push(h)
    await h.client.start()
    const p = page()
    installUnload(h.client, p.env)
    p.pagehide()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
