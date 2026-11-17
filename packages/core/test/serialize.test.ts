import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  computeEof,
  EofRecordSchema,
  emptyBoardState,
  serializeBoard,
  stateFromRecords,
} from '../src/index'
import { fixtureId, makeAsset, makeBoard, makeNote, makeYarn, T0 } from './fixtures'

const n = (i: number) => fixtureId('note', i)

function sampleState() {
  const notes = [
    makeNote({ id: n(1), z: 3 }),
    makeNote({ id: n(2), z: 1 }),
    makeNote({ id: n(3), z: 2 }),
  ]
  // assets and yarns deliberately in reverse id order
  const assets = [
    makeAsset({ id: fixtureId('asset', 2) }),
    makeAsset({ id: fixtureId('asset', 1) }),
  ]
  const yarns = [
    makeYarn([n(1), n(2)], { id: fixtureId('yarn', 2) }),
    makeYarn([n(2), n(3)], { id: fixtureId('yarn', 1) }),
  ]
  return stateFromRecords(makeBoard({ revision: 7 }), [...yarns, ...notes, ...assets])
}

describe('emptyBoardState', () => {
  it('builds a revision-0 board with no clients and empty maps', () => {
    const id = fixtureId('board', 9)
    const s = emptyBoardState(id, 'Fresh', T0)
    expect(s.board).toEqual({
      type: 'board',
      schemaVersion: 6,
      id,
      name: 'Fresh',
      revision: 0,
      clients: {},
      createdAt: T0,
      updatedAt: T0,
    })
    expect(s.assets.size).toBe(0)
    expect(s.notes.size).toBe(0)
    expect(s.yarns.size).toBe(0)
    expect(s.books.size).toBe(0)
    expect(s.blocks.size).toBe(0)
    expect(s.blocksHeld).toBe('all')
  })
})

describe('stateFromRecords', () => {
  it('indexes records by id into the right maps', () => {
    const s = sampleState()
    expect(s.assets.size).toBe(2)
    expect(s.notes.size).toBe(3)
    expect(s.yarns.size).toBe(2)
    expect(s.notes.get(n(2))?.z).toBe(1)
  })
})

describe('serializeBoard', () => {
  it('orders lines: board, assets by id, notes by (z, id), yarns by id, eof', () => {
    const lines = serializeBoard(sampleState()).split('\n')
    expect(lines.pop()).toBe('') // trailing newline
    const parsed = lines.map((l) => JSON.parse(l) as { type: string; id?: string })
    expect(parsed.map((r) => r.type)).toEqual([
      'board',
      'asset',
      'asset',
      'note',
      'note',
      'note',
      'yarn',
      'yarn',
      'eof',
    ])
    expect(parsed.filter((r) => r.type === 'asset').map((r) => r.id)).toEqual([
      fixtureId('asset', 1),
      fixtureId('asset', 2),
    ])
    expect(parsed.filter((r) => r.type === 'note').map((r) => r.id)).toEqual([n(2), n(3), n(1)])
    expect(parsed.filter((r) => r.type === 'yarn').map((r) => r.id)).toEqual([
      fixtureId('yarn', 1),
      fixtureId('yarn', 2),
    ])
  })

  it('breaks z ties by id', () => {
    const s = stateFromRecords(makeBoard(), [
      makeNote({ id: n(5), z: 0 }),
      makeNote({ id: n(4), z: 0 }),
    ])
    const ids = serializeBoard(s)
      .split('\n')
      .filter((l) => l.includes('"type":"note"'))
      .map((l) => (JSON.parse(l) as { id: string }).id)
    expect(ids).toEqual([n(4), n(5)])
  })

  it('ends with a newline and a valid eof whose record count matches', () => {
    const out = serializeBoard(sampleState())
    expect(out.endsWith('\n')).toBe(true)
    const lines = out.slice(0, -1).split('\n')
    const eof = EofRecordSchema.parse(JSON.parse(lines[lines.length - 1] as string))
    expect(eof.records).toBe(lines.length - 1)
    expect(eof.revision).toBe(7)
  })

  it('eof.sha256 equals an independently computed hash of the body', () => {
    const out = serializeBoard(sampleState())
    const lastNl = out.lastIndexOf('\n', out.length - 2)
    const body = out.slice(0, lastNl + 1)
    const eof = EofRecordSchema.parse(JSON.parse(out.slice(lastNl + 1)))
    expect(eof.sha256).toBe(bytesToHex(sha256(new TextEncoder().encode(body))))
    expect(eof.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps every physical line valid JSON for newlines, quotes and emoji text', () => {
    const text = 'Knot 🧵 "q"\nline2 x '
    const s = stateFromRecords(makeBoard(), [
      makeNote({ id: n(1), text }),
      makeNote({ id: n(2), text: 'a\u2028b\u2029c' }),
      makeYarn([n(1), n(2)], { label: 'supports' }),
    ])
    const out = serializeBoard(s)
    const lines = out.slice(0, -1).split('\n')
    expect(lines).toHaveLength(5) // board, 2 notes, yarn, eof
    const objs = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(objs[1]?.text).toBe(text)
    expect(objs[2]?.text).toBe('a\u2028b\u2029c')
    expect(objs[3]?.label).toBe('supports')
  })

  it('is deterministic', () => {
    const s = sampleState()
    expect(serializeBoard(s)).toBe(serializeBoard(s))
    expect(serializeBoard(sampleState())).toBe(serializeBoard(sampleState()))
  })

  it('serializes an empty board as board + eof', () => {
    const out = serializeBoard(emptyBoardState(fixtureId('board', 1), 'E', T0))
    const lines = out.slice(0, -1).split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1] as string)).toMatchObject({ type: 'eof', records: 1, revision: 0 })
  })
})

describe('computeEof', () => {
  it('hashes each line followed by \\n and counts lines', () => {
    const body = ['{"a":1}', '{"b":"é"}']
    const eof = computeEof(body, 3)
    expect(eof).toEqual({
      type: 'eof',
      revision: 3,
      records: 2,
      sha256: bytesToHex(sha256(new TextEncoder().encode('{"a":1}\n{"b":"é"}\n'))),
    })
    expect(EofRecordSchema.safeParse(eof).success).toBe(true)
  })

  it('handles an empty body', () => {
    const eof = computeEof([], 0)
    expect(eof.records).toBe(0)
    expect(eof.sha256).toBe(bytesToHex(sha256(new Uint8Array(0))))
  })
})
