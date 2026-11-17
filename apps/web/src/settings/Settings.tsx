import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { RouteLink } from '../app/RouteLink'
import { navigate, type SettingsSection } from '../app/router'
import type { BoardSession } from '../app/session'
import { SettingsIcon } from '../ui/sidebarIcons'
import { useNarrow } from '../ui/useNarrow'
import { DataSettings } from './Data'
import { Export } from './Export'
import { History } from './History'
import { Preferences } from './Preferences'
import './settings.css'

type Tabs = readonly { section: SettingsSection; label: string }[]

const SECTIONS: Tabs = [
  { section: 'export', label: 'Export' },
  { section: 'history', label: 'History' },
  { section: 'preferences', label: 'Preferences' },
  { section: 'data', label: 'Data' },
]

const close = () => navigate({ name: 'board' })

function Body({
  section,
  session,
}: {
  section: SettingsSection
  session: BoardSession
}): ReactNode {
  switch (section) {
    case 'export':
      return <Export session={session} />
    case 'history':
      return <History session={session} />
    case 'preferences':
      return <Preferences />
    case 'data':
      return <DataSettings session={session} />
  }
}

/** The elements a Tab can reach inside `root`, in order. */
const tabbable = (root: HTMLElement): HTMLElement[] =>
  [
    ...root.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => !el.closest('[inert]'))

/**
 * Settings: a fibre sheet laid over the dimmed board, with the section tabs on its left edge.
 * The canvas under it is inert and dimmed (`CanvasView` `covered`), but the sidebar beside it
 * stays in use: Tab runs over the sidebar and the sheet and no further, so this is not a modal
 * dialog (under 768 px, where it fills the screen and the mini-bar is inert, it is). Esc (outside an IME composition) or the close mark returns to the board. Focus returns
 * to where it was when the sheet closes, unless it has gone somewhere on purpose by then.
 * `section` is the route's.
 */
export function Settings({
  section,
  session,
}: {
  section: SettingsSection
  session: BoardSession
}) {
  const shown = section
  const sheet = useRef<HTMLElement>(null)
  const narrow = useNarrow()
  const narrowRef = useRef(narrow)
  narrowRef.current = narrow

  useEffect(() => {
    const from = document.activeElement
    sheet.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (e.key !== 'Tab' || !sheet.current) return
      // The sidebar comes first in the page, then the sheet.
      // Full screen (narrow) it is the only thing to reach.
      const side = narrowRef.current
        ? null
        : document.querySelector<HTMLElement>('.sidebar, .minibar')
      const els = [...(side ? tabbable(side) : []), ...tabbable(sheet.current)]
      const first = els[0]
      const last = els.at(-1)
      if (!first || !last) return
      const at = document.activeElement
      const inRing = at !== null && (sheet.current.contains(at) || !!side?.contains(at))
      if (!inRing) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && (at === first || at === sheet.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && at === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      // The canvas under the sheet is inert until this commit lands: focus goes back a turn
      // later, and only if it is lost (on the page, or still on the sheet that has gone). A tool
      // of the sidebar that closed the sheet and took focus keeps it.
      if (from instanceof HTMLElement)
        queueMicrotask(() => {
          const at = document.activeElement
          const lost = !at || at === document.body || !at.isConnected
          if (lost && from.isConnected) from.focus()
        })
    }
  }, [])

  // Narrow, the tabs run along the top and may run past it: the open tab is scrolled into view,
  // and each edge the strip runs past says so (`data-clip`), which fades it (settings.css).
  const tabs = useRef<HTMLElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the section and the layout move the open tab
  useLayoutEffect(() => {
    const nav = tabs.current
    if (!nav) return
    const clip = () => {
      const start = nav.scrollLeft > 0.5
      const end = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 0.5
      const next = [start && 'start', end && 'end'].filter(Boolean).join(' ')
      if (next === '') delete nav.dataset.clip
      else nav.dataset.clip = next
    }
    const reveal = () => {
      const current = nav.querySelector<HTMLElement>('[aria-current="page"]')
      if (current && nav.scrollWidth > nav.clientWidth) {
        const r = current.getBoundingClientRect()
        const box = nav.getBoundingClientRect()
        if (r.right > box.right) nav.scrollLeft += r.right - box.right
        else if (r.left < box.left) nav.scrollLeft -= box.left - r.left
      }
      clip()
    }
    reveal()
    // The labels widen as their face arrives: the open tab is brought back into view then.
    const list = nav.querySelector('ul')
    const grew = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal)
    if (list) grew?.observe(list)
    nav.addEventListener('scroll', clip, { passive: true })
    window.addEventListener('resize', clip)
    return () => {
      grew?.disconnect()
      nav.removeEventListener('scroll', clip)
      window.removeEventListener('resize', clip)
    }
  }, [shown, narrow])

  const label = SECTIONS.find((s) => s.section === shown)?.label ?? ''
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc is the keyboard's way out; the veil is for the pointer
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above
    <div
      className="settings-veil"
      data-testid="settings"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <section
        ref={sheet}
        className="settings-sheet note note--rustic"
        data-paper="cream"
        data-mask="5"
        role="dialog"
        aria-modal={narrow || undefined}
        aria-label="Settings"
        tabIndex={-1}
      >
        <div className="note-shadow" />
        <div className="note-paper settings-paper">
          <nav className="settings-tabs" aria-label="Settings" ref={tabs}>
            <p className="settings-mark" aria-hidden="true">
              <SettingsIcon />
              <span>Settings</span>
            </p>
            <ul>
              {SECTIONS.map((s) => (
                <li key={s.section}>
                  <RouteLink
                    to={{ name: 'settings', section: s.section }}
                    className="settings-tab"
                    current={s.section === shown}
                  >
                    {s.label}
                  </RouteLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="settings-main">
            <header className="settings-head">
              <h1 className="settings-title">{label}</h1>
              <button type="button" className="settings-close" aria-label="Close" onClick={close}>
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M3 3l6 6M9 3l-6 6" />
                </svg>
              </button>
            </header>
            <div className="settings-body">
              <Body section={shown} session={session} />
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
