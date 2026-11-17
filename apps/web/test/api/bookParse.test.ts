import { describe, expect, it } from 'vitest'
import { parseBook } from '../../src/api/bookParse'
import { BOOK, BOOK2, block, book } from '../helpers/books'

const lines = (...xs: unknown[]) => `${xs.map((x) => JSON.stringify(x)).join('\n')}\n`
const eof = (revision: number) => ({ type: 'eof', revision, records: 3, sha256: '0'.repeat(64) })

describe('parseBook', () => {
  it('the book, its blocks in order, and the revision its eof names', async () => {
    const text = lines(book(), block(1, 'one'), block(2, 'two'), eof(7))
    expect(await parseBook(text)).toEqual({
      revision: 7,
      book: book(),
      blocks: [block(1, 'one'), block(2, 'two')],
    })
  })

  it('nothing for an answer cut short, a line that is not valid, or another book’s block', async () => {
    expect(await parseBook(lines(book(), block(1, 'one')))).toBeNull()
    expect(await parseBook(lines(book(), { type: 'block', id: 'x' }, eof(1)))).toBeNull()
    expect(await parseBook(lines(book(), block(1, 'one', BOOK2), eof(1)))).toBeNull()
    expect(await parseBook(lines(block(1, 'one'), eof(1)))).toBeNull()
    expect(await parseBook(`${lines(book(), eof(1))}{"type":"eof"}\n`)).toBeNull()
    expect(await parseBook(lines(book(BOOK), eof(2)))).toMatchObject({ revision: 2, blocks: [] })
  })
})
