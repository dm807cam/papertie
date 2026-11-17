import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { isReducedMotion, prefsStore, systemReducedMotion } from '../app/prefs'
import { MOTION } from '../styles/motion'
import { type FeedNotice, type SyncFeed, useFeed } from './feed'
import './sync.css'

/** A dropped or reset notice's slip fades after this long untouched (it stays in the popover). */
export const SLIP_CALM_MS = 8000

function Slip({
  notice,
  onHide,
  onDownload,
}: {
  notice: FeedNotice
  onHide(id: number): void
  onDownload(): void
}) {
  const [leaving, setLeaving] = useState(false)
  // A refused change must not slip away: its slip stays until dismissed.
  const calm = notice.kind !== 'rejected'
  const [held, setHeld] = useState(false)

  const leave = useCallback(() => setLeaving(true), [])
  useEffect(() => {
    if (!leaving) return
    const reduced = isReducedMotion(prefsStore.getState(), systemReducedMotion())
    const t = setTimeout(() => onHide(notice.id), reduced ? 0 : MOTION.slow)
    return () => clearTimeout(t)
  }, [leaving, notice.id, onHide])
  // Under the pointer or the focus, it waits to be read.
  useEffect(() => {
    if (!calm || held || leaving) return
    const t = setTimeout(leave, SLIP_CALM_MS)
    return () => clearTimeout(t)
  }, [calm, held, leaving, leave])

  const hold = (on: boolean) => () => setHeld(on)
  return (
    <div
      className="sync-slip sync-paper"
      role="note"
      data-kind={notice.kind}
      data-leaving={leaving || undefined}
      onPointerEnter={hold(true)}
      onPointerLeave={hold(false)}
      onFocus={hold(true)}
      onBlur={hold(false)}
    >
      <p className="sync-slip-text">{notice.message}</p>
      {notice.kind === 'rejected' && (
        <button type="button" className="sync-text-button" onClick={onDownload}>
          Download unsaved changes
        </button>
      )}
      <button type="button" className="sync-slip-close" aria-label="Dismiss" onClick={leave}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </div>
  )
}

/**
 * The board's quiet notices, as paper slips at the foot of the view: one per kind, counting
 * every change concerned. A refused change's slip stays until dismissed and offers the
 * unsaved-changes download; a dropped change's slip fades after {@link SLIP_CALM_MS}, and both
 * stay listed in the save dot's popover. Read out politely.
 */
export function SyncNotices({
  feed,
  onDownload,
  children,
}: {
  feed: SyncFeed
  onDownload(): void
  /** What else is said here, at the foot of the stack (the recovery slip): one place for all. */
  children?: ReactNode
}) {
  const notices = useFeed(feed, (s) => s.notices)
  const hide = useRef((id: number) => feed.hideSlip(id)).current
  return (
    <section className="sync-notices" aria-label="Notices" aria-live="polite">
      {children}
      {notices
        // A book gone under the writer is said by the book's own screen, not the board.
        .filter((n) => n.slip && n.held === undefined && n.kind !== 'book-gone')
        .map((n) => (
          <Slip key={n.id} notice={n} onHide={hide} onDownload={onDownload} />
        ))}
    </section>
  )
}
