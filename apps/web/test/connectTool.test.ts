import { isId, type Note, YarnRecordSchema } from '@papertie/core'
import { boardFrames, createAttach, topologyOf } from '../src/canvas/attach'
import { noteBounds, pinPosition } from '../src/canvas/geometry'
import { type Point, rectContainsPoint } from '../src/canvas/types'
import { YarnMotion } from '../src/canvas/YarnMotion'
import { DEMO_IDS, demoBoard } from '../src/dev/demoBoard'
import { createConnectTool, type LiveThread } from '../src/interactions/connectTool'
import type { ToolPointer } from '../src/interactions/selectTool'
import { createBoardStore } from '../src/store/boardStore'
import { createYarnFlows } from '../src/yarn/yarnFlows'

const NOW = '2026-10-27T00:00:00.000Z'
const FROM = DEMO_IDS.knot

function setup() {
  const store = createBoardStore(demoBoard(NOW), undefined, () => NOW)
  const pinOf = (id: string) => {
    const n = store.getState().notes.get(id)
    return n && pinPosition(n)
  }
  const attach = () => {
    const s = store.getState()
    return createAttach(topologyOf(s), boardFrames(s.notes, { rotation: false }))
  }
  const flows = createYarnFlows(store)
  const noteAt = (w: Point) => {
    let top: Note | undefined
    for (const n of store.getState().notes.values()) {
      if (rectContainsPoint(noteBounds(n), w) && (top === undefined || n.z > top.z)) top = n
    }
    return top?.id
  }
  const live: Array<LiveThread | null> = []
  const missed = { count: 0 }
  const landingOf = (id: string) => attach().preview(id, FROM)
  const tool = createConnectTool({
    fromNoteId: FROM,
    pinOf,
    noteAt,
    landingOf,
    flows,
    color: () => 'apricot',
    threadEnd: (id, end) => {
      const ids = store.getState().yarns.get(id)?.noteIds
      return end === 'first' ? ids?.[0] : ids?.at(-1)
    },
    setLive: (l) => live.push(l),
    onNoConnect: () => missed.count++,
  })
  const at = (world: Point): ToolPointer => ({
    screen: world,
    world,
    button: 0,
    shiftKey: false,
    target: {},
  })
  const centre = (id: string) => {
    const n = store.getState().notes.get(id) as Note
    return { x: n.x + n.w / 2, y: n.y + n.h / 2 }
  }
  return { store, tool, live, at, centre, pinOf, landingOf, missed }
}

describe('createConnectTool', () => {
  it('connect: drop on another note creates one valid 2-note yarn', () => {
    const { store, tool, live, at, centre, pinOf, landingOf, missed } = setup()
    const from = pinOf(FROM) as Point
    const before = new Set(store.getState().yarns.keys())
    tool.pointerDown(at(from))
    const target = centre(DEMO_IDS.print)
    const mid = { x: 1400, y: 400 }
    tool.pointerMove(at(mid))
    tool.pointerMove(at(target))
    // It leaves from FROM's hanging pin, beneath FROM's own paper.
    expect(live.at(-2)).toEqual({ from, under: FROM, to: mid, color: 'apricot' })
    // Over a note, the thread's end lands on the edge pin it would get there.
    const landing = landingOf(DEMO_IDS.print) as Point
    expect(landing).not.toEqual(target)
    expect(live.at(-1)).toEqual({
      from,
      under: FROM,
      to: landing,
      targetNoteId: DEMO_IDS.print,
      color: 'apricot',
    })
    expect(store.commits).toBe(0)
    tool.pointerUp(at(target))
    expect(store.commits).toBe(1)
    const added = [...store.getState().yarns.values()].filter((y) => !before.has(y.id))
    expect(added).toHaveLength(1)
    const yarn = added[0]
    expect(YarnRecordSchema.parse(yarn)).toEqual(yarn)
    expect(isId(yarn?.id, 'yarn')).toBe(true)
    expect(yarn?.noteIds).toEqual([FROM, DEMO_IDS.print])
    expect(live.at(-1)).toBeNull()
    expect(missed.count).toBe(0)
  })

  it('connect: drop on cork, drop on the source note and Esc commit nothing', () => {
    const cork = setup()
    cork.tool.pointerDown(cork.at(cork.pinOf(FROM) as Point))
    cork.tool.pointerMove(cork.at({ x: 1400, y: 900 }))
    expect(cork.live.at(-1)?.targetNoteId).toBeUndefined()
    cork.tool.pointerUp(cork.at({ x: 1400, y: 900 }))
    expect(cork.store.commits).toBe(0)
    expect(cork.live.at(-1)).toBeNull()
    expect(cork.missed.count).toBe(1)

    const self = setup()
    self.tool.pointerDown(self.at(self.pinOf(FROM) as Point))
    self.tool.pointerMove(self.at(self.centre(FROM)))
    expect(self.live.at(-1)?.targetNoteId).toBeUndefined()
    self.tool.pointerUp(self.at(self.centre(FROM)))
    expect(self.store.commits).toBe(0)
    expect(self.live.at(-1)).toBeNull()
    expect(self.missed.count).toBe(1)

    const esc = setup()
    esc.tool.pointerDown(esc.at(esc.pinOf(FROM) as Point))
    esc.tool.pointerMove(esc.at(esc.centre(DEMO_IDS.print)))
    expect(esc.tool.key({ key: 'Escape' })).toBe(true)
    expect(esc.live.at(-1)).toBeNull()
    esc.tool.pointerUp(esc.at(esc.centre(DEMO_IDS.print)))
    expect(esc.store.commits).toBe(0)
    expect(esc.tool.key({ key: 'Escape' })).toBe(false)
    // Esc abandons: it is not a drop that connected nothing.
    expect(esc.missed.count).toBe(0)
  })

  it('ignores other buttons and a source note that is gone', () => {
    const { store, tool, live, at, centre } = setup()
    tool.pointerDown({ ...at(centre(FROM)), button: 2 })
    tool.pointerUp(at(centre(DEMO_IDS.print)))
    expect(store.commits).toBe(0)
    expect(live).toEqual([])
    store.commit([{ op: 'note.delete', id: FROM }])
    tool.pointerDown(at({ x: 0, y: 0 }))
    tool.pointerUp(at(centre(DEMO_IDS.print)))
    expect(store.commits).toBe(1)
  })
})

describe('the live thread spring', () => {
  it('starts at rest, lags a moved end, and settles', () => {
    const motion = new YarnMotion(() => false)
    const a = { x: 0, y: 0 }
    motion.setLive(a, a)
    expect(motion.liveSag(a, a)).toEqual(a)
    const b = { x: 500, y: 0 }
    motion.setLive(a, b)
    const rest = { x: 250, y: 40 }
    expect(motion.liveSag(a, b)).toEqual(a)
    expect(motion.step(1 / 60, 16)).toBe(true)
    const lag = motion.liveSag(a, b)
    expect(lag.x).toBeGreaterThan(0)
    expect(lag.x).toBeLessThan(rest.x)
    for (let i = 0; i < 120; i++) motion.step(1 / 60, 32 + i * 16)
    expect(motion.liveSag(a, b)).toEqual(rest)
    expect(motion.step(1 / 60, 3000)).toBe(false)
    motion.clearLive()
    expect(motion.liveSag(a, b)).toEqual(rest)
  })

  it('snaps under reduced motion', () => {
    const motion = new YarnMotion(() => true)
    const a = { x: 0, y: 0 }
    motion.setLive(a, a)
    motion.setLive(a, { x: 500, y: 0 })
    expect(motion.liveSag(a, { x: 500, y: 0 })).toEqual({ x: 250, y: 40 })
    expect(motion.step(1 / 60, 16)).toBe(false)
  })
})
