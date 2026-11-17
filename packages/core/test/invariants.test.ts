import {
  type BoardState,
  emptyBoardState,
  type InvariantViolation,
  introducedViolations,
  LIMITS,
  type Note,
  stateFromRecords,
  validateInvariants,
} from '../src/index'
import { fixtureId, makeAsset, makeBoard, makeNote, makeYarn, T0 } from './fixtures'

const a = fixtureId('note', 1)
const b = fixtureId('note', 2)
const c = fixtureId('note', 3)
const ghost = fixtureId('note', 99)
const y1 = fixtureId('yarn', 1)
const assetId = fixtureId('asset', 1)
const boardId = fixtureId('board', 1)

function withNotes(...yarns: ReturnType<typeof makeYarn>[]): BoardState {
  return stateFromRecords(makeBoard(), [
    makeNote({ id: a }),
    makeNote({ id: b }),
    makeNote({ id: c }),
    ...yarns,
  ])
}

const kinds = (vs: InvariantViolation[]) => vs.map((v) => v.kind)

describe('validateInvariants', () => {
  it('every fixture state is clean', () => {
    expect(validateInvariants(emptyBoardState(boardId, 'Empty', T0))).toEqual([])
    expect(validateInvariants(withNotes())).toEqual([])
    expect(validateInvariants(withNotes(makeYarn([a, b, c], { id: y1 })))).toEqual([])
    expect(
      validateInvariants(
        stateFromRecords(makeBoard(), [
          makeAsset({ id: assetId }),
          makeNote({ id: a, image: { assetId, frame: 'print' } }),
        ]),
      ),
    ).toEqual([])
  })

  it('a thread with fewer than 2 notes is thread-too-short', () => {
    expect(validateInvariants(withNotes(makeYarn([a], { id: y1 })))).toEqual([
      { kind: 'thread-too-short', id: y1 },
    ])
  })

  it('a thread with a repeated note is thread-duplicate', () => {
    expect(validateInvariants(withNotes(makeYarn([a, b, a], { id: y1 })))).toEqual([
      { kind: 'thread-duplicate', id: y1 },
    ])
  })

  it('a thread referencing a missing note is missing-note', () => {
    expect(validateInvariants(withNotes(makeYarn([a, ghost], { id: y1 })))).toEqual([
      { kind: 'missing-note', id: y1 },
    ])
  })

  it('a note image whose asset is missing is missing-asset', () => {
    const s = stateFromRecords(makeBoard(), [
      makeNote({ id: a, image: { assetId, frame: 'print' } }),
    ])
    expect(validateInvariants(s)).toEqual([{ kind: 'missing-asset', id: a }])
  })

  it('more than maxNotes notes is too-many-notes', () => {
    const notes: Note[] = []
    for (let i = 1; i <= LIMITS.maxNotes + 1; i++)
      notes.push(makeNote({ id: fixtureId('note', i) }))
    expect(validateInvariants(stateFromRecords(makeBoard(), notes))).toEqual([
      { kind: 'too-many-notes', id: boardId },
    ])
  })

  it('a record keyed or prefixed wrongly is id-prefix', () => {
    const wrongPrefix = fixtureId('yarn', 7)
    const s = withNotes()
    const notes = new Map(s.notes)
    notes.set(wrongPrefix, makeNote({ id: wrongPrefix }))
    expect(validateInvariants({ ...s, notes })).toEqual([{ kind: 'id-prefix', id: wrongPrefix }])

    const mismatched = new Map(s.notes)
    mismatched.set(fixtureId('note', 50), makeNote({ id: fixtureId('note', 51) }))
    expect(validateInvariants({ ...s, notes: mismatched })).toEqual([
      { kind: 'id-prefix', id: fixtureId('note', 50) },
    ])

    const badBoard = { ...s, board: makeBoard({ id: fixtureId('note', 60) }) }
    expect(validateInvariants(badBoard)).toEqual([{ kind: 'id-prefix', id: fixtureId('note', 60) }])
  })

  it('reports several violations at once', () => {
    const s = withNotes(makeYarn([ghost], { id: y1 }))
    expect(kinds(validateInvariants(s)).sort()).toEqual(['missing-note', 'thread-too-short'])
  })
})

describe('introducedViolations', () => {
  const sound = withNotes(makeYarn([a, b], { id: y1 }))
  const dangling = withNotes(makeYarn([a, ghost], { id: y1 }))

  it('is empty when the result is sound, whatever the input', () => {
    expect(introducedViolations(dangling, sound)).toEqual([])
    expect(introducedViolations(sound, sound)).toEqual([])
  })

  it('ignores violations the input already had (same kind and id)', () => {
    expect(introducedViolations(dangling, dangling)).toEqual([])
    const renamed = { ...dangling, board: { ...dangling.board, name: 'Renamed' } }
    expect(introducedViolations(dangling, renamed)).toEqual([])
  })

  it('reports a new kind on a record that already had another kind', () => {
    const shortAndDangling = withNotes(makeYarn([ghost], { id: y1 }))
    expect(introducedViolations(dangling, shortAndDangling)).toEqual([
      { kind: 'thread-too-short', id: y1 },
    ])
  })

  it('reports an existing kind on a new record', () => {
    const y2 = fixtureId('yarn', 2)
    const twoDangling = withNotes(
      makeYarn([a, ghost], { id: y1 }),
      makeYarn([b, ghost], { id: y2 }),
    )
    expect(introducedViolations(dangling, twoDangling)).toEqual([{ kind: 'missing-note', id: y2 }])
  })
})
