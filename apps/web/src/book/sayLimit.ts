import { announce } from '../app/liveRegion'
import type { BoardSession } from '../app/session'

/**
 * Says why a change was not made (a book's limit, a full shelf, too late to put a book back) in a
 * slip of its own kind (`limit`), so it never takes a board-reloaded or restored slip's place nor
 * gives its own up to one. Said once: the board's notices read their slips
 * out (`SyncNotices`, a polite live region); a local board has none, so there it goes to screen
 * readers alone.
 */
export function sayLimit(session: Pick<BoardSession, 'sync' | 'feed'>, message: string): void {
  session.feed.notice({ kind: 'limit', count: 0, message })
  if (session.sync === null) announce(message)
}
