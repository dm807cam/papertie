import type { BoardState, Note } from '@papertie/core'
import { boardFrames, createAttach, type SegmentRef, topologyOf } from '../src/canvas/attach'
import type { Point } from '../src/canvas/types'
import { YarnMotion } from '../src/canvas/YarnMotion'
import { restSagPoint } from '../src/canvas/yarnGeometry'
import { DEMO_IDS, demoBoard } from '../src/dev/demoBoard'
import { createBoardStore } from '../src/store/boardStore'
import { createYarnFlows } from '../src/yarn/yarnFlows'

const NOW = '2026-10-27T00:00:00.000Z'

function setup(reducedAtStart = false) {
  const store = createBoardStore(demoBoard(NOW), undefined, () => NOW)
  const offsets = new Map<string, Point>()
  /** Segment ends between edge pins, with each note moved by its offset (a drag override). */
  const endsOf = (ref: SegmentRef) => {
    const s = store.getState()
    const effective = (n: Note) => {
      const o = offsets.get(n.id) ?? { x: 0, y: 0 }
      return { ...n, x: n.x + o.x, y: n.y + o.y }
    }
    return createAttach(topologyOf(s), boardFrames(s.notes, { rotation: false, effective })).ends(
      ref,
    )
  }
  const endsOfYarn = (yarnId: string) =>
    (topologyOf(store.getState()).byYarn.get(yarnId) ?? []).flatMap((r) => endsOf(r) ?? [])
  const flags = { reduced: reducedAtStart, wakes: 0 }
  const motion = new YarnMotion(
    () => flags.reduced,
    () => flags.wakes++,
  )
  motion.sync(store.getState(), endsOf)
  store.subscribe((s) => motion.sync(s, endsOf))
  return { store, offsets, endsOf, endsOfYarn, motion, flags }
}

/** The yarn flows with the canvas effects the runtime gives them, on this test's motion. */
function flows(
  store: ReturnType<typeof setup>['store'],
  motion: YarnMotion,
  now: () => number,
  endsOfYarn: (yarnId: string) => Array<{ a: Point; b: Point }>,
) {
  return createYarnFlows(store, {
    drawIn: (id) => motion.startDrawIn(id, now()),
    pulse: (id) => motion.startPulse(id, now()),
    loosen: (yarn) => motion.startLoosen(yarn, endsOfYarn(yarn.id), now()),
  })
}

/** A note on exactly one segment. */
function loneNote(motion: YarnMotion, s: BoardState): string {
  const id = [...s.notes.keys()].find((n) => motion.segmentsOf([n]).length === 1)
  if (id === undefined) throw new Error('no single-segment note')
  return id
}

/** Step at 60 Hz for `ms`; returns the last step's result and the clock. */
function frames(motion: YarnMotion, t0: number, ms: number) {
  let t = t0
  let active = true
  for (let e = 0; e < ms; e += 1000 / 60) {
    t += 1000 / 60
    active = motion.step(1 / 60, t)
  }
  return { active, t }
}

describe('YarnMotion', () => {
  it('sync adds sleeping springs at rest for every segment', () => {
    const { store, motion, endsOf } = setup()
    const s = store.getState()
    expect(motion.segmentsOf([DEMO_IDS.hub])).toHaveLength(4)
    expect(motion.awakeCount).toBe(0)
    expect(motion.activeAnimations).toBe(0)
    expect(motion.step(1 / 60, 16)).toBe(false)
    const yarn = s.yarns.get(DEMO_IDS.threeNote)
    if (yarn === undefined) throw new Error('no yarn')
    const [ref] = motion.segmentsOf([yarn.noteIds[0] as string]).filter((r) => r.yarnId === yarn.id)
    const e = ref && endsOf(ref)
    if (!ref || !e) throw new Error('no segment')
    expect(motion.sagOf(ref, e.a, e.b)).toEqual(restSagPoint(e.a, e.b))
  })

  it('sync adds sleeping springs; retarget after a 50 px pin move wakes one; 1 s later step() is false', () => {
    const { store, motion, endsOf, offsets, flags } = setup()
    const id = loneNote(motion, store.getState())
    const refs = motion.segmentsOf([id])
    const ref = refs[0]
    if (ref === undefined) throw new Error('no ref')
    offsets.set(id, { x: 50, y: 0 })
    motion.retarget(refs, endsOf)
    expect(motion.awakeCount).toBe(1)
    expect(flags.wakes).toBeGreaterThan(0)
    expect([...motion.activeRefs()].map((r) => r.key)).toEqual([ref.key])

    const { a, b } = endsOf(ref) as { a: Point; b: Point }
    const rest = restSagPoint(a, b)
    expect(motion.step(1 / 60, 16)).toBe(true)
    // It lags behind the moved pins, then catches up.
    const lagging = motion.sagOf(ref, a, b)
    expect(Math.abs(lagging.x - rest.x)).toBeGreaterThan(5)
    const { active } = frames(motion, 16, 1000)
    expect(active).toBe(false)
    expect(motion.awakeCount).toBe(0)
    expect(motion.sagOf(ref, a, b)).toEqual(rest)
  })

  it('a snapping retarget (measured height, tilt toggle) moves the rest point without waking', () => {
    const { store, motion, endsOf, offsets, flags } = setup()
    const id = loneNote(motion, store.getState())
    const refs = motion.segmentsOf([id])
    const ref = refs[0]
    if (ref === undefined) throw new Error('no ref')
    offsets.set(id, { x: 80, y: 30 })
    const wakes = flags.wakes
    motion.retarget(refs, endsOf, { snap: true })
    expect(motion.awakeCount).toBe(0)
    expect(flags.wakes).toBe(wakes)
    const { a, b } = endsOf(ref) as { a: Point; b: Point }
    expect(motion.step(1 / 60, 16)).toBe(false)
    motion.retarget(refs, endsOf)
    expect(motion.awakeCount).toBe(0)
    expect(motion.sagOf(ref, a, b)).toEqual(restSagPoint(a, b))
  })

  it('a move within restEpsilon does not wake the spring', () => {
    const { store, motion, endsOf, offsets } = setup()
    const id = loneNote(motion, store.getState())
    offsets.set(id, { x: 0.05, y: 0 })
    motion.retarget(motion.segmentsOf([id]), endsOf)
    expect(motion.awakeCount).toBe(0)
  })

  it('a 5 s frame gap lands every spring at rest; dt 0 and NaN keep them awake but unchanged', () => {
    const { store, motion, endsOf, offsets } = setup()
    offsets.set(DEMO_IDS.hub, { x: 120, y: -80 })
    const refs = motion.segmentsOf([DEMO_IDS.hub])
    motion.retarget(refs, endsOf)
    expect(motion.awakeCount).toBe(4)
    const ref = refs[0] as (typeof refs)[number]
    const { a, b } = endsOf(ref) as { a: Point; b: Point }
    motion.step(1 / 60, 16)
    const before = motion.sagOf(ref, a, b)
    for (const dt of [0, -1, Number.NaN]) {
      expect(motion.step(dt, 20)).toBe(true)
      expect(motion.sagOf(ref, a, b)).toEqual(before)
    }
    expect(motion.step(5, 5020)).toBe(false)
    expect(motion.awakeCount).toBe(0)
    expect(motion.sagOf(ref, a, b)).toEqual(restSagPoint(a, b))
    expect(store.getState().notes.size).toBeGreaterThan(0)
  })

  it('YarnMotion under reduced motion never has an awake spring', () => {
    const { motion, endsOf, offsets } = setup(true)
    const refs = motion.segmentsOf([DEMO_IDS.hub])
    for (let k = 1; k <= 10; k++) {
      offsets.set(DEMO_IDS.hub, { x: 30 * k, y: 10 * k })
      motion.retarget(refs, endsOf)
      expect(motion.awakeCount).toBe(0)
      expect(motion.step(1 / 60, 16 * k)).toBe(false)
    }
    const ref = refs[0] as (typeof refs)[number]
    const { a, b } = endsOf(ref) as { a: Point; b: Point }
    expect(motion.sagOf(ref, a, b)).toEqual(restSagPoint(a, b))
  })

  it('switching to reduced motion mid-swing snaps the awake springs', () => {
    const { motion, endsOf, offsets, flags } = setup()
    offsets.set(DEMO_IDS.hub, { x: 200, y: 0 })
    motion.retarget(motion.segmentsOf([DEMO_IDS.hub]), endsOf)
    motion.step(1 / 60, 16)
    expect(motion.awakeCount).toBe(4)
    flags.reduced = true
    expect(motion.step(1 / 60, 32)).toBe(false)
    expect(motion.awakeCount).toBe(0)
  })

  it('drops springs whose segment is gone', () => {
    const { store, motion, offsets, endsOf } = setup()
    offsets.set(DEMO_IDS.hub, { x: 50, y: 0 })
    motion.retarget(motion.segmentsOf([DEMO_IDS.hub]), endsOf)
    expect(motion.awakeCount).toBe(4)
    store.commit([{ op: 'note.delete', id: DEMO_IDS.hub }])
    expect(motion.segmentsOf([DEMO_IDS.hub])).toEqual([])
    expect(motion.awakeCount).toBe(0)
  })

  it('create commits one apricot yarn and draws it in over 350 ms', () => {
    const { store, motion, endsOfYarn } = setup()
    let now = 1000
    const cmd = flows(store, motion, () => now, endsOfYarn)
    const c0 = store.commits
    const id = cmd.tie(DEMO_IDS.knot, DEMO_IDS.print).yarnId
    expect(store.commits).toBe(c0 + 1)
    expect(store.getState().yarns.get(id)).toMatchObject({
      type: 'yarn',
      noteIds: [DEMO_IDS.knot, DEMO_IDS.print],
      color: 'apricot',
      label: '',
    })
    expect(motion.activeAnimations).toBe(1)
    expect(motion.progressOf(id)).toBe(0)
    expect([...motion.activeRefs()].map((r) => r.yarnId)).toEqual([id])
    expect(cmd.tie(DEMO_IDS.knot, DEMO_IDS.hub, 'rose').yarnId).not.toBe(id)

    now = 1175
    expect(motion.step(1 / 60, now)).toBe(true)
    const p = motion.progressOf(id)
    expect(p).toBeGreaterThan(0.3)
    expect(p).toBeLessThan(1)
    expect(motion.alphaOf(id)).toBe(1)
    now = 1400
    expect(motion.step(1 / 60, now)).toBe(false)
    expect(motion.progressOf(id)).toBe(1)
    expect(motion.activeAnimations).toBe(0)
  })

  it('reduced motion draws in as a 100 ms fade', () => {
    const { store, motion, endsOfYarn, flags } = setup()
    flags.reduced = true
    const cmd = flows(store, motion, () => 0, endsOfYarn)
    const id = cmd.tie(DEMO_IDS.knot, DEMO_IDS.print).yarnId
    expect(motion.progressOf(id)).toBe(1)
    expect(motion.alphaOf(id)).toBe(0)
    motion.step(1 / 60, 50)
    expect(motion.alphaOf(id)).toBe(0.5)
    expect(motion.step(1 / 60, 100)).toBe(false)
    expect(motion.alphaOf(id)).toBe(1)
  })

  it('loosen ghost survives the delete commit until done', () => {
    const { store, motion, endsOfYarn } = setup()
    let now = 5000
    const cmd = flows(store, motion, () => now, endsOfYarn)
    const yarn = store.getState().yarns.get(DEMO_IDS.crossed)
    if (yarn === undefined) throw new Error('no yarn')
    const segments = endsOfYarn(yarn.id)
    expect(segments).toHaveLength(1)
    const c0 = store.commits
    cmd.untie(yarn.id)
    expect(store.commits).toBe(c0 + 1)
    expect(store.getState().yarns.has(yarn.id)).toBe(false)
    expect(motion.ghosts()).toEqual([{ yarn, segments, sagScale: 1, alpha: 1 }])
    expect(motion.activeAnimations).toBe(1)

    now = 5100
    expect(motion.step(1 / 60, now)).toBe(true)
    const [g] = motion.ghosts()
    expect(g?.sagScale).toBeGreaterThan(1)
    expect(g?.alpha).toBeGreaterThan(0)
    expect(g?.alpha).toBeLessThan(1)
    // A later board change keeps the ghost.
    store.commit([{ op: 'note.update', id: DEMO_IDS.hub, set: { x: 1050 } }])
    expect(motion.ghosts()).toHaveLength(1)

    now = 5200
    expect(motion.step(1 / 60, now)).toBe(false)
    expect(motion.ghosts()).toEqual([])
    expect(motion.activeAnimations).toBe(0)
    cmd.untie(yarn.id)
    expect(store.commits).toBe(c0 + 2)
    expect(motion.activeAnimations).toBe(0)
  })
})

describe('a thread pulse', () => {
  it('swells the thread once over 800 ms, then is gone', () => {
    const { motion } = setup()
    let now = 2000
    const id = DEMO_IDS.crossed
    expect(motion.pulseOf(id)).toBe(0)
    motion.startPulse(id, now)
    expect(motion.activeAnimations).toBe(1)
    // Drawn live while it runs, so the cached layer is not redrawn per frame.
    expect([...motion.activeRefs()].every((r) => r.yarnId === id)).toBe(true)
    expect([...motion.activeRefs()].length).toBeGreaterThan(0)
    now = 2400
    expect(motion.step(1 / 60, now)).toBe(true)
    expect(motion.pulseOf(id)).toBeCloseTo(1, 5)
    now = 2200
    motion.step(1 / 60, now)
    const early = motion.pulseOf(id)
    expect(early).toBeGreaterThan(0)
    expect(early).toBeLessThan(1)
    now = 2800
    expect(motion.step(1 / 60, now)).toBe(false)
    expect(motion.pulseOf(id)).toBe(0)
    expect(motion.activeAnimations).toBe(0)
  })

  it('is skipped under reduced motion', () => {
    const { motion, flags } = setup()
    flags.reduced = true
    const wakes = flags.wakes
    motion.startPulse(DEMO_IDS.crossed, 0)
    expect(motion.activeAnimations).toBe(0)
    expect(motion.pulseOf(DEMO_IDS.crossed)).toBe(0)
    expect(flags.wakes).toBe(wakes)
  })

  it('is dropped with a thread that is deleted meanwhile', () => {
    const { store, motion } = setup()
    motion.startPulse(DEMO_IDS.crossed, 0)
    store.commit([{ op: 'yarn.delete', id: DEMO_IDS.crossed }])
    expect(motion.activeAnimations).toBe(0)
  })

  it('sync with thread ids re-matches only those threads’ springs, as a full sync would', () => {
    const { store, endsOf } = setup()
    const motion = new YarnMotion(() => false)
    motion.sync(store.getState(), endsOf)
    const springs = (m: YarnMotion) =>
      (m as unknown as { springs: Map<string, { ref: SegmentRef; target: Point }> }).springs
    const before = new Map(springs(motion))
    const yarn = [...store.getState().yarns.values()].find((y) => y.noteIds.length >= 3)
    if (yarn === undefined) throw new Error('no thread of three')
    const other = [...store.getState().yarns.values()].find((y) => y.id !== yarn.id)
    // The thread loses its middle note: its springs change, nobody else's.
    store.commit([{ op: 'yarn.removeNote', id: yarn.id, noteId: yarn.noteIds[1] as string }])
    const s = store.getState()
    motion.sync(s, endsOf, [yarn.id])
    const full = new YarnMotion(() => false)
    full.sync(s, endsOf)
    expect([...springs(motion).keys()].sort()).toEqual([...springs(full).keys()].sort())
    for (const [k, spring] of springs(motion)) {
      if (spring.ref.yarnId !== yarn.id) expect(spring).toBe(before.get(k))
    }
    expect(
      motion
        .segmentsOf([yarn.noteIds[0] as string])
        .map((r) => r.key)
        .sort(),
    ).toEqual(
      full
        .segmentsOf([yarn.noteIds[0] as string])
        .map((r) => r.key)
        .sort(),
    )
    if (other) {
      expect(motion.segmentsOf(other.noteIds).length).toBe(full.segmentsOf(other.noteIds).length)
    }
    // A thread gone: its springs go with it.
    store.commit([{ op: 'yarn.delete', id: yarn.id }])
    motion.sync(store.getState(), endsOf, [yarn.id])
    expect([...springs(motion).values()].some((sp) => sp.ref.yarnId === yarn.id)).toBe(false)
  })
})
