import {
  applyBatch,
  type ClientOp,
  emptyBoardState,
  LIMITS,
  OpError,
  stateFromRecords,
} from '@papertie/core'
import { announce } from '../../src/app/liveRegion'
import { openLocalSession, stepHistory } from '../../src/app/session'
import {
  deleteNotes,
  deleteSelection,
  duplicateNotes,
  duplicateSelection,
  forgetTopZ,
  primeTopZ,
  setNoteText,
  settleTopZ,
  topZHolds,
  topZOf,
} from '../../src/notes/noteCommands'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const N1 = idOf('note', 1)
const N2 = idOf('note', 2)
const N3 = idOf('note', 3)
const Y1 = idOf('yarn', 1)

vi.mock('../../src/app/liveRegion', () => ({ announce: vi.fn() }))

/** N1–N3 threaded in order by Y1; N2 carries every decoration. */
function threaded() {
  const ops: ClientOp[] = [
    { op: 'note.create', note: note(N1, { x: 0, z: 1, text: 'one' }) },
    {
      op: 'note.create',
      note: note(N2, {
        x: 300,
        y: 40,
        z: 5,
        paper: 'rose',
        style: 'smooth',
        text: 'Spring trip\n- Milan',
        motif: 'fold',
        stamp: true,
        layered: 'lilac',
      }),
    },
    { op: 'note.create', note: note(N3, { x: 600, z: 3, text: 'three' }) },
    {
      op: 'yarn.create',
      yarn: {
        type: 'yarn',
        id: Y1,
        noteIds: [N1, N2, N3],
        color: 'apricot',
        label: '',
        createdAt: T0,
        updatedAt: T0,
      },
    },
  ]
  const state = applyBatch(emptyBoardState(BOARD_ID, 'Test board', T0), ops, { now: T0 })
  return openLocalSession({ kind: 'local', state, label: 'test' })
}

describe('note commands', () => {
  it('delete removes the note from its thread, undo restores', () => {
    const session = threaded()
    const { store } = session
    const labels: Array<string | undefined> = []
    store.onCommit((_b, _ops, o) => labels.push(o.label))

    deleteNotes(store, [N2])

    expect(store.getState().notes.has(N2)).toBe(false)
    expect(store.getState().yarns.get(Y1)?.noteIds).toEqual([N1, N3])
    expect(store.commits).toBe(1)
    expect(labels).toEqual(['delete'])

    stepHistory(session, 'undo')
    expect(store.getState().notes.get(N2)).toMatchObject({
      text: 'Spring trip\n- Milan',
      motif: 'fold',
    })
    expect(store.getState().yarns.get(Y1)?.noteIds).toEqual([N1, N2, N3])
  })

  it('delete of several notes is one batch; unknown ids are left out; none commits nothing', () => {
    const session = threaded()
    const { store } = session
    deleteNotes(store, [N1, idOf('note', 9), N3])
    expect(store.commits).toBe(1)
    expect([...store.getState().notes.keys()]).toEqual([N2])
    // A thread left with one note is untied.
    expect(store.getState().yarns.has(Y1)).toBe(false)
    deleteNotes(store, [idOf('note', 9)])
    deleteNotes(store, [])
    expect(store.commits).toBe(1)
  })

  it('duplicate copies decor, not threads', () => {
    const session = threaded()
    const { store } = session
    const labels: Array<string | undefined> = []
    store.onCommit((_b, _ops, o) => labels.push(o.label))
    const top = topZOf(store.getState())

    const ids = duplicateNotes(store, [N2])

    expect(ids).toHaveLength(1)
    const [copyId] = ids
    if (copyId === undefined) throw new Error('no copy')
    expect(copyId).not.toBe(N2)
    const src = store.getState().notes.get(N2)
    const copy = store.getState().notes.get(copyId)
    expect(copy).toEqual({
      ...src,
      id: copyId,
      x: (src?.x ?? 0) + 24,
      y: (src?.y ?? 0) + 24,
      z: top + 1,
      createdAt: copy?.createdAt,
      updatedAt: copy?.updatedAt,
    })
    // Threads stay as they were: the copy hangs on none.
    expect(store.getState().yarns.size).toBe(1)
    expect(store.getState().yarns.get(Y1)?.noteIds).toEqual([N1, N2, N3])
    expect(store.commits).toBe(1)
    expect(labels).toEqual(['duplicate'])

    // One undo takes the copy away again.
    stepHistory(session, 'undo')
    expect(store.getState().notes.has(copyId)).toBe(false)
  })

  it('duplicates keep their stacking order above the top, and stay inside the coordinate limits', () => {
    const session = threaded()
    const { store } = session
    store.commit([{ op: 'note.update', id: N1, set: { x: LIMITS.maxCoord - 200 } }])
    const top = topZOf(store.getState())
    // Given out of z order: N2 (z 5) above N3 (z 3) above N1 (z 1).
    const ids = duplicateNotes(store, [N2, N1, N3], 40)
    const notes = store.getState().notes
    const z = ids.map((id) => notes.get(id)?.z)
    expect(z).toEqual([top + 3, top + 1, top + 2])
    expect(notes.get(ids[1] ?? '')?.x).toBe(LIMITS.maxCoord - 200)
    expect(notes.get(ids[2] ?? '')?.y).toBe(40)
  })

  it('text commits coalesce under text:<id> with the label edit', () => {
    const session = threaded()
    const { store } = session
    const seen: Array<{ key?: string; label?: string }> = []
    store.onCommit((_b, _ops, o) => seen.push({ key: o.coalesceKey, label: o.label }))
    setNoteText(store, N1, 'o')
    setNoteText(store, N1, 'on')
    expect(seen).toEqual([
      { key: `text:${N1}`, label: 'edit' },
      { key: `text:${N1}`, label: 'edit' },
    ])
    expect(store.getState().notes.get(N1)?.text).toBe('on')
    // A typing session is one undo step.
    stepHistory(session, 'undo')
    expect(store.getState().notes.get(N1)?.text).toBe('one')
  })

  it('duplicating the selection selects the copies, brought into focus', () => {
    const { store } = threaded()
    const selectNotes = vi.fn()
    duplicateSelection(store, [N1, N3], { selectNotes })
    expect(store.getState().notes.size).toBe(5)
    expect(selectNotes).toHaveBeenCalledTimes(1)
    const [copies, mode, o] = selectNotes.mock.calls[0] ?? []
    expect([...copies].every((id: string) => store.getState().notes.has(id))).toBe(true)
    expect([[...copies].length, mode, o]).toEqual([2, 'replace', { bringIn: true }])
  })

  it('a full board refuses a duplicate out loud, and nothing is added', () => {
    vi.mocked(announce).mockClear()
    const notes = Array.from({ length: LIMITS.maxNotes }, (_, i) =>
      note(idOf('note', i + 1), { x: i, z: i + 1 }),
    )
    const state = stateFromRecords(emptyBoardState(BOARD_ID, 'Full', T0).board, notes)
    const { store } = openLocalSession({ kind: 'local', state, label: 'full' })
    const selectNotes = vi.fn()
    duplicateSelection(store, [N1], { selectNotes })
    expect(store.getState().notes.size).toBe(LIMITS.maxNotes)
    expect(store.commits).toBe(0)
    expect(selectNotes).not.toHaveBeenCalled()
    expect(vi.mocked(announce).mock.calls.at(-1)?.[0]).toBe(
      'Couldn’t duplicate: a board holds at most 100,000 notes',
    )
  })

  it('a refused delete is said, not swallowed; a bug is not hidden', () => {
    vi.mocked(announce).mockClear()
    const { store } = threaded()
    const commit = vi.spyOn(store, 'commit')
    commit.mockImplementationOnce(() => {
      throw new OpError('invalid', 'refused')
    })
    deleteSelection(store, [N1])
    expect(store.getState().notes.has(N1)).toBe(true)
    expect(vi.mocked(announce).mock.calls.at(-1)?.[0]).toBe('Couldn’t delete the notes')
    commit.mockImplementationOnce(() => {
      throw new TypeError('a bug')
    })
    expect(() => deleteSelection(store, [N1])).toThrow('a bug')
  })
})

describe('topZOf on a lifetime board', () => {
  const big = () => {
    const notes = Array.from({ length: 20_000 }, (_, i) =>
      note(idOf('note', 100_000 + i), { x: i * 10, z: i }),
    )
    return stateFromRecords(emptyBoardState(BOARD_ID, 'b', T0).board, notes)
  }
  const brute = (s: ReturnType<typeof big>) => {
    let z = 0
    for (const n of s.notes.values()) if (n.z > z) z = n.z
    return z
  }

  it('follows edits from the board it last answered for, without walking every note (a drag start)', () => {
    let s = big()
    expect(topZOf(s)).toBe(19_999)
    // Each edit below costs what it changed: the next board's notes are never iterated whole.
    const edits: ClientOp[][] = [
      [{ op: 'note.update', id: idOf('note', 100005), set: { x: 1 } }],
      [{ op: 'note.create', note: note(idOf('note', 900_001), { z: 25_000 }) }],
      [{ op: 'note.update', id: idOf('note', 100007), set: { z: 30_000 } }],
    ]
    for (const ops of edits) {
      s = applyBatch(s, ops, { now: T0 })
      const want = brute(s)
      const walk = vi.spyOn(s.notes, 'values')
      expect(topZOf(s)).toBe(want)
      expect(walk).not.toHaveBeenCalled()
      walk.mockRestore()
    }
  })

  it('a lowered or deleted top is answered by its bound, never a walk, and walked for in idle time', () => {
    let s = big()
    expect(topZOf(s)).toBe(19_999)
    const lowered = applyBatch(
      s,
      [{ op: 'note.update', id: idOf('note', 119_999), set: { z: 3 } }],
      { now: T0 },
    )
    const walk = vi.spyOn(lowered.notes, 'values')
    // Still above every note: a note given one more is on top.
    expect(topZOf(lowered)).toBe(19_999)
    expect(walk).not.toHaveBeenCalled()
    walk.mockRestore()
    settleTopZ()
    expect(topZOf(lowered)).toBe(19_998)
    s = applyBatch(lowered, [{ op: 'note.delete', id: idOf('note', 119_998) }], { now: T0 })
    expect(topZOf(s)).toBe(19_998)
    settleTopZ()
    expect(topZOf(s)).toBe(19_997)
    expect(topZOf(emptyBoardState(BOARD_ID, 'b', T0))).toBe(0)
    expect(topZOf(big())).toBe(19_999)
  })

  /** Let the idle walk's slices run (a 0 ms timer each, where there is no idle callback). */
  const idleTurns = async (n = 20) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('a prime queued before forgetTopZ never fills it again (a sign-out, the canvas closing)', async () => {
    forgetTopZ()
    const s = big()
    primeTopZ(() => s)
    forgetTopZ()
    await idleTurns()
    expect(topZHolds()).toBe(false)
    // And a walk under way when it is forgotten stops too.
    primeTopZ(() => s)
    await new Promise((r) => setTimeout(r, 0))
    forgetTopZ()
    await idleTurns()
    expect(topZHolds()).toBe(false)
  })

  it('a board swapped in whole while another is held is met by the idle prime, not by the next ask', async () => {
    forgetTopZ()
    const held = big()
    expect(topZOf(held)).toBe(19_999)
    // A restore: a different board, not reachable from the held one by a few changes.
    const swapped = applyBatch(
      emptyBoardState(BOARD_ID, 'b', T0),
      [{ op: 'note.create', note: note(idOf('note', 900_002), { z: 7 }) }],
      { now: T0 },
    )
    primeTopZ(() => swapped)
    await idleTurns()
    const walk = vi.spyOn(swapped.notes, 'values')
    expect(topZOf(swapped)).toBe(7)
    expect(walk).not.toHaveBeenCalled()
    walk.mockRestore()
  })

  it('primed in idle time, the first ask after an open walks nothing; forgotten, it holds no board', async () => {
    forgetTopZ()
    const s = big()
    primeTopZ(() => s)
    await idleTurns()
    const next = applyBatch(s, [{ op: 'note.update', id: idOf('note', 100_005), set: { x: 9 } }], {
      now: T0,
    })
    const walk = vi.spyOn(next.notes, 'values')
    expect(topZOf(next)).toBe(19_999)
    expect(walk).not.toHaveBeenCalled()
    walk.mockRestore()
    forgetTopZ()
    const again = vi.spyOn(next.notes, 'values')
    expect(topZOf(next)).toBe(19_999)
    expect(again).toHaveBeenCalled()
  })
})
