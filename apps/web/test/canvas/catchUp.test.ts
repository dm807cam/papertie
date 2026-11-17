// @vitest-environment jsdom
/**
 * Editing while the canvas catches up with a board swapped in whole (a restore, a reload): the
 * canvas draws the board as it has taken it so far, but every edit starts from the restored
 * record, never a stale drawn one; a note the restore removed goes when it is pressed; the view
 * (and its threads) come first, wherever the camera goes; and the store's own board is never
 * built anew per gesture meanwhile.
 */
import { type BoardState, type Note, stateFromRecords, type Yarn } from '@papertie/core'
import { generateBoard } from '@papertie/tools/gen-board'
import { topologyOf, topologyStats } from '../../src/canvas/attach'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { type BoardStore, createBoardStore } from '../../src/store/boardStore'
import { canvasElements, installCanvasStubs } from '../helpers/domCanvas'

// The catch-up's own slices never run here: each test takes its steps itself.
vi.mock('../../src/sync/pace', () => ({
  pagePace: { hidden: () => false, yield: () => new Promise<void>(() => {}) },
}))

interface Inside {
  model: Pick<BoardState, 'notes' | 'yarns'>
  catching: { first: string[]; walked: boolean } | null
  catchUpSlice(end: number): boolean
  nudgeSelection(dir: 'left' | 'right' | 'up' | 'down', step: number): boolean
}
const inside = (rt: CanvasRuntime) => rt as unknown as Inside

const base = generateBoard({ notes: 20_000, yarns: 2_000, seed: 5 })
const ids = [...base.notes.keys()]
/** Notes far from the view (the board's other corner). */
const far = ids.slice(-40)

/** `s` loaded again: every record a copy, `change` applied to the notes it names. */
function restored(s: BoardState, change: Record<string, Partial<Note> | null> = {}): BoardState {
  const notes: Note[] = []
  for (const n of s.notes.values()) {
    const c = change[n.id]
    if (c === null) continue
    notes.push({ ...n, ...c })
  }
  const yarns = [...s.yarns.values()]
    .map((y) => ({ ...y, noteIds: y.noteIds.filter((id) => change[id] !== null) }))
    .filter((y) => y.noteIds.length >= 2)
  return stateFromRecords(s.board, [...s.assets.values(), ...notes, ...yarns])
}

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: x,
    clientY: y,
  })

/**
 * A note's element as `NoteLayer` would mount it, with the camera over bare cork, so that the
 * press is on that note alone (no other note, pin or thread under the pointer).
 */
function noteEl(rt: CanvasRuntime, id: string): HTMLElement {
  rt.camera.set({ x: -200_000, y: -200_000, zoom: 1 })
  const el = document.createElement('article')
  el.dataset.noteId = id
  rt.els.world.append(el)
  return el
}

let restore: () => void = () => {}
let store: BoardStore
let rt: CanvasRuntime
beforeEach(async () => {
  restore = installCanvasStubs()
  store = createBoardStore(base)
  rt = new CanvasRuntime(canvasElements(), store)
  // The board's first corner, at reading zoom.
  const n = base.notes.get(ids[0] as string) as Note
  rt.camera.set({ x: n.x - 100, y: n.y - 100, zoom: 1 })
  // A few frames: the view is culled at reading zoom.
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 17))
})
afterEach(() => {
  rt.dispose()
  document.body.replaceChildren()
  restore()
})

const taken = (id: string) => inside(rt).model.notes.get(id) === store.getState().notes.get(id)

describe('edits while the canvas catches up', () => {
  it('an editor opened on a note not yet taken starts from the restored note', () => {
    const [x] = far as [string]
    store.replace(restored(base, { [x]: { text: 'restored words' } }), 'all')
    expect(taken(x)).toBe(false)
    expect(rt.startEditing(x)).toBe(true)
    expect(taken(x)).toBe(true)
    // What the editor is seeded from: the notes drawn.
    expect(rt.view.getState().drawn?.get(x)?.text).toBe('restored words')
    rt.stopEditing(x)
    expect(store.getState().notes.get(x)?.text).toBe('restored words')
  })

  it('closing the editor never deletes a restored note that only looked empty', () => {
    const [x] = far as [string]
    store.commit([{ op: 'note.update', id: x, set: { text: '' } }])
    store.replace(restored(store.getState(), { [x]: { text: 'kept' } }), 'all')
    expect(rt.startEditing(x)).toBe(true)
    rt.stopEditing(x)
    expect(store.getState().notes.get(x)?.text).toBe('kept')
  })

  it('a drag of a note not yet taken moves it from its restored place', () => {
    const [x] = far as [string]
    const was = base.notes.get(x) as Note
    store.replace(restored(base, { [x]: { x: was.x + 500 } }), 'all')
    expect(taken(x)).toBe(false)
    const el = noteEl(rt, x)
    el.dispatchEvent(pointer('pointerdown', 400, 300))
    el.dispatchEvent(pointer('pointermove', 460, 340))
    el.dispatchEvent(pointer('pointerup', 460, 340))
    expect(store.getState().notes.get(x)?.x).toBe(was.x + 500 + 60)
    expect(store.getState().notes.get(x)?.y).toBe(was.y + 40)
  })

  it('a nudge of a selected note not yet taken moves it from its restored place', () => {
    const [x] = far as [string]
    const was = base.notes.get(x) as Note
    rt.selectNote(x)
    store.replace(restored(base, { [x]: { x: was.x + 500 } }), 'all')
    expect(taken(x)).toBe(false)
    inside(rt).nudgeSelection('right', 10)
    expect(store.getState().notes.get(x)?.x).toBe(was.x + 510)
  })

  it('a search jump or Bring in to a note not yet taken finds it where the store has it', () => {
    const [x, seed] = far as [string, string]
    const was = base.notes.get(x) as Note
    const added: Note = { ...was, id: `${x.slice(0, -4)}ZZZZ`, x: was.x + 9000 }
    const s = restored(base, { [x]: { x: was.x + 5000 } })
    store.replace(
      stateFromRecords(s.board, [...s.notes.values(), added, ...s.yarns.values()]),
      'all',
    )
    expect(taken(x)).toBe(false)
    expect(inside(rt).model.notes.has(added.id)).toBe(false)
    // The palette's jump: the camera goes to the note as the store has it.
    expect(rt.focusNote(added.id, 1)).toBe(true)
    const c = rt.camera.get()
    expect(c.x + rt.viewport.width / 2).toBeCloseTo(added.x + added.w / 2)
    expect(rt.focusNote(x, 1)).toBe(true)
    expect(rt.camera.get().x + rt.viewport.width / 2).toBeCloseTo(was.x + 5000 + was.w / 2)
    // Bring in… of a note the canvas has not taken yet.
    rt.setFocus({ seeds: [seed], depth: 1, include: [] })
    rt.setFocus({ seeds: [seed], depth: 1, include: [added.id] })
    expect(rt.focusState?.include).toEqual([added.id])
  })

  it('a press on a note the restore removed: it goes, nothing throws, nothing is committed', () => {
    const [x] = far as [string]
    store.replace(restored(base, { [x]: null }), 'all')
    expect(inside(rt).model.notes.has(x)).toBe(true)
    const commits = store.commits
    const el = noteEl(rt, x)
    expect(() => {
      el.dispatchEvent(pointer('pointerdown', 400, 300))
      el.dispatchEvent(pointer('pointermove', 460, 340))
      el.dispatchEvent(pointer('pointerup', 460, 340))
    }).not.toThrow()
    expect(inside(rt).model.notes.has(x)).toBe(false)
    expect(rt.view.getState().drawn?.has(x)).toBe(false)
    expect(store.commits).toBe(commits)
  })

  it('⌘A selects every note the store has, not only those drawn so far', () => {
    const [gone, x] = far as [string, string]
    const was = base.notes.get(x) as Note
    const added: Note = { ...was, id: `${x.slice(0, -4)}ZZZZ`, x: was.x + 9000 }
    const s = restored(base, { [gone]: null })
    store.replace(
      stateFromRecords(s.board, [...s.notes.values(), added, ...s.yarns.values()]),
      'all',
    )
    expect(inside(rt).model.notes.has(added.id)).toBe(false)
    expect(inside(rt).model.notes.has(gone)).toBe(true)
    rt.selectAll()
    expect(inside(rt).catching).not.toBeNull()
    expect(rt.selection.size).toBe(store.getState().notes.size)
    expect(rt.selection.has(added.id)).toBe(true)
    expect(rt.selection.has(gone)).toBe(false)
  })

  it('a gesture on a pin takes its note’s threads first; the thread drawn is the store’s', () => {
    const thread = [...base.yarns.values()].find((y) => y.noteIds.every((id) => far.includes(id)))
    const y = thread ?? ([...base.yarns.values()].at(-1) as Yarn)
    const [first] = y.noteIds as [string]
    const s = restored(base)
    const next = stateFromRecords(s.board, [
      ...s.assets.values(),
      ...s.notes.values(),
      ...[...s.yarns.values()].map((t) =>
        t.id === y.id ? ({ ...t, noteIds: [...t.noteIds].reverse() } as Yarn) : t,
      ),
    ])
    store.replace(next, 'all')
    expect(rt.drawnYarn(y.id)?.noteIds).toEqual(y.noteIds)
    expect(rt.takeBeforeGesture([first])).toBe(true)
    expect(rt.drawnYarn(y.id)?.noteIds).toEqual([...y.noteIds].reverse())
    // Taken already: nothing changes the second time.
    expect(rt.takeBeforeGesture([first])).toBe(false)
  })
})

describe('a gesture on a thread while the canvas catches up (the real capture stage)', () => {
  it('pulling the drawn end pin of a thread the restore reversed extends it at that end', async () => {
    const y = [...base.yarns.values()].find((t) => t.noteIds.length >= 3) as Yarn
    const ends = y.noteIds as string[]
    const pulled = ends[0] as string
    const target = ids.find((id) => !ends.includes(id)) as string
    const n = base.notes.get(pulled) as Note
    rt.camera.set({ x: n.x - 300, y: n.y - 300, zoom: 1 })
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 17))
    rt.selectYarn(y.id)
    const at = rt.attachScreen(y.id, 0, 'a')
    if (at === undefined) throw new Error('no end pin drawn')
    const s = restored(base)
    store.replace(
      stateFromRecords(s.board, [
        ...s.assets.values(),
        ...s.notes.values(),
        ...[...s.yarns.values()].map((t) =>
          t.id === y.id ? ({ ...t, noteIds: [...t.noteIds].reverse() } as Yarn) : t,
        ),
      ]),
      'all',
    )
    expect(rt.drawnYarn(y.id)?.noteIds).toEqual(ends)
    const to = rt.pinScreen(target)
    if (to === undefined) throw new Error('no target pin')
    rt.els.root.dispatchEvent(pointer('pointerdown', at.x, at.y))
    rt.els.root.dispatchEvent(pointer('pointermove', to.x, to.y))
    rt.els.root.dispatchEvent(pointer('pointerup', to.x, to.y))
    // Pulled from the pin drawn at its first note, which the restore made its last.
    expect(store.getState().yarns.get(y.id)?.noteIds).toEqual([...ends].reverse().concat(target))
  })
})

describe('what is caught up first', () => {
  it('a thread in view that changed is taken with the view, though its notes did not', () => {
    const v = rt.camera.get()
    const view = { x: v.x, y: v.y, w: 1200, h: 800 }
    const inView = new Set(
      ids.filter((id) => {
        const n = base.notes.get(id) as Note
        return (
          n.x < view.x + view.w && n.x + n.w > view.x && n.y < view.y + view.h && n.y + n.h > view.y
        )
      }),
    )
    const thread = [...base.yarns.values()].find((y) => y.noteIds.every((id) => inView.has(id)))
    if (thread === undefined) throw new Error('no thread in view')
    // The same notes (the very records), the thread in another colour.
    const yarns = [...base.yarns.values()].map((y) =>
      y.id === thread.id ? ({ ...y, color: y.color === 'ink' ? 'apricot' : 'ink' } as Yarn) : y,
    )
    const next = stateFromRecords(base.board, [
      ...base.assets.values(),
      ...base.notes.values(),
      ...yarns,
    ])
    store.replace(next, 'all')
    const c = inside(rt).catching
    if (c === null) throw new Error('not catching up')
    for (let i = 0; i < 100 && c.first.length > 0; i++) inside(rt).catchUpSlice(0)
    expect(inside(rt).model.yarns.get(thread.id)).toBe(next.yarns.get(thread.id))
  })

  it('where the camera goes while it catches up, that view is caught up next', async () => {
    const moved: Record<string, Partial<Note>> = {}
    for (const id of ids) moved[id] = { x: (base.notes.get(id) as Note).x + 3 }
    store.replace(restored(base, moved), 'all')
    // Two steps where the camera was, then the camera goes to the far corner and stays.
    inside(rt).catchUpSlice(0)
    inside(rt).catchUpSlice(0)
    const n = base.notes.get(far[0] as string) as Note
    rt.camera.set({ x: n.x - 100, y: n.y - 100, zoom: 1 })
    // Once it has settled.
    for (let i = 0; i < 40 && rt.camera.moving; i++) await new Promise((r) => setTimeout(r, 20))
    expect(rt.camera.moving).toBe(false)
    const c = inside(rt).catching
    if (c === null) throw new Error('not catching up')
    for (let i = 0; i < 30; i++) inside(rt).catchUpSlice(0)
    expect(c.walked).toBe(false)
    expect(taken(far[0] as string)).toBe(true)
  })
})

describe('the store’s own board while the canvas catches up', () => {
  it('a gesture’s topologyOf(store board) is made from its last, never built anew per edit', () => {
    store.replace(restored(base), 'all')
    // Its first sight of the restored board may build it, once.
    topologyOf(store.getState())
    const built = topologyStats.built
    for (let i = 0; i < 12; i++) {
      for (let k = 0; k < 6; k++) inside(rt).catchUpSlice(0)
      const id = far[i] as string
      store.commit([{ op: 'note.update', id, set: { text: `edit ${i}` } }])
      topologyOf(store.getState())
    }
    expect(inside(rt).catching).not.toBeNull()
    expect(topologyStats.built - built).toBe(0)
  })
})

describe('an opening’s told slices', () => {
  /** `s` with `n` new notes far from the view, as an opening's slice brings them. */
  const slice = (s: BoardState, n: number, from: number): { next: BoardState; added: Note[] } => {
    const added = Array.from({ length: n }, (_, i) => ({
      ...(base.notes.get(ids[0] as string) as Note),
      id: `note_${String(from + i).padStart(26, '0')}`,
      x: 900_000 + (from + i) * 400,
      y: 900_000,
    }))
    return { next: stateFromRecords(s.board, [...s.notes.values(), ...added]), added }
  }

  it('a told slice of 150 notes is caught up a step at a time, never taken in the task that tells it', () => {
    const { next, added } = slice(store.getState(), 150, 1)
    store.replace(next, {
      notes: new Set(added.map((n) => n.id)),
      yarns: new Set<string>(),
      assets: new Set<string>(),
      books: new Set<string>(),
      blocks: new Set<string>(),
    })
    // Not taken yet: the catch-up takes it in its steps.
    expect(inside(rt).catching).not.toBeNull()
    expect(taken((added[0] as Note).id)).toBe(false)
    for (let i = 0; i < 40 && inside(rt).catching !== null; i++) inside(rt).catchUpSlice(0)
    expect(inside(rt).catching).toBeNull()
    expect(added.every((n) => taken(n.id))).toBe(true)
  })

  it('a told slice of a few notes, and any edit, is taken at once', () => {
    const { next, added } = slice(store.getState(), 8, 500)
    store.replace(next, {
      notes: new Set(added.map((n) => n.id)),
      yarns: new Set<string>(),
      assets: new Set<string>(),
      books: new Set<string>(),
      blocks: new Set<string>(),
    })
    expect(inside(rt).catching).toBeNull()
    expect(added.every((n) => taken(n.id))).toBe(true)
    // An edit of 150 notes (never told) is taken at once.
    const moved = ids.filter((id) => base.notes.get(id)?.image == null).slice(0, 150)
    store.commit(moved.map((id) => ({ op: 'note.update' as const, id, set: { x: 1 } })))
    expect(inside(rt).catching).toBeNull()
    expect(moved.every((id) => taken(id))).toBe(true)
  })
})
