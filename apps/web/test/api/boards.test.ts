import { type BoardState, emptyBoardState, serializeBoard } from '@papertie/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  boardMeta,
  commitImport,
  createBoard,
  dismissRecovery,
  exportHref,
  listBackups,
  listBoards,
  loadBoard,
  loadRegion,
  opsSince,
  parseRegion,
  postBatch,
  previewImport,
  restoreBackup,
} from '../../src/api/boards'
import { REQUEST_TIMEOUT_MS } from '../../src/api/http'

const BOARD_ID = 'board_01JBTEST000000000000000001'
const NOW = '2026-10-29T10:00:00.000Z'
const fetchMock = vi.fn()

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  fetchMock.mockResolvedValueOnce(
    new Response(status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers,
    }),
  )
const lastCall = () => fetchMock.mock.calls.at(-1) as [string, RequestInit]

function fixture(): { state: BoardState; text: string } {
  const state = emptyBoardState(BOARD_ID, 'Test board', NOW)
  return { state, text: serializeBoard(state) }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('loadBoard', () => {
  it('parses the NDJSON body and reads the revision, server clock and recovery headers', async () => {
    const { state, text } = fixture()
    reply(200, text, {
      'X-Papertie-Revision': '7',
      'X-Papertie-Now': '2026-10-29T10:00:05.000Z',
      'X-Papertie-Recovered': '1',
    })
    const loaded = await loadBoard(BOARD_ID)
    expect(lastCall()[0]).toBe(`/api/boards/${BOARD_ID}`)
    expect(loaded.state.board.id).toBe(state.board.id)
    expect(loaded.state.board.name).toBe('Test board')
    expect(loaded.revision).toBe(7)
    expect(loaded.serverNow).toBe('2026-10-29T10:00:05.000Z')
    expect(loaded.serverNowKnown).toBe(true)
    expect(loaded.recovered).toBe(true)
  })

  it('takes the revision from the board when the header is missing or not a count', async () => {
    const { state, text } = fixture()
    for (const bad of [undefined, '', 'abc', '-3', '1e3', '2.5', '99999999999999999999']) {
      reply(
        200,
        text,
        bad === undefined ? { 'X-Papertie-Now': NOW } : { 'X-Papertie-Revision': bad },
      )
      expect((await loadBoard(BOARD_ID)).revision).toBe(state.board.revision)
    }
  })

  it('takes the local clock when X-Papertie-Now is missing or not a date, and says so', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'))
    try {
      reply(200, fixture().text, { 'X-Papertie-Revision': '0' })
      const missing = await loadBoard(BOARD_ID)
      expect(missing.serverNow).toBe('2026-11-01T00:00:00.000Z')
      expect(missing.serverNowKnown).toBe(false)
      reply(200, fixture().text, { 'X-Papertie-Revision': '0', 'X-Papertie-Now': 'yesterday' })
      const bad = await loadBoard(BOARD_ID)
      expect(bad.serverNow).toBe('2026-11-01T00:00:00.000Z')
      expect(bad.serverNowKnown).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps a connection dropped mid-download to network, and an abort to the abort', async () => {
    const broken = (error: unknown) =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(error)
          },
        }),
        { status: 200 },
      )
    fetchMock.mockResolvedValueOnce(broken(new TypeError('network error')))
    await expect(loadBoard(BOARD_ID)).rejects.toMatchObject({ status: 0, code: 'network' })
    const controller = new AbortController()
    controller.abort()
    fetchMock.mockResolvedValueOnce(broken(new DOMException('aborted', 'AbortError')))
    await expect(loadBoard(BOARD_ID, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('has recovered false without the header', async () => {
    reply(200, fixture().text, { 'X-Papertie-Revision': '0', 'X-Papertie-Now': NOW })
    expect((await loadBoard(BOARD_ID)).recovered).toBe(false)
  })

  it('throws board-unreadable for a body parseBoard cannot read', async () => {
    reply(200, 'this is not a board\n', { 'X-Papertie-Revision': '1', 'X-Papertie-Now': NOW })
    await expect(loadBoard(BOARD_ID)).rejects.toMatchObject({ code: 'board-unreadable' })
  })

  it('passes a server error through', async () => {
    reply(409, { error: 'board-unreadable', reason: 'schema' })
    await expect(loadBoard(BOARD_ID)).rejects.toMatchObject({
      status: 409,
      code: 'board-unreadable',
    })
  })
})

describe('boards', () => {
  it('lists and creates boards', async () => {
    reply(200, [])
    await expect(listBoards()).resolves.toEqual([])
    expect(lastCall()[0]).toBe('/api/boards')
    reply(201, { id: BOARD_ID, name: 'First' })
    await createBoard('First')
    expect(lastCall()[0]).toBe('/api/boards')
    expect(lastCall()[1].method).toBe('POST')
    expect(lastCall()[1].body).toBe('{"name":"First"}')
  })

  it('reads meta and dismisses recovery', async () => {
    reply(200, { id: BOARD_ID, name: 'B', revision: 3, recovery: null })
    await expect(boardMeta(BOARD_ID)).resolves.toMatchObject({ revision: 3 })
    expect(lastCall()[0]).toBe(`/api/boards/${BOARD_ID}/meta`)
    reply(204, undefined)
    await dismissRecovery(BOARD_ID)
    expect(lastCall()[0]).toBe(`/api/boards/${BOARD_ID}/recovery`)
    expect(lastCall()[1].method).toBe('DELETE')
  })

  it('lists backups (unwrapped) and restores one with an empty body', async () => {
    const row = {
      id: 'b.jsonl',
      revision: 4,
      takenAt: NOW,
      notes: 1,
      yarns: 0,
      bytes: 9,
      damaged: false,
    }
    reply(200, { backups: [row] })
    await expect(listBackups(BOARD_ID)).resolves.toEqual([row])
    expect(lastCall()[0]).toBe(`/api/boards/${BOARD_ID}/backups`)
    reply(200, { revision: 9, safetyBackup: 's.jsonl' })
    await expect(restoreBackup(BOARD_ID, 'b.jsonl')).resolves.toEqual({
      revision: 9,
      safetyBackup: 's.jsonl',
    })
    expect(lastCall()[0]).toBe(`/api/boards/${BOARD_ID}/backups/b.jsonl/restore`)
    expect(lastCall()[1].method).toBe('POST')
    expect(lastCall()[1].body).toBe('{}')
  })

  it('builds the export href for both formats', () => {
    expect(exportHref(BOARD_ID, 'jsonl')).toBe(`/api/boards/${BOARD_ID}/export?format=jsonl`)
    expect(exportHref(BOARD_ID, 'papertie')).toBe(`/api/boards/${BOARD_ID}/export?format=papertie`)
  })
})

describe('sync requests', () => {
  it('posts a batch and answers the ack', async () => {
    const ack = { clientId: 'tab_1', seq: 1, revision: 5, now: NOW, duplicate: false }
    reply(200, ack)
    const batch = { clientId: 'tab_1', seq: 1, baseRevision: 4, ops: [] }
    await expect(postBatch(BOARD_ID, batch)).resolves.toEqual(ack)
    expect(lastCall()[0]).toBe(`/api/boards/${BOARD_ID}/ops`)
    expect(lastCall()[1].method).toBe('POST')
    expect(JSON.parse(lastCall()[1].body as string)).toEqual(batch)
  })

  it('carries a 409 client-busy as an ApiError', async () => {
    reply(409, { error: 'client-busy' })
    await expect(
      postBatch(BOARD_ID, { clientId: 'tab_1', seq: 2, baseRevision: 4, ops: [] }),
    ).rejects.toMatchObject({ status: 409, code: 'client-busy' })
  })

  it('asks for ops since a revision, with either answer', async () => {
    reply(200, { revision: 6, commits: [] })
    await expect(opsSince(BOARD_ID, 4)).resolves.toEqual({ revision: 6, commits: [] })
    expect(lastCall()[0]).toBe(`/api/boards/${BOARD_ID}/ops?since=4`)
    reply(200, { revision: 600, full: true })
    await expect(opsSince(BOARD_ID, 4)).resolves.toEqual({ revision: 600, full: true })
  })
})

describe('loadRegion', () => {
  const note = {
    type: 'note',
    id: 'note_01JBTEST000000000000000001',
    x: 10,
    y: 20,
    w: 200,
    h: 120,
    z: 1,
    paper: 'cream',
    style: 'rustic',
    text: 'Aube',
    image: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
  const yarn = {
    type: 'yarn',
    id: 'yarn_01JBTEST000000000000000001',
    noteIds: [note.id, 'note_01JBTEST000000000000000002'],
    color: 'indigo',
    label: '',
    createdAt: NOW,
    updatedAt: NOW,
  }
  const frame = {
    type: 'frame',
    id: 'note_01JBTEST000000000000000002',
    x: 9000,
    y: 0,
    w: 200,
    h: 120,
    z: 2,
  }
  const lines = (...rs: unknown[]) => `${rs.map((r) => JSON.stringify(r)).join('\n')}\n`

  it('asks for the rect and reads the board, notes and threads', async () => {
    const { state } = fixture()
    const board = { ...state.board, revision: 4 }
    reply(200, lines(board, note, yarn, { type: 'eof', revision: 4 }))
    const r = await loadRegion(BOARD_ID, { x0: -4096, y0: -4096, x1: 5376, y1: 4896 })
    expect(lastCall()[0]).toBe(`/api/boards/${BOARD_ID}/region?x0=-4096&y0=-4096&x1=5376&y1=4896`)
    expect(r.board.revision).toBe(4)
    expect(r.notes.map((n) => n.id)).toEqual([note.id])
    expect(r.others.map((x) => x.id)).toEqual([yarn.id])
  })

  it('throws board-unreadable for an answer cut short, out of order or with a bad line', async () => {
    const { state } = fixture()
    const board = state.board
    for (const body of [
      lines(board, note), // no eof
      lines(note, board, { type: 'eof', revision: 0 }), // board not first
      lines(board, { ...note, w: 'wide' }, { type: 'eof', revision: 0 }),
      lines(board, frame, { type: 'eof', revision: 0 }), // a line of no known type
      lines(board, { type: 'eof', revision: 3 }), // not the board's revision
    ]) {
      reply(200, body)
      await expect(loadRegion(BOARD_ID, { x0: 0, y0: 0, x1: 1, y1: 1 })).rejects.toMatchObject({
        code: 'board-unreadable',
      })
    }
    expect(parseRegion(lines(board, { type: 'eof', revision: 0 }))?.notes).toEqual([])
  })
})

describe('requests that answer only after a long upload or replace', () => {
  afterEach(() => vi.useRealTimers())

  /** The call, with the server taking three timeouts to answer; whether it still succeeds. */
  async function outlastsTimeout(call: () => Promise<unknown>, answer: unknown) {
    vi.useFakeTimers()
    let respond: () => void = () => {}
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          respond = () => resolve(new Response(JSON.stringify(answer), { status: 200 }))
        }),
    )
    const pending = call().then(
      () => 'answered',
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 3)
    respond()
    return pending
  }

  it('previewImport waits without a header timeout', async () => {
    const answer = { preview: {}, importId: 'i' }
    expect(await outlastsTimeout(() => previewImport(BOARD_ID, new Blob(['x'])), answer)).toBe(
      'answered',
    )
  })

  it('commitImport waits without a header timeout', async () => {
    const answer = { revision: 2, safetyBackup: 's' }
    expect(await outlastsTimeout(() => commitImport(BOARD_ID, 'i'), answer)).toBe('answered')
  })

  it('restoreBackup waits without a header timeout', async () => {
    const answer = { revision: 2, safetyBackup: 's' }
    expect(await outlastsTimeout(() => restoreBackup(BOARD_ID, 'b.jsonl'), answer)).toBe('answered')
  })
})
