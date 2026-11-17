/**
 * The batch safety net's scoped check (`introducedViolationsAmong`, given the ids a draft wrote)
 * reaches the same verdict as the whole-board `introducedViolations`, on sound states and on
 * states broken in every way `validateInvariants` knows.
 */
import fc from 'fast-check'
import {
  type ApplyCtx,
  type BoardState,
  type InvariantViolation,
  introducedViolations,
  introducedViolationsAmong,
  OpError,
} from '../src/index'
import { applyToDraft, Draft, parseOp } from '../src/ops/draft'
import { arbBoardState, arbOpScript, toOps } from './arbitraries'
import { fixtureId } from './fixtures'

const ctx: ApplyCtx = { now: '2030-01-01T00:00:00.000Z' }

type Break =
  | { kind: 'drop-note' | 'drop-asset' | 'short-thread' | 'twice-on-thread'; pick: number }
  | { kind: 'rekey-thread' | 'rekey-note'; pick: number }

const arbBreak: fc.Arbitrary<Break> = fc.record({
  kind: fc.constantFrom(
    'drop-note',
    'drop-asset',
    'short-thread',
    'twice-on-thread',
    'rekey-thread',
    'rekey-note',
  ),
  pick: fc.nat(),
})

const nth = <T>(xs: readonly T[], pick: number): T | undefined => xs[pick % Math.max(1, xs.length)]

/** `s` broken as `b` says (plain `Map`s, as a hand-built state would have). */
function broken(s: BoardState, b: Break): BoardState {
  const assets = new Map(s.assets)
  const notes = new Map(s.notes)
  const yarns = new Map(s.yarns)
  const noteIds = [...notes.keys()]
  const yarnIds = [...yarns.keys()]
  switch (b.kind) {
    case 'drop-note': {
      const id = nth(noteIds, b.pick)
      if (id) notes.delete(id)
      break
    }
    case 'drop-asset': {
      const id = nth([...assets.keys()], b.pick)
      if (id) assets.delete(id)
      break
    }
    case 'short-thread':
    case 'twice-on-thread': {
      const yarn = yarns.get(nth(yarnIds, b.pick) ?? '')
      if (!yarn) break
      const first = yarn.noteIds[0] as string
      const ids = b.kind === 'short-thread' ? [first] : [...yarn.noteIds, first]
      yarns.set(yarn.id, { ...yarn, noteIds: ids })
      break
    }
    case 'rekey-thread': {
      const id = nth(yarnIds, b.pick)
      const yarn = id ? yarns.get(id) : undefined
      if (!id || !yarn) break
      yarns.delete(id)
      yarns.set(fixtureId('yarn', 9_000 + b.pick), yarn)
      break
    }
    case 'rekey-note': {
      const id = nth(noteIds, b.pick)
      const note = id ? notes.get(id) : undefined
      if (!id || !note) break
      notes.delete(id)
      notes.set(`not_a_note_${b.pick}`, note)
      break
    }
  }
  return { ...s, assets, notes, yarns }
}

const key = (v: InvariantViolation) => `${v.kind} ${v.id}`

describe('scoped safety net', () => {
  it('introducedViolationsAmong gives the same verdict as introducedViolations', () => {
    fc.assert(
      fc.property(
        arbBoardState(),
        fc.array(arbBreak, { maxLength: 3 }),
        // With asset.remove: a removed asset that an unwritten note still shows is found too.
        arbOpScript({ minLength: 3, assetRemove: true }),
        (sound, breaks, script) => {
          // Ops resolved on the sound state, applied (where they still apply) to the broken one.
          const ops = toOps(sound, script, ctx)
          const before = breaks.reduce(broken, sound)
          const d = new Draft(before)
          for (const op of ops) {
            try {
              applyToDraft(d, parseOp(op), ctx.now)
            } catch (err) {
              if (!(err instanceof OpError)) throw err
            }
          }
          const after = d.toState(ctx.now)
          if (after === before) return
          expect(introducedViolationsAmong(before, after, d.touched).map(key).sort()).toEqual(
            introducedViolations(before, after).map(key).sort(),
          )
        },
      ),
      { numRuns: 400 },
    )
  })
})
