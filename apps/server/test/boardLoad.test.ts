import {
  type Asset,
  type Block,
  type BoardState,
  type Book,
  computeEof,
  emptyBoardState,
  IMAGE_FRAMES,
  type Note,
  newId,
  parseBoard,
  serializeBoard,
  stateFromRecords,
  threadsOf,
  type Yarn,
} from '@papertie/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseBoardSliced } from '../src/store/boardLoad'
import { SLICE_MS, Slicer } from '../src/store/compact'

const AT = '2026-10-27T10:00:00.000Z'

/** A small board with everything a reference can point at: a photo, threads, pins. */
function smallBoard(): BoardState {
  const board = emptyBoardState(newId('board'), 'Small', AT).board
  const asset: Asset = {
    type: 'asset',
    id: newId('asset'),
    mime: 'image/webp',
    width: 400,
    height: 300,
    bytes: 1234,
    sha256: 'a'.repeat(64),
    createdAt: AT,
  }
  const notes: Note[] = []
  for (let i = 0; i < 12; i++) {
    notes.push({
      type: 'note',
      id: newId('note'),
      x: i * 300,
      y: (i % 3) * 200,
      w: 240,
      h: 160,
      z: i,
      paper: 'cream',
      style: 'rustic',
      text: i % 4 === 0 ? `Knot ${i} — ü ✓ 😀` : `note ${i}`,
      image: i === 5 ? { assetId: asset.id, frame: IMAGE_FRAMES[0] } : null,
      createdAt: AT,
      updatedAt: AT,
    } as Note)
  }
  const yarns: Yarn[] = [0, 4, 8].map(
    (k) =>
      ({
        type: 'yarn',
        id: newId('yarn'),
        noteIds: [notes[k]?.id, notes[k + 1]?.id, notes[k + 2]?.id],
        color: 'apricot',
        label: `thread ${k}`,
        createdAt: AT,
        updatedAt: AT,
      }) as Yarn,
  )
  const book: Book = {
    type: 'book',
    id: newId('book'),
    title: 'Field notes',
    lang: 'en',
    shelfPos: 'V',
    cover: { seed: 9, ink: 'indigo', motif: 'overprint' },
    trashedAt: null,
    createdAt: AT,
    updatedAt: AT,
  }
  const blocks: Block[] = ['V', 'W'].map((pos) => ({
    type: 'block',
    id: newId('block'),
    bookId: book.id,
    pos,
    kind: 'p',
    text: `paragraph ${pos}`,
    marks: [{ t: 'b', from: 0, to: 4 }],
  }))
  return stateFromRecords(board, [asset, ...notes, ...yarns, book, ...blocks])
}

/** `parseBoardSliced` with the decode cut every `decodeBytes` bytes. */
async function sliced(bytes: Buffer, decodeBytes?: number, fallback?: BoardState['board']) {
  const s = await Slicer.start(SLICE_MS)
  return parseBoardSliced(bytes, s, {
    ...(decodeBytes ? { decodeBytes } : {}),
    ...(fallback ? { fallbackBoard: fallback } : {}),
  })
}

/** What `parseBoard` gives for the same bytes, as the server read them (`readFile(…, 'utf8')`). */
function expectSame(got: Awaited<ReturnType<typeof sliced>>, bytes: Buffer) {
  const want = parseBoard(bytes.toString('utf8'))
  expect(got.integrity).toBe(want.integrity)
  expect(got.issues).toEqual(want.issues)
  if (want.state === null) {
    expect(got.state).toBeNull()
    return
  }
  const s = got.state as BoardState
  expect(s.board).toEqual(want.state.board)
  // Map order is line order, which serialization and replicas rely on.
  for (const k of ['assets', 'notes', 'yarns', 'books', 'blocks'] as const) {
    expect([...s[k].entries()]).toEqual([...want.state[k].entries()])
  }
  for (const id of s.notes.keys()) {
    expect(threadsOf(s, id).map((y) => y.id)).toEqual(threadsOf(want.state, id).map((y) => y.id))
  }
}

describe('parseBoardSliced', () => {
  it('a clean file: the same state as parseBoard, and its eof record', async () => {
    const text = serializeBoard(smallBoard())
    const got = await sliced(Buffer.from(text))
    expectSame(got, Buffer.from(text))
    expect(got.integrity).toBe('ok')
    expect(got.issues).toEqual([])
    expect(
      got.state?.notes.get([...(got.state?.notes.keys() ?? [])][5] ?? '')?.image,
    ).not.toBeNull()
    const eof = JSON.parse(text.trimEnd().split('\n').at(-1) as string)
    expect(got.eof).toEqual(eof)
    // Cut into many pieces, most hashed as their bytes: still the same checksum.
    for (const cut of [1, 7, 64, 200, 1000]) {
      const piecewise = await sliced(Buffer.from(text), cut)
      expect(piecewise.integrity).toBe('ok')
      expectSame(piecewise, Buffer.from(text))
    }
  })

  it('a clean file edited by a byte anywhere is a checksum mismatch, however it is cut', async () => {
    const good = Buffer.from(serializeBoard(smallBoard()))
    for (const at of [10, 300, 1500, good.length - 200]) {
      const bytes = Buffer.from(good)
      // A digit or letter for another of its kind, so the line still parses.
      const c = bytes[at] as number
      bytes[at] = c >= 0x30 && c <= 0x38 ? c + 1 : c === 0x39 ? 0x30 : c
      for (const cut of [undefined, 1, 64, 700]) expectSame(await sliced(bytes, cut), bytes)
    }
  })

  it('BOM, CRLF, lone CRs, blank and whitespace lines, no final newline, cut anywhere', async () => {
    const lines = serializeBoard(smallBoard()).slice(0, -1).split('\n')
    const variants = [
      `﻿${lines.join('\n')}\n`,
      `${lines.join('\r\n')}\r\n`,
      `${lines.join('\n')}`,
      `\n\n${lines.join('\n\n')}\n \n \n\t\n`,
      `${lines.slice(0, 3).join('\n')}\r${lines.slice(3).join('\n')}\n`,
      `${lines.join('\n')}\r`,
      `\r\n${lines.join('\r\r\n')}`,
      '',
      '\n',
      '﻿',
    ]
    for (const text of variants) {
      const bytes = Buffer.from(text)
      for (const cut of [undefined, 1, 7, 64, 200]) expectSame(await sliced(bytes, cut), bytes)
    }
  })

  it('bytes that are not UTF-8 decode as a whole read decodes them', async () => {
    const good = Buffer.from(serializeBoard(smallBoard()))
    const nl = good.indexOf(0x0a, 400)
    for (const junk of [
      [0xff],
      [0xe7, 0xb5],
      [0xf0, 0x9f, 0x98],
      [0xc0, 0x80],
      [0xed, 0xa0, 0x80],
    ]) {
      // Just before a newline, so a cut there leaves the broken character at a piece's end.
      const bytes = Buffer.concat([good.subarray(0, nl), Buffer.from(junk), good.subarray(nl)])
      for (const cut of [undefined, 1, 3, 400]) expectSame(await sliced(bytes, cut), bytes)
    }
  })

  it('dangling references are repaired as parseBoard repairs them', async () => {
    const state = smallBoard()
    const text = serializeBoard(state)
    const asset = [...state.assets.keys()][0] as string
    const note = [...state.notes.keys()][1] as string
    const damaged = text
      .split('\n')
      .filter((l) => !l.includes(`"id":"${asset}"`) && !l.includes(`"id":"${note}"`))
      .join('\n')
    const got = await sliced(Buffer.from(damaged))
    expectSame(got, Buffer.from(damaged))
    expect(got.issues.filter((i) => i.kind === 'dangling-reference')).toHaveLength(2)
  })

  it('a footnote anchor whose footnote is gone is stripped quietly, as parseBoard strips it', async () => {
    const state = smallBoard()
    const [first] = [...state.blocks.values()] as [Block]
    const gone = newId('block')
    const kept = newId('block')
    const footnote: Block = {
      ...first,
      id: kept,
      pos: 'Vk',
      kind: 'footnote',
      text: 'Kept',
      marks: [],
    }
    const anchored: Block = {
      ...first,
      marks: [
        { t: 'b', from: 0, to: 4 },
        { t: `n:${gone}`, from: 0, to: 9 },
        { t: `n:${kept}`, from: 10, to: 11 },
      ],
    }
    const leftover = stateFromRecords(state.board, [
      ...state.assets.values(),
      ...state.notes.values(),
      ...state.yarns.values(),
      ...state.books.values(),
      anchored,
      footnote,
      ...[...state.blocks.values()].slice(1),
    ])
    // A file the server wrote: clean, its checksum vouching for every line.
    const bytes = Buffer.from(serializeBoard(leftover))
    const got = await sliced(bytes)
    expectSame(got, bytes)
    expect(got.integrity).toBe('ok')
    expect(got.issues).toEqual([])
    expect(got.state?.blocks.get(first.id)?.marks).toEqual([
      { t: 'b', from: 0, to: 4 },
      { t: `n:${kept}`, from: 10, to: 11 },
    ])
  })

  it('blocks whose book is missing are repaired away as parseBoard repairs them', async () => {
    const state = smallBoard()
    const book = [...state.books.keys()][0] as string
    const damaged = serializeBoard(state)
      .split('\n')
      .filter((l) => !l.includes(`"id":"${book}"`))
      .join('\n')
    const got = await sliced(Buffer.from(damaged))
    expectSame(got, Buffer.from(damaged))
    expect(got.issues.filter((i) => i.kind === 'dangling-reference')).toHaveLength(2)
    expect(got.state?.blocks.size).toBe(0)
  })

  it('a file with no board record loads under the fallback board, or not at all', async () => {
    const state = smallBoard()
    const text = serializeBoard(state).split('\n').slice(1).join('\n')
    const bytes = Buffer.from(text)
    expectSame(await sliced(bytes), bytes)
    const got = await sliced(bytes, undefined, state.board)
    const want = parseBoard(text, { fallbackBoard: state.board })
    expect(got.issues).toEqual(want.issues)
    expect([...(got.state?.notes.keys() ?? [])]).toEqual([...(want.state?.notes.keys() ?? [])])
  })

  it('agrees with parseBoard on any mutation of a board’s lines', async () => {
    const base = serializeBoard(smallBoard()).slice(0, -1).split('\n')
    const line = fc.nat(base.length - 1)
    const mutation = fc.oneof(
      fc.tuple(fc.constant('junk' as const), line, fc.string({ maxLength: 12, unit: 'binary' })),
      fc.tuple(fc.constant('drop' as const), line, fc.constant('')),
      fc.tuple(fc.constant('twice' as const), line, fc.constant('')),
      fc.tuple(fc.constant('blank' as const), line, fc.constantFrom('', ' ', '\r', '\t')),
      fc.tuple(fc.constant('crlf' as const), line, fc.constant('')),
    )
    await fc.assert(
      fc.asyncProperty(
        fc.array(mutation, { maxLength: 6 }),
        fc.constantFrom(undefined, 1, 13, 97, 511),
        async (muts, cut) => {
          const lines = [...base]
          for (const [kind, i, junk] of muts) {
            const l = lines[i] ?? ''
            if (kind === 'junk') {
              const at = Math.min(junk.length, l.length)
              lines[i] = l.slice(0, at) + junk + l.slice(at)
            } else if (kind === 'drop') lines.splice(i, 1)
            else if (kind === 'twice') lines.splice(i, 0, l)
            else if (kind === 'blank') lines.splice(i, 0, junk)
            else lines[i] = `${l}\r`
          }
          const bytes = Buffer.from(`${lines.join('\n')}\n`)
          expectSame(await sliced(bytes, cut), bytes)
        },
      ),
      { numRuns: 150 },
    )
  })
})

describe('a clean board.jsonl skips the per-record schema check', () => {
  /** This thread's CPU time for `fn`, ms. */
  const cpu = async (fn: () => Promise<unknown>) => {
    const t = process.threadCpuUsage()
    await fn()
    const d = process.threadCpuUsage(t)
    return (d.user + d.system) / 1000
  }
  const load = (bytes: Buffer) => parseBoardSliced(bytes, new Slicer(SLICE_MS))

  it('a file its eof checksum vouches for parses with a quarter less CPU, to the same state', async () => {
    const { hugeState } = await import('./helpers/boards')
    const state = hugeState(newId('board'), 100_000)
    const text = serializeBoard(state)
    const clean = Buffer.from(text, 'utf8')
    // One character of one note's text changed: still a valid record, but the checksum is off,
    // so every line must be checked (and the result is `parseBoard`'s).
    const at = text.indexOf('"text":"Note 5:') + 10
    const damaged = Buffer.from(`${text.slice(0, at)}X${text.slice(at + 1)}`, 'utf8')
    await load(clean)
    await load(damaged)
    const runs = { clean: [] as number[], damaged: [] as number[] }
    for (let i = 0; i < 3; i++) {
      runs.clean.push(await cpu(() => load(clean)))
      runs.damaged.push(await cpu(() => load(damaged)))
    }
    const best = (xs: number[]) => Math.min(...xs)
    console.info(
      `parse of 100,000 notes: clean ${best(runs.clean).toFixed(0)} ms CPU, a checksum off ` +
        `${best(runs.damaged).toFixed(0)} ms`,
    )
    const r = await load(clean)
    expect(r.integrity).toBe('ok')
    expect(r.issues).toEqual([])
    expect(serializeBoard(r.state as BoardState)).toBe(text)
    // The schema check was a quarter of the parse: the clean file must save at least that much
    // against one that pays for it (and, damaged, for a first pass too).
    expect(best(runs.clean)).toBeLessThanOrEqual(0.8 * best(runs.damaged))
  }, 120_000)

  it('a file whose checksum is off still has every record checked, as parseBoard does', async () => {
    const s = smallBoard()
    const text = serializeBoard(s)
    // A note that breaks the schema (no paper), and nothing else changed: the checksum is off.
    const id = [...s.notes.keys()][3] as string
    const broken = text.replace(new RegExp(`("id":"${id}"[^\\n]*?)"paper":"cream",`), '$1')
    expect(broken).not.toBe(text)
    const r = await load(Buffer.from(broken, 'utf8'))
    const whole = parseBoard(broken)
    expect(r.integrity).toBe('checksum-mismatch')
    expect(r.issues).toEqual(whole.issues)
    expect(r.issues.some((i) => i.kind === 'invalid-record')).toBe(true)
    expect(r.state?.notes.has(id)).toBe(false)
    expect(serializeBoard(r.state as BoardState)).toBe(serializeBoard(whole.state as BoardState))
  })

  /** `lines` (the body, no newlines) with an eof record that vouches for them. */
  const checksummed = (lines: string[], revision = 0) =>
    `${[...lines, JSON.stringify(computeEof(lines, revision))].join('\n')}\n`
  const bodyOf = (text: string) => text.trimEnd().split('\n').slice(0, -1)
  /** `parseBoardSliced` gives exactly `parseBoard`'s state, issues and integrity. */
  const sameAsParseBoard = async (
    text: string,
    options: { fallbackBoard?: BoardState['board'] } = {},
  ) => {
    const r = await parseBoardSliced(Buffer.from(text, 'utf8'), new Slicer(SLICE_MS), options)
    const whole = parseBoard(text, options)
    expect(r.integrity).toBe(whole.integrity)
    expect(r.issues).toEqual(whole.issues)
    expect(r.state === null).toBe(whole.state === null)
    if (r.state && whole.state) expect(serializeBoard(r.state)).toBe(serializeBoard(whole.state))
    return r
  }

  it('a checksum-valid file with an invalid board line: every record checked, under the fallback board', async () => {
    const s = smallBoard()
    const body = bodyOf(serializeBoard(s))
    // The board line breaks the schema (a name over 120 characters); a note breaks it too. The
    // eof vouches for these very lines, but this is no file the server wrote.
    const board = JSON.parse(body[0] as string)
    body[0] = JSON.stringify({ ...board, name: 'x'.repeat(200) })
    const id = [...s.notes.keys()][2] as string
    const i = body.findIndex((l) => l.includes(`"id":"${id}"`))
    body[i] = JSON.stringify({ ...JSON.parse(body[i] as string), paper: 'neon' })
    const text = checksummed(body)
    const r = await sameAsParseBoard(text, { fallbackBoard: s.board })
    expect(r.integrity).toBe('ok')
    expect(r.issues.filter((x) => x.kind === 'invalid-record')).toHaveLength(2)
    expect(r.issues.some((x) => x.kind === 'missing-board')).toBe(true)
    expect(r.state?.notes.has(id)).toBe(false)
  })

  it('a checksum-valid file with a duplicate id: the first valid record wins, as parseBoard has it', async () => {
    const s = smallBoard()
    const body = bodyOf(serializeBoard(s))
    const id = [...s.notes.keys()][4] as string
    const i = body.findIndex((l) => l.includes(`"id":"${id}"`))
    const good = body[i] as string
    // An invalid copy first, the valid one after it.
    body.splice(i, 1, JSON.stringify({ ...JSON.parse(good), w: -5 }), good)
    const r = await sameAsParseBoard(checksummed(body))
    expect(r.integrity).toBe('ok')
    expect(r.state?.notes.get(id)?.w).toBe(JSON.parse(good).w)
  })

  it('a checksum-valid file whose note carries a field this schema does not know: every record checked', async () => {
    // A newer build's field (written without a schema version bump), then a rollback to this one.
    const s = smallBoard()
    const body = bodyOf(serializeBoard(s))
    const id = [...s.notes.keys()][1] as string
    const i = body.findIndex((l) => l.includes(`"id":"${id}"`))
    body[i] = JSON.stringify({ ...JSON.parse(body[i] as string), sparkle: true })
    const r = await sameAsParseBoard(checksummed(body))
    expect(r.issues.filter((x) => x.kind === 'invalid-record')).toHaveLength(1)
    expect(r.state?.notes.has(id)).toBe(false)
    // An unknown key inside a note's image too.
    const photo = body.findIndex((l) => l.includes('"image":{'))
    const withImage = JSON.parse(body[photo] as string)
    body[i] = JSON.stringify((({ sparkle: _, ...n }) => n)(JSON.parse(body[i] as string)))
    body[photo] = JSON.stringify({ ...withImage, image: { ...withImage.image, crop: 1 } })
    const r2 = await sameAsParseBoard(checksummed(body))
    expect(r2.issues.filter((x) => x.kind === 'invalid-record')).toHaveLength(1)
  })

  it('records come before any board line: every record checked', async () => {
    const s = smallBoard()
    const body = bodyOf(serializeBoard(s))
    const id = [...s.notes.keys()][0] as string
    const i = body.findIndex((l) => l.includes(`"id":"${id}"`))
    const bad = JSON.stringify({ ...JSON.parse(body[i] as string), h: 1e9 })
    body.splice(i, 1)
    body.unshift(bad)
    const r = await sameAsParseBoard(checksummed(body))
    expect(r.issues.filter((x) => x.kind === 'invalid-record')).toHaveLength(1)
  })
})
