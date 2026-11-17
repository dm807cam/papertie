import { type Board, type Note, OpError, PIN_KEY_PATTERN, stateFromRecords } from '@papertie/core'
import { announce } from '../../src/app/liveRegion'
import { anchorKey } from '../../src/canvas/attach'
import type { Point } from '../../src/canvas/types'
import { UndoStack } from '../../src/history/UndoStack'
import { createConnectTool, type LiveThread } from '../../src/interactions/connectTool'
import type { ToolPointer } from '../../src/interactions/selectTool'
import { createBoardStore } from '../../src/store/boardStore'
import {
  announceFailure,
  createYarnFlows,
  noteLead,
  type PinChoice,
  tie,
  untie,
  type YarnFx,
} from '../../src/yarn/yarnFlows'

vi.mock('../../src/app/liveRegion', () => ({ announce: vi.fn() }))

const T0 = '2026-10-27T10:00:00.000Z'
const nid = (n: number) => `note_${String(n).padStart(26, '0')}`
const [A, B, C, D] = [nid(1), nid(2), nid(3), nid(4)]

const BOARD: Board = {
  type: 'board',
  schemaVersion: 6,
  id: `board_${'0'.repeat(25)}1`,
  name: 'Test',
  revision: 0,
  clients: {},
  createdAt: T0,
  updatedAt: T0,
}

/** Four notes in a row, 240 wide with 60 between: A at x 0, B at 300, C at 600, D at 900. */
const note = (n: number, text: string): Note => ({
  type: 'note',
  id: nid(n),
  x: (n - 1) * 300,
  y: 0,
  w: 240,
  h: 160,
  z: n,
  paper: 'cream',
  style: 'rustic',
  text,
  image: null,
  createdAt: T0,
  updatedAt: T0,
})

function setup() {
  const state = stateFromRecords(BOARD, [
    note(1, 'Alpha'),
    note(2, 'Beta\nsecond line'),
    note(3, 'Gamma'),
    note(4, ''),
  ])
  const store = createBoardStore(state, undefined, () => T0)
  const fx = {
    select: vi.fn(),
    drawIn: vi.fn(),
    pulse: vi.fn(),
    loosen: vi.fn(),
  } satisfies YarnFx
  const flows = createYarnFlows(store, fx, () => 'apricot')
  const yarns = () => [...store.getState().yarns.values()]
  return { store, fx, flows, yarns }
}

const said = () => vi.mocked(announce).mock.calls.at(-1)?.[0]

beforeEach(() => vi.mocked(announce).mockClear())

describe('tie', () => {
  it('creates a two-note apricot yarn, draws it in, and announces it', () => {
    const { store, fx, flows } = setup()
    const res = flows.tie(A, B)
    expect(res.created).toBe(true)
    expect(store.commits).toBe(1)
    expect(store.getState().yarns.get(res.yarnId)).toMatchObject({
      noteIds: [A, B],
      color: 'apricot',
      label: '',
    })
    expect(fx.drawIn).toHaveBeenCalledWith(res.yarnId)
    expect(fx.pulse).not.toHaveBeenCalled()
    expect(said()).toBe('Tied “Alpha” to “Beta” with crimson yarn')
  })

  it('tying two notes already on the same-colour thread pulses instead of creating', () => {
    const { store, fx, flows, yarns } = setup()
    const first = flows.tie(A, B)
    flows.extend(first.yarnId, 'last', C)
    const commits = store.commits
    // Neighbours, and the two ends of a thread that no single segment joins.
    for (const [from, to] of [
      [A, B],
      [B, A],
      [A, C],
      [C, A],
    ] as const) {
      const again = flows.tie(from, to)
      expect(again).toEqual({ yarnId: first.yarnId, created: false })
    }
    expect(store.commits).toBe(commits)
    expect(yarns()).toHaveLength(1)
    expect(fx.select).toHaveBeenCalledTimes(4)
    expect(fx.select).toHaveBeenCalledWith(first.yarnId)
    expect(fx.pulse).toHaveBeenCalledTimes(4)
    expect(fx.drawIn).toHaveBeenCalledTimes(1)
  })

  it('different colour creates a second thread', () => {
    const { flows, fx, yarns } = setup()
    const apricot = flows.tie(A, B)
    const indigo = flows.tie(A, B, 'indigo')
    expect(indigo.created).toBe(true)
    expect(indigo.yarnId).not.toBe(apricot.yarnId)
    expect(yarns().map((y) => y.color)).toEqual(['apricot', 'indigo'])
    expect(fx.pulse).not.toHaveBeenCalled()
    expect(said()).toBe('Tied “Alpha” to “Beta” with indigo yarn')
  })

  it('looks only at the threads touching the first note', () => {
    const { store, flows } = setup()
    // A thread of the same colour elsewhere on the board does not count.
    flows.tie(C, D)
    expect(flows.tie(A, B).created).toBe(true)
    expect(store.getState().yarns.size).toBe(2)
    expect(flows.tie(A, D).created).toBe(true)
  })

  it('without effects it is a plain commit', () => {
    const { store } = setup()
    expect(tie(store, A, B, 'apricot').created).toBe(true)
    expect(tie(store, A, B, 'apricot').created).toBe(false)
  })
})

describe('winding and extending', () => {
  it('extend winds a note on after the last note, or puts it first', () => {
    const { store, flows } = setup()
    const { yarnId } = flows.tie(B, C)
    expect(flows.extend(yarnId, 'last', D)).toBe(true)
    expect(store.getState().yarns.get(yarnId)?.noteIds).toEqual([B, C, D])
    expect(flows.extend(yarnId, 'first', A)).toBe(true)
    expect(store.getState().yarns.get(yarnId)?.noteIds).toEqual([A, B, C, D])
    // Already on the thread: nothing changes.
    const commits = store.commits
    expect(flows.extend(yarnId, 'last', A)).toBe(false)
    expect(flows.extend(yarnId, 'first', D)).toBe(false)
    expect(store.commits).toBe(commits)
  })

  it('commits under the tie, wind and untie labels: the only changes a thread has', () => {
    const { store, flows } = setup()
    const labels: Array<string | undefined> = []
    store.onCommit((_b, _o, o) => labels.push(o.label))
    const { yarnId } = flows.tie(A, B)
    flows.extend(yarnId, 'last', C)
    flows.untie(yarnId)
    expect(labels).toEqual(['tie', 'wind', 'untie'])
    expect(Object.keys(flows).sort()).toEqual(['extend', 'tie', 'untie'])
  })
})

describe('untying', () => {
  it('untie loosens, then deletes; an unknown thread does nothing', () => {
    const { store, fx, flows } = setup()
    const { yarnId } = flows.tie(A, B)
    const order: string[] = []
    fx.loosen.mockImplementation(() => order.push(`loosen ${store.getState().yarns.size}`))
    flows.untie(yarnId)
    expect(order).toEqual(['loosen 1'])
    expect(store.getState().yarns.size).toBe(0)
    const commits = store.commits
    untie(store, yarnId, fx)
    untie(store, 'yarn_nope', fx)
    expect(store.commits).toBe(commits)
  })
})

describe('what is said of each change (the live region)', () => {
  it('names the already-tied case in lower case too', () => {
    const { flows } = setup()
    flows.tie(A, B)
    flows.tie(B, A)
    expect(said()).toBe('“Beta” and “Alpha” are already tied with crimson yarn')
  })

  it('wind and untie each say what they did', () => {
    const { flows } = setup()
    const { yarnId } = flows.tie(A, B)
    flows.extend(yarnId, 'last', C)
    expect(said()).toBe('Added “Gamma” to the thread')
    flows.extend(yarnId, 'first', D)
    expect(said()).toBe('Added “Empty note” to the thread')
    flows.untie(yarnId)
    expect(said()).toBe('Untied the thread')
  })

  it('says nothing when nothing changed', () => {
    const { flows } = setup()
    const { yarnId } = flows.tie(A, B)
    vi.mocked(announce).mockClear()
    expect(flows.extend(yarnId, 'last', A)).toBe(false)
    flows.untie('yarn_nope')
    expect(announce).not.toHaveBeenCalled()
  })

  it('announceFailure words a limit and a vanished note, and rethrows what is not an OpError', () => {
    announceFailure(new OpError('limit', 'x'))
    expect(said()).toBe('This thread already has 200 notes')
    announceFailure(new OpError('not-found', 'x'))
    expect(said()).toBe('That note is no longer on the board')
    announceFailure(new OpError('invalid', 'x'))
    expect(said()).toBe('Couldn’t change the thread')
    expect(() => announceFailure(new TypeError('bug'))).toThrow('bug')
  })
})

describe('noteLead', () => {
  it('is the first non-blank line, cut, or what the note is without text', () => {
    const { store } = setup()
    const notes = store.getState().notes
    expect(noteLead(notes.get(B))).toBe('Beta')
    expect(noteLead(notes.get(D))).toBe('Empty note')
    expect(noteLead({ ...(notes.get(A) as Note), text: '\n\n  spaced   out  ' })).toBe('spaced out')
    expect(noteLead({ ...(notes.get(A) as Note), text: 'y'.repeat(60) }, 10)).toBe(
      `${'y'.repeat(10)}…`,
    )
    expect(noteLead(undefined)).toBe('Note')
  })
})

describe('the connect gesture', () => {
  function gesture() {
    const { store, flows, yarns, fx } = setup()
    const lives: Array<LiveThread | null> = []
    const sources: string[] = []
    const centre = (id: string) => {
      const n = store.getState().notes.get(id) as Note
      return { x: n.x + n.w / 2, y: n.y + n.h / 2 }
    }
    const noteAt = (w: { x: number; y: number }) => {
      for (const n of store.getState().notes.values()) {
        if (w.x >= n.x && w.x <= n.x + n.w && w.y >= n.y && w.y <= n.y + n.h) return n.id
      }
      return undefined
    }
    const at = (id: string | { x: number; y: number }, shiftKey = false): ToolPointer => {
      const world = typeof id === 'string' ? centre(id) : id
      return { screen: world, world, button: 0, shiftKey, target: {} }
    }
    /** Existing pins the pointer can land on, by note: within 10 of `at`. */
    const pins = new Map<string, { pin: PinChoice; at: Point }>()
    const make = (
      from: string,
      extend?: { yarnId: string; end: 'first' | 'last' },
      start?: { pin: PinChoice; at: Point },
    ) =>
      createConnectTool({
        fromNoteId: from,
        start,
        pinAt: (e) => {
          for (const [noteId, p] of pins) {
            if (Math.hypot(p.at.x - e.world.x, p.at.y - e.world.y) <= 10) return { noteId, ...p }
          }
          return undefined
        },
        pinOf: (id) => {
          const n = store.getState().notes.get(id)
          return n && { x: n.x + n.w / 2, y: n.y - 10 }
        },
        noteAt,
        flows,
        color: () => 'apricot',
        colorOf: (id) => store.getState().yarns.get(id)?.color,
        extend,
        threadEnd: (id, end) => {
          const ids = store.getState().yarns.get(id)?.noteIds
          return end === 'first' ? ids?.[0] : ids?.at(-1)
        },
        leadOf: (id) => noteLead(store.getState().notes.get(id)),
        setLive: (l) => lives.push(l),
        onSource: (id) => sources.push(id),
      })
    return { store, flows, yarns, fx, lives, sources, at, make, pins }
  }

  it('shift-drop winds A→B→C into one thread', () => {
    const { store, make, at, yarns, lives, sources } = gesture()
    const tool = make(A)
    tool.pointerDown(at(A))
    tool.pointerMove(at(B))
    // Shift on release: the tie is made and the thread goes on from B, with no button down.
    tool.pointerUp(at(B, true))
    expect(yarns().map((y) => y.noteIds)).toEqual([[A, B]])
    expect(tool.winding()).toBe(true)
    expect(sources).toEqual([B])
    expect(lives.at(-1)).not.toBeNull()
    expect(tool.holds(B)).toBe(true)
    expect(tool.holds(A)).toBe(false)
    // It follows the pointer from B's pin, in the thread's colour.
    tool.pointerMove(at({ x: 700, y: 400 }))
    expect(lives.at(-1)).toMatchObject({ from: { x: 420, y: -10 }, color: 'apricot' })
    // A click on C (Shift again) winds it on and goes on from C; the release of that click is
    // not a second drop.
    tool.pointerDown(at(C, true))
    tool.pointerUp(at(C, true))
    expect(yarns().map((y) => y.noteIds)).toEqual([[A, B, C]])
    expect(tool.winding()).toBe(true)
    const commits = store.commits
    // A click on D without Shift winds it on and ends.
    tool.pointerDown(at(D))
    tool.pointerUp(at(D))
    expect(yarns().map((y) => y.noteIds)).toEqual([[A, B, C, D]])
    expect(tool.winding()).toBe(false)
    expect(store.commits).toBe(commits + 1)
    expect(yarns()).toHaveLength(1)
    expect(lives.at(-1)).toBeNull()
  })

  it('without shift a drop ties once and ends', () => {
    const { make, at, yarns } = gesture()
    const tool = make(A)
    tool.pointerDown(at(A))
    tool.pointerUp(at(B))
    expect(yarns().map((y) => y.noteIds)).toEqual([[A, B]])
    expect(tool.winding()).toBe(false)
    expect(tool.holds(A)).toBe(false)
  })

  it('a click on cork or Esc stops winding with no more ops; what is wound stays', () => {
    const cork = gesture()
    const t1 = cork.make(A)
    t1.pointerDown(cork.at(A))
    t1.pointerUp(cork.at(B, true))
    const commits = cork.store.commits
    t1.pointerDown(cork.at({ x: 500, y: 900 }))
    t1.pointerUp(cork.at({ x: 500, y: 900 }))
    expect(t1.winding()).toBe(false)
    expect(cork.store.commits).toBe(commits)
    expect(cork.yarns().map((y) => y.noteIds)).toEqual([[A, B]])

    const esc = gesture()
    const t2 = esc.make(A)
    t2.pointerDown(esc.at(A))
    t2.pointerUp(esc.at(B, true))
    expect(t2.key({ key: 'Escape' })).toBe(true)
    expect(t2.winding()).toBe(false)
    expect(esc.lives.at(-1)).toBeNull()
  })

  it('a shift-drop onto a thread that already exists is shown, not wound', () => {
    const { flows, make, at, yarns } = gesture()
    flows.tie(A, B)
    const tool = make(A)
    tool.pointerDown(at(A))
    tool.pointerUp(at(B, true))
    expect(tool.winding()).toBe(false)
    expect(yarns()).toHaveLength(1)
  })

  it('extends a thread from its end pin, first or last, and Shift winds on from there', () => {
    const { flows, make, at, yarns, lives, sources } = gesture()
    const { yarnId } = flows.tie(B, C)
    const head = make(B, { yarnId, end: 'first' })
    head.pointerDown(at(B))
    head.pointerUp(at(A))
    expect(yarns()[0]?.noteIds).toEqual([A, B, C])
    expect(head.winding()).toBe(false)

    const tail = make(C, { yarnId, end: 'last' })
    tail.pointerDown(at(C))
    tail.pointerUp(at(D, true))
    expect(yarns()[0]?.noteIds).toEqual([A, B, C, D])
    expect(yarns()).toHaveLength(1)
    // On from D, in the thread's own colour.
    expect(tail.winding()).toBe(true)
    expect(sources).toEqual([D])
    expect(lives.at(-1)).toMatchObject({ color: 'apricot' })
    tail.cancel()
    expect(tail.winding()).toBe(false)
  })

  it('a refused drop (thread full, note gone) ends the gesture and says why; nothing throws', () => {
    const g = gesture()
    const { yarnId } = g.flows.tie(A, B)
    const tool = g.make(B, { yarnId, end: 'last' })
    const full = vi.spyOn(g.store, 'commit').mockImplementationOnce(() => {
      throw new OpError('limit', 'full')
    })
    tool.pointerDown(g.at(B))
    expect(() => tool.pointerUp(g.at(C))).not.toThrow()
    full.mockRestore()
    expect(said()).toBe('This thread already has 200 notes')
    expect(tool.winding()).toBe(false)
    expect(tool.holds(B)).toBe(false)
    expect(g.lives.at(-1)).toBeNull()
    expect(g.yarns().map((y) => y.noteIds)).toEqual([[A, B]])

    // The same in the hands-free click.
    const g2 = gesture()
    const t2 = g2.make(A)
    t2.pointerDown(g2.at(A))
    t2.pointerUp(g2.at(B, true))
    expect(t2.winding()).toBe(true)
    vi.spyOn(g2.store, 'commit').mockImplementationOnce(() => {
      throw new OpError('not-found', 'gone')
    })
    expect(() => t2.pointerDown(g2.at(C, true))).not.toThrow()
    expect(said()).toBe('That note is no longer on the board')
    expect(t2.winding()).toBe(false)
    expect(g2.lives.at(-1)).toBeNull()
  })

  it('an error that is not an OpError still ends the gesture before it surfaces', () => {
    const g = gesture()
    const tool = g.make(A)
    tool.pointerDown(g.at(A))
    vi.spyOn(g.store, 'commit').mockImplementationOnce(() => {
      throw new TypeError('bug')
    })
    expect(() => tool.pointerUp(g.at(B))).toThrow('bug')
    expect(g.lives.at(-1)).toBeNull()
    expect(tool.holds(A)).toBe(false)
  })

  it("winding goes on from the thread's real end: a note already on it changes nothing", () => {
    const { make, at, yarns, sources, lives } = gesture()
    const tool = make(A)
    tool.pointerDown(at(A))
    tool.pointerUp(at(B, true))
    tool.pointerDown(at(C, true))
    tool.pointerUp(at(C, true))
    expect(yarns().map((y) => y.noteIds)).toEqual([[A, B, C]])
    // Shift-click A, already on the thread: core no-ops, and the strand still hangs from C.
    tool.pointerDown(at(A, true))
    tool.pointerUp(at(A, true))
    expect(tool.winding()).toBe(true)
    expect(tool.holds(C)).toBe(true)
    expect(tool.holds(A)).toBe(false)
    expect(sources.at(-1)).toBe(C)
    tool.pointerMove(at({ x: 1000, y: 700 }))
    expect(lives.at(-1)).toMatchObject({ from: { x: 720, y: -10 } })
    // The next drop appends after C, where the strand is.
    tool.pointerDown(at(D))
    tool.pointerUp(at(D))
    expect(yarns().map((y) => y.noteIds)).toEqual([[A, B, C, D]])
  })

  it('an undo under a winding thread ends the winding', () => {
    const g = gesture()
    const tool = g.make(A)
    tool.pointerDown(g.at(A))
    tool.pointerUp(g.at(B, true))
    tool.pointerDown(g.at(C, true))
    tool.pointerUp(g.at(C, true))
    expect(tool.winding()).toBe(true)
    // ⌘Z takes C off again (as the history's inverse does).
    g.store.commit([{ op: 'yarn.removeNote', id: g.yarns()[0]?.id as string, noteId: C }], {
      undo: 'skip',
    })
    tool.pointerMove(g.at({ x: 800, y: 500 }))
    expect(tool.winding()).toBe(false)
    expect(g.lives.at(-1)).toBeNull()
    expect(tool.active()).toBe(false)

    // Undoing the tie itself (the thread is gone) too.
    const g2 = gesture()
    const t2 = g2.make(A)
    t2.pointerDown(g2.at(A))
    t2.pointerUp(g2.at(B, true))
    g2.store.commit([{ op: 'yarn.delete', id: g2.yarns()[0]?.id as string }], { undo: 'skip' })
    t2.pointerDown(g2.at(C, true))
    t2.pointerUp(g2.at(C, true))
    expect(t2.winding()).toBe(false)
    expect(g2.yarns()).toEqual([])
  })

  it('entering the winding says the thread is live, and how to leave it', () => {
    const g = gesture()
    const tool = g.make(A)
    tool.pointerDown(g.at(A))
    tool.pointerUp(g.at(B, true))
    expect(said()).toBe('Winding on from “Beta”. Click notes to add, Esc to finish.')
    tool.pointerDown(g.at(C, true))
    tool.pointerUp(g.at(C, true))
    expect(said()).toBe('Winding on from “Gamma”. Click notes to add, Esc to finish.')
  })

  it('a press on an existing pin starts there, and the new thread shares it', () => {
    const g = gesture()
    const at = { x: 120, y: -10 }
    const tool = g.make(A, undefined, { pin: 'hanging', at })
    tool.pointerDown(g.at(A))
    tool.pointerMove(g.at({ x: 500, y: 400 }))
    // From the hanging pin, the strand runs beneath A's own paper.
    expect(g.lives.at(-1)).toMatchObject({ from: at, under: A })
    tool.pointerUp(g.at(B))
    // From another thread's edge pin it does not.
    const edge = g.make(C, undefined, { pin: { yarnId: g.yarns()[0]?.id as string, end: 'b' }, at })
    edge.pointerDown(g.at(C))
    edge.pointerMove(g.at({ x: 500, y: 400 }))
    expect(g.lives.at(-1)).not.toHaveProperty('under')
    edge.cancel()
    expect(g.yarns().map((y) => [y.noteIds, y.pins])).toEqual([[[A, B], { [A]: 'hanging' }]])
  })

  it('over an existing pin the strand lands on it and the drop shares it; elsewhere it does not', () => {
    const g = gesture()
    const first = g.flows.tie(C, B)
    const p = { x: 330, y: 80 }
    g.pins.set(B, { pin: { yarnId: first.yarnId, end: 'b' }, at: p })
    const tool = g.make(A)
    tool.pointerDown(g.at(A))
    tool.pointerMove(g.at({ x: 334, y: 83 }))
    expect(g.lives.at(-1)).toMatchObject({ to: p, targetNoteId: B, shared: 'edge' })
    tool.pointerMove(g.at(B))
    expect(g.lives.at(-1)).not.toHaveProperty('shared')
    tool.pointerMove(g.at({ x: 334, y: 83 }))
    tool.pointerUp(g.at({ x: 334, y: 83 }))
    const key = g.store.getState().yarns.get(first.yarnId)?.pins?.[B]
    expect(key).toBeDefined()
    expect(g.yarns().at(-1)).toMatchObject({ noteIds: [A, B], pins: { [B]: key } })
    expect(said()).toBe('Tied “Alpha” to “Beta” with crimson yarn, on the existing pin')

    const plain = gesture()
    plain.pins.set(B, { pin: 'hanging', at: p })
    const t2 = plain.make(A)
    t2.pointerDown(plain.at(A))
    t2.pointerMove(plain.at({ x: 334, y: 83 }))
    expect(plain.lives.at(-1)).toMatchObject({ to: p, targetNoteId: B, shared: 'hanging' })
    t2.pointerUp(plain.at(B))
    expect(plain.yarns()[0]).not.toHaveProperty('pins')
  })

  it('winding on from a shared pin leaves from it and shares the next pin too', () => {
    const g = gesture()
    const other = g.flows.tie(B, D, 'indigo')
    const p = { x: 330, y: 80 }
    g.pins.set(B, { pin: { yarnId: other.yarnId, end: 'a' }, at: p })
    g.pins.set(C, { pin: 'hanging', at: { x: 720, y: 10 } })
    const tool = g.make(A)
    tool.pointerDown(g.at(A))
    tool.pointerUp({ ...g.at(p), shiftKey: true })
    expect(tool.winding()).toBe(true)
    tool.pointerMove(g.at({ x: 700, y: 400 }))
    expect(g.lives.at(-1)).toMatchObject({ from: p })
    expect(g.lives.at(-1)).not.toHaveProperty('under')
    tool.pointerDown(g.at({ x: 721, y: 11 }))
    tool.pointerUp(g.at({ x: 721, y: 11 }))
    const thread = g.yarns().find((y) => y.color === 'apricot')
    const key = g.store.getState().yarns.get(other.yarnId)?.pins?.[B]
    expect(thread).toMatchObject({ noteIds: [A, B, C], pins: { [B]: key, [C]: 'hanging' } })
  })

  it("extending a selected thread's end onto a pin ties it there", () => {
    const g = gesture()
    const { yarnId } = g.flows.tie(A, B)
    g.pins.set(C, { pin: 'hanging', at: { x: 720, y: 10 } })
    const tool = g.make(B, { yarnId, end: 'last' })
    tool.pointerDown(g.at(B))
    tool.pointerUp(g.at({ x: 718, y: 10 }))
    expect(g.store.getState().yarns.get(yarnId)).toMatchObject({
      noteIds: [A, B, C],
      pins: { [C]: 'hanging' },
    })
  })
})

describe('shared pins', () => {
  /** Record every commit on an undo stack, as the board's history does. */
  function withHistory() {
    const g = setup()
    const history = new UndoStack()
    g.store.onCommit((before, ops, o) => {
      if (o.undo !== 'skip') history.record(before, ops, o.label ?? '')
    })
    const undo = () => {
      const step = history.undo(g.store.getState())
      if (step) g.store.commit(step.ops, { undo: 'skip' })
    }
    return { ...g, undo }
  }
  const pinsOf = (g: ReturnType<typeof setup>, yarnId: string) =>
    g.store.getState().yarns.get(yarnId)?.pins

  it("ties at the note's hanging pin; joining a thread already there is said", () => {
    const g = setup()
    const { yarnId } = g.flows.tie(A, B, 'apricot', { from: 'hanging' })
    expect(pinsOf(g, yarnId)).toEqual({ [A]: 'hanging' })
    expect(g.store.commits).toBe(1)
    // The hanging pin held no thread yet: nothing to say about it.
    expect(said()).toBe('Tied “Alpha” to “Beta” with crimson yarn')
    g.flows.tie(A, C, 'apricot', { from: 'hanging' })
    expect(said()).toBe('Tied “Alpha” to “Gamma” with crimson yarn, on the existing pin')
    g.flows.extend(yarnId, 'last', D, 'hanging')
    expect(said()).toBe('Added “Empty note” to the thread')
  })

  it("shares another thread's edge pin: one key minted on both ends, in one batch, one undo", () => {
    const g = withHistory()
    const first = g.flows.tie(A, B)
    expect(pinsOf(g, first.yarnId)).toBeUndefined()
    const commits = g.store.commits
    const next = g.flows.tie(C, B, 'apricot', { to: { yarnId: first.yarnId, end: 'b' } })
    expect(g.store.commits).toBe(commits + 1)
    const key = pinsOf(g, first.yarnId)?.[B] as string
    expect(key).toMatch(PIN_KEY_PATTERN)
    // It names the end it was: B's end of the first thread, toward its previous note.
    expect(key).toBe(anchorKey(first.yarnId, 'b'))
    expect(pinsOf(g, next.yarnId)).toEqual({ [B]: key })
    g.undo()
    expect(g.store.getState().yarns.has(next.yarnId)).toBe(false)
    expect(g.store.getState().yarns.get(first.yarnId)).not.toHaveProperty('pins')
  })

  it('reuses the key a shared pin already has, changing nothing else', () => {
    const g = setup()
    const first = g.flows.tie(A, B, 'apricot', { to: 'hanging' })
    const second = g.flows.tie(C, B, 'apricot', { to: { yarnId: first.yarnId, end: 'b' } })
    expect(pinsOf(g, second.yarnId)).toEqual({ [B]: 'hanging' })
    const third = g.flows.tie(B, D, 'indigo')
    const fourth = g.flows.tie(B, C, 'indigo', { from: { yarnId: third.yarnId, end: 'a' } })
    const key = pinsOf(g, third.yarnId)?.[B]
    expect(pinsOf(g, fourth.yarnId)).toEqual({ [B]: key })
    const before = g.store.getState().yarns.get(third.yarnId)
    g.flows.tie(B, A, 'sage', { from: { yarnId: fourth.yarnId, end: 'a' } })
    expect(g.store.getState().yarns.get(third.yarnId)).toBe(before)
  })

  it('gives two pins on one note two keys', () => {
    const g = setup()
    const first = g.flows.tie(A, B)
    const second = g.flows.tie(C, B)
    g.flows.tie(D, B, 'apricot', { to: { yarnId: first.yarnId, end: 'b' } })
    g.flows.tie(D, B, 'indigo', { to: { yarnId: second.yarnId, end: 'b' } })
    expect(pinsOf(g, first.yarnId)?.[B]).not.toBe(pinsOf(g, second.yarnId)?.[B])
  })

  it('a thread through the note: the key names the pin pressed, toward its next or previous note', () => {
    const g = setup()
    const through = g.flows.tie(A, B)
    g.flows.extend(through.yarnId, 'last', C)
    g.flows.tie(D, B, 'apricot', { to: { yarnId: through.yarnId, end: 'a' } })
    expect(pinsOf(g, through.yarnId)?.[B]).toBe(anchorKey(through.yarnId, 'a'))
    expect(anchorKey(through.yarnId, 'a').endsWith('n')).toBe(true)
  })

  it('both ends sharing pins of one thread patch it once', () => {
    const g = setup()
    const first = g.flows.tie(A, B)
    const ops: string[] = []
    g.store.onCommit((_b, batch) => ops.push(...batch.map((op) => op.op)))
    const next = g.flows.tie(A, B, 'indigo', {
      from: { yarnId: first.yarnId, end: 'a' },
      to: { yarnId: first.yarnId, end: 'b' },
    })
    expect(ops).toEqual(['yarn.update', 'yarn.create'])
    const pins = pinsOf(g, first.yarnId)
    expect(Object.keys(pins ?? {})).toEqual([A, B])
    expect(pinsOf(g, next.yarnId)).toEqual(pins)
    expect(said()).toBe('Tied “Alpha” to “Beta” with indigo yarn, on the existing pins')
  })

  it('an already-tied pair is only shown: no pin changes', () => {
    const g = setup()
    const first = g.flows.tie(A, B)
    const res = g.flows.tie(A, B, 'apricot', {
      to: 'hanging',
      from: { yarnId: first.yarnId, end: 'a' },
    })
    expect(res.created).toBe(false)
    expect(pinsOf(g, first.yarnId)).toBeUndefined()
  })

  it('winding a note on at a shared pin ties it there, in one batch, one undo', () => {
    const g = withHistory()
    const other = g.flows.tie(C, D)
    const thread = g.flows.tie(A, B)
    const commits = g.store.commits
    expect(g.flows.extend(thread.yarnId, 'last', C, { yarnId: other.yarnId, end: 'a' })).toBe(true)
    expect(g.store.commits).toBe(commits + 1)
    const key = pinsOf(g, other.yarnId)?.[C]
    expect(key).toMatch(PIN_KEY_PATTERN)
    expect(pinsOf(g, thread.yarnId)).toEqual({ [C]: key })
    expect(g.store.getState().yarns.get(thread.yarnId)?.noteIds).toEqual([A, B, C])
    g.undo()
    expect(g.store.getState().yarns.get(thread.yarnId)).toMatchObject({ noteIds: [A, B] })
    expect(g.store.getState().yarns.get(thread.yarnId)).not.toHaveProperty('pins')
    expect(g.store.getState().yarns.get(other.yarnId)).not.toHaveProperty('pins')
    // At the hanging pin, and onto a note already on the thread: nothing changes.
    g.flows.extend(thread.yarnId, 'first', D, 'hanging')
    expect(pinsOf(g, thread.yarnId)).toEqual({ [D]: 'hanging' })
    const now = g.store.commits
    expect(g.flows.extend(thread.yarnId, 'last', A, 'hanging')).toBe(false)
    expect(g.store.commits).toBe(now)
  })
})
