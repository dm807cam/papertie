/**
 * `asset.remove`: the server-only op the asset sweep commits. It takes the record
 * off the board; a note still showing the asset breaks the invariant, so a batch that would leave
 * one is refused whole. It inverts to `asset.add` with the full record.
 */
import fc from 'fast-check'
import {
  type ApplyCtx,
  applyBatch,
  applyOp,
  type BoardState,
  ClientOpSchema,
  cardCounts,
  cardMarkT,
  commitChanges,
  invertOp,
  normalizeMarks,
  type Op,
  OpError,
  OpSchema,
  parseBoard,
  repairReferences,
  serializeBoard,
  stateFromRecords,
  stripTimestamps,
  validateInvariants,
  withoutAssets,
} from '../src/index'
import { arbBoardState } from './arbitraries'
import { fixtureId, makeAsset, makeBlock, makeBoard, makeBook, makeNote } from './fixtures'

const ctx: ApplyCtx = { now: '2026-10-27T11:00:00.000Z' }
const shown = fixtureId('asset', 1)
const loose = fixtureId('asset', 2)
const a = fixtureId('note', 1)
const b = fixtureId('note', 2)

/** Notes a (showing `shown`) and b (no image); assets `shown` and `loose`. */
function fixture(): BoardState {
  return stateFromRecords(makeBoard({ revision: 3 }), [
    makeAsset({ id: shown }),
    makeAsset({ id: loose, bytes: 99 }),
    makeNote({ id: a, image: { assetId: shown, frame: 'print' } }),
    makeNote({ id: b, z: 1 }),
  ])
}

const remove = (id: string): Op => ({ op: 'asset.remove', id })

describe('asset.remove', () => {
  it('is server-only: OpSchema accepts it, ClientOpSchema does not', () => {
    expect(OpSchema.safeParse(remove(loose)).success).toBe(true)
    expect(ClientOpSchema.safeParse(remove(loose)).success).toBe(false)
    expect(OpSchema.safeParse({ op: 'asset.remove', id: a }).success).toBe(false)
  })

  it('removes an unreferenced asset; a missing one is a no-op', () => {
    const s = fixture()
    const next = applyBatch(s, [remove(loose)], ctx)
    expect(next.assets.has(loose)).toBe(false)
    expect(next.assets.has(shown)).toBe(true)
    expect(validateInvariants(next)).toEqual([])
    expect(applyOp(next, remove(loose), ctx)).toBe(next)
  })

  it('a commit of it leaves the id among the written assets (its tombstone)', () => {
    const c = commitChanges(fixture(), [remove(loose)], ctx.now, null)
    expect([...c.written.assets]).toEqual([loose])
    expect(c.state.board.revision).toBe(4)
  })

  it('asset.remove of a referenced asset breaks the invariant', () => {
    const s = fixture()
    // applyOp itself does not check references; the invariant names the note left without it.
    expect(validateInvariants(applyOp(s, remove(shown), ctx))).toEqual([
      { kind: 'missing-asset', id: a },
    ])
    // The batch safety net finds it although the batch never wrote note a.
    expect(() => applyBatch(s, [remove(loose), remove(shown)], ctx)).toThrow(OpError)
    try {
      commitChanges(s, [remove(shown)], ctx.now, null)
      expect.unreachable()
    } catch (e) {
      expect((e as OpError).code).toBe('invalid')
      expect((e as OpError).message).toContain(`missing-asset on ${a}`)
    }
    // Taking the image off in the same batch first makes it collectable.
    const freed = applyBatch(
      s,
      [{ op: 'note.update', id: a, set: { image: null } }, remove(shown)],
      ctx,
    )
    expect(freed.assets.has(shown)).toBe(false)
  })

  it('asset.remove then its inverse round-trips', () => {
    const s = fixture()
    const inverse = invertOp(s, remove(loose))
    expect(inverse).toEqual([{ op: 'asset.add', asset: s.assets.get(loose) }])
    expect(invertOp(s, remove(fixtureId('asset', 9)))).toEqual([])

    // On any sound board, removing any of its assets and applying the inverse gives it back.
    fc.assert(
      fc.property(arbBoardState(), fc.nat(), (before, pick) => {
        const ids = [...before.assets.keys()]
        const id = ids[pick % Math.max(1, ids.length)]
        if (id === undefined) return
        const op = remove(id)
        const undo = invertOp(before, op)
        const after = applyOp(before, op, ctx)
        expect(after.assets.has(id)).toBe(false)
        const back = applyBatch(after, undo, ctx)
        expect(stripTimestamps(back)).toEqual(stripTimestamps(before))
        expect(back.assets.get(id)).toEqual(before.assets.get(id))
      }),
      { numRuns: 200 },
    )
  })
})

describe('withoutAssets (a restore or import whose asset files are missing)', () => {
  it('drops the records and clears the images that showed them, one issue each', () => {
    const s = fixture()
    const { state, issues } = withoutAssets(s, new Set([shown, fixtureId('asset', 9)]))
    expect([...state.assets.keys()]).toEqual([loose])
    expect(state.notes.get(a)?.image).toBeNull()
    expect(state.notes.get(b)).toBe(s.notes.get(b))
    expect(validateInvariants(state)).toEqual([])
    expect(issues.map((i) => [i.kind, JSON.parse(i.raw ?? '').id])).toEqual([
      ['dangling-reference', shown],
      ['dangling-reference', a],
    ])
    expect(issues[0]?.message).toBe(`asset ${shown}: its files are missing; record removed`)
    expect(withoutAssets(s, new Set([fixtureId('asset', 9)])).state).toBe(s)
  })
})

describe('a figure whose photo is gone', () => {
  const book = fixtureId('book', 1)
  const card = fixtureId('note', 3)
  const other = fixtureId('note', 4)
  const f1 = fixtureId('block', 1)
  const f2 = fixtureId('block', 2)
  const f3 = fixtureId('block', 3)
  const f4 = fixtureId('block', 4)
  const figures = () =>
    stateFromRecords(makeBoard(), [
      makeAsset({ id: shown }),
      makeAsset({ id: loose }),
      makeNote({ id: card, x: 0, y: 0 }),
      makeNote({ id: other, x: 300, y: 0 }),
      makeBook({ id: book, cards: [card, other].sort() }),
      // From a card, with a caption that names another card already.
      makeBlock({
        id: f1,
        pos: 'V',
        kind: 'figure',
        text: 'The harbour',
        marks: [{ t: cardMarkT(other), from: 4, to: 11 }],
        image: { assetId: shown, card },
      }),
      // From a card, no caption: nothing is left to carry the card.
      makeBlock({ id: f2, pos: 'W', kind: 'figure', text: '', image: { assetId: shown, card } }),
      // Not from a card.
      makeBlock({ id: f3, pos: 'X', kind: 'figure', text: 'A map', image: { assetId: shown } }),
      // Its photo is still there.
      makeBlock({ id: f4, pos: 'Y', kind: 'figure', text: 'Kept', image: { assetId: loose } }),
    ])

  it('becomes a paragraph of its caption, the card carried as a card mark over it', () => {
    const s = figures()
    const { state, issues } = withoutAssets(s, new Set([shown]))
    expect(state.blocks.get(f1)).toEqual({
      ...s.blocks.get(f1),
      kind: 'p',
      image: undefined,
      marks: normalizeMarks([
        { t: cardMarkT(card), from: 0, to: 11 },
        { t: cardMarkT(other), from: 4, to: 11 },
      ]),
    })
    expect('image' in (state.blocks.get(f1) as object)).toBe(false)
    expect(state.blocks.get(f2)).toMatchObject({ kind: 'p', text: '', marks: [] })
    expect(state.blocks.get(f3)).toMatchObject({ kind: 'p', text: 'A map', marks: [] })
    expect(state.blocks.get(f4)).toBe(s.blocks.get(f4))
    // The card is still named (by f1's mark): the book's list holds; the index counts it once.
    expect(state.books.get(book)?.cards).toEqual([card, other].sort())
    expect(cardCounts(state, book).get(card)).toBe(1)
    expect(validateInvariants(state)).toEqual([])
    expect(issues.map((i) => [i.kind, JSON.parse(i.raw ?? '').id])).toEqual([
      ['dangling-reference', shown],
      ['dangling-reference', f1],
      ['dangling-reference', f2],
      ['dangling-reference', f3],
    ])
    expect(issues[1]?.message).toBe(
      `block ${f1}: image asset ${shown} is missing; figure kept as its caption`,
    )
  })

  it('a card no block names any more leaves the book’s list', () => {
    const s = stateFromRecords(makeBoard(), [
      makeNote({ id: card, x: 0, y: 0 }),
      makeBook({ id: book, cards: [card] }),
      makeBlock({ id: f2, kind: 'figure', text: '', image: { assetId: shown, card } }),
    ])
    const { state, issues } = repairReferences(s)
    expect(state.blocks.get(f2)).toMatchObject({ kind: 'p', text: '', marks: [] })
    expect('cards' in (state.books.get(book) as object)).toBe(false)
    expect(validateInvariants(state)).toEqual([])
    expect(issues).toHaveLength(1)
  })

  it('a damaged load repairs it as it repairs a note', () => {
    const s = stateFromRecords(makeBoard(), [
      makeBook({ id: book }),
      makeBlock({ id: f3, kind: 'figure', text: 'A map', image: { assetId: shown } }),
    ])
    const { state, issues } = parseBoard(serializeBoard(s))
    expect(state?.blocks.get(f3)).toMatchObject({ kind: 'p', text: 'A map' })
    expect(issues.map((i) => i.kind)).toEqual(['dangling-reference'])
  })
})
