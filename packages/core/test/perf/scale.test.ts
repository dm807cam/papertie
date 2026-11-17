/**
 * Scale guard: at 100,000 notes an edit's cost does not follow the board's size. The
 * budgets are fixed (a single-note batch ≤ 1 ms, a 500-op batch ≤ 50 ms), the best of five
 * warm runs so a GC pause or a busy machine cannot fail them; a copy of the note map or a scan
 * of every note per batch costs several times the budget. Timings only count as benchmark
 * results from a quiet machine on AC power, so the load average is printed with them.
 */
import {
  type ApplyCtx,
  applyBatch,
  type BoardState,
  LIMITS,
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

const one: Op[] = [{ op: 'note.update', id: fixtureId('note', 54_321), set: { x: 7, y: -7 } }]
const many: Op[] = Array.from({ length: 500 }, (_, i) => ({
  op: 'note.update',
  id: fixtureId('note', i * 199 + 1),
  set: { x: i + 1, y: -(i + 1) },
}))

describe('limits', () => {
  it('maxNotes is 500,000', () => {
    expect(LIMITS.maxNotes).toBe(500_000)
  })
})

describe('scale (100,000 notes, 500 × 200-note threads)', () => {
  const s = hugeBoard()

  it('an edit leaves the state it came from untouched', () => {
    const id = fixtureId('note', 54_321)
    const before = s.notes.get(id)
    const next = applyBatch(s, one, ctx)
    expect(next.notes.get(id)?.x).toBe(7)
    expect(s.notes.get(id)).toBe(before)
    expect(next.notes.size).toBe(NOTES)
    expect(next.yarns).toBe(s.yarns)
  })

  // How long each takes is the timing rows' (`scale.timing.test.ts`); here, what each finds.
  it('what one edit changed is found in ≤ 0.5 ms at 100,000 notes (mapChanges)', () => {
    const next = applyBatch(s, one, ctx)
    const many500 = applyBatch(s, many, ctx)
    expect(mapChanges(s.notes, next.notes)).toEqual({
      set: [fixtureId('note', 54_321)],
      deleted: [],
    })
    expect(mapChanges(s.notes, many500.notes).set).toHaveLength(500)
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
  })
})
