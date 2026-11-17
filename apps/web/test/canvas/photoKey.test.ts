// @vitest-environment jsdom
import { applyBatch, emptyBoardState } from '@papertie/core'
import { canvasHistory, openLocalSession } from '../../src/app/session'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { registerPhotoPicker } from '../../src/ui/photoPicker'
import { canvasElements, installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, T0 } from '../helpers/fakeServer'

describe('the P key on the board', () => {
  it('opens the photo picker once per press: holding the key does not reopen it', () => {
    const restore = installCanvasStubs()
    const session = openLocalSession({
      kind: 'local',
      state: applyBatch(emptyBoardState(BOARD_ID, 'Test board', T0), [], { now: T0 }),
      label: 'test',
    })
    const rt = new CanvasRuntime(canvasElements(), session.store, null, canvasHistory(session))
    const open = vi.fn()
    const unregister = registerPhotoPicker(open)
    try {
      const press = (init: KeyboardEventInit) =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
        )
      press({ key: 'p', code: 'KeyP' })
      expect(open).toHaveBeenCalledTimes(1)
      // The auto-repeat of a held key.
      press({ key: 'p', code: 'KeyP', repeat: true })
      press({ key: 'p', code: 'KeyP', repeat: true })
      expect(open).toHaveBeenCalledTimes(1)
      // Released and pressed again: a new press.
      press({ key: 'p', code: 'KeyP' })
      expect(open).toHaveBeenCalledTimes(2)
    } finally {
      unregister()
      rt.dispose()
      restore()
    }
  })
})
