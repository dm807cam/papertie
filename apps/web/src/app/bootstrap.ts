import { isId, type Note, newId, type OpBatch } from '@papertie/core'
import * as boardsApi from '../api/boards'

/** Where the board last opened is remembered (its id), so the next launch opens it at once. */
export const BOARD_KEY = 'papertie.board'

/**
 * The first board's one note. It is stored in the board, so it says neither Press nor Tap (the
 * live empty hint says which).
 */
export const WELCOME_TEXT = 'Use + to pin a thought'

const FIRST_BOARD_NAME = 'My board'

export type BootstrapApi = Pick<typeof boardsApi, 'listBoards' | 'createBoard' | 'postBatch'>

/** The board last opened, or null. */
export function rememberedBoard(): string | null {
  try {
    const v = localStorage.getItem(BOARD_KEY)
    return v !== null && isId(v, 'board') ? v : null
  } catch {
    return null // no storage: as if nothing were remembered
  }
}

function remember(boardId: string): void {
  try {
    localStorage.setItem(BOARD_KEY, boardId)
  } catch {
    // no storage: the board list still finds it next time
  }
}

/**
 * The board to open: the one opened last if it is still there, else the first. A first run has
 * no board, so `My board` is made, with the welcome note pinned at the origin. `now` stamps that
 * note.
 *
 * The welcome note is sent under a one-off id of its own (`seq` 1 on revision 0). A welcome note
 * that fails to send is left out: the board itself is there and opens empty.
 */
export async function bootstrapBoard(
  now: () => string,
  api: BootstrapApi = boardsApi,
): Promise<string> {
  const boards = await api.listBoards()
  const last = rememberedBoard()
  const pick = boards.find((b) => b.id === last) ?? boards[0]
  if (pick) {
    remember(pick.id)
    return pick.id
  }

  // Asked as the first board: if another boot on this data folder made it meanwhile, the server
  // hands that one back, and its welcome note is already its own.
  const created = await api.createBoard(FIRST_BOARD_NAME, true)
  if (created.created === false) {
    remember(created.id)
    return created.id
  }
  const stamp = now()
  const note: Note = {
    type: 'note',
    id: newId('note'),
    x: 0,
    y: 0,
    w: 280,
    h: 160,
    z: 1,
    paper: 'cream',
    style: 'rustic',
    text: WELCOME_TEXT,
    image: null,
    createdAt: stamp,
    updatedAt: stamp,
  }
  const batch: OpBatch = {
    clientId: newId('tab'),
    seq: 1,
    baseRevision: 0,
    ops: [{ op: 'note.create', note }],
  }
  try {
    await api.postBatch(created.id, batch)
  } catch {
    // the board is made; an empty one is still a board
  }
  remember(created.id)
  return created.id
}
