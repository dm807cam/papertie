import {
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { isReducedMotion, prefsStore, systemReducedMotion } from '../app/prefs'
import { EASE_CSS, MOTION } from '../styles/motion'
import { type FeedNotice, type SyncFeed, useFeed } from './feed'
import { offerUnsaved, type UnsavedParts } from './offerUnsaved'
import type { SaveStatus } from './types'
import './sync.css'

/** The save dot's words for each status. */
export const SAVE_COPY: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  offline: 'Not saved yet — trying again',
  error: 'Couldn’t save',
}

/** How long `Saved` stays before the dot fades. */
export const SAVED_SHOWN_MS = 1500
/** The saving pulse runs at most this often. */
const PULSE_GAP_MS = 1000

const motionAllowed = () => !isReducedMotion(prefsStore.getState(), systemReducedMotion())

/**
 * The save indicator: an 8 px ink dot at the sidebar's foot. `saved` shows for 1.5 s and fades;
 * `saving` pulses once (at most every second, and only when motion is allowed); `offline` (a
 * hollow ring) and `error` (crimson ink) stay, and say so to a screen reader. `attention` (notices
 * the popover still lists) and `expanded` (the popover is open) keep it in reach. A click asks
 * for the detail. Hidden, it takes no tab stop and is not read out. Its live region lives in the
 * board's UI layer, outside the sidebar, so a folded sidebar never silences it.
 */
export function SaveDot({
  status,
  onOpenDetail,
  attention = false,
  expanded = false,
  ref,
}: {
  status: SaveStatus
  onOpenDetail(): void
  attention?: boolean
  expanded?: boolean
  ref?: Ref<HTMLButtonElement>
}) {
  const resting = status === 'saved' && !attention && !expanded
  // A board that opens with nothing to save shows no dot at all.
  const [rested, setRested] = useState(resting)
  useEffect(() => {
    if (!resting) {
      setRested(false)
      return
    }
    const t = setTimeout(() => setRested(true), SAVED_SHOWN_MS)
    return () => clearTimeout(t)
  }, [resting])
  const shown = !(resting && rested)

  const ink = useRef<HTMLSpanElement>(null)
  const lastPulse = useRef(Number.NEGATIVE_INFINITY)
  useEffect(() => {
    if (status !== 'saving') return
    const el = ink.current
    const now = performance.now()
    if (!el || typeof el.animate !== 'function' || now - lastPulse.current < PULSE_GAP_MS) return
    if (!motionAllowed()) return
    lastPulse.current = now
    el.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.55)', opacity: 0.6 },
        { transform: 'scale(1)' },
      ],
      { duration: MOTION.slow * 2, easing: EASE_CSS },
    )
  }, [status])

  const own = useRef<HTMLButtonElement | null>(null)
  const setRef = useCallback(
    (el: HTMLButtonElement | null) => {
      own.current = el
      if (typeof ref === 'function') ref(el)
      else if (ref) ref.current = el
    },
    [ref],
  )
  const [liveHost, setLiveHost] = useState<Element | null>(null)
  useLayoutEffect(() => setLiveHost(own.current?.closest('.ui') ?? null), [])

  const copy = SAVE_COPY[status]
  const loud = status === 'offline' || status === 'error'
  const live = (
    <span className="sync-live" role="status">
      {loud ? copy : ''}
    </span>
  )
  return (
    <>
      <button
        ref={setRef}
        type="button"
        className="save-dot"
        data-testid="save-dot"
        data-status={status}
        data-attention={attention || undefined}
        data-shown={shown}
        aria-label={copy}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-hidden={shown ? undefined : true}
        tabIndex={shown ? 0 : -1}
        title={copy}
        onClick={onOpenDetail}
      >
        <span className="save-dot-ink" ref={ink} />
      </button>
      {liveHost === null ? live : createPortal(live, liveHost)}
    </>
  )
}

/** An Esc (or any key) that ends an IME or dead-key composition; Safari says so by key code 229. */
const composing = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229

const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`

/** The detail: the status, what waits to be saved, the notices kept, and the download. */
function SavePopover({
  anchor,
  status,
  pending,
  notices,
  unsaved,
  unsavedParts,
  onClear,
  onClose,
}: {
  anchor: HTMLElement | null
  status: SaveStatus
  pending: number
  notices: readonly FeedNotice[]
  unsaved(): string
  unsavedParts(): UnsavedParts | undefined
  onClear(): void
  onClose(): void
}) {
  const titleId = useId()
  const box = useRef<HTMLDivElement>(null)
  // Read when it opens and when what it shows changes: never per keystroke on the board.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of either may change the download
  const text = useMemo(() => unsaved(), [pending, notices, unsaved])

  // Beside the sidebar, its foot level with the dot's (above the mini-bar's dot). Placed once:
  // it closes on a resize.
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !anchor) return
    const dot = anchor.getBoundingClientRect()
    if (anchor.closest('.minibar')) {
      // Above the mini-bar's dot, from the left gutter.
      el.style.left = '12px'
      el.style.bottom = `${Math.max(12, Math.round(window.innerHeight - dot.top + 8))}px`
    } else {
      const panel = anchor.closest('.sidebar')?.getBoundingClientRect() ?? dot
      el.style.left = `${Math.round(panel.right + 12)}px`
      el.style.bottom = `${Math.max(12, Math.round(window.innerHeight - dot.bottom - 10))}px`
    }
    // The focus goes in, so Esc reaches it: to its first live button, else to the popover itself
    // (the store out of reach with nothing waiting, the download is its only button, and disabled).
    const first = el.querySelector<HTMLElement>('button:not(:disabled)') ?? el
    first.focus()
  }, [anchor])

  // The download going disabled under the focus (the save landed) would drop it on <body>, out
  // of Esc's reach: the popover keeps it.
  const download = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const at = document.activeElement
    if (text === '' && (at === download.current || at === document.body)) box.current?.focus()
  }, [text])

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && !box.current?.contains(t) && !anchor?.contains(t)) onClose()
    }
    // Esc with the keyboard nowhere (the focus dropped on <body>) is the popover's, before the
    // board's own (the selection). Anywhere else it belongs to what has the focus: ⌘K, a note
    // being written on, Settings. Inside the popover, its own handler takes it.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || composing(e)) return
      const at = document.activeElement
      if (at !== null && at !== document.body) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc, true)
      window.removeEventListener('resize', onClose)
    }
  }, [anchor, onClose])

  // In the board's UI layer, never inside the sidebar, which clips as it folds.
  return createPortal(
    <div
      ref={box}
      className="save-pop sync-paper"
      role="dialog"
      aria-label="Save status"
      aria-describedby={titleId}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || composing(e.nativeEvent)) return
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      <p className="save-pop-status" id={titleId} data-status={status}>
        <span className="save-pop-ink" aria-hidden="true" />
        {SAVE_COPY[status]}
      </p>
      <p className="save-pop-line">
        {pending === 0 ? 'Nothing waiting to be saved' : `${changes(pending)} waiting to be saved`}
      </p>
      {notices.length > 0 && (
        <div className="save-pop-notices">
          <ul>
            {notices.map((n) => (
              <li key={n.id}>{n.message}</li>
            ))}
          </ul>
          <button type="button" className="sync-text-button" onClick={onClear}>
            Clear
          </button>
        </div>
      )}
      {/* The ink button only when saving fails; saving or waiting, all is well: a quiet line. */}
      <button
        ref={download}
        type="button"
        className={status === 'error' ? 'sync-button' : 'sync-text-button'}
        disabled={text === ''}
        onClick={() => void offerUnsaved(unsaved(), unsavedParts())}
      >
        Download unsaved changes
      </button>
    </div>,
    anchor?.closest('.ui') ?? document.body,
  )
}

/**
 * The save dot on a session's feed, with its popover. It alone follows the feed, so a status
 * change renders the dot and nothing of the board. `unsaved` is `SyncClient.unsavedJsonl`.
 */
export function SyncSaveDot({
  feed,
  unsaved,
  unsavedParts = () => undefined,
}: {
  feed: SyncFeed
  unsaved(): string
  /** `SyncClient.unsavedParts`: what the book text beside the JSONL is made of. */
  unsavedParts?: () => UnsavedParts | undefined
}) {
  const status = useFeed(feed, (s) => s.status)
  const pending = useFeed(feed, (s) => s.pending)
  const all = useFeed(feed, (s) => s.notices)
  const notices = useMemo(
    () => all.filter((n) => n.kind !== 'reset' && n.kind !== 'limit' && n.kind !== 'book-gone'),
    [all],
  )
  const [open, setOpen] = useState(false)
  const dot = useRef<HTMLButtonElement>(null)
  const unsavedRef = useRef(unsaved)
  unsavedRef.current = unsaved
  const textRef = useRef(unsavedParts)
  textRef.current = unsavedParts
  const read = useMemo(() => () => unsavedRef.current(), [])
  const readText = useMemo(() => () => textRef.current(), [])
  const close = useMemo(
    () => () => {
      setOpen(false)
      dot.current?.focus()
    },
    [],
  )
  return (
    <>
      <SaveDot
        ref={dot}
        status={status}
        attention={notices.length > 0}
        expanded={open}
        onOpenDetail={() => (open ? close() : setOpen(true))}
      />
      {open && (
        <SavePopover
          anchor={dot.current}
          status={status}
          pending={pending}
          notices={notices}
          unsaved={read}
          unsavedParts={readText}
          onClear={() => feed.clearNotices()}
          onClose={close}
        />
      )}
    </>
  )
}
