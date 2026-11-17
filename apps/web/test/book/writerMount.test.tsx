/**
 * Opening a book of `maxBlocksPerBook` paragraphs in the writer: the hold, then
 * the writer's model, its word count and its first window, never one task longer than a 4 ms
 * slice and its last step counted 8× for a slow device (as `holdSliced.test.ts` counts the hold
 * alone). Here what is on the page; how long the page was held is the timing row's
 * (`writerMount.timing.test.tsx`).
 */
import {
  applyBatch,
  type Block,
  type BoardState,
  emptyBoardState,
  holdBookSteps,
  LIMITS,
  posKeysBetween,
  releaseBook,
} from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { openLocalSession } from '../../src/app/session'
import { BookScreen } from '../../src/book/BookScreen'
import { attachBooks, type BookStore } from '../../src/sync/books/bookStore'
import { slicer } from '../../src/sync/pace'
import { book } from '../helpers/books'
import { BOARD_ID, idOf, T0 } from '../helpers/fakeServer'

const ID = idOf('book', 3)

afterEach(() => {
  cleanup()
  attachBooks(null)
})

describe('opening a long book in the writer', () => {
  it(`a book of ${LIMITS.maxBlocksPerBook.toLocaleString('en')} paragraphs, once held: on the page and counted with no task over 50 ms counted 8× for a Raspberry Pi`, async () => {
    const n = LIMITS.maxBlocksPerBook
    const keys = posKeysBetween(null, null, n)
    const blocks: Block[] = keys.map((pos, i) => ({
      type: 'block',
      id: `block_${String(i).padStart(26, '0')}`,
      bookId: ID,
      pos,
      kind: i % 500 === 0 ? 'h1' : 'p',
      text: `Paragraph ${i}, a sentence of a few words.`,
      marks: [],
    }))
    const whole = applyBatch(
      emptyBoardState(BOARD_ID, 'Test board', T0),
      [{ op: 'book.create', book: { ...book(ID, { title: 'Long' }), trashedAt: null } }],
      { now: T0 },
    )
    // The board as a client reads it: the book not held.
    const unheld: BoardState = releaseBook(whole, ID)
    let held: () => void = () => {}
    const books: BookStore = {
      open: () =>
        new Promise<boolean>((r) => {
          held = () => r(true)
        }),
      close: () => {},
      onReset: () => () => {},
      reset: () => {},
      changed: () => {},
      dispose: () => {},
    }
    const session = openLocalSession({ kind: 'local', state: unheld, label: 'test' })
    session.books = books
    attachBooks(session.store)
    render(<BookScreen session={session} bookId={ID} />)
    // The hold, as the sync client takes it (`book/bookSync.ts`): in 4 ms slices.
    let made: BoardState = unheld
    const pause = slicer()
    const steps = holdBookSteps(unheld, ID, blocks)
    for (;;) {
      const r = steps.next()
      if (r.done) {
        made = r.value
        break
      }
      await pause()
    }
    // Then the writer's part: the board takes the held book, and the writer puts it on the page
    // (its model, the first window) and counts its words.
    await act(async () => {
      session.store.replace(made)
      held()
    })
    let shown = false
    for (let i = 0; i < 2000 && !shown; i++) {
      shown =
        document.querySelector('.bk-book [data-id]') !== null &&
        document.querySelector('.writer-count') !== null
      if (!shown) await new Promise((r) => setTimeout(r, 2))
    }
    expect(shown).toBe(true)
    expect(document.querySelectorAll('.bk-book [data-id]').length).toBeLessThanOrEqual(130)
    expect(document.querySelector('.writer-count')?.textContent).toBe(
      `${(n * 8).toLocaleString('en')} words`,
    )
  }, 60_000)
})
