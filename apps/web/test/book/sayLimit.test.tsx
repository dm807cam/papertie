/**
 * A change not made, and why: said once. On a server board the notices'
 * slip says it, read out by their live region; a local board has no notices, so the page's live
 * region says it there.
 */
import { applyBatch, emptyBoardState } from '@papertie/core'
import { openLocalSession } from '../../src/app/session'
import { restoreBook } from '../../src/book/shelfActions'
import { tooLateMessage } from '../../src/sync/notices'
import type { SyncClient } from '../../src/sync/SyncClient'
import { BOOK, book } from '../helpers/books'
import { BOARD_ID, T0 } from '../helpers/fakeServer'

const DAY = 86_400_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse(T0) + 31 * DAY)
})
afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

const deleted = () =>
  applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [
      { op: 'book.create', book: { ...book(BOOK), trashedAt: null } },
      { op: 'book.update', id: BOOK, set: { trashedAt: T0 } },
    ],
    { now: T0 },
  )
const live = () => document.querySelector('[data-live-region]')?.textContent ?? ''

describe('a change not made, said once', () => {
  it('on a server board: a slip of its own kind, and nothing in the page’s live region', () => {
    const local = openLocalSession({ kind: 'local', state: deleted(), label: 'test' })
    const session = { ...local, sync: {} as SyncClient }
    restoreBook(session, BOOK)
    expect(live()).not.toContain(tooLateMessage())
    expect(session.feed.getState().notices.map((n) => [n.kind, n.message])).toEqual([
      ['limit', tooLateMessage()],
    ])
  })

  it('on a local board (no notices shown): to screen readers, once', () => {
    const session = openLocalSession({ kind: 'local', state: deleted(), label: 'test' })
    restoreBook(session, BOOK)
    expect(live().trim()).toBe(tooLateMessage())
  })
})
