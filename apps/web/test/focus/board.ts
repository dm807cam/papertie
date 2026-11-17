import { type Board, type BoardState, stateFromRecords, type Yarn } from '@papertie/core'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { type BoardStore, createBoardStore } from '../../src/store/boardStore'
import { canvasElements } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

/** Notes A to H in a row, 400 world px apart, each with its letter as text. */
export const A = idOf('note', 1)
export const B = idOf('note', 2)
export const C = idOf('note', 3)
export const D = idOf('note', 4)
export const E = idOf('note', 5)
export const F = idOf('note', 6)
export const G = idOf('note', 7)
export const H = idOf('note', 8)

export const Y1 = idOf('yarn', 1)
export const Y2 = idOf('yarn', 2)
export const Y3 = idOf('yarn', 3)
export const Y4 = idOf('yarn', 4)
export const Y5 = idOf('yarn', 5)

export const LETTERS = [A, B, C, D, E, F, G, H]

const yarn = (id: string, noteIds: string[]): Yarn => ({
  type: 'yarn',
  id,
  noteIds,
  color: 'indigo',
  label: '',
  createdAt: T0,
  updatedAt: T0,
})

/**
 * One chain and one pair: Y1 [A, B, C], Y2 [C, D], Y3 [D, E], Y4 [E, F]; and, apart from it,
 * Y5 [G, H]. From A: depth 1 is A–C, depth 2 adds D, depth 3 adds E, the component adds F.
 */
export function chainBoard(): BoardState {
  const board: Board = {
    type: 'board',
    schemaVersion: 6,
    id: BOARD_ID,
    name: 'Focus',
    revision: 0,
    clients: {},
    createdAt: T0,
    updatedAt: T0,
  }
  const notes = LETTERS.map((id, i) =>
    note(id, { x: i * 400, y: 0, z: i + 1, text: `note ${'ABCDEFGH'[i]}` }),
  )
  return stateFromRecords(board, [
    ...notes,
    yarn(Y1, [A, B, C]),
    yarn(Y2, [C, D]),
    yarn(Y3, [D, E]),
    yarn(Y4, [E, F]),
    yarn(Y5, [G, H]),
  ])
}

/** A runtime on the chain board, with every note mounted as `NoteLayer` would mount it. */
export function chainRuntime(): { rt: CanvasRuntime; store: BoardStore } {
  const store = createBoardStore(chainBoard())
  const rt = new CanvasRuntime(canvasElements(), store)
  for (const id of LETTERS) mount(rt, id)
  return { rt, store }
}

/** A note's element as `NoteLayer` mounts it: in the world layer, registered with the runtime. */
export function mount(rt: CanvasRuntime, id: string): HTMLElement {
  const el = document.createElement('article')
  el.dataset.noteId = id
  el.tabIndex = -1
  rt.els.world.append(el)
  rt.noteEls.set(id, el)
  rt.noteMounted(id, el)
  return el
}

/** World centre of a note on the chain board (200 x 120 at x = 400 i). */
export function centreOf(id: string): { x: number; y: number } {
  const i = LETTERS.indexOf(id)
  return { x: i * 400 + 100, y: 60 }
}
