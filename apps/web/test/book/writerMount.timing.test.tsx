/**
 * Opening a book of `maxBlocksPerBook` paragraphs in the writer: the hold, then
 * the writer's model, its word count and its first window, never one task longer than a 4 ms
 * slice and its last step counted 8× for a slow device (as `holdSliced.test.ts` counts the hold
 * alone). Real timers: a heartbeat of tasks measures the longest stretch the page was held. The
 * timing project runs it, a file at a time (`writerMount.test.tsx` keeps its untimed proofs: the
 * page's window and the word count).
 */
import { loadavg } from 'node:os'
import { PerformanceObserver } from 'node:perf_hooks'
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
import { longestTaskOf } from '../helpers/longestTask'

/** A Raspberry Pi runs this code about 8× slower than a Mac it is timed on. */
const PI = 8
/** The slicer's budget (`sync/pace.ts`). */
const SLICE_MS = 4
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
    // The book was read before it is held (the route's parse, its own slices, a while before):
    // its blocks are not the young heap's any more by then, as they are here, made just now. A
    // churn of short-lived objects lets the collector move them on first.
    let churn: unknown = null
    for (let i = 0; i < 3_000_000; i++) churn = { i }
    void churn
    await new Promise((r) => setTimeout(r, 20))
    const load = loadavg()[0] ?? 0
    const gc: number[] = []
    const obs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) gc.push(e.duration)
    })
    obs.observe({ entryTypes: ['gc'] })
    // The hold, as the sync client takes it (`book/bookSync.ts`): in 4 ms slices. Timed here for
    // the record; through the client itself it is `holdSliced.test.ts`'s row.
    let made: BoardState = unheld
    const { ms: holdMs } = await longestTaskOf(async () => {
      const pause = slicer()
      const steps = holdBookSteps(unheld, ID, blocks)
      for (;;) {
        const r = steps.next()
        if (r.done) {
          made = r.value
          return
        }
        await pause()
      }
    })
    // Then the writer's part: the board takes the held book, and the writer puts it on the page
    // (its model, the first window) and counts its words.
    const { ms } = await longestTaskOf(async () => {
      await act(async () => {
        session.store.replace(made)
        held()
      })
      for (let i = 0; i < 2000; i++) {
        const shown = document.querySelector('.bk-book [data-id]') !== null
        if (shown && document.querySelector('.writer-count') !== null) return
        await new Promise((r) => setTimeout(r, 2))
      }
      throw new Error('the book never showed')
    })
    await new Promise((r) => setTimeout(r, 20))
    obs.disconnect()
    expect(document.querySelectorAll('.bk-book [data-id]').length).toBeLessThanOrEqual(130)
    expect(document.querySelector('.writer-count')?.textContent).toBe(
      `${(n * 8).toLocaleString('en')} words`,
    )
    console.info(
      `writer mount of ${n} paragraphs: longest task ${ms.toFixed(1)} ms (the hold before it: ${holdMs.toFixed(1)} ms), longest GC pause ${Math.max(0, ...gc).toFixed(1)} ms, load1 ${load.toFixed(2)}`,
    )
    if (load < 4) expect(ms).toBeLessThanOrEqual(SLICE_MS + (50 - SLICE_MS) / PI)
  }, 60_000)
})
