import {
  type Asset,
  type Board,
  type BoardState,
  type Note,
  stateFromRecords,
  type Yarn,
} from '@papertie/core'
import type { RegionRect } from '../api/boards'
import { type Camera, visibleWorldRect } from '../canvas/Camera'
import type { Point, Size } from '../canvas/types'

/**
 * Opening the board where it was left: the camera the app remembers,
 * the region it shows asked of the store, a first paint, then the whole board as the sync client
 * loads it, handed over. Nothing on screen says it is loading.
 */

/** A tile's side in world px: the region route answers at most 8 × 8 of them. */
export const TILE = 4096

/** What a first paint is drawn from: one view of the board and what its notes need. */
export interface FirstPaint {
  board: Board
  /** The notes in the view, and the notes at the far ends of their threads. */
  notes: Note[]
  /** The threads naming the notes, and the photos the notes show. */
  others: Array<Asset | Yarn>
}

export type OpeningStage =
  /** The view as it was left: `state` is the part of the board to draw (`notes` are its notes). */
  | { kind: 'firstPaint'; notes: Note[]; state: BoardState }
  /** The sync client has the whole board. */
  | { kind: 'synced'; state: BoardState }
  /** The opening is over: edits go to the sync client from now on. */
  | { kind: 'ready' }

/** Where an opening reads from: the store's region route, and the sync client. */
export interface OpeningSource {
  /** The viewport, in screen px, the camera is for. */
  viewport: Size
  /** The board in `rect`, from the store. */
  region(rect: RegionRect): Promise<FirstPaint>
  /** Start the sync client: resolves with the whole board. */
  start(): Promise<BoardState>
}

/** A world rect to read, whole numbers (as the region route takes them), and the view's centre. */
export interface OpeningRect extends RegionRect {
  centre: Point
}

/**
 * The world rect a first paint reads for `camera`: what it shows, grown by one tile on every side
 * (a note's stored height is its least, and its text may run below it; a note whose corner is in
 * the tile beside the view may reach into it).
 */
export function openingRect(camera: Camera, viewport: Size): OpeningRect {
  const v = visibleWorldRect(camera, viewport)
  return {
    x0: Math.floor(v.x) - TILE,
    y0: Math.floor(v.y) - TILE,
    x1: Math.ceil(v.x + v.w) + TILE,
    y1: Math.ceil(v.y + v.h) + TILE,
    centre: { x: v.x + v.w / 2, y: v.y + v.h / 2 },
  }
}

/**
 * `r` cut down, about its centre, to what the region route answers: at most 8 tiles a side, so
 * at most {@link FIRST_PAINT_TILES} in all. A far view shows its middle first.
 */
export function regionFor(r: OpeningRect): RegionRect {
  const side = 8 * TILE
  const cut = (lo: number, hi: number, mid: number): [number, number] =>
    hi - lo <= side ? [lo, hi] : [Math.round(mid - side / 2), Math.round(mid - side / 2) + side]
  const [x0, x1] = cut(r.x0, r.x1, r.centre.x)
  const [y0, y1] = cut(r.y0, r.y1, r.centre.y)
  return { x0, y0, x1, y1 }
}

/**
 * The board a first paint draws: its notes, their photos, and the threads all of whose notes it
 * holds. A thread with a note missing (a region answer names only the far ends' frames) waits for
 * the whole board rather than being drawn through the wrong notes.
 */
export function paintState(p: FirstPaint): BoardState {
  const ids = new Set(p.notes.map((n) => n.id))
  const whole = p.others.filter((r) => r.type !== 'yarn' || r.noteIds.every((id) => ids.has(id)))
  // No book's blocks: a first paint holds none (`blocksHeld` says so, as the client's do).
  return stateFromRecords(p.board, [...whole, ...p.notes], new Set())
}

/**
 * Open board `boardId` at `camera` (null: none is remembered, so the whole board is waited for
 * and fitted). Yields `firstPaint` (unless the whole board is in before the view's region is),
 * then `synced` and `ready`. Throws as the sync client's start fails.
 */
export async function* openBoard(
  boardId: string,
  camera: Camera | null,
  src: OpeningSource,
): AsyncGenerator<OpeningStage, void, undefined> {
  const whole = src.start()
  // A failure is thrown where the board is awaited below, not as an unhandled rejection here.
  whole.catch(() => undefined)
  if (camera) {
    // The view's region and the whole board are asked for together: whichever is in first.
    const view = openingRect(camera, src.viewport)
    const paint = await Promise.race([
      src.region(regionFor(view)).catch(() => null),
      whole.then(
        () => null,
        () => null,
      ),
    ])
    if (paint) {
      performance.mark?.('papertie:first-paint-read', { detail: { boardId } })
      yield { kind: 'firstPaint', notes: paint.notes, state: paintState(paint) }
    }
  }
  yield { kind: 'synced', state: await whole }
  yield { kind: 'ready' }
}

/** Whether a board session is still opening, for what waits on it (the empty-board hint, say). */
export interface OpeningView {
  /** True from the first paint until the whole board is in. */
  readonly open: boolean
  /** Told once, when the opening ends. */
  subscribe(fn: () => void): () => void
  /** Settles as the opening ends; rejects when it failed after the first paint was shown. */
  readonly done: Promise<void>
  /**
   * The board's first paint is in the board shown. False only while a session opened on a book
   * (Papertie opened again into it) waits for it: the canvas is made once it is in, as on any
   * opening (a board made empty would take the paint as a change, caught up a slice at a time).
   */
  readonly painted: boolean
  /** Told once, when `painted` becomes true. */
  onPainted(fn: () => void): () => void
  /**
   * The board shown has every book of the board (the sync client's): before, it has none, or only
   * the one Papertie was opened again into. The shelf waits for it.
   */
  readonly booksWhole: boolean
  /** Told once, when `booksWhole` becomes true. */
  onBooksWhole(fn: () => void): () => void
}

/** A flag that turns true once, telling who waits for it. */
function once(on: boolean) {
  let is = on
  const waiting = new Set<() => void>()
  return {
    get on() {
      return is
    },
    wait(fn: () => void): () => void {
      if (is) return () => {}
      waiting.add(fn)
      return () => {
        waiting.delete(fn)
      }
    },
    set() {
      if (is) return
      is = true
      for (const fn of [...waiting]) fn()
      waiting.clear()
    },
  }
}

/**
 * An opening under way, ended by `end` (with the failure, if it failed). `painted`: its first
 * paint is in already; else `paint` says when it is (and `end` does, at the latest).
 */
export function openingView(
  painted = true,
  booksWhole = true,
): OpeningView & { end(failure?: { e: unknown }): void; paint(): void; booksIn(): void } {
  let open = true
  const paintFlag = once(painted)
  const booksFlag = once(booksWhole)
  const listeners = new Set<() => void>()
  let settle: (failure?: { e: unknown }) => void = () => {}
  const done = new Promise<void>((resolve, reject) => {
    settle = (failure) => (failure ? reject(failure.e) : resolve())
  })
  done.catch(() => undefined) // a session nobody watches any more
  return {
    get open() {
      return open
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    done,
    get painted() {
      return paintFlag.on
    },
    onPainted: (fn) => paintFlag.wait(fn),
    paint: () => paintFlag.set(),
    get booksWhole() {
      return booksFlag.on
    },
    onBooksWhole: (fn) => booksFlag.wait(fn),
    booksIn: () => booksFlag.set(),
    end(failure) {
      if (!open) return
      open = false
      paintFlag.set()
      booksFlag.set()
      settle(failure)
      for (const fn of [...listeners]) fn()
    },
  }
}

/** A session that opened whole (a local board, or a board with nothing to paint before it was in). */
export const OPENED: OpeningView = {
  open: false,
  subscribe: () => () => {},
  done: Promise.resolve(),
  painted: true,
  onPainted: () => () => {},
  booksWhole: true,
  onBooksWhole: () => () => {},
}
