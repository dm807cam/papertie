/**
 * The thread index a draft carries from one yarn map to the next always matches an index built
 * from scratch, through random op scripts applied one action per batch (including undos).
 */
import fc from 'fast-check'
import {
  type ApplyCtx,
  applyBatch,
  applyLenient,
  type BoardState,
  emptyBoardState,
  IMAGE_FRAMES,
  invertBatch,
  mapChangesWithin,
  type Note,
  patchYarns,
  repairReferences,
  serializeBoard,
  stateBuilder,
  stateFromRecords,
  threadsOf,
  type Yarn,
} from '../src/index'
import { hasThreadIndex, threadIndex } from '../src/ops/threadIndex'
import { arbBoardState, arbOpScript, toOps } from './arbitraries'
import { fixtureId, makeBoard, makeNote, makeYarn } from './fixtures'

const ctx: ApplyCtx = { now: '2030-01-01T00:00:00.000Z' }

/** The index as sorted `[noteId, sorted keys]` pairs, for comparison. */
function plain(yarns: ReadonlyMap<string, Yarn>): Array<[string, string[]]> {
  return [...threadIndex(yarns)]
    .map(([noteId, keys]): [string, string[]] => [noteId, [...keys].sort()])
    .sort(([a], [b]) => (a < b ? -1 : 1))
}

describe('thread index', () => {
  it('a carried-over index matches one built from scratch', () => {
    fc.assert(
      fc.property(
        arbBoardState(),
        arbOpScript({ minLength: 5 }),
        fc.array(fc.boolean(), { minLength: 40, maxLength: 40 }),
        (start, script, undos) => {
          // Build the index first, so every later batch carries it over.
          threadIndex(start.yarns)
          let s: BoardState = start
          for (const [i, action] of script.entries()) {
            const ops = toOps(s, [action], ctx)
            const next = applyBatch(s, ops, ctx)
            const undo = invertBatch(s, ops)
            s = undos[i % undos.length] ? applyLenient(next, undo, ctx).state : next
            expect(hasThreadIndex(s.yarns)).toBe(true)
            expect(plain(s.yarns)).toEqual(plain(new Map(s.yarns)))
          }
        },
      ),
      { numRuns: 150 },
    )
  })
})

describe('thread index through repair', () => {
  it('survives a repair that rewrites no thread', () => {
    const a = fixtureId('note', 1)
    const b = fixtureId('note', 2)
    const loaded = stateFromRecords(makeBoard(), [
      makeNote({ id: a, image: { assetId: fixtureId('asset', 9), frame: IMAGE_FRAMES[0] } }),
      makeNote({ id: b }),
      makeYarn([a, b], { id: fixtureId('yarn', 1) }),
    ])
    const { state, issues } = repairReferences(loaded)
    expect(issues.map((i) => i.kind)).toEqual(['dangling-reference'])
    expect(hasThreadIndex(state.yarns)).toBe(true)
  })
})

describe('stateBuilder', () => {
  it('builds, a batch at a time, the board stateFromRecords builds at once, thread index too', () => {
    fc.assert(
      fc.property(arbBoardState(), fc.integer({ min: 1, max: 7 }), (whole, size) => {
        const records = [...whole.assets.values(), ...whole.notes.values(), ...whole.yarns.values()]
        // A later record with an id already given replaces it, as in stateFromRecords.
        const again = records
          .slice(0, 3)
          .map((r) => ({ ...r, createdAt: '2031-01-01T00:00:00.000Z' }))
        const all = [...records, ...again]
        const b = stateBuilder(whole.board)
        for (let i = 0; i < all.length; i += size) b.add(all.slice(i, i + size))
        const built = b.finish()
        const once = stateFromRecords(whole.board, all)
        expect(serializeBoard(built)).toBe(serializeBoard(once))
        expect(hasThreadIndex(built.yarns)).toBe(true)
        expect(plain(built.yarns)).toEqual(plain(once.yarns))
        for (const id of built.notes.keys()) {
          expect(
            threadsOf(built, id)
              .map((y) => y.id)
              .sort(),
          ).toEqual(
            threadsOf(once, id)
              .map((y) => y.id)
              .sort(),
          )
        }
      }),
    )
  })

  it('shows the notes built so far as one map: each taken is never changed, the last is the board’s', () => {
    const notes = Array.from({ length: 300 }, (_, i) =>
      makeNote({ id: fixtureId('note', i + 1), x: i * 10 }),
    )
    const b = stateBuilder(makeBoard(), { notes: notes.length })
    const taken: Array<{ map: ReadonlyMap<string, Note>; ids: string[] }> = []
    for (let i = 0; i < notes.length; i += 40) {
      b.add(notes.slice(i, i + 40))
      const map = b.notes()
      // Taken twice with no add between: the same map.
      expect(b.notes()).toBe(map)
      taken.push({ map, ids: notes.slice(0, i + 40).map((n) => n.id) })
    }
    // A note added and then taken out again (one shown before it was read, which the read lacked).
    b.add([makeNote({ id: fixtureId('note', 999) })])
    b.removeNotes([fixtureId('note', 999), fixtureId('note', 998)])
    const built = b.finish()
    for (const { map, ids } of taken) expect([...map.keys()]).toEqual(ids)
    expect([...built.notes.keys()]).toEqual(notes.map((n) => n.id))
    // No add since the last map was taken but the one taken out: the board's map shares it all.
    expect(
      mapChangesWithin((taken.at(-1) as { map: ReadonlyMap<string, Note> }).map, built.notes, 4),
    ).toEqual({
      set: [],
      deleted: [],
    })
    expect(() => b.add([])).toThrow()
    expect(() => b.removeNotes([fixtureId('note', 1)])).toThrow()
    // Asked again: the same board.
    expect(b.finish()).toBe(built)
  })

  it('a note given again as the very object held changes nothing in the next map', () => {
    const n = makeNote({ id: fixtureId('note', 1) })
    const b = stateBuilder(makeBoard())
    b.add([n, makeNote({ id: fixtureId('note', 2) })])
    const before = b.notes()
    b.add([n])
    expect(b.notes()).toBe(before)
  })
})

describe('patchYarns', () => {
  it('carries the index through any writes: the same as one built from scratch, none rebuilt', () => {
    const noteIds = Array.from({ length: 6 }, (_, i) => fixtureId('note', i + 1))
    const arbWrite = fc.tuple(
      fc.integer({ min: 1, max: 8 }),
      fc.option(fc.uniqueArray(fc.constantFrom(...noteIds), { minLength: 2, maxLength: 4 }), {
        nil: undefined,
      }),
    )
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.array(fc.array(arbWrite, { maxLength: 6 }), { maxLength: 6 }),
        (fromEmpty, rounds) => {
          // Indexed (a loaded board), or empty (an opening's first board): both carry on.
          let yarns: ReadonlyMap<string, Yarn> = fromEmpty
            ? emptyBoardState(fixtureId('board', 1), 'b', ctx.now).yarns
            : stateFromRecords(makeBoard(), [
                makeYarn([noteIds[0] as string, noteIds[1] as string], {
                  id: fixtureId('yarn', 1),
                }),
              ]).yarns
          for (const writes of rounds) {
            const before = yarns
            yarns = patchYarns(
              yarns,
              writes.map(([n, ids]) => {
                const key = fixtureId('yarn', n)
                return [key, ids && makeYarn(ids, { id: key })] as const
              }),
            )
            expect(hasThreadIndex(yarns)).toBe(true)
            if (writes.length === 0) expect(yarns).toBe(before)
          }
          const fresh = stateFromRecords(makeBoard(), [...yarns.values()]).yarns
          expect(plain(yarns)).toEqual(plain(fresh))
        },
      ),
    )
  })
})
