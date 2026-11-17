import type { BoardSession } from '../app/session'
import { useFeed } from '../sync/feed'

/**
 * What the shelf says about a book it came to from the writer: gone from a restored board. A slip
 * each, in the board's notice paper, until dismissed.
 */
export function BookNotices({ session }: { session: BoardSession }) {
  const { feed } = session
  const all = useFeed(feed, (s) => s.notices)
  const notices = all.filter((n) => n.kind === 'book-gone' && n.slip)
  if (notices.length === 0) return null
  return (
    <div className="book-notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className="sync-slip sync-paper book-notice" role="note">
          <p className="sync-slip-text">{n.message}</p>
          <button
            type="button"
            className="sync-slip-close"
            aria-label="Dismiss"
            onClick={() => feed.hideSlip(n.id)}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
