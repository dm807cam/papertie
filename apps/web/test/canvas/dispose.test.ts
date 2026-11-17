// @vitest-environment jsdom
/**
 * A disposed runtime lets go of the board: its tied descriptions stop listening to the store and
 * forget every note they kept.
 */
import { emptyBoardState, stateFromRecords } from '@papertie/core'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { createBoardStore } from '../../src/store/boardStore'
import { canvasElements, installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

let restore: () => void = () => {}
beforeEach(() => {
  restore = installCanvasStubs()
})
afterEach(() => {
  document.body.replaceChildren()
  restore()
})

it('disposing the runtime disposes its tied descriptions', () => {
  const id = idOf('note', 1)
  const store = createBoardStore(
    stateFromRecords(emptyBoardState(BOARD_ID, 'b', T0).board, [note(id, { x: 100 })]),
  )
  const rt = new CanvasRuntime(canvasElements(), store, null, null, null, false)
  rt.tied.subscribe(id, () => {})
  rt.tied.get(id)
  expect(rt.tied.kept).toBe(1)
  rt.dispose()
  expect(rt.tied.kept).toBe(0)
})
