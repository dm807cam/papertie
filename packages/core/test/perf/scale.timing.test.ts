/**
 * Scale guard: at 100,000 notes an edit's cost does not follow the board's size. The
 * budgets are fixed (a single-note batch ≤ 1 ms, a 500-op batch ≤ 50 ms), the best of five
 * warm runs so a GC pause or a busy machine cannot fail them; a copy of the note map or a scan
 * of every note per batch costs several times the budget. Timings only count as benchmark
 * results from a quiet machine on AC power, so the load average is printed with them.
 */
import { loadavg } from 'node:os'
import {
  type ApplyCtx,
  applyBatch,
  type BoardState,
  invertBatch,
  type MapChanges,
  mapChangesWithin,
  type Op,
  OpError,
  stateFromRecords,
} from '../../src/index'
import { fixtureId, makeAsset, makeBoard, makeNote, makeYarn } from '../fixtures'

const ctx: ApplyCtx = { now: '2026-10-30T11:00:00.000Z' }
/** Every change, however many: no limit. */
const mapChanges = <K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>) =>
  mapChangesWithin(a, b, Number.POSITIVE_INFINITY) as MapChanges<K>
const NOTES = 100_000

/** 100,000 notes and 500 threads of 200 notes each (every note on exactly one thread). */
function hugeBoard(): BoardState {
  const notes = Array.from({ length: NOTES }, (_, i) =>
    makeNote({ id: fixtureId('note', i + 1), x: i % 1000, y: Math.floor(i / 1000), z: i }),
  )
  const yarns = Array.from({ length: NOTES / 200 }, (_, t) =>
    makeYarn(
      notes.slice(t * 200, (t + 1) * 200).map((n) => n.id),
      { id: fixtureId('yarn', t + 1) },
    ),
  )
  return stateFromRecords(makeBoard(), [...notes, ...yarns])
}

/** The fastest of five runs, in ms. */
function best(fn: () => unknown): number {
  let ms = Number.POSITIVE_INFINITY
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    fn()
    ms = Math.min(ms, performance.now() - t0)
  }
  return ms
}

const one: Op[] = [{ op: 'note.update', id: fixtureId('note', 54_321), set: { x: 7, y: -7 } }]
const many: Op[] = Array.from({ length: 500 }, (_, i) => ({
  op: 'note.update',
  id: fixtureId('note', i * 199 + 1),
  set: { x: i + 1, y: -(i + 1) },
}))

// The timed rows of scale.test.ts, in the timing project (`vitest.config.ts`); the file keeps the rest,
// and the untimed proofs of the mapChanges and asset.remove rows.
describe('scale (100,000 notes, 500 × 200-note threads)', () => {
  const s = hugeBoard()
  // Warm the JIT and zod on the same paths the timed runs take.
  for (let i = 0; i < 20; i++) {
    applyBatch(s, many, ctx)
    invertBatch(s, many)
  }
  const load = loadavg()[0]?.toFixed(2)

  it('one note.update on a 100,000-note state takes ≤ 1 ms; 500 ops ≤ 50 ms', () => {
    const single = best(() => applyBatch(s, one, ctx))
    const batch = best(() => applyBatch(s, many, ctx))
    const undo = best(() => invertBatch(s, many))
    console.info(
      `scale at ${NOTES}: note.update ${single.toFixed(3)} ms, 500 ops ${batch.toFixed(1)} ms, ` +
        `invert 500 ${undo.toFixed(1)} ms (load1 ${load})`,
    )
    expect(single).toBeLessThanOrEqual(1)
    expect(batch).toBeLessThanOrEqual(50)
    expect(undo).toBeLessThanOrEqual(50)
  })

  it('note.delete, note.create and a thread edit each take ≤ 1 ms at 100,000 notes', () => {
    // A full board refuses a create, so it is timed on the board less one note.
    const less = applyBatch(s, [{ op: 'note.delete', id: fixtureId('note', 77) }], ctx)
    const create: Op = { op: 'note.create', note: makeNote({ id: fixtureId('note', NOTES + 1) }) }
    const yarn = fixtureId('yarn', 250)
    const thread: Op[] = [
      { op: 'yarn.update', id: yarn, set: { label: 'kept' } },
      { op: 'yarn.removeNote', id: yarn, noteId: fixtureId('note', 249 * 200 + 5) },
    ]
    const del = best(() => applyBatch(s, [{ op: 'note.delete', id: fixtureId('note', 99) }], ctx))
    const add = best(() => applyBatch(less, [create], ctx))
    const wind = best(() => applyBatch(s, thread, ctx))
    console.info(
      `scale at ${NOTES}: note.delete ${del.toFixed(3)} ms, note.create ${add.toFixed(3)} ms, ` +
        `thread edit ${wind.toFixed(3)} ms (load1 ${load})`,
    )
    expect(del).toBeLessThanOrEqual(1)
    expect(add).toBeLessThanOrEqual(1)
    expect(wind).toBeLessThanOrEqual(1)
  })

  it('what one edit changed is found in ≤ 0.5 ms at 100,000 notes (mapChanges)', () => {
    const next = applyBatch(s, one, ctx)
    const many500 = applyBatch(s, many, ctx)
    expect(mapChanges(s.notes, next.notes)).toEqual({
      set: [fixtureId('note', 54_321)],
      deleted: [],
    })
    expect(mapChanges(s.notes, many500.notes).set).toHaveLength(500)
    const single = best(() => mapChanges(s.notes, next.notes))
    const batch = best(() => mapChanges(s.notes, many500.notes))
    console.info(
      `scale at ${NOTES}: mapChanges one ${single.toFixed(3)} ms, 500 ${batch.toFixed(3)} ms ` +
        `(load1 ${load})`,
    )
    expect(single).toBeLessThanOrEqual(0.5)
    expect(batch).toBeLessThanOrEqual(5)
  })

  it('asset.remove checks every note for the image in ≤ 15 ms at 100,000 notes', () => {
    // 12 photos shown by 5,000 notes (the clustered board's mix), and one photo nothing shows.
    const photo = (n: number) => fixtureId('asset', n)
    const photos = applyBatch(
      s,
      [
        ...Array.from(
          { length: 13 },
          (_, i): Op => ({
            op: 'asset.add',
            asset: makeAsset({ id: photo(i + 1) }),
          }),
        ),
        ...Array.from(
          { length: 5_000 },
          (_, i): Op => ({
            op: 'note.update',
            id: fixtureId('note', i * 20 + 1),
            set: { image: { assetId: photo((i % 12) + 1), frame: 'print' } },
          }),
        ),
      ],
      ctx,
    )
    const loose: Op[] = [{ op: 'asset.remove', id: photo(13) }]
    const shown: Op[] = [{ op: 'asset.remove', id: photo(5) }]
    expect(applyBatch(photos, loose, ctx).assets.has(photo(13))).toBe(false)
    expect(() => applyBatch(photos, shown, ctx)).toThrow(OpError)
    const free = best(() => applyBatch(photos, loose, ctx))
    const refused = best(() => {
      try {
        applyBatch(photos, shown, ctx)
      } catch {}
    })
    console.info(
      `scale at ${NOTES}: asset.remove ${free.toFixed(2)} ms, refused ${refused.toFixed(2)} ms ` +
        `(load1 ${load})`,
    )
    expect(free).toBeLessThanOrEqual(15)
    expect(refused).toBeLessThanOrEqual(15)
  })
})
