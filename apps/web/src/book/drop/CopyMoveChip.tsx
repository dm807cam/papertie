/**
 * Copy or move on touch: a card held still on a tablet, with the book open beside the
 * board, offers "Copy · Move" at the card. The pick arms that card's next drag into the book; the
 * chip goes once a drag starts (the next press), or with a press anywhere else. Without it, a
 * touch drag into the book copies. Only of use with a book beside the board, so it is the book's.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export type CopyOrMove = 'copy' | 'move'

export function CopyMoveChip(p: {
  x: number
  y: number
  armed: CopyOrMove | null
  onPick(how: CopyOrMove): void
  onDone(): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const done = useRef(p.onDone)
  done.current = p.onDone

  useLayoutEffect(() => {
    const el = box.current
    if (el === null) return
    // Above the finger, kept on the screen.
    const left = Math.min(
      Math.max(8, p.x - el.offsetWidth / 2),
      window.innerWidth - el.offsetWidth - 8,
    )
    el.style.left = `${Math.round(left)}px`
    el.style.top = `${Math.round(Math.max(8, p.y - el.offsetHeight - 28))}px`
  }, [p.x, p.y])

  // The next press anywhere but on the chip: the drag it armed starts, or it was not wanted.
  useEffect(() => {
    const onPress = (e: Event) => {
      if (!(e.target instanceof Node && box.current?.contains(e.target))) done.current()
    }
    document.addEventListener('pointerdown', onPress, true)
    return () => document.removeEventListener('pointerdown', onPress, true)
  }, [])

  return createPortal(
    // biome-ignore lint/a11y/useSemanticElements: two commands, not a form field set
    <div ref={box} className="copy-move sync-paper" role="group" aria-label="Copy or move">
      {(['copy', 'move'] as const).map((how) => (
        <button
          key={how}
          type="button"
          className="copy-move-button"
          aria-pressed={p.armed === how}
          onClick={() => p.onPick(how)}
        >
          {how === 'copy' ? 'Copy' : 'Move'}
        </button>
      ))}
    </div>,
    document.body,
  )
}
