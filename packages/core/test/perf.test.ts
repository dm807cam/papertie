/**
 * Performance guard: a batch must not cost O(ops × notes). With a map copy per op
 * this workload took ~130 ms warm (~400 ms cold); with one copy per batch ~3–10 ms; with
 * persistent maps an op costs O(log n), ~2–6 ms here. The best of three warm runs is
 * compared, so a GC pause cannot fail the guard, and the budget leaves several times the
 * current cost as headroom for slower machines. The 100,000-note guard is `perf/scale.test.ts`.
 */
import {
  type ApplyCtx,
  applyBatch,
  type BoardState,
  invertBatch,
  type Op,
  stateFromRecords,
} from '../src/index'
import { fixtureId, makeBoard, makeNote, makeYarn } from './fixtures'

const BUDGET_MS = 50
const ctx: ApplyCtx = { now: '2026-10-27T11:00:00.000Z' }

/** 5,000 notes and 25 threads of 200 notes each (every note on exactly one thread). */
function bigBoard(): BoardState {
  const notes = Array.from({ length: 5_000 }, (_, i) =>
    makeNote({ id: fixtureId('note', i + 1), z: i, text: `note ${i}` }),
  )
  const yarns = Array.from({ length: 25 }, (_, t) =>
    makeYarn(
      notes.slice(t * 200, (t + 1) * 200).map((n) => n.id),
      { id: fixtureId('yarn', t + 1) },
    ),
  )
  return stateFromRecords(makeBoard(), [...notes, ...yarns])
}

const updates: Op[] = Array.from({ length: 500 }, (_, i) => ({
  op: 'note.update',
  id: fixtureId('note', i * 10 + 1),
  set: { x: i + 1, y: -(i + 1) },
}))

/** The fastest of three runs, in ms. */
function time(fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    fn()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

/** Warm up the JIT and zod on a small board, so the timed run measures the algorithm. */
function warmUp(): void {
  const small = stateFromRecords(makeBoard(), [makeNote({ id: fixtureId('note', 1) })])
  const ops: Op[] = Array.from({ length: 50 }, (_, i) => ({
    op: 'note.update',
    id: fixtureId('note', 1),
    set: { x: i + 1 },
  }))
  for (let i = 0; i < 20; i++) {
    applyBatch(small, ops, ctx)
    invertBatch(small, ops)
  }
}

describe('batch performance (5,000 notes, 25 × 200-note threads, 500 note.update)', () => {
  const s = bigBoard()
  warmUp()

  it(`applyBatch stays under ${BUDGET_MS} ms`, () => {
    const ms = time(() => applyBatch(s, updates, ctx))
    console.info(`applyBatch: ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it(`invertBatch stays under ${BUDGET_MS} ms`, () => {
    const ms = time(() => invertBatch(s, updates))
    console.info(`invertBatch: ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(BUDGET_MS)
  })
})
