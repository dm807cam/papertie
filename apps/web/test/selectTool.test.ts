import { applyBatch, type BoardState, type ClientOp, LIMITS, type Note } from '@papertie/core'
import { TransientOverrides } from '../src/canvas/transient'
import type { Point } from '../src/canvas/types'
import { DEMO_IDS, demoBoard } from '../src/dev/demoBoard'
import type { ResizeHandle } from '../src/interactions/drag'
import {
  createSelectTool,
  type DragWatch,
  type ToolPointer,
  toolTarget,
} from '../src/interactions/selectTool'

const NOW = '2026-10-27T00:00:00.000Z'
const LATER = '2026-10-27T01:00:00.000Z'

/** The z a dragged demo note is lifted to: one above the board's top note. */
const LIFTED = Math.max(...[...demoBoard(NOW).notes.values()].map((n) => n.z)) + 1

function setup(
  zoom = 1,
  measured: ReadonlyMap<string, number> = new Map(),
  prep: readonly ClientOp[] = [],
) {
  let state: BoardState = applyBatch(demoBoard(NOW), prep, { now: NOW })
  const overrides = new TransientOverrides()
  const commits: ClientOp[][] = []
  const selected: Array<string | null> = []
  const tool = createSelectTool({
    getNote: (id) => state.notes.get(id),
    overrides,
    commit: (ops) => {
      commits.push([...ops])
      state = applyBatch(state, ops, { now: LATER })
    },
    select: (id) => selected.push(id),
    selection: () => new Set(),
    selectNotes: () => {},
    topZ: () => Math.max(...[...state.notes.values()].map((n) => n.z)),
    zoom: () => zoom,
    aspectOf: (n) => (n.image ? 1.5 : undefined),
    heightOf: (n) => Math.max(n.h, measured.get(n.id) ?? 0),
  })
  /** A pointer at viewport `screen`, with the camera at the origin. */
  const at = (
    screen: Point,
    target: ToolPointer['target'] = { noteId: DEMO_IDS.hub },
    extra: Partial<ToolPointer> = {},
  ): ToolPointer => ({
    screen,
    world: { x: screen.x / zoom, y: screen.y / zoom },
    button: 0,
    shiftKey: false,
    target,
    ...extra,
  })
  const note = (id: string = DEMO_IDS.hub) => state.notes.get(id) as Note
  return { tool, overrides, commits, selected, at, note }
}

const hubTarget = (handle?: ResizeHandle) => ({ noteId: DEMO_IDS.hub, handle })

describe('createSelectTool', () => {
  it('a 2 px press-and-release selects without committing', () => {
    const { tool, overrides, commits, selected, at } = setup()
    tool.pointerDown(at({ x: 100, y: 100 }))
    tool.pointerMove(at({ x: 101, y: 101 }))
    tool.pointerMove(at({ x: 102, y: 100 }))
    tool.pointerUp(at({ x: 102, y: 100 }))
    expect(selected).toEqual([DEMO_IDS.hub])
    expect(overrides.ids()).toEqual([])
    expect(overrides.version).toBe(0)
    expect(commits).toEqual([])
  })

  it('a press on cork clears the selection', () => {
    const { tool, commits, selected, at } = setup()
    tool.pointerDown(at({ x: 5, y: 5 }, {}))
    tool.pointerMove(at({ x: 50, y: 5 }, {}))
    tool.pointerUp(at({ x: 50, y: 5 }, {}))
    expect(selected).toEqual([null])
    expect(commits).toEqual([])
  })

  it('ignores buttons other than the primary one', () => {
    const { tool, commits, selected, at } = setup()
    tool.pointerDown(at({ x: 0, y: 0 }, hubTarget(), { button: 2 }))
    tool.pointerMove(at({ x: 50, y: 0 }))
    tool.pointerUp(at({ x: 50, y: 0 }))
    expect(selected).toEqual([])
    expect(commits).toEqual([])
  })

  it('a 10 px drag sets overrides, then one commit with one note.update at pointer-up after 30 moves', () => {
    const { tool, overrides, commits, at, note } = setup()
    const start = note()
    tool.pointerDown(at({ x: 1100, y: 600 }))
    tool.pointerMove(at({ x: 1110, y: 600 }))
    expect(overrides.get(start.id)).toMatchObject({ x: start.x + 10, y: start.y })
    for (let i = 1; i <= 30; i++) tool.pointerMove(at({ x: 1110 + i, y: 600 + i }))
    expect(commits).toEqual([])
    expect(note().x).toBe(start.x)
    expect(overrides.get(start.id)).toEqual({ x: start.x + 40, y: start.y + 30, z: LIFTED })
    tool.pointerUp(at({ x: 1140, y: 630 }))
    expect(commits).toEqual([
      [{ op: 'note.update', id: start.id, set: { x: start.x + 40, y: start.y + 30, z: LIFTED } }],
    ])
    expect(overrides.ids()).toEqual([])
    expect(note()).toMatchObject({ x: start.x + 40, y: start.y + 30, z: LIFTED })
    // Moves and releases after the gesture do nothing.
    tool.pointerMove(at({ x: 0, y: 0 }))
    tool.pointerUp(at({ x: 0, y: 0 }))
    expect(commits).toHaveLength(1)
  })

  it('drags in world units: at zoom 0.5, 200 px moves 400', () => {
    const { tool, commits, at, note } = setup(0.5)
    const x0 = note().x
    tool.pointerDown(at({ x: 600, y: 330 }))
    for (let i = 1; i <= 20; i++) tool.pointerMove(at({ x: 600 + 10 * i, y: 330 }))
    tool.pointerUp(at({ x: 800, y: 330 }))
    expect(commits).toHaveLength(1)
    expect(note().x).toBe(x0 + 400)
  })

  it('a drag that returns to its start commits nothing', () => {
    const { tool, overrides, commits, at } = setup()
    tool.pointerDown(at({ x: 100, y: 100 }))
    tool.pointerMove(at({ x: 140, y: 100 }))
    tool.pointerUp(at({ x: 100, y: 100 }))
    expect(commits).toEqual([])
    expect(overrides.ids()).toEqual([])
  })

  it.each(['cancel', 'Escape', 'pointercancel'] as const)(
    '%s mid-drag clears overrides and never commits',
    (how) => {
      const { tool, overrides, commits, at } = setup()
      tool.pointerDown(at({ x: 100, y: 100 }))
      for (let i = 1; i <= 10; i++) tool.pointerMove(at({ x: 100 + 5 * i, y: 100 }))
      expect(overrides.ids()).toEqual([DEMO_IDS.hub])
      // The runtime maps pointercancel and lostpointercapture to cancel(); Esc goes through key().
      if (how === 'Escape') expect(tool.key({ key: 'Escape' })).toBe(true)
      else tool.cancel()
      expect(overrides.ids()).toEqual([])
      tool.pointerMove(at({ x: 300, y: 100 }))
      tool.pointerUp(at({ x: 300, y: 100 }))
      expect(overrides.ids()).toEqual([])
      expect(commits).toEqual([])
    },
  )

  it('Esc while idle is not handled; other keys never are', () => {
    const { tool, at } = setup()
    expect(tool.key({ key: 'Escape' })).toBe(false)
    tool.pointerDown(at({ x: 100, y: 100 }))
    tool.pointerMove(at({ x: 150, y: 100 }))
    expect(tool.key({ key: 'a' })).toBe(false)
  })

  it('cancel while pressing returns to idle, so the release commits nothing', () => {
    const { tool, overrides, commits, at } = setup()
    tool.pointerDown(at({ x: 100, y: 100 }))
    tool.cancel()
    tool.pointerMove(at({ x: 200, y: 100 }))
    tool.pointerUp(at({ x: 200, y: 100 }))
    expect(overrides.version).toBe(0)
    expect(commits).toEqual([])
  })

  it('dragging the se handle resizes through overrides and commits one w/h update', () => {
    const { tool, overrides, commits, at, note } = setup()
    const n0 = note()
    tool.pointerDown(at({ x: 1320, y: 760 }, hubTarget('se')))
    for (let i = 1; i <= 10; i++) tool.pointerMove(at({ x: 1320 + 6 * i, y: 760 + 4 * i }, {}))
    expect(overrides.get(n0.id)).toEqual({ x: n0.x, y: n0.y, w: n0.w + 60, h: n0.h + 40 })
    expect(commits).toEqual([])
    tool.pointerUp(at({ x: 1380, y: 800 }, {}))
    expect(commits).toEqual([
      [{ op: 'note.update', id: n0.id, set: { w: n0.w + 60, h: n0.h + 40 } }],
    ])
    expect(overrides.ids()).toEqual([])
  })

  it('image notes keep their aspect while resizing from a corner', () => {
    const { tool, commits, at, note } = setup()
    const target = { noteId: DEMO_IDS.print, handle: 'se' as const }
    tool.pointerDown(at({ x: 820, y: 370 }, target))
    tool.pointerMove(at({ x: 910, y: 380 }, target))
    tool.pointerUp(at({ x: 910, y: 380 }, target))
    expect(commits).toHaveLength(1)
    const n = note(DEMO_IDS.print)
    expect(Math.abs(n.w / n.h - 1.5)).toBeLessThan(0.02)
  })

  describe('a note drawn taller than its h (h 100, measured 136)', () => {
    const shrunk: ClientOp[] = [{ op: 'note.update', id: DEMO_IDS.hub, set: { h: 100 } }]
    const tall = (measured = 136) => setup(1, new Map([[DEMO_IDS.hub, measured]]), shrunk)

    it('the s handle +20 gives h 156: the resize starts from the drawn height', () => {
      const { tool, overrides, commits, at, note } = tall()
      const n0 = note()
      expect(n0.h).toBe(100)
      tool.pointerDown(at({ x: 0, y: 0 }, hubTarget('s')))
      tool.pointerMove(at({ x: 0, y: 4 }))
      // The first move already grows the drawn note: no dead zone.
      expect(overrides.get(n0.id)).toEqual({ x: n0.x, y: n0.y, w: n0.w, h: 140 })
      tool.pointerMove(at({ x: 0, y: 20 }))
      tool.pointerUp(at({ x: 0, y: 20 }))
      expect(commits).toEqual([[{ op: 'note.update', id: n0.id, set: { h: 156 } }]])
      expect(note().h).toBe(156)
    })

    it('the e handle changes only w: no h op, and the override keeps the stored h', () => {
      const { tool, overrides, commits, at, note } = tall()
      const n0 = note()
      tool.pointerDown(at({ x: 0, y: 0 }, hubTarget('e')))
      tool.pointerMove(at({ x: 30, y: 9 }))
      expect(overrides.get(n0.id)).toEqual({ x: n0.x, y: n0.y, w: n0.w + 30, h: 100 })
      tool.pointerUp(at({ x: 30, y: 9 }))
      expect(commits).toEqual([[{ op: 'note.update', id: n0.id, set: { w: n0.w + 30 } }]])
    })

    it('an s drag out and back commits nothing; a corner w-only change sets no h', () => {
      const t = tall()
      t.tool.pointerDown(t.at({ x: 0, y: 0 }, hubTarget('s')))
      t.tool.pointerMove(t.at({ x: 0, y: 50 }))
      t.tool.pointerUp(t.at({ x: 0, y: 0 }))
      expect(t.commits).toEqual([])
      const n0 = t.note()
      t.tool.pointerDown(t.at({ x: 0, y: 0 }, hubTarget('se')))
      t.tool.pointerMove(t.at({ x: 25, y: 0 }))
      t.tool.pointerUp(t.at({ x: 25, y: 0 }))
      expect(t.commits).toEqual([[{ op: 'note.update', id: n0.id, set: { w: n0.w + 25 } }]])
    })

    it('the nw handle keeps the drawn bottom edge fixed', () => {
      const { tool, commits, at, note } = tall()
      const n0 = note()
      tool.pointerDown(at({ x: 0, y: 0 }, hubTarget('nw')))
      tool.pointerMove(at({ x: -10, y: -10 }))
      tool.pointerUp(at({ x: -10, y: -10 }))
      expect(commits).toEqual([
        [
          {
            op: 'note.update',
            id: n0.id,
            set: { x: n0.x - 10, y: n0.y - 10, w: n0.w + 10, h: 146 },
          },
        ],
      ])
      expect(note().y + note().h).toBe(n0.y + 136)
    })

    it('a drawn height beyond noteMaxH starts from noteMaxH and still applies', () => {
      const { tool, commits, at, note } = tall(LIMITS.noteMaxH + 500)
      const n0 = note()
      tool.pointerDown(at({ x: 0, y: 0 }, hubTarget('e')))
      tool.pointerMove(at({ x: 10, y: 0 }))
      tool.pointerUp(at({ x: 10, y: 0 }))
      expect(commits).toEqual([[{ op: 'note.update', id: n0.id, set: { w: n0.w + 10 } }]])
      tool.pointerDown(at({ x: 0, y: 0 }, hubTarget('s')))
      tool.pointerMove(at({ x: 0, y: 40 }))
      tool.pointerUp(at({ x: 0, y: 40 }))
      // Already drawn at the limit: growing it changes nothing, so nothing commits.
      expect(commits).toHaveLength(1)
      expect(note().h).toBe(100)
      tool.pointerDown(at({ x: 0, y: 0 }, hubTarget('s')))
      tool.pointerMove(at({ x: 0, y: -40 }))
      tool.pointerUp(at({ x: 0, y: -40 }))
      // setup's commit runs applyBatch, so the op passes the LIMITS checks too.
      expect(note().h).toBe(LIMITS.noteMaxH - 40)
    })

    it('an image note resized from a corner by width ignores the drawn height', () => {
      const target = { noteId: DEMO_IDS.print, handle: 'se' as const }
      const run = (measured: number) => {
        const t = setup(1, new Map([[DEMO_IDS.print, measured]]))
        t.tool.pointerDown(t.at({ x: 0, y: 0 }, target))
        t.tool.pointerMove(t.at({ x: 30, y: 0 }, target))
        t.tool.pointerUp(t.at({ x: 30, y: 0 }, target))
        return t.note(DEMO_IDS.print)
      }
      const plain = run(0)
      expect(run(plain.h + 300)).toEqual(plain)
      expect(Math.abs(plain.w / plain.h - 1.5)).toBeLessThan(0.02)
    })
  })

  it('a resize that ends where it began commits nothing', () => {
    const { tool, commits, at, note } = setup()
    const n0 = note()
    // Out and back: the release lands on the original rect.
    tool.pointerDown(at({ x: 0, y: 0 }, hubTarget('se')))
    tool.pointerMove(at({ x: -n0.w * 10, y: -n0.h * 10 }))
    tool.pointerMove(at({ x: 0, y: 0 }))
    tool.pointerUp(at({ x: 0, y: 0 }))
    expect(commits).toEqual([])
  })

  it('clears the overrides even when the commit throws', () => {
    const overrides = new TransientOverrides()
    const state = demoBoard(NOW)
    const tool = createSelectTool({
      getNote: (id) => state.notes.get(id),
      overrides,
      commit: () => {
        throw new Error('rejected')
      },
      select: () => {},
      selection: () => new Set(),
      selectNotes: () => {},
      topZ: () => 14,
      zoom: () => 1,
      aspectOf: () => undefined,
    })
    const p = (x: number): ToolPointer => ({
      screen: { x, y: 0 },
      world: { x, y: 0 },
      button: 0,
      shiftKey: false,
      target: { noteId: DEMO_IDS.hub },
    })
    tool.pointerDown(p(0))
    tool.pointerMove(p(50))
    expect(() => tool.pointerUp(p(50))).toThrow('rejected')
    expect(overrides.ids()).toEqual([])
    tool.pointerMove(p(80))
    expect(overrides.ids()).toEqual([])
  })
})

describe('createSelectTool with a drag watch (merging)', () => {
  function watched(take: boolean, members: ReadonlySet<string> = new Set()) {
    const state = demoBoard(NOW)
    const overrides = new TransientOverrides()
    const commits: ClientOp[][] = []
    const seen: string[] = []
    const watch: DragWatch = {
      move: (n) => seen.push(`move ${n.id} ${n.x},${n.y}`),
      release: (n) => {
        seen.push(`release ${n.id} ${n.x},${n.y} overridden:${overrides.has(n.id)}`)
        return take
      },
      end: () => seen.push('end'),
    }
    const tool = createSelectTool({
      getNote: (id) => state.notes.get(id),
      overrides,
      commit: (ops) => {
        commits.push([...ops])
      },
      select: () => {},
      selection: () => members,
      selectNotes: () => {},
      topZ: () => LIFTED - 1,
      zoom: () => 1,
      aspectOf: () => undefined,
      watch,
    })
    const p = (x: number, target: ToolPointer['target'] = hubTarget()): ToolPointer => ({
      screen: { x, y: 0 },
      world: { x, y: 0 },
      button: 0,
      shiftKey: false,
      target,
    })
    const hub = state.notes.get(DEMO_IDS.hub) as Note
    return { tool, overrides, commits, seen, p, hub }
  }

  it('tells the watch where a single dragged note is, and lets it take the release', () => {
    const { tool, overrides, commits, seen, p, hub } = watched(true)
    tool.pointerDown(p(0))
    tool.pointerMove(p(10))
    tool.pointerMove(p(20))
    tool.pointerUp(p(25))
    expect(seen).toEqual([
      `move ${hub.id} ${hub.x + 10},${hub.y}`,
      `move ${hub.id} ${hub.x + 20},${hub.y}`,
      `move ${hub.id} ${hub.x + 25},${hub.y}`,
      `release ${hub.id} ${hub.x + 25},${hub.y} overridden:true`,
      'end',
    ])
    // The merge committed the batch: the move is not committed, and the drag's override goes.
    expect(commits).toEqual([])
    expect(overrides.size).toBe(0)
    expect(tool.holds?.(hub.id)).toBe(false)
  })

  it('a release the watch declines drops the note as usual, then ends the watch', () => {
    const { tool, commits, seen, p, hub } = watched(false)
    tool.pointerDown(p(0))
    tool.pointerMove(p(10))
    tool.pointerUp(p(10))
    expect(commits).toEqual([
      [{ op: 'note.update', id: hub.id, set: { x: hub.x + 10, y: hub.y, z: LIFTED } }],
    ])
    expect(seen.slice(-2)).toEqual([
      `release ${hub.id} ${hub.x + 10},${hub.y} overridden:true`,
      'end',
    ])
  })

  it.each(['cancel', 'Escape'] as const)('%s ends the watch without a release', (how) => {
    const { tool, seen, p } = watched(true)
    tool.pointerDown(p(0))
    tool.pointerMove(p(10))
    if (how === 'Escape') tool.key({ key: 'Escape' })
    else tool.cancel()
    expect(seen.at(-1)).toBe('end')
    expect(seen.some((s) => s.startsWith('release'))).toBe(false)
  })

  it('a release that throws still ends the drag', () => {
    const { overrides, p, hub } = watched(true)
    const thrower = createSelectTool({
      getNote: () => hub,
      overrides,
      commit: () => {},
      select: () => {},
      selection: () => new Set(),
      selectNotes: () => {},
      topZ: () => LIFTED - 1,
      zoom: () => 1,
      aspectOf: () => undefined,
      watch: {
        move: () => {},
        release: () => {
          throw new Error('bug')
        },
        end: () => {},
      },
    })
    thrower.pointerDown(p(0))
    thrower.pointerMove(p(10))
    expect(() => thrower.pointerUp(p(10))).toThrow('bug')
    expect(overrides.size).toBe(0)
    expect(thrower.holds?.(hub.id)).toBe(false)
  })

  it('group drags and resizes never reach the watch', () => {
    const group = watched(true, new Set([DEMO_IDS.hub, DEMO_IDS.overlap]))
    group.tool.pointerDown(group.p(0))
    group.tool.pointerMove(group.p(10))
    group.tool.pointerUp(group.p(10))
    expect(group.seen.filter((s) => s !== 'end')).toEqual([])
    expect(group.commits).toHaveLength(1)

    const resize = watched(true)
    resize.tool.pointerDown(resize.p(0, hubTarget('se')))
    resize.tool.pointerMove(resize.p(10, hubTarget('se')))
    resize.tool.pointerUp(resize.p(10, hubTarget('se')))
    expect(resize.seen.filter((s) => s !== 'end')).toEqual([])
    expect(resize.commits).toHaveLength(1)
  })
})

describe('toolTarget', () => {
  /** A stand-in element: `closest` answers from a selector → dataset table. */
  interface Fake {
    dataset?: Record<string, string>
    closest(sel: string): Fake | null
  }
  const fake = (hits: Record<string, Record<string, string>>): Fake => ({
    closest: (sel) => {
      const dataset = hits[sel]
      return dataset ? { ...fake(hits), dataset } : null
    },
  })
  const el = (hits: Record<string, Record<string, string>>) => fake(hits) as unknown as EventTarget

  it('resolves handles (with their note), notes and cork', () => {
    const frame = { '[data-note-id]': { noteId: DEMO_IDS.hub } }
    expect(toolTarget(el({ '[data-handle]': { handle: 'se' }, ...frame }))).toEqual({
      noteId: DEMO_IDS.hub,
      handle: 'se',
    })
    expect(toolTarget(el({ 'article[data-note-id]': { noteId: DEMO_IDS.knot } }))).toEqual({
      noteId: DEMO_IDS.knot,
    })
    expect(toolTarget(el({ '[data-handle]': { handle: 'zz' } }))).toEqual({})
    expect(toolTarget(el({}))).toEqual({})
    expect(toolTarget(null)).toEqual({})
  })
})
