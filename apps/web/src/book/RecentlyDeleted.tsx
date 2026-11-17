import type { Book } from '@papertie/core'
import { useEffect, useRef } from 'react'
import type { BoardSession } from '../app/session'
import { isComposing } from '../ui/PickerSheet'
import { restoreBook } from './shelfActions'
import { daysLeft } from './trashedBooks'

const left = (n: number) => (n === 1 ? '1 day left' : `${n} days left`)

/**
 * "Recently deleted": the books that can still be put back, newest deletion first,
 * each with the days it has left and "Put it back". A quiet sheet over the shelf; Esc, Done and a
 * press outside it close it.
 */
export function RecentlyDeleted({
  session,
  books,
  onClose,
}: {
  session: BoardSession
  books: readonly Book[]
  onClose(): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const now = Date.now()
  useEffect(() => {
    box.current?.focus()
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isComposing(e)) return
      e.preventDefault()
      e.stopPropagation()
      close.current()
    }
    const away = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && !box.current?.contains(t) && !(t as Element).closest?.('.shelf-trash-link'))
        close.current()
    }
    document.addEventListener('keydown', esc, true)
    document.addEventListener('pointerdown', away, true)
    return () => {
      document.removeEventListener('keydown', esc, true)
      document.removeEventListener('pointerdown', away, true)
      // Gone (Done, Esc, the last put back): the focus back to the link, or once there is no
      // link, to the shelf's first book.
      queueMicrotask(() => {
        const at = document.activeElement
        if (at !== null && at !== document.body && at.isConnected) return
        const back =
          document.querySelector<HTMLElement>('.shelf-trash-link') ??
          document.querySelector<HTMLElement>('.shelf-open')
        back?.focus({ preventScroll: true })
      })
    }
  }, [])
  return (
    <div
      className="shelf-trash"
      role="dialog"
      aria-label="Recently deleted"
      tabIndex={-1}
      ref={box}
    >
      <h2 className="shelf-trash-title">Recently deleted</h2>
      <ul className="shelf-trash-list">
        {books.map((b) => {
          const title = b.title.trim() || 'Untitled'
          return (
            <li key={b.id} className="shelf-trash-row">
              <span className="shelf-trash-name" lang={b.lang}>
                {title}
              </span>
              <span className="shelf-trash-left">{left(daysLeft(b, now))}</span>
              <button
                type="button"
                className="shelf-trash-back"
                onClick={() => {
                  restoreBook(session, b.id)
                  // Its row goes: the focus stays in the list.
                  queueMicrotask(() => {
                    const at = document.activeElement
                    if (at === null || at === document.body || !at.isConnected) box.current?.focus()
                  })
                }}
              >
                Put it back
              </button>
            </li>
          )
        })}
      </ul>
      <button type="button" className="shelf-trash-done" onClick={onClose}>
        Done
      </button>
    </div>
  )
}
