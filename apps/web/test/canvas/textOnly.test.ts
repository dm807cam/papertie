// @vitest-environment jsdom
/**
 * A note's text written elsewhere moves no paper: the commit that brings it
 * stamps the note's `rev`, and that stamp is not a change of the paper either. The yarn's static
 * layer and the index are left alone; a remote text edit of the 1000 board's hub redrew the whole
 * yarn layer every time (p95 5.0 ms against a 4 ms budget).
 */
import { commitBatch, emptyBoardState, stateFromRecords } from '@papertie/core'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { createBoardStore } from '../../src/store/boardStore'
import { canvasElements, installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const N1 = idOf('note', 1)
const N2 = idOf('note', 2)

let restore: () => void = () => {}
beforeEach(() => {
  restore = installCanvasStubs()
})
afterEach(() => {
  document.body.replaceChildren()
  restore()
})

describe('a remote text edit', () => {
  it('stamps the rev, and neither indexes the note again nor invalidates the yarn', () => {
    const board = stateFromRecords(emptyBoardState(BOARD_ID, 'b', T0).board, [
      note(N1, { x: 100 }),
      note(N2, { x: 500 }),
    ])
    const store = createBoardStore(board)
    const rt = new CanvasRuntime(canvasElements(), store, null, null, null, false)
    try {
      const inside = rt as unknown as {
        yarn: { invalidateStatic(c?: unknown): void }
        reindex(s: unknown, ids: Set<string>): void
      }
      const invalidated = vi.spyOn(inside.yarn, 'invalidateStatic')
      const reindexed = vi.spyOn(inside, 'reindex')
      for (let i = 0; i < 3; i++) {
        const next = commitBatch(
          store.getState(),
          [{ op: 'note.update', id: N1, set: { text: `Remote edit ${i}` } }],
          new Date(Date.parse(T0) + 1000 * (i + 1)).toISOString(),
          { clientId: 'tab_remote', seq: i + 1 },
        )
        store.replace(next)
      }
      const n = store.getState().notes.get(N1)
      expect(n?.text).toBe('Remote edit 2')
      // The commit stamped it: the case the paper check must not take for a change.
      expect(n?.rev).toBeGreaterThan(0)
      expect(reindexed).not.toHaveBeenCalled()
      expect(invalidated).not.toHaveBeenCalled()
    } finally {
      rt.dispose()
    }
  })

  it("a print's caption coming or going is drawn: the card overview's image area follows it", () => {
    // No pyramid here (a small board): the card overview draws from the yarn's static cache,
    // and a print's image area sits above a caption band only while it has text.
    const asset = 'asset_01M6SEGKN6KTNF6W3485JB72GR'
    const board = stateFromRecords(emptyBoardState(BOARD_ID, 'b', T0).board, [
      {
        type: 'asset',
        id: asset,
        mime: 'image/webp',
        width: 100,
        height: 100,
        bytes: 10,
        sha256: 'a'.repeat(64),
        createdAt: T0,
      },
      note(N1, { x: 100, style: 'print', text: '', image: { assetId: asset, frame: 'print' } }),
      note(N2, { x: 500 }),
    ])
    const store = createBoardStore(board)
    const rt = new CanvasRuntime(canvasElements(), store, null, null, null, false)
    try {
      const inside = rt as unknown as { yarn: { invalidateStatic(c?: unknown): void } }
      const invalidated = vi.spyOn(inside.yarn, 'invalidateStatic')
      let seq = 0
      const write = (text: string) =>
        store.replace(
          commitBatch(
            store.getState(),
            [{ op: 'note.update', id: N1, set: { text } }],
            new Date(Date.parse(T0) + 1000 * ++seq).toISOString(),
            { clientId: 'tab_remote', seq },
          ),
        )
      write('a caption')
      expect(invalidated).toHaveBeenCalledTimes(1)
      expect(invalidated.mock.calls[0]?.[0]).toMatchObject({ notes: new Set([N1]) })
      // Still a caption: nothing to draw again.
      write('a longer caption')
      expect(invalidated).toHaveBeenCalledTimes(1)
      write('')
      expect(invalidated).toHaveBeenCalledTimes(2)
    } finally {
      rt.dispose()
    }
  })
})
