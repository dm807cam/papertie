import { type BoardState, emptyBoardState } from '@papertie/core'
import {
  BENCH_SIZES,
  benchBoard,
  clusteredLifetimeBoard,
  lifetimeBoard,
  WIDE_SIZE,
  wideBoard,
} from '@papertie/tools/gen-board'
import type { Rect } from '../canvas/types'
import { DEMO_FRAME, demoBoard } from './demoBoard'
import { farBoard } from './farBoard'

/**
 * A board to load, its picker label and the world rect its first camera fits (all notes if
 * none).
 */
export interface ResolvedBoard {
  state: BoardState
  label: string
  frame?: Rect
}

/** The empty board's id: a fresh board with nothing on it. */
const EMPTY_ID = 'board_01JBEMPTY00000000000000001'

/**
 * Pick the board named by `?board=demo|100|500|1000|5000|lifetime|clusters|empty|far|far0`; anything
 * else is the demo board. `empty` has no notes at all (the empty state). `5000` is the wide board
 * (5,000 notes and yarns over ~54,000 x 26,000 world px); `lifetime` is 100,000 notes and 10,000
 * threads on a grid (not in the picker), drawn far out from the picture pyramid, and `clusters` the
 * same counts in clusters of related notes, as years of use leave a board (the bench board, not in the picker either). `far` is a small board near the coordinate
 * limit and `far0` the same board at the origin (neither is in the picker). Benchmark boards
 * keep their fixed timestamps so every run loads identical data; `now` stamps the demo and the
 * far boards.
 */
export function resolveBoard(search: string, now: string): ResolvedBoard {
  const value = new URLSearchParams(search).get('board')
  const size = BENCH_SIZES.find((s) => String(s) === value)
  if (size !== undefined) return { state: benchBoard(size), label: String(size) }
  if (value === String(WIDE_SIZE)) return { state: wideBoard(), label: value }
  if (value === 'lifetime') return { state: lifetimeBoard(), label: 'lifetime' }
  if (value === 'clusters') return { state: clusteredLifetimeBoard(), label: 'clusters' }
  if (value === 'far') return { state: farBoard(now), label: 'far' }
  if (value === 'far0') return { state: farBoard(now, { x: 0, y: 0 }), label: 'far0' }
  if (value === 'empty')
    return { state: emptyBoardState(EMPTY_ID, 'Empty board', now), label: 'empty' }
  return { state: demoBoard(now), label: 'demo', frame: DEMO_FRAME }
}
