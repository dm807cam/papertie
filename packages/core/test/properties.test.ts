/**
 * Cross-module property and fuzz suite: serialization ↔ parsing, ops ↔ inversion ↔ invariants,
 * parser robustness against corrupted files, and derived focus. Generators: ./arbitraries.ts.
 */
import fc from 'fast-check'
import {
  type ApplyCtx,
  applyBatch,
  applyLenient,
  type BoardState,
  buildMembership,
  computeFocus,
  type FocusDepth,
  invertBatch,
  type Op,
  parseBoard,
  serializeBoard,
  stripTimestamps,
  validateInvariants,
} from '../src/index'
import { arbBoardState, arbOpScript, arbText, toOps } from './arbitraries'
import { neighbours } from './fixtures'

const RUNS = { numRuns: 300 }
const ctx: ApplyCtx = { now: '2030-01-01T00:00:00.000Z' }
const undoCtx: ApplyCtx = { now: '2030-01-01T00:00:01.000Z' }

/** `state` with only the assets whose ids are in `keep` (asset.add is not undone by design). */
function withAssetsOf(state: BoardState, keep: BoardState): BoardState {
  return { ...state, assets: new Map([...state.assets].filter(([id]) => keep.assets.has(id))) }
}

describe('generators', () => {
  it('arbBoardState gives invariant-valid states', () => {
    fc.assert(
      fc.property(arbBoardState(), (s) => {
        expect(validateInvariants(s)).toEqual([])
      }),
      { numRuns: 100 },
    )
  })

  it('arbOpScript + toOps produce every op kind, and most actions resolve', () => {
    const samples = fc.sample(fc.tuple(arbBoardState(), arbOpScript({ minLength: 10 })), {
      numRuns: 200,
      seed: 42,
    })
    const kinds = new Set<Op['op']>()
    let actions = 0
    let ops = 0
    for (const [s, script] of samples) {
      const resolved = toOps(s, script, ctx)
      actions += script.length
      ops += resolved.length
      for (const op of resolved) kinds.add(op.op)
    }
    expect([...kinds].sort()).toEqual(
      [
        'asset.add',
        'board.update',
        'note.create',
        'note.delete',
        'note.update',
        'yarn.create',
        'yarn.delete',
        'yarn.insertNote',
        'yarn.removeNote',
        'yarn.update',
      ].sort(),
    )
    expect(ops / actions).toBeGreaterThan(0.6)
  })

  it('states carry shared pins, and scripts set them and take pinned notes off threads', () => {
    const samples = fc.sample(fc.tuple(arbBoardState(), arbOpScript({ minLength: 10 })), {
      numRuns: 200,
      seed: 7,
    })
    let pinnedStates = 0
    let pinUpdates = 0
    let pinnedRemovals = 0
    for (const [s, script] of samples) {
      if ([...s.yarns.values()].some((y) => y.pins !== undefined)) pinnedStates++
      let cur = s
      for (const op of toOps(s, script, ctx)) {
        if (op.op === 'yarn.update' && op.set.pins !== undefined) pinUpdates++
        if (op.op === 'yarn.removeNote' && cur.yarns.get(op.id)?.pins?.[op.noteId] !== undefined) {
          pinnedRemovals++
        }
        cur = applyBatch(cur, [op], ctx)
      }
    }
    expect(pinnedStates).toBeGreaterThan(20)
    expect(pinUpdates).toBeGreaterThan(20)
    expect(pinnedRemovals).toBeGreaterThan(5)
  })
})

describe('property: serialization round trip', () => {
  it('parseBoard(serializeBoard(s)) gives back s with no issues and integrity ok', () => {
    fc.assert(
      fc.property(arbBoardState(), (s) => {
        const text = serializeBoard(s)
        const r = parseBoard(text)
        expect(r.issues).toEqual([])
        expect(r.integrity).toBe('ok')
        expect(r.state).toEqual(s)
        // Canonical: re-serializing the parsed state is byte-identical.
        expect(serializeBoard(r.state as BoardState)).toBe(text)
      }),
      RUNS,
    )
  })
})

describe('property: op scripts', () => {
  const scenario = fc.tuple(arbBoardState(), arbOpScript())

  it('undo: applying invertBatch restores the state apart from timestamps (and added assets)', () => {
    fc.assert(
      fc.property(scenario, ([s, script]) => {
        const ops = toOps(s, script, ctx)
        const after = applyBatch(s, ops, ctx)
        const inverse = invertBatch(s, ops)
        const undone = applyBatch(after, inverse, undoCtx)
        // Strict: an undone decoration must be absent, not present-as-undefined.
        expect(stripTimestamps(withAssetsOf(undone, s))).toStrictEqual(stripTimestamps(s))
        // Assets are garbage-collected, not undone: the only extra assets are the added ones.
        const added = ops.flatMap((op) => (op.op === 'asset.add' ? [op.asset.id] : []))
        expect([...undone.assets.keys()].sort()).toEqual(
          [...new Set([...s.assets.keys(), ...added])].sort(),
        )
      }),
      RUNS,
    )
  })

  it('undo after a remote change: applyLenient of the inverse keeps the invariants', () => {
    const remoteCtx: ApplyCtx = { now: '2030-01-01T00:00:00.500Z' }
    fc.assert(
      fc.property(scenario, arbOpScript(), ([s, local], remote) => {
        const ops = toOps(s, local, ctx)
        const inverse = invertBatch(s, ops)
        const afterLocal = applyBatch(s, ops, ctx)
        // The board changes before the undo is applied.
        const afterRemote = applyBatch(afterLocal, toOps(afterLocal, remote, remoteCtx), remoteCtx)
        // Any non-OpError would escape applyLenient and fail the property.
        const undone = applyLenient(afterRemote, inverse, undoCtx)
        expect(validateInvariants(undone.state)).toEqual([])
        expect(undone.skipped.length).toBeLessThanOrEqual(inverse.length)
      }),
      RUNS,
    )
  })

  it('invariants: applyBatch over a resolved script keeps validateInvariants empty', () => {
    fc.assert(
      fc.property(scenario, ([s, script]) => {
        const after = applyBatch(s, toOps(s, script, ctx), ctx)
        expect(validateInvariants(after)).toEqual([])
      }),
      RUNS,
    )
  })

  it('states reached through ops still round-trip through JSONL', () => {
    fc.assert(
      fc.property(scenario, ([s, script]) => {
        const after = applyBatch(s, toOps(s, script, ctx), ctx)
        const r = parseBoard(serializeBoard(after))
        expect(r.issues).toEqual([])
        expect(r.integrity).toBe('ok')
        expect(r.state).toEqual(after)
      }),
      RUNS,
    )
  })
})

type Corruption =
  | { kind: 'truncate'; at: number }
  | { kind: 'flip'; at: number; xor: number }
  | { kind: 'swap'; i: number; j: number }
  | { kind: 'drop'; i: number }
  | { kind: 'duplicate'; i: number }

const arbCorruption: fc.Arbitrary<Corruption> = fc.oneof(
  fc.record({ kind: fc.constant('truncate' as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant('flip' as const),
    at: fc.nat(),
    xor: fc.integer({ min: 1, max: 255 }),
  }),
  fc.record({ kind: fc.constant('swap' as const), i: fc.nat(), j: fc.nat() }),
  fc.record({ kind: fc.constant('drop' as const), i: fc.nat() }),
  fc.record({ kind: fc.constant('duplicate' as const), i: fc.nat() }),
)

/** Corrupt a serialized board at the byte level (truncate, flip) or the line level. */
function corrupt(text: string, c: Corruption): string {
  if (c.kind === 'truncate' || c.kind === 'flip') {
    const bytes = new TextEncoder().encode(text)
    if (c.kind === 'truncate') return new TextDecoder().decode(bytes.slice(0, c.at % bytes.length))
    const i = c.at % bytes.length
    bytes[i] = (bytes[i] as number) ^ c.xor
    return new TextDecoder().decode(bytes)
  }
  // Without the trailing newline, so every index is a real line.
  const lines = text.slice(0, -1).split('\n')
  const i = c.i % lines.length
  if (c.kind === 'swap') {
    const j = c.j % lines.length
    ;[lines[i], lines[j]] = [lines[j] as string, lines[i] as string]
  } else if (c.kind === 'drop') {
    lines.splice(i, 1)
  } else {
    lines.splice(i, 0, lines[i] as string)
  }
  return `${lines.join('\n')}\n`
}

describe('property: parseBoard robustness', () => {
  function expectSound(text: string): ReturnType<typeof parseBoard> {
    const r = parseBoard(text)
    expect(Array.isArray(r.issues)).toBe(true)
    if (r.state !== null) expect(validateInvariants(r.state)).toEqual([])
    return r
  }

  it('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expectSound(s)
      }),
      RUNS,
    )
  })

  it('never throws on arbitrary full-Unicode strings', () => {
    fc.assert(
      fc.property(arbText(500), (s) => {
        expectSound(s)
      }),
      RUNS,
    )
  })

  it('never throws on corrupted boards, loads only sound states, and ok means unchanged', () => {
    fc.assert(
      fc.property(
        arbBoardState(),
        fc.array(arbCorruption, { minLength: 1, maxLength: 3 }),
        (s, corruptions) => {
          const text = corruptions.reduce(corrupt, serializeBoard(s))
          const r = expectSound(text)
          // A corruption the integrity check passes must not have changed what is loaded.
          if (r.integrity === 'ok')
            expect(r.state && serializeBoard(r.state)).toBe(serializeBoard(s))
        },
      ),
      RUNS,
    )
  })
})

describe('property: focus', () => {
  /** Reference model: plain BFS over `neighbours`, distances capped at `depth`. */
  function naiveDepths(s: BoardState, seeds: string[], depth: FocusDepth): Map<string, number> {
    const m = buildMembership(s)
    const limit = depth === 'all' ? Number.POSITIVE_INFINITY : depth
    const dist = new Map<string, number>()
    let frontier = [...new Set(seeds.filter((id) => s.notes.has(id)))]
    for (const id of frontier) dist.set(id, 0)
    for (let d = 1; d <= limit && frontier.length > 0; d++) {
      const next: string[] = []
      for (const id of frontier) {
        for (const other of neighbours(m, id)) {
          if (!dist.has(other)) {
            dist.set(other, d)
            next.push(other)
          }
        }
      }
      frontier = next
    }
    return dist
  }

  const ghost = `note_${'Y'.repeat(26)}`
  const arbDepth: fc.Arbitrary<FocusDepth> = fc.constantFrom<FocusDepth[]>(1, 2, 3, 'all')

  it('visible yarns are exactly the fully visible ones; surviving seeds are visible', () => {
    fc.assert(
      fc.property(
        arbBoardState(),
        arbOpScript({ maxLength: 15 }),
        fc.array(fc.option(fc.nat(), { nil: null }), { maxLength: 5 }),
        fc.array(fc.option(fc.nat(), { nil: null }), { maxLength: 3 }),
        arbDepth,
        (s, script, seedPicks, includePicks, depth) => {
          // Seeds and includes are chosen on the original board (null = an unknown id); the
          // script may then delete some of them.
          const ids = [...s.notes.keys()]
          const resolve = (p: number | null) =>
            p === null || ids.length === 0 ? ghost : (ids[p % ids.length] as string)
          const seeds = seedPicks.map(resolve)
          const include = includePicks.map(resolve)
          const after = applyBatch(s, toOps(s, script, ctx), ctx)

          const f = computeFocus(buildMembership(after), { seeds, depth, include })

          for (const id of f.notes) expect(after.notes.has(id)).toBe(true)
          for (const id of seeds) if (after.notes.has(id)) expect(f.notes.has(id)).toBe(true)
          const fullyVisible = [...after.yarns.values()]
            .filter((y) => y.noteIds.every((id) => f.notes.has(id)))
            .map((y) => y.id)
          expect([...f.yarns].sort()).toEqual(fullyVisible.sort())

          const expected = naiveDepths(after, seeds, depth)
          expect(new Map([...f.depthOf].sort())).toEqual(new Map([...expected].sort()))
          const expectedNotes = new Set(expected.keys())
          for (const id of include) if (after.notes.has(id)) expectedNotes.add(id)
          expect([...f.notes].sort()).toEqual([...expectedNotes].sort())

          for (const end of f.looseEnds) {
            expect(f.notes.has(end.noteId)).toBe(true)
            expect(f.yarns.has(end.yarnId)).toBe(false)
          }
          expect(f.canExpand).toBe(f.looseEnds.length > 0 && depth !== 'all')
        },
      ),
      RUNS,
    )
  })
})
