import {
  applyBatch,
  type BoardState,
  type ClientOp,
  emptyBoardState,
  OpError,
} from '@papertie/core'
import { localBoardFor } from '../src/app/boardSource'
import { openLocalSession } from '../src/app/session'
import { DEMO_IDS, demoBoard } from '../src/dev/demoBoard'
import { type CommitOptions, createBoardStore } from '../src/store/boardStore'

const T0 = '2026-10-27T00:00:00.000Z'
const T1 = '2026-10-27T09:30:00.000Z'

const move = (id: string, x: number): ClientOp => ({ op: 'note.update', id, set: { x } })

describe('createBoardStore', () => {
  it('commit applies one batch stamped by the clock and notifies once', () => {
    const store = createBoardStore(demoBoard(T0), undefined, () => T1)
    const calls: Array<[BoardState, BoardState]> = []
    store.subscribe((s, prev) => calls.push([s, prev]))
    const before = store.getState()

    const next = store.commit([move(DEMO_IDS.hub, 1234), move(DEMO_IDS.knot, 4321)])

    expect(next).toBe(store.getState())
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe(next)
    expect(calls[0]?.[1]).toBe(before)
    expect(store.commits).toBe(1)
    expect(next.notes.get(DEMO_IDS.hub)?.x).toBe(1234)
    expect(next.notes.get(DEMO_IDS.hub)?.updatedAt).toBe(T1)
    expect(next.notes.get(DEMO_IDS.knot)?.x).toBe(4321)
    expect(next.board.updatedAt).toBe(T1)
  })

  it('a failing batch throws OpError and leaves state and commits unchanged', () => {
    const store = createBoardStore(demoBoard(T0), undefined, () => T1)
    const calls: unknown[] = []
    store.subscribe((s) => calls.push(s))
    const before = store.getState()

    const bad = [move(DEMO_IDS.hub, 50), move('note_0000000000000000000000000Z', 5)]
    expect(() => store.commit(bad)).toThrow(OpError)
    expect(store.getState()).toBe(before)
    expect(store.getState().notes.get(DEMO_IDS.hub)?.x).toBe(before.notes.get(DEMO_IDS.hub)?.x)
    expect(store.commits).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('a no-op batch neither notifies nor counts', () => {
    const store = createBoardStore(demoBoard(T0), undefined, () => T1)
    let calls = 0
    store.subscribe(() => calls++)
    const before = store.getState()
    const sameX = before.notes.get(DEMO_IDS.hub)?.x ?? 0

    expect(store.commit([])).toBe(before)
    expect(store.commit([move(DEMO_IDS.hub, sameX)])).toBe(before)
    expect(store.commit([{ op: 'note.delete', id: 'note_0000000000000000000000000Z' }])).toBe(
      before,
    )
    expect(calls).toBe(0)
    expect(store.commits).toBe(0)
  })

  it('an invalid clock is an OpError, not a half-applied commit', () => {
    const store = createBoardStore(demoBoard(T0), undefined, () => 'yesterday')
    expect(() => store.commit([move(DEMO_IDS.hub, 1)])).toThrow(OpError)
    expect(store.commits).toBe(0)
  })

  it('replace swaps the state and notifies without counting a commit', () => {
    const store = createBoardStore(demoBoard(T0), undefined, () => T1)
    const seen: BoardState[] = []
    store.subscribe((s) => seen.push(s))
    const other = emptyBoardState('board_01JBDEM0000000000000000099', 'Other', T0)

    store.replace(other)
    expect(store.getState()).toBe(other)
    expect(seen).toEqual([other])
    expect(store.commits).toBe(0)
  })

  it('unsubscribe stops notifications', () => {
    const store = createBoardStore(demoBoard(T0), undefined, () => T1)
    let calls = 0
    const off = store.subscribe(() => calls++)
    store.commit([move(DEMO_IDS.hub, 7)])
    off()
    store.commit([move(DEMO_IDS.hub, 8)])
    expect(calls).toBe(1)
    expect(store.commits).toBe(2)
  })
})

describe('the applier', () => {
  it('local session commits through applyBatch as before', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(T1))
    try {
      const session = openLocalSession(localBoardFor('demo', T0))
      expect(session.sync).toBeNull()
      expect(session.boardId).toBeNull()
      const before = session.store.getState()
      const ops = [move(DEMO_IDS.hub, 1234)]

      const next = session.store.commit(ops, { coalesceKey: 'k', label: 'Move' })
      expect(next).toEqual(applyBatch(before, ops, { now: T1 }))
      expect(session.store.getState()).toBe(next)
      expect(session.store.commits).toBe(1)
      expect(() => session.store.commit([move('note_0000000000000000000000000Z', 1)])).toThrow(
        OpError,
      )
      session.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('commit hands the ops and options to the applier and takes the board it answers', () => {
    const start = demoBoard(T0)
    const calls: Array<[readonly ClientOp[], CommitOptions]> = []
    let answer = start
    const store = createBoardStore(start, (ops, o) => {
      calls.push([ops, o])
      return answer
    })
    const seen: BoardState[] = []
    store.subscribe((s) => seen.push(s))

    // The applier answered the board unchanged: nothing to notify or count.
    expect(store.commit([move(DEMO_IDS.hub, 1)])).toBe(start)
    expect(calls).toEqual([[[move(DEMO_IDS.hub, 1)], {}]])
    expect(seen).toEqual([])

    answer = applyBatch(start, [move(DEMO_IDS.hub, 2)], { now: T1 })
    const o: CommitOptions = { coalesceKey: `text:${DEMO_IDS.hub}`, label: 'Edit text' }
    expect(store.commit([move(DEMO_IDS.hub, 2)], o)).toBe(answer)
    expect(calls[1]?.[1]).toEqual(o)
    expect(store.getState()).toBe(answer)
    expect(seen).toEqual([answer])
    expect(store.commits).toBe(1)
  })
})
