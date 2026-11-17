/** The book text of the unsaved-changes download (`unsavedMarkdown`). */
import { applyBatch, type ClientOp, emptyBoardState, holdBook } from '@papertie/core'
import { describe, expect, it, vi } from 'vitest'
import { loadBookSync } from '../../../src/sync/books/bookOps'
import { unsavedMarkdown } from '../../../src/sync/books/unsavedText'
import { offerUnsaved } from '../../../src/sync/offerUnsaved'
import { downloadUnsaved } from '../../../src/sync/unsavedDownload'
import { BOOK, book, makeBook, para, typeAt } from '../../helpers/books'
import { BOARD_ID, note, T0 } from '../../helpers/fakeServer'

const ctx = { now: T0 }
const board = (texts: string[]) =>
  applyBatch(emptyBoardState(BOARD_ID, 'B', T0), makeBook(texts), ctx)

describe('unsavedMarkdown', () => {
  it('the pending text of each paragraph touched, under its book’s title', () => {
    const pending: ClientOp[][] = [[typeAt(1, 3, ' and more')], [typeAt(2, 0, 'Second: ')]]
    const s = applyBatch(board(['one', 'two', 'untouched']), pending.flat(), ctx)
    expect(unsavedMarkdown(s, pending)).toBe('# Shared\n\none and more\n\nSecond: two\n')
  })

  it('a paragraph the view no longer has (deleted, its book purged) keeps what was typed into it', () => {
    const typed: ClientOp[][] = [[typeAt(1, 3, ' lost words')]]
    const gone = holdBook(board(['one']), BOOK, [])
    expect(unsavedMarkdown(gone, [], typed)).toContain('lost words')
    const purged = emptyBoardState(BOARD_ID, 'B', T0)
    expect(unsavedMarkdown(purged, [], typed)).toBe('# Untitled book\n\n lost words\n')
  })

  it('a rejected edit of a paragraph still there: its words follow the paragraph as shown', () => {
    expect(unsavedMarkdown(board(['text']), [], [[typeAt(1, 4, ' more')]])).toBe(
      '# Shared\n\ntext\n\n more\n',
    )
  })

  it('a paragraph pasted, saying what it follows, and rejected: its text is offered', () => {
    const pasted: ClientOp = {
      op: 'block.create',
      block: {
        type: 'block',
        id: para(9),
        bookId: BOOK,
        pos: 'V1V',
        kind: 'p',
        text: 'pasted words',
        marks: [],
      },
      after: para(1),
    }
    const md = unsavedMarkdown(board(['one', 'two']), [], [[pasted]])
    expect(md).toContain('pasted words')
  })

  it('nothing when no batch touches a book', () => {
    const notes: ClientOp[][] = [
      [{ op: 'note.create', note: note('note_00000000000000000000000001') }],
    ]
    expect(unsavedMarkdown(board(['x']), notes)).toBe('')
    void book
    void para
  })

  it('the download is the JSONL, and the .md beside it only when there is book text', () => {
    const urls: Blob[] = []
    vi.stubGlobal('URL', {
      createObjectURL: (b: Blob) => {
        urls.push(b)
        return `blob:${urls.length}`
      },
      revokeObjectURL: () => {},
    })
    const names: string[] = []
    vi.stubGlobal('document', {
      createElement: () => ({
        click() {
          names.push(this.download)
        },
        download: '',
        href: '',
      }),
    })
    const day = new Date(2026, 10, 7)
    downloadUnsaved('{"op":{}}\n', day)
    downloadUnsaved('{"op":{}}\n', day, '# Shared\n\ntext\n')
    expect(names).toEqual([
      'papertie-unsaved-2026-11-07.jsonl',
      'papertie-unsaved-2026-11-07.jsonl',
      'papertie-unsaved-2026-11-07.md',
    ])
    expect(urls[2]?.type).toBe('text/markdown')
    vi.unstubAllGlobals()
  })
})

describe('unsavedMarkdown, edge cases', () => {
  it('a rejected batch keeps every fragment it typed, even one the paragraph shows elsewhere', () => {
    const s = board(['the cat sat'])
    const md = unsavedMarkdown(s, [], [[typeAt(1, 11, 'cat')]])
    expect(md).toBe('# Shared\n\nthe cat sat\n\ncat\n')
  })

  it('a JSONL alone still offers its book text', async () => {
    await loadBookSync() // before `URL` is stubbed: the test's module loader needs it
    const files: string[] = []
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
    vi.stubGlobal('document', {
      createElement: () => ({
        download: '',
        href: '',
        click() {
          files.push(this.download)
        },
      }),
    })
    const jsonl = `${JSON.stringify(typeAt(1, 0, 'typed before'))}\n`
    await offerUnsaved(jsonl)
    vi.unstubAllGlobals()
    expect(files.map((f) => f.split('.').pop())).toEqual(['jsonl', 'md'])
  })
})

describe('unsavedMarkdown with prompts and figures', () => {
  it('the unsaved .md holds prompts and captions', () => {
    const ASSET = `asset_${'0'.repeat(25)}1`
    const s0 = applyBatch(
      board(['one', 'a note', 'cap']),
      [
        {
          op: 'asset.add',
          asset: {
            type: 'asset',
            id: ASSET,
            mime: 'image/webp',
            width: 4,
            height: 3,
            bytes: 10,
            sha256: 'a'.repeat(64),
            createdAt: T0,
          },
        },
        { op: 'block.set', bookId: BOOK, id: para(2), set: { kind: 'prompt' } },
        { op: 'block.delete', bookId: BOOK, id: para(3) },
        {
          op: 'block.create',
          block: {
            type: 'block',
            id: para(3),
            bookId: BOOK,
            pos: 'V3',
            kind: 'figure',
            text: 'cap',
            marks: [],
            image: { assetId: ASSET },
          },
        },
      ] as ClientOp[],
      ctx,
    )
    const pending: ClientOp[][] = [[typeAt(1, 3, '!'), typeAt(2, 6, ' more'), typeAt(3, 3, 'tion')]]
    const s = applyBatch(s0, pending.flat(), ctx)
    expect(unsavedMarkdown(s, pending)).toBe(
      '# Shared\n\none!\n\nPrompt: a note more\n\nFigure: caption\n',
    )
  })
})

describe('unsavedMarkdown with footnotes', () => {
  it('the unsaved .md holds footnotes', () => {
    const s0 = applyBatch(
      board(['one', 'two']),
      [
        {
          op: 'block.create',
          block: {
            type: 'block',
            id: para(9),
            bookId: BOOK,
            pos: 'V1V',
            kind: 'footnote',
            text: 'a note',
            marks: [],
          },
        },
        {
          op: 'block.edit',
          bookId: BOOK,
          id: para(1),
          splices: [],
          addMarks: [{ t: `n:${para(9)}`, from: 0, to: 3 }],
        },
      ] as ClientOp[],
      ctx,
    )
    const pending: ClientOp[][] = [[typeAt(1, 0, 'Yes, '), typeAt(9, 6, ' more')]]
    const s = applyBatch(s0, pending.flat(), ctx)
    // The anchor's reference in its paragraph; the footnote a `[^n]:` line after it.
    expect(unsavedMarkdown(s, pending)).toBe('# Shared\n\nYes, one[^1]\n\n[^1]: a note more\n')
    // A footnote touched alone is its own line still.
    const alone: ClientOp[][] = [[typeAt(9, 0, 'See: ')]]
    expect(unsavedMarkdown(applyBatch(s0, alone.flat(), ctx), alone)).toBe(
      '# Shared\n\n[^1]: See: a note\n',
    )
  })
})
