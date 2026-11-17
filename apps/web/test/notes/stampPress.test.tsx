import { emptyBoardState } from '@papertie/core'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { markPinned, stampPending, takeStamp } from '../../src/notes/stampPress'
import { createBoardStore } from '../../src/store/boardStore'
import { canvasElements, installCanvasStubs } from '../helpers/domCanvas'

describe('the stamp ledger', () => {
  it('a mark is taken once', () => {
    markPinned('note_a')
    expect(stampPending('note_a')).toBe(true)
    expect(takeStamp('note_a')).toBe(true)
    expect(takeStamp('note_a')).toBe(false)
  })

  it('is marked before the note reaches the store, so a stamp that mounts inside the commit is pressed', () => {
    const restore = installCanvasStubs()
    const store = createBoardStore(
      emptyBoardState('board_01JBT7000000000000000000', 'Stamp', '2026-11-06T00:00:00.000Z'),
    )
    const rt = new CanvasRuntime(canvasElements(), store)
    try {
      const seen: boolean[] = []
      const commit = store.commit.bind(store)
      store.commit = ((ops, opts) => {
        for (const op of ops) if (op.op === 'note.create') seen.push(stampPending(op.note.id))
        return commit(ops, opts)
      }) as typeof store.commit
      const id = rt.createNoteAtCentre({
        paper: 'cream',
        style: 'rustic',
        decoration: 'stamp',
        sheet: 'rose',
      })
      expect(id).toBeDefined()
      expect(seen).toEqual([true])
      // A plain note is never marked.
      seen.length = 0
      rt.stopEditing()
      const plain = rt.createNoteAtCentre({
        paper: 'cream',
        style: 'rustic',
        decoration: 'none',
        sheet: 'rose',
      })
      expect(seen).toEqual([false])
      expect(stampPending(plain as string)).toBe(false)
    } finally {
      rt.dispose()
      document.body.replaceChildren()
      restore()
    }
  })
})
