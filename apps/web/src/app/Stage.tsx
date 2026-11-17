import { type ReactNode, useId, useLayoutEffect, useRef } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { mountCork } from '../canvas/mountCork'
import '../notes/note.css'
import '../styles/pin.css'
import './stage.css'

/** The board's cork at zoom 1, filling the window behind the cards; it never pans. */
function Cork() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const cork = mountCork(el)
    const fit = () => {
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      cork.update(1, viewport.width / 2, viewport.height / 2, viewport)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => {
      window.removeEventListener('resize', fit)
      cork.dispose()
    }
  }, [])
  return <div className="stage-cork" ref={ref} aria-hidden="true" />
}

/** Mounted canvases: while one shows its own cork, the shell's is not mounted. */
const covers = createStore<number>()(() => 0)

/**
 * The app shell's one cork, behind every card: mounted once, so moving between them never
 * rebuilds its layers. A board canvas covering it ({@link useCoverShellCork}) has its own, and
 * this one goes.
 */
export function ShellCork() {
  const covered = useStore(covers, (n) => n > 0)
  return covered ? null : <Cork />
}

/** While the calling component is mounted, the shell's cork is not (the board has its own). */
export function useCoverShellCork(): void {
  useLayoutEffect(() => {
    covers.setState((n) => n + 1, true)
    return () => covers.setState((n) => n - 1, true)
  }, [])
}

/**
 * The cork alone: what shows while the user is read and before the board's first paint, so the
 * card (or the board) lands on it. It says nothing, not even busy: no loading screen.
 */
export function CorkStage() {
  return <main className="stage" />
}

/**
 * One cream fibre note pinned on the cork, centred, holding a short message (the board could not
 * open, say): the board's own paper (`NoteView`'s classes, deckle mask and fibre) under a brass
 * pin, with the display serif title. The cork is the shell's.
 */
export function PinnedCard({
  title,
  children,
  busy = false,
}: {
  title: string
  children?: ReactNode
  busy?: boolean
}) {
  const titleId = useId()
  return (
    <main className="stage" aria-busy={busy || undefined}>
      <section
        className="stage-card note note--rustic"
        data-paper="cream"
        data-mask="3"
        aria-labelledby={titleId}
      >
        <div className="note-shadow" />
        <div className="note-paper stage-paper">
          <p className="stage-mark" aria-hidden="true">
            Papertie
          </p>
          <h1 className="note-title stage-title" id={titleId}>
            {title}
          </h1>
          {children}
        </div>
        <span className="stage-pin brass-pin" aria-hidden="true" />
      </section>
    </main>
  )
}
