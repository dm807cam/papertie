import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Block,
  emptyBoardState,
  newId,
  posKeysBetween,
  stateFromRecords,
} from '@papertie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportBook } from '../src/export/bookExport'
import { bookMarkdown } from '../src/export/bookMarkdown'
import { bookDocx } from '../src/export/docx'
import { serverId } from '../src/ids'
import { createLogger } from '../src/log'
import { boardDir, createBoard, noteCreate, postOps, tabNow } from './helpers/boards'
import { blockCreate, blockRecord, bookCreate, bookRecord, genBookRecords } from './helpers/books'
import type { TestUser } from './helpers/client'
import { FakeClock } from './helpers/clock'
import { startTestServer, type TestServer } from './helpers/harness'
import { png } from './helpers/images'
import { assertWellFormed } from './helpers/xml'
import { readZip } from './helpers/zip'

/** Book export, Markdown and Word. */

const T0 = '2026-11-13T10:00:00.000Z'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

let server: TestServer
let user: TestUser
let board: string
let assetId: string
let noteId: string
let seq = 0
let revision = 0

async function post(ops: unknown[]) {
  const res = await postOps(user, board, {
    clientId: tabNow(server),
    seq: ++seq,
    baseRevision: revision,
    ops,
  })
  expect(res.status, await res.clone().text()).toBe(200)
  revision = ((await res.json()) as { revision: number }).revision
}

/** The blocks of a book in order, `pos` given by place. */
function inOrder(bookId: string, specs: Array<Partial<Block> & { text: string }>): Block[] {
  const keys = posKeysBetween(null, null, specs.length)
  return specs.map((s, i) => blockRecord(bookId, keys[i] as string, s.text, s))
}

const fnA = newId('block')
const fnB = newId('block')
const fnOrphan = newId('block')

/** The book of the first rows: every kind, two footnotes and an orphan, a prompt and a card mark. */
function sampleBlocks(bookId: string, figureAsset: string, cardNote: string): Block[] {
  return inOrder(bookId, [
    { kind: 'h1', text: 'Chapter One' },
    {
      text: 'Some bold and italic words.',
      marks: [
        { t: 'b', from: 5, to: 9 },
        { t: 'i', from: 14, to: 20 },
        { t: `n:${fnA}`, from: 21, to: 26 },
      ],
    },
    { id: fnA, kind: 'footnote', text: 'Thoreau, Walden, 1854, p. 12' },
    { kind: 'h2', text: 'A section' },
    {
      kind: 'quote',
      text: 'To be awake is to be alive.',
      marks: [{ t: `n:${fnB}`, from: 0, to: 27 }],
    },
    { id: fnB, kind: 'footnote', text: 'See https://example.com/walden for more' },
    { kind: 'li', text: 'first item' },
    { kind: 'li', text: 'second item' },
    { kind: 'figure', text: 'A photo caption', image: { assetId: figureAsset } },
    { kind: 'prompt', text: 'PROMPT-NEVER-EXPORTED write more here' },
    { text: 'Card passage text', marks: [{ t: `c:${cardNote}`, from: 0, to: 4 }] },
    { id: fnOrphan, kind: 'footnote', text: 'ORPHAN-NEVER-EXPORTED' },
  ])
}

const EXPECTED_MD = (asset: string) => `# Walden, Revisited

## Chapter One

Some **bold** and *italic* words[^1].

### A section

> To be awake is to be alive.[^2]

- first item
- second item

![A photo caption](images/${asset}.webp)
A photo caption

Card passage text

[^1]: Thoreau, Walden, 1854, p. 12
[^2]: See https://example.com/walden for more
`

let bookId: string
let trashedId: string

beforeAll(async () => {
  server = await startTestServer({ clock: new FakeClock(T0) })
  user = server.user
  board = await createBoard(user, 'Export')
  const form = new FormData()
  form.append('file', new File([new Uint8Array(await png(64, 48))], 'p.png', { type: 'image/png' }))
  const up = await user.request(`/api/boards/${board}/assets`, { method: 'POST', body: form })
  expect(up.status).toBe(201)
  assetId = ((await up.json()) as { asset: { id: string } }).asset.id
  const res = await user.request(`/api/boards/${board}/meta`)
  revision = ((await res.json()) as { revision: number }).revision

  noteId = newId('note')
  const book = bookRecord({ title: 'Walden, Revisited' })
  bookId = book.id
  const blocks = sampleBlocks(book.id, assetId, noteId)
  // Footnotes first: an anchor names a footnote the batch has made already.
  const footnotes = blocks.filter((b) => b.kind === 'footnote')
  const rest = blocks.filter((b) => b.kind !== 'footnote')
  await post([
    noteCreate({ id: noteId, at: T0, text: 'a card' }),
    bookCreate(book),
    ...footnotes.map(blockCreate),
    ...rest.map(blockCreate),
  ])

  const trashed = bookRecord({ title: 'Gone', shelfPos: 'W' })
  trashedId = trashed.id
  await post([bookCreate(trashed), blockCreate(blockRecord(trashed.id, 'V', 'gone text'))])
  await post([{ op: 'book.update', id: trashed.id, set: { trashedAt: T0 } }])
})

afterAll(() => server?.close())

const exportUrl = (book: string, format: string) =>
  `/api/boards/${board}/books/${book}/export?format=${format}`

describe('book export: Markdown', () => {
  it('markdown: headings, emphasis, a quote, a list, a figure and two footnotes, in order', async () => {
    const res = await user.request(exportUrl(bookId, 'md'))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="walden-revisited.zip"',
    )
    expect(res.headers.get('cache-control')).toBe('no-store')
    const entries = readZip(Buffer.from(await res.arrayBuffer()))
    expect(entries.map((e) => e.name)).toEqual(['walden-revisited.md', `images/${assetId}.webp`])
    expect(entries[0]?.data.toString('utf8')).toBe(EXPECTED_MD(assetId))
    // The 2560 variant, as stored.
    expect(entries[1]?.data.subarray(8, 12).toString('latin1')).toBe('WEBP')
  })

  it('markdown escapes *, _, [ and # in text', () => {
    const book = bookRecord()
    const blocks = inOrder(book.id, [
      { text: 'a*b_c [d] #e and \\ `x` <y>' },
      { text: '# not a heading' },
      { text: '- not a list' },
      { text: '1. not a list either' },
      { kind: 'h1', text: 'Star *power*' },
    ])
    const { text } = bookMarkdown('Title [draft] #1', blocks)
    expect(text).toBe(
      `${[
        '# Title \\[draft\\] \\#1',
        'a\\*b\\_c \\[d\\] \\#e and \\\\ \\`x\\` \\<y\\>',
        '\\# not a heading',
        '\\- not a list',
        '1\\. not a list either',
        '## Star \\*power\\*',
      ].join('\n\n')}\n`,
    )
  })

  it('prompts and pins are never exported', async () => {
    const res = await user.request(exportUrl(bookId, 'md'))
    const md = readZip(Buffer.from(await res.arrayBuffer()))[0]?.data.toString('utf8') ?? ''
    expect(md).not.toContain('PROMPT-NEVER-EXPORTED')
    expect(md).not.toContain(noteId)
    expect(md).not.toContain('c:')
    const docx = readZip(
      Buffer.from(await (await user.request(exportUrl(bookId, 'docx'))).arrayBuffer()),
    )
    for (const e of docx) {
      if (!e.name.endsWith('.xml') && !e.name.endsWith('.rels')) continue
      const xml = e.data.toString('utf8')
      expect(xml, e.name).not.toContain('PROMPT-NEVER-EXPORTED')
      expect(xml, e.name).not.toContain(noteId)
    }
  })

  it('orphan footnotes are left out', async () => {
    const book = bookRecord()
    const blocks = sampleBlocks(book.id, newId('asset'), newId('note'))
    const { text } = bookMarkdown('T', blocks)
    expect(text).not.toContain('ORPHAN-NEVER-EXPORTED')
    expect(text).not.toContain('[^3]')
    // A footnote anchored only in a prompt is an orphan of the export too.
    const fn = newId('block')
    const onlyPrompt = inOrder(book.id, [
      { kind: 'prompt', text: 'ask', marks: [{ t: `n:${fn}`, from: 0, to: 3 }] },
      { id: fn, kind: 'footnote', text: 'PROMPT-ONLY-NOTE' },
      { text: 'kept' },
    ])
    expect(bookMarkdown('T', onlyPrompt).text).toBe('# T\n\nkept\n')
    const docx = readZip(
      Buffer.from(await (await user.request(exportUrl(bookId, 'docx'))).arrayBuffer()),
    )
    const notes = docx.find((e) => e.name === 'word/footnotes.xml')?.data.toString('utf8') ?? ''
    expect(notes).not.toContain('ORPHAN-NEVER-EXPORTED')
  })
})

describe('book export: Word', () => {
  it('docx: every part parses as XML; document.xml has the headings’ styles, two footnoteReferences and an inline image; footnotes.xml has their text', async () => {
    const res = await user.request(exportUrl(bookId, 'docx'))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(res.headers.get('content-type')).toBe(DOCX)
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="walden-revisited.docx"',
    )
    const entries = readZip(Buffer.from(await res.arrayBuffer()))
    const byName = new Map(entries.map((e) => [e.name, e.data]))
    expect([...byName.keys()].sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/core.xml',
        'word/_rels/document.xml.rels',
        'word/_rels/footnotes.xml.rels',
        'word/document.xml',
        'word/fontTable.xml',
        'word/footnotes.xml',
        `word/media/${assetId}.jpg`,
        'word/numbering.xml',
        'word/settings.xml',
        'word/styles.xml',
      ].sort(),
    )
    for (const [name, data] of byName) {
      if (name.endsWith('.xml') || name.endsWith('.rels')) assertWellFormed(data.toString('utf8'))
    }
    const text = (name: string) => byName.get(name)?.toString('utf8') ?? ''
    const doc = text('word/document.xml')
    for (const style of ['Title', 'Heading1', 'Heading2', 'Quote', 'ListBullet']) {
      expect(doc).toContain(`<w:pStyle w:val="${style}"/>`)
    }
    expect(doc.match(/<w:footnoteReference /g)).toHaveLength(2)
    expect(doc).toContain('<wp:inline')
    expect(doc).toMatch(/<a:blip r:embed="rId\w+"\/>/)
    // At the page width (Letter, an inch each side: 6.5 in), by the photo's aspect (64 × 48).
    expect(doc).toContain('<wp:extent cx="5943600" cy="4457700"/>')
    expect(doc).not.toContain('ORPHAN-NEVER-EXPORTED')

    const notes = text('word/footnotes.xml')
    expect(notes).toContain('Thoreau, Walden, 1854, p. 12')
    expect(notes).toContain('example.com/walden')
    expect(notes).toMatch(/<w:footnote w:id="1">/)
    expect(notes).toMatch(/<w:footnote w:id="2">/)
    expect(notes).toContain('<w:hyperlink r:id=')

    const styles = text('word/styles.xml')
    for (const id of ['Title', 'Heading1', 'Heading2', 'Normal', 'Quote', 'ListBullet']) {
      expect(styles).toContain(`w:styleId="${id}"`)
    }
    for (const face of ['Newsreader', 'Instrument Sans']) expect(styles).toContain(face)
    const fonts = text('word/fontTable.xml')
    expect(fonts).toContain('<w:altName w:val="Georgia"/>')
    expect(fonts).toContain('<w:altName w:val="Arial"/>')

    // No macros, and no external relationship but a footnote's link.
    expect(text('[Content_Types].xml')).not.toMatch(/macro|vbaProject/i)
    for (const name of ['_rels/.rels', 'word/_rels/document.xml.rels']) {
      expect(text(name), name).not.toContain('External')
    }
    const linkRels = text('word/_rels/footnotes.xml.rels')
    expect(linkRels.match(/TargetMode="External"/g)).toHaveLength(1)
    expect(linkRels).toContain('Target="https://example.com/walden"')
    expect(linkRels).toContain('/relationships/hyperlink"')
    // The photo, as a JPEG every Word opens.
    const jpeg = byName.get(`word/media/${assetId}.jpg`)
    expect(jpeg?.subarray(0, 2).toString('hex')).toBe('ffd8')
  })

  it('docx escapes &, < and quotes', () => {
    const book = bookRecord()
    const blocks = inOrder(book.id, [
      { text: `Tom & Jerry <tag> "q" 'a'\u0001` },
      { kind: 'h1', text: 'A & B' },
    ])
    const parts = bookDocx({ title: 'Q & "A" <x>', lang: 'en', now: T0 }, blocks, new Map())
    for (const xml of parts.values()) assertWellFormed(xml)
    const doc = parts.get('word/document.xml') ?? ''
    expect(doc).toContain('Tom &amp; Jerry &lt;tag&gt; &quot;q&quot; &apos;a&apos;<')
    expect(doc).toContain('Q &amp; &quot;A&quot; &lt;x&gt;')
    expect(parts.get('docProps/core.xml')).toContain('Q &amp; &quot;A&quot; &lt;x&gt;')
  })
})

describe('book export: a footnote link', () => {
  it('a footnote URL holding a control character still makes well-formed rels', () => {
    const book = bookRecord()
    const fn = newId('block')
    const blocks = inOrder(book.id, [
      { text: 'Walden', marks: [{ t: `n:${fn}`, from: 0, to: 6 }] },
      { id: fn, kind: 'footnote', text: 'See https://example.com/wal\u0001den\u0008x now' },
    ])
    const parts = bookDocx({ title: 'T', lang: 'en', now: T0 }, blocks, new Map())
    for (const xml of parts.values()) assertWellFormed(xml)
    const rels = parts.get('word/_rels/footnotes.xml.rels') ?? ''
    expect(rels).toContain('Target="https://example.com/waldenx"')
  })
})

describe('book export: the route', () => {
  it('an unknown book or board is 404, and a format that is neither is 400', async () => {
    // The same 404 as the board export's.
    const unknownBoard = `board_${'0'.repeat(26)}`
    expect((await user.request(`/api/boards/${unknownBoard}/export?format=papertie`)).status).toBe(
      404,
    )
    // An unknown book, a malformed id, and a format that is neither.
    expect((await user.request(exportUrl(newId('book'), 'md'))).status).toBe(404)
    expect((await user.request(exportUrl('nope', 'md'))).status).toBe(404)
    const bad = await user.request(exportUrl(bookId, 'pdf'))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid' })
  })

  it('a trashed book 404s', async () => {
    for (const format of ['md', 'docx']) {
      const res = await user.request(exportUrl(trashedId, format))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not-found' })
    }
  })

  it('book text never appears in logs', async () => {
    const TITLE = 'SENTINEL-EXPORT-TITLE-61'
    const book = bookRecord({ title: TITLE, shelfPos: 'X' })
    const fn = newId('block')
    await post([
      bookCreate(book),
      blockCreate(
        blockRecord(book.id, 'U', 'SENTINEL-EXPORT-NOTE-63', { id: fn, kind: 'footnote' }),
      ),
      blockCreate(
        blockRecord(book.id, 'T', 'SENTINEL-EXPORT-TEXT-62', {
          marks: [{ t: `n:${fn}`, from: 0, to: 23 }],
        }),
      ),
      // A figure whose photo is gone: left out, and logged by kind only.
      blockCreate(
        blockRecord(book.id, 'W', 'SENTINEL-EXPORT-CAPTION-64', {
          kind: 'figure',
          image: { assetId },
        }),
      ),
    ])
    await rm(join(boardDir(server, user.id, board), 'assets', assetId, '2560.webp'), {
      force: true,
    })
    for (const format of ['md', 'docx']) {
      const res = await user.request(exportUrl(book.id, format))
      expect(res.status).toBe(200)
      const entries = readZip(Buffer.from(await res.arrayBuffer()))
      expect(entries.some((e) => e.data.toString('utf8').includes('SENTINEL-EXPORT-TEXT-62'))).toBe(
        true,
      )
    }
    expect(server.logs.length).toBeGreaterThan(3)
    for (const line of server.logs) {
      expect(line, line).not.toContain('SENTINEL-EXPORT')
      expect(line, line).not.toContain('sentinel-export')
      expect(line, line).not.toMatch(/[a-z]+_[0-9A-HJKMNP-TV-Z]{26}/)
    }
    const routes = server.logs.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(routes).toContainEqual(
      expect.objectContaining({ route: '/api/boards/:id/books/:bookId/export', status: 200 }),
    )
  })
})

describe('book export: in slices', () => {
  it('a 200,000-word book exports in slices', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'papertie-book-export-'))
    try {
      const empty = emptyBoardState(newId('board'), 'B', T0)
      const g = genBookRecords(5, 200_000, { title: 'Long' })
      const state = stateFromRecords(empty.board, [g.book, ...g.blocks])
      const logs: string[] = []
      const deps = {
        dataDir,
        userId: serverId('user'),
        boardId: state.board.id,
        log: createLogger((l) => logs.push(l)),
        now: new Date(T0),
      }
      for (const format of ['md', 'docx'] as const) {
        const r = await exportBook(state, g.book.id, format, deps)
        if (!r) throw new Error('no export')
        expect(r.slices, format).toBeGreaterThan(1)
        const main = r.entries.find(
          (e) => e.name === (format === 'md' ? 'long.md' : 'word/document.xml'),
        )
        // The big part goes to the zip in pieces, never as one buffer.
        expect(main && 'parts' in main && main.parts.length > 1, format).toBe(true)
      }
      expect(logs).toEqual([])
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
