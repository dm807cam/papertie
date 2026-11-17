import {
  AssetRecordSchema,
  BoardLineSchema,
  BoardRecordSchema,
  ClientMarkSchema,
  EofRecordSchema,
  LIMITS,
  NoteRecordSchema,
  newId,
  YarnRecordSchema,
} from '../src/index'
import { fixtureId, makeAsset, makeBoard, makeNote, makeYarn, T0 } from './fixtures'

const n1 = fixtureId('note', 1)
const n2 = fixtureId('note', 2)

describe('fixtures', () => {
  it('fixtureId is deterministic, distinct and valid', () => {
    expect(fixtureId('note', 1)).toBe(fixtureId('note', 1))
    expect(fixtureId('note', 1)).not.toBe(fixtureId('note', 2))
    expect(fixtureId('note', 33)).not.toBe(fixtureId('note', 1))
  })
  it('make* builders parse', () => {
    expect(BoardRecordSchema.parse(makeBoard())).toEqual(makeBoard())
    expect(NoteRecordSchema.parse(makeNote())).toEqual(makeNote())
    expect(YarnRecordSchema.parse(makeYarn([n1, n2]))).toEqual(makeYarn([n1, n2]))
    expect(AssetRecordSchema.parse(makeAsset())).toEqual(makeAsset())
  })
})

describe('NoteRecordSchema', () => {
  const bad = (over: Record<string, unknown>) =>
    NoteRecordSchema.safeParse({ ...makeNote(), ...over }).success
  it('rejects Infinity (JSON 1e400)', () => {
    expect(bad({ x: Infinity })).toBe(false)
    const parsed = JSON.parse('{"x":1e400}') as { x: number }
    expect(bad({ x: parsed.x })).toBe(false)
  })
  it('rejects NaN', () => expect(bad({ y: Number.NaN })).toBe(false))
  it('enforces maxCoord', () => {
    expect(bad({ x: LIMITS.maxCoord })).toBe(true)
    expect(bad({ x: LIMITS.maxCoord + 1 })).toBe(false)
    expect(bad({ y: -LIMITS.maxCoord - 1 })).toBe(false)
  })
  it('enforces size bounds', () => {
    expect(bad({ w: -5 })).toBe(false)
    expect(bad({ w: LIMITS.noteMinW - 1 })).toBe(false)
    expect(bad({ w: LIMITS.noteMaxW + 1 })).toBe(false)
    expect(bad({ h: LIMITS.noteMinH - 1 })).toBe(false)
    expect(bad({ h: LIMITS.noteMaxH + 1 })).toBe(false)
    expect(bad({ w: LIMITS.noteMinW, h: LIMITS.noteMaxH })).toBe(true)
  })
  it('rejects non-integer z', () => expect(bad({ z: 1.5 })).toBe(false))
  it('rejects unknown paper / style', () => {
    expect(bad({ paper: 'neon' })).toBe(false)
    expect(bad({ style: 'glossy' })).toBe(false)
  })
  it('rejects extra keys (strict)', () => expect(bad({ width: 10 })).toBe(false))
  it('enforces text length', () => {
    expect(bad({ text: 'a'.repeat(LIMITS.maxTextLength) })).toBe(true)
    expect(bad({ text: 'a'.repeat(LIMITS.maxTextLength + 1) })).toBe(false)
  })
  it('rejects an id with the wrong prefix', () => expect(bad({ id: newId('yarn') })).toBe(false))
  it('rejects non-Z timestamps', () => {
    expect(bad({ createdAt: '2026-10-27T10:00:00+02:00' })).toBe(false)
    expect(bad({ updatedAt: '2026-10-27' })).toBe(false)
    expect(bad({ createdAt: '2026-10-27T10:00:00Z' })).toBe(true)
  })
  it('validates image', () => {
    const assetId = fixtureId('asset', 1)
    expect(bad({ image: { assetId, frame: 'print' } })).toBe(true)
    expect(bad({ image: { assetId, frame: 'gold' } })).toBe(false)
    expect(bad({ image: { assetId: n1, frame: 'none' } })).toBe(false)
    expect(bad({ image: { assetId, frame: 'none', extra: 1 } })).toBe(false)
    expect(bad({ image: undefined })).toBe(false)
  })
})

describe('YarnRecordSchema', () => {
  const bad = (noteIds: string[], over: Record<string, unknown> = {}) =>
    YarnRecordSchema.safeParse(makeYarn(noteIds, over as never)).success
  it('requires at least 2 notes', () => {
    expect(bad([n1])).toBe(false)
    expect(bad([])).toBe(false)
    expect(bad([n1, n2])).toBe(true)
  })
  it('rejects duplicate note ids', () => expect(bad([n1, n1])).toBe(false))
  it('caps at maxThreadNotes', () => {
    const ids = (k: number) => Array.from({ length: k }, (_, i) => fixtureId('note', i + 1))
    expect(bad(ids(LIMITS.maxThreadNotes))).toBe(true)
    expect(bad(ids(LIMITS.maxThreadNotes + 1))).toBe(false)
  })
  it('rejects non-note ids in noteIds', () => expect(bad([n1, fixtureId('yarn', 2)])).toBe(false))
  it('limits label to maxLabelLength, empty allowed', () => {
    expect(bad([n1, n2], { label: '' })).toBe(true)
    expect(bad([n1, n2], { label: 'x'.repeat(LIMITS.maxLabelLength) })).toBe(true)
    expect(bad([n1, n2], { label: 'x'.repeat(81) })).toBe(false)
  })
  it('rejects unknown colour and extra keys', () => {
    expect(bad([n1, n2], { color: 'neon' })).toBe(false)
    expect(bad([n1, n2], { extra: 1 })).toBe(false)
  })
})

describe('BoardRecordSchema / ClientMarkSchema', () => {
  it('validates name length', () => {
    expect(BoardRecordSchema.safeParse(makeBoard({ name: '' })).success).toBe(false)
    expect(BoardRecordSchema.safeParse(makeBoard({ name: 'x'.repeat(120) })).success).toBe(true)
    expect(BoardRecordSchema.safeParse(makeBoard({ name: 'x'.repeat(121) })).success).toBe(false)
  })
  it('requires schemaVersion 6 and revision >= 0', () => {
    expect(BoardRecordSchema.safeParse({ ...makeBoard(), schemaVersion: 5 }).success).toBe(false)
    expect(BoardRecordSchema.safeParse({ ...makeBoard(), schemaVersion: 7 }).success).toBe(false)
    expect(BoardRecordSchema.safeParse(makeBoard({ revision: -1 })).success).toBe(false)
  })
  it('validates clients map', () => {
    const mark = { lastSeq: 3, lastRevision: 4, seenAt: T0 }
    const tab = fixtureId('tab', 1)
    expect(ClientMarkSchema.safeParse(mark).success).toBe(true)
    expect(BoardRecordSchema.safeParse(makeBoard({ clients: { [tab]: mark } })).success).toBe(true)
    expect(
      BoardRecordSchema.safeParse(makeBoard({ clients: { [tab]: { ...mark, lastSeq: -1 } } }))
        .success,
    ).toBe(false)
    expect(BoardRecordSchema.safeParse(makeBoard({ clients: { 'not-an-id': mark } })).success).toBe(
      false,
    )
    expect(ClientMarkSchema.safeParse({ ...mark, extra: 1 }).success).toBe(false)
  })
})

describe('AssetRecordSchema', () => {
  const bad = (over: Record<string, unknown>) =>
    AssetRecordSchema.safeParse({ ...makeAsset(), ...over }).success
  it('is webp only with positive ints and lowercase sha256', () => {
    expect(bad({ mime: 'image/png' })).toBe(false)
    expect(bad({ width: 0 })).toBe(false)
    expect(bad({ height: 1.5 })).toBe(false)
    expect(bad({ bytes: 0 })).toBe(false)
    expect(bad({ sha256: 'A'.repeat(64) })).toBe(false)
    expect(bad({ sha256: 'a'.repeat(63) })).toBe(false)
    expect(bad({ extra: 1 })).toBe(false)
  })
})

describe('EofRecordSchema', () => {
  it('validates fields', () => {
    const eof = { type: 'eof', revision: 5, records: 10, sha256: 'b'.repeat(64) }
    expect(EofRecordSchema.safeParse(eof).success).toBe(true)
    expect(EofRecordSchema.safeParse({ ...eof, records: -1 }).success).toBe(false)
    expect(EofRecordSchema.safeParse({ ...eof, sha256: 'zz' }).success).toBe(false)
    expect(EofRecordSchema.safeParse({ ...eof, extra: 1 }).success).toBe(false)
  })
})

describe('BoardLineSchema', () => {
  it('dispatches on type', () => {
    const eof = { type: 'eof', revision: 0, records: 0, sha256: 'c'.repeat(64) }
    for (const line of [makeBoard(), makeNote(), makeYarn([n1, n2]), makeAsset(), eof]) {
      const r = BoardLineSchema.parse(line)
      expect(r.type).toBe(line.type)
    }
  })
  it('rejects unknown type and a record validated against the wrong shape', () => {
    expect(BoardLineSchema.safeParse({ ...makeNote(), type: 'sticker' }).success).toBe(false)
    expect(BoardLineSchema.safeParse({ ...makeNote(), type: 'yarn' }).success).toBe(false)
    expect(BoardLineSchema.safeParse({ ...makeNote(), x: Infinity }).success).toBe(false)
    expect(BoardLineSchema.safeParse(null).success).toBe(false)
  })
})
