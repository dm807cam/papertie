/**
 * The whole board parsed off the main thread: a worker parses the
 * NDJSON and posts its records in small batches; the page folds each into the board as it comes,
 * so no task after the first paint lasts as long as the parse.
 */
import {
  type Asset,
  emptyBoardState,
  type Note,
  parseBoard,
  serializeBoard,
  stateFromRecords,
  type Yarn,
} from '@papertie/core'
import {
  PARSE_BATCH,
  type ParseMessage,
  parseOffThread,
  WORKER_QUIET_MS,
  type WorkerLike,
  withoutBlocks,
} from '../../src/api/boardParse'
import { parseAndPost } from '../../src/api/parsePost'
import { BOOK, block, book } from '../helpers/books'

const BOARD_ID = 'board_01JBTEST000000000000000001'
const NOW = '2026-10-29T10:00:00.000Z'
const id = (p: 'note' | 'yarn', n: number) => `${p}_01JBTEST${String(n).padStart(18, '0')}`

function bigBoard(notes: number) {
  const records: Array<Asset | Note | Yarn> = []
  for (let i = 0; i < notes; i++) {
    records.push({
      type: 'note',
      id: id('note', i),
      x: i * 10,
      y: 0,
      w: 200,
      h: 120,
      z: i,
      paper: 'cream',
      style: 'rustic',
      text: `n${i}`,
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
  }
  for (let i = 0; i + 1 < notes; i += 2) {
    records.push({
      type: 'yarn',
      id: id('yarn', i),
      noteIds: [id('note', i), id('note', i + 1)],
      color: 'indigo',
      label: '',
      createdAt: NOW,
      updatedAt: NOW,
    })
  }
  const board = { ...emptyBoardState(BOARD_ID, 'Big', NOW).board, revision: 3 }
  return serializeBoard(stateFromRecords(board, records))
}

/** A worker run in this thread: each message it posts arrives as a task of its own. */
function inProcess(): { worker: WorkerLike; posted: ParseMessage[] } {
  const posted: ParseMessage[] = []
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(bytes: ArrayBuffer) {
      parseAndPost(bytes, (m) => {
        posted.push(m)
        setTimeout(() => worker.onmessage?.({ data: m } as MessageEvent<ParseMessage>), 0)
      })
    },
    terminate() {},
  }
  return { worker, posted }
}

/** The board `parseBoard` makes of `text` on this thread. */
function whole(text: string) {
  const { state } = parseBoard(text)
  if (state === null) throw new Error('not a board')
  return state
}

const bytesOf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('parsing the whole board off the main thread', () => {
  it('posts its records in batches of at most PARSE_BATCH, and the page builds the same board', async () => {
    const text = bigBoard(2500)
    const { worker, posted } = inProcess()
    const state = await parseOffThread(bytesOf(text), () => worker)
    expect(state && serializeBoard(state)).toBe(serializeBoard(whole(text)))
    const batches = posted.filter((m) => m.type === 'records')
    expect(batches.length).toBeGreaterThan(3)
    for (const m of batches) {
      if (m.type === 'records') expect(m.records.length).toBeLessThanOrEqual(PARSE_BATCH)
    }
    expect(posted[0]?.type).toBe('board')
    expect(posted.at(-1)?.type).toBe('end')
  })

  it('a body the parser cannot make a board of is null (board-unreadable), as on the main thread', async () => {
    const { worker } = inProcess()
    expect(await parseOffThread(bytesOf('not a board\n'), () => worker)).toBeNull()
  })

  it('a worker that fails, garbles a message or falls silent: the board is fetched again and parsed here', async () => {
    const text = bigBoard(10)
    const again = vi.fn(async () => whole(text))
    // None at all: nothing to fetch again, the bytes are parsed here.
    const none = await parseOffThread(bytesOf(text), () => null, again)
    expect(none && serializeBoard(none)).toBe(serializeBoard(whole(text)))
    expect(again).not.toHaveBeenCalled()

    const worker = (): WorkerLike & { terminated: boolean } => ({
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminated: false,
      postMessage() {},
      terminate() {
        this.terminated = true
      },
    })
    const broken = worker()
    broken.postMessage = () => {
      setTimeout(() => broken.onerror?.(new Event('error') as ErrorEvent), 0)
    }
    const garbled = worker()
    garbled.postMessage = () => {
      setTimeout(() => garbled.onmessageerror?.(new MessageEvent('messageerror')), 0)
    }
    const silent = worker()
    vi.useFakeTimers()
    try {
      for (const w of [broken, garbled, silent]) {
        again.mockClear()
        const p = parseOffThread(bytesOf(text), () => w, again)
        await vi.advanceTimersByTimeAsync(WORKER_QUIET_MS + 1)
        const state = await p
        expect(state && serializeBoard(state)).toBe(serializeBoard(whole(text)))
        expect(again).toHaveBeenCalledTimes(1)
        expect(w.terminated).toBe(true)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a board read whole holds no book', () => {
  it('its books come with it, their blocks never: it holds none of them', async () => {
    const records = [book(BOOK), block(1, 'private text')]
    const board = { ...emptyBoardState(BOARD_ID, 'Books', NOW).board, revision: 2 }
    const text = serializeBoard(stateFromRecords(board, records))
    const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer
    const { worker, posted } = inProcess()
    const state = await parseOffThread(bytes, () => worker)
    expect(
      posted.flatMap((m) => (m.type === 'records' ? m.records.map((r) => r.type) : [])),
    ).toEqual(['book'])
    expect(state?.books.has(BOOK)).toBe(true)
    expect(state?.blocks.size).toBe(0)
    expect(state?.blocksHeld).toEqual(new Set())
    // Parsed here (no worker): the same.
    const here = await parseOffThread(
      new TextEncoder().encode(text).buffer as ArrayBuffer,
      () => null,
    )
    expect(here?.blocksHeld).toEqual(new Set())
    expect(here?.blocks.size).toBe(0)
  })

  it('a board without books holds them all: there is none to miss', () => {
    expect(withoutBlocks(emptyBoardState(BOARD_ID, 'B', NOW)).blocksHeld).toBe('all')
  })
})
