import type { BoardState } from '@papertie/core'
import type { Rect } from '../canvas/types'
import { resolveBoard } from '../dev/boardSource'

/** Where a canvas gets its board: the store (the user's board) or a local dev board. */
export type BoardSource =
  | { kind: 'server'; boardId: string }
  | { kind: 'local'; state: BoardState; label: string; frame?: Rect }

/** The local dev board named `board` (demo, 100..5000, empty, far, far0; else demo). */
export function localBoardFor(board: string, now: string): BoardSource & { kind: 'local' } {
  return { kind: 'local', ...resolveBoard(`?board=${encodeURIComponent(board)}`, now) }
}
