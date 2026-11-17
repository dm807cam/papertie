import type { BoardState } from '@papertie/core'

/**
 * A board's `board.jsonl` as UTF-8 bytes, in pieces that each end at a line's end (as
 * `serializeSliced` makes them): streamed and written as they are, never joined into one string
 * or one buffer (a 100,000-note board's 43 MB in one go held a Raspberry Pi's loop for about 150 ms).
 *
 * The pieces are published: one `Jsonl` is shared by every read, export and backup of that state,
 * possibly at once. They are never written to, never transferred (no `type: 'bytes'` stream, no
 * `postMessage` transfer list: either would detach them for every other reader), and only their
 * views are read, never `.buffer` (each is a view of a buffer of its own, whose bytes past the
 * view are uninitialized).
 */
export interface Jsonl {
  parts: readonly Buffer[]
  bytes: number
}

/**
 * A board's file and what a whole-board read serves of it (`served`: the lines before the first
 * `block` line and an eof over them, ADR-0001; the file itself for a board without blocks).
 */
export interface BoardText extends Jsonl {
  served: Jsonl
}

/** The text of `jsonl`, decoded whole: for tests and small boards, never a route's answer. */
export const jsonlText = (jsonl: Jsonl): string =>
  jsonl.parts.map((p) => p.toString('utf8')).join('')

/**
 * A whole board's `board.jsonl` as a stream of its serialized pieces, as they are: never joined
 * or encoded in one go (43 MB at 100,000 notes: 27–37 ms in one iteration on a Mac).
 */
export function jsonlStream(jsonl: Jsonl): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = jsonl.parts[i++]
      if (part === undefined) return controller.close()
      controller.enqueue(part)
    },
  })
}

/** A board state and its `board.jsonl`. */
export interface Served {
  state: BoardState
  jsonl: BoardText
}

/**
 * The whole-board text a board's reads (`GET /:id`, `export`) answer with, serialized in slices
 * outside the board's lock. Serializations coalesce: at most one
 * runs and one waits per board. The waiting one serializes the newest state when it starts, so
 * every read that arrives meanwhile shares it and still gets its revision or a newer one. A user
 * alternating commits and whole reads can therefore never start serializations faster than one
 * finishes, nor hold more than two texts of the board in the making.
 */
export class ServedText {
  /** The newest state serialized so far (or given whole), kept until the next commit. */
  private done: Served | null = null
  private running: { state: BoardState; p: Promise<Served> } | null = null
  private queued: Promise<Served> | null = null

  constructor(private readonly serialize: (state: BoardState) => Promise<BoardText>) {}

  /**
   * The text of `current`, or of a newer state: shared with a serialization of `current` already
   * running, or with the one queued behind a serialization of an older state. `latest` gives the
   * board's state when the queued one starts.
   */
  get(current: BoardState, latest: () => BoardState): Promise<Served> {
    if (this.done?.state === current) return Promise.resolve(this.done)
    if (this.running?.state === current) return this.running.p
    // Between a run's end and the queued one's start, the queued one is still the one to share.
    if (this.queued) return this.queued
    if (this.running === null) return this.start(current)
    this.queued = this.running.p.then(
      () => this.next(latest),
      () => this.next(latest),
    )
    return this.queued
  }

  /** `jsonl` is `state`'s, known whole (a restore or an import just wrote it). */
  set(state: BoardState, jsonl: BoardText): void {
    this.keep({ state, jsonl })
  }

  /** The board moved on: the kept text is of no use to the next read. */
  clear(): void {
    this.done = null
  }

  private next(latest: () => BoardState): Promise<Served> {
    this.queued = null
    const state = latest()
    if (this.done?.state === state) return Promise.resolve(this.done)
    return this.start(state)
  }

  private start(state: BoardState): Promise<Served> {
    const p = this.serialize(state)
      .then((jsonl) => {
        const served = { state, jsonl }
        this.keep(served)
        return served
      })
      .finally(() => {
        if (this.running?.p === p) this.running = null
      })
    this.running = { state, p }
    return p
  }

  /** Keeps `served` unless a newer state's text is kept already. */
  private keep(served: Served): void {
    if (this.done && this.done.state.board.revision > served.state.board.revision) return
    this.done = served
  }
}
