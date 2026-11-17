import { type Board, type Note, OpError, stateFromRecords } from '@papertie/core'
import { prefsStore } from '../src/app/prefs'
import { anchorKey } from '../src/canvas/attach'
import type { Hit } from '../src/canvas/hitTest'
import type { CanvasRuntime } from '../src/canvas/runtime'
import { type CaptureStage, installCaptureHandlers } from '../src/interactions/capture'
import { createBoardStore } from '../src/store/boardStore'
import { closeConnect, connectFrom } from '../src/yarn/connectStore'
import { createYarnFlows } from '../src/yarn/yarnFlows'

vi.mock('../src/app/liveRegion', () => ({ announce: vi.fn() }))

/*
 * The capture stage's connect state machine, driven the way the runtime drives it: with a stub
 * runtime (identity camera, notes found by rectangle) and the real flows on a real store.
 */
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
const note = (n: number): Note => ({
  type: 'note',
  id: nid(n),
  x: (n - 1) * 300,
  y: 100,
  w: 240,
  h: 160,
  z: n,
  paper: 'cream',
  style: 'rustic',
  text: ['Alpha', 'Beta', 'Gamma', 'Delta'][n - 1] as string,
  image: null,
  createdAt: T0,
  updatedAt: T0,
})

interface Pt {
  x: number
  y: number
}
const pinOf = (n: Note): Pt => ({ x: n.x + n.w / 2, y: n.y - 10 })

function setup() {
  const store = createBoardStore(
    stateFromRecords(BOARD, [1, 2, 3, 4].map(note)),
    undefined,
    () => T0,
  )
  const state = { selectedYarnId: undefined as string | undefined, selection: new Set<string>() }
  const flows = createYarnFlows(store, {
    select: (id) => {
      state.selectedYarnId = id
    },
  })
  const noteAt = (w: Pt) =>
    [...store.getState().notes.values()].find(
      (n) => w.x >= n.x && w.x <= n.x + n.w && w.y >= n.y && w.y <= n.y + n.h,
    )?.id
  const lives: Array<unknown> = []
  let stage: CaptureStage | null = null
  const rt = {
    store,
    yarnFlows: flows,
    get selectedYarnId() {
      return state.selectedYarnId
    },
    get selection() {
      return state.selection
    },
    editing: null,
    pressing: false,
    panning: false,
    pressTravelled: false,
    lod: 'full',
    setCaptureStage: (s: CaptureStage | null) => {
      stage = s
    },
    toViewport: (x: number, y: number) => ({ x, y }),
    drawnCamera: () => ({ x: 0, y: 0, zoom: 1 }),
    toolPointer: (e: PointerEvent) => ({
      screen: { x: e.clientX, y: e.clientY },
      world: { x: e.clientX, y: e.clientY },
      button: e.button,
      shiftKey: e.shiftKey,
      target: {},
    }),
    hitTest: (p: Pt): Hit => {
      for (const n of store.getState().notes.values()) {
        const pin = pinOf(n)
        if (Math.hypot(p.x - pin.x, p.y - pin.y) <= 10) return { kind: 'pin', noteId: n.id }
      }
      return rt.edgeHit?.(p) ?? { kind: 'none' }
    },
    edgeHit: undefined as ((p: Pt) => Hit | undefined) | undefined,
    /**
     * Threads drawn as they were before the store's board was swapped in whole (the canvas still
     * catching up): what the hits are made from until a gesture takes them.
     */
    stale: new Map<string, readonly string[]>(),
    drawnYarn: (id: string) => {
      const y = store.getState().yarns.get(id)
      const was = rt.stale.get(id)
      return y && was ? { ...y, noteIds: was } : y
    },
    takeBeforeGesture: (ids: Iterable<string>) => {
      const of = new Set(ids)
      let changed = false
      for (const [id, was] of rt.stale) {
        if (!was.some((n) => of.has(n))) continue
        rt.stale.delete(id)
        changed = true
      }
      return changed
    },
    /** Where the stub's one edge pin is, for every thread end. */
    edgeAt: undefined as Pt | undefined,
    attachWorld: () => rt.edgeAt,
    noteAt,
    pinWorld: (id: string) => {
      const n = store.getState().notes.get(id)
      return n && pinOf(n)
    },
    landingWorld: () => undefined,
    setLiveThread: (l: unknown) => {
      lives.push(l)
    },
    setHoverPin: () => {},
    setHoverCard: () => {},
    selectYarn: (id: string | null) => {
      state.selectedYarnId = id ?? undefined
    },
    selectNote: (id: string | null) => {
      state.selection = new Set(id === null ? [] : [id])
    },
    stopEditing: () => {},
    startEditing: () => false,
    createNoteAt: () => {},
  }
  const root = document.createElement('div')
  document.body.append(root)
  const off = installCaptureHandlers(root, rt as unknown as CanvasRuntime)
  if (stage === null) throw new Error('no stage')
  const st: CaptureStage = stage
  const pe = (type: string, at: Pt, o: Partial<PointerEvent> = {}) =>
    ({
      type,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: at.x,
      clientY: at.y,
      shiftKey: false,
      target: root,
      ...o,
    }) as unknown as PointerEvent
  const centre = (id: string): Pt => {
    const n = store.getState().notes.get(id) as Note
    return { x: n.x + n.w / 2, y: n.y + n.h / 2 }
  }
  const yarns = () => [...store.getState().yarns.values()].map((y) => y.noteIds)
  return {
    store,
    state,
    rt,
    st,
    pe,
    centre,
    yarns,
    lives,
    root,
    off,
    pin: (id: string) => pinOf(store.getState().notes.get(id) as Note),
  }
}

// The Yarn tool is the one way to tie a thread (a press on a pin or anywhere on a note).
beforeEach(() => {
  prefsStore.setState({ tool: 'yarn' })
})
afterEach(() => {
  closeConnect()
  document.body.replaceChildren()
  prefsStore.setState({ tool: 'select' })
})

describe('the capture stage with the select tool', () => {
  beforeEach(() => {
    prefsStore.setState({ tool: 'select' })
  })

  it("a press on a hanging pin ties nothing: the press is the note's", () => {
    const { st, pe, pin, centre, yarns, lives } = setup()
    expect(st.down(pe('pointerdown', pin(A)))).toBe(false)
    st.move(pe('pointermove', centre(B)))
    st.end(pe('pointerup', centre(B)))
    expect(yarns()).toEqual([])
    expect(lives).toEqual([])
    expect(st.holds(A)).toBe(false)
  })

  it("a press on an unselected thread's edge pin selects the thread and ties nothing", () => {
    const s = setup()
    const { yarnId } = s.rt.yarnFlows.tie(A, B)
    s.rt.selectYarn(null)
    const end = { x: 300, y: 180 }
    s.rt.edgeAt = end
    s.rt.edgeHit = (p) =>
      Math.hypot(p.x - end.x, p.y - end.y) <= 10
        ? { kind: 'pin', noteId: B, edge: { yarnId, segIndex: 0, end: 'b' } }
        : undefined
    expect(s.st.down(s.pe('pointerdown', end))).toBe(true)
    s.st.move(s.pe('pointermove', s.centre(C)))
    s.st.end(s.pe('pointerup', s.centre(C)))
    expect(s.yarns()).toEqual([[A, B]])
    expect(s.rt.selectedYarnId).toBe(yarnId)
    expect(s.lives).toEqual([])
  })

  it('the end pin of the selected thread still extends it', () => {
    const s = setup()
    const { yarnId } = s.rt.yarnFlows.tie(A, B)
    s.rt.selectYarn(yarnId)
    const end = { x: 300, y: 180 }
    s.rt.edgeAt = end
    s.rt.edgeHit = (p) =>
      Math.hypot(p.x - end.x, p.y - end.y) <= 10
        ? { kind: 'pin', noteId: B, edge: { yarnId, segIndex: 0, end: 'b' } }
        : undefined
    expect(s.st.down(s.pe('pointerdown', end))).toBe(true)
    s.st.move(s.pe('pointermove', s.centre(C)))
    s.st.end(s.pe('pointerup', s.centre(C)))
    expect(s.yarns()).toEqual([[A, B, C]])
  })

  it('hovering a hanging pin shows no pin: there is nothing to pull from it', () => {
    const { st, pe, pin, root } = setup()
    st.move(pe('pointermove', pin(A), { buttons: 0 }))
    expect(root.dataset.hover).toBeUndefined()
    prefsStore.setState({ tool: 'yarn' })
    st.move(pe('pointermove', { x: pin(A).x + 1, y: pin(A).y }, { buttons: 0 }))
    expect(root.dataset.hover).toBe('pin')
  })
})

describe('the capture stage connect gesture', () => {
  it('ties in the colour the Yarn tool was armed with, the live strand drawn in it', () => {
    prefsStore.setState({ yarnColor: 'indigo' })
    const { st, pe, centre, pin, store, lives } = setup()
    st.down(pe('pointerdown', pin(A)))
    st.move(pe('pointermove', centre(B)))
    expect(lives.at(-1)).toMatchObject({ color: 'indigo' })
    st.end(pe('pointerup', centre(B)))
    expect([...store.getState().yarns.values()].map((y) => y.color)).toEqual(['indigo'])
    prefsStore.setState({ yarnColor: 'apricot' })
  })

  it('a Shift release winds on; clicks drop, through the capture release and button-less moves', () => {
    const { st, pe, centre, yarns, pin, off } = setup()
    expect(st.down(pe('pointerdown', pin(A)))).toBe(true)
    st.move(pe('pointermove', centre(B)))
    st.end(pe('pointerup', centre(B), { shiftKey: true }))
    expect(yarns()).toEqual([[A, B]])
    expect(st.holds(B)).toBe(true)
    // The release lets go of the pointer capture; the thread is still being wound.
    st.end(pe('lostpointercapture', centre(B)))
    expect(st.holds(B)).toBe(true)
    // The mouse moves with no button down: that is not a missed release.
    st.move(pe('pointermove', centre(C), { buttons: 0 }))
    expect(st.holds(B)).toBe(true)
    // A click on C, Shift held: wound on, and still going.
    expect(st.down(pe('pointerdown', centre(C), { shiftKey: true }))).toBe(true)
    st.end(pe('pointerup', centre(C), { shiftKey: true }))
    st.end(pe('lostpointercapture', centre(C)))
    expect(yarns()).toEqual([[A, B, C]])
    expect(st.holds(C)).toBe(true)
    // A click on D without Shift ends it; the next press is the tools' again.
    expect(st.down(pe('pointerdown', centre(D)))).toBe(true)
    st.end(pe('pointerup', centre(D)))
    expect(yarns()).toEqual([[A, B, C, D]])
    expect(st.holds(D)).toBe(false)
    expect(st.down(pe('pointerdown', { x: 3000, y: 3000 }))).toBe(false)
    off()
  })

  it("Esc and a click on cork end the winding; presses are the tools' again", () => {
    const esc = setup()
    esc.st.down(esc.pe('pointerdown', esc.pin(A)))
    esc.st.end(esc.pe('pointerup', esc.centre(B), { shiftKey: true }))
    expect(esc.st.key({ key: 'Escape' } as KeyboardEvent)).toBe(true)
    expect(esc.st.holds(B)).toBe(false)
    expect(esc.st.down(esc.pe('pointerdown', { x: 3000, y: 3000 }))).toBe(false)

    const cork = setup()
    cork.st.down(cork.pe('pointerdown', cork.pin(A)))
    cork.st.end(cork.pe('pointerup', cork.centre(B), { shiftKey: true }))
    const commits = cork.store.commits
    expect(cork.st.down(cork.pe('pointerdown', { x: 3000, y: 3000 }))).toBe(true)
    cork.st.end(cork.pe('pointerup', { x: 3000, y: 3000 }))
    expect(cork.store.commits).toBe(commits)
    expect(cork.st.down(cork.pe('pointerdown', { x: 3000, y: 3000 }))).toBe(false)
  })

  it('a press-hold drag whose mouse was released elsewhere is cancelled by the next move', () => {
    const { st, pe, pin, centre, yarns } = setup()
    st.down(pe('pointerdown', pin(A)))
    st.move(pe('pointermove', centre(B), { buttons: 0 }))
    expect(st.holds(A)).toBe(false)
    expect(yarns()).toEqual([])
  })

  it('a drop whose commit is refused ends the gesture instead of swallowing every press', () => {
    const { st, pe, pin, centre, store, yarns } = setup()
    st.down(pe('pointerdown', pin(A)))
    st.move(pe('pointermove', centre(B)))
    vi.spyOn(store, 'commit').mockImplementationOnce(() => {
      throw new OpError('not-found', 'gone')
    })
    expect(() => st.end(pe('pointerup', centre(B)))).not.toThrow()
    expect(st.holds(A)).toBe(false)
    expect(st.down(pe('pointerdown', { x: 3000, y: 3000 }))).toBe(false)
    expect(yarns()).toEqual([])
  })

  it('a refusal in the winding click ends it too', () => {
    const { st, pe, pin, centre, store } = setup()
    st.down(pe('pointerdown', pin(A)))
    st.end(pe('pointerup', centre(B), { shiftKey: true }))
    vi.spyOn(store, 'commit').mockImplementationOnce(() => {
      throw new OpError('limit', 'full')
    })
    expect(() => st.down(pe('pointerdown', centre(C), { shiftKey: true }))).not.toThrow()
    expect(st.holds(B)).toBe(false)
    expect(st.down(pe('pointerdown', { x: 3000, y: 3000 }))).toBe(false)
  })

  it('a bug in a drop still ends the gesture before it surfaces', () => {
    const { st, pe, pin, centre, store } = setup()
    st.down(pe('pointerdown', pin(A)))
    vi.spyOn(store, 'commit').mockImplementationOnce(() => {
      throw new TypeError('bug')
    })
    expect(() => st.end(pe('pointerup', centre(B)))).toThrow('bug')
    expect(st.holds(A)).toBe(false)
    expect(st.down(pe('pointerdown', { x: 3000, y: 3000 }))).toBe(false)
  })

  it('an undo under a winding thread ends it on the next move', () => {
    const { st, pe, pin, centre, store, yarns } = setup()
    st.down(pe('pointerdown', pin(A)))
    st.end(pe('pointerup', centre(B), { shiftKey: true }))
    const id = [...store.getState().yarns.keys()][0] as string
    store.commit([{ op: 'yarn.delete', id }], { undo: 'skip' })
    st.move(pe('pointermove', centre(C), { buttons: 0 }))
    expect(st.holds(B)).toBe(false)
    expect(st.down(pe('pointerdown', { x: 3000, y: 3000 }))).toBe(false)
    expect(yarns()).toEqual([])
  })

  it('a drag from the end pin of the selected thread extends it', () => {
    const s = setup()
    const { yarnId } = s.rt.yarnFlows.tie(A, B)
    s.rt.selectYarn(yarnId)
    const end = { x: 300, y: 180 }
    s.rt.edgeAt = end
    s.rt.edgeHit = (p) =>
      Math.hypot(p.x - end.x, p.y - end.y) <= 10
        ? { kind: 'pin', noteId: B, edge: { yarnId, segIndex: 0, end: 'b' } }
        : undefined
    s.st.down(s.pe('pointerdown', end))
    s.st.move(s.pe('pointermove', s.centre(C)))
    s.st.end(s.pe('pointerup', s.centre(C)))
    expect(s.yarns()).toEqual([[A, B, C]])
    // The near end is not an end of the thread's: a press there starts a plain tie from B.
    s.rt.selectYarn(yarnId)
    s.rt.edgeHit = (p) =>
      Math.hypot(p.x - end.x, p.y - end.y) <= 10
        ? { kind: 'pin', noteId: B, edge: { yarnId, segIndex: 0, end: 'b' } }
        : undefined
    s.st.down(s.pe('pointerdown', end))
    s.st.end(s.pe('pointerup', s.centre(D)))
    expect(s.yarns()).toEqual([
      [A, B, C],
      [B, D],
    ])
  })

  it('a press on a hanging pin ties the thread there; a drop on one shares it too', () => {
    const { st, pe, pin, centre, store } = setup()
    st.down(pe('pointerdown', pin(A)))
    st.end(pe('pointerup', centre(B)))
    st.down(pe('pointerdown', pin(C)))
    st.move(pe('pointermove', pin(D)))
    st.end(pe('pointerup', pin(D)))
    expect([...store.getState().yarns.values()].map((y) => [y.noteIds, y.pins])).toEqual([
      [[A, B], { [A]: 'hanging' }],
      [[C, D], { [C]: 'hanging', [D]: 'hanging' }],
    ])
  })

  it("a drop on another thread's edge pin shares it: the live strand lands there first", () => {
    const s = setup()
    const { yarnId } = s.rt.yarnFlows.tie(A, B)
    const end = { x: 320, y: 180 }
    s.rt.edgeAt = end
    s.rt.edgeHit = (p) =>
      Math.hypot(p.x - end.x, p.y - end.y) <= 10
        ? { kind: 'pin', noteId: B, edge: { yarnId, segIndex: 0, end: 'b' } }
        : undefined
    s.st.down(s.pe('pointerdown', s.pin(C)))
    s.st.move(s.pe('pointermove', { x: 324, y: 183 }))
    expect(s.lives.at(-1)).toMatchObject({ to: end, targetNoteId: B, shared: 'edge' })
    s.st.end(s.pe('pointerup', { x: 324, y: 183 }))
    const all = [...s.store.getState().yarns.values()]
    const key = all[0]?.pins?.[B]
    expect(key).toBe(anchorKey(yarnId, 'b'))
    expect(all[1]).toMatchObject({ noteIds: [C, B], pins: { [C]: 'hanging', [B]: key } })
  })

  it('on a thread through a note, the end hit is the pin shared: toward its next or its previous note', () => {
    for (const [segIndex, end] of [
      [0, 'b'],
      [1, 'a'],
    ] as const) {
      const s = setup()
      const { yarnId } = s.rt.yarnFlows.tie(A, B)
      s.rt.yarnFlows.extend(yarnId, 'last', C)
      const at = { x: 400 + 100 * segIndex, y: 180 }
      s.rt.edgeAt = at
      s.rt.edgeHit = (p) =>
        Math.hypot(p.x - at.x, p.y - at.y) <= 10
          ? { kind: 'pin', noteId: B, edge: { yarnId, segIndex, end } }
          : undefined
      s.st.down(s.pe('pointerdown', s.pin(D)))
      s.st.end(s.pe('pointerup', at))
      const pins = s.store.getState().yarns.get(yarnId)?.pins
      expect(pins).toEqual({ [B]: anchorKey(yarnId, end) })
      expect(pins?.[B]?.endsWith(end === 'a' ? 'n' : 'p')).toBe(true)
    }
  })

  it('while the canvas catches up, an end pin is judged on the thread as the store has it', () => {
    prefsStore.setState({ tool: 'select' })
    const s = setup()
    const { yarnId } = s.rt.yarnFlows.tie(A, B)
    s.rt.selectYarn(yarnId)
    // A restore put C before A; the canvas still draws the thread as A, B.
    s.rt.yarnFlows.extend(yarnId, 'first', C)
    s.rt.stale.set(yarnId, [A, B])
    const at = { x: 120, y: 180 }
    s.rt.edgeAt = at
    s.rt.edgeHit = (p) => {
      if (Math.hypot(p.x - at.x, p.y - at.y) > 10) return undefined
      // A's edge pin: the drawn thread's first end, the restored thread's second note.
      const drawn = s.rt.drawnYarn(yarnId)?.noteIds
      return drawn?.[0] === A
        ? { kind: 'pin', noteId: A, edge: { yarnId, segIndex: 0, end: 'a' } }
        : { kind: 'pin', noteId: A, edge: { yarnId, segIndex: 0, end: 'b' } }
    }
    // A hover shows the end drawn.
    s.st.move(s.pe('pointermove', at, { buttons: 0 }))
    expect(s.root.dataset.hover).toBe('pin')
    // The press takes the thread: A is in its middle now, so the press selects it. No strand
    // starts from A as an end, and the drag extends nothing (never from C, the first end).
    s.lives.length = 0
    expect(s.st.down(s.pe('pointerdown', at))).toBe(true)
    expect(s.rt.stale.has(yarnId)).toBe(false)
    s.st.move(s.pe('pointermove', s.centre(D)))
    s.st.end(s.pe('pointerup', s.centre(D)))
    expect(s.lives).toEqual([])
    expect(s.yarns()).toEqual([[C, A, B]])
    expect(s.rt.selectedYarnId).toBe(yarnId)
  })
})

describe('the capture stage keys', () => {
  const key = (k: string, target: EventTarget | null, o: Partial<KeyboardEvent> = {}) =>
    ({
      key: k,
      code: `Key${k.toUpperCase()}`,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      target,
      ...o,
    }) as unknown as KeyboardEvent

  it('C on the one selected note opens Connect to… for it', () => {
    const { st, rt } = setup()
    rt.selectNote(A)
    expect(st.key(key('c', document.body))).toBe(true)
    expect(connectFrom()).toBe(A)
  })

  it('C does nothing with no selection, with two, in the UI, in a field or with a modifier', () => {
    const { st, rt, root, state } = setup()
    expect(st.key(key('c', document.body))).toBe(false)
    state.selection = new Set([A, B])
    expect(st.key(key('c', document.body))).toBe(false)
    rt.selectNote(A)
    const ui = document.createElement('button')
    ui.className = 'ui'
    root.append(ui)
    expect(st.key(key('c', ui))).toBe(false)
    const input = document.createElement('input')
    document.body.append(input)
    expect(st.key(key('c', input))).toBe(false)
    expect(st.key(key('c', document.body, { metaKey: true }))).toBe(false)
    expect(connectFrom()).toBeNull()
  })

  it('while writing is on but its field has no focus, P (like the other board keys) is swallowed', () => {
    const { st, rt } = setup()
    ;(rt as { editing: string | null }).editing = A
    // Not the field: the board's keys do nothing meanwhile, the photo picker's included.
    expect(st.key(key('p', document.body))).toBe(true)
    expect(st.key(key('v', document.body))).toBe(true)
    expect(st.key(key('x', document.body))).toBe(false)
    // A chord is the browser's.
    expect(st.key(key('p', document.body, { metaKey: true }))).toBe(false)
    // With nothing being written, the stage leaves P to the runtime.
    ;(rt as { editing: string | null }).editing = null
    expect(st.key(key('p', document.body))).toBe(false)
  })

  it('Delete unties the selected thread, but not from a control inside the UI', () => {
    const { st, rt, store, root } = setup()
    const { yarnId } = rt.yarnFlows.tie(A, B)
    rt.selectYarn(yarnId)
    const ui = document.createElement('button')
    ui.className = 'ui'
    root.append(ui)
    expect(st.key(key('Delete', ui, { code: 'Delete' }))).toBe(false)
    expect(store.getState().yarns.size).toBe(1)
    expect(st.key(key('Delete', document.body, { code: 'Delete' }))).toBe(true)
    expect(store.getState().yarns.size).toBe(0)
  })
})
