import fc from 'fast-check'
import {
  type BoardState,
  CURRENT_SCHEMA_VERSION,
  type LoadIssue,
  parseBoard,
  repairReferences,
  serializeBoard,
  stateFromRecords,
} from '../src/index'
import { fixtureId, makeAsset, makeBoard, makeNote, makeYarn } from './fixtures'

const n = (i: number) => fixtureId('note', i)
const assetId = fixtureId('asset', 1)

/** 3 notes (one backed by an asset image) and a 3-note yarn. */
function fixtureState(): BoardState {
  return stateFromRecords(makeBoard({ revision: 4 }), [
    makeAsset({ id: assetId }),
    makeNote({ id: n(1), z: 0, text: 'first' }),
    makeNote({ id: n(2), z: 1, text: 'second', image: { assetId, frame: 'print' } }),
    makeNote({ id: n(3), z: 2, text: 'third' }),
    makeYarn([n(1), n(2), n(3)], { label: 'supports' }),
  ])
}

/** Same as fixtureState but without the asset, so the notes sit on lines 2, 3 and 4. */
function noAssetState(): BoardState {
  return stateFromRecords(makeBoard(), [
    makeNote({ id: n(1), z: 0, text: 'first' }),
    makeNote({ id: n(2), z: 1, text: 'second' }),
    makeNote({ id: n(3), z: 2, text: 'third' }),
    makeYarn([n(1), n(2), n(3)]),
  ])
}

/** Physical lines of a serialized board, without the trailing empty string. */
function linesOf(text: string): string[] {
  return text.slice(0, -1).split('\n')
}

const kinds = (issues: LoadIssue[]) => issues.map((i) => i.kind)

/** `text` with the first byte of line 1 (the board's `{`) flipped, so the board line is not JSON. */
function flipBoardByte(text: string): string {
  return `${String.fromCharCode(text.charCodeAt(0) ^ 0x01)}${text.slice(1)}`
}

describe('parseBoard fallbackBoard', () => {
  const fallbackBoard = makeBoard({ name: 'Recovered board', revision: 9 })

  it('without the option, a corrupt board line still gives state null', () => {
    const r = parseBoard(flipBoardByte(serializeBoard(fixtureState())))
    expect(r.state).toBeNull()
    expect(kinds(r.issues)).toEqual(['invalid-json', 'missing-board'])
    expect(r.integrity).toBe('checksum-mismatch')
  })

  it('loads every valid record under the fallback when the board line is corrupt', () => {
    const s = fixtureState()
    const r = parseBoard(flipBoardByte(serializeBoard(s)), { fallbackBoard })
    expect(r.state).toEqual({ ...s, board: fallbackBoard })
    expect(r.issues).toEqual([
      expect.objectContaining({ line: 1, kind: 'invalid-json' }),
      expect.objectContaining({ line: 0, kind: 'missing-board' }),
    ])
    expect(r.integrity).toBe('checksum-mismatch')
  })

  it('loads under the fallback when the board line is missing', () => {
    const s = fixtureState()
    const r = parseBoard(linesOf(serializeBoard(s)).slice(1).join('\n'), { fallbackBoard })
    expect(r.state).toEqual({ ...s, board: fallbackBoard })
    expect(kinds(r.issues)).toEqual(['missing-board'])
    expect(r.integrity).toBe('count-mismatch')
  })

  it('loads under the fallback when the board line fails the schema, and still repairs', () => {
    const lines = linesOf(serializeBoard(fixtureState()))
    lines[0] = (lines[0] as string).replace('"name":"Test board"', '"name":""')
    lines.splice(1, 1) // drop the asset: the image reference dangles
    const r = parseBoard(lines.join('\n'), { fallbackBoard })
    expect(r.state?.board).toEqual(fallbackBoard)
    expect(r.state?.notes.size).toBe(3)
    expect(r.state?.notes.get(n(2))?.image).toBeNull()
    expect(r.state?.yarns.size).toBe(1)
    expect(kinds(r.issues)).toEqual(['invalid-record', 'missing-board', 'dangling-reference'])
  })

  it('ignores the fallback when the file has a valid board', () => {
    const s = fixtureState()
    expect(parseBoard(serializeBoard(s), { fallbackBoard })).toEqual({
      state: s,
      issues: [],
      integrity: 'ok',
    })
  })

  it('an unsupported version still gives state null with only that issue', () => {
    const text = serializeBoard(fixtureState()).replace('"schemaVersion":6', '"schemaVersion":7')
    const r = parseBoard(text, { fallbackBoard })
    expect(r.state).toBeNull()
    expect(kinds(r.issues)).toEqual(['unsupported-version'])
  })

  it('an invalid fallback board is not used', () => {
    const bad = { ...fallbackBoard, id: 'nope' }
    const r = parseBoard(flipBoardByte(serializeBoard(fixtureState())), { fallbackBoard: bad })
    expect(r.state).toBeNull()
    expect(kinds(r.issues)).toEqual(['invalid-json', 'missing-board'])
  })
})

describe('CURRENT_SCHEMA_VERSION', () => {
  it('is 5', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(6)
  })
})

describe('parseBoard', () => {
  it('round-trips a serialized board exactly', () => {
    const s = fixtureState()
    expect(parseBoard(serializeBoard(s))).toEqual({ state: s, issues: [], integrity: 'ok' })
  })

  it('loads a truncated file: missing-eof, invalid-json at line 4, other notes kept', () => {
    const text = serializeBoard(noAssetState())
    const lines = linesOf(text)
    const third = lines[3] as string
    expect(third).toContain(n(3))
    const truncated = `${lines.slice(0, 3).join('\n')}\n${third.slice(0, Math.floor(third.length / 2))}`

    const r = parseBoard(truncated)
    expect(r.integrity).toBe('missing-eof')
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]).toMatchObject({ line: 4, kind: 'invalid-json' })
    expect(r.issues[0]?.raw).toBe(third.slice(0, Math.floor(third.length / 2)))
    expect([...(r.state?.notes.keys() ?? [])]).toEqual([n(1), n(2)])
    expect(r.state?.yarns.size).toBe(0)
  })

  it('flags an edited body as checksum-mismatch and loads the edited text', () => {
    const text = serializeBoard(fixtureState())
    const edited = text.replace('"text":"first"', '"text":"firsT"')
    expect(edited).not.toBe(text)
    const r = parseBoard(edited)
    expect(r.integrity).toBe('checksum-mismatch')
    expect(r.issues).toEqual([])
    expect(r.state?.notes.get(n(1))?.text).toBe('firsT')
  })

  it('treats BOM, CRLF and trailing blank lines as encoding-only edits (integrity ok)', () => {
    const s = fixtureState()
    const text = `\uFEFF${serializeBoard(s).replace(/\n/g, '\r\n')}\r\n\r\n`
    const r = parseBoard(text)
    expect(r.issues.filter((i) => i.kind.startsWith('invalid-'))).toEqual([])
    expect(r.issues).toEqual([])
    expect(r.integrity).toBe('ok')
    expect(r.state).toEqual(s)
  })

  it('loads a sketch of a board without throwing: 4 invalid-record + missing-board', () => {
    const example = [
      '{"type":"board","id":"main","schemaVersion":6,"name":"My Board"}',
      '{"type":"note","id":"note_01","x":240,"y":160,"color":"rose","text":"An idea"}',
      '{"type":"note","id":"note_02","x":540,"y":310,"color":"indigo","text":"A related thought"}',
      '{"type":"yarn","id":"yarn_01","noteIds":["note_01","note_02"],"color":"apricot","label":"supports"}',
    ]
    const r = parseBoard(example.join('\n'))
    expect(r.state).toBeNull()
    expect(r.integrity).toBe('missing-eof')
    const invalid = r.issues.filter((i) => i.kind === 'invalid-record')
    expect(invalid.map((i) => i.line)).toEqual([1, 2, 3, 4])
    expect(invalid.map((i) => i.raw)).toEqual(example)
    expect(kinds(r.issues).filter((k) => k === 'missing-board')).toHaveLength(1)
    expect(r.issues).toHaveLength(5)
  })

  it.each(['', '   \n', '\n\n'])('treats empty input %j as missing board and missing eof', (t) => {
    const r = parseBoard(t)
    expect(r.state).toBeNull()
    expect(kinds(r.issues)).toEqual(['missing-board'])
    expect(r.integrity).toBe('missing-eof')
  })

  it('reports an unknown record type with its raw text', () => {
    const lines = linesOf(serializeBoard(fixtureState()))
    const sticker = '{"type":"sticker"}'
    lines.splice(2, 0, sticker)
    const r = parseBoard(lines.join('\n'))
    expect(r.issues).toEqual([
      expect.objectContaining({ line: 3, kind: 'unknown-type', raw: sticker }),
    ])
    expect(r.state?.notes.size).toBe(3)
  })

  it.each([['42'], ['[1,2]'], ['null'], ['"note"'], ['{"no":"type"}'], ['{"type":7}']])(
    'reports valid JSON that is not a typed object (%s) as invalid-record',
    (raw) => {
      const lines = linesOf(serializeBoard(fixtureState()))
      lines.splice(1, 0, raw)
      const r = parseBoard(lines.join('\n'))
      expect(r.issues).toEqual([expect.objectContaining({ line: 2, kind: 'invalid-record', raw })])
    },
  )

  it('reports invalid JSON with its raw text and line number', () => {
    const lines = linesOf(serializeBoard(fixtureState()))
    lines.splice(1, 0, '{"type":"note",')
    const r = parseBoard(lines.join('\n'))
    expect(r.issues).toEqual([
      expect.objectContaining({ line: 2, kind: 'invalid-json', raw: '{"type":"note",' }),
    ])
    expect(r.state?.notes.size).toBe(3)
  })

  it('keeps the first of two notes with the same id and reports the second', () => {
    const lines = linesOf(serializeBoard(fixtureState()))
    const firstIdx = lines.findIndex((l) => l.includes(`"id":"${n(1)}"`))
    const dup = (lines[firstIdx] as string).replace('"text":"first"', '"text":"impostor"')
    lines.splice(firstIdx + 1, 0, dup)
    const r = parseBoard(lines.join('\n'))
    expect(r.state?.notes.get(n(1))?.text).toBe('first')
    expect(r.issues).toEqual([
      expect.objectContaining({ line: firstIdx + 2, kind: 'duplicate-id', raw: dup }),
    ])
  })

  it('keeps the first board line and reports a second one', () => {
    const lines = linesOf(serializeBoard(fixtureState()))
    const second = JSON.stringify(makeBoard({ name: 'Other' }))
    lines.splice(1, 0, second)
    const r = parseBoard(lines.join('\n'))
    expect(r.state?.board.name).toBe('Test board')
    expect(r.issues).toEqual([
      expect.objectContaining({ line: 2, kind: 'duplicate-id', raw: second }),
    ])
  })

  it.each([
    ['an older', 5],
    ['a newer', 7],
  ])('refuses %s schema version: state null, unsupported-version, nothing loaded', (_, v) => {
    const text = serializeBoard(fixtureState()).replace('"schemaVersion":6', `"schemaVersion":${v}`)
    const r = parseBoard(text)
    expect(r.state).toBeNull()
    expect(r.issues).toEqual([expect.objectContaining({ line: 1, kind: 'unsupported-version' })])
    expect(r.issues[0]?.raw).toContain(`"schemaVersion":${v}`)
  })

  it('flags lines after eof as content-after-eof and count-mismatch, without loading them', () => {
    const extraNote = JSON.stringify(makeNote({ id: n(9) }))
    const text = `${serializeBoard(fixtureState())}${extraNote}\ngarbage\n`
    const r = parseBoard(text)
    expect(r.integrity).toBe('count-mismatch')
    expect(r.issues).toEqual([
      expect.objectContaining({ line: 8, kind: 'content-after-eof', raw: extraNote }),
      expect.objectContaining({ line: 9, kind: 'content-after-eof', raw: 'garbage' }),
    ])
    expect(r.state?.notes.has(n(9))).toBe(false)
    expect(r.state?.notes.size).toBe(3)
  })

  it('reports count-mismatch when eof.records disagrees with the lines before it', () => {
    const lines = linesOf(serializeBoard(fixtureState()))
    lines.splice(1, 1) // drop the asset line; the note image then dangles
    const r = parseBoard(lines.join('\n'))
    expect(r.integrity).toBe('count-mismatch')
  })

  it('does not treat a schema-invalid eof line as the end of the file', () => {
    const lines = linesOf(serializeBoard(fixtureState()))
    const badEof = '{"type":"eof","revision":0,"records":1,"sha256":"nope"}'
    lines.splice(1, 0, badEof)
    const r = parseBoard(lines.join('\n'))
    expect(r.issues).toEqual([
      expect.objectContaining({ line: 2, kind: 'invalid-record', raw: badEof }),
    ])
    expect(r.state?.notes.size).toBe(3)
    expect(r.integrity).toBe('count-mismatch')
  })

  it('repairs dangling yarn references: [a,b,ghost] -> [a,b]; [a,ghost] dropped', () => {
    const a = n(1)
    const b = n(2)
    const ghost = n(99)
    const keep = makeYarn([a, b, ghost], { id: fixtureId('yarn', 1) })
    const drop = makeYarn([a, ghost], { id: fixtureId('yarn', 2) })
    const s = stateFromRecords(makeBoard(), [
      makeNote({ id: a }),
      makeNote({ id: b, z: 1 }),
      keep,
      drop,
    ])
    const r = parseBoard(serializeBoard(s))
    expect(r.integrity).toBe('ok')
    expect(r.state?.yarns.get(keep.id)?.noteIds).toEqual([a, b])
    expect(r.state?.yarns.has(drop.id)).toBe(false)
    expect(r.issues).toEqual([
      expect.objectContaining({ line: 0, kind: 'dangling-reference', raw: JSON.stringify(keep) }),
      expect.objectContaining({ line: 0, kind: 'dangling-reference', raw: JSON.stringify(drop) }),
    ])
  })

  it('orders issues by line, with line-0 file-level issues and repairs last', () => {
    const lines = linesOf(serializeBoard(fixtureState()))
    lines.splice(1, 1) // drop the asset -> dangling image repair
    lines.splice(2, 0, 'not json') // line 3
    lines.splice(1, 0, '{"type":"sticker"}') // line 2
    const r = parseBoard(lines.join('\n'))
    expect(r.issues.map((i) => [i.line, i.kind])).toEqual([
      [2, 'unknown-type'],
      [4, 'invalid-json'],
      [0, 'dangling-reference'],
    ])
  })

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const r = parseBoard(s)
        expect(Array.isArray(r.issues)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  it('never throws and never drops a line silently when lines are mutated', () => {
    const base = linesOf(serializeBoard(fixtureState()))
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(base.length - 1), fc.string({ maxLength: 20 }))),
        (muts) => {
          const lines = [...base]
          for (const [i, junk] of muts) {
            const l = lines[i] as string
            const at = Math.min(junk.length, l.length)
            lines[i] = l.slice(0, at) + junk + l.slice(at)
          }
          const r = parseBoard(lines.join('\n'))
          // With state null (no board / newer schema) nothing is loaded and the caller keeps
          // the whole file. Otherwise every non-blank line is loaded, the eof, or reported.
          if (!r.state) return
          const s = r.state
          const reported = new Set(r.issues.filter((i) => i.line > 0).map((i) => i.line))
          const droppedYarns = r.issues.filter((i) => {
            if (i.kind !== 'dangling-reference') return false
            const rec = JSON.parse(i.raw) as { type: string; id: string }
            return rec.type === 'yarn' && !s.yarns.has(rec.id)
          }).length
          const loaded = 1 + s.assets.size + s.notes.size + s.yarns.size + droppedYarns
          const eofCount = r.integrity === 'missing-eof' ? 0 : 1
          const nonBlank = lines.filter((l) => l.trim() !== '').length
          expect(loaded + reported.size + eofCount).toBe(nonBlank)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('repairReferences', () => {
  it('nulls an image whose asset is missing and reports the original note', () => {
    const note = makeNote({ id: n(1), image: { assetId, frame: 'none' } })
    const s = stateFromRecords(makeBoard(), [note])
    const r = repairReferences(s)
    expect(r.state.notes.get(n(1))?.image).toBeNull()
    expect(r.issues).toEqual([
      expect.objectContaining({ line: 0, kind: 'dangling-reference', raw: JSON.stringify(note) }),
    ])
  })

  it('leaves a consistent state untouched with no issues', () => {
    const s = fixtureState()
    const r = repairReferences(s)
    expect(r.state).toEqual(s)
    expect(r.issues).toEqual([])
  })
})
