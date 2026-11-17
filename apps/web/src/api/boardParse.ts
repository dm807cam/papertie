import {
  type Asset,
  type Board,
  type BoardState,
  type Book,
  type BuilderSizes,
  type Note,
  PMap,
  stateBuilder,
  type Yarn,
} from '@papertie/core'

/**
 * A board read whole, as a client holds it: without blocks (ADR-0001: a whole-board read serves
 * none; a book's come from the book route once it is opened), so it holds no book. A board with
 * no book holds them all (there is none to miss), and keeps the blocks of books made later.
 */
export function withoutBlocks(state: BoardState): BoardState {
  if (state.books.size === 0) {
    return state.blocksHeld === 'all' && state.blocks.size === 0
      ? state
      : { ...state, blocks: PMap.from(), blocksHeld: 'all' }
  }
  return { ...state, blocks: PMap.from(), blocksHeld: new Set() }
}

/**
 * Parsing a whole board off the main thread: at 100,000 notes `parseBoard` takes
 * about a second, which on the page would freeze the board already painted. A worker parses the
 * bytes and posts the records in batches of {@link PARSE_BATCH}; the page folds each into the
 * board as it comes (`stateBuilder`), one short task per batch.
 */

/** Records per message: about a millisecond or two to receive and fold in. */
export const PARSE_BATCH = 1000

/** What the worker says, in order: the board, its records in batches, then the end. */
export type ParseMessage =
  | { type: 'board'; board: Board; sizes: BuilderSizes }
  | { type: 'records'; records: Array<Asset | Note | Yarn | Book> }
  | { type: 'end' }
  /** `parseBoard` could make no board of it: `board-unreadable`. */
  | { type: 'unreadable' }

/** The part of `Worker` used here. */
export interface WorkerLike {
  onmessage: ((e: MessageEvent<ParseMessage>) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
  onmessageerror: ((e: MessageEvent) => void) | null
  postMessage(bytes: ArrayBuffer, transfer?: Transferable[]): void
  terminate(): void
}

/** The parse worker, or null where there is none (tests, a browser without module workers). */
function spawnWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./parseWorker.ts', import.meta.url), {
      type: 'module',
      name: 'papertie-parse',
    }) as unknown as WorkerLike
  } catch {
    return null
  }
}

/**
 * The board in `bytes`, parsed on this thread (no worker). The parser is a chunk of its own
 * (`@papertie/core/parse`), loaded only then: the board's chunk never holds it (the
 * budget); the worker has its own copy.
 */
export const parseHere = async (bytes: ArrayBuffer): Promise<BoardState | null> => {
  const { parseBoard } = await import('@papertie/core/parse')
  const { state } = parseBoard(new TextDecoder().decode(bytes), { blocksHeld: 'none' })
  return state && withoutBlocks(state)
}

/**
 * How long the worker may go without a word before it is given up on (a worker that hangs never
 * holds the open): far longer than parsing 100,000 notes takes before its first batch.
 */
export const WORKER_QUIET_MS = 15_000

/**
 * The board in `bytes`, parsed by a worker and built here a batch at a time; null when it is not a
 * board. `bytes` is handed to the worker (transferred, never copied here), so the caller must not
 * use it again. Without a worker the bytes are parsed here. When the worker fails, sends a
 * message that cannot be read, or falls silent for {@link WORKER_QUIET_MS}, it is given up on and
 * `again` answers instead (the board fetched again and parsed here: one long task, and only then).
 */
export function parseOffThread(
  bytes: ArrayBuffer,
  spawn: () => WorkerLike | null = spawnWorker,
  again: () => Promise<BoardState | null> = () => Promise.reject(new Error('no worker fallback')),
): Promise<BoardState | null> {
  const worker = spawn()
  if (worker === null) return parseHere(bytes)
  return new Promise((resolve, reject) => {
    let build: ReturnType<typeof stateBuilder> | null = null
    let settled = false
    let quiet: ReturnType<typeof setTimeout> | null = null
    const finish = () => {
      settled = true
      if (quiet) clearTimeout(quiet)
      worker.terminate()
    }
    const end = (state: BoardState | null) => {
      if (settled) return
      finish()
      resolve(state)
    }
    const giveUp = () => {
      if (settled) return
      finish()
      again().then(resolve, reject)
    }
    const listen = () => {
      if (quiet) clearTimeout(quiet)
      quiet = setTimeout(giveUp, WORKER_QUIET_MS)
    }
    worker.onmessage = (e) => {
      if (settled) return
      listen()
      const m = e.data
      if (m.type === 'board') build = stateBuilder(m.board, m.sizes)
      else if (m.type === 'records') build?.add(m.records)
      else if (m.type === 'end') end(build ? withoutBlocks(build.finish()) : null)
      else end(null)
    }
    worker.onerror = (e) => {
      e.preventDefault?.()
      giveUp()
    }
    worker.onmessageerror = () => giveUp()
    listen()
    worker.postMessage(bytes, [bytes])
  })
}
